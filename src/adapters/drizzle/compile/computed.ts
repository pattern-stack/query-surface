// Computed metrics — cheap aggregates over the introspected relational graph,
// surfaced as first-class fields (filterable, sortable, projected inline).
//
// A metric is declared host-side as `{ key, agg, over, field?, filter? }` and
// compiled HERE into a correlated scalar subquery against the related table:
//
//   observation_count → (select count(*)::int from observations
//                         where observations.opportunity_id = opportunities.id
//                           and observations.retracted_at is null
//                           and observations.scope = 'deal')
//
// No materialized column, no write-path: the value is derived at read time from
// the same FK graph the registry already introspects, so it is always correct.
// The resulting SQL expression rides the engine's existing expression path
// (compiler `kind:'computed'`), giving filter + sort + projection for free.
//
// Hard-rule 1 (builder-only): aggregates use the SAME idiom as window measures —
// `count(*)` / `sql.raw(agg)(col)` over column OBJECTS + bound params, never a
// caller string. Self-contained (no compiler import) to keep compiler→computed
// one-directional.

import {
  type SQL,
  and,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  sql,
} from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { EntityName } from '../../../internal/language/types.ts';
import type { ComputedFieldSpec, ComputedFilterLeaf } from '../registry/registry.ts';
import { registry } from '../registry/registry.ts';

// Drizzle column refs are camelCase; the spec speaks snake_case (consumer dialect).
function camel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function fail(spec: ComputedFieldSpec, msg: string): never {
  throw new Error(`computed '${spec.key}': ${msg}`);
}

/** The aggregate over the related table. count → ::int so node-pg hands back a
 *  JS number (bigint would arrive as a string); max/min/sum use the window-measure
 *  `sql.raw(agg)` idiom (agg is a closed union, never a caller string). */
function aggExpr(spec: ComputedFieldSpec, childCols: Record<string, PgColumn>): SQL {
  if (spec.agg === 'count') return sql`count(*)::int`;
  if (!spec.field) fail(spec, `agg '${spec.agg}' requires 'field'`);
  const col = childCols[camel(spec.field)];
  if (!col) fail(spec, `field '${spec.field}' not found on related entity`);
  return sql`${sql.raw(spec.agg)}(${col})`;
}

/** A sub-filter leaf compiled against a child column. Host-authored constants —
 *  values are already correctly typed, so no JSON coercion is needed here. */
function subLeaf(
  spec: ComputedFieldSpec,
  childCols: Record<string, PgColumn>,
  leaf: ComputedFilterLeaf,
): SQL {
  const col = childCols[camel(leaf.on)];
  if (!col) fail(spec, `sub-filter column '${leaf.on}' not found on related entity`);
  switch (leaf.op) {
    case 'eq':
      return eq(col, leaf.value as never);
    case 'neq':
      return ne(col, leaf.value as never);
    case 'in':
      return inArray(col, leaf.value as never[]);
    case 'nin':
      return notInArray(col, leaf.value as never[]);
    case 'gt':
      return gt(col, leaf.value as never);
    case 'gte':
      return gte(col, leaf.value as never);
    case 'lt':
      return lt(col, leaf.value as never);
    case 'lte':
      return lte(col, leaf.value as never);
    case 'is_null':
      return isNull(col);
    case 'is_not_null':
      return isNotNull(col);
    default:
      return fail(spec, `unsupported sub-filter op '${leaf.op}'`);
  }
}

/** One relationship → a correlated `(select <agg> from child where child.fk =
 *  parent.pk [and <sub-filter>])` scalar subquery. */
function aggOverRelation(entity: EntityName, relName: string, spec: ComputedFieldSpec): SQL {
  const parent = registry[entity];
  if (!parent) fail(spec, `unknown entity '${entity}'`);
  const rel = parent.relationships[relName];
  if (!rel) fail(spec, `no relationship '${relName}' on '${entity}'`);
  if (rel.kind !== 'has_many') {
    fail(spec, `relationship '${relName}' must be has_many to aggregate over`);
  }
  const child = registry[rel.target];
  if (!child) fail(spec, `relationship '${relName}' targets unknown entity '${rel.target}'`);

  const childCols = child.columns as Record<string, PgColumn>;
  const parentCols = parent.columns as Record<string, PgColumn>;
  const fkCol = childCols[camel(rel.fk)];
  const parentPk = parentCols[parent.primaryKey];
  if (!fkCol || !parentPk) fail(spec, `cannot resolve FK for relationship '${relName}'`);

  const predicates: SQL[] = [eq(fkCol, parentPk)];
  for (const leaf of spec.filter ?? []) {
    predicates.push(subLeaf(spec, childCols, leaf));
  }
  // NB: predicates is non-empty (the FK eq is always present); and() never returns undefined here.
  const where = and(...predicates)!;
  return sql`(select ${aggExpr(spec, childCols)} from ${child.table} where ${where})`;
}

// to_char formats so a date/datetime aggregate serializes like a NATIVE datetime
// column. node-pg does not type-parse a correlated-subquery scalar (proven: even
// a ::timestamptz cast stays a raw string), so we format to ISO-8601 UTC text in
// SQL. Display-ONLY — comparison paths keep the raw timestamp so coerced Date
// filter params still compare correctly. Format is a bound param (rule 1).
const ISO_DATETIME_FMT = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';
const ISO_DATE_FMT = 'YYYY-MM-DD';

/**
 * Compile a computed metric spec into its SQL expression. A single `over`
 * relationship yields one correlated subquery; an array (max/min only) folds the
 * per-relationship aggregates via GREATEST/LEAST. With `display`, a date/datetime
 * max/min is wrapped in `to_char` so it serializes as ISO-8601 like native
 * datetime columns (projection only; default returns the comparable form).
 */
export function buildComputedExpr(
  entity: EntityName,
  spec: ComputedFieldSpec,
  opts: { display?: boolean } = {},
): SQL {
  const base = buildAggregate(entity, spec);
  if (!opts.display || (spec.agg !== 'max' && spec.agg !== 'min')) return base;
  if (spec.type === 'datetime') return sql`to_char(${base}, ${ISO_DATETIME_FMT})`;
  if (spec.type === 'date') return sql`to_char(${base}, ${ISO_DATE_FMT})`;
  return base;
}

function buildAggregate(entity: EntityName, spec: ComputedFieldSpec): SQL {
  const rels = Array.isArray(spec.over) ? spec.over : [spec.over];
  if (rels.length === 0) fail(spec, `'over' must name at least one relationship`);
  if (rels.length === 1) return aggOverRelation(entity, rels[0], spec);

  if (spec.agg !== 'max' && spec.agg !== 'min') {
    fail(spec, `multi-relationship 'over' supports only max/min (got '${spec.agg}')`);
  }
  const parts = rels.map((r) => aggOverRelation(entity, r, spec));
  const joined = sql.join(parts, sql`, `);
  return spec.agg === 'max' ? sql`greatest(${joined})` : sql`least(${joined})`;
}

/**
 * Aliased SELECT expressions for an entity's computed metrics, keyed by the
 * snake_case metric key (the dialect describe / projectRow speak). Always uses
 * the display form (ISO-8601 for datetime aggregates). `previewOnly` limits the
 * set to metrics flagged for first-pass preview rows; the default (all) is what
 * /fetch hydrates inline.
 */
export function computedSelectShape(
  entity: EntityName,
  opts: { previewOnly?: boolean } = {},
): Record<string, SQL.Aliased> {
  const out: Record<string, SQL.Aliased> = {};
  for (const spec of registry[entity]?.computed ?? []) {
    if (opts.previewOnly && !spec.preview) continue;
    out[spec.key] = buildComputedExpr(entity, spec, { display: true }).as(spec.key);
  }
  return out;
}
