// The governed aggregation stage for the query-surface.
//
// A MEASURE is a leaf; AGGREGATION is a stage (sibling to filter/sort/rankBy).
// Field tags (role/agg/additivity/time) ride on the registry, mirroring the
// native FieldMeta and the EAV field_definitions row (one vocabulary, two homes).
//
// Correctness is structural: each measure is aggregated WITHIN ITS OWN SOURCE
// ENTITY grouped by the group key, then per-source aggregates are joined on the
// key. A measure is never summed across a join it doesn't own, so fan-out is
// impossible by construction. See ./grain.ts and ./compile.ts.

import type { FilterExpression } from '../language/types';

export type Agg = 'count' | 'count_distinct' | 'sum' | 'avg' | 'min' | 'max';
export type Additivity = 'additive' | 'semi' | 'non';
export type AggColType = 'number' | 'string' | 'boolean' | 'datetime' | 'json' | 'uuid' | 'enum';

/** Per-field analytics tags. Native columns carry these on FieldMeta; EAV custom
 *  fields carry the SAME keys on their field_definitions row. */
export interface AggFieldMeta {
  type: AggColType;
  role?: 'measure' | 'dimension';
  /** default aggregation for a measure */
  agg?: Agg;
  /** Allowed aggregations for a measure field — the field IS the measure, aggregation is a
   *  config on it. The catalog generates one `field.agg` entry per listed agg (e.g.
   *  `Amount.sum`, `Amount.avg`). Omit → fall back to the single `agg` (legacy named measure). */
  aggs?: Agg[];
  /** additive (sum/avg/min/max ok) | semi (not summable over time) | non (never sum) */
  additivity?: Additivity;
  /** marks the time axis (semi-additive measures may not be summed across it) */
  time?: boolean;
  /** physical column; defaults to the field key */
  column?: string;
  /** EAV custom field, resolved through field_values (single-row by UNIQUE) */
  eav?: {
    valueColumn: 'value_number' | 'value_text' | 'value_date' | 'value_boolean';
    defId: string;
  };
  /** A DIMENSION with a DECLARED value domain (a native pg-enum, or a qField/EAV
   *  `select_options` list). Surfaced on ConformedDim as `valueDomain:'declared'` so an
   *  agent knows the values are already enumerated for free (see describe `key_fields`),
   *  vs `'open'` (free-string / to-one — no declared list; enumerate via `measure(group_by)`,
   *  scoped). NB declared ≠ exhaustive: prod data drifts past the declared set (see
   *  prod-select-options-divergence) — declared is a trustworthy PRIOR, not ground truth. */
  hasDeclaredDomain?: boolean;
}

export interface AggRelationship {
  kind: 'belongs_to' | 'has_many';
  target: string;
  fk: string;
}

export interface AggEntity {
  table: string;
  pk: string;
  rels: Record<string, AggRelationship>;
  fields: Record<string, AggFieldMeta>;
}

export type AggRegistry = Record<string, AggEntity>;

// ---------------------------------------------------------------------------
// Query model
// ---------------------------------------------------------------------------
// ONE expression language: the aggregate stage's filter/where/having ARE the
// package's FilterExpression — so query() and aggregate() share the filter/scope
// type (and a scope FilterExpression composes into an aggregate filter for free).
export type Predicate = FilterExpression;
export type { FilterExpression };

/** Explicit "this source carries no tenancy" decision. A scope resolver MUST
 *  return either a Predicate or TENANT_GLOBAL for every source it's asked about;
 *  returning `undefined` is NOT "unscoped" — it means the resolver had no answer,
 *  which the engine treats as a coverage gap and REFUSES (fail-closed). This
 *  inverts the dangerous default where a forgotten/typo'd source silently
 *  aggregated cross-tenant. */
export const TENANT_GLOBAL = Symbol('tenant-global');

/** Per-source tenancy scope resolver: given a SOURCE entity name, return the
 *  predicate to AND into THAT source's pre-aggregation WHERE, or TENANT_GLOBAL to
 *  declare it has no tenancy. Resolved per source so a cross-entity measure CTE is
 *  scoped to its OWN entity, never the query root. Returning `undefined` for a
 *  source that is actually queried is a coverage gap → the engine throws (it does
 *  NOT silently leave that source unscoped). When NO resolver is supplied at all,
 *  the engine runs unscoped (trusted/standalone mode — e.g. evals, demos). */
export type ScopeFor = (sourceEntity: string) => Predicate | typeof TENANT_GLOBAL | undefined;

/** A ROW-LEVEL expression (ADR-0029 D4) — the value a measure aggregates over, computed PER ROW
 *  BEFORE the single aggregation pass: `agg(f(col1,col2,…))`. This is still ONE pass → still a
 *  MEASURE (below the aggregation boundary), NEVER a metric: SUM(a·b) ≠ SUM(a)·SUM(b), so the
 *  multiply must happen per-row, before SUM. Leaves are a LOCAL native/EAV numeric col on the
 *  measure's OWN source (v1 — a dotted relation reach is rejected at registration) or a numeric
 *  literal. The op set is the closed 4 (matches the compiler's DERIVED_OP; invariant #1). */
export type RowExpr =
  | { col: string } // a LOCAL native/EAV numeric field key on the measure's source
  | { lit: number } // a numeric literal
  | { op: '+' | '-' | '*' | '/'; left: RowExpr; right: RowExpr };

/** The distinct column leaves of a RowExpr (for coverage checks in the doctor). */
export function rowExprCols(e: RowExpr): string[] {
  if ('col' in e) return [e.col];
  if ('lit' in e) return [];
  return [...rowExprCols(e.left), ...rowExprCols(e.right)];
}

export interface Measure {
  /** '*' | fieldKey | 'relation.fieldKey' | a RowExpr (an expression measure, ADR-0029 D4 — a
   *  per-row expression aggregated ONCE) */
  on: string | RowExpr;
  agg: Agg;
  /** optional source-entity override (else inferred from `on` / root) */
  source?: string;
  /** filtered measure → agg(...) FILTER (WHERE <predicate>) */
  where?: Predicate;
  as: string;
}

/** A composite output column computed by OUTER-SELECT arithmetic over already-collapsed
 *  measure-leg aliases — never a CTE join, so it adds no fan-out. The legs are `$`-aliased
 *  Measures in `measures` (engine-generated, computed in their own source CTEs); the
 *  composite combines their collapsed values post-group/join. A composite is non-additive
 *  by definition. (B5 adds a 'pop' kind.) */
export interface RatioComposite {
  kind: 'ratio';
  as: string;
  numerator: string; // a leg measure's `as`
  denominator: string; // a leg measure's `as`
  /** the numerator leg's agg — drives the NULL-policy: an absent group on a
   *  zero-on-empty agg (sum/count/count_distinct) coalesces to 0 (genuinely 0),
   *  but on avg/min/max stays NULL (undefined, not 0). */
  numeratorAgg: Agg;
}

/** A COMPILED derived expression: the same binary tree as the host-facing DerivedExpr, but
 *  every `ref` has been REWRITTEN by normalize to a LEG ALIAS (an engine-generated `__cmp_`
 *  Measure `as`), NOT a catalog measure name. The compiler lowers it to numeric-safe SQL
 *  over the grouped subquery's leg columns. */
export type CompiledDerivedExpr =
  | { ref: string } // a leg alias on the grouped subquery
  | { lit: number } // a numeric literal (a weight)
  | { op: '+' | '-' | '*' | '/'; left: CompiledDerivedExpr; right: CompiledDerivedExpr };

/** A derived metric: an arithmetic EXPRESSION (the closed 4-op binary tree) over atomic
 *  measure legs (the ADR-0029 D2 subtractive/weighted gap, e.g. gross_profit = revenue -
 *  cost). Computed as OUTER-SELECT arithmetic over the collapsed legs — never a CTE join,
 *  so it adds no fan-out, exactly like ratio. `legs` carries each leg's agg for the per-leg
 *  NULL-policy (zero-on-empty agg coalesces to 0; avg/min/max stays NULL). */
export interface DerivedComposite {
  kind: 'derived';
  as: string;
  expr: CompiledDerivedExpr; // refs = leg aliases
  legs: { alias: string; agg: Agg }[];
}

export type CompositeColumn = RatioComposite | DerivedComposite;

export interface Aggregate {
  entity: string; // the anchor / root entity
  group_by?: string[]; // dimension columns (on the relevant grain)
  measures: Measure[];
  /** outer-SELECT composites (ratio/PoP) over collapsed leg aliases; produced by
   *  normalizeAggregate from a catalog ratio ref, emitted in the final projection. */
  composites?: CompositeColumn[];
  filter?: Predicate; // pre-aggregation WHERE (row-local)
  having?: Predicate; // post-aggregation, over measure aliases
  order_by?: { on: string; dir: 'asc' | 'desc' }[];
  limit?: number;
  // NB: aggregate() is the COLLAPSE verb (GROUP BY → groups). Window measures
  // (agg() OVER (PARTITION BY …), rows preserved) live on query() — see WindowMeasure.
}

export interface AggregatePlan {
  groupGrain: string;
  needsCte: boolean; // measures span >1 source entity → per-source pre-agg + join
  /** would a naive single-pass root-join double-count? (the danger flag) */
  rootJoinWouldFan: boolean;
  sources: string[];
}

export interface AggregateResult {
  rows: Record<string, unknown>[];
  row_count: number;
  group_count: number | null;
  sql: string;
  params: unknown[];
  plan: AggregatePlan;
  warnings?: string[];
}

/**
 * Calibration-grade citation for a relevance cohort (Wave-2 — ADR-0024 §A, step 7).
 * MANDATORY whenever a `relevant` leaf is present: the collapsing aggregate/compare SQL
 * yields grouped rows with no row id/text, so this is computed by a COMPANION query at
 * ROW grain over the semantic entity (re-running the crispified cohort predicate, reusing
 * the already-resolved vector — NO second embed). It makes the fuzzy cohort AUDITABLE: the
 * cutoff, how many matched, a handful of exemplars, and the membership boundary.
 *
 *   - `on`             : the relevant leaf's semantic text column (or dotted path) as authored.
 *   - `query`          : the concept that was embedded.
 *   - `mode`           : 'threshold' (similarity cutoff) | 'top_k' (ranked cutoff).
 *   - `per`            : the top_k partition key, when one was resolved (else absent).
 *   - `cutoff`         : the resolved threshold (threshold mode) OR the k-th / lowest-included
 *                        similarity (top_k mode) — the line membership is decided on.
 *   - `match_count`    : rows in the cohort (>= cutoff, or exactly k capped at available).
 *   - `exemplars`      : the top matches (default 4) — id + similarity + a head-truncated
 *                        snippet of the semantic text + full_length.
 *   - `boundary`       : lowest_included = the weakest member (the cutoff row);
 *                        highest_excluded = the strongest NON-member (one row past the cutoff),
 *                        present ONLY when requested (citation:{boundary:true}).
 */
export interface CitationExemplar {
  id: string;
  similarity: number;
  snippet: string;
  full_length: number;
}
export interface CitationBoundaryRow {
  id: string;
  similarity: number;
  snippet: string;
}
export interface RelevanceCitation {
  on: string;
  query: string;
  mode: 'threshold' | 'top_k';
  per?: string;
  cutoff: number;
  match_count: number;
  exemplars: CitationExemplar[];
  boundary: {
    lowest_included: CitationBoundaryRow;
    highest_excluded?: CitationBoundaryRow;
  };
}

/** Public surface response — parallel to FetchResponse, NOT a SearchEntityResult
 *  (grouped rows carry no entity id). `plan` stays internal (AggregateResult). */
export interface AggregateResponse {
  entity: string;
  rows: Record<string, unknown>[];
  row_count: number;
  group_count: number | null;
  warnings?: string[];
  sql?: string;
  /** The bound parameter values for `sql` (placeholder $n → value), echoed with `include_sql` —
   *  parity with query()/fetch(). Debug surface; a vector param is the full embedding array. */
  params?: unknown[];
  /** ON whenever a `relevant` leaf was present in the filter — the auditable cohort
   *  definition, computed by a row-grain companion query (additive, flows to the wire). */
  citation?: RelevanceCitation;
}
