// SAME eval superset as aggregate.eval.spec.ts, now via the DRIZZLE-NATIVE path
// (real registry from relations(), real PgColumns, parameterized Drizzle sql).
// The eval is the safety net: behavior is pinned, only the engine underneath changed.
//
//   DBURL=postgres://postgres:PW@localhost:54321/dealbrain bun test aggregate.drizzle.eval

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertAggregateSafe } from '../../../../internal/analytics/doctor';
import type {
  AtomicMeasureDef,
  RatioMeasureDef,
} from '../../../../internal/analytics/measure-catalog';
import { type DealbrainModel, loadDealbrainModel } from '../../../reference/model.dealbrain';
import { compileNaiveDrizzle } from '../../compile/compile-drizzle';
import { type DrizzleDb, makeDb } from '../drizzle-db';
import { aggregate, runAggregateDrizzle } from '../run-drizzle';

const DBURL = process.env.DBURL;
const suite = DBURL ? describe : describe.skip;
const WA = `(select id from field_definitions where entity_type='opportunity' and label='Weighted amount')`;
const DP = `(select id from field_definitions where entity_type='opportunity' and label='Deal probability')`;

suite('aggregate engine — Drizzle-native, live dealbrain eval superset', () => {
  let db: DrizzleDb;
  let close: () => Promise<void>;
  let model: DealbrainModel;
  const truth = async (text: string) => {
    return (await db.execute(sql.raw(text))).rows as Record<string, unknown>[];
  };
  const num = (v: unknown) => Number(v);

  beforeAll(async () => {
    ({ db, close } = makeDb(DBURL!));
    model = await loadDealbrainModel(db);
  });
  afterAll(async () => {
    await close?.();
  });

  it('E1 grouped aggregation + multi-field ordering', async () => {
    const res = await runAggregateDrizzle(db, model, {
      entity: 'observations',
      group_by: ['type'],
      measures: [{ on: '*', agg: 'count', as: 'n' }],
      order_by: [
        { on: 'n', dir: 'desc' },
        { on: 'type', dir: 'asc' },
      ],
      limit: 5,
    });
    const ref = await truth(
      `select type, count(*)::int as n from observations group by type order by n desc, type asc limit 5`,
    );
    expect(res.rows.map((r) => ({ type: r.type, n: num(r.n) }))).toEqual(
      ref.map((r) => ({ type: r.type, n: num(r.n) })),
    );
    expect(res.group_count).toBe(
      num((await truth(`select count(distinct type)::int c from observations`))[0]!.c),
    );
  });

  it('E2 filtered (conditional) measure + boolean predicate', async () => {
    const res = await runAggregateDrizzle(db, model, {
      entity: 'observations',
      measures: [
        {
          on: 'id',
          agg: 'count_distinct',
          as: 'n',
          where: {
            or: [
              { on: 'type', op: 'eq', value: 'commitment' },
              { on: 'type', op: 'eq', value: 'risk' },
            ],
          },
        },
      ],
    });
    const ref = await truth(
      `select count(distinct id)::int n from observations where type in ('commitment','risk')`,
    );
    expect(num(res.rows[0]!.n)).toBe(num(ref[0]!.n));
  });

  it('E3 date-only comparisons are whole-day', async () => {
    const lte = await runAggregateDrizzle(db, model, {
      entity: 'observations',
      measures: [{ on: '*', agg: 'count', as: 'n' }],
      filter: { on: 'occurred_at', op: 'lte', value: '2026-06-09' },
    });
    expect(num(lte.rows[0]!.n)).toBe(
      num(
        (
          await truth(
            `select count(*)::int n from observations where occurred_at < date '2026-06-10'`,
          )
        )[0]!.n,
      ),
    );
    const gt = await runAggregateDrizzle(db, model, {
      entity: 'observations',
      measures: [{ on: '*', agg: 'count', as: 'n' }],
      filter: { on: 'occurred_at', op: 'gt', value: '2026-06-09' },
    });
    expect(num(gt.rows[0]!.n)).toBe(
      num(
        (
          await truth(
            `select count(*)::int n from observations where occurred_at >= date '2026-06-10'`,
          )
        )[0]!.n,
      ),
    );
  });

  it('E4 dotted JSON-path filter compiles to ->> and matches Postgres', async () => {
    const res = await runAggregateDrizzle(db, model, {
      entity: 'observations',
      measures: [{ on: '*', agg: 'count', as: 'n' }],
      filter: { on: 'structured_data.context', op: 'contains', value: 'a' },
    });
    const ref = await truth(
      `select count(*)::int n from observations where (structured_data ->> 'context') ilike '%a%'`,
    );
    expect(num(res.rows[0]!.n)).toBe(num(ref[0]!.n));
  });

  it('E8 HAVING over a measure alias + order + limit', async () => {
    const res = await runAggregateDrizzle(db, model, {
      entity: 'observations',
      group_by: ['account_id'],
      measures: [{ on: '*', agg: 'count', as: 'n' }],
      having: { on: 'n', op: 'gt', value: 50 },
      order_by: [{ on: 'n', dir: 'desc' }],
    });
    expect(res.rows.every((r) => num(r.n) > 50)).toBe(true);
    const ref = await truth(
      `select account_id, count(*)::int n from observations group by account_id having count(*) > 50 order by n desc`,
    );
    expect(res.rows.map((r) => num(r.n))).toEqual(ref.map((r) => num(r.n)));
    // group_count counts POST-having groups (consistent single + multi source).
    expect(res.group_count).toBe(ref.length);
  });

  it('E6 fan-out (multi-grain): guarded == truth, naive root-join inflates', async () => {
    const q = {
      entity: 'opportunities',
      measures: [
        { on: 'weighted_amount', agg: 'sum' as const, as: 'weighted' },
        { source: 'observations', on: '*', agg: 'count' as const, as: 'obs' },
      ],
    };
    const res = await runAggregateDrizzle(db, model, q);
    expect(res.plan.needsCte).toBe(true);
    const refW = await truth(
      `select sum(value_number) s from field_values where field_definition_id=${WA}`,
    );
    const refO = await truth(`select count(*)::int c from observations`);
    expect(num(res.rows[0]!.weighted)).toBeCloseTo(num(refW[0]!.s), 2);
    expect(num(res.rows[0]!.obs)).toBe(num(refO[0]!.c));
    const naive = (await compileNaiveDrizzle(db, model, q)) as Record<string, unknown>[];
    expect(num(naive[0]!.weighted)).toBeGreaterThan(num(res.rows[0]!.weighted) * 5);
  });

  it('E7 grain inversion: rooted on the fine fact, guarded matches per-source truth', async () => {
    const q = {
      entity: 'observations',
      group_by: ['account_id'],
      measures: [
        { on: '*', agg: 'count' as const, as: 'obs' },
        { source: 'opportunities', on: 'weighted_amount', agg: 'sum' as const, as: 'pipeline' },
      ],
      order_by: [{ on: 'pipeline', dir: 'desc' as const }],
      limit: 5,
    };
    const res = await runAggregateDrizzle(db, model, q);
    expect(res.plan.rootJoinWouldFan).toBe(true);
    const ref = await truth(
      `select o.account_id, sum(fv.value_number) pipeline from opportunities o
       join field_values fv on fv.entity_id=o.id and fv.field_definition_id=${WA}
       group by o.account_id order by pipeline desc nulls last limit 5`,
    );
    expect(res.rows.map((r) => num(r.pipeline))).toEqual(ref.map((r) => num(r.pipeline)));
  });

  it('E12 multi-source HAVING over a measure alias (subquery-wrapped) + order by alias', async () => {
    const res = await runAggregateDrizzle(db, model, {
      entity: 'opportunities',
      group_by: ['account_id'],
      measures: [
        { on: 'weighted_amount', agg: 'sum', as: 'weighted' },
        { source: 'observations', on: '*', agg: 'count', as: 'obs' },
      ],
      having: { on: 'obs', op: 'gt', value: 50 },
      order_by: [{ on: 'obs', dir: 'desc' }],
    });
    expect(res.plan.needsCte).toBe(true);
    expect(res.rows.every((r) => num(r.obs) > 50)).toBe(true);
    // the account set matches the per-source HAVING truth (full-outer-join + having on the obs alias)
    const ref = await truth(
      `select account_id from observations group by account_id having count(*) > 50 order by account_id`,
    );
    expect(res.rows.map((r) => String(r.account_id)).sort()).toEqual(
      ref.map((r) => String(r.account_id)).sort(),
    );
  });

  it('E13 FAN-SAFETY: disjoint cross-source group_by is REFUSED (no cross-join inflation)', async () => {
    // state_of_deal_status is opportunities-only; `type` is observations-only. Grouping
    // cross-source measures by both is refused — under ADR-0024 a bare dim absent on a measure
    // source resolves NOWHERE on that CTE → "unknown column" (the caller must use the conformed
    // entity-prefixed form, e.g. `opportunities.state_of_deal_status`, which joins to-one; a
    // genuinely to-many dim like `observations.type` on an opp measure is rejected by the
    // resolver — see the conformed-dimension eval). Either way: REFUSED, never a fan-out join.
    expect(
      runAggregateDrizzle(db, model, {
        entity: 'opportunities',
        group_by: ['state_of_deal_status', 'type'],
        measures: [
          { on: 'weighted_amount', agg: 'sum', as: 'weighted' },
          { source: 'observations', on: '*', agg: 'count', as: 'obs' },
        ],
      }),
    ).rejects.toThrow(/unknown column "type" on opportunities/i);
  });

  it('E14 caller-input guards: unknown HAVING alias + unknown order_by alias are refused (→ 400)', async () => {
    expect(
      runAggregateDrizzle(db, model, {
        entity: 'observations',
        group_by: ['account_id'],
        measures: [{ on: '*', agg: 'count', as: 'n' }],
        having: { on: 'no_such_alias', op: 'gt', value: 1 },
      }),
    ).rejects.toThrow(/having references unknown/i);
    expect(
      runAggregateDrizzle(db, model, {
        entity: 'observations',
        group_by: ['account_id'],
        measures: [{ on: '*', agg: 'count', as: 'n' }],
        order_by: [{ on: 'occurred_at', dir: 'desc' }], // valid column, NOT projected
      }),
    ).rejects.toThrow(/order_by references unknown/i);
  });

  it('E15 empty IN/NIN resolve by truth value (no `in ()` syntax error)', async () => {
    const inEmpty = await runAggregateDrizzle(db, model, {
      entity: 'observations',
      measures: [{ on: '*', agg: 'count', as: 'n' }],
      filter: { on: 'type', op: 'in', value: [] },
    });
    expect(num(inEmpty.rows[0]!.n)).toBe(0); // empty IN matches nothing
    const ninEmpty = await runAggregateDrizzle(db, model, {
      entity: 'observations',
      measures: [{ on: '*', agg: 'count', as: 'n' }],
      filter: { on: 'type', op: 'nin', value: [] },
    });
    const all = await truth(`select count(*)::int n from observations`);
    expect(num(ninEmpty.rows[0]!.n)).toBe(num(all[0]!.n)); // empty NOT IN matches everything
  });

  it('E16 model.catalog is DERIVED from the dealbrain tags (B2): weighted_amount + deal_probability', () => {
    const cat = model.catalog ?? {};
    expect(Object.keys(cat).sort()).toEqual(['deal_probability', 'weighted_amount']);
    expect(cat.weighted_amount).toMatchObject({
      agg: 'sum',
      additivity: 'additive',
      source: 'opportunities',
    });
    expect(cat.deal_probability).toMatchObject({
      agg: 'avg',
      additivity: 'non',
      source: 'opportunities',
    });
  });

  it('E17 {ref} expands to the catalog measure: ref == inline == truth (live)', async () => {
    const refRes = await runAggregateDrizzle(db, model, {
      entity: 'opportunities',
      measures: [{ ref: 'weighted_amount' }],
    });
    const inlineRes = await runAggregateDrizzle(db, model, {
      entity: 'opportunities',
      measures: [{ on: 'weighted_amount', agg: 'sum', as: 'w' }],
    });
    const truthW = await truth(
      `select sum(value_number) s from field_values where field_definition_id=${WA}`,
    );
    expect(num(refRes.rows[0]!.weighted_amount)).toBeCloseTo(num(truthW[0]!.s), 2);
    expect(num(refRes.rows[0]!.weighted_amount)).toBeCloseTo(num(inlineRes.rows[0]!.w), 2);
  });

  // B4 — ratio composites. A test catalog adds ratios over the derived atomic measures.
  const obsCount: AtomicMeasureDef = {
    kind: 'atomic',
    on: 'id',
    agg: 'count_distinct',
    source: 'observations',
    additivity: 'additive',
  };
  const oppCount: AtomicMeasureDef = {
    kind: 'atomic',
    on: 'id',
    agg: 'count_distinct',
    source: 'opportunities',
    additivity: 'additive',
  };
  const modelWithRatios = (): DealbrainModel => ({
    ...model,
    catalog: {
      ...model.catalog,
      obs_count: obsCount,
      opp_count: oppCount,
      wa_per_dp: {
        kind: 'ratio',
        numerator: 'weighted_amount',
        denominator: 'deal_probability',
      } as RatioMeasureDef,
      pipeline_per_obs: {
        kind: 'ratio',
        numerator: 'weighted_amount',
        denominator: 'obs_count',
      } as RatioMeasureDef,
      // int/int legs (count_distinct / count_distinct) — exercises the ::numeric cast.
      obs_per_opp: {
        kind: 'ratio',
        numerator: 'obs_count',
        denominator: 'opp_count',
      } as RatioMeasureDef,
      // non-additive (avg) NUMERATOR over a different source — exercises the agg-aware
      // numerator null-policy (absent group → NULL, not a fabricated 0).
      dp_per_obs: {
        kind: 'ratio',
        numerator: 'deal_probability',
        denominator: 'obs_count',
      } as RatioMeasureDef,
    },
  });

  it('E18 single-source ratio == truth; legs excluded from output (live)', async () => {
    const res = await runAggregateDrizzle(db, modelWithRatios(), {
      entity: 'opportunities',
      measures: [{ ref: 'wa_per_dp' }],
    });
    const sumW = num(
      (
        await truth(`select sum(value_number) s from field_values where field_definition_id=${WA}`)
      )[0]!.s,
    );
    const avgD = num(
      (
        await truth(`select avg(value_number) a from field_values where field_definition_id=${DP}`)
      )[0]!.a,
    );
    expect(num(res.rows[0]!.wa_per_dp)).toBeCloseTo(sumW / avgD, 4);
    expect(res.rows[0]).not.toHaveProperty('__cmp_wa_per_dp_num'); // internal legs dropped
  });

  it('E19 multi-source ratio (different grains) == truth; needsCte (live)', async () => {
    const res = await runAggregateDrizzle(db, modelWithRatios(), {
      entity: 'opportunities',
      measures: [{ ref: 'pipeline_per_obs' }],
    });
    expect(res.plan.needsCte).toBe(true);
    const sumW = num(
      (
        await truth(`select sum(value_number) s from field_values where field_definition_id=${WA}`)
      )[0]!.s,
    );
    const obsN = num((await truth(`select count(distinct id)::int c from observations`))[0]!.c);
    expect(num(res.rows[0]!.pipeline_per_obs)).toBeCloseTo(sumW / obsN, 6);
  });

  it('E20 grouped ratio: order_by the ratio works, NULLIF guards div-by-zero, legs hidden', async () => {
    const res = await aggregate(
      db,
      modelWithRatios(),
      {
        entity: 'opportunities',
        group_by: ['account_id'],
        measures: [{ ref: 'wa_per_dp' }],
        order_by: [{ on: 'wa_per_dp', dir: 'desc' }],
        limit: 5,
      },
      { include_sql: true },
    );
    expect(res.rows.length).toBeGreaterThan(0);
    expect(res.rows.every((r) => 'wa_per_dp' in r && !('__cmp_wa_per_dp_num' in r))).toBe(true);
    expect(res.sql?.toLowerCase()).toContain('nullif'); // div-by-zero guard present
  });

  it('E21 HAVING over a composite alias is refused (composites are not filterable)', async () => {
    expect(
      runAggregateDrizzle(db, modelWithRatios(), {
        entity: 'opportunities',
        group_by: ['account_id'],
        measures: [{ ref: 'wa_per_dp' }],
        having: { on: 'wa_per_dp', op: 'gt', value: 0 },
      }),
    ).rejects.toThrow(/having references unknown/i);
  });

  it('E21b HAVING on an internal __cmp_ leg alias is refused (leg namespace is not a handle)', async () => {
    expect(
      runAggregateDrizzle(db, modelWithRatios(), {
        entity: 'opportunities',
        group_by: ['account_id'],
        measures: [{ ref: 'wa_per_dp' }],
        having: { on: '__cmp_wa_per_dp_num', op: 'gt', value: 0 },
      }),
    ).rejects.toThrow(/having references unknown/i);
  });

  it('E22 int/int ratio uses true division (::numeric), never integer-truncation (live)', async () => {
    // obs_count / opp_count per account — both count_distinct (bigint). Without the cast
    // Postgres would integer-divide (e.g. 7/2 → 3). Assert it matches fractional truth.
    const res = await runAggregateDrizzle(db, modelWithRatios(), {
      entity: 'opportunities',
      group_by: ['account_id'],
      measures: [{ ref: 'obs_per_opp' }],
    });
    const refRows = await truth(
      `select o.account_id,
              (select count(distinct obs.id) from observations obs where obs.account_id = o.account_id)::numeric
              / nullif(count(distinct o.id), 0) as r
       from opportunities o group by o.account_id`,
    );
    const refByAcct = new Map(
      refRows.map((r) => [String(r.account_id), r.r == null ? null : num(r.r)]),
    );
    let sawFractional = false;
    for (const row of res.rows) {
      const got = row.obs_per_opp == null ? null : num(row.obs_per_opp);
      const want = refByAcct.get(String(row.account_id)) ?? null;
      if (want == null) expect(got).toBeNull();
      else {
        expect(got).toBeCloseTo(want, 6);
        if (!Number.isInteger(want)) sawFractional = true;
      }
    }
    expect(sawFractional).toBe(true); // proves a non-integer value survived (no truncation)
  });

  it('E23 grouped MULTI-SOURCE ratio == per-group truth incl. single-source accounts; legs hidden (live)', async () => {
    const res = await runAggregateDrizzle(db, modelWithRatios(), {
      entity: 'opportunities',
      group_by: ['account_id'],
      measures: [{ ref: 'pipeline_per_obs' }], // sum(weighted)[opps] / count_distinct(obs)[observations]
    });
    expect(res.plan.needsCte).toBe(true);
    // per-account truth via FULL OUTER JOIN of the two per-source aggregates.
    const refRows = await truth(
      `select coalesce(o.account_id, b.account_id) as account_id,
              coalesce(w, 0)::numeric / nullif(coalesce(obs, 0), 0) as r
       from (select account_id, sum(fv.value_number) w from opportunities o
             join field_values fv on fv.entity_id=o.id and fv.field_definition_id=${WA}
             group by account_id) o
       full outer join (select account_id, count(distinct id) obs from observations group by account_id) b
       on o.account_id = b.account_id`,
    );
    const refByAcct = new Map(
      refRows.map((r) => [String(r.account_id), r.r == null ? null : num(r.r)]),
    );
    expect(res.rows.length).toBeGreaterThan(0);
    for (const row of res.rows) {
      expect(row).not.toHaveProperty('__cmp_pipeline_per_obs_num'); // legs hidden every row
      const got = row.pipeline_per_obs == null ? null : num(row.pipeline_per_obs);
      const want = refByAcct.get(String(row.account_id)) ?? null;
      if (want == null) expect(got).toBeNull();
      else expect(got).toBeCloseTo(want, 6);
    }
  });

  it('E24 non-additive (avg) numerator: absent group → NULL (not a fabricated 0), warned (live)', async () => {
    const res = await aggregate(db, modelWithRatios(), {
      entity: 'opportunities',
      group_by: ['account_id'],
      measures: [{ ref: 'dp_per_obs' }], // avg(deal_probability)[opps] / count_distinct(obs)[observations]
    });
    // An account with observations but no opportunity-probability rows: avg numerator is
    // absent → the ratio must be NULL, never 0. Cross-check against per-source truth.
    const refRows = await truth(
      `select coalesce(o.account_id, b.account_id) as account_id, o.dp
       from (select account_id, avg(fv.value_number) dp from opportunities o
             join field_values fv on fv.entity_id=o.id and fv.field_definition_id=${DP}
             group by account_id) o
       full outer join (select account_id from observations group by account_id) b
       on o.account_id = b.account_id`,
    );
    const dpByAcct = new Map(refRows.map((r) => [String(r.account_id), r.dp]));
    for (const row of res.rows) {
      if (dpByAcct.get(String(row.account_id)) == null) {
        // numerator absent → engine must report NULL, never 0
        expect(row.dp_per_obs).toBeNull();
      }
    }
  });

  it('E25 cumulative metric is REFUSED on aggregate() → routed to query({window}) (live)', async () => {
    // A running total preserves rows (window), so aggregate() must refuse it and point
    // the caller at query({window}) — the path proven by query-window.eval.spec.ts.
    const m = modelWithRatios();
    const withCumulative: DealbrainModel = {
      ...m,
      catalog: {
        ...m.catalog,
        running_pipeline: {
          kind: 'cumulative',
          measure: 'weighted_amount',
          order_by: 'occurred_at',
        },
      },
    };
    expect(
      runAggregateDrizzle(db, withCumulative, {
        entity: 'opportunities',
        measures: [{ ref: 'running_pipeline' }],
      }),
    ).rejects.toThrow(/cumulative .* query\(\{ window/is);
  });

  it('E5 additivity: SUM of a non-additive % is refused; AVG is allowed', async () => {
    expect(() =>
      assertAggregateSafe(model.analytics, {
        entity: 'opportunities',
        measures: [{ on: 'deal_probability', agg: 'sum', as: 'x' }],
      }),
    ).toThrow(/SUM_NON_ADDITIVE/);
    const res = await runAggregateDrizzle(db, model, {
      entity: 'opportunities',
      measures: [{ on: 'deal_probability', agg: 'avg', as: 'avg_dp' }],
    });
    const ref = await truth(
      `select avg(value_number) a from field_values where field_definition_id=${DP}`,
    );
    expect(num(res.rows[0]!.avg_dp)).toBeCloseTo(num(ref[0]!.a), 6);
  });

  it('E9 doctor guards: unknown field + agg on a dimension are refused', () => {
    expect(() =>
      assertAggregateSafe(model.analytics, {
        entity: 'observations',
        measures: [{ on: 'nonexistent', agg: 'count', as: 'x' }],
      }),
    ).toThrow(/UNKNOWN_FIELD/);
    expect(() =>
      assertAggregateSafe(model.analytics, {
        entity: 'observations',
        measures: [{ on: 'type', agg: 'sum', as: 'x' }],
      }),
    ).toThrow(/MEASURE_ON_DIMENSION/);
  });

  // (window measures moved to query() — see query-window.eval.spec.ts)

  it('E11 public aggregate() returns the package-shaped AggregateResponse', async () => {
    const res = await aggregate(db, model, {
      entity: 'observations',
      group_by: ['type'],
      measures: [{ on: '*', agg: 'count', as: 'n' }],
    });
    expect(res.entity).toBe('observations');
    expect(res.row_count).toBe(res.rows.length);
    expect(res.group_count).toBeGreaterThan(0);
    // @ts-expect-error plan is internal — not on the public response
    expect(res.plan).toBeUndefined();
  });
});
