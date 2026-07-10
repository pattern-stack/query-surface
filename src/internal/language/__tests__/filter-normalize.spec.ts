import { describe, expect, it } from 'bun:test';
import { normalizeFilter } from '../filter-normalize.ts';

describe('normalizeFilter — natural DSL → canonical AST', () => {
  it('maps a scalar to eq', () => {
    expect(normalizeFilter({ dealstage: 'closedwon' })).toEqual({
      on: 'dealstage',
      op: 'eq',
      value: 'closedwon',
    });
  });

  it('an EMPTY filter is NO CONSTRAINT → match-all (empty AND, compiles to no WHERE)', () => {
    // Scope is ANDed in separately and is non-bypassable, so `{}` = everything WITHIN scope.
    expect(normalizeFilter({})).toEqual({ and: [] });
  });

  it('maps an operator object to that op', () => {
    expect(normalizeFilter({ amount: { gt: 100000 } })).toEqual({
      on: 'amount',
      op: 'gt',
      value: 100000,
    });
  });

  it('ANDs multiple operators on one field', () => {
    expect(normalizeFilter({ amount: { gte: 1000, lte: 5000 } })).toEqual({
      and: [
        { on: 'amount', op: 'gte', value: 1000 },
        { on: 'amount', op: 'lte', value: 5000 },
      ],
    });
  });

  it('maps a bare array to in', () => {
    expect(normalizeFilter({ type: ['objection', 'risk'] })).toEqual({
      on: 'type',
      op: 'in',
      value: ['objection', 'risk'],
    });
  });

  it('supports explicit in / nin operator objects', () => {
    expect(normalizeFilter({ type: { in: ['a', 'b'] } })).toEqual({
      on: 'type',
      op: 'in',
      value: ['a', 'b'],
    });
  });

  it('maps null to is_null and {is_null:false} to is_not_null', () => {
    expect(normalizeFilter({ closedate: null })).toEqual({
      on: 'closedate',
      op: 'is_null',
    });
    expect(normalizeFilter({ closedate: { is_null: false } })).toEqual({
      on: 'closedate',
      op: 'is_not_null',
    });
  });

  it('supports is_not_null and its boolean inversion', () => {
    expect(normalizeFilter({ closedate: { is_not_null: true } })).toEqual({
      on: 'closedate',
      op: 'is_not_null',
    });
    expect(normalizeFilter({ closedate: { is_not_null: false } })).toEqual({
      on: 'closedate',
      op: 'is_null',
    });
  });

  it('implicit-ANDs multiple fields', () => {
    expect(normalizeFilter({ dealstage: 'closedwon', amount: { gt: 1 } })).toEqual({
      and: [
        { on: 'dealstage', op: 'eq', value: 'closedwon' },
        { on: 'amount', op: 'gt', value: 1 },
      ],
    });
  });

  it('handles explicit and / or / not groups recursively', () => {
    expect(
      normalizeFilter({
        or: [{ dealstage: 'closedwon' }, { amount: { gt: 100000 } }],
      }),
    ).toEqual({
      or: [
        { on: 'dealstage', op: 'eq', value: 'closedwon' },
        { on: 'amount', op: 'gt', value: 100000 },
      ],
    });
    expect(normalizeFilter({ not: { dealstage: 'closedlost' } })).toEqual({
      not: { on: 'dealstage', op: 'eq', value: 'closedlost' },
    });
  });

  it('passes through the legacy explicit {on,op,value} leaf', () => {
    expect(normalizeFilter({ on: 'stage', op: 'eq', value: 'x' })).toEqual({
      on: 'stage',
      op: 'eq',
      value: 'x',
    });
  });

  it('keeps dotted relation paths as the field key', () => {
    expect(normalizeFilter({ 'account.name': { contains: 'Acme' } })).toEqual({
      on: 'account.name',
      op: 'contains',
      value: 'Acme',
    });
  });

  it('rejects mixing logical keys with field conditions', () => {
    expect(() => normalizeFilter({ and: [{ a: 1 }], dealstage: 'x' })).toThrow(/cannot mix/);
  });

  it('tolerates operator keys wrapped in literal quotes (small-model over-escaping)', () => {
    expect(normalizeFilter({ amount: { '"gt"': 100000 } })).toEqual({
      on: 'amount',
      op: 'gt',
      value: 100000,
    });
  });

  it('rejects an unknown operator', () => {
    expect(() => normalizeFilter({ amount: { biggerthan: 5 } })).toThrow(/unknown operator/);
  });

  // Hybrid leaf {field: {op, value}} — gpt-oss-20b + qwen3.6 convergent emission
  // (2026-06-11 translation benchmark: sole cause of every first-attempt 400 on both).
  it('accepts the hybrid leaf {field: {op, value}}', () => {
    expect(normalizeFilter({ amount: { op: 'gt', value: 100000 } })).toEqual({
      on: 'amount',
      op: 'gt',
      value: 100000,
    });
    expect(
      normalizeFilter({
        occurred_at: { op: 'between', value: ['2026-05-01', '2026-05-31'] },
      }),
    ).toEqual({
      on: 'occurred_at',
      op: 'between',
      value: ['2026-05-01', '2026-05-31'],
    });
  });

  it('resolves op aliases inside a hybrid leaf', () => {
    expect(normalizeFilter({ type: { op: 'notIn', value: ['a'] } })).toEqual({
      on: 'type',
      op: 'nin',
      value: ['a'],
    });
  });

  it('accepts hybrid null-check ops without a value and flips on false', () => {
    expect(normalizeFilter({ closedate: { op: 'is_null' } })).toEqual({
      on: 'closedate',
      op: 'is_null',
    });
    expect(normalizeFilter({ closedate: { op: 'is_null', value: false } })).toEqual({
      on: 'closedate',
      op: 'is_not_null',
    });
  });

  it('rejects a hybrid leaf with an unknown op or missing value', () => {
    expect(() => normalizeFilter({ amount: { op: 'biggerthan', value: 5 } })).toThrow(
      /unknown operator "biggerthan"/,
    );
    expect(() => normalizeFilter({ amount: { op: 'gt' } })).toThrow(/requires a "value"/);
  });

  it('does NOT treat "op" alongside other operator keys as hybrid', () => {
    expect(() => normalizeFilter({ amount: { op: 'gt', value: 1, lte: 5 } })).toThrow(
      /unknown operator "op"/,
    );
  });

  it('rejects a non-object filter', () => {
    expect(() => normalizeFilter('nope')).toThrow(/must be a JSON object/);
  });
});
