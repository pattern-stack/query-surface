// B2 — the measure catalog is DERIVED from the analytics tags + REGISTRATION-validated.
// Pure unit (no DB): measuresFromRegistry / validateMeasureDef operate on an in-memory
// AggRegistry, so these run in CI without DBURL.
import { describe, expect, it } from 'bun:test';
import { type AtomicMeasureDef, measuresFromRegistry, validateMeasureDef } from './measure-catalog';
import type { AggRegistry } from './types';

const reg: AggRegistry = {
  opps: {
    table: 'opps',
    pk: 'id',
    rels: {},
    fields: {
      id: { type: 'uuid', role: 'dimension' },
      stage: { type: 'enum', role: 'dimension' },
      amount: { type: 'number', role: 'measure', agg: 'sum', additivity: 'additive' },
      win_rate: { type: 'number', role: 'measure', agg: 'avg', additivity: 'non' },
      // role:measure but missing agg+additivity → NOT auto-cataloggable
      partial: { type: 'number', role: 'measure' },
    },
  },
};

const def = (
  over: Partial<AtomicMeasureDef> & Pick<AtomicMeasureDef, 'on' | 'source'>,
): AtomicMeasureDef => ({
  kind: 'atomic',
  agg: 'sum',
  additivity: 'additive',
  ...over,
});

describe('measure catalog (B2)', () => {
  it('derives one atomic measure per fully-tagged role:measure field; copies agg + additivity', () => {
    const cat = measuresFromRegistry(reg);
    expect(Object.keys(cat).sort()).toEqual(['amount', 'win_rate']); // not dims, not `partial`
    expect(cat.amount).toEqual({
      kind: 'atomic',
      on: 'amount',
      agg: 'sum',
      source: 'opps',
      additivity: 'additive',
    });
    expect(cat.win_rate).toEqual({
      kind: 'atomic',
      on: 'win_rate',
      agg: 'avg',
      source: 'opps',
      additivity: 'non',
    });
  });

  it('rejects a def whose (source, on) is not a registered field', () => {
    expect(() => validateMeasureDef(reg, 'x', def({ on: 'nope', source: 'opps' }))).toThrow(
      /not registered on "opps"/,
    );
    expect(() => validateMeasureDef(reg, 'x', def({ on: 'amount', source: 'ghost' }))).toThrow(
      /not registered/,
    );
  });

  it('rejects LOOSENING a field additivity (additive over a non field), allows TIGHTENING', () => {
    expect(() =>
      validateMeasureDef(
        reg,
        'bad',
        def({ on: 'win_rate', source: 'opps', additivity: 'additive' }),
      ),
    ).toThrow(/may not loosen/);
    expect(() =>
      validateMeasureDef(reg, 'ok', def({ on: 'amount', source: 'opps', additivity: 'non' })),
    ).not.toThrow();
  });

  it('refuses an ambiguous measure name shared by measures on two entities', () => {
    const dup: AggRegistry = {
      a: {
        table: 'a',
        pk: 'id',
        rels: {},
        fields: { score: { type: 'number', role: 'measure', agg: 'sum', additivity: 'additive' } },
      },
      b: {
        table: 'b',
        pk: 'id',
        rels: {},
        fields: { score: { type: 'number', role: 'measure', agg: 'sum', additivity: 'additive' } },
      },
    };
    expect(() => measuresFromRegistry(dup)).toThrow(/ambiguous measure name "score"/);
  });
});
