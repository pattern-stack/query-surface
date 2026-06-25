// compare() against live dealbrain — variant-vs-variant (observation `type` as the
// variant axis: 'commitment' vs 'risk'), the same machinery PoP uses with time filters.
// The variant-runner here calls runAggregateDrizzle — exactly what the service injects.
//
//   DBURL=postgres://postgres:PW@localhost:54321/dealbrain bun test compare.eval

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import {
  type CompareRequest,
  runCompare,
  stitchCompare,
} from '../../../../internal/analytics/compare';
import type { AggregateInput } from '../../../../internal/analytics/measure-catalog';
import { QueryApplicationService } from '../../../../query.application-service';
import { type AggregateModel, loadDealbrainModel } from '../../../reference/model.dealbrain';
import { type DrizzleDb, makeDb } from '../drizzle-db';
import { runAggregateDrizzle } from '../run-drizzle';

const DBURL = process.env.DBURL;
const suite = DBURL ? describe : describe.skip;

suite('compare() — live dealbrain (variant-vs-variant on observation type)', () => {
  let db: DrizzleDb;
  let close: () => Promise<void>;
  let model: AggregateModel;
  const truth = async (text: string) =>
    (await db.execute(sql.raw(text))).rows as Record<string, unknown>[];
  const num = (v: unknown) => Number(v);

  // The variant runner the orchestrator drives — same path the service uses.
  const run = (entity: string, req: CompareRequest) =>
    runCompare(entity, req, (agg: Omit<AggregateInput, 'entity'>) =>
      runAggregateDrizzle(db, model, { ...agg, entity }).then((r) => ({
        rows: r.rows,
        warnings: r.warnings,
      })),
    );

  beforeAll(async () => {
    ({ db, close } = makeDb(DBURL!));
    model = await loadDealbrainModel(db);
  });
  afterAll(async () => {
    await close?.();
  });

  const pvp = (over: Partial<CompareRequest> = {}): CompareRequest => ({
    group_by: ['account_id'],
    measures: [{ on: '*', agg: 'count', as: 'obs' }],
    variants: [
      { label: 'commitment', filter: { on: 'type', op: 'eq', value: 'commitment' } },
      { label: 'risk', filter: { on: 'type', op: 'eq', value: 'risk' } },
    ],
    compare: { baseline: 'commitment', derive: ['delta'] },
    ...over,
  });

  it('C1 stitched PvP: per-account values + delta == truth', async () => {
    const res = await run('observations', pvp());
    expect(res.delivery).toBe('stitched');
    if (res.delivery !== 'stitched') throw new Error('unreachable');
    const commit = new Map(
      (
        await truth(
          `select account_id, count(*)::int n from observations where type='commitment' group by account_id`,
        )
      ).map((r) => [String(r.account_id), num(r.n)]),
    );
    const risk = new Map(
      (
        await truth(
          `select account_id, count(*)::int n from observations where type='risk' group by account_id`,
        )
      ).map((r) => [String(r.account_id), num(r.n)]),
    );
    expect(res.rows.length).toBeGreaterThan(0);
    for (const row of res.rows) {
      const acct = String(row.account_id);
      const c = row.obs__commitment == null ? null : num(row.obs__commitment);
      const rk = row.obs__risk == null ? null : num(row.obs__risk);
      expect(c).toBe(commit.get(acct) ?? null);
      expect(rk).toBe(risk.get(acct) ?? null);
      // delta = risk − commitment (baseline=commitment); null when either side absent
      const d = row.obs__risk__delta;
      if (c == null || rk == null) expect(d).toBeNull();
      else expect(num(d)).toBe(rk - c);
    }
  });

  it('C2 separate delivery: two labeled result sets == per-type truth', async () => {
    const res = await run('observations', pvp({ delivery: 'separate' }));
    expect(res.delivery).toBe('separate');
    if (res.delivery !== 'separate') throw new Error('unreachable');
    expect(res.variants.map((v) => v.label)).toEqual(['commitment', 'risk']);
    // count GROUPS (incl. the NULL-account bucket, which group_by produces but
    // count(distinct account_id) would skip) — must match the aggregate's row count.
    const refCommit = num(
      (
        await truth(
          `select count(*)::int c from (select account_id from observations where type='commitment' group by account_id) t`,
        )
      )[0]!.c,
    );
    expect(res.variants[0]!.rows.length).toBe(refCommit);
  });

  it('C3 global compare (no group_by): total commitment vs risk + delta', async () => {
    const res = await run('observations', pvp({ group_by: undefined }));
    if (res.delivery !== 'stitched') throw new Error('unreachable');
    expect(res.rows).toHaveLength(1);
    const c = num(
      (await truth(`select count(*)::int n from observations where type='commitment'`))[0]!.n,
    );
    const rk = num(
      (await truth(`select count(*)::int n from observations where type='risk'`))[0]!.n,
    );
    expect(num(res.rows[0]!.obs__commitment)).toBe(c);
    expect(num(res.rows[0]!.obs__risk)).toBe(rk);
    expect(num(res.rows[0]!.obs__risk__delta)).toBe(rk - c);
  });

  it('C4 order_by + limit rank the STITCHED rows (same top-N compared across variants)', async () => {
    const res = await run(
      'observations',
      pvp({ order_by: [{ on: 'obs__commitment', dir: 'desc' }], limit: 5 }),
    );
    if (res.delivery !== 'stitched') throw new Error('unreachable');
    expect(res.rows.length).toBeLessThanOrEqual(5);
    // sorted desc by obs__commitment (nulls last), and both variant columns present
    const vals = res.rows.map((r) => (r.obs__commitment == null ? -1 : num(r.obs__commitment)));
    expect([...vals].sort((a, b) => b - a)).toEqual(vals);
    expect(res.rows[0]).toHaveProperty('obs__risk');
  });

  it('C5 per_variant_top churn: keyset == UNION of each variant top-N', async () => {
    const res = await run(
      'observations',
      pvp({ per_variant_top: { by: 'obs', n: 3 }, compare: { baseline: 'commitment' } }),
    );
    if (res.delivery !== 'stitched') throw new Error('unreachable');
    const topCommit = (
      await truth(
        `select account_id from observations where type='commitment' group by account_id order by count(*) desc limit 3`,
      )
    ).map((r) => String(r.account_id));
    const topRisk = (
      await truth(
        `select account_id from observations where type='risk' group by account_id order by count(*) desc limit 3`,
      )
    ).map((r) => String(r.account_id));
    const expectedKeys = new Set([...topCommit, ...topRisk]);
    const gotKeys = new Set(res.rows.map((r) => String(r.account_id)));
    expect(gotKeys).toEqual(expectedKeys);
  });

  it('C6 pct_change with absent baseline → null + warning', async () => {
    // baseline = a RARE type (urgency); compared = a common one (discovery). Many accounts
    // have discovery but no urgency → baseline absent → pct must be NULL, never fabricated.
    const res = await run('observations', {
      group_by: ['account_id'],
      measures: [{ on: '*', agg: 'count', as: 'obs' }],
      variants: [
        { label: 'urgency', filter: { on: 'type', op: 'eq', value: 'urgency' } },
        { label: 'discovery', filter: { on: 'type', op: 'eq', value: 'discovery' } },
      ],
      compare: { baseline: 'urgency', derive: ['pct_change'] },
    });
    if (res.delivery !== 'stitched') throw new Error('unreachable');
    const urgencyAccts = new Set(
      (await truth(`select distinct account_id from observations where type='urgency'`)).map((r) =>
        String(r.account_id),
      ),
    );
    const noBaseline = res.rows.filter(
      (r) => r.obs__discovery != null && !urgencyAccts.has(String(r.account_id)),
    );
    expect(noBaseline.length).toBeGreaterThan(0); // accounts with discovery but no urgency
    for (const r of noBaseline) expect(r.obs__discovery__pct_change).toBeNull();
    expect((res.warnings ?? []).some((w) => /pct_change.*absent baseline/.test(w))).toBe(true);
  });

  it('C7 variant filter is scoped/soft-dropped like a base filter (no hard-throw on cross-source)', async () => {
    // type lives on observations; a variant filter on it is fine here. This pins that a
    // variant filter behaves like q.filter (no special strictness) — runs without throwing.
    const res = await run('observations', pvp());
    expect(res.delivery).toBe('stitched');
  });

  // ── N-variant: prove the "N" in N-variant beyond the 2-variant default ────────
  it('C8 N=3 variants (discovery/commitment/risk): all three values + both deltas == truth', async () => {
    const res = await run('observations', {
      group_by: ['account_id'],
      measures: [{ on: '*', agg: 'count', as: 'obs' }],
      variants: [
        { label: 'discovery', filter: { on: 'type', op: 'eq', value: 'discovery' } },
        { label: 'commitment', filter: { on: 'type', op: 'eq', value: 'commitment' } },
        { label: 'risk', filter: { on: 'type', op: 'eq', value: 'risk' } },
      ],
      compare: { baseline: 'discovery', derive: ['delta'] },
    });
    if (res.delivery !== 'stitched') throw new Error('unreachable');
    expect(res.variants).toEqual(['discovery', 'commitment', 'risk']);
    const byType = async (t: string) =>
      new Map(
        (
          await truth(
            `select account_id, count(*)::int n from observations where type='${t}' group by account_id`,
          )
        ).map((r) => [String(r.account_id), num(r.n)]),
      );
    const [disc, comm, risk] = await Promise.all([
      byType('discovery'),
      byType('commitment'),
      byType('risk'),
    ]);
    for (const row of res.rows) {
      const acct = String(row.account_id);
      const d = row.obs__discovery == null ? null : num(row.obs__discovery);
      const c = row.obs__commitment == null ? null : num(row.obs__commitment);
      const rk = row.obs__risk == null ? null : num(row.obs__risk);
      expect(d).toBe(disc.get(acct) ?? null);
      expect(c).toBe(comm.get(acct) ?? null);
      expect(rk).toBe(risk.get(acct) ?? null);
      // baseline=discovery → no discovery derive col; both others derive vs discovery
      expect(row).not.toHaveProperty('obs__discovery__delta');
      expect(row.obs__commitment__delta).toBe(d == null || c == null ? null : c - d);
      expect(row.obs__risk__delta).toBe(d == null || rk == null ? null : rk - d);
    }
  });

  // ── PoP proper: a TIME-WINDOW variant (the headline use case; never tested above) ─
  it('C9 time-window PoP: Q4-2025 vs Q1-2026 counts by type, values + delta + pct == truth', async () => {
    const res = await run('observations', {
      group_by: ['type'],
      measures: [{ on: '*', agg: 'count', as: 'obs' }],
      variants: [
        {
          label: 'q4',
          filter: {
            and: [
              { on: 'occurred_at', op: 'gte', value: '2025-10-01' },
              { on: 'occurred_at', op: 'lt', value: '2026-01-01' },
            ],
          },
        },
        {
          label: 'q1',
          filter: {
            and: [
              { on: 'occurred_at', op: 'gte', value: '2026-01-01' },
              { on: 'occurred_at', op: 'lt', value: '2026-04-01' },
            ],
          },
        },
      ],
      compare: { baseline: 'q4', derive: ['delta', 'pct_change'] },
    });
    if (res.delivery !== 'stitched') throw new Error('unreachable');
    const win = async (lo: string, hi: string) =>
      new Map(
        (
          await truth(
            `select type, count(*)::int n from observations where occurred_at >= '${lo}' and occurred_at < '${hi}' group by type`,
          )
        ).map((r) => [String(r.type), num(r.n)]),
      );
    const q4 = await win('2025-10-01', '2026-01-01');
    const q1 = await win('2026-01-01', '2026-04-01');
    expect(res.rows.length).toBeGreaterThan(0);
    for (const row of res.rows) {
      const t = String(row.type);
      const a = row.obs__q4 == null ? null : num(row.obs__q4); // baseline leg
      const b = row.obs__q1 == null ? null : num(row.obs__q1);
      expect(a).toBe(q4.get(t) ?? null);
      expect(b).toBe(q1.get(t) ?? null);
      expect(row.obs__q1__delta).toBe(a == null || b == null ? null : b - a);
      const pct = row.obs__q1__pct_change;
      if (a == null || a === 0 || b == null) expect(pct).toBeNull();
      else expect(num(pct)).toBeCloseTo((b - a) / a, 10);
    }
  });

  // ── full column matrix: 2 measures × 2 derives, aligned per account ───────────
  it('C10 multi-measure × multi-derive: obs + distinct-opps, delta + pct, per account == truth', async () => {
    const res = await run('observations', {
      group_by: ['account_id'],
      measures: [
        { on: '*', agg: 'count', as: 'obs' },
        { on: 'opportunity_id', agg: 'count_distinct', as: 'opps' },
      ],
      variants: [
        { label: 'commitment', filter: { on: 'type', op: 'eq', value: 'commitment' } },
        { label: 'risk', filter: { on: 'type', op: 'eq', value: 'risk' } },
      ],
      compare: { baseline: 'commitment', derive: ['delta', 'pct_change'] },
    });
    if (res.delivery !== 'stitched') throw new Error('unreachable');
    expect([...res.measures].sort()).toEqual(['obs', 'opps']);
    const byType = async (t: string) =>
      new Map(
        (
          await truth(
            `select account_id, count(*)::int obs, count(distinct opportunity_id)::int opps from observations where type='${t}' group by account_id`,
          )
        ).map((r) => [String(r.account_id), { obs: num(r.obs), opps: num(r.opps) }]),
      );
    const comm = await byType('commitment');
    const risk = await byType('risk');
    for (const row of res.rows) {
      const acct = String(row.account_id);
      const c = comm.get(acct);
      const rk = risk.get(acct);
      for (const meas of ['obs', 'opps'] as const) {
        const cv = row[`${meas}__commitment`];
        const rv = row[`${meas}__risk`];
        // count/count_distinct columns serialize as strings (pg bigint) — coerce, like C1.
        expect(cv == null ? null : num(cv)).toBe(c?.[meas] ?? null);
        expect(rv == null ? null : num(rv)).toBe(rk?.[meas] ?? null);
        const base = c?.[meas] ?? null;
        const variant = rk?.[meas] ?? null;
        // delta is computed numeric (stitchCompare coerces), so it stays a number/null.
        expect(row[`${meas}__risk__delta`]).toBe(
          base == null || variant == null ? null : variant - base,
        );
      }
    }
  });

  // ── ordering by a DERIVE column (C4 only ordered by a value column) ───────────
  it('C11 order_by on a DERIVE column ranks the stitched rows (nulls last)', async () => {
    const res = await run(
      'observations',
      pvp({ order_by: [{ on: 'obs__risk__delta', dir: 'asc' }], limit: 10 }),
    );
    if (res.delivery !== 'stitched') throw new Error('unreachable');
    expect(res.rows.length).toBeLessThanOrEqual(10);
    const vals = res.rows.map((r) => r.obs__risk__delta);
    const nonNull = vals.filter((v) => v != null).map(num);
    expect([...nonNull].sort((a, b) => a - b)).toEqual(nonNull); // asc prefix
    const firstNull = vals.findIndex((v) => v == null);
    if (firstNull >= 0) expect(vals.slice(firstNull).every((v) => v == null)).toBe(true); // nulls last
  });

  // ── THE design claim: server pre-stitch === client re-stitch of the SAME parts ─
  it('C12 client-stitch parity: separate parts re-stitched client-side === server stitched', async () => {
    const base = pvp({ compare: { baseline: 'commitment', derive: ['delta', 'pct_change'] } });
    const server = await run('observations', base);
    const sep = await run('observations', { ...base, delivery: 'separate' });
    if (server.delivery !== 'stitched' || sep.delivery !== 'separate') {
      throw new Error('unreachable');
    }
    // Client stitches the separate parts with the EXACT exported function — they can't disagree.
    const client = stitchCompare(
      sep.variants.map((v) => ({ label: v.label, rows: v.rows })),
      { groupBy: ['account_id'], baseline: 'commitment', derive: ['delta', 'pct_change'] },
    );
    const norm = (rows: Record<string, unknown>[]) =>
      new Map(rows.map((r) => [String(r.account_id), JSON.stringify(r)]));
    const s = norm(server.rows);
    const c = norm(client.rows);
    expect(c.size).toBe(s.size);
    expect(s.size).toBeGreaterThan(0);
    for (const [k, v] of s) expect(c.get(k)).toBe(v);
  });

  // ── scope is inherited PER VARIANT (each variant is a scoped aggregate) ───────
  it('C13 scope applies per variant (non-bypassable) via QueryApplicationService.compare', async () => {
    const acct = String(
      (
        await truth(
          'select account_id from observations where account_id is not null group by account_id order by count(*) desc limit 1',
        )
      )[0]!.account_id,
    );
    const req: CompareRequest = {
      group_by: ['account_id'],
      measures: [{ on: '*', agg: 'count', as: 'obs' }],
      variants: [
        { label: 'commitment', filter: { on: 'type', op: 'eq', value: 'commitment' } },
        { label: 'risk', filter: { on: 'type', op: 'eq', value: 'risk' } },
      ],
      compare: { baseline: 'commitment', derive: ['delta'] },
    };
    const scoped = new QueryApplicationService(db, {
      aggregateModel: () => loadDealbrainModel(db),
      scope: (entity) =>
        entity === 'observations' ? { on: 'account_id', op: 'eq', value: acct } : undefined,
    });
    const res = await scoped.compare('observations' as never, req);
    if (res.delivery !== 'stitched') throw new Error('unreachable');
    // scope pins EVERY variant to the one account → exactly one aligned group, that account
    expect(res.rows).toHaveLength(1);
    expect(String(res.rows[0]!.account_id)).toBe(acct);
    const c = num(
      (
        await truth(
          `select count(*)::int n from observations where type='commitment' and account_id='${acct}'`,
        )
      )[0]!.n,
    );
    const rk = num(
      (
        await truth(
          `select count(*)::int n from observations where type='risk' and account_id='${acct}'`,
        )
      )[0]!.n,
    );
    expect(num(res.rows[0]!.obs__commitment)).toBe(c);
    expect(num(res.rows[0]!.obs__risk)).toBe(rk);
    // and an UNSCOPED service returns many accounts — proving the scope genuinely narrowed.
    const unscoped = new QueryApplicationService(db, {
      aggregateModel: () => loadDealbrainModel(db),
    });
    const all = await unscoped.compare('observations' as never, req);
    if (all.delivery !== 'stitched') throw new Error('unreachable');
    expect(all.rows.length).toBeGreaterThan(1);
  });

  // ── the Q6 landmine: an unqueryable filter column must FAIL CLOSED (inherited) ────
  it('C14 fail-closed: a VARIANT filter on an unqueryable column is REFUSED (no silent self-compare)', async () => {
    // `nonsense_col` is not a queryable field on observations → the engine throws (rather than
    // soft-dropping and leaving variant "a" on the FULL population identical to "b"). compare
    // inherits the throw — it never returns a fabricated "no difference".
    await expect(
      run('observations', {
        group_by: ['account_id'],
        measures: [{ on: '*', agg: 'count', as: 'obs' }],
        variants: [
          { label: 'a', filter: { on: 'nonsense_col', op: 'eq', value: 'x' } },
          { label: 'b', filter: { on: 'type', op: 'eq', value: 'risk' } },
        ],
      }),
    ).rejects.toThrow(/\[nonsense_col\] not queryable on observations/i);
  });

  it('C15 fail-closed: a BASE filter on an unqueryable column ALSO refuses (ANDed into every variant)', async () => {
    // The base filter is ANDed into each variant, so an unqueryable base column makes every
    // variant's aggregate throw — compare aborts rather than comparing grand-total-to-itself.
    await expect(
      run('observations', {
        group_by: ['account_id'],
        measures: [{ on: '*', agg: 'count', as: 'obs' }],
        filter: { on: 'nonsense_col', op: 'eq', value: 'x' },
        variants: [
          { label: 'commitment', filter: { on: 'type', op: 'eq', value: 'commitment' } },
          { label: 'risk', filter: { on: 'type', op: 'eq', value: 'risk' } },
        ],
      }),
    ).rejects.toThrow(/not queryable on observations/i);
  });

  it('C16 fail-closed: a MULTI-SOURCE compare distinguished by a DIAMOND column is REFUSED (no fabricated no-difference)', async () => {
    // The re-review's smoking gun (ADR-0024 wave 1): obs + opp measures, variants distinguished
    // by accounts.name. accounts.name is a clean to-one from opportunities but an ambiguous
    // DIAMOND from observations — so it does NOT conform on every measure source. Before the
    // every-source-conformance rule, the obs measure silently no-opped the variant filter → both
    // legs collapsed to the full 7548-corpus → a fabricated delta=0 (ground truth: Holman has 0
    // observations, Aaxisdigital has 31). Now the global-filter conformance guard rejects it and
    // compare aborts honestly instead of comparing the corpus to itself.
    await expect(
      run('observations', {
        group_by: ['account_id'],
        measures: [
          { on: '*', agg: 'count', as: 'obs' },
          { source: 'opportunities', on: '*', agg: 'count', as: 'opp' },
        ],
        variants: [
          { label: 'holman', filter: { on: 'accounts.name', op: 'eq', value: 'Holman' } },
          { label: 'aax', filter: { on: 'accounts.name', op: 'eq', value: 'Aaxisdigital' } },
        ],
      }),
    ).rejects.toThrow(/ambiguous|diamond|distinct to-one/i);
  });
});
