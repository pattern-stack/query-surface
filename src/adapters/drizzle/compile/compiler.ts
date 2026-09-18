// FilterCompiler — JSON FilterExpression → Drizzle SQL.
//
// Resolves dotted field paths into JOIN chains (for belongs_to) or EXISTS
// subqueries (for has_many). Compiles each leaf op to a Drizzle SQL fragment.
// Handles boolean composition. Returns a runnable query the service layer
// dispatches.

import {
  type SQL,
  type SQLWrapper,
  and,
  asc,
  eq,
  getTableName,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  not,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { type PgColumn, type PgTable, alias } from 'drizzle-orm/pg-core';
import { ENGINE_ERROR } from '../../../internal/language/error-messages.ts';
import { normalizeFilter } from '../../../internal/language/filter-normalize.ts';
import {
  type DomainQueryRequest,
  type EntityName,
  type FilterExpression,
  type Leaf,
  type LeafFilter,
  type Op,
  RANK_SCORE_KEY,
  RANK_SNIPPET_KEY,
  type SimGteLeaf,
  type SimTopkLeaf,
  type Sort,
  type TextMatchDescriptor,
} from '../../../internal/language/types.ts';
import type { EavContext, FieldMap } from '../eav/field-map.ts';
import { coercionCategory, valueColumnForDataType } from '../eav/mapping.ts';
import { columnDataType } from '../registry/introspect.ts';
import { registry } from '../registry/registry.ts';
import { buildComputedExpr } from './computed.ts';

// camelCase helper — Drizzle column refs are camelCase; YAML/JSON uses snake_case.
function camel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

// Resolve a dotted path against a starting entity. Returns either a direct
// column reference (with any JOIN clauses needed) or a has_many subquery
// descriptor.
type Join = { table: PgTable; on: SQL };

type ColumnResolution = {
  kind: 'column';
  column: PgColumn;
  joins: Join[];
  // For EAV value columns: the field-definition data_type, so the leaf value is
  // coerced by the field's logical type rather than the storage column's
  // (numeric stores as a JS string, so the column can't tell us).
  coerceAs?: string;
};

type EavExprResolution = {
  // EAV Shape B (jsonb): the value is a cast SQL expression, not a column.
  // Ops compile against the expression via compileLeafOpExpr.
  kind: 'eav_expr';
  expr: SQL;
  joins: Join[];
  coerceAs: string;
};

type ComputedResolution = {
  // Computed metric — a self-contained correlated aggregate subquery. Carries no
  // joins of its own (it correlates to the entity's pk); any `joins` are the
  // belongs_to hops taken to REACH the entity. Rides the eav_expr op path.
  kind: 'computed';
  // Comparable form (raw aggregate) — used in WHERE / ORDER BY.
  expr: SQL;
  // Display form (ISO-8601 text for datetime aggregates) — used in projection.
  // Same as `expr` for count/number metrics.
  displayExpr: SQL;
  joins: Join[];
  coerceAs: string;
};

type PathResolution =
  | ColumnResolution
  | EavExprResolution
  | ComputedResolution
  | {
      kind: 'has_many';
      target: PgTable; // the child/junction table — FROM of the EXISTS
      fkColumn: PgColumn; // child.fk back to parent
      parentPkColumn: PgColumn; // parent.pk
      // The op target INSIDE the EXISTS, plus any belongs_to joins from the child
      // onward (e.g. opportunity_contacts → contacts → contacts.email). Lets a
      // has_many be followed by a belongs_to chain, not just a single child column.
      inner: ColumnResolution | EavExprResolution | ComputedResolution;
    };

// jsonb value → typed SQL expression for Shape B. `value` stores the scalar as
// jsonb; `#>> '{}'` extracts it as text, then we cast per the field's data_type.
function jsonbValueExpr(valueCol: PgColumn, dataType: string): SQL {
  switch (coercionCategory(dataType)) {
    case 'number':
      return sql`(${valueCol} #>> '{}')::numeric`;
    case 'boolean':
      return sql`(${valueCol} #>> '{}')::boolean`;
    case 'date':
      return sql`(${valueCol} #>> '{}')::timestamptz`;
    default: // string / text / picklist / reference / …
      return sql`${valueCol} #>> '{}'`;
  }
}

function resolvePath(ctx: CompileContext, dotted: string): PathResolution {
  return resolveFrom(ctx, ctx.rootEntity, dotted.split('.'));
}

// Resolve a dotted path from an arbitrary entity. Recurses through a has_many:
// the has_many becomes a correlated EXISTS, and the REMAINDER of the path is
// resolved rooted at the child (belongs_to chain) and emitted as joins inside
// that EXISTS — so `opp.opportunity_contacts.contact.email` compiles, not just
// `opp.opportunity_contacts.role`. A has_many must still be the first collection
// hop (belongs_to → has_many is not correlatable here); no has_many → has_many.
function resolveFrom(
  ctx: CompileContext,
  startEntity: EntityName,
  segments: string[],
): PathResolution {
  let currentEntity = startEntity;
  const joins: Join[] = [];

  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const desc = registry[currentEntity];
    const rel = desc.relationships[seg];
    if (!rel) {
      throw new Error(
        `${ENGINE_ERROR.FIELD_PATH} '${segments.join('.')}' invalid at segment '${seg}' on entity '${currentEntity}'`,
      );
    }
    if (rel.kind === 'has_many') {
      if (joins.length > 0) {
        // belongs_to hops preceded this has_many — the EXISTS can't correlate to
        // an intermediate joined table. (Root the query on the child instead.)
        throw new Error(
          `belongs_to → has_many is ${ENGINE_ERROR.UNSUPPORTED_IN_PATH} '${segments.join('.')}'`,
        );
      }
      const childDesc = registry[rel.target];
      const fkCol = (childDesc.columns as Record<string, PgColumn>)[camel(rel.fk)];
      const parentPkCol = (desc.columns as Record<string, PgColumn>)[desc.primaryKey];
      if (!fkCol || !parentPkCol) {
        throw new Error(`has_many subquery resolution failed for '${segments.join('.')}'`);
      }
      // Resolve the tail (a belongs_to chain) rooted at the child; its joins ride
      // inside the EXISTS. `select 1 from child <joins> where child.fk = parent.pk and <op>`.
      const inner = resolveFrom(ctx, rel.target, segments.slice(i + 1));
      if (inner.kind === 'has_many') {
        throw new Error(
          `has_many → has_many is ${ENGINE_ERROR.UNSUPPORTED_IN_PATH} '${segments.join('.')}'`,
        );
      }
      return {
        kind: 'has_many',
        target: childDesc.table,
        fkColumn: fkCol,
        parentPkColumn: parentPkCol,
        inner,
      };
    }
    // to-one (belongs_to / has_one) — add LEFT JOIN and advance. belongs_to joins
    // source.fk = target.pk; has_one (fk on the target) joins target.fk = source.pk.
    // Both are 1:1, so the join never fans the root rows.
    const targetDesc = registry[rel.target];
    const srcCols = desc.columns as Record<string, PgColumn>;
    const tgtCols = targetDesc.columns as Record<string, PgColumn>;
    const [left, right] =
      rel.kind === 'belongs_to'
        ? [srcCols[camel(rel.fk)], tgtCols[targetDesc.primaryKey]]
        : [srcCols[desc.primaryKey], tgtCols[camel(rel.fk)]];
    if (!left || !right) {
      throw new Error(`${rel.kind} resolution failed for '${seg}' on '${currentEntity}'`);
    }
    joins.push({ table: targetDesc.table, on: eq(left, right) });
    currentEntity = rel.target;
  }

  // Final segment. A native entity-row column wins over a same-keyed EAV
  // field: native columns are complete (every row) and org-visible, while the
  // EAV mirror of a native key is sparse and actor-scoped — resolving e.g.
  // accounts.name through the mirror silently missed every row without a
  // mirror entry for the requesting user (D1, 2026-06-11). Keys with no native
  // column (dealstage, amount, industry, …) resolve through the field map: a
  // value column behind a LEFT JOIN to field_values whose unique
  // (entity_id, entity_type, field_definition_id) constraint keeps the join
  // single-row, so it behaves exactly like a real nullable column downstream.
  const finalSeg = segments[segments.length - 1];
  const finalDesc = registry[currentEntity];

  const nativeCol = (finalDesc.columns as Record<string, PgColumn>)[camel(finalSeg)];
  if (nativeCol) {
    return { kind: 'column', column: nativeCol, joins };
  }

  // Computed metric — a correlated aggregate subquery over a relationship.
  // Self-contained (correlates to this entity's pk); `joins` carry only the
  // belongs_to hops taken to reach this entity. Comparable expr for filter/sort,
  // display expr (ISO-8601 for datetime) for projection.
  const computedSpec = finalDesc.computed?.find((c) => c.key === finalSeg);
  if (computedSpec) {
    return {
      kind: 'computed',
      expr: buildComputedExpr(currentEntity, computedSpec),
      displayExpr: buildComputedExpr(currentEntity, computedSpec, { display: true }),
      joins,
      coerceAs: computedSpec.type,
    };
  }

  if (finalDesc.eav) {
    const field = ctx.fieldMaps[currentEntity]?.get(finalSeg);
    if (field) {
      const strat = finalDesc.eav;
      const aliasName = `fv_${currentEntity}_${finalSeg}`.replace(/[^a-zA-Z0-9_]/g, '_');
      let aliased = ctx.eavAliases.get(aliasName);
      if (!aliased) {
        aliased = alias(strat.valueTable, aliasName);
        ctx.eavAliases.set(aliasName, aliased);
      }
      const a = aliased as unknown as Record<string, PgColumn>;
      const parentPk = (finalDesc.columns as Record<string, PgColumn>)[finalDesc.primaryKey];

      // Join predicate: parent ↔ value row for THIS field. For Shape B with
      // inline temporal, restrict to the current value (valid_to IS NULL) so
      // the join stays single-row (the virtual-column invariant).
      const predicates: SQL[] = [
        eq(a.entityId, parentPk),
        eq(a.entityType, strat.entityTypeValue),
        eq(a.fieldDefinitionId, field.fieldDefinitionId),
      ];
      if (strat.kind === 'jsonb-value' && strat.currentOnly) {
        predicates.push(isNull(a[strat.validToColumn]));
      }
      // NB: predicates is non-empty here; drizzle and() only returns undefined for an empty arg list
      joins.push({ table: aliased, on: and(...predicates)! });

      if (strat.kind === 'typed-columns') {
        // Shape A — value lives in a typed column; rides the column op path.
        return {
          kind: 'column',
          column: a[valueColumnForDataType(field.dataType)],
          joins,
          coerceAs: field.dataType,
        };
      }
      // Shape B — value is a jsonb cast expression; rides the eav_expr path.
      return {
        kind: 'eav_expr',
        expr: jsonbValueExpr(a[strat.valueColumn], field.dataType),
        joins,
        coerceAs: field.dataType,
      };
    }
  }

  throw new Error(
    `${ENGINE_ERROR.FIELD_PATH} '${segments.join('.')}' invalid at final column '${finalSeg}' on entity '${currentEntity}'`,
  );
}

// Parse a datetime filter value anchored to UTC. JS `new Date()` parses a bare
// datetime string ('2026-06-02 20:00:13', no zone suffix) as MACHINE-LOCAL,
// which silently shifted filter bounds by the server's UTC offset (D2,
// 2026-06-11). Stored timestamps are UTC, so bare inputs must be too: append
// 'Z' when no explicit zone is present. Date-only strings ('2026-06-02') and
// zone-suffixed strings already parse as UTC and pass through.
function parseDateUtc(value: string | number): Date {
  if (typeof value === 'number') return new Date(value);
  const s = value.trim();
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (hasZone || dateOnly) return new Date(s);
  return new Date(`${s.replace(' ', 'T')}Z`);
}

// Coerce a JSON value into the runtime type Drizzle expects for `col`.
//
// JSON has no native Date/bigint shape, so callers send dates as ISO strings,
// integers as integers, etc. The registry knows what each column's TypeScript
// type should be (via Drizzle's `.dataType` introspection): if we don't coerce,
// pg sends the raw string parameter and Postgres throws on type-mismatched
// comparisons (e.g. `timestamp > text`).
//
// Coercion is per-element so `in`/`nin`/`between` work transparently — pass
// an array/tuple and we coerce each entry against the same column.
//
// Already-coerced values (Date object, number, boolean) flow through unchanged.
function coerceForColumn(col: PgColumn, value: unknown, coerceAs?: string): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => coerceForColumn(col, v, coerceAs));

  // Drizzle exposes the TS-level type via .dataType (normalized by columnDataType):
  // PgTimestamp is 'date'; PgInteger is 'number'; PgBoolean is 'boolean';
  // PgText / PgVarchar / pgEnum are 'string'; etc.
  //
  // For EAV value columns the storage column lies (numeric → 'string'), so the
  // field-definition data_type is the authority — coerceAs carries it.
  const dt = coerceAs ? coercionCategory(coerceAs) : columnDataType(col);

  if (dt === 'date') {
    if (value instanceof Date) return value;
    if (typeof value === 'string' || typeof value === 'number') {
      const d = parseDateUtc(value);
      if (Number.isNaN(d.getTime())) {
        throw new Error(
          `Invalid date value for column '${(col as unknown as { name?: string }).name}': ${JSON.stringify(value)}`,
        );
      }
      return d;
    }
    return value;
  }
  if (dt === 'number') {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Number(value);
    }
    return value;
  }
  if (dt === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const v = value.toLowerCase();
      if (v === 'true' || v === '1') return true;
      if (v === 'false' || v === '0') return false;
    }
    if (typeof value === 'number') return value !== 0;
    return value;
  }
  // string / json / array / unknown — pass through. Postgres will coerce or
  // throw with a meaningful message; we don't second-guess.
  return value;
}

// ILIKE-family ops are only meaningful on string-typed fields. On a numeric /
// date / boolean field they compiled to `ilike(numeric_col, …)`, which Postgres
// rejects at execution — surfacing as a 500 that leaked the generated SQL (D4,
// 2026-06-11). Reject at compile time with a `filter:`-prefixed message so the
// nest classifier maps it to a 400. `matches` stays allowed everywhere — it
// casts `::text` explicitly.
const ILIKE_OPS: ReadonlySet<Op> = new Set(['contains', 'startswith', 'endswith'] as Op[]);

function assertTextOpTarget(op: Op, category: string | undefined, fieldLabel: string): void {
  if (!ILIKE_OPS.has(op)) return;
  if (category === 'number' || category === 'date' || category === 'boolean') {
    throw new Error(
      `${ENGINE_ERROR.FILTER} op '${op}' requires a text field; '${fieldLabel}' is ${category}`,
    );
  }
}

// Lower a crisp sim_gte leaf → (1 - (embedding <=> query_vector)) >= threshold (invariant #1:
// the vector is a BOUND string param the driver binds, ::vector is a fixed cast keyword, the
// threshold is bound — never sql.raw of caller data). `target` is the already-resolved embedding
// column / expr (crispify rewrote `on` to the embedding column, so resolvePath yields it). The
// EXACT similarity formula at the rank path (simExpr, ~line 779): similarity in [0,1].
function compileSimGte(target: SQL | PgColumn, leaf: SimGteLeaf): SQL {
  const vecLit = `[${leaf.vector.join(',')}]`;
  return sql`(1 - (${target} <=> ${vecLit}::vector)) >= ${leaf.threshold}`;
}

function compileLeafOp(
  col: PgColumn,
  op: Op | 'sim_gte',
  rawValue: unknown,
  coerceAs?: string,
  sim?: SimGteLeaf,
): SQL {
  // Vector-distance primitive: the embedding column is `col` (crispify rewrote `on` to it),
  // so the cross-grain EXISTS inner reuses this op impl with the child-resolved column.
  if (op === 'sim_gte') return compileSimGte(col, sim!);
  assertTextOpTarget(op, coerceAs ? coercionCategory(coerceAs) : columnDataType(col), col.name);
  // Coerce once at the boundary. All subsequent op handlers see the right type.
  const value = coerceForColumn(col, rawValue, coerceAs);
  switch (op) {
    case 'eq':
      return eq(col, value as never);
    case 'neq':
      return ne(col, value as never);
    case 'in':
      return inArray(col, value as never[]);
    case 'nin':
      return notInArray(col, value as never[]);
    case 'gt':
      return gt(col, value as never);
    case 'gte':
      return gte(col, value as never);
    case 'lt':
      return lt(col, value as never);
    case 'lte':
      return lte(col, value as never);
    case 'between': {
      const [lo, hi] = value as [unknown, unknown];
      return and(gte(col, lo as never), lte(col, hi as never)) as SQL;
    }
    // String-typed ops — never coerce, ILIKE always wants a string pattern.
    case 'contains':
      return ilike(col, `%${rawValue}%`);
    case 'startswith':
      return ilike(col, `${rawValue}%`);
    case 'endswith':
      return ilike(col, `%${rawValue}`);
    // FTS boolean match (stemmed). `::text` cast keeps it safe on non-text columns.
    case 'matches':
      return sql`to_tsvector('english', ${col}::text) @@ websearch_to_tsquery('english', ${String(rawValue)})`;
    case 'is_null':
      return isNull(col);
    case 'is_not_null':
      return isNotNull(col);
    default:
      throw new Error(`Unknown op: ${op}`);
  }
}

// Coerce a JSON leaf value by the field's data_type, for the expression path
// (no column to introspect). Mirror of coerceForColumn's per-category logic.
function coerceForExpr(value: unknown, coerceAs: string): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => coerceForExpr(v, coerceAs));
  const cat = coercionCategory(coerceAs);
  if (cat === 'date') {
    if (value instanceof Date) return value;
    const d = parseDateUtc(value as string | number);
    return Number.isNaN(d.getTime()) ? value : d;
  }
  if (cat === 'number') {
    if (typeof value === 'number') return value;
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (cat === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 1 || value === '1') return true;
    if (value === 'false' || value === 0 || value === '0') return false;
  }
  return value;
}

// Compile a leaf op against an arbitrary SQL value EXPRESSION (EAV Shape B —
// jsonb cast). Parallel to compileLeafOp, which targets a PgColumn. The LEFT
// JOIN means an absent current value reads as NULL, so semantics match a
// nullable column.
function compileLeafOpExpr(
  expr: SQL,
  op: Op | 'sim_gte',
  rawValue: unknown,
  coerceAs: string,
  sim?: SimGteLeaf,
): SQL {
  // Vector-distance primitive over an arbitrary SQL value expression (EAV / dotted target).
  if (op === 'sim_gte') return compileSimGte(expr, sim!);
  assertTextOpTarget(op, coercionCategory(coerceAs), coerceAs);
  const v = coerceForExpr(rawValue, coerceAs);
  switch (op) {
    case 'eq':
      return sql`${expr} = ${v}`;
    case 'neq':
      return sql`${expr} <> ${v}`;
    case 'gt':
      return sql`${expr} > ${v}`;
    case 'gte':
      return sql`${expr} >= ${v}`;
    case 'lt':
      return sql`${expr} < ${v}`;
    case 'lte':
      return sql`${expr} <= ${v}`;
    case 'between': {
      const [lo, hi] = v as [unknown, unknown];
      return sql`${expr} between ${lo} and ${hi}`;
    }
    case 'in':
    case 'nin': {
      const arr = (v as unknown[]) ?? [];
      if (arr.length === 0) return op === 'in' ? sql`false` : sql`true`;
      const list = sql.join(
        arr.map((x) => sql`${x}`),
        sql`, `,
      );
      return op === 'in' ? sql`${expr} in (${list})` : sql`${expr} not in (${list})`;
    }
    // Text ops never coerce — ILIKE wants the raw string pattern.
    case 'contains':
      return sql`${expr} ilike ${`%${rawValue}%`}`;
    case 'startswith':
      return sql`${expr} ilike ${`${rawValue}%`}`;
    case 'endswith':
      return sql`${expr} ilike ${`%${rawValue}`}`;
    // FTS boolean match (stemmed). `::text` cast keeps it safe on non-text exprs.
    case 'matches':
      return sql`to_tsvector('english', ${expr}::text) @@ websearch_to_tsquery('english', ${String(rawValue)})`;
    case 'is_null':
      return sql`${expr} is null`;
    case 'is_not_null':
      return sql`${expr} is not null`;
    default:
      throw new Error(`Unknown op: ${op}`);
  }
}

interface CompileContext {
  rootEntity: EntityName;
  joins: { table: PgTable; on: SQL }[]; // accumulated as the tree is walked
  joinKeys: Set<string>; // dedupe by table name
  textMatches: TextMatchDescriptor[]; // direct-column text-op hits (for snippet extraction)
  textMatchKeys: Set<string>; // dedupe by column|op|pattern
  fieldMaps: Partial<Record<EntityName, FieldMap>>; // actor-scoped EAV field maps
  eavAliases: Map<string, PgTable>; // aliasName → aliased field_values, deduped per field
}

function pushJoin(ctx: CompileContext, j: { table: PgTable; on: SQL }): void {
  const key = getTableName(j.table);
  if (ctx.joinKeys.has(key)) return;
  ctx.joinKeys.add(key);
  ctx.joins.push(j);
}

// Text ops whose matches we can snippet at runtime. has_many subqueries are
// excluded — those matches live on a child row not present in the parent preview.
const TEXT_OPS = new Set<Op>(['contains', 'startswith', 'endswith']);

function pushTextMatch(ctx: CompileContext, column: string, op: Op, pattern: unknown): void {
  if (!TEXT_OPS.has(op)) return;
  if (typeof pattern !== 'string' || pattern.length === 0) return;
  const key = `${column}|${op}|${pattern}`;
  if (ctx.textMatchKeys.has(key)) return;
  ctx.textMatchKeys.add(key);
  ctx.textMatches.push({
    column,
    op: op as TextMatchDescriptor['op'],
    pattern,
  });
}

function compileLeaf(ctx: CompileContext, leaf: Leaf): SQL {
  // Wave-2: a crisp sim_gte leaf carries vector/threshold (not a value); `on` is the
  // embedding column (crispify rewrote it), so resolvePath yields it / the cross-grain
  // has_many EXISTS exactly like a value leaf. sim_topk is a ranked-CTE membership test
  // lowered elsewhere (step 6) — never reaches this value-op leaf path.
  const sim = leaf.op === 'sim_gte' ? leaf : undefined;
  const op = leaf.op as Op | 'sim_gte';
  const value = 'value' in leaf ? leaf.value : undefined;
  const resolved = resolvePath(ctx, leaf.on);
  if (resolved.kind === 'column') {
    for (const j of resolved.joins) pushJoin(ctx, j);
    // Only track text matches that land on a column of the ROOT entity (no joins).
    // Joined-column text matches (e.g. opportunity.account.name on a transcript root)
    // could be snippeted from the join output, but for v1 we keep it simple and
    // restrict snippets to the root entity's own columns.
    if (resolved.joins.length === 0 && TEXT_OPS.has(op as Op)) {
      // Extract camelCase column name from the Drizzle column ref.
      // Drizzle exposes the column's name via the `.name` property.
      const colName = (resolved.column as unknown as { name?: string }).name;
      if (colName) {
        // colName is snake_case from the DB; convert to camelCase for the row key.
        const camelName = colName.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
        pushTextMatch(ctx, camelName, op as Op, value);
      }
    }
    return compileLeafOp(resolved.column, op, value, resolved.coerceAs, sim);
  }
  if (resolved.kind === 'eav_expr' || resolved.kind === 'computed') {
    // Expression-backed field: EAV Shape B jsonb cast (behind a LEFT JOIN) or a
    // computed aggregate subquery (self-contained). Both compile ops against the
    // SQL expression, coerced by the field's logical type.
    for (const j of resolved.joins) pushJoin(ctx, j);
    return compileLeafOpExpr(resolved.expr, op, value, resolved.coerceAs, sim);
  }
  // has_many → EXISTS (SELECT 1 FROM child <inner belongs_to joins> WHERE
  // child.fk = parent.pk AND <op on the inner target>). Drizzle's exists() helper
  // doesn't paren raw sql templates, so emit the whole EXISTS clause directly.
  const inner = resolved.inner;
  const innerCondition =
    inner.kind === 'column'
      ? compileLeafOp(inner.column, op, value, inner.coerceAs, sim)
      : compileLeafOpExpr(inner.expr, op, value, inner.coerceAs, sim);
  const innerJoins = inner.joins.length
    ? sql.join(
        inner.joins.map((j) => sql` inner join ${j.table} on ${j.on}`),
        sql``,
      )
    : sql``;
  return sql`exists (select 1 from ${resolved.target}${innerJoins} where ${eq(resolved.fkColumn, resolved.parentPkColumn)} and ${innerCondition})`;
}

function compileExpression(ctx: CompileContext, expr: FilterExpression): SQL {
  if ('and' in expr) {
    const parts = expr.and.map((e) => compileExpression(ctx, e));
    return and(...parts) as SQL;
  }
  if ('or' in expr) {
    const parts = expr.or.map((e) => compileExpression(ctx, e));
    return or(...parts) as SQL;
  }
  if ('not' in expr) {
    return not(compileExpression(ctx, expr.not));
  }
  return compileLeaf(ctx, expr as Leaf);
}

// ── sim_topk (Wave-2, step 6) — ranked MEMBERSHIP cohort on the query/fetch path ───────────────
// sim_topk is a ranked-CTE MEMBERSHIP test, not a boolean WHERE leaf: an inline subquery that
// ranks the SEMANTIC entity by similarity and keeps the k most-relevant pks, consumed as
// `pk in (select pk from cohort …)` (same-grain) or the has_many EXISTS shell with inner
// `child.pk in (…)` (cross-grain) — NEVER a fan-inducing JOIN to a non-unique key (invariant #2).
// The cohort body folds the SAME sibling predicates as the outer query (the scope leaf rides as
// an AND-sibling), so the cohort ranks over the scoped population BEFORE the LIMIT (invariant #3 —
// no scope-leak-via-ranking). pk ASC = deterministic cutoff tiebreak (NEVER SELECT DISTINCT over
// the vector(1536) column — OOM guardrail). similarity = 1-(emb<=>vec::vector), the EXACT simExpr.

// Split a top-level filter into its sim_topk leaves + the boolean-only remainder. sim_topk is
// RESTRICTED to the top level / under `and` (REJECT under `or`/`not` — a ranked cohort membership
// has no grain-safe negation/disjunction; `threshold`/sim_gte IS fine there). `rest` is the same
// tree with the sim_topk leaves removed (an empty AND collapses to undefined).
function splitSimTopk(expr: FilterExpression): {
  topk: SimTopkLeaf[];
  rest: FilterExpression | undefined;
} {
  const assertNoTopk = (e: FilterExpression): void => {
    if ('and' in e) {
      for (const c of e.and) assertNoTopk(c);
      return;
    }
    if ('or' in e) {
      for (const c of e.or) assertNoTopk(c);
      return;
    }
    if ('not' in e) {
      assertNoTopk(e.not);
      return;
    }
    if ((e as Leaf).op === 'sim_topk') {
      throw new Error(
        `${ENGINE_ERROR.FILTER} a relevance top_k leaf is only allowed at the top level or under \`and\` — not under \`or\`/\`not\` (a ranked cohort membership has no grain-safe negation/disjunction; use \`threshold\` there)`,
      );
    }
  };
  // Only a top-level AND (or a top-level bare leaf) may carry sim_topk; anything under or/not is
  // rejected by assertNoTopk. Recurse only through top-level ANDs.
  if ('and' in expr) {
    const topk: SimTopkLeaf[] = [];
    const keep: FilterExpression[] = [];
    for (const child of expr.and) {
      if (!('and' in child) && !('or' in child) && !('not' in child)) {
        const leaf = child as Leaf;
        if (leaf.op === 'sim_topk') {
          topk.push(leaf as SimTopkLeaf);
          continue;
        }
        keep.push(child);
        continue;
      }
      if ('and' in child) {
        const nested = splitSimTopk(child);
        topk.push(...nested.topk);
        if (nested.rest) keep.push(nested.rest);
        continue;
      }
      // or/not subtree — must not contain sim_topk.
      assertNoTopk(child);
      keep.push(child);
    }
    const rest = keep.length === 0 ? undefined : keep.length === 1 ? keep[0] : { and: keep };
    return { topk, rest };
  }
  if (!('or' in expr) && !('not' in expr) && (expr as Leaf).op === 'sim_topk') {
    return { topk: [expr as SimTopkLeaf], rest: undefined };
  }
  assertNoTopk(expr);
  return { topk: [], rest: expr };
}

// Lower ONE sim_topk leaf → a ranked membership condition. `restWhere` is the compiled outer
// remainder (scope + sibling filters) re-applied inside the SAME-GRAIN cohort body so the cohort
// ranks over the scoped population. The semantic entity is resolved by resolvePath: a local column
// (bare `on`) → same-grain (rank the root); a has_many path (dotted `on`) → cross-grain (the
// EXISTS shell over the child, ranking children globally — ruling (a): no group_by/per → GLOBAL).
function compileSimTopk(ctx: CompileContext, leaf: SimTopkLeaf, restWhere: SQL | undefined): SQL {
  const vecLit = `[${leaf.vector.join(',')}]`;
  const k = Number(leaf.top_k);
  // The partition key (`per`) → per-group top-k via row_number(); else GLOBAL top-k.
  const resolved = resolvePath(ctx, leaf.on);

  if (resolved.kind === 'column' && resolved.joins.length === 0) {
    // SAME-GRAIN: rank the ROOT entity. The cohort body re-applies the outer remainder (scope +
    // siblings) so the LIMIT cuts the scoped population (#3). pk ASC = deterministic cutoff.
    const desc = registry[ctx.rootEntity];
    const pk = (desc.columns as Record<string, PgColumn>)[desc.primaryKey];
    const sim = sql`(1 - (${resolved.column} <=> ${vecLit}::vector))`;
    const whereClause = restWhere ? sql` where ${restWhere}` : sql``;
    if (leaf.per) {
      // PER-GROUP: top-k within each partition; NULL partition keys dropped (a NULL FK can't be
      // "top-k within its group"). row_number() OVER (PARTITION BY key ORDER BY sim desc, pk asc).
      const partRes = resolvePath(ctx, leaf.per);
      if (partRes.kind === 'has_many') {
        throw new Error(`${ENGINE_ERROR.FILTER} relevance top_k 'per' cannot be a has_many path`);
      }
      const partExpr = partRes.kind === 'column' ? sql`${partRes.column}` : partRes.expr;
      const notNull = sql`${partExpr} is not null`;
      const innerWhere = restWhere
        ? sql` where ${restWhere} and ${notNull}`
        : sql` where ${notNull}`;
      const rn = sql`row_number() over (partition by ${partExpr} order by ${sim} desc, ${pk} asc)`;
      return sql`${pk} in (select pk from (select ${pk} as pk, ${rn} as rn from ${desc.table}${innerWhere}) ranked_cohort where rn <= ${k})`;
    }
    return sql`${pk} in (select ${pk} from ${desc.table}${whereClause} order by ${sim} desc, ${pk} asc limit ${k})`;
  }

  if (resolved.kind === 'has_many') {
    // CROSS-GRAIN: the semantic entity is a has_many child. GLOBAL cohort (no group_by/per on the
    // query path → ruling (a)): the EXISTS shell tests whether THIS parent has a child in the
    // globally-ranked top-k. The embedding lives on the child (resolvePath pointed `inner` at it);
    // membership keys on the CHILD pk. Child-local scope only (the outer remainder addresses the
    // parent, not the child) — the cross-grain query path's best-effort scope.
    const child = resolved;
    const embExpr = child.inner.kind === 'column' ? sql`${child.inner.column}` : child.inner.expr;
    const childEntity = getChildEntity(ctx, leaf.on);
    const cdesc = registry[childEntity];
    const childPk = (cdesc.columns as Record<string, PgColumn>)[cdesc.primaryKey];
    const sim = sql`(1 - (${embExpr} <=> ${vecLit}::vector))`;
    const cohort = sql`select ${childPk} from ${child.target} order by ${sim} desc, ${childPk} asc limit ${k}`;
    return sql`exists (select 1 from ${child.target} where ${eq(child.fkColumn, child.parentPkColumn)} and ${childPk} in (${cohort}))`;
  }

  throw new Error(
    `${ENGINE_ERROR.FILTER} relevance top_k on '${leaf.on}' does not resolve to a rankable column`,
  );
}

// The child entity a dotted relevance `on` (has_many path) targets — the first hop's target
// entity. Mirrors resolveFrom's has_many resolution.
function getChildEntity(ctx: CompileContext, on: string): EntityName {
  const segs = on.split('.');
  const rel = registry[ctx.rootEntity].relationships[segs[0]!];
  if (!rel) throw new Error(`${ENGINE_ERROR.FILTER} relevance 'on' path '${on}' is not a relation`);
  return rel.target;
}

function compileSort(ctx: CompileContext, sort: Sort): SQLWrapper {
  const resolved = resolvePath(ctx, sort.field);
  if (resolved.kind === 'has_many') {
    throw new Error(`Cannot sort by has_many path: ${sort.field}`);
  }
  for (const j of resolved.joins) pushJoin(ctx, j);
  // DESC carries explicit NULLS LAST: Postgres defaults DESC to nulls-first,
  // which buried every valued row under the null-valued ones on sparse
  // EAV-backed sorts like amount (D3, 2026-06-11). ASC is nulls-last by
  // default and stays untouched.
  if (resolved.kind === 'eav_expr' || resolved.kind === 'computed') {
    return sort.dir === 'desc' ? sql`${resolved.expr} desc nulls last` : sql`${resolved.expr} asc`;
  }
  return sort.dir === 'desc' ? sql`${resolved.column} desc nulls last` : asc(resolved.column);
}

// Alias of the window row-number in the partitioned (per-group top-K) SELECT. Runner-internal:
// used to filter `_rn <= perLimit` on the wrapped subquery, then stripped from response rows.
export const PARTITION_RN_KEY = '_rn';

export interface CompiledQuery {
  rootTable: PgTable;
  joins: { table: PgTable; on: SQL }[];
  where: SQL | undefined;
  orderBy: SQLWrapper[];
  limit: number;
  offset: number;
  // Per-group top-K (rank_by.partition_by). When set, the runner wraps the SELECT in a
  // subquery with `rowNumber` (ROW_NUMBER() OVER (PARTITION BY key ORDER BY score DESC) AS
  // _rn) and keeps rows where _rn <= perLimit, ordered by (partition key, _rn). `key` is the
  // request field name — also guaranteed present in `projection` so rows carry their group.
  // `keyExpr` is the resolved partition-column SQL — the runner counts DISTINCT over it so
  // `total` reports the number of GROUPS (not the pre-window candidate count).
  partition?: {
    key: string;
    keyExpr: SQL;
    rowNumber: SQL.Aliased;
    perLimit: number;
  };
  // Direct-column text-op leaves collected during compile. The runtime uses
  // these to (a) ensure the matched column is in the preview SELECT and
  // (b) extract a snippet around each match per row.
  textMatches: TextMatchDescriptor[];
  // LEFT JOINs needed ONLY to surface the projected fields (not the filter) —
  // the belongs_to hop for a dotted column, or the field_values join for an EAV
  // field. Kept separate from `joins` so the COUNT query stays minimal — these
  // apply to the projecting SELECT only. Deduped against filter joins.
  previewJoins: { table: PgTable; on: SQL }[];
  // Compiler-resolved SELECT columns for the projected fields, keyed by the
  // requested field key. Carries native columns (PgColumn), EAV Shape A value
  // columns (PgColumn), and EAV Shape B jsonb casts (aliased SQL) alike — NOT
  // just EAV. In default preview this holds only the curated EAV preview fields
  // (native preview columns come from catalogPreview); when the caller projects
  // explicit `columns` it holds every requested field. has_many is excluded.
  projection: Record<string, PgColumn | SQL.Aliased>;
  // Extra SELECT expressions contributed by `rank_by` (the `_rank` score and,
  // for lexical, the `_snippet` ts_headline). Added to preview-row SELECTs only.
  rankSelect: Record<string, SQL.Aliased>;
  // Window-measure SELECT expressions: agg(col) OVER (PARTITION BY …) AS alias.
  // Injected into preview SELECTs only — rows preserved, no GROUP BY. Empty when
  // no window is requested (so the runner's loop is a no-op without a null check).
  windowSelect: Record<string, SQL.Aliased>;
  // Non-fatal advisories surfaced to the caller (e.g. sort ignored because
  // rank_by owns ordering, or min_score uncalibrated for lexical ranking).
  warnings: string[];
}

// Rewrite any `{on: 'text', op, value}` leaves in a filter tree into an OR
// across the root entity's declared searchableColumns. Each searchable column
// becomes a sibling leaf with the same op + value, then the engine compiles
// them normally (including has_many fan-out for dotted paths like 'chunks.body').
//
// If an entity declares zero searchable columns and the filter uses 'text',
// we throw — the caller asked for something the entity doesn't support.
function expandTextMagic(rootEntity: EntityName, expr: FilterExpression): FilterExpression {
  if ('and' in expr) {
    return { and: expr.and.map((e) => expandTextMagic(rootEntity, e)) };
  }
  if ('or' in expr) {
    return { or: expr.or.map((e) => expandTextMagic(rootEntity, e)) };
  }
  if ('not' in expr) {
    return { not: expandTextMagic(rootEntity, expr.not) };
  }
  // Leaf
  const leaf = expr as LeafFilter;
  if (leaf.on !== 'text') return leaf;
  const cols = registry[rootEntity].searchableColumns;
  if (!cols || cols.length === 0) {
    throw new Error(
      `Entity '${rootEntity}' has no searchable columns; cannot resolve 'text' filter`,
    );
  }
  if (cols.length === 1) {
    return { on: cols[0], op: leaf.op, value: leaf.value };
  }
  return {
    or: cols.map((col) => ({ on: col, op: leaf.op, value: leaf.value })),
  };
}

export function compile(
  req: DomainQueryRequest,
  eav?: EavContext,
  // Fields to project into the SELECT beyond the primary key, each resolved like
  // a filter `on:` (native / EAV / belongs_to dotted; has_many is skipped).
  // Default preview passes the curated EAV preview keys; explicit projection
  // passes the caller's `columns`. See CompiledQuery.projection.
  projectFields?: string[],
): CompiledQuery {
  const desc = registry[req.entity];
  if (!desc) throw new Error(`${ENGINE_ERROR.UNKNOWN_ENTITY}${req.entity}`);

  const ctx: CompileContext = {
    rootEntity: req.entity,
    joins: [],
    joinKeys: new Set(),
    textMatches: [],
    textMatchKeys: new Set(),
    fieldMaps: eav?.fieldMaps ?? {},
    eavAliases: new Map(),
  };

  // Normalize the natural (Mongo/Prisma-style) or legacy {on,op,value} filter input into the
  // canonical AST before any compilation. Single front-door translation; everything below this
  // line works on the canonical shape only.
  const normalized = req.filter ? normalizeFilter(req.filter) : undefined;
  const expanded = normalized ? expandTextMagic(req.entity, normalized) : undefined;
  // Split out sim_topk leaves (ranked-CTE membership, NOT boolean WHERE leaves; rejected under
  // or/not). The remainder (scope + value/sim_gte leaves) compiles normally AND is re-applied
  // inside each same-grain cohort body so the LIMIT cuts the SCOPED population (#3).
  const split = expanded ? splitSimTopk(expanded) : { topk: [], rest: undefined };
  const restWhere = split.rest ? compileExpression(ctx, split.rest) : undefined;
  const topkConds = split.topk.map((leaf) => compileSimTopk(ctx, leaf, restWhere));
  const where = topkConds.length > 0 ? (and(restWhere, ...topkConds) as SQL) : restWhere;
  const orderBy = (req.sort ?? []).map((s) => compileSort(ctx, s));

  // Resolve each projected field through the SAME machinery as filters (so a
  // join is deduped if the field is also filtered). Their joins go into
  // previewJoins (SELECT-only); their resolved columns into `projection`, keyed
  // by the requested field key. has_many can't be a scalar column → skipped.
  const previewJoins: { table: PgTable; on: SQL }[] = [];
  const projection: Record<string, PgColumn | SQL.Aliased> = {};
  for (const f of projectFields ?? []) {
    const resolved = resolvePath(ctx, f);
    if (resolved.kind === 'has_many') continue;
    for (const j of resolved.joins) {
      const key = getTableName(j.table);
      if (ctx.joinKeys.has(key)) continue; // already joined for the filter/sort
      ctx.joinKeys.add(key);
      previewJoins.push(j);
    }
    // Native / Shape A → column; Shape B → cast expr; computed → display form
    // (ISO-8601 for datetime aggregates). Row key = f.
    projection[f] =
      resolved.kind === 'computed'
        ? resolved.displayExpr.as(f)
        : resolved.kind === 'eav_expr'
          ? resolved.expr.as(f)
          : resolved.column;
  }

  // rank_by — a ranking method over one text column. Owns ordering + limit when
  // present (any `sort` is ignored, with a warning). `lexical` = FTS ts_rank_cd;
  // `semantic` is Rung 2 (needs an injected embed() port + a registered
  // embedding column), guarded here for now.
  const warnings: string[] = [];
  const rankSelect: Record<string, SQL.Aliased> = {};
  const windowSelect: Record<string, SQL.Aliased> = {};
  let finalOrderBy = orderBy;
  let finalWhere = where;
  let finalLimit = req.page?.limit ?? 25;
  let partition: CompiledQuery['partition'];
  // The ranking score expression (similarity / ts_rank) — captured so partition_by can window
  // over it (ROW_NUMBER() ... ORDER BY score DESC).
  let scoreExpr: SQL | undefined;
  if (req.rankBy) {
    const rb = req.rankBy;
    finalLimit = rb.limit ?? finalLimit;
    if ((req.sort ?? []).length > 0) {
      warnings.push('sort ignored: rank_by owns ordering');
    }
    if (rb.method === 'semantic') {
      // semantic: cosine similarity against the entity's embedding column. The
      // service resolved the query vector + column (req.rankSemantic) — compile
      // stays sync. `<=>` is pgvector cosine distance (matches the column's
      // vector_cosine_ops index); 1 - distance = similarity in [0,1].
      const sem = req.rankSemantic;
      if (!sem) {
        throw new Error(`${ENGINE_ERROR.RANK} semantic ranking is not configured`);
      }
      const embCol = (desc.columns as Record<string, PgColumn>)[camel(sem.embeddingColumn)];
      if (!embCol) {
        throw new Error(
          `${ENGINE_ERROR.RANK} no embedding column '${sem.embeddingColumn}' on '${req.entity}'`,
        );
      }
      const vecLit = `[${sem.vector.join(',')}]`;
      const simExpr = sql`(1 - (${embCol} <=> ${vecLit}::vector))`;
      scoreExpr = simExpr;
      finalOrderBy = [sql`${simExpr} desc`];
      rankSelect[RANK_SCORE_KEY] = simExpr.as(RANK_SCORE_KEY);
      // No `_snippet` for semantic — there is no keyword to headline.
      if (typeof rb.min_score === 'number') {
        // cosine similarity IS calibrated (0..1) — a real threshold, no warning.
        const cutoff = sql`${simExpr} >= ${rb.min_score}`;
        finalWhere = finalWhere ? and(finalWhere, cutoff) : cutoff;
      }
    } else {
      // lexical (FTS): rank by ts_rank_cd, snippet via ts_headline. Ranking uses
      // OR semantics (partial matches should still rank) — plainto normalizes +
      // sanitizes the query, then we swap its implicit AND (`&`) for OR (`|`).
      // (The `matches` filter op keeps websearch AND semantics — precision is
      // right for filtering; recall is right for ranking.)
      // `on` is defaulted by the service for the common case; if it's still missing here the
      // entity had no single default column — surface a clear error rather than rank on nothing.
      if (!rb.on) {
        throw new Error(`${ENGINE_ERROR.RANK} lexical rank_by requires "on"`);
      }
      const resolved = resolvePath(ctx, rb.on);
      if (resolved.kind === 'has_many') {
        throw new Error(`${ENGINE_ERROR.RANK} cannot rank_by a has_many path: ${rb.on}`);
      }
      for (const j of resolved.joins) pushJoin(ctx, j);
      const colExpr: SQL = resolved.kind === 'column' ? sql`${resolved.column}` : resolved.expr;
      if (typeof rb.query !== 'string' || rb.query.trim() === '') {
        throw new Error(`${ENGINE_ERROR.RANK} lexical rank_by requires query text`);
      }
      const tsq = sql`replace(plainto_tsquery('english', ${rb.query})::text, ' & ', ' | ')::tsquery`;
      const rankExpr = sql`ts_rank_cd(to_tsvector('english', ${colExpr}::text), ${tsq})`;
      scoreExpr = rankExpr;
      finalOrderBy = [sql`${rankExpr} desc`];
      rankSelect[RANK_SCORE_KEY] = rankExpr.as(RANK_SCORE_KEY);
      rankSelect[RANK_SNIPPET_KEY] =
        sql`ts_headline('english', ${colExpr}::text, ${tsq}, 'MaxFragments=2, MaxWords=18, MinWords=6')`.as(
          RANK_SNIPPET_KEY,
        );
      if (typeof rb.min_score === 'number') {
        const cutoff = sql`${rankExpr} >= ${rb.min_score}`;
        finalWhere = finalWhere ? and(finalWhere, cutoff) : cutoff;
        warnings.push(
          'min_score is uncalibrated for lexical ranking (ts_rank scores are not normalized); prefer limit',
        );
      }
    }

    // partition_by — per-group top-K (the window primitive). Keep the best `limit` rows WITHIN
    // each group instead of overall: ROW_NUMBER() OVER (PARTITION BY <field> ORDER BY score
    // DESC) <= limit. The runner wraps the SELECT in a subquery and filters on the row number;
    // here we resolve the partition field, build the window expression, and re-scope `limit`
    // (per-group, not flat).
    if (rb.partition_by) {
      const part = resolvePath(ctx, rb.partition_by);
      if (part.kind === 'has_many') {
        throw new Error(
          `${ENGINE_ERROR.RANK} cannot partition_by a has_many path: ${rb.partition_by}`,
        );
      }
      for (const j of part.joins) pushJoin(ctx, j);
      const partExpr: SQL = part.kind === 'column' ? sql`${part.column}` : part.expr;
      // Exclude rows whose partition key is NULL: SQL collapses all NULLs into one phantom
      // "group", so a null-keyed row can't meaningfully be "top-K within its group". Dropping
      // them keeps the result to real groups (e.g. real accounts, not the account-less lump).
      const notNull = sql`${partExpr} is not null`;
      finalWhere = finalWhere ? and(finalWhere, notNull) : notNull;
      // scoreExpr is always set when rankBy is present (both method branches assign it).
      const rn = sql`row_number() over (partition by ${partExpr} order by ${scoreExpr} desc)`;
      partition = {
        key: rb.partition_by,
        keyExpr: partExpr,
        rowNumber: rn.as(PARTITION_RN_KEY),
        perLimit: rb.limit ?? 5,
      };
      // Partitioned: rb.limit means per-group K, so the flat LIMIT reverts to the page bound
      // (or a generous cap — e.g. 69 accounts × top 5 = 345 rows is a normal result).
      finalLimit = req.page?.limit ?? 500;
      // Project the partition field so every returned row says which group it belongs to —
      // without it the consumer can't reassemble the groups.
      if (!(rb.partition_by in projection)) {
        projection[rb.partition_by] =
          part.kind === 'column' ? part.column : part.expr.as(rb.partition_by);
      }
    }
  }

  // Window measures — agg(col) OVER (PARTITION BY <partCols>) projected onto preview
  // rows (grain preserved, no GROUP BY). Reuses resolvePath for the on/partition
  // columns (native + EAV) and the same OVER plumbing as rank_by.partition_by above.
  for (const wm of req.window ?? []) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(wm.as)) {
      throw new Error(`${ENGINE_ERROR.RANK} window: unsafe alias '${wm.as}'`);
    }
    let aggExpr: SQL;
    if (wm.on === '*') {
      aggExpr = sql.raw('*');
    } else {
      const onRes = resolvePath(ctx, wm.on);
      if (onRes.kind === 'has_many') {
        throw new Error(`${ENGINE_ERROR.RANK} window: cannot aggregate a has_many path: ${wm.on}`);
      }
      for (const j of onRes.joins) pushJoin(ctx, j);
      aggExpr = onRes.kind === 'column' ? sql`${onRes.column}` : onRes.expr;
    }
    const partExprs: SQL[] = [];
    for (const pb of wm.partition_by) {
      const pbRes = resolvePath(ctx, pb);
      if (pbRes.kind === 'has_many') {
        throw new Error(`${ENGINE_ERROR.RANK} window: cannot partition_by a has_many path: ${pb}`);
      }
      for (const j of pbRes.joins) pushJoin(ctx, j);
      partExprs.push(pbRes.kind === 'column' ? sql`${pbRes.column}` : pbRes.expr);
    }
    const partClause = partExprs.length ? sql`partition by ${sql.join(partExprs, sql`, `)}` : sql``;
    let core: SQL;
    switch (wm.agg) {
      case 'count':
        core = wm.on === '*' ? sql`count(*)` : sql`count(${aggExpr})`;
        break;
      case 'count_distinct':
        core = sql`count(distinct ${aggExpr})`;
        break;
      default:
        core = sql`${sql.raw(wm.agg)}(${aggExpr})`;
    }
    windowSelect[wm.as] = sql`${core} over (${partClause})`.as(wm.as);
  }

  return {
    rootTable: desc.table,
    joins: ctx.joins,
    where: finalWhere,
    orderBy: finalOrderBy,
    limit: finalLimit,
    offset: req.page?.offset ?? 0,
    partition,
    textMatches: ctx.textMatches,
    previewJoins,
    projection,
    rankSelect,
    windowSelect,
    warnings,
  };
}
