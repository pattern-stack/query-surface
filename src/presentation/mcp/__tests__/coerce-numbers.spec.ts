import { describe, expect, it } from 'bun:test';
import { coerceNumbers, losslessNumber } from '../tools.ts';

describe('losslessNumber — coerce only when it round-trips exactly', () => {
  it('coerces clean integers (the common count/sum case)', () => {
    expect(losslessNumber('100')).toBe(100);
    expect(losslessNumber('10929000')).toBe(10929000);
    expect(losslessNumber('0')).toBe(0);
    expect(losslessNumber('-5')).toBe(-5);
  });

  it('coerces decimals that round-trip', () => {
    expect(losslessNumber('0.55')).toBe(0.55);
    expect(losslessNumber('0.8694827770873914')).toBe(0.8694827770873914);
  });

  it('KEEPS precision-exceeding / non-canonical numerics as strings (no silent rounding)', () => {
    expect(losslessNumber('115042.105263157895')).toBe('115042.105263157895');
    expect(losslessNumber('0.00000000000000000000')).toBe('0.00000000000000000000');
    expect(losslessNumber('100.0000000000000000')).toBe('100.0000000000000000');
  });

  it('leaves non-numeric strings untouched (names, uuids, dates)', () => {
    expect(losslessNumber('completed')).toBe('completed');
    expect(losslessNumber('00286778-ce4c-5bce-82c9-e63a903bdf5c')).toBe(
      '00286778-ce4c-5bce-82c9-e63a903bdf5c',
    );
    expect(losslessNumber('2026-06-21')).toBe('2026-06-21');
    expect(losslessNumber('')).toBe('');
    expect(losslessNumber('1e5')).toBe('1e5'); // not /^-?\d+(\.\d+)?$/ → untouched
  });
});

describe('coerceNumbers — recursive, structure-preserving', () => {
  it('coerces numeric leaves in nested rows + citation, keeps the rest', () => {
    const input = {
      rows: [{ 'accounts.name': 'Cyera', amount_sum: '293000', win_pct: '100.0000000000000000' }],
      citation: { match_count: '281', cutoff: 0.55, exemplars: [{ similarity: '1', id: 'abc-1' }] },
    };
    expect(coerceNumbers(input)).toEqual({
      rows: [{ 'accounts.name': 'Cyera', amount_sum: 293000, win_pct: '100.0000000000000000' }],
      citation: { match_count: 281, cutoff: 0.55, exemplars: [{ similarity: 1, id: 'abc-1' }] },
    });
  });
});
