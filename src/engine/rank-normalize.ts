// rank_by input normalizer — sibling of filter-normalize.ts, same philosophy: accept the
// shapes models naturally emit and canonicalize at the front door.
//
// Canonicalizations:
//   • key aliases  — partition field: group_by / per / per_group / groupBy / partitionBy →
//     partition_by (the canonical name; chosen empirically — it's what gemini-3.5-flash emits
//     unanimously and flash-lite half the time when asked to design the shape unprompted).
//     Also top_k/topK/k → limit.
//   • quote-stripping — small models sometimes emit keys wrapped in literal quotes
//     (`{"\"limit\"": 5}`); strip wrapping quotes/whitespace before matching.
//   • unknown keys are DROPPED with no error (rank_by is a directive, not a filter — a stray
//     key shouldn't 400 the whole search; the canonical fields drive behavior).

import type { RankBy } from '../types.ts';

const KEY_ALIAS: Readonly<Record<string, keyof RankBy>> = {
  on: 'on',
  column: 'on',
  field: 'on',
  query: 'query',
  q: 'query',
  text: 'query',
  search: 'query',
  method: 'method',
  mode: 'method',
  limit: 'limit',
  top_k: 'limit',
  topk: 'limit',
  k: 'limit',
  min_score: 'min_score',
  minscore: 'min_score',
  threshold: 'min_score',
  partition_by: 'partition_by',
  partitionby: 'partition_by',
  group_by: 'partition_by',
  groupby: 'partition_by',
  per: 'partition_by',
  per_group: 'partition_by',
  pergroup: 'partition_by',
};

// method VALUE aliases — models improvise the ranking method ('similarity', 'cosine', 'keyword'
// …) instead of the canonical 'semantic'/'lexical'. Conform the ones they reach for; an
// unrecognized value is left as-is for the service to reject with a clear error.
const METHOD_ALIAS: Readonly<Record<string, 'semantic' | 'lexical'>> = {
  semantic: 'semantic',
  similarity: 'semantic',
  similar: 'semantic',
  cosine: 'semantic',
  cosine_similarity: 'semantic',
  cosinesimilarity: 'semantic',
  vector: 'semantic',
  embedding: 'semantic',
  embeddings: 'semantic',
  nearest: 'semantic',
  knn: 'semantic',
  lexical: 'lexical',
  keyword: 'lexical',
  keywords: 'lexical',
  fts: 'lexical',
  full_text: 'lexical',
  fulltext: 'lexical',
  text: 'lexical',
  ts: 'lexical',
  tsvector: 'lexical',
  bm25: 'lexical',
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function normalizeRankBy(input: unknown): RankBy | undefined {
  if (input === undefined || input === null) return undefined;
  if (!isPlainObject(input)) return undefined;

  const out: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(input)) {
    const key = rawKey
      .trim()
      .replace(/^["']+|["']+$/g, '')
      .toLowerCase();
    const canonical = KEY_ALIAS[key];
    if (canonical) out[canonical] = value;
  }
  // Conform the method VALUE (similarity/cosine → semantic, keyword/fts → lexical). An
  // unrecognized non-empty value is left as-is so the service rejects it with a clear message.
  if (typeof out.method === 'string') {
    const m = out.method
      .trim()
      .replace(/^["']+|["']+$/g, '')
      .toLowerCase();
    out.method = METHOD_ALIAS[m] ?? m;
  }
  // Coerce numeric strings for limit/min_score (models sometimes quote numbers).
  if (typeof out.limit === 'string' && out.limit.trim() !== '') {
    const n = Number(out.limit);
    if (Number.isFinite(n)) out.limit = n;
  }
  if (typeof out.min_score === 'string' && out.min_score.trim() !== '') {
    const n = Number(out.min_score);
    if (Number.isFinite(n)) out.min_score = n;
  }
  return out as unknown as RankBy;
}
