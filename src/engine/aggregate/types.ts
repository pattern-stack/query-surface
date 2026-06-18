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

import type { FilterExpression } from '../../types';

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

export interface Measure {
  /** '*' | fieldKey | 'relation.fieldKey' */
  on: string;
  agg: Agg;
  /** optional source-entity override (else inferred from `on` / root) */
  source?: string;
  /** filtered measure → agg(...) FILTER (WHERE <predicate>) */
  where?: Predicate;
  as: string;
}

/** A composite output column computed by OUTER-SELECT arithmetic over already-collapsed
 *  measure-leg aliases — never a CTE join, so it adds no fan-out. The legs (`numerator`/
 *  `denominator`) are `$`-aliased Measures in `measures` (engine-generated, computed in
 *  their own source CTEs); the composite divides their collapsed values post-group/join.
 *  A ratio is non-additive by definition. (B5 adds a 'pop' kind.) */
export interface CompositeColumn {
  kind: 'ratio';
  as: string;
  numerator: string; // a leg measure's `as`
  denominator: string; // a leg measure's `as`
  /** the numerator leg's agg — drives the NULL-policy: an absent group on a
   *  zero-on-empty agg (sum/count/count_distinct) coalesces to 0 (genuinely 0),
   *  but on avg/min/max stays NULL (undefined, not 0). */
  numeratorAgg: Agg;
}

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
  plan: AggregatePlan;
  warnings?: string[];
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
}
