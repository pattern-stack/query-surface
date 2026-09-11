import { describe, expect, it } from 'bun:test';
import { assertRankInput, normalizeRankBy } from '../rank-normalize.ts';

describe('normalizeRankBy — method value aliases', () => {
  it('conforms semantic synonyms', () => {
    for (const m of ['similarity', 'cosine', 'cosine_similarity', 'vector', 'KNN']) {
      expect(normalizeRankBy({ query: 'x', method: m })?.method).toBe('semantic');
    }
  });
  it('conforms lexical synonyms', () => {
    for (const m of ['keyword', 'fts', 'full_text', 'text', 'BM25']) {
      expect(normalizeRankBy({ query: 'x', method: m })?.method).toBe('lexical');
    }
  });
  it('leaves an unrecognized method for the service to reject', () => {
    expect(String(normalizeRankBy({ query: 'x', method: 'wat' })?.method)).toBe('wat');
  });
  it('leaves method absent when omitted (service defaults it)', () => {
    expect(normalizeRankBy({ query: 'x' })?.method).toBeUndefined();
  });
});

describe('normalizeRankBy — alias + tolerance canonicalization', () => {
  it('passes canonical fields through', () => {
    expect(
      normalizeRankBy({
        query: 'pricing',
        method: 'semantic',
        limit: 5,
        partition_by: 'account_id',
      }),
    ).toEqual({
      query: 'pricing',
      method: 'semantic',
      limit: 5,
      partition_by: 'account_id',
    });
  });

  it('maps group_by / per / per_group to partition_by', () => {
    expect(
      normalizeRankBy({
        query: 'x',
        method: 'semantic',
        group_by: 'account_id',
      }),
    ).toEqual({ query: 'x', method: 'semantic', partition_by: 'account_id' });
    expect(
      normalizeRankBy({
        query: 'x',
        method: 'semantic',
        per: 'opportunity_id',
      }),
    ).toEqual({
      query: 'x',
      method: 'semantic',
      partition_by: 'opportunity_id',
    });
    expect(
      normalizeRankBy({
        query: 'x',
        method: 'semantic',
        per_group: 'account_id',
      }),
    ).toEqual({ query: 'x', method: 'semantic', partition_by: 'account_id' });
  });

  it('maps camelCase aliases (groupBy, partitionBy, topK)', () => {
    expect(
      normalizeRankBy({
        query: 'x',
        method: 'semantic',
        groupBy: 'a',
        topK: 3,
      }),
    ).toEqual({ query: 'x', method: 'semantic', partition_by: 'a', limit: 3 });
  });

  it('strips literal quote wrapping on keys and coerces numeric strings', () => {
    expect(
      normalizeRankBy({
        '"query"': 'x',
        '"method"': 'semantic',
        '"limit"': '5',
      }),
    ).toEqual({ query: 'x', method: 'semantic', limit: 5 });
  });

  it('drops unknown keys instead of erroring', () => {
    expect(normalizeRankBy({ query: 'x', method: 'semantic', bogus: true })).toEqual({
      query: 'x',
      method: 'semantic',
    });
  });

  it('returns undefined for nullish / non-object input', () => {
    expect(normalizeRankBy(undefined)).toBeUndefined();
    expect(normalizeRankBy(null)).toBeUndefined();
    expect(normalizeRankBy('semantic')).toBeUndefined();
  });
});

describe('normalizeRankBy — vector input (#38)', () => {
  it('passes a canonical vector through untouched', () => {
    expect(normalizeRankBy({ vector: [0.1, 0.2], method: 'semantic' })).toEqual({
      vector: [0.1, 0.2],
      method: 'semantic',
    });
  });
  it('maps embedding / query_vector / queryVector to vector', () => {
    for (const key of ['embedding', 'query_vector', 'queryVector', '"vector"']) {
      expect(normalizeRankBy({ [key]: [1, 2, 3] })?.vector).toEqual([1, 2, 3]);
    }
  });
  it('does not coerce a vector: a string stays a string for the validator to reject', () => {
    expect(normalizeRankBy({ vector: '[1,2]' })?.vector).toBe('[1,2]' as unknown as number[]);
  });
});

describe('assertRankInput — exactly one of query | vector', () => {
  const ok = (rb: Parameters<typeof assertRankInput>[0]) => assertRankInput(rb);
  it('returns undefined and a text rank unchanged', () => {
    expect(ok(undefined)).toBeUndefined();
    expect(ok({ query: 'pricing', method: 'semantic' })).toEqual({
      query: 'pricing',
      method: 'semantic',
    });
    expect(ok({ query: 'pricing', method: 'lexical' })).toEqual({
      query: 'pricing',
      method: 'lexical',
    });
  });
  it('accepts a finite non-empty vector for semantic', () => {
    expect(ok({ vector: [0.5, -0.25], method: 'semantic' })?.vector).toEqual([0.5, -0.25]);
  });
  it('rejects an empty, non-numeric or non-finite vector with a clear message', () => {
    for (const v of [[], ['a'], [1, Number.NaN], [1, Number.POSITIVE_INFINITY], '[1,2]', 3]) {
      expect(() => ok({ vector: v as unknown as number[], method: 'semantic' })).toThrow(
        /rank_by:.*vector must be a non-empty array of finite numbers/,
      );
    }
  });
  it('rejects a vector on a lexical rank', () => {
    expect(() => ok({ vector: [1], method: 'lexical' })).toThrow(
      /vector requires method 'semantic'/,
    );
  });
  it('rejects query AND vector together', () => {
    expect(() => ok({ query: 'x', vector: [1], method: 'semantic' })).toThrow(
      /query OR vector, not both/,
    );
  });
  it('rejects neither, naming the vector option only for semantic', () => {
    expect(() => ok({ method: 'semantic' })).toThrow(/query \(text\) or vector is required/);
    expect(() => ok({ method: 'lexical' })).toThrow(/query is required/);
    expect(() => ok({ query: '   ', method: 'semantic' })).toThrow(/query \(text\) or vector/);
  });
});
