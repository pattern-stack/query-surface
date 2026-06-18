// B3 — {ref} expansion. Pure unit (no DB): normalizeAggregate over an in-memory catalog.
import { describe, expect, it } from 'bun:test';
import type { MeasureCatalog } from './measure-catalog';
import { normalizeAggregate } from './normalize';

const catalog: MeasureCatalog = {
  revenue: { kind: 'atomic', on: 'amount', agg: 'sum', source: 'opps', additivity: 'additive' },
  won_rate: {
    kind: 'atomic',
    on: 'rate',
    agg: 'avg',
    source: 'opps',
    additivity: 'non',
    where: { on: 'stage', op: 'eq', value: 'won' },
  },
};

describe('normalizeAggregate (B3 {ref} expansion)', () => {
  it('expands a {ref} to its inline measure; alias defaults to the ref name', () => {
    const q = normalizeAggregate(catalog, { entity: 'opps', measures: [{ ref: 'revenue' }] });
    expect(q.measures).toEqual([{ on: 'amount', agg: 'sum', source: 'opps', as: 'revenue' }]);
  });

  it('carries the def `where` and honors an `as` override', () => {
    const q = normalizeAggregate(catalog, {
      entity: 'opps',
      measures: [{ ref: 'won_rate', as: 'wr' }],
    });
    expect(q.measures[0]).toEqual({
      on: 'rate',
      agg: 'avg',
      source: 'opps',
      where: { on: 'stage', op: 'eq', value: 'won' },
      as: 'wr',
    });
  });

  it('passes inline measures through unchanged, alongside refs', () => {
    const inline = { on: 'amount', agg: 'sum' as const, as: 'raw' };
    const q = normalizeAggregate(catalog, {
      entity: 'opps',
      measures: [inline, { ref: 'revenue' }],
    });
    expect(q.measures[0]).toEqual(inline);
    expect(q.measures[1]!.as).toBe('revenue');
  });

  it('throws on an unknown ref', () => {
    expect(() =>
      normalizeAggregate(catalog, { entity: 'opps', measures: [{ ref: 'nope' }] }),
    ).toThrow(/unknown measure ref "nope"/);
  });

  it('throws on a duplicate output alias (ref vs inline)', () => {
    expect(() =>
      normalizeAggregate(catalog, {
        entity: 'opps',
        measures: [{ on: 'x', agg: 'sum', as: 'revenue' }, { ref: 'revenue' }],
      }),
    ).toThrow(/duplicate measure alias "revenue"/);
  });
});

const ratioCatalog: MeasureCatalog = {
  won: { kind: 'atomic', on: 'amount', agg: 'sum', source: 'opps', additivity: 'additive' },
  total: { kind: 'atomic', on: 'id', agg: 'count', source: 'opps', additivity: 'additive' },
  win_rate: { kind: 'ratio', numerator: 'won', denominator: 'total' },
};

describe('normalizeAggregate — ratio composites (B4)', () => {
  it('expands a ratio ref into two __cmp_ legs + a composite column', () => {
    const q = normalizeAggregate(ratioCatalog, { entity: 'opps', measures: [{ ref: 'win_rate' }] });
    expect(q.measures.map((m) => m.as)).toEqual(['__cmp_win_rate_num', '__cmp_win_rate_den']);
    expect(q.composites).toEqual([
      {
        kind: 'ratio',
        as: 'win_rate',
        numerator: '__cmp_win_rate_num',
        denominator: '__cmp_win_rate_den',
        numeratorAgg: 'sum', // `won` is sum(amount)
      },
    ]);
    expect(q.measures[0]).toMatchObject({ on: 'amount', agg: 'sum', source: 'opps' });
    expect(q.measures[1]).toMatchObject({ on: 'id', agg: 'count', source: 'opps' });
  });

  it('honors an `as` override for the ratio output', () => {
    const q = normalizeAggregate(ratioCatalog, {
      entity: 'opps',
      measures: [{ ref: 'win_rate', as: 'wr' }],
    });
    expect(q.composites?.[0]?.as).toBe('wr');
    expect(q.measures.map((m) => m.as)).toEqual(['__cmp_wr_num', '__cmp_wr_den']);
  });

  it('refuses a ratio whose leg is missing or itself a composite', () => {
    const missing: MeasureCatalog = {
      ...ratioCatalog,
      bad: { kind: 'ratio', numerator: 'won', denominator: 'nope' },
    };
    expect(() =>
      normalizeAggregate(missing, { entity: 'opps', measures: [{ ref: 'bad' }] }),
    ).toThrow(/leg measure "nope" is not in the catalog/);
    const nested: MeasureCatalog = {
      ...ratioCatalog,
      bad: { kind: 'ratio', numerator: 'win_rate', denominator: 'won' },
    };
    expect(() =>
      normalizeAggregate(nested, { entity: 'opps', measures: [{ ref: 'bad' }] }),
    ).toThrow(/not an atomic measure/);
  });

  it('refuses a user alias colliding with a generated leg alias', () => {
    expect(() =>
      normalizeAggregate(ratioCatalog, {
        entity: 'opps',
        measures: [{ ref: 'win_rate' }, { on: 'amount', agg: 'sum', as: '__cmp_win_rate_num' }],
      }),
    ).toThrow(/duplicate measure alias "__cmp_win_rate_num"/);
  });
});

describe('normalizeAggregate — cumulative routes to query({window}) (B6)', () => {
  const cumCatalog: MeasureCatalog = {
    revenue: { kind: 'atomic', on: 'amount', agg: 'sum', source: 'opps', additivity: 'additive' },
    running_revenue: { kind: 'cumulative', measure: 'revenue', order_by: 'closed_at' },
  };

  it('REFUSES a cumulative ref on aggregate() and points at query({window})', () => {
    expect(() =>
      normalizeAggregate(cumCatalog, { entity: 'opps', measures: [{ ref: 'running_revenue' }] }),
    ).toThrow(/cumulative .* window .* query\(\{ window/is);
  });

  it('the cumulative error names CUMULATIVE_IS_WINDOW and does not emit a measure/composite', () => {
    let msg = '';
    try {
      normalizeAggregate(cumCatalog, { entity: 'opps', measures: [{ ref: 'running_revenue' }] });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('CUMULATIVE_IS_WINDOW');
  });
});
