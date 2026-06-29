// DERIVED COMPOSITE METRIC (ADR-0029 D2) — an arithmetic EXPRESSION over atomic measure legs
// (the subtractive/weighted gap that ratio can't express). The headline is gross_profit =
// revenue - cost. A derived metric expands (in normalize) into one Measure per DISTINCT atomic
// leg (fan-safe, in its own source CTE) + a CompositeColumn the compiler lowers to OUTER-SELECT
// arithmetic over the collapsed legs — so it adds NO fan, exactly like ratio.
//
// Ground truth is computed INDEPENDENTLY: every assertion derives the expected value from the
// two atomic legs queried on their own (num/den per group), then checks the derived column equals
// the hand-computed arithmetic. No reference to the engine's own derived output.
//
// Pins: (D1) subtraction over two atomics, grouped; (D2) a weighted literal term; (D3) the
// same atomic referenced twice DEDUPES to one leg and the arithmetic still holds; (D4) describeMetrics
// advertises it as kind:'derived'; (D5) a non-atomic/unknown leg is refused at model load;
// (D6) the derived legs never leak as public output columns.
//
//   DBURL=postgres://postgres:password@localhost:54321/dealbrain \
//     bun test src/adapters/drizzle/execute/__tests__/derived-metric.eval.spec.ts

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type QuerySurfaceHarness, makeQuerySurface } from '../../../../characterization/harness.ts';
import { loadDealbrainModel } from '../../../reference/model.dealbrain';

const DBURL = process.env.DBURL;
const suite = DBURL ? describe : describe.skip;

const DIMENSION_SPECS = [{ name: 'stage', key: 'StageName' }];

// gross_profit = ExpectedRevenue.sum - Amount.sum  (the headline subtractive metric);
// half_revenue = ExpectedRevenue.sum * 0.5  (a weighted/literal term);
// zero_spread  = ExpectedRevenue.sum - ExpectedRevenue.sum  (dedupe → one leg, must be 0).
const MEASURE_DEFS = {
  // an atomic COUNT over the to-MANY child (observations) — a cross-source leg for the fan-safety pin
  obs_count: {
    kind: 'atomic' as const,
    on: 'id',
    agg: 'count' as const,
    source: 'observations',
    additivity: 'additive' as const,
    label: 'Observation Count',
  },
  gross_profit: {
    kind: 'derived' as const,
    expr: { op: '-' as const, left: { ref: 'ExpectedRevenue.sum' }, right: { ref: 'Amount.sum' } },
    label: 'Gross Profit',
  },
  half_revenue: {
    kind: 'derived' as const,
    expr: { op: '*' as const, left: { ref: 'ExpectedRevenue.sum' }, right: { lit: 0.5 } },
    label: 'Half Revenue',
  },
  // a NESTED, mixed-operator weighted blend: 0.7·rev + 0.3·cost
  blend: {
    kind: 'derived' as const,
    expr: {
      op: '+' as const,
      left: { op: '*' as const, left: { lit: 0.7 }, right: { ref: 'ExpectedRevenue.sum' } },
      right: { op: '*' as const, left: { lit: 0.3 }, right: { ref: 'Amount.sum' } },
    },
    label: 'Blend',
  },
  // a FRACTIONAL literal divisor — pins the nullif-before-::numeric cast fix (else Postgres 22P02)
  frac_div: {
    kind: 'derived' as const,
    expr: { op: '/' as const, left: { ref: 'ExpectedRevenue.sum' }, right: { lit: 2.5 } },
    label: 'Revenue / 2.5',
  },
  zero_spread: {
    kind: 'derived' as const,
    expr: { op: '-' as const, left: { ref: 'ExpectedRevenue.sum' }, right: { ref: 'ExpectedRevenue.sum' } },
  },
  // CROSS-SOURCE: an opportunities measure minus a to-many child (observations) measure. The fan
  // hazard a single-join impl would hit: rev inflated ×(obs per opp). Per-source-CTE design = no fan.
  rev_minus_obs: {
    kind: 'derived' as const,
    expr: { op: '-' as const, left: { ref: 'ExpectedRevenue.sum' }, right: { ref: 'obs_count' } },
    label: 'Revenue minus Observation Count',
  },
};

suite('derived composite metric — arithmetic over atomic measure legs (ADR-0029 D2)', () => {
  let h: QuerySurfaceHarness;

  beforeAll(() => {
    h = makeQuerySurface(DBURL!, { dimensionSpecs: DIMENSION_SPECS, measureDefs: MEASURE_DEFS });
  });
  afterAll(async () => {
    await h.close();
  });

  it('D1 gross_profit = ExpectedRevenue.sum - Amount.sum per group (independent ground truth)', async () => {
    const derived = await h.service.measure('opportunities', {
      group_by: ['stage'],
      measures: [{ ref: 'gross_profit', as: 'gross_profit' } as never],
    });
    const legs = await h.service.measure('opportunities', {
      group_by: ['stage'],
      measures: [
        { on: 'ExpectedRevenue', agg: 'sum', as: 'rev' },
        { on: 'Amount', agg: 'sum', as: 'cost' },
      ],
    });
    const expected = new Map(
      legs.rows.map((r) => [String(r.stage), Number(r.rev) - Number(r.cost)]),
    );
    const got = new Map(
      derived.rows.map((r) => [String(r.stage), Number(r.gross_profit)]),
    );
    expect(got.size).toBeGreaterThan(0);
    expect(got.size).toBe(expected.size);
    for (const [k, v] of got) expect(v).toBeCloseTo(expected.get(k)!, 6);
    // non-degeneracy: subtraction is only a real test if some group has rev != cost
    const someDiffer = [...expected.entries()].some(([k]) => {
      const leg = legs.rows.find((r) => String(r.stage) === k)!;
      return Number(leg.rev) !== Number(leg.cost);
    });
    expect(someDiffer).toBe(true);
  });

  it('D1b the derived column is the ONLY measure projected — the __cmp_ legs never leak', async () => {
    const derived = await h.service.measure('opportunities', {
      group_by: ['stage'],
      measures: [{ ref: 'gross_profit', as: 'gross_profit' } as never],
    });
    const cols = Object.keys(derived.rows[0] as Record<string, unknown>);
    expect(cols).toContain('gross_profit');
    expect(cols).toContain('stage');
    expect(cols.some((c) => c.startsWith('__cmp_'))).toBe(false);
  });

  it('D2 a weighted literal term: half_revenue = ExpectedRevenue.sum * 0.5', async () => {
    const derived = await h.service.measure('opportunities', {
      group_by: ['stage'],
      measures: [{ ref: 'half_revenue', as: 'half_revenue' } as never],
    });
    const legs = await h.service.measure('opportunities', {
      group_by: ['stage'],
      measures: [{ on: 'ExpectedRevenue', agg: 'sum', as: 'rev' }],
    });
    const expected = new Map(legs.rows.map((r) => [String(r.stage), Number(r.rev) * 0.5]));
    const got = new Map(derived.rows.map((r) => [String(r.stage), Number(r.half_revenue)]));
    expect(got.size).toBe(expected.size);
    for (const [k, v] of got) expect(v).toBeCloseTo(expected.get(k)!, 6);
  });

  it('D2b a nested weighted blend = 0.7·rev + 0.3·cost (mixed operators, independent ground truth)', async () => {
    const derived = await h.service.measure('opportunities', {
      group_by: ['stage'],
      measures: [{ ref: 'blend', as: 'blend' } as never],
    });
    const legs = await h.service.measure('opportunities', {
      group_by: ['stage'],
      measures: [
        { on: 'ExpectedRevenue', agg: 'sum', as: 'rev' },
        { on: 'Amount', agg: 'sum', as: 'cost' },
      ],
    });
    const expected = new Map(
      legs.rows.map((r) => [String(r.stage), 0.7 * Number(r.rev) + 0.3 * Number(r.cost)]),
    );
    const got = new Map(derived.rows.map((r) => [String(r.stage), Number(r.blend)]));
    expect(got.size).toBe(expected.size);
    for (const [k, v] of got) expect(v).toBeCloseTo(expected.get(k)!, 4);
  });

  it('D2c a FRACTIONAL literal divisor (rev / 2.5) computes (regression: nullif-before-::numeric cast)', async () => {
    const derived = await h.service.measure('opportunities', {
      group_by: ['stage'],
      measures: [{ ref: 'frac_div', as: 'frac_div' } as never],
    });
    const legs = await h.service.measure('opportunities', {
      group_by: ['stage'],
      measures: [{ on: 'ExpectedRevenue', agg: 'sum', as: 'rev' }],
    });
    const expected = new Map(legs.rows.map((r) => [String(r.stage), Number(r.rev) / 2.5]));
    const got = new Map(derived.rows.map((r) => [String(r.stage), Number(r.frac_div)]));
    expect(got.size).toBe(expected.size);
    for (const [k, v] of got) expect(v).toBeCloseTo(expected.get(k)!, 4);
  });

  it('D3 the same atomic referenced twice DEDUPES to exactly ONE leg (structural, via compiled SQL)', async () => {
    const derived = await h.service.measure(
      'opportunities',
      { group_by: ['stage'], measures: [{ ref: 'zero_spread', as: 'zero_spread' } as never] },
      { include_sql: true },
    );
    // structural witness: a self-referential derived must emit ONE __cmp_ leg, not two.
    const legAliases = new Set((derived.sql ?? '').match(/__cmp_zero_spread_d\d+/g) ?? []);
    expect(legAliases.size).toBe(1);
    // and the value still holds (x - x == 0)
    for (const r of derived.rows) expect(Number(r.zero_spread)).toBeCloseTo(0, 6);
  });

  it('D3b CROSS-SOURCE fan-safety: rev − obs_count (to-many child leg) is NOT inflated by fan', async () => {
    // Group by account_id — a NATIVE dimension on BOTH opportunities and observations — so each leg
    // resolves the group key in its OWN source. The fan hazard a single-join impl hits: rev × (obs
    // per account). The per-source-CTE design (each leg pre-aggregates alone, outer-joined on the key)
    // = no fan. (Grouping a cross-source child leg by a PARENT'S EAV dim like `stage` is a SEPARATE,
    // currently-unsupported multi-source-conformance path — D3c pins that it fails loud, not silently.)
    const derived = await h.service.measure('opportunities', {
      group_by: ['account_id'],
      measures: [{ ref: 'rev_minus_obs', as: 'rev_minus_obs' } as never],
    });
    // independent ground truth: each leg aggregated ALONE (un-inflated) then subtracted.
    const rev = await h.service.measure('opportunities', {
      group_by: ['account_id'],
      measures: [{ on: 'ExpectedRevenue', agg: 'sum', as: 'rev' }],
    });
    const obs = await h.service.measure('opportunities', {
      group_by: ['account_id'],
      measures: [{ on: 'id', agg: 'count', source: 'observations', as: 'obs' } as never],
    });
    const revBy = new Map(rev.rows.map((r) => [String(r.account_id), Number(r.rev)]));
    const obsBy = new Map(obs.rows.map((r) => [String(r.account_id), Number(r.obs)]));
    const got = new Map(derived.rows.map((r) => [String(r.account_id), Number(r.rev_minus_obs)]));
    expect(got.size).toBeGreaterThan(0);
    // at least one account must have observations, else "no fan" is vacuous
    expect([...obsBy.values()].some((n) => n > 0)).toBe(true);
    for (const [k, v] of got) {
      expect(v).toBeCloseTo((revBy.get(k) ?? 0) - (obsBy.get(k) ?? 0), 4);
    }
  });

  it('D3c a cross-source leg grouped by a PARENT EAV dim fails LOUD (not silently mis-grained)', async () => {
    // The to-one EAV conformance (observations→opportunities.stage) is not applied to a NON-ROOT
    // measure source today — so this REFUSES rather than emitting a wrong number. Pins the boundary;
    // lifting it is a separate multi-source group-dim conformance increment (orthogonal to D2).
    await expect(
      h.service.measure('opportunities', {
        group_by: ['stage'],
        measures: [{ ref: 'rev_minus_obs', as: 'rev_minus_obs' } as never],
      }),
    ).rejects.toThrow();
  });

  it('D4 describeMetrics advertises the derived metric as kind:"derived" with its expr', async () => {
    const metrics = await h.service.describeMetrics();
    const gp = metrics.find((m) => m.name === 'gross_profit');
    expect(gp).toBeDefined();
    expect(gp?.layer).toBe('metric');
    expect(gp?.kind).toBe('derived');
    expect(gp?.expr).toEqual({
      op: '-',
      left: { ref: 'ExpectedRevenue.sum' },
      right: { ref: 'Amount.sum' },
    });
    // a derived metric is NOT entity-sourced → must not appear in describeMeasures
    const measures = await h.service.describeMeasures('opportunities');
    expect(measures.find((m) => m.name === 'gross_profit')).toBeUndefined();
  });

  it('D5 a derived def whose leg is non-atomic (a ratio) is refused at model load', async () => {
    await expect(
      loadDealbrainModel(h.db, undefined, DIMENSION_SPECS, {
        win_share: {
          kind: 'ratio',
          numerator: 'ExpectedRevenue.sum',
          denominator: 'Amount.sum',
        },
        bad_derived: {
          kind: 'derived',
          expr: { op: '+', left: { ref: 'win_share' }, right: { lit: 1 } },
        },
      }),
    ).rejects.toThrow(/atomic/i);
  });

  it('D5b a derived def naming an unknown leg is refused at model load', async () => {
    await expect(
      loadDealbrainModel(h.db, undefined, DIMENSION_SPECS, {
        bad_derived: {
          kind: 'derived',
          expr: { op: '-', left: { ref: 'not_a_measure' }, right: { ref: 'Amount.sum' } },
        },
      }),
    ).rejects.toThrow(/not in the catalog/i);
  });

  it('D5c a derived def with no atomic ref (pure literals) is refused at model load', async () => {
    await expect(
      loadDealbrainModel(h.db, undefined, DIMENSION_SPECS, {
        bad_derived: {
          kind: 'derived',
          expr: { op: '+', left: { lit: 1 }, right: { lit: 2 } },
        },
      }),
    ).rejects.toThrow(/references no atomic measure/i);
  });
});
