// EXPRESSION MEASURE (ADR-0029 D4) — a ROW-LEVEL-product measure: agg(f(col1,col2,…)), evaluated
// PER ROW and aggregated ONCE. The headline is weighted_pipeline = SUM(Amount · Probability) — the
// multiply happens per-row, BEFORE the SUM, so it is still ONE aggregation pass → still a MEASURE
// (below the aggregation boundary), NEVER a metric. This can never be a metric: SUM(Amount·Probability)
// ≠ SUM(Amount)·SUM(Probability). The wrinkle D4 adds over a derived metric: an expression can name
// >=2 EAV cols (Amount AND Probability, both EAV) — each pushes its OWN 1:1 field_values join, so they
// must get DISTINCT aliases and compose 1:1 → NO fan.
//
// Ground truth is computed INDEPENDENTLY via RAW SQL joining field_values directly (twice, for the
// two EAV cols) — NEVER via the expression path itself.
//
//   DBURL=postgres://postgres:password@localhost:54321/dealbrain \
//     bun test src/adapters/drizzle/execute/__tests__/expression-measure.eval.spec.ts

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import {
  type QuerySurfaceHarness,
  makeQuerySurface,
} from '../../../../characterization/harness.ts';
import { loadDealbrainModel } from '../../../reference/model.dealbrain';

const DBURL = process.env.DBURL;
const suite = DBURL ? describe : describe.skip;

const DIMENSION_SPECS = [{ name: 'stage', key: 'StageName' }];

// weighted_pipeline = SUM(Amount · Probability) — the headline multi-EAV row-level product.
// rev_minus_amount  = SUM(ExpectedRevenue − Amount) — the distributive/linear case (must equal the
//                     derived/post-aggregate form SUM(rev) − SUM(amount)).
const MEASURE_DEFS = {
  weighted_pipeline: {
    kind: 'atomic' as const,
    on: { op: '*' as const, left: { col: 'Amount' }, right: { col: 'Probability' } },
    agg: 'sum' as const,
    source: 'opportunities',
    additivity: 'additive' as const,
    label: 'Weighted Pipeline',
  },
  rev_minus_amount: {
    kind: 'atomic' as const,
    on: { op: '-' as const, left: { col: 'ExpectedRevenue' }, right: { col: 'Amount' } },
    agg: 'sum' as const,
    source: 'opportunities',
    additivity: 'additive' as const,
    label: 'Revenue minus Amount (row-level)',
  },
};

suite('expression measure — agg(f(col,col)) over local numeric cols (ADR-0029 D4)', () => {
  let h: QuerySurfaceHarness;
  beforeAll(() => {
    h = makeQuerySurface(DBURL!, { dimensionSpecs: DIMENSION_SPECS, measureDefs: MEASURE_DEFS });
  });
  afterAll(async () => {
    await h.close();
  });

  const truth = async <T = Record<string, unknown>>(q: string) =>
    (await h.db.execute(sql.raw(q))).rows as T[];
  const num = (v: unknown) => Number(v);
  const bucketKey = (v: unknown) => (v == null ? '<null>' : String(v));

  // A field_values CTE for a dealbrain key — the 1:1 (entity → value) the engine joins. We join the
  // EAV cols DIRECTLY (twice) to build ground truth WITHOUT the expression path.
  const fv = (key: string, col: 'value_text' | 'value_number') =>
    `(select fv.entity_id eid, fv.${col} v from field_values fv
        join field_definitions fd on fd.id = fv.field_definition_id where fd.key = '${key}')`;

  // A NUMERIC field_values CTE that also EXCLUDES present-but-null value_number rows (the fixture
  // stores some field_values rows whose value lives in another typed column → value_number NULL).
  // The engine's row-level expression drops a NULL operand, so a non-null restriction mirrors it.
  const fvNum = (key: string) =>
    `(select fv.entity_id eid, fv.value_number v from field_values fv
        join field_definitions fd on fd.id = fv.field_definition_id
       where fd.key = '${key}' and fv.value_number is not null)`;

  it('D4-1 HEADLINE multi-EAV product: SUM(Amount·Probability) per stage == raw Σ(amount·prob)', async () => {
    // ground truth: join Amount and Probability field_values DIRECTLY, multiply per row, then SUM.
    const expected = await truth<{ stage: string | null; wp: string }>(
      `select s.v as stage, sum(a.v * p.v) as wp
         from opportunities o
         left join ${fv('StageName', 'value_text')} s on s.eid = o.id
         left join ${fv('Amount', 'value_number')} a on a.eid = o.id
         left join ${fv('Probability', 'value_number')} p on p.eid = o.id
        group by s.v`,
    );
    const expBy = new Map<string, number>();
    for (const e of expected) expBy.set(bucketKey(e.stage), num(e.wp));

    const res = await h.service.measure(
      'opportunities',
      {
        group_by: ['stage'],
        measures: [{ ref: 'weighted_pipeline', as: 'wp' } as never],
      },
      { include_sql: true },
    );
    const gotBy = new Map<string, number>();
    for (const r of res.rows) gotBy.set(bucketKey(r.stage), num(r.wp));

    expect(gotBy.size).toBeGreaterThan(0);
    // SQL must carry TWO distinct EAV leaf aliases (the multi-EAV-join case) — not a collision.
    const leafAliases = new Set((res.sql ?? '').match(/fv_wp_\d+/g) ?? []);
    expect(leafAliases.size).toBe(2);

    const keys = new Set([...expBy.keys(), ...gotBy.keys()]);
    for (const k of keys) {
      // a stage where every opp lacks amount OR prob → SUM over no rows is NULL on both sides.
      const e = expBy.get(k);
      const g = gotBy.get(k);
      if (e == null && g == null) continue;
      expect(g).toBeCloseTo(e ?? 0, 2);
    }
  });

  it('D4-2 LINEAR EQUIVALENCE: SUM(ExpectedRevenue − Amount) [row-level expr] == SUM(rev) − SUM(amount) over the co-present rows', async () => {
    // The distributive identity SUM(a − b) == SUM(a) − SUM(b) holds over the row set where BOTH legs
    // are present. A row-level expression naturally RESTRICTS to that set (a NULL operand → NULL →
    // dropped from the SUM), so the meaningful comparison is against SUM(a) − SUM(b) computed over the
    // SAME co-present rows (INNER joins on both EAV legs). Ground truth proves both forms coincide there.
    const expected = await truth<{ stage: string | null; spread: string; distrib: string }>(
      `select s.v as stage,
              sum(e.v - a.v)      as spread,
              sum(e.v) - sum(a.v) as distrib
         from opportunities o
         join ${fvNum('ExpectedRevenue')} e on e.eid = o.id
         join ${fvNum('Amount')} a on a.eid = o.id
         left join ${fv('StageName', 'value_text')} s on s.eid = o.id
        group by s.v`,
    );
    // the distributive identity itself, on the ground-truth side (row-level == derived form).
    for (const e of expected) expect(num(e.spread)).toBeCloseTo(num(e.distrib), 2);

    const expr = await h.service.measure('opportunities', {
      group_by: ['stage'],
      measures: [{ ref: 'rev_minus_amount', as: 'spread' } as never],
    });
    const exprBy = new Map(expr.rows.map((r) => [bucketKey(r.stage), num(r.spread)]));
    const expBy = new Map(expected.map((e) => [bucketKey(e.stage), num(e.spread)]));
    expect(expBy.size).toBeGreaterThan(0);
    // non-degeneracy: at least one group has a non-zero spread (else subtraction is vacuous).
    expect(expected.some((e) => num(e.spread) !== 0)).toBe(true);
    for (const [k, v] of expBy) expect(exprBy.get(k)).toBeCloseTo(v, 2);
  });

  it('D4-3 DISCRIMINATOR: SUM(Amount·Probability) ≠ SUM(Amount)·SUM(Probability) (row-level, not post-aggregate)', async () => {
    // both computed INDEPENDENTLY via raw SQL: the row-level product, and the product-of-sums.
    const rows = await truth<{ stage: string | null; wp: string; pos: string }>(
      `select s.v as stage,
              sum(a.v * p.v)            as wp,
              sum(a.v) * sum(p.v)       as pos
         from opportunities o
         left join ${fv('StageName', 'value_text')} s on s.eid = o.id
         left join ${fv('Amount', 'value_number')} a on a.eid = o.id
         left join ${fv('Probability', 'value_number')} p on p.eid = o.id
        group by s.v`,
    );
    // engine row-level product (proves the engine matches the row-level ground truth, not POS).
    const eng = await h.service.measure('opportunities', {
      group_by: ['stage'],
      measures: [{ ref: 'weighted_pipeline', as: 'wp' } as never],
    });
    const engBy = new Map(eng.rows.map((r) => [bucketKey(r.stage), num(r.wp)]));

    // NON-DEGENERACY GUARD: at least one group must differ by a non-trivial relative margin. If the
    // fixture is too even (Probability near-constant) the two would collapse — FAIL with a finding.
    let anyNonTrivial = false;
    for (const r of rows) {
      const wp = num(r.wp);
      const pos = num(r.pos);
      if (wp === 0 && pos === 0) continue;
      // the engine's row-level number must equal the row-level ground truth (NOT the product-of-sums).
      expect(engBy.get(bucketKey(r.stage))).toBeCloseTo(wp, 2);
      const denom = Math.max(Math.abs(wp), Math.abs(pos), 1);
      if (Math.abs(wp - pos) / denom > 0.01) {
        anyNonTrivial = true;
        // DIRECT (not just transitive) discriminator: on a group where the two forms diverge, the
        // engine's value must NOT match the product-of-sums — proves it is genuinely row-level.
        expect(engBy.get(bucketKey(r.stage))).not.toBeCloseTo(pos, 2);
      }
    }
    expect(
      anyNonTrivial,
      'fixture too even: SUM(Amount·Probability) ≈ SUM(Amount)·SUM(Probability) on every group — ' +
        'beanmaxx Probability is near-constant, so this discriminator cannot distinguish a row-level ' +
        'measure from a post-aggregate metric. Need lumpier data (a real finding, not a pass).',
    ).toBe(true);
  });

  it('D4-4 MULTI-EAV NO-FAN: grouped product matches row-for-row + row count == independent group count', async () => {
    const expected = await truth<{ stage: string | null; wp: string }>(
      `select s.v as stage, sum(a.v * p.v) as wp
         from opportunities o
         left join ${fv('StageName', 'value_text')} s on s.eid = o.id
         left join ${fv('Amount', 'value_number')} a on a.eid = o.id
         left join ${fv('Probability', 'value_number')} p on p.eid = o.id
        group by s.v`,
    );
    const res = await h.service.measure('opportunities', {
      group_by: ['stage'],
      measures: [{ ref: 'weighted_pipeline', as: 'wp' } as never],
    });
    // row count parity: the two 1:1 EAV joins add NO fan, so the engine emits exactly one row per
    // independent group (no inflation).
    expect(res.row_count).toBe(expected.length);

    const expBy = new Map(
      expected.map((e) => [bucketKey(e.stage), e.wp == null ? null : num(e.wp)]),
    );
    const gotBy = new Map(
      res.rows.map((r) => [bucketKey(r.stage), r.wp == null ? null : num(r.wp)]),
    );
    expect(gotBy.size).toBe(expBy.size);
    for (const [k, v] of gotBy) {
      const e = expBy.get(k);
      if (v == null && e == null) continue;
      expect(v).toBeCloseTo(e ?? 0, 2);
    }
  });

  it('D4-5a FAIL-LOUD: a { col } naming a non-numeric / unregistered field is refused at model load', async () => {
    // 'stage' is a string EAV dimension (type:string), not numeric → arithmetic refused.
    await expect(
      loadDealbrainModel(h.db, undefined, DIMENSION_SPECS, {
        bad_expr: {
          kind: 'atomic',
          on: { op: '*', left: { col: 'Amount' }, right: { col: 'not_a_field' } },
          agg: 'sum',
          source: 'opportunities',
          additivity: 'additive',
        },
      }),
    ).rejects.toThrow(/not registered/i);
  });

  it('D4-5b FAIL-LOUD: a dotted relation col is refused at model load (LOCAL-only v1)', async () => {
    await expect(
      loadDealbrainModel(h.db, undefined, DIMENSION_SPECS, {
        bad_expr: {
          kind: 'atomic',
          on: { op: '*', left: { col: 'account.size' }, right: { col: 'Probability' } },
          agg: 'sum',
          source: 'opportunities',
          additivity: 'additive',
        },
      }),
    ).rejects.toThrow(/dotted|relation|local/i);
  });

  it('D4-5c FAIL-LOUD: a pure-literal expression (no col) is refused at model load', async () => {
    await expect(
      loadDealbrainModel(h.db, undefined, DIMENSION_SPECS, {
        bad_expr: {
          kind: 'atomic',
          on: { op: '+', left: { lit: 1 }, right: { lit: 2 } },
          agg: 'sum',
          source: 'opportunities',
          additivity: 'additive',
        },
      }),
    ).rejects.toThrow(/references no column|pure-literal/i);
  });

  it('D4-6 describeMeasures surfaces the expression measure with its expr (and absent `on`)', async () => {
    const measures = await h.service.describeMeasures('opportunities');
    const wp = measures.find((m) => m.name === 'weighted_pipeline');
    expect(wp).toBeDefined();
    expect(wp?.layer).toBe('measure');
    expect(wp?.agg).toBe('sum');
    expect(wp?.on).toBeUndefined();
    expect(wp?.expr).toEqual({
      op: '*',
      left: { col: 'Amount' },
      right: { col: 'Probability' },
    });
  });
});
