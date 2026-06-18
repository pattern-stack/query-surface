// Drizzle-native aggregate compiler — BUILDER-based (no raw SQL construction).
// Per-source pre-agg CTEs are built with db.$with()/db.with(); joins with
// .leftJoin()/.fullJoin(); EAV tables via alias(); aggregates/coalesce as `sql`
// templates over COLUMN OBJECTS (escaped) + bound params. The only `sql.raw` uses
// are fixed operators/keywords (=, asc/desc, in) — never caller strings. Identifiers
// go through column objects or sql.identifier; values are always bound params.

import { type SQL, and, eq, getTableColumns, getTableName, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { type PgColumn, type PgTable, alias } from 'drizzle-orm/pg-core';
import { ENGINE_ERROR } from '../error-messages';
import { groupKeyColumns, measureSource, planAggregate } from './grain';
import { resolveJoinPlan } from './join-plan';
import type { DealbrainModel } from './model.dealbrain';
import { TENANT_GLOBAL } from './types';
import type {
  Agg,
  AggColType,
  Aggregate,
  AggregatePlan,
  Measure,
  Predicate,
  ScopeFor,
} from './types';

// biome-ignore lint/suspicious/noExplicitAny: Drizzle's query-builder + WithSubquery types don't survive dynamic join chains / dynamic select shapes; the package uses `any` accumulators here (see runners.ts).
type Db = NodePgDatabase<any>;
// A compiled, runnable query: awaitable to rows + serializable for include_sql.
export type AggQuery = { toSQL(): { sql: string; params: unknown[] } } & PromiseLike<
  Record<string, unknown>[]
>;

const IDENT = /^[a-z_][a-z0-9_]*$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const BINOP: Record<string, string> = {
  eq: '=',
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};
const assertIdent = (n: string) => {
  if (!IDENT.test(n)) throw new Error(`${ENGINE_ERROR.AGGREGATE} unsafe identifier: ${n}`);
  return n;
};

// Aggs whose value over zero input rows is conventionally 0 (so an absent group's
// leg coalesces to 0). avg/min/max over no rows are undefined → stay NULL.
const ZERO_ON_EMPTY = new Set<Agg>(['sum', 'count', 'count_distinct']);

interface Resolved {
  expr: SQL;
  type: AggColType;
}
type Resolver = (path: string) => Resolved;

// Native column → a `sql` wrapping the COLUMN OBJECT (Drizzle qualifies + escapes),
// with JSON dotted paths lowered to ->> over bound path segments. No raw strings.
function nativeColSql(model: DealbrainModel, entity: string, path: string): Resolved {
  const [head, ...rest] = path.split('.');
  const col = model.colByDbName[entity]?.[head!];
  if (!col) throw new Error(`${ENGINE_ERROR.AGGREGATE} unknown column "${head}" on ${entity}`);
  const type = model.analytics[entity]?.fields[head!]?.type ?? 'string';
  if (type === 'json' && rest.length > 0) {
    let e = sql`${col}`;
    rest.forEach((seg, i) => {
      e = i === rest.length - 1 ? sql`(${e} ->> ${seg})` : sql`(${e} -> ${seg})`;
    });
    return { expr: e, type: 'string' };
  }
  return { expr: sql`${col}`, type };
}

// Apply a leaf op to an already-resolved value expression. Operators are fixed keywords
// (sql.raw of a constant); VALUES are bound params; `expr` is a column object / safe SQL.
// Shared by compilePredicateSql (local: scope/having/measure.where) AND the graph-aware
// source-filter compiler (local / to-one-joined / semijoin-inner legs) — one op impl.
export function applyLeafOp(expr: SQL, type: AggColType, op: string, value: unknown): SQL {
  switch (op) {
    case 'is_null':
      return sql`${expr} is null`;
    case 'is_not_null':
      return sql`${expr} is not null`;
    case 'in':
    case 'nin': {
      const arr = (Array.isArray(value) ? value : [value]) as unknown[];
      // Empty set: `x in ()` is a Postgres syntax error. Resolve the degenerate case
      // by truth value — empty IN matches nothing, empty NOT IN matches everything.
      if (arr.length === 0) return op === 'nin' ? sql`true` : sql`false`;
      return sql`${expr} ${sql.raw(op === 'nin' ? 'not in' : 'in')} (${sql.join(
        arr.map((v) => sql`${v}`),
        sql`, `,
      )})`;
    }
    case 'between': {
      const [lo, hi] = (Array.isArray(value) ? value : [value, value]) as [unknown, unknown];
      return sql`${expr} between ${lo} and ${hi}`;
    }
    case 'contains':
      return sql`${expr} ilike ${`%${String(value)}%`}`;
    case 'startswith':
      return sql`${expr} ilike ${`${String(value)}%`}`;
    case 'endswith':
      return sql`${expr} ilike ${`%${String(value)}`}`;
    case 'matches':
      return sql`to_tsvector('english', ${expr}) @@ websearch_to_tsquery('english', ${value})`;
    case 'eq':
    case 'neq':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (type === 'datetime' && typeof value === 'string' && DATE_ONLY.test(value)) {
        const d = value;
        switch (op) {
          case 'eq':
            return sql`(${expr} >= ${d}::date and ${expr} < (${d}::date + interval '1 day'))`;
          case 'neq':
            return sql`not (${expr} >= ${d}::date and ${expr} < (${d}::date + interval '1 day'))`;
          case 'lte':
            return sql`${expr} < (${d}::date + interval '1 day')`;
          case 'lt':
            return sql`${expr} < ${d}::date`;
          case 'gt':
            return sql`${expr} >= (${d}::date + interval '1 day')`;
          case 'gte':
            return sql`${expr} >= ${d}::date`;
        }
      }
      return sql`${expr} ${sql.raw(BINOP[op]!)} ${value}`;
    }
    default:
      throw new Error(`${ENGINE_ERROR.AGGREGATE} unsupported op ${String(op)}`);
  }
}

// Predicate → SQL via a column resolver (LOCAL columns only: scope, having, measure.where).
// Boolean composition here; leaf ops via applyLeafOp. The graph-aware q.filter path uses
// compileSourceFilter instead (it resolves dotted paths to joins/semijoins per leaf).
function compilePredicateSql(resolve: Resolver, pred: Predicate): SQL {
  if ('and' in pred)
    return sql`(${sql.join(
      pred.and.map((p) => compilePredicateSql(resolve, p)),
      sql` and `,
    )})`;
  if ('or' in pred)
    return sql`(${sql.join(
      pred.or.map((p) => compilePredicateSql(resolve, p)),
      sql` or `,
    )})`;
  if ('not' in pred) return sql`(not ${compilePredicateSql(resolve, pred.not)})`;
  const { expr, type } = resolve(pred.on);
  return applyLeafOp(expr, type, pred.op, pred.value);
}

// Aggregate function as a fixed switch — no sql.raw(agg). An unknown agg throws
// (closes the agg-name gap: the function name can never be caller-interpolated).
function aggCore(agg: Agg, valExpr: SQL, isStar: boolean): SQL {
  switch (agg) {
    case 'count':
      return isStar ? sql`count(*)` : sql`count(${valExpr})`;
    case 'count_distinct':
      return sql`count(distinct ${valExpr})`;
    case 'sum':
      return sql`sum(${valExpr})`;
    case 'avg':
      return sql`avg(${valExpr})`;
    case 'min':
      return sql`min(${valExpr})`;
    case 'max':
      return sql`max(${valExpr})`;
    default:
      throw new Error(`${ENGINE_ERROR.AGGREGATE} unsupported agg ${String(agg)}`);
  }
}

// The value expression a measure aggregates over, plus any EAV join it needs.
// EAV: alias(valueTable) + column OBJECTS (entity_id/field_definition_id/value_*),
// defId as a bound param — no raw table name, no raw qualified refs.
function measureValue(
  model: DealbrainModel,
  source: string,
  m: Measure,
  joins: Array<{ table: PgTable; on: SQL }>,
): { valExpr: SQL; isStar: boolean } {
  if (m.on === '*') return { valExpr: sql``, isStar: true };
  const head = m.on.split('.')[0]!;
  const field = model.analytics[source]?.fields[head];
  if (field?.eav) {
    const valueTable = model.registry[source]?.eav?.valueTable;
    if (!valueTable) {
      throw new Error(`${ENGINE_ERROR.AGGREGATE} no EAV value table registered for ${source}`);
    }
    const fv = alias(valueTable, `fv_${assertIdent(m.as)}`);
    const cols = Object.values(getTableColumns(fv)) as PgColumn[];
    const byName = (n: string): PgColumn => {
      const c = cols.find((col) => col.name === n);
      if (!c) throw new Error(`${ENGINE_ERROR.AGGREGATE} EAV column "${n}" missing on ${source}`);
      return c;
    };
    const pk = model.colByDbName[source]![model.analytics[source]!.pk]!;
    joins.push({
      table: fv,
      on: and(eq(byName('entity_id'), pk), eq(byName('field_definition_id'), field.eav.defId))!,
    });
    return { valExpr: sql`${byName(field.eav.valueColumn)}`, isStar: false };
  }
  return { valExpr: nativeColSql(model, source, m.on).expr, isStar: false };
}

// model.colByDbName lookup with a clear failure. fk/pk/column names come from the
// registry + the join-plan resolver — exact-match lookups, never interpolated.
function colObj(model: DealbrainModel, entity: string, name: string): PgColumn {
  const c = model.colByDbName[entity]?.[name];
  if (!c) throw new Error(`${ENGINE_ERROR.AGGREGATE} unknown column "${name}" on ${entity}`);
  return c;
}

// Per-entity tenancy scope as SQL (fail-closed). null = no scope (unscoped mode OR
// TENANT_GLOBAL). When a resolver IS supplied but has no answer for a queried/traversed
// entity, throw the coverage-gap error with NO `aggregate:` prefix → classified as an untyped
// 500 (opaque to the CLIENT; the server-side message names the entity for operator logs, not
// the caller). Reused for the source CTE, every to-one JOIN target, and every
// semijoin child — scope is non-bypassable across the WHOLE graph the query touches (the
// design-hardening proof: a value-predicate scope has no FK-tenant invariant behind it, so
// a join/semijoin to an unscoped parent/child would leak or fabricate membership).
function scopeSqlFor(model: DealbrainModel, entity: string, scopeFor?: ScopeFor): SQL | null {
  if (!scopeFor) return null;
  const decision = scopeFor(entity);
  if (decision === undefined) {
    throw new Error(
      `source "${entity}" has no tenancy scope and was not declared TENANT_GLOBAL — ` +
        'refusing to read it unscoped (server-side scope coverage gap).',
    );
  }
  if (decision === TENANT_GLOBAL) return null;
  return compilePredicateSql((p) => nativeColSql(model, entity, p), decision);
}

// Lower a to-one join plan → LEFT JOIN specs (scope folded into each ON) + the resolved
// column expr/type on the target. A belongs_to chain is 1:1 (FK→PK) so it cannot fan — the
// SAME single-row-join class as the EAV value join. Scope folds into the ON (not a WHERE):
// an out-of-scope parent yields NULL columns rather than dropping the (in-scope) child row.
function lowerToOne(
  model: DealbrainModel,
  hops: { from: string; to: string; fk: string; toPk: string }[],
  target: string,
  column: string,
  scopeFor?: ScopeFor,
): {
  joins: Array<{ table: PgTable; on: SQL }>;
  col: PgColumn | null;
  expr: SQL;
  type: AggColType;
} {
  const joins: Array<{ table: PgTable; on: SQL }> = [];
  for (const hop of hops) {
    let on: SQL = eq(colObj(model, hop.from, hop.fk), colObj(model, hop.to, hop.toPk));
    const scope = scopeSqlFor(model, hop.to, scopeFor);
    if (scope) on = and(on, scope)!;
    joins.push({ table: model.tables[hop.to]!, on });
  }
  const { expr, type } = nativeColSql(model, target, column);
  // The raw column object (plain column, no json path) so a group projection over it
  // CTE-qualifies in the multi-source outer join; null for a json subpath (expr only).
  const col = column.includes('.') ? null : colObj(model, target, column);
  return { joins, col, expr, type };
}

// Lower a has_many filter leaf → a correlated EXISTS semijoin: boolean, NEVER a fan-out
// join. The child TABLE OBJECT is named directly in FROM (Drizzle renders the real table
// name; no alias → no 42P01, the retrieval-path bug we must not clone). Native inner leg
// only (wave 1). Child scope ANDs into the EXISTS body — an unscoped child could FABRICATE
// cross-tenant membership (strictly worse than a leak).
function lowerSemijoin(
  model: DealbrainModel,
  source: string,
  child: string,
  fk: string,
  parentPk: string,
  column: string,
  op: string,
  value: unknown,
  scopeFor?: ScopeFor,
): SQL {
  const fkCol = colObj(model, child, fk);
  const parentPkCol = colObj(model, source, parentPk);
  const { expr, type } = nativeColSql(model, child, column);
  const inner = applyLeafOp(expr, type, op, value);
  const childScope = scopeSqlFor(model, child, scopeFor);
  const scopeClause = childScope ? sql` and ${childScope}` : sql``;
  return sql`exists (select 1 from ${model.tables[child]!} where ${eq(fkCol, parentPkCol)} and ${inner}${scopeClause})`;
}

// The GLOBAL q.filter compiled PER SOURCE, graph-aware + PER LEAF (replaces the old tree-level
// try/catch soft-drop — ADR-0024 §Decision.4 "no silent drops anywhere"). The run-drizzle guard
// has ALREADY proved every leaf resolves on EVERY compiled measure source (a non-conforming leaf
// is rejected there, never silently no-opped — see the guard), so here every leaf compiles to a
// real condition that means the SAME population on each source:
//   local → applyLeafOp on the source column · to-one → scope-folded LEFT JOIN + applyLeafOp on
//   the joined column · semijoin → EXISTS over the has_many child (scope folded inside).
// No cross-source `true` substitution exists (that was the Q6 landmine: it silently left a
// non-conforming measure unfiltered, fabricating cross-measure comparisons). A reject reaching
// here is a guard bug → fail closed, never a silent drop. and/or/not just compose real conditions.
function compileSourceFilter(
  model: DealbrainModel,
  source: string,
  pred: Predicate,
  joins: Array<{ table: PgTable; on: SQL }>,
  scopeFor?: ScopeFor,
): SQL {
  if ('and' in pred)
    return sql`(${sql.join(
      pred.and.map((p) => compileSourceFilter(model, source, p, joins, scopeFor)),
      sql` and `,
    )})`;
  if ('or' in pred)
    return sql`(${sql.join(
      pred.or.map((p) => compileSourceFilter(model, source, p, joins, scopeFor)),
      sql` or `,
    )})`;
  if ('not' in pred)
    return sql`(not ${compileSourceFilter(model, source, pred.not, joins, scopeFor)})`;
  const plan = resolveJoinPlan(model.analytics, source, pred.on, 'filter');
  switch (plan.kind) {
    case 'local': {
      // The guard proved this leaf resolves on every compiled source, so the column is present;
      // the check is defensive (an absent column → 400, NEVER a silent `true` no-op).
      if (!model.colByDbName[source]?.[plan.column.split('.')[0]!]) {
        throw new Error(`${ENGINE_ERROR.AGGREGATE} unknown column "${plan.column}" on ${source}`);
      }
      const { expr, type } = nativeColSql(model, source, plan.column);
      return applyLeafOp(expr, type, pred.op, pred.value);
    }
    case 'to-one': {
      const lowered = lowerToOne(model, plan.hops, plan.target, plan.column, scopeFor);
      for (const j of lowered.joins) joins.push(j);
      return applyLeafOp(lowered.expr, lowered.type, pred.op, pred.value);
    }
    case 'semijoin':
      return lowerSemijoin(
        model,
        source,
        plan.child,
        plan.fk,
        plan.parentPk,
        plan.column,
        pred.op,
        pred.value,
        scopeFor,
      );
    default: // reject — the guard rejects non-conforming leaves pre-compile; reaching here is a bug.
      throw new Error(`${ENGINE_ERROR.AGGREGATE} ${plan.reason}`);
  }
}

// Resolve a group_by dim → (alias, group/select expr, scope-folded joins). The conformed-
// dimension rule: a dim is groupable at this source's grain iff it is the source's own
// column (local) or to-one-reachable (belongs_to chain). A to-many / ambiguous / unreachable
// group dim is a caller error → HARD-THROW (aggregate: → 400), never a silent drop.
//
// The OUTPUT alias / row key is the dim string VERBATIM (`accounts.name`,
// `state_of_deal_status`) — uniform across every measure source, so the SELECT alias, the
// GROUP BY key, the FULL OUTER JOIN key, and order_by/having all agree. (A bare local dim
// keeps today's bare-column key.)
function lowerGroupDim(
  model: DealbrainModel,
  source: string,
  dim: string,
  scopeFor?: ScopeFor,
): { alias: string; col: PgColumn | null; expr: SQL; joins: Array<{ table: PgTable; on: SQL }> } {
  const plan = resolveJoinPlan(model.analytics, source, dim, 'group');
  if (plan.kind === 'reject') throw new Error(`${ENGINE_ERROR.AGGREGATE} ${plan.reason}`);
  const alias = dim;
  if (plan.kind === 'local') {
    const col = plan.column.includes('.') ? null : colObj(model, source, plan.column);
    const { expr } = nativeColSql(model, source, plan.column);
    return { alias, col, expr, joins: [] };
  }
  if (plan.kind !== 'to-one') {
    // group role never yields a semijoin (a to-many group dim rejects above) — defensive.
    throw new Error(
      `${ENGINE_ERROR.AGGREGATE} dimension "${dim}" cannot be grouped at ${source} grain`,
    );
  }
  const lowered = lowerToOne(model, plan.hops, plan.target, plan.column, scopeFor);
  return { alias, col: lowered.col, expr: lowered.expr, joins: lowered.joins };
}

// One source's pre-aggregated SELECT, built with the query builder. Group dims resolve
// through the conformed-dimension resolver (local column OR to-one belongs_to join);
// measures to aggregate exprs aliased by `as`. Returns the resolved group ALIASES (the
// output keys) so the multi-source join keys on them. Return type inferred (not AggQuery):
// the builder must keep its TypedQueryBuilder shape so db.$with().as() accepts it.
function sourceSelect(
  db: Db,
  model: DealbrainModel,
  q: Aggregate,
  source: string,
  measures: Measure[],
  scopeFor?: ScopeFor,
) {
  const table = model.tables[source]!;
  const joins: Array<{ table: PgTable; on: SQL }> = [];
  // biome-ignore lint/suspicious/noExplicitAny: dynamic select shape (group aliases + measure aliases) can't be statically typed.
  const shape: Record<string, any> = {};
  const groupAliases: string[] = [];
  const groupExprs: Array<SQL | PgColumn> = [];
  for (const dim of q.group_by ?? []) {
    const { alias, col, expr, joins: gj } = lowerGroupDim(model, source, dim, scopeFor);
    groupAliases.push(alias);
    // Prefer the raw COLUMN OBJECT in the projection + GROUP BY: Drizzle qualifies it
    // (`"t"."c" as "alias"`), so the CTE column proxy resolves CTE-qualified in the
    // multi-source outer join. An aliased sql-expr would render a BARE alias in the outer
    // refs → "column reference ambiguous" across CTEs. A json subpath has no single column
    // → fall back to the expr (single-source-safe).
    groupExprs.push(col ?? expr);
    shape[alias] = col ?? expr.as(alias);
    for (const j of gj) joins.push(j);
  }
  for (const m of measures) {
    assertIdent(m.as);
    const { valExpr, isStar } = measureValue(model, source, m, joins);
    // A measure's `where` is SOURCE-LOCAL by design: it filters THIS measure's own rows,
    // so a column not on this source is a caller error → HARD-THROW (aggregate: → 400).
    const filter = m.where
      ? compilePredicateSql((p) => nativeColSql(model, source, p), m.where)
      : null;
    const core = aggCore(m.agg, valExpr, isStar);
    shape[m.as] = (filter ? sql`${core} filter (where ${filter})` : core).as(m.as);
  }
  // WHERE = per-source scope (fail-closed) AND the graph-aware global filter. The filter is
  // compiled per LEAF (local / to-one-join / semijoin); to-one joins push into `joins`; a
  // legit cross-source leaf becomes `true` here. No silent tree-drop.
  const scopeSql = scopeSqlFor(model, source, scopeFor);
  const filterSql = q.filter ? compileSourceFilter(model, source, q.filter, joins, scopeFor) : null;
  const where =
    scopeSql && filterSql
      ? sql`(${scopeSql}) and (${filterSql})`
      : (scopeSql ?? filterSql ?? undefined);
  // Dedupe joins by table name — a group dim and a filter leaf may traverse the same to-one
  // target (identical JOIN). EAV joins use alias() so their names are distinct and survive.
  const seen = new Set<string>();
  const dedup: Array<{ table: PgTable; on: SQL }> = [];
  for (const j of joins) {
    const k = getTableName(j.table);
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(j);
  }
  // biome-ignore lint/suspicious/noExplicitAny: builder type narrows per chained .leftJoin; not statically typeable across a dynamic join list.
  let qb: any = db.select(shape).from(table);
  for (const j of dedup) qb = qb.leftJoin(j.table, j.on);
  if (where) qb = qb.where(where);
  if (groupExprs.length) qb = qb.groupBy(...groupExprs);
  return { qb, groupAliases };
}

// Multi-source: each measure source pre-aggregated in its OWN CTE, then FULL OUTER JOIN on
// the shared group-dim ALIASES, COALESCE'ing the key across CTEs. Every CTE produces the
// SAME conformed group-dim aliases — sourceSelect HARD-THROWS for any dim not conformed to a
// source's grain (the conformed-dimension intersection rule), so the join keys on the full
// key and no measure can be broadcast across a foreign cardinality. CTE refs are column
// OBJECTS from the WithSubquery — escaped by construction, never raw.
function multiSourceSelect(
  db: Db,
  model: DealbrainModel,
  q: Aggregate,
  plan: AggregatePlan,
  scopeFor?: ScopeFor,
): AggQuery {
  const ctes = plan.sources.map((s, i) => {
    const { qb, groupAliases } = sourceSelect(
      db,
      model,
      q,
      s,
      q.measures.filter((m) => measureSource(q, m) === s),
      scopeFor,
    );
    return {
      source: s,
      // biome-ignore lint/suspicious/noExplicitAny: WithSubquery columns are keyed dynamically by the inner select shape.
      cte: db.$with(`cte_${i}`).as(qb) as any,
      aliases: groupAliases,
    };
  });
  // Every CTE resolved the same group dims (or sourceSelect threw), so the alias sets match.
  const keyAliases = ctes[0]!.aliases;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic outer select shape over CTE columns.
  const shape: Record<string, any> = {};
  for (const a of keyAliases) {
    const present = ctes.map((ct) => ct.cte[a]);
    shape[a] = (
      present.length > 1 ? sql`coalesce(${sql.join(present, sql`, `)})` : sql`${present[0]}`
    ).as(a);
  }
  for (const m of q.measures) {
    const ci = plan.sources.indexOf(measureSource(q, m));
    shape[m.as] = sql`${ctes[ci]!.cte[m.as]}`.as(m.as);
  }
  // biome-ignore lint/suspicious/noExplicitAny: builder type narrows per chained .fullJoin.
  let qb: any = db
    .with(...ctes.map((c) => c.cte))
    .select(shape)
    .from(ctes[0]!.cte);
  for (let i = 1; i < ctes.length; i++) {
    const cond = keyAliases.length
      ? and(...keyAliases.map((a) => eq(ctes[0]!.cte[a], ctes[i]!.cte[a])))
      : sql`true`;
    qb = qb.fullJoin(ctes[i]!.cte, cond ?? sql`true`);
  }
  return qb as AggQuery;
}

// ORDER BY references output aliases (a measure alias or a projected group-key column)
// — Postgres binds select aliases in ORDER BY (unlike WHERE). Validate `on` against the
// known output set: anything else (a typo, a non-projected column, a dotted path) is a
// caller error → clean 400, never a raw "must appear in GROUP BY" 500. Membership in the
// set also means it's already a safe identifier; sql.identifier escapes it regardless.
// biome-ignore lint/suspicious/noExplicitAny: operates on the dynamic builder.
function applyOrderLimit(builder: any, q: Aggregate, outputAliases: Set<string>): AggQuery {
  let qb = builder;
  if (q.order_by?.length) {
    qb = qb.orderBy(
      ...q.order_by.map((o) => {
        if (!outputAliases.has(o.on)) {
          throw new Error(
            `${ENGINE_ERROR.AGGREGATE} order_by references unknown output "${o.on}" — expected a ` +
              'measure alias or a projected group_by column',
          );
        }
        return sql`${sql.identifier(o.on)} ${sql.raw(o.dir === 'desc' ? 'desc' : 'asc')} nulls last`;
      }),
    );
  }
  if (q.limit != null) qb = qb.limit(Number(q.limit));
  return qb as AggQuery;
}

// The columns the result projects: USER measure aliases (composite legs excluded — they
// aren't in the output) ∪ composite aliases ∪ the group-dim aliases (the group_by strings
// VERBATIM — conformed/joined dims are projected under their dotted alias, so they ARE
// orderable). The legal target set for order_by (so a ratio IS orderable, a leg is not).
function outputAliasSet(q: Aggregate): Set<string> {
  const groupCols = q.group_by ?? [];
  const legs = new Set((q.composites ?? []).flatMap((c) => [c.numerator, c.denominator]));
  const measures = q.measures.map((m) => m.as).filter((a) => !legs.has(a));
  const composites = (q.composites ?? []).map((c) => c.as);
  return new Set<string>([...groupCols, ...measures, ...composites]);
}

export interface CompiledDrizzle {
  query: AggQuery;
  groupCountQuery: AggQuery | null;
  plan: AggregatePlan;
}

export function compileGroupedDrizzle(
  db: Db,
  model: DealbrainModel,
  q: Aggregate,
  scopeFor?: ScopeFor,
): CompiledDrizzle {
  const plan = planAggregate(model.analytics, q);
  // Refuse a bogus root/source entity (the caller controls `entity` + each measure's
  // `source`): an unregistered name has no table → UNKNOWN_ENTITY (404), matching
  // search/fetch, AND can't slip past the scope check.
  for (const e of [q.entity, ...plan.sources]) {
    if (!model.tables[e]) throw new Error(`${ENGINE_ERROR.UNKNOWN_ENTITY}${e}`);
  }
  const grouped = (q.group_by?.length ?? 0) > 0;
  // Validate each group_by SEGMENT as a safe identifier (entity prefix + column), so a dotted
  // conformed dim passes while a hostile key is rejected (S9). Resolution itself is by
  // exact-match registry / colByDbName lookup — never interpolation.
  for (const dim of q.group_by ?? []) for (const seg of dim.split('.')) assertIdent(seg);

  // Group-dim aliases the grouped subquery projects (the dim strings VERBATIM). For
  // composites, the outer projection re-selects these from the grouped subquery.
  const projectedGroupCols = q.group_by ?? [];

  // A fresh grouped query (no order/limit) — built per call so the main query and the
  // group-count query don't share a mutable builder. When HAVING or composites are
  // present, wrap ONCE over the grouped subquery: the composite divisions are projected
  // (and the internal __cmp_ legs dropped from the output), and HAVING filters the
  // grouped aliases in the WHERE. A HAVING that names a composite alias resolves to
  // `undefined` here (the composite is computed in THIS select, not in the grouped sub)
  // → caught as an unknown-alias 400; composites stay non-filterable.
  const makeGrouped = (): AggQuery => {
    const groupedQ: AggQuery =
      plan.sources.length <= 1
        ? sourceSelect(db, model, q, plan.sources[0] ?? q.entity, q.measures, scopeFor).qb
        : multiSourceSelect(db, model, q, plan, scopeFor);
    const composites = q.composites ?? [];
    if (!q.having && composites.length === 0) return groupedQ;

    // biome-ignore lint/suspicious/noExplicitAny: subquery columns keyed dynamically by alias.
    const sub = (groupedQ as any).as('g');
    // The internal composite legs (__cmp_…) are NOT part of the output/filter contract:
    // excluded from the projection AND refused in HAVING (order_by already excludes them
    // via outputAliasSet) — so the reserved namespace never leaks as a public handle.
    const legs = new Set(composites.flatMap((c) => [c.numerator, c.denominator]));
    // biome-ignore lint/suspicious/noExplicitAny: dynamic projection shape.
    let wrapped: any;
    if (composites.length) {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic projection shape.
      const shape: Record<string, any> = {};
      for (const c of projectedGroupCols) shape[c] = sub[c];
      for (const m of q.measures) if (!legs.has(m.as)) shape[m.as] = sub[m.as];
      for (const comp of composites) {
        // NUMERATOR null-policy is agg-aware: a zero-on-empty agg (sum/count/count_distinct)
        // coalesces an absent group to 0 (genuinely 0); avg/min/max stay NULL (undefined,
        // not 0 → ratio NULL → counted into warnings). DENOMINATOR: absent OR genuine-zero
        // → NULLIF → NULL (never div-by-zero). `::numeric` forces true division — without
        // it two integer legs (count/count) would integer-truncate (5/2 → 2).
        const num = ZERO_ON_EMPTY.has(comp.numeratorAgg)
          ? sql`coalesce(${sub[comp.numerator]}, 0)`
          : sql`${sub[comp.numerator]}`;
        shape[comp.as] = sql`${num}::numeric / nullif(coalesce(${sub[comp.denominator]}, 0), 0)`.as(
          comp.as,
        );
      }
      wrapped = db.select(shape).from(sub);
    } else {
      wrapped = db.select().from(sub);
    }
    if (q.having) {
      wrapped = wrapped.where(
        compilePredicateSql((p) => {
          // A composite leg is internal — reject it on the filter surface (mirrors
          // order_by's outputAliasSet exclusion), even though it's a real subquery column.
          if (legs.has(p)) {
            throw new Error(
              `${ENGINE_ERROR.AGGREGATE} having references unknown measure/group alias "${p}"`,
            );
          }
          const col = sub[p];
          if (col === undefined) {
            throw new Error(
              `${ENGINE_ERROR.AGGREGATE} having references unknown measure/group alias "${p}"`,
            );
          }
          return { expr: sql`${col}`, type: 'number' };
        }, q.having),
      );
    }
    return wrapped as AggQuery;
  };

  const outputAliases = outputAliasSet(q);
  const query = applyOrderLimit(makeGrouped(), q, outputAliases);
  const groupCountQuery = grouped
    ? (db
        .select({ group_count: sql<number>`count(*)::int` })
        // biome-ignore lint/suspicious/noExplicitAny: subquery wrapper for the count.
        .from((makeGrouped() as any).as('g')) as AggQuery)
    : null;
  return { query, groupCountQuery, plan };
}

/** The WRONG single-pass root-join (builder), for eval contrast: fans out. */
export function compileNaiveDrizzle(db: Db, model: DealbrainModel, q: Aggregate): AggQuery {
  const root = q.entity;
  const joins: Array<{ table: PgTable; on: SQL }> = [];
  const joined = new Set<string>();
  const ensureChildJoin = (src: string) => {
    if (src === root || joined.has(src)) return;
    joined.add(src);
    const rel = Object.values(model.registry[root]!.relationships).find((r) => r.target === src)!;
    const on =
      rel.kind === 'has_many'
        ? eq(model.colByDbName[src]![rel.fk]!, model.colByDbName[root]!.id!)
        : eq(model.colByDbName[src]!.id!, model.colByDbName[root]![rel.fk]!);
    joins.push({ table: model.tables[src]!, on });
  };
  const groupCols = groupKeyColumns(q).filter((c) => model.colByDbName[root]?.[c]);
  // biome-ignore lint/suspicious/noExplicitAny: dynamic select shape.
  const shape: Record<string, any> = {};
  for (const c of groupCols) shape[c] = model.colByDbName[root]![c]!;
  for (const m of q.measures) {
    const src = measureSource(q, m);
    ensureChildJoin(src); // add the fan-inducing join even for count(*) measures
    let valExpr: SQL;
    let isStar = false;
    if (m.on === '*') {
      isStar = true;
      valExpr = sql``;
    } else {
      const field = model.analytics[src]?.fields[m.on.split('.')[0]!];
      if (field?.eav) {
        const valueTable = model.registry[src]?.eav?.valueTable;
        const fv = alias(valueTable!, `fv_${assertIdent(m.as)}`);
        const cols = Object.values(getTableColumns(fv)) as PgColumn[];
        const byName = (n: string) => cols.find((c) => c.name === n)!;
        joins.push({
          table: fv,
          on: and(
            eq(byName('entity_id'), model.colByDbName[src]!.id!),
            eq(byName('field_definition_id'), field.eav.defId),
          )!,
        });
        valExpr = sql`${byName(field.eav.valueColumn)}`;
      } else valExpr = sql`${model.colByDbName[src]![m.on.split('.')[0]!]!}`;
    }
    shape[m.as] = aggCore(m.agg, valExpr, isStar).as(m.as);
  }
  // biome-ignore lint/suspicious/noExplicitAny: builder narrows per chained .leftJoin.
  let qb: any = db.select(shape).from(model.tables[root]!);
  for (const j of joins) qb = qb.leftJoin(j.table, j.on);
  if (groupCols.length) qb = qb.groupBy(...groupCols.map((c) => model.colByDbName[root]![c]!));
  // The naive path is composite-agnostic (eval-only fan-out contrast): it projects every
  // measure (incl. any legs) as a plain column, so its order_by allow-set is group cols +
  // all measure aliases — strip composites so legs aren't excluded / composites included.
  return applyOrderLimit(
    qb,
    { ...q, having: undefined },
    outputAliasSet({ ...q, composites: undefined }),
  );
}
