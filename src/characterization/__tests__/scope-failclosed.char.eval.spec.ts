// CHARACTERIZATION NET — scope-fold + fail-closed / soft-drop (the SAFETY
// CONTRACT the upcoming dialect-neutral query IR must preserve).
//
// This pins CURRENT behavior against the live dealbrain DB; it is the safety gate
// for the IR/QueryBackend extraction and becomes that port's contract test. It
// does NOT improve or fix anything — where the engine looks wrong, the row is
// pinned AS-IS and tagged // SUSPECTED-DIVERGENCE.
//
// SCOPE OF THIS FILE (the gaps the existing aggregate-scope.eval.spec.ts leaves):
//   (a) query()/fetch() with a SERVICE scope option — scope ANDs into the WHERE
//       and a caller filter can only NARROW it (the existing spec proves this for
//       aggregate(); the query/fetch side was UNTESTED).
//   (b) ITEM-F — query()/fetch() CURRENT behavior when a filter column resolves
//       NOWHERE. (The hypothesis was "silent soft-drop"; characterized here AS-IS.)
//   (c) aggregate() fail-closed on a filter column on no source (commit d11a0dd)
//       — assert it THROWS (public path).
//   (d) the multiSourceSelect cross-source group_by REFUSAL (a group key not on
//       every measure source throws, never cross-joins) + the FULL OUTER JOIN
//       coalesce of the shared key.
//   (e) composite ratio NULL-policy (zero/absent denominator → null ratio + the
//       warning).
//
// Public surface first (h.service is a QueryApplicationService). Where a behavior
// needs a scope/catalog the shared harness doesn't wire (it is unscoped, note 6),
// a local QueryApplicationService is constructed — flagged inline.
//
//   cd packages/query-surface && \
//   DBURL=postgres://postgres:password@localhost:54321/dealbrain \
//   bun test src/characterization/scope-failclosed.char.eval.spec.ts

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { POC_ACTOR_USER_ID } from '../../adapters/drizzle/eav/field-map.ts';
import { loadDealbrainModel } from '../../adapters/reference/model.dealbrain.ts';
import { QueryApplicationService } from '../../query.application-service.ts';
import { DEALBRAIN_ORG, type QuerySurfaceHarness, makeQuerySurface } from '../harness.ts';

const DBURL = process.env.DBURL;
const suite = DBURL ? describe : describe.skip;

suite('scope-failclosed — characterization', () => {
  let h: QuerySurfaceHarness;
  beforeAll(() => {
    h = makeQuerySurface(DBURL!); // configures the global registry EAGERLY
  });
  afterAll(async () => {
    await h.close();
  });

  // ground truth (rule 3): raw SQL via the SAME pool.
  const truth = async (q: string) =>
    (await h.db.execute(sql.raw(q))).rows as Record<string, unknown>[];
  const num = (v: unknown) => Number(v);

  // A locally-scoped service over the SAME pool/registry — the shared harness is
  // intentionally unscoped (note 6), so the query/fetch scope path needs its own
  // instance carrying options.scope. Same EAV actor/org as the harness.
  const scopedService = (scope: (e: string) => unknown) =>
    new QueryApplicationService(h.db, {
      actorUserId: POC_ACTOR_USER_ID,
      actorOrganizationId: DEALBRAIN_ORG,
      // biome-ignore lint/suspicious/noExplicitAny: ScopeResolver is keyed by EntityName; the test names entities as raw strings
      scope: scope as any,
    });

  const COMMITMENT = `(select count(*)::int n from observations where type='commitment')`;

  // ==========================================================================
  // (a) query()/fetch() SERVICE SCOPE — scope ANDs into WHERE; caller filter can
  //     only NARROW. This side was untested (the existing spec covers aggregate).
  // ==========================================================================

  it('F1 query(): options.scope ANDs into WHERE — total == the scoped truth, SQL has WHERE', async () => {
    const svc = scopedService((e) =>
      e === 'observations' ? { on: 'type', op: 'eq', value: 'commitment' } : undefined,
    );
    const res = await svc.query('observations', { page: { limit: 5000 }, include_sql: true });
    const ref = await truth(COMMITMENT);
    // scope alone collapses the population to type=commitment (610), NOT the 7548 total.
    expect(res.total).toBe(num(ref[0]!.n));
    expect((res.sql ?? '').toLowerCase()).toContain('where');
  });

  it('F2 query(): scope is NON-BYPASSABLE — caller filter can only NARROW (intersection)', async () => {
    // scope: type=commitment, caller filter: type=discovery → disjoint → empty.
    const svc = scopedService((e) =>
      e === 'observations' ? { on: 'type', op: 'eq', value: 'commitment' } : undefined,
    );
    const res = await svc.query('observations', {
      filter: { on: 'type', op: 'eq', value: 'discovery' },
      page: { limit: 5000 },
    });
    expect(res.total).toBe(0); // AND(commitment, discovery) — caller cannot WIDEN past scope
  });

  it('F3 query(): a caller filter that NARROWS WITHIN scope intersects (scope ∧ filter)', async () => {
    // scope: type IN (commitment, risk); caller filter: type=commitment → just commitment.
    const svc = scopedService((e) =>
      e === 'observations' ? { on: 'type', op: 'in', value: ['commitment', 'risk'] } : undefined,
    );
    const res = await svc.query('observations', {
      filter: { on: 'type', op: 'eq', value: 'commitment' },
      page: { limit: 5000 },
    });
    const ref = await truth(COMMITMENT);
    expect(res.total).toBe(num(ref[0]!.n));
  });

  it('F4 fetch(): options.scope filters the hydrated rows — IDs outside scope are dropped', async () => {
    // Take a mix of commitment + discovery IDs, then fetch under a commitment scope:
    // only the commitment ones survive (scope ANDs onto the id IN (...) filter).
    const commitIds = (
      await truth(`select id from observations where type='commitment' order by id limit 5`)
    ).map((r) => String(r.id));
    const discoveryIds = (
      await truth(`select id from observations where type='discovery' order by id limit 5`)
    ).map((r) => String(r.id));
    const svc = scopedService((e) =>
      e === 'observations' ? { on: 'type', op: 'eq', value: 'commitment' } : undefined,
    );
    const res = await svc.fetch('observations', [...commitIds, ...discoveryIds]);
    // Exactly the commitment IDs come back (scope ∧ id-IN); the discovery IDs are excluded.
    expect(res.count).toBe(commitIds.length);
    expect(new Set(res.rows.map((r) => String(r.id)))).toEqual(new Set(commitIds));
  });

  // ==========================================================================
  // (b) ITEM-F — query()/fetch() when a filter column resolves NOWHERE.
  //     HYPOTHESIS in the brief: "does it soft-drop silently?" GROUND TRUTH from
  //     the engine: it does NOT. compileLeaf → resolvePath THROWS a FIELD_PATH
  //     error for an unresolvable column on BOTH query() and fetch(). So query/
  //     fetch ALREADY fail-closed here (the condition is never silently ignored).
  // ==========================================================================

  it('F5 ITEM-F: query() with a filter column that resolves NOWHERE THROWS (no silent soft-drop)', async () => {
    // SUSPECTED-DIVERGENCE: the brief framed query/fetch as a possible *silent
    // soft-drop* (and aggregate() was hardened in d11a0dd to fail-closed so the two
    // could converge). CURRENT behavior: query() ALSO fail-closes — but via a
    // DIFFERENT error contract than aggregate(): query/fetch throw FIELD_PATH
    // ("Field path '<col>' invalid at final column '<col>'"), while aggregate()
    // throws an AGGREGATE "not a registered field" error (see F8). The IR must
    // reconcile these two error messages into one fail-closed contract; the
    // BEHAVIOR (refuse, never drop) already matches. — revisit
    expect(
      h.service.query('observations', {
        filter: { on: 'nonexistent_col', op: 'eq', value: 'x' },
        page: { limit: 10 },
      }),
    ).rejects.toThrow(/field path 'nonexistent_col' invalid at final column 'nonexistent_col'/i);
  });

  it('F6 ITEM-F: fetch() with a refinement filter column that resolves NOWHERE THROWS (same path)', async () => {
    // SUSPECTED-DIVERGENCE: same divergence as F5 — fetch()'s refinement filter
    // ANDs onto the id-IN, and an unresolvable column throws FIELD_PATH, NOT a
    // silent drop. Pinned AS-IS; the IR should land on ONE fail-closed error
    // contract across query/fetch/aggregate. — revisit
    const some = await h.service.query('observations', { page: { limit: 3 } });
    expect(
      h.service.fetch('observations', some.ids, {
        filter: { on: 'nonexistent_col', op: 'eq', value: 'x' },
      }),
    ).rejects.toThrow(/field path 'nonexistent_col' invalid at final column 'nonexistent_col'/i);
  });

  it('F7 ITEM-F control: a RESOLVABLE filter column does narrow (proves the throw is column-specific)', async () => {
    // Same shape as F5 but with a real column → no throw, narrows to the truth.
    // Confirms F5/F6 throw because the column is unresolvable, not because filtering is broken.
    const res = await h.service.query('observations', {
      filter: { on: 'type', op: 'eq', value: 'commitment' },
      page: { limit: 5000 },
    });
    const ref = await truth(COMMITMENT);
    expect(res.total).toBe(num(ref[0]!.n));
  });

  // ==========================================================================
  // (c) aggregate() fail-closed on a filter column that resolves on NO source
  //     (commit d11a0dd). Public aggregate() path → THROWS (→ 400).
  // ==========================================================================

  it('F8 aggregate(): a filter column on NO queried source HARD-THROWS (fail-closed, public path)', async () => {
    // The harness wires aggregateModel = loadDealbrainModel. A typo'd/unregistered
    // filter column is refused (not silently dropped → never answers a DIFFERENT
    // question). Distinct error text from F5/F6 (see the F5 divergence note).
    expect(
      h.service.aggregate('observations', {
        measures: [{ on: '*', agg: 'count', as: 'n' }],
        filter: { on: 'nonexistent_col', op: 'eq', value: 'x' },
      }),
    ).rejects.toThrow(/\[nonexistent_col\][\s\S]*not a registered field/i);
  });

  // ==========================================================================
  // (d) multiSourceSelect — cross-source group_by REFUSAL + FULL OUTER JOIN
  //     coalesce of the shared key. (The existing S2 proves per-source SCOPE on a
  //     multi-source aggregate; it does NOT assert the refusal or the join shape.)
  // ==========================================================================

  it('F9 multi-source: a group_by key NOT on every measure source is REFUSED (no cross-join inflation)', async () => {
    // `type` lives on observations only; the opportunities measure source lacks it. Grouping
    // by it cross-source would CROSS JOIN and inflate — the engine refuses. (ADR-0024 wave 1
    // changed the MESSAGE: a bare dim absent on a measure source now resolves NOWHERE on that
    // CTE → "unknown column …" — the caller must use the conformed entity-prefixed form, e.g.
    // `opportunities.state_of_deal_status` which joins to-one; a genuinely to-many dim like
    // `observations.type` on the opp measure is rejected by the resolver. Either way: REFUSED.)
    expect(
      h.service.aggregate('opportunities', {
        group_by: ['type'],
        measures: [
          { on: 'weighted_amount', agg: 'sum', as: 'w' },
          { source: 'observations', on: '*', agg: 'count', as: 'o' },
        ],
      }),
    ).rejects.toThrow(/unknown column "type" on opportunities/i);
  });

  it('F10 multi-source: a SHARED key (account_id) FULL OUTER JOINs + COALESCEs — group keys = the UNION', async () => {
    const res = await h.service.aggregate(
      'opportunities',
      {
        group_by: ['account_id'],
        measures: [
          { on: 'weighted_amount', agg: 'sum', as: 'w' },
          { source: 'observations', on: '*', agg: 'count', as: 'o' },
        ],
      },
      { include_sql: true },
    );
    const s = (res.sql ?? '').toLowerCase();
    // FULL OUTER JOIN of the per-source CTEs, with the shared key coalesced.
    expect(s.includes('full join') || s.includes('full outer')).toBe(true);
    expect(s).toContain('coalesce');
    // Result group keys = the COALESCED UNION of account_id across BOTH sources
    // (includes the NULL-account_id group, which the union-with-null below counts).
    const ref = await truth(
      `select count(*)::int n from (
         select account_id from opportunities group by account_id
         union
         select account_id from observations group by account_id
       ) u`,
    );
    expect(res.rows.length).toBe(num(ref[0]!.n)); // 170 (169 real account_ids + the NULL group)
  });

  // ==========================================================================
  // (e) composite ratio NULL-policy: zero/absent denominator → NULL ratio + the
  //     surfaced warning (run-drizzle counts NULL ratios per composite). The
  //     dealbrain analytics catalog ships only atomic measures, so a ratio is
  //     registered locally over the two real EAV legs (weighted_amount /
  //     deal_probability) — same legs the existing scope spec uses.
  // ==========================================================================

  it('F11 composite ratio: absent/zero denominator → NULL ratio + a warning counting those groups', async () => {
    // Local model = dealbrain model + one extra ratio in the catalog. weighted_amount
    // (sum, zero-on-empty numerator) / deal_probability (avg, NULL-on-absent
    // denominator). Grouped by account_id: a group whose opps carry NO deal_probability
    // has a NULL avg → NULLIF(coalesce(den,0),0) → NULL ratio.
    const withRatio = async () => {
      const m = await loadDealbrainModel(h.db);
      // biome-ignore lint/suspicious/noExplicitAny: appending a host ratio onto the derived catalog (mirrors host registration)
      (m as any).catalog = {
        ...m.catalog,
        wpd: { kind: 'ratio', numerator: 'weighted_amount', denominator: 'deal_probability' },
      };
      return m;
    };
    const svc = new QueryApplicationService(h.db, {
      actorUserId: POC_ACTOR_USER_ID,
      actorOrganizationId: DEALBRAIN_ORG,
      aggregateModel: withRatio,
    });
    const res = await svc.aggregate('opportunities', {
      group_by: ['account_id'],
      measures: [{ ref: 'wpd' }],
    });

    // The engine groups opportunities by account_id (169 groups). Ground-truth the
    // count of groups with NO usable denominator (avg deal_probability null/zero),
    // keyed by the SAME field_definitions KEYs the model resolves (hs_projected_amount
    // / hs_deal_stage_probability), not by label.
    const ref = await truth(
      `select count(distinct o.account_id)::int n from opportunities o
       where o.account_id not in (
         select o2.account_id from opportunities o2
         join field_values fv on fv.entity_id = o2.id and fv.entity_type='opportunity'
           and fv.field_definition_id =
             (select id from field_definitions where entity_type='opportunity' and key='hs_deal_stage_probability')
         where fv.value_number is not null
         group by o2.account_id having avg(fv.value_number) is not null and avg(fv.value_number) <> 0
       )`,
    );
    const nullDenomGroups = num(ref[0]!.n); // 46

    // (1) the NULL-ratio rows in the engine output match the SQL truth …
    const nullRows = res.rows.filter((r) => r.wpd == null).length;
    expect(nullRows).toBe(nullDenomGroups);
    expect(nullDenomGroups).toBeGreaterThan(0); // the null-policy genuinely fires

    // (2) … and the warning surfaces exactly that count (never a silent div-by-zero).
    expect(res.warnings ?? []).toContainEqual(
      `wpd: ${nullDenomGroups} group(s) have a null ratio (zero or absent denominator)`,
    );
  });

  it('F12 composite ratio control: groups WITH a denominator yield a NON-null numeric ratio', async () => {
    // The complement of F11 — proves the NULL is denominator-driven, not a blanket null.
    const withRatio = async () => {
      const m = await loadDealbrainModel(h.db);
      // biome-ignore lint/suspicious/noExplicitAny: see F11
      (m as any).catalog = {
        ...m.catalog,
        wpd: { kind: 'ratio', numerator: 'weighted_amount', denominator: 'deal_probability' },
      };
      return m;
    };
    const svc = new QueryApplicationService(h.db, {
      actorUserId: POC_ACTOR_USER_ID,
      actorOrganizationId: DEALBRAIN_ORG,
      aggregateModel: withRatio,
    });
    const res = await svc.aggregate('opportunities', {
      group_by: ['account_id'],
      measures: [{ ref: 'wpd' }],
    });
    const nonNull = res.rows.filter((r) => r.wpd != null);
    expect(nonNull.length).toBeGreaterThan(0);
    for (const r of nonNull) expect(Number.isFinite(Number(r.wpd))).toBe(true);
  });
});
