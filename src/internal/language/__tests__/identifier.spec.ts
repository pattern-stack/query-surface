import { describe, expect, it } from 'bun:test';
import { isIdentifier, toIdentifier } from '../identifier';

describe('identifier contract', () => {
  it('isIdentifier accepts safe names, rejects the rest', () => {
    for (const ok of ['amount_sum', '_x', 'a1', 'deal_size_band'])
      expect(isIdentifier(ok)).toBe(true);
    for (const bad of ['Amount.sum', 'Amount', '1abc', 'a b', 'x)or(1=1', '']) {
      expect(isIdentifier(bad)).toBe(false);
    }
  });

  it('toIdentifier coerces any name to a valid identifier', () => {
    expect(toIdentifier('Amount.sum')).toBe('amount_sum');
    expect(toIdentifier('Deal Size Band')).toBe('deal_size_band');
    expect(toIdentifier('Probability.avg')).toBe('probability_avg');
    expect(toIdentifier('123abc')).toBe('_123abc');
    expect(toIdentifier('%$#')).toBe('_');
    expect(toIdentifier('  weird--name!! ')).toBe('weird_name');
  });

  it('is total + idempotent: every output satisfies isIdentifier', () => {
    for (const n of ['Amount.sum', 'Deal Size Band', '123', '%$#', 'ALL_CAPS', 'a.b.c']) {
      const id = toIdentifier(n);
      expect(isIdentifier(id)).toBe(true);
      expect(toIdentifier(id)).toBe(id);
    }
  });
});
