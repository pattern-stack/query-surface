// EAV-DIM-VIA-TO-ONE — an EAV select/text dimension on a belongs_to TARGET, conformed at the
// source grain and EXECUTED through the to-one join (Design 2: lowerToOne ∘ eavValueJoin). This
// closes the describe-over-promise bug: describe() advertised `opportunities.stage` (an EAV dim on
// the to-one target) as conformed, but the lowering rendered it as a NATIVE column → "unknown
// column stage on opportunities". The fix composes the SAME shared 1:1 field_values join THROUGH
// the belongs_to LEFT JOIN — both joins 1:1, so the composite stays grain-safe + scope fail-closed.
//
// FIXTURE ANALOG: the in-repo char net registers accounts/opportunities/observations only (NOT
// artifacts). observations→opportunities is the SAME shape (a SINGLE to-one onto opportunities
// whose target dim is EAV) as the original artifacts→opportunities bug — so every spec here uses
// observations→opportunities. opportunities EAV dims (stage→StageName, deal_size_band) are loaded
// via dimensionSpecs so they become role:'dimension' fields on opportunities.
//
// DETERMINISM: every expected value is recomputed from raw SQL through the SAME pool AT TEST TIME
// (the Bean Maxx fixture is non-hermetic). The truth field_values CTE is keyed by
// field_definitions.key + entity_type='opportunity' + organization_id (the org the engine resolves
// the defId under at model load), matching the engine's join exactly. Run:
//   DBURL=postgres://postgres:password@localhost:54321/dealbrain \
//     bun test src/adapters/drizzle/execute/__tests__/eav-to-one-dim.eval.spec.ts

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { conformedDimensions } from '../../../../internal/analytics/join-plan';
import { TENANT_GLOBAL } from '../../../../internal/analytics/types';
import {
  DEALBRAIN_ORG,
  type QuerySurfaceHarness,
  makeQuerySurface,
} from '../../../../characterization/harness.ts';
import { type AggregateModel, loadDealbrainModel } from '../../../reference/model.dealbrain';
import { runAggregateDrizzle } from '../run-drizzle';

const DBURL = process.env.DBURL;
const suite = DBURL ? describe : describe.skip;

// The host's resolved semantic layer: opportunities EAV select/text fields exposed as group dims.
const DIMENSION_SPECS = [
  { name: 'stage', key: 'StageName' },
  { name: 'deal_size_band', key: 'deal_size_band' },
];

suite('EAV dimension via to-one (describe/execute parity — the over-promise bug, closed)', () => {
  let h: QuerySurfaceHarness;
  let model: AggregateModel;

  beforeAll(async () => {
    h = makeQuerySurface(DBURL!, { dimensionSpecs: DIMENSION_SPECS });
    // The SAME model the service uses, loaded against the SAME pool — so the scopeFor specs
    // (which the public service can't parameterize per-call) run on the identical registry.
    model = await loadDealbrainModel(h.db, undefined, DIMENSION_SPECS);
  });
  afterAll(async () => {
    await h.close();
  });

  const truth = async <T = Record<string, unknown>>(q: string) =>
    (await h.db.execute(sql.raw(q))).rows as T[];
  const num = (v: unknown) => Number(v);

  // The truth field_values CTE for an opportunities EAV key — the 1:1 (opp → value) the engine
  // joins. Org-scoped defId provenance (entity_type + organization_id) mirrors the model load.
  const fv = (key: string) =>
    `(select fv.entity_id eid, fv.value_text v from field_values fv
        where fv.field_definition_id = (select id from field_definitions
          where key='${key}' and entity_type='opportunity' and organization_id='${DEALBRAIN_ORG}'))`;

  // ── E1 describe/execute parity — the bug, pinned closed ─────────────────────────────────────
  it('E1 describe advertises opportunities.stage AND it EXECUTES (set-identity vs truth)', async () => {
    // describe-side: the conformed set INCLUDES the EAV-on-to-one dim (the over-promise).
    const dims = conformedDimensions(model.analytics, 'observations');
    const stage = dims.find((d) => d.path === 'opportunities.stage');
    expect(stage).toBeDefined();
    expect(stage?.via).toBe('to-one'); // reached THROUGH the belongs_to, not local
    expect(stage?.owner).toBe('opportunities');

    // execute-side: PRE-FIX this threw `unknown column "stage" on opportunities`. POST-FIX it
    // lowers the field_values join THROUGH the belongs_to and returns grouped rows.
    const expected = await truth<{ stage: string | null; obs: string }>(
      `select s.v as stage, count(*) as obs
         from observations ob
         left join opportunities o on ob.opportunity_id = o.id
         left join ${fv('StageName')} s on s.eid = o.id
        group by s.v`,
    );
    const res = await h.service.measure(
      'observations',
      {
        group_by: ['opportunities.stage'],
        measures: [{ on: '*', agg: 'count', as: 'obs' }],
      },
      { include_sql: true },
    );

    // Set identity: the engine's grouped rows == the SQL ground truth, group-for-group (incl. the
    // NULL-stage bucket from the LEFT JOIN — opps lacking a StageName, plus obs lacking an opp).
    const key = (v: unknown) => (v == null ? '<null>' : String(v));
    const got = new Map(res.rows.map((r) => [key(r['opportunities.stage']), num(r.obs)]));
    expect(res.rows.length).toBe(expected.length);
    for (const e of expected) expect(got.get(key(e.stage))).toBe(num(e.obs));

    // It's a field_values join COMPOSED with the belongs_to LEFT JOIN, declared via an alias
    // (`fvt_opportunities_stage`) — never a bare `inner join <alias>` fragment (the 42P01 bug
    // class). NOT a SELECT DISTINCT over a multiplying join.
    const s = res.sql!.toLowerCase();
    expect(s).toContain('field_values');
    expect(s).toContain('fvt_opportunities_stage');
    expect(s).toContain('left join');
    expect(s).not.toContain('select distinct');
    expect(s).not.toMatch(/inner join "?field_values"? +(as +)?fvt_/);
  });

  // ── E2 grain-safety: 1:1 ∘ 1:1 = 1:1 (no inflation) ─────────────────────────────────────────
  it('E2 grain-safety: Σ(per-group obs) == total population (the two 1:1 joins do not fan)', async () => {
    // The to-one belongs_to (FK→PK, 1:1) ∘ the field_values value join (entity_id+def, 1:1) is
    // 1:1: every observation counts exactly once, with a NULL-stage bucket via the LEFT JOINs.
    const [{ n: total }] = await truth<{ n: string }>('select count(*) n from observations');
    const res = await h.service.measure('observations', {
      group_by: ['opportunities.stage'],
      measures: [{ on: '*', agg: 'count', as: 'obs' }],
    });
    const summed = res.rows.reduce((acc, r) => acc + num(r.obs), 0);
    expect(summed).toBe(num(total)); // exact — a fan-out join would over-count
  });

  // ── E3 FILTER on a to-one EAV dim (the run-drizzle guard + compileSourceFilter to-one path) ──
  it('E3 filter observations by opportunities.stage (to-one EAV) — count matches truth', async () => {
    const [{ n: want }] = await truth<{ n: string }>(
      `select count(*) n from observations ob
         join opportunities o on ob.opportunity_id = o.id
         join ${fv('StageName')} s on s.eid = o.id
        where s.v = 'closed_won'`,
    );
    const res = await h.service.measure(
      'observations',
      {
        measures: [{ on: '*', agg: 'count', as: 'obs' }],
        filter: { on: 'opportunities.stage', op: 'eq', value: 'closed_won' },
      },
      { include_sql: true },
    );
    expect(num(res.rows[0]?.obs)).toBe(num(want));
    // The filter lowered through the SAME composed join (belongs_to + field_values alias).
    expect(res.sql!.toLowerCase()).toContain('fvt_opportunities_stage');
  });

  // ── E4 HAVING over a to-one EAV group dim (the col:valueCol CTE-qualification) ───────────────
  it('E4 having on a to-one EAV grouping — the grouped subquery wraps + filters correctly', async () => {
    const THRESH = 1000;
    const expected = await truth<{ stage: string | null; obs: string }>(
      `select s.v as stage, count(*) as obs
         from observations ob
         left join opportunities o on ob.opportunity_id = o.id
         left join ${fv('StageName')} s on s.eid = o.id
        group by s.v having count(*) > ${THRESH}`,
    );
    // PRE-FIX would also throw at the group step; this additionally proves the EAV value column
    // CTE-qualifies (col:valueCol) so the HAVING wrapper select over the grouped subquery resolves
    // (an expr-only return would render a bare alias → "column reference ambiguous").
    const res = await h.service.measure('observations', {
      group_by: ['opportunities.stage'],
      measures: [{ on: '*', agg: 'count', as: 'obs' }],
      having: { on: 'obs', op: 'gt', value: THRESH },
    });
    const key = (v: unknown) => (v == null ? '<null>' : String(v));
    const got = new Map(res.rows.map((r) => [key(r['opportunities.stage']), num(r.obs)]));
    expect(res.rows.length).toBe(expected.length);
    for (const e of expected) expect(got.get(key(e.stage))).toBe(num(e.obs));
    for (const r of res.rows) expect(num(r.obs)).toBeGreaterThan(THRESH);
  });

  // ── E5 ≥2 EAV-to-one dims in ONE statement (distinct aliases, no collision) ──────────────────
  it('E5 two to-one EAV dims (stage + deal_size_band) in one group_by — distinct fv aliases', async () => {
    const expected = await truth<{ stage: string | null; band: string | null; obs: string }>(
      `select s.v as stage, b.v as band, count(*) as obs
         from observations ob
         left join opportunities o on ob.opportunity_id = o.id
         left join ${fv('StageName')} s on s.eid = o.id
         left join ${fv('deal_size_band')} b on b.eid = o.id
        group by s.v, b.v`,
    );
    const res = await h.service.measure(
      'observations',
      {
        group_by: ['opportunities.stage', 'opportunities.deal_size_band'],
        measures: [{ on: '*', agg: 'count', as: 'obs' }],
      },
      { include_sql: true },
    );
    const key = (s: unknown, b: unknown) =>
      `${s == null ? '<null>' : s}|${b == null ? '<null>' : b}`;
    const got = new Map(
      res.rows.map((r) => [
        key(r['opportunities.stage'], r['opportunities.deal_size_band']),
        num(r.obs),
      ]),
    );
    expect(res.rows.length).toBe(expected.length);
    for (const e of expected) expect(got.get(key(e.stage, e.band))).toBe(num(e.obs));

    // TWO DISTINCT field_values aliases — the per-(target,column) scheme dedupes correctly and the
    // join dedup (by table name) keeps both. A leaf-only alias scheme would have collided.
    const s = res.sql!.toLowerCase();
    expect(s).toContain('fvt_opportunities_stage');
    expect(s).toContain('fvt_opportunities_deal_size_band');
    // Grain-safe across both 1:1 joins: the population is conserved.
    const [{ n: total }] = await truth<{ n: string }>('select count(*) n from observations');
    expect(res.rows.reduce((acc, r) => acc + num(r.obs), 0)).toBe(num(total));
  });

  // ── E6 COMPARE grouped by a to-one EAV dim, variants filtering ANOTHER to-one EAV dim ────────
  it('E6 compare grouped by opportunities.stage, variants on opportunities.deal_size_band', async () => {
    const stageOf = async (band: string) =>
      truth<{ stage: string | null; obs: string }>(
        `select s.v as stage, count(*) as obs
           from observations ob
           join opportunities o on ob.opportunity_id = o.id
           left join ${fv('StageName')} s on s.eid = o.id
           join ${fv('deal_size_band')} b on b.eid = o.id and b.v = '${band}'
          group by s.v`,
      );
    const entExpected = await stageOf('enterprise');

    const res = await h.service.compare('observations', {
      group_by: ['opportunities.stage'],
      measures: [{ on: '*', agg: 'count', as: 'obs' }],
      variants: [
        { label: 'ent', filter: { on: 'opportunities.deal_size_band', op: 'eq', value: 'enterprise' } },
        { label: 'mid', filter: { on: 'opportunities.deal_size_band', op: 'eq', value: 'mid' } },
      ],
      delivery: 'separate',
    });
    expect(res.delivery).toBe('separate');
    if (res.delivery !== 'separate') throw new Error('expected separate delivery');
    const ent = res.variants.find((v) => v.label === 'ent')!;
    const key = (v: unknown) => (v == null ? '<null>' : String(v));
    const got = new Map(ent.rows.map((r) => [key(r['opportunities.stage']), num(r.obs)]));
    expect(ent.rows.length).toBe(entExpected.length);
    for (const e of entExpected) expect(got.get(key(e.stage))).toBe(num(e.obs));
  });

  // ── E7 native-to-one regression — the EAV branch must NOT perturb the native path ───────────
  it('E7 a NATIVE to-one dim (opportunities.state_of_deal_status) emits NO field_values join', async () => {
    const expected = await truth<{ status: string | null; obs: string }>(
      `select o.state_of_deal_status as status, count(*) as obs
         from observations ob
         left join opportunities o on ob.opportunity_id = o.id
        group by o.state_of_deal_status`,
    );
    const res = await h.service.measure(
      'observations',
      {
        group_by: ['opportunities.state_of_deal_status'],
        measures: [{ on: '*', agg: 'count', as: 'obs' }],
      },
      { include_sql: true },
    );
    const key = (v: unknown) => (v == null ? '<null>' : String(v));
    const got = new Map(res.rows.map((r) => [key(r['opportunities.state_of_deal_status']), num(r.obs)]));
    expect(res.rows.length).toBe(expected.length);
    for (const e of expected) expect(got.get(key(e.status))).toBe(num(e.obs));
    // The native path is untouched: a real belongs_to LEFT JOIN, NO field_values / fvt_ alias.
    const s = res.sql!.toLowerCase();
    expect(s).toContain('left join');
    expect(s).not.toContain('field_values');
    expect(s).not.toContain('fvt_');
  });

  // ── E8 scope FAIL-CLOSED on the EAV-to-one target (the branch sits AFTER the scope-fold) ─────
  it('E8 an uncovered to-one target REFUSES (coverage gap thrown before the EAV column resolves)', async () => {
    // observations is whitelisted; the JOINED opportunities (the EAV target) has no scope answer.
    // The EAV branch sits AFTER the scope-folded hop loop, so scopeSqlFor(opportunities) throws the
    // coverage gap BEFORE the field_values join is built — never an unscoped EAV read.
    expect(
      runAggregateDrizzle(
        h.db,
        model,
        {
          entity: 'observations',
          group_by: ['opportunities.stage'],
          measures: [{ on: '*', agg: 'count', as: 'obs' }],
        },
        (src) => (src === 'observations' ? TENANT_GLOBAL : undefined),
      ),
    ).rejects.toThrow(/no tenancy scope|coverage gap|refusing/i);
  });

  // ── E9 scope FOLDS into the belongs_to ON for an EAV-to-one dim (out-of-scope → NULL group) ──
  it('E9 a scoped EAV-to-one target folds the predicate into the belongs_to ON (NULL-group, not dropped)', async () => {
    // Scope opportunities to a NATIVE predicate (state_of_deal_status <> 'won'): the belongs_to ON
    // gains it, so a 'won' opp's observations join to NULL → land in the NULL-stage bucket rather
    // than being DROPPED. The total obs population is conserved (LEFT JOIN), and the EAV value join
    // hangs off the now-NULL opp pk → NULL stage. Proves scope reaches the JOIN ahead of the EAV.
    const res = await runAggregateDrizzle(
      h.db,
      model,
      {
        entity: 'observations',
        group_by: ['opportunities.stage'],
        measures: [{ on: '*', agg: 'count', as: 'obs' }],
      },
      (src) =>
        src === 'opportunities'
          ? { on: 'state_of_deal_status', op: 'neq', value: 'won' }
          : TENANT_GLOBAL,
    );
    // Population conserved despite the scope (NULL-group, not dropped rows).
    const [{ n: total }] = await truth<{ n: string }>('select count(*) n from observations');
    expect(res.rows.reduce((acc, r) => acc + num(r.obs), 0)).toBe(num(total));
    // The scope landed in the belongs_to LEFT JOIN ON (not the source WHERE).
    expect(res.sql.toLowerCase()).toMatch(/left join "opportunities" on .*state_of_deal_status/);
    // Truth: observations whose in-scope ('won'-excluded) opp HAS a 'closed_won' StageName.
    const [{ n: cw }] = await truth<{ n: string }>(
      `select count(*) n from observations ob
         join opportunities o on ob.opportunity_id = o.id and o.state_of_deal_status <> 'won'
         join ${fv('StageName')} s on s.eid = o.id where s.v = 'closed_won'`,
    );
    const got = res.rows.find((r) => r['opportunities.stage'] === 'closed_won');
    expect(num(got?.obs ?? 0)).toBe(num(cw));
  });

  // ── E10 diamond + to-many STILL reject (the EAV branch only fires inside the to-one arm) ─────
  it('E10 a DIAMOND dim still REJECTS as ambiguous (EAV branch never reached for >1 to-one path)', async () => {
    // observations→accounts is reachable directly (account_id) AND via opportunity → a diamond.
    // resolveJoinPlan rejects BEFORE any lowering, so the EAV composition is never reached.
    expect(
      runAggregateDrizzle(h.db, model, {
        entity: 'observations',
        group_by: ['accounts.name'],
        measures: [{ on: '*', agg: 'count', as: 'obs' }],
      }),
    ).rejects.toThrow(/ambiguous|diamond|distinct to-one/i);
  });

  it('E11 a TO-MANY group dim still REJECTS (the EAV branch only fires on a to-one target)', async () => {
    // opportunities→observations is has_many → grouping by it would fan out. Rejected in
    // resolveJoinPlan (group role) before lowering — the EAV branch lives inside the to-one arm.
    expect(
      runAggregateDrizzle(h.db, model, {
        entity: 'opportunities',
        group_by: ['observations.type'],
        measures: [{ on: '*', agg: 'count', as: 'cnt' }],
      }),
    ).rejects.toThrow(/to-many|fan out|not conformed/i);
  });

  it('E12 group_by a MEASURE is REJECTED — the footgun is blocked (PascalCase: caught upstream)', async () => {
    // Grouping by a measure's raw value (one group per distinct value) is never allowed. A
    // PascalCase key like Amount is caught by the pre-existing identifier guard; either way the
    // request fails loud rather than silently grouping by a measure. (Filtering on Amount stays legal.)
    expect(
      runAggregateDrizzle(h.db, model, {
        entity: 'observations',
        group_by: ['opportunities.Amount'],
        measures: [{ on: '*', agg: 'count', as: 'cnt' }],
      }),
    ).rejects.toThrow(/unsafe identifier|not a groupable dimension/i);
  });

  it('E13 group_by a SNAKE-keyed EAV MEASURE hits the ROLE GATE with the clear reason (own-entity + to-one)', async () => {
    // snake keys pass the identifier guard, so they reach lowerGroupDim's role gate — THIS is the
    // case the new gate exists for (a measure the lowering COULD resolve but must not group).
    const m = await loadDealbrainModel(h.db, [{ key: 'age_days', aggs: ['avg', 'max'], additivity: 'non' }], DIMENSION_SPECS);
    // own-entity: group opportunities by the raw age_days measure
    expect(
      runAggregateDrizzle(h.db, m, {
        entity: 'opportunities',
        group_by: ['age_days'],
        measures: [{ on: '*', agg: 'count', as: 'cnt' }],
      }),
    ).rejects.toThrow(/is a measure.*not a groupable dimension/i);
    // to-one: group observations by opportunities.age_days (the resolveJoinPlan→to-one gate)
    expect(
      runAggregateDrizzle(h.db, m, {
        entity: 'observations',
        group_by: ['opportunities.age_days'],
        measures: [{ on: '*', agg: 'count', as: 'cnt' }],
      }),
    ).rejects.toThrow(/is a measure.*not a groupable dimension/i);
  });

  it('E14 FILTER on a measure stays LEGAL (the group-only gate must not block measure filters)', async () => {
    // Amount > 100000 as a filter is valid (you filter on measures); only GROUP-BY is dim-only.
    const res = await runAggregateDrizzle(h.db, model, {
      entity: 'opportunities',
      filter: { on: 'Amount', op: 'gt', value: 100000 },
      measures: [{ on: '*', agg: 'count', as: 'cnt' }],
    });
    expect(Number(res.rows[0]!.cnt)).toBeGreaterThan(0);
  });
});
