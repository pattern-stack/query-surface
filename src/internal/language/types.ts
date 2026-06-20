// Uniform domain query primitive — the language the agent speaks.
//
// One JSON shape works across every entity. Cross-entity reachability via
// dotted field paths. Boolean composition. Text search is just an op, not a
// special tool.

// Entity names are CONSUMER-defined — registered via configureQueryRegistry()
// (or registerSchema()). The package treats them as opaque strings; a consumer
// can narrow this to a union of their own registered names for extra safety.
export type EntityName = string;

export type Op =
  | 'eq'
  | 'neq'
  | 'in'
  | 'nin'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'contains' // ILIKE %X%
  | 'startswith' // ILIKE X%
  | 'endswith' // ILIKE %X
  | 'matches' // Postgres FTS: to_tsvector @@ websearch_to_tsquery (stemmed, boolean)
  | 'is_null'
  | 'is_not_null';

export interface LeafFilter {
  on: string; // field key or dotted path: 'StageName' | 'account.name' | 'opportunity.StageName' | 'text' (magic)
  op: Op;
  value?: unknown;
}

/**
 * Relevance leaf (Wave-2 — ADR-0024 §Direction A + Amendment 2): a semantic match
 * expressed as a Predicate leaf, so it flows into query / aggregate / compare filters
 * identically (hard rule #9 — one expression language). The crisp set is EXPLICIT and
 * MANDATORY: exactly one of `threshold` | `top_k` (the engine REJECTS neither — no
 * silent default). The service resolves `vector` + `embeddingColumn` from the injected
 * embed() port BEFORE compile (engine-internal, NOT part of the wire contract) — the
 * same pattern as SingleSearchQuery.rankSemantic.
 */
export interface RelevantLeaf {
  on: string; // semantic text column (or dotted path); resolves to its embedding column via semanticColumns
  op: 'relevant';
  query: string; // the concept to match (e.g. 'pricing objection')
  threshold?: number; // similarity cutoff in [0,1] = 1 - cosine_distance(embedding, vector); XOR with top_k
  top_k?: number; // ranked cutoff (the k most relevant); XOR with threshold
  per?: string; // top_k partition key; omitted → group_by key when grouping, else global
  // Engine-internal — stamped by the service (which owns the async embed() call) before
  // compile. Not authored by a caller, not part of the wire contract.
  vector?: number[];
  embeddingColumn?: string;
}

/**
 * Crispified relevance leaves — PRIVATE engine shapes the defuzzify step (normalize)
 * emits and BOTH predicate compilers lower. Never authored by a caller. `on` is the
 * resolved EMBEDDING column (crispify rewrites it from the semantic text column so the
 * wave-1 conform/semijoin resolver lowers it over a real column).
 */
export interface SimGteLeaf {
  on: string;
  op: 'sim_gte';
  vector: number[];
  embeddingColumn: string;
  threshold: number;
}
export interface SimTopkLeaf {
  on: string;
  op: 'sim_topk';
  vector: number[];
  embeddingColumn: string;
  top_k: number;
  per?: string;
}

/** A filter leaf: a value op (LeafFilter), the relevance op, or its crispified forms. */
export type Leaf = LeafFilter | RelevantLeaf | SimGteLeaf | SimTopkLeaf;

export type FilterExpression =
  | Leaf
  | { and: FilterExpression[] }
  | { or: FilterExpression[] }
  | { not: FilterExpression };

/** Narrow a filter node to a leaf (vs a boolean and/or/not node). */
export function isLeaf(e: FilterExpression): e is Leaf {
  return !('and' in e) && !('or' in e) && !('not' in e);
}

export interface Sort {
  field: string;
  dir: 'asc' | 'desc';
}

// Rank results by a search method against one text column. A RANKING (order +
// top-K), distinct from boolean `filter`. When present it OWNS ordering + limit
// — any `sort` is ignored (a non-fatal warning is returned). `lexical` = FTS
// (ts_rank_cd); `semantic` = vector cosine (requires a registered embedding
// column + an injected embed() port — see Rung 2).
export interface RankBy {
  // Text column (or dotted path) to rank on. OPTIONAL at the wire: when omitted, the service
  // defaults it to the entity's sole semantic text column (e.g. observations → normalized_text),
  // so callers never have to name it. Always set by the time the engine consumes a RankBy.
  on?: string;
  query: string; // the search text
  // OPTIONAL at the wire: when omitted, the service defaults to 'semantic' if the entity has an
  // embedding column for `on`, else 'lexical'. Value-aliases (similarity/cosine/vector →
  // semantic, keyword/fts/text → lexical) are conformed by normalizeRankBy. Always one of the
  // two canonical values by the time the engine consumes a RankBy.
  method?: 'lexical' | 'semantic';
  limit?: number; // top-K overall — or top-K PER GROUP when partition_by is set
  min_score?: number; // optional cutoff; uncalibrated for lexical
  // Per-group top-K (the window primitive): partition the ranking by this field and keep the
  // best `limit` rows WITHIN each group instead of overall — e.g. partition_by:'account_id'
  // = "the top K most similar per account, across all accounts". Compiles to
  // ROW_NUMBER() OVER (PARTITION BY col ORDER BY score DESC). Canonical name chosen by
  // elicitation (small models emit partition_by/group_by unprompted); aliases (group_by, per,
  // per_group) normalize to this.
  partition_by?: string;
}

/** A windowed measure on query(): agg(on) OVER (PARTITION BY partition_by), projected as
 *  `as`. Rows are PRESERVED + annotated (the within-group face of aggregation) — never
 *  collapsed. Collapsing aggregation (GROUP BY) is the separate aggregate() verb. */
export interface WindowMeasure {
  on: string; // field key / dotted path; '*' → count(*)
  agg: 'sum' | 'count' | 'count_distinct' | 'avg' | 'min' | 'max';
  partition_by: string[];
  as: string;
}

// ============================================================================
// Internal (kept for compatibility with the demo CLI which imports it)
// ============================================================================

export interface DomainQueryRequest {
  entity: EntityName;
  filter?: FilterExpression;
  sort?: Sort[];
  page?: { limit?: number; offset?: number };
  rankBy?: RankBy;
  rankSemantic?: { vector: number[]; embeddingColumn: string };
  window?: WindowMeasure[];
  expand?: string[];
  include_sql?: boolean;
}

export interface DomainQueryResult<T = Record<string, unknown>> {
  rows: T[];
  count: number;
  sql?: string;
  params?: unknown[];
}

// ============================================================================
// /search — find things, return IDs (and optional preview rows)
// ============================================================================

// Per-entity query inside a multi-entity search.
export interface SingleSearchQuery {
  entity: EntityName;
  filter?: FilterExpression;
  sort?: Sort[];
  page?: { limit?: number; offset?: number };
  // Projection — explicit list of fields to return in each preview row (the
  // primary key is always included). Each entry is a field key or dotted path,
  // resolved exactly like a filter `on:` — native columns, EAV fields, and
  // belongs_to paths (e.g. 'account.name') are all valid. has_many paths can't
  // be a scalar column, so they're dropped (the key is simply absent — use
  // fetch + expand to hydrate child rows).
  //   • each field is returned keyed by the EXACT string you pass here — note
  //     this differs from default preview, which keys native columns camelCase.
  //   • `[]` (empty) → id only; omit entirely → the entity's curated preview
  //     fields (CatalogField.preview). The two are distinct.
  // Only honoured when preview rows are requested.
  columns?: string[];
  // Rank + top-K by a search method (lexical/semantic). Owns ordering + limit
  // when present; `sort` is ignored with a warning.
  rankBy?: RankBy;
  // Engine-internal: the resolved query vector + embedding column for a
  // `method:'semantic'` rank, populated by the service (which owns the async
  // embed() call) before compile. Not part of the wire contract.
  rankSemantic?: { vector: number[]; embeddingColumn: string };
  // Windowed measures — agg() OVER (PARTITION BY …) projected onto preview rows
  // (grain preserved). The "selection within query" face of aggregation.
  window?: WindowMeasure[];
}

// Request shape: ONE of these forms.
//   Shape 1: single entity inline — { entity, filter, sort, page, columns?, preview?, include_sql? }
//   Shape 2: multi-entity         — { queries: SingleSearchQuery[], preview?, include_sql? }
export type SearchRequest =
  | (SingleSearchQuery & { preview?: boolean; include_sql?: boolean })
  | { queries: SingleSearchQuery[]; preview?: boolean; include_sql?: boolean };

/**
 * Snippet entry returned in preview rows when a text op (contains/startswith/
 * endswith) fired in the filter. ADDITIVE — does not replace the column value.
 * One entry per matched column per row; rows with no text match get no _snippets.
 *
 *   - `column`        : camelCase column name where the match was found
 *   - `snippet`       : windowed text around the match (±60 chars by default).
 *                       Leading/trailing `…` indicate truncation from full value.
 *   - `match.start`   : zero-based index OF THE MATCH within `snippet`
 *                       (NOT the full column value). Accounts for the leading `…`.
 *   - `match.end`     : exclusive end of the match within `snippet`.
 *   - `full_length`   : length of the original column value (so caller knows
 *                       there's more to fetch beyond the window).
 */
export interface SnippetEntry {
  column: string;
  snippet: string;
  match: { start: number; end: number };
  full_length: number;
}

/** Additive key stamped on preview rows that have a text-op match (value:
 *  SnippetEntry[]). Part of the public result shape — referenced at the stamp
 *  site and anywhere a consumer projection must preserve it. */
export const SNIPPETS_KEY = '_snippets';

/** Additive keys stamped on preview rows by `rank_by`: the relevance score and
 *  (lexical) the ts_headline match snippet. Public result shape — the consumer
 *  projection must preserve them. */
export const RANK_SCORE_KEY = '_rank';
export const RANK_SNIPPET_KEY = '_snippet';

/**
 * Descriptor of a text-op leaf in the compiled filter. Collected during compile;
 * consumed at runtime to extract snippets from preview rows.
 *
 * Only direct columns are tracked — has_many text matches (e.g. transcript
 * matching via `chunks.body`) live on a child row not present in the parent
 * preview, so v1 skips them.
 */
export interface TextMatchDescriptor {
  column: string; // camelCase column on the root entity
  pattern: string; // original search string
  op: 'contains' | 'startswith' | 'endswith';
}

// One entity's search result.
// Preview rows are `Record<string, unknown>` to allow the additive `_snippets`
// array — present when a text op fired AND a column matched in this row.
export interface SearchEntityResult {
  ids: string[];
  total: number; // total matching across all pages
  has_more: boolean;
  preview?: Array<Record<string, unknown>>; // each row may carry a `_snippets: SnippetEntry[]` field
  warnings?: string[]; // non-fatal advisories (e.g. sort ignored because rank_by owns ordering)
  sql?: string; // debug
  params?: unknown[];
  /** ON whenever a `relevant` leaf was present in the query filter — the auditable cohort
   *  definition (cutoff, match_count, exemplars, boundary), computed by a row-grain companion
   *  query. Additive (flows to the Nest wire verbatim). Defined in analytics/types.ts (the
   *  dialect-free home, parallel to SnippetEntry); imported type-only to avoid a runtime cycle. */
  citation?: import('../analytics/types.ts').RelevanceCitation;
}

// Response shape mirrors the request:
//   Single-entity request →  { entity, ids, total, has_more, preview?, sql? }
//   Multi-entity request →   { results: { [entity]: SearchEntityResult } }
export type SearchResponse =
  | ({ entity: EntityName } & SearchEntityResult)
  | { results: Partial<Record<EntityName, SearchEntityResult>> };

// ============================================================================
// /fetch — hydrate IDs into full rows, with optional refinement filter
// ============================================================================

export interface FetchRequest {
  entity: EntityName;
  ids: string[];
  filter?: FilterExpression; // optional refinement — narrow within these IDs
  expand?: string[]; // relations to hydrate inline — dotted paths, e.g. 'opportunity.account' (≤3 hops)
  include_sql?: boolean;
}

export interface FetchResponse {
  entity: EntityName;
  rows: Array<Record<string, unknown>>;
  count: number;
  sql?: string;
  params?: unknown[];
}
