import { describe, expect, it } from 'bun:test';
import { normalizeRankBy } from '../rank-normalize.ts';

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
