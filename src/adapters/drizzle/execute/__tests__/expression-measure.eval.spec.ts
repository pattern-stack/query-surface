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
  // TO-ONE×TO-ONE headline (ADR-0029 D4 follow-up): a measure on the OBSERVATIONS source whose two
  // EXPLICIT DOTTED cols 'opportunities.Amount'/'opportunities.Probability' are reached via the single
  // observations→opportunities belongs_to (to-one). Each observation reaches its ONE parent opp's
  // Amount·Probability (1:1, no fan); the SUM is over observations rows.
  to_one_weighted: {
    kind: 'atomic' as const,
    on: {
      op: '*' as const,
      left: { col: 'opportunities.Amount' },
      right: { col: 'opportunities.Probability' },
    },
    agg: 'sum' as const,
    source: 'observations',
    additivity: 'additive' as const,
    label: 'To-one weighted (obs→opp)',
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

  it('D4-2 LINEAR EQUIVALENCE + MISSING→0: SUM(ExpectedRevenue − Amount) [row-level expr] == SUM(rev) − SUM(amount) over ALL rows (a missing operand is 0, not a dropped row)', async () => {
    // A missing EAV operand is coalesced to 0 (the additive identity), so the row STAYS — the
    // expression form therefore coincides with the post-aggregate derived form over ALL rows, not
    // just the co-present subset. Ground truth mirrors that with coalesce(...,0) + LEFT joins: a deal
    // with revenue but no amount contributes revenue−0, never dropping out of the total.
    const expected = await truth<{ stage: string | null; spread: string; distrib: string }>(
      `select s.v as stage,
              sum(coalesce(e.v,0) - coalesce(a.v,0))      as spread,
              sum(coalesce(e.v,0)) - sum(coalesce(a.v,0)) as distrib
         from opportunities o
         left join ${fvNum('ExpectedRevenue')} e on e.eid = o.id
         left join ${fvNum('Amount')} a on a.eid = o.id
         left join ${fv('StageName', 'value_text')} s on s.eid = o.id
        group by s.v`,
    );
    // the distributive identity holds GLOBALLY now (missing→0): row-level == derived form.
    for (const e of expected) expect(num(e.spread)).toBeCloseTo(num(e.distrib), 2);

    // WITNESS that missing→0 actually does work here: the co-present-ONLY spread (INNER joins, the
    // old row-dropping behavior) must DIFFER from the all-rows spread on >=1 stage — otherwise this
    // fixture has no present/missing rows and the missing→0 semantics would be untested (vacuous).
    const coPresent = await truth<{ stage: string | null; spread: string }>(
      `select s.v as stage, sum(e.v - a.v) as spread
         from opportunities o
         join ${fvNum('ExpectedRevenue')} e on e.eid = o.id
         join ${fvNum('Amount')} a on a.eid = o.id
         left join ${fv('StageName', 'value_text')} s on s.eid = o.id
        group by s.v`,
    );
    const coBy = new Map(coPresent.map((e) => [bucketKey(e.stage), num(e.spread)]));

    const expr = await h.service.measure('opportunities', {
      group_by: ['stage'],
      measures: [{ ref: 'rev_minus_amount', as: 'spread' } as never],
    });
    const exprBy = new Map(expr.rows.map((r) => [bucketKey(r.stage), num(r.spread)]));
    const expBy = new Map(expected.map((e) => [bucketKey(e.stage), num(e.spread)]));
    expect(expBy.size).toBeGreaterThan(0);
    // non-degeneracy: at least one group has a non-zero spread (else subtraction is vacuous).
    expect(expected.some((e) => num(e.spread) !== 0)).toBe(true);
    // the engine matches the ALL-ROWS (missing→0) form — and that form genuinely DIFFERS from the
    // co-present-only form, so the engine provably did NOT drop a row missing one operand.
    let diverges = false;
    for (const [k, v] of expBy) {
      expect(exprBy.get(k)).toBeCloseTo(v, 2);
      if (Math.abs(v - (coBy.get(k) ?? v)) > 0.5) diverges = true;
    }
    expect(
      diverges,
      'fixture has no opp with exactly one of {ExpectedRevenue, Amount} present — cannot witness ' +
        'missing→0 vs row-drop here (a real finding about fixture sparsity, not a pass).',
    ).toBe(true);
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

  it('D4-7 HEADLINE to-one×to-one: SUM(opportunities.Amount·opportunities.Probability) on OBSERVATIONS source == raw Σ over the parent opp, per observations.type', async () => {
    // INDEPENDENT ground truth: each observation reaches its ONE parent opportunity (belongs_to), and
    // the EAV cols key on the PARENT opp id (amt.eid = opp.id, NOT o.id — the load-bearing distinction
    // that makes this independent of the to-one path). Grouped by the LOCAL observations.type dim, so
    // the ONLY opportunities join present comes from the measure (a clean witness).
    const expected = await truth<{ type: string | null; wp: string }>(
      `select o.type as type, sum(coalesce(amt.v,0) * coalesce(prob.v,0)) as wp
         from observations o
         left join opportunities opp on opp.id = o.opportunity_id
         left join ${fvNum('Amount')} amt on amt.eid = opp.id
         left join ${fvNum('Probability')} prob on prob.eid = opp.id
        group by o.type`,
    );
    const expBy = new Map<string, number | null>();
    for (const e of expected) expBy.set(bucketKey(e.type), e.wp == null ? null : num(e.wp));

    const res = await h.service.measure(
      'observations',
      {
        group_by: ['observations.type'],
        measures: [{ ref: 'to_one_weighted', as: 'wp' } as never],
      },
      { include_sql: true },
    );
    const gotBy = new Map<string, number | null>();
    // the group alias for a dotted dim is the dotted path itself ('observations.type').
    for (const r of res.rows)
      gotBy.set(bucketKey(r['observations.type']), r.wp == null ? null : num(r.wp));

    // value parity per (type) bucket
    expect(gotBy.size).toBeGreaterThan(0);
    const keys = new Set([...expBy.keys(), ...gotBy.keys()]);
    for (const k of keys) {
      const e = expBy.get(k);
      const g = gotBy.get(k);
      if (e == null && g == null) continue;
      expect(g).toBeCloseTo(e ?? 0, 2);
    }

    // WITNESS the EAV-via-to-one joins: two distinct fvt_opportunities_<col> aliases (toIdentifier
    // lowercases the key), NOT the bare-EAV fv_<as>_<i> scheme → proves the dotted cols took the
    // to-one path.
    const fvt = new Set((res.sql ?? '').match(/fvt_opportunities_\w+/g) ?? []);
    expect(fvt.size).toBe(2);
    expect(fvt.has('fvt_opportunities_amount')).toBe(true);
    expect(fvt.has('fvt_opportunities_probability')).toBe(true);
    // WITNESS the belongs_to hop observations→opportunities (the FK ON).
    expect(res.sql ?? '').toMatch(/opportunity_id/i);
    // NEGATIVE witness: the bare-local EAV alias scheme must be ABSENT (the cols did NOT resolve local).
    const bare = (res.sql ?? '').match(/fv_wp_\d+/g) ?? [];
    expect(bare.length).toBe(0);
  });

  it('D4-8 NO-FAN + GRAIN: row count == independent group count, summed at OBSERVATIONS grain (not opp grain)', async () => {
    const expected = await truth<{ type: string | null; wp: string }>(
      `select o.type as type, sum(coalesce(amt.v,0) * coalesce(prob.v,0)) as wp
         from observations o
         left join opportunities opp on opp.id = o.opportunity_id
         left join ${fvNum('Amount')} amt on amt.eid = opp.id
         left join ${fvNum('Probability')} prob on prob.eid = opp.id
        group by o.type`,
    );
    const res = await h.service.measure('observations', {
      group_by: ['observations.type'],
      measures: [{ ref: 'to_one_weighted', as: 'wp' } as never],
    });
    // row-count parity: the belongs_to + two EAV joins are each 1:1 → exactly one row per type, no
    // inflation (a has_many would have multiplied).
    expect(res.row_count).toBe(expected.length);

    const expBy = new Map(
      expected.map((e) => [bucketKey(e.type), e.wp == null ? null : num(e.wp)]),
    );
    const gotBy = new Map(
      res.rows.map((r) => [bucketKey(r['observations.type']), r.wp == null ? null : num(r.wp)]),
    );
    expect(gotBy.size).toBe(expBy.size);
    for (const [k, v] of gotBy) {
      const e = expBy.get(k);
      if (v == null && e == null) continue;
      expect(v).toBeCloseTo(e ?? 0, 2);
    }

    // GRAIN NON-DEGENERACY: the OBSERVATIONS-grain total (each opp's product counted once PER child
    // observation) must DIFFER from the opp-grain total (each opp once) — else ≥1 opp has >1 obs is
    // false and the test would pass vacuously even if the engine collapsed to opp grain.
    const [obsRow] = await truth<{ t: string }>(
      `select sum(coalesce(amt.v,0) * coalesce(prob.v,0)) t
         from observations o
         left join opportunities opp on opp.id = o.opportunity_id
         left join ${fvNum('Amount')} amt on amt.eid = opp.id
         left join ${fvNum('Probability')} prob on prob.eid = opp.id`,
    );
    const [oppRow] = await truth<{ t: string }>(
      `select sum(coalesce(amt.v,0) * coalesce(prob.v,0)) t
         from opportunities opp
         left join ${fvNum('Amount')} amt on amt.eid = opp.id
         left join ${fvNum('Probability')} prob on prob.eid = opp.id`,
    );
    const obsTotal = num(obsRow?.t);
    const oppTotal = num(oppRow?.t);
    expect(
      Math.abs(obsTotal - oppTotal) > 0.5,
      'fixture-degenerate: every opportunity has ≤1 observation, so observations-grain == opp-grain ' +
        'and this grain guard cannot witness the per-obs SUM (a real finding about fixture shape).',
    ).toBe(true);
    // the engine grand total must equal the OBSERVATIONS-grain total — proving it summed per-obs via a
    // 1:1 to-one, NOT at opp grain.
    let engTotal = 0;
    for (const v of gotBy.values()) engTotal += v ?? 0;
    expect(engTotal).toBeCloseTo(obsTotal, 2);
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

  it('D4-5b FAIL-LOUD: a dotted col that is NOT a to-one reach to a registered numeric field is refused at model load', async () => {
    // CONTRACT INVERSION (ADR-0029 D4 follow-up): a to-one dotted col is now ALLOWED (see D4-7); only a
    // non-numeric-target / unregistered-target / has_many-reach / diamond-reach is refused fail-loud.
    const def = (left: { col: string }, source: string) => ({
      bad_expr: {
        kind: 'atomic' as const,
        on: { op: '*' as const, left, right: { col: 'Probability' } },
        agg: 'sum' as const,
        source,
        additivity: 'additive' as const,
      },
    });
    // (i) NON-NUMERIC target: opportunities→accounts is to-one, but accounts.name is a string dim.
    await expect(
      loadDealbrainModel(
        h.db,
        undefined,
        DIMENSION_SPECS,
        def({ col: 'accounts.name' }, 'opportunities'),
      ),
    ).rejects.toThrow(/numeric/i);
    // (ii) UNREGISTERED target col: to-one, but accounts has no 'nope' field.
    await expect(
      loadDealbrainModel(
        h.db,
        undefined,
        DIMENSION_SPECS,
        def({ col: 'accounts.nope' }, 'opportunities'),
      ),
    ).rejects.toThrow(/not a registered numeric field|not registered|numeric/i);
    // (iii) HAS_MANY reach: opportunities has_many observations → resolveJoinPlan(role 'filter') = semijoin, not to-one (would fan).
    await expect(
      loadDealbrainModel(
        h.db,
        undefined,
        DIMENSION_SPECS,
        def({ col: 'observations.id' }, 'opportunities'),
      ),
    ).rejects.toThrow(/to-one|fan/i);
    // (iv) DIAMOND reach: observations→accounts has TWO belongs_to paths (direct + via opportunities) → ambiguous.
    await expect(
      loadDealbrainModel(
        h.db,
        undefined,
        DIMENSION_SPECS,
        def({ col: 'accounts.name' }, 'observations'),
      ),
    ).rejects.toThrow(/ambiguous|diamond|to-one|numeric/i);
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
