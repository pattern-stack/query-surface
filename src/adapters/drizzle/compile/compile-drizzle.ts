// Drizzle-native aggregate compiler — BUILDER-based (no raw SQL construction).
// Per-source pre-agg CTEs are built with db.$with()/db.with(); joins with
// .leftJoin()/.fullJoin(); EAV tables via alias(); aggregates/coalesce as `sql`
// templates over COLUMN OBJECTS (escaped) + bound params. The only `sql.raw` uses
// are fixed operators/keywords (=, asc/desc, in) — never caller strings. Identifiers
// go through column objects or sql.identifier; values are always bound params.

import { type SQL, and, eq, getTableColumns, getTableName, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { type PgColumn, type PgTable, alias } from 'drizzle-orm/pg-core';
import {
  groupKeyColumns,
  measureField,
  measureSource,
  planAggregate,
} from '../../../internal/analytics/grain';
import { type JoinHop, resolveJoinPlan } from '../../../internal/analytics/join-plan';
import { TENANT_GLOBAL } from '../../../internal/analytics/types';
import type {
  Agg,
  AggColType,
  Aggregate,
  AggregatePlan,
  CompiledDerivedExpr,
  Measure,
  Predicate,
  RowExpr,
  ScopeFor,
} from '../../../internal/analytics/types';
import { ENGINE_ERROR } from '../../../internal/language/error-messages';
import { isIdentifier, toIdentifier } from '../../../internal/language/identifier';
import { isLeaf } from '../../../internal/language/types';
import type { Leaf, Op, SimTopkLeaf } from '../../../internal/language/types';
import type { AggregateModel } from '../registry/model';

// biome-ignore lint/suspicious/noExplicitAny: Drizzle's query-builder + WithSubquery types don't survive dynamic join chains / dynamic select shapes; the package uses `any` accumulators here (see runners.ts).
type Db = NodePgDatabase<any>;
// A compiled, runnable query: awaitable to rows + serializable for include_sql.
export type AggQuery = { toSQL(): { sql: string; params: unknown[] } } & PromiseLike<
  Record<string, unknown>[]
>;

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
  if (!isIdentifier(n)) throw new Error(`${ENGINE_ERROR.AGGREGATE} unsafe identifier: ${n}`);
  return n;
};

// Aggs whose value over zero input rows is conventionally 0 (so an absent group's
// leg coalesces to 0). avg/min/max over no rows are undefined → stay NULL.
const ZERO_ON_EMPTY = new Set<Agg>(['sum', 'count', 'count_distinct']);

// The closed 4-op set a derived composite may lower (invariant #1: operators are a fixed
// keyword set via sql.raw, NEVER a caller string).
const DERIVED_OP = new Set(['+', '-', '*', '/']);

// Lower a COMPILED derived AST (refs already = leg aliases on the grouped `sub`) into a
// numeric-safe Drizzle SQL fragment — OUTER-SELECT arithmetic over already-collapsed legs, so
// it adds ZERO fan (invariant #2), exactly like the ratio division. `legAgg` gives each leg's
// agg for the zero-on-empty NULL policy (sum/count/count_distinct coalesce an absent group to
// 0; avg/min/max stay NULL). A '/' RIGHT operand is wrapped in nullif(...,0) → div-by-zero
// impossible (mirrors the ratio denominator). ::numeric on each operand → integer legs don't
// integer-truncate on '/'. Operators lower via sql.raw over the FIXED closed set ONLY
// (invariant #1 — the same sanctioned fixed-keyword pattern as BINOP/in/asc-desc); refs lower
// to `sub[alias]` column objects; literals are bound params. NEVER a caller SQL string.
// biome-ignore lint/suspicious/noExplicitAny: `sub` is the dynamic grouped subquery (see makeGrouped's `.as('g')`); leg columns are keyed by alias exactly as the ratio path does.
function walkDerived(node: CompiledDerivedExpr, legAgg: Map<string, Agg>, sub: any): SQL {
  if ('lit' in node) return sql`${node.lit}`; // bound param
  if ('ref' in node) {
    const agg = legAgg.get(node.ref);
    return agg && ZERO_ON_EMPTY.has(agg)
      ? sql`coalesce(${sub[node.ref]}, 0)` // absent group → genuine 0
      : sql`${sub[node.ref]}`; // avg/min/max → stay NULL
  }
  if (!DERIVED_OP.has(node.op)) {
    throw new Error(`${ENGINE_ERROR.AGGREGATE} derived: unsupported operator "${node.op}"`);
  }
  // Cast each operand ::numeric BEFORE the nullif wrap, so a literal divisor resolves as
  // nullif($1::numeric, 0) — otherwise Postgres types the bound param to integer from the bare
  // `0` and a fractional divisor (e.g. `/ 2.5`) errors 22P02. (Casting a numeric expr again is a
  // no-op.) Integer legs stay non-truncating on '/'.
  const L = sql`${walkDerived(node.left, legAgg, sub)}::numeric`;
  let R = sql`${walkDerived(node.right, legAgg, sub)}::numeric`;
  if (node.op === '/') R = sql`nullif(${R}, 0)`; // guard the divisor → NULL, not div-by-zero
  return sql`(${L} ${sql.raw(node.op)} ${R})`;
}

interface Resolved {
  expr: SQL;
  type: AggColType;
}
type Resolver = (path: string) => Resolved;

// Native column → a `sql` wrapping the COLUMN OBJECT (Drizzle qualifies + escapes),
// with JSON dotted paths lowered to ->> over bound path segments. No raw strings.
function nativeColSql(model: AggregateModel, entity: string, path: string): Resolved {
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
    case 'sim_gte': {
      // Vector-distance primitive: (1 - (embedding <=> query_vector)) >= threshold. `expr` is
      // the resolved embedding column (crispify rewrote `on` to it). Invariant #1: the vector
      // is a BOUND string param the driver binds; ::vector is a fixed cast keyword; the
      // threshold is bound — never sql.raw of caller data. similarity in [0,1] (the EXACT
      // formula at compiler.ts simExpr). `value` carries { vector, threshold } (stamped by
      // valueLeaf — a sim_gte leaf has no scalar `.value`). This ONE impl lights up the local,
      // to-one-joined, and cross-grain EXISTS-inner legs together (its three callers).
      const { vector, threshold } = value as { vector: number[]; threshold: number };
      const vecLit = `[${vector.join(',')}]`;
      return sql`(1 - (${expr} <=> ${vecLit}::vector)) >= ${threshold}`;
    }
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
// Wave-2: a `relevant` leaf is crispified into sim_gte/sim_topk by normalize() BEFORE
// compile, and those sim leaves are lowered by the vector / ranked-CTE paths — never via
// applyLeafOp's value path. Reaching the value path with one is an internal error (fail
// loud, never read a missing `.value`). The vector lowering lands in the steps below.
function valueLeaf(leaf: Leaf): { op: Op | 'sim_gte'; value: unknown } {
  // sim_gte (Wave-2, step 5) is a crisp vector-distance leaf: it has no scalar `.value`, so
  // package its vector + threshold for applyLeafOp's sim_gte case. The same op impl lights up
  // local / to-one / cross-grain-EXISTS legs. `relevant` (uncrispified — normalize() crispifies
  // it BEFORE compile) and sim_topk (a ranked-CTE membership test lowered in step 6) must never
  // reach this value path → fail loud rather than read a missing `.value`.
  if (leaf.op === 'sim_gte') {
    return { op: 'sim_gte', value: { vector: leaf.vector, threshold: leaf.threshold } };
  }
  if (leaf.op === 'relevant' || leaf.op === 'sim_topk') {
    // `relevant` must be crispified BEFORE compile; sim_topk is a ranked-CTE MEMBERSHIP test
    // lowered by compileSourceFilter (the global-filter path) — NEVER the value path. Reaching
    // here means a sim_topk slipped into scope/having/measure.where (where it has no meaning) or
    // an uncrispified `relevant` survived → fail loud rather than read a missing `.value`.
    throw new Error(
      `${ENGINE_ERROR.AGGREGATE} relevance op '${leaf.op}' is not valid on this predicate surface (scope/having/measure.where) — a top_k cohort lives only on the global filter`,
    );
  }
  return { op: leaf.op, value: leaf.value };
}

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
  const { op, value } = valueLeaf(pred);
  return applyLeafOp(expr, type, op, value);
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

// The EAV value join — the ONE place the resolved-semantic-layer field_values join is built, shared
// by every verb that reads an EAV field (measure · group dim · filter). A 1:1 join keyed on
// (entity_id = source.pk AND field_definition_id = defId), exposing the typed value column; the
// caller supplies a unique alias (so multiple EAV refs in one statement don't collide) and decides
// how to use the result. Column OBJECTS + defId bound param — no raw table name / qualified refs.
// (This used to be copy-pasted per verb, and the FILTER verb was missed entirely — that was the gap.)
function eavValueJoin(
  model: AggregateModel,
  source: string,
  eav: { valueColumn: string; defId: string },
  aliasName: string,
): { valueCol: PgColumn; join: { table: PgTable; on: SQL } } {
  const valueTable = model.registry[source]?.eav?.valueTable;
  if (!valueTable) {
    throw new Error(`${ENGINE_ERROR.AGGREGATE} no EAV value table registered for ${source}`);
  }
  const fv = alias(valueTable, aliasName);
  const cols = Object.values(getTableColumns(fv)) as PgColumn[];
  const byName = (n: string): PgColumn => {
    const c = cols.find((col) => col.name === n);
    if (!c) throw new Error(`${ENGINE_ERROR.AGGREGATE} EAV column "${n}" missing on ${source}`);
    return c;
  };
  const pk = model.colByDbName[source]![model.analytics[source]!.pk]!;
  return {
    valueCol: byName(eav.valueColumn),
    join: {
      table: fv,
      on: and(eq(byName('entity_id'), pk), eq(byName('field_definition_id'), eav.defId))!,
    },
  };
}

// Lower a ROW-LEVEL expression (ADR-0029 D4) into a numeric-safe Drizzle SQL fragment over RAW
// source columns — PRE-aggregation (the opposite of walkDerived, which combines already-collapsed
// leg aliases). aggCore then wraps the WHOLE expr ONCE: sum(<expr>)/avg(<expr>)/… → still ONE pass,
// still a MEASURE (SUM(a·b) ≠ SUM(a)·SUM(b)). Each { col } leaf resolves to a NATIVE column object
// (nativeColSql) or pushes its OWN 1:1 EAV value join; { lit } is a BOUND param; { op } lowers via
// sql.raw over the FIXED closed 4-set ONLY (invariant #1) with ::numeric casts + a nullif('/'
// divisor) guard. The MULTI-EAV wrinkle: an expr can name >=2 EAV cols (Amount·Probability, both
// EAV) — each leaf gets a DISTINCT alias fv_<as>_<i> (the threaded `counter`) so two EAV joins don't
// collide; each is 1:1 (entity_id + field_definition_id), so N compose to 1:1 → NO fan (invariant #2).
function lowerRowExpr(
  model: AggregateModel,
  source: string,
  node: RowExpr,
  measureAs: string,
  joins: Array<{ table: PgTable; on: SQL }>,
  counter: { n: number },
  scopeFor?: ScopeFor,
): SQL {
  if ('lit' in node) return sql`${node.lit}`; // bound param — never sql.raw of caller data
  if ('col' in node) {
    // TO-ONE DOTTED REACH (ADR-0029 D4 follow-up): an EXPLICIT dotted `target.column` reached via a
    // SINGLE belongs_to (to-one) chain — compose the EXISTING, scope-folded lowerToOne (handles a
    // native OR EAV target col + folds the target's scope into the belongs_to ON). Each hop is 1:1 →
    // the leg cannot fan (invariant #2). Validation (validateMeasureDef) already rejected a
    // non-to-one reach at MODEL LOAD; this re-resolves defensively and THROWS rather than ever emit an
    // unsafe (fanning) leg. The EAV-via-to-one alias is fvt_<target>_<column> (lowerToOne) — distinct
    // from the bare-EAV fv_<as>_<i> scheme; the SAME target col twice dedups to one join by table
    // name. Missing operand (incl. an out-of-scope NULL parent) → coalesce to 0 (the bare-path policy).
    if (node.col.includes('.')) {
      const plan = resolveJoinPlan(model.analytics, source, node.col, 'filter');
      if (plan.kind !== 'to-one') {
        throw new Error(
          `${ENGINE_ERROR.AGGREGATE} expression measure: col "${node.col}" is not a to-one reach from "${source}" — refusing to emit a fanning leg (validation should have rejected this at model load)`,
        );
      }
      const lowered = lowerToOne(model, plan.hops, plan.target, plan.column, scopeFor);
      for (const j of lowered.joins) joins.push(j);
      return sql`coalesce(${lowered.expr}, 0)`; // missing/out-of-scope-NULL → 0, same as the bare path
    }
    const field = model.analytics[source]?.fields[node.col];
    // MISSING → 0 (the arithmetic identity), NEVER a dropped row. A NULL operand makes a per-row
    // expression NULL, and SUM silently SKIPS it — so `profit = sales_price − item_cost` over a deal
    // with no recorded cost would VANISH from the total instead of yielding sales_price. Coalescing
    // each leaf to 0 keeps the row and treats an absent measurement as zero; it also makes the
    // expression form coincide with the derived-metric form over ALL rows (SUM(a−b) ≡ SUM(a)−SUM(b)),
    // not just co-present ones. A host that wants "exclude rows missing X" uses a measure-level `where`.
    if (field?.eav) {
      const { valueCol, join } = eavValueJoin(
        model,
        source,
        field.eav,
        `fv_${measureAs}_${counter.n++}`, // DISTINCT alias per EAV leaf — no multi-EAV collision
      );
      joins.push(join);
      return sql`coalesce(${valueCol}, 0)`; // column OBJECT (Drizzle escapes) → missing EAV value = 0
    }
    return sql`coalesce(${nativeColSql(model, source, node.col).expr}, 0)`; // native; missing cell = 0
  }
  if (!DERIVED_OP.has(node.op)) {
    throw new Error(
      `${ENGINE_ERROR.AGGREGATE} expression measure: unsupported operator "${node.op}"`,
    );
  }
  const L = sql`${lowerRowExpr(model, source, node.left, measureAs, joins, counter, scopeFor)}::numeric`;
  let R = sql`${lowerRowExpr(model, source, node.right, measureAs, joins, counter, scopeFor)}::numeric`;
  if (node.op === '/') R = sql`nullif(${R}, 0)`; // guard divisor → NULL, not div-by-zero
  return sql`(${L} ${sql.raw(node.op)} ${R})`; // op via sql.raw over the FIXED 4-set ONLY
}

// The value expression a measure aggregates over, plus any EAV join it needs.
function measureValue(
  model: AggregateModel,
  source: string,
  m: Measure,
  joins: Array<{ table: PgTable; on: SQL }>,
  scopeFor?: ScopeFor,
): { valExpr: SQL; isStar: boolean } {
  if (m.on === '*') return { valExpr: sql``, isStar: true };
  // EXPRESSION measure (D4): an object `on` is a RowExpr → walk it into a composed pre-agg valExpr
  // (aggCore wraps it unchanged). Must win BEFORE measureField (which throws on an object). scopeFor
  // is threaded so a TO-ONE dotted col's belongs_to target scope folds into the join ON (lowerToOne).
  if (typeof m.on === 'object') {
    const counter = { n: 0 };
    return {
      valExpr: lowerRowExpr(model, source, m.on, assertIdent(m.as), joins, counter, scopeFor),
      isStar: false,
    };
  }
  const head = measureField(m); // field relative to source — strips the relation prefix of a dotted `on`
  const field = model.analytics[source]?.fields[head];
  if (field?.eav) {
    const { valueCol, join } = eavValueJoin(model, source, field.eav, `fv_${assertIdent(m.as)}`);
    joins.push(join);
    return { valExpr: sql`${valueCol}`, isStar: false };
  }
  return { valExpr: nativeColSql(model, source, head).expr, isStar: false };
}

// model.colByDbName lookup with a clear failure. fk/pk/column names come from the
// registry + the join-plan resolver — exact-match lookups, never interpolated.
function colObj(model: AggregateModel, entity: string, name: string): PgColumn {
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
function scopeSqlFor(model: AggregateModel, entity: string, scopeFor?: ScopeFor): SQL | null {
  if (!scopeFor) return null;
  const decision = scopeFor(entity);
  if (decision === undefined) {
    throw new Error(
      `source "${entity}" has no tenancy scope and was not declared TENANT_GLOBAL — refusing to read it unscoped (server-side scope coverage gap).`,
    );
  }
  if (decision === TENANT_GLOBAL) return null;
  return compilePredicateSql((p) => nativeColSql(model, entity, p), decision);
}

// Lower a to-one join plan → LEFT JOIN specs (scope folded into each ON) + the resolved
// column expr/type on the target. A to-one chain (belongs_to FK→PK / has_one PK←FK) is 1:1 so it cannot fan — the
// SAME single-row-join class as the EAV value join. Scope folds into the ON (not a WHERE):
// an out-of-scope parent yields NULL columns rather than dropping the (in-scope) child row.
function lowerToOne(
  model: AggregateModel,
  hops: JoinHop[],
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
    // belongs_to: from.fk = to.pk · has_one: from.pk = to.fk — both 1:1 (JoinHop fromCol/toCol).
    let on: SQL = eq(colObj(model, hop.from, hop.fromCol), colObj(model, hop.to, hop.toCol));
    const scope = scopeSqlFor(model, hop.to, scopeFor);
    if (scope) on = and(on, scope)!;
    joins.push({ table: model.tables[hop.to]!, on });
  }
  // EAV-DIM-VIA-TO-ONE (the resolved semantic layer reached THROUGH a belongs_to chain): the
  // target's dim is an EAV field (e.g. opportunities.stage→StageName), NOT a native column.
  // Compose the SAME shared 1:1 field_values join (eavValueJoin) AFTER the belongs_to LEFT
  // JOIN(s) — both joins are 1:1 (FK→PK ∘ entity_id=pk+field_definition_id=defId), so the
  // composite stays non-fanning + grain-safe (1:1∘1:1=1:1; no `rels` edge added, so the grain
  // oracle/doctor see the same topology). NB: the EAV leg's 1:1-ness rests on the SINGLE-VALUED-EAV
  // convention (≤1 field_values row per entity_id+field_definition_id) — the SAME assumption the
  // own-entity EAV dim/measure paths already make; it is NOT enforced by a DB UNIQUE (field_values
  // PK is just `id`). A multi-valued EAV field tagged role:'dimension' would fan here exactly as it
  // would on its own entity — an engine-wide hardening concern (guard single-valued at registration),
  // not specific to the to-one composition. Sits AFTER the scope-folded hop loop on purpose: the
  // final hop already folded the TARGET's scope into its belongs_to ON, so an uncovered
  // (non-TENANT_GLOBAL) target throws the coverage-gap at scopeSqlFor BEFORE we resolve the
  // value column. field_values is never tenant-bearing — its tenancy is inherited via
  // entity_id = the already-scoped target pk; an out-of-scope target → NULL pk → NULL dim
  // value (never a leak, never a dropped in-scope child). The alias is fvt_<target>_<column>
  // (unique per target+column, distinct from the own-entity fv_/fvg_/fvf_ prefixes) so ≥2
  // EAV-to-one dims in one statement get distinct field_values aliases. toIdentifier (sanitize)
  // NOT assertIdent: an EAV/host key may be PascalCase ('StageName'); the alias is internal.
  const targetField = model.analytics[target]?.fields[column];
  if (targetField?.eav) {
    const { valueCol, join } = eavValueJoin(
      model,
      target,
      targetField.eav,
      `fvt_${toIdentifier(target)}_${toIdentifier(column)}`,
    );
    joins.push(join);
    return { joins, col: valueCol, expr: sql`${valueCol}`, type: targetField.type ?? 'string' };
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
  model: AggregateModel,
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

// ── sim_topk — the ranked-CTE MEMBERSHIP cohort (Wave-2, step 6) ───────────────────────────
// sim_topk is NOT a boolean WHERE leaf: it's a statement-level ranked cohort (the k most-relevant
// rows of the SEMANTIC entity) consumed as a MEMBERSHIP test (pk in (select pk from cohort)),
// AND-composing, NEVER a fan-inducing JOIN to the ranked CTE on a non-unique key (invariant #2).
// The cohort is hoisted ABOVE the per-source selects (db.$with) so the embed resolves ONCE and
// every source tests the SAME population. Its ORDER BY/LIMIT runs AFTER folding the semantic
// entity's scope (#3 — no scope-leak-via-ranking). GLOBAL (no `per`, no group_by) → a single
// flat `order by sim desc, pk asc limit k`; PER-GROUP (`per` set, or the group_by key when
// grouping) → row_number() OVER (PARTITION BY <expr> ORDER BY sim desc, pk asc) <= k, dropping
// NULL-partition-key rows (so a NULL FK can't collapse into one phantom group). pk ASC is the
// deterministic cutoff tiebreak (NEVER SELECT DISTINCT over the vector column — OOM guardrail).

// similarity = 1 - (embedding <=> vector), in [0,1] — the EXACT formula at compiler.ts simExpr.
function simSql(embExpr: SQL, vector: number[]): SQL {
  const vecLit = `[${vector.join(',')}]`;
  return sql`(1 - (${embExpr} <=> ${vecLit}::vector))`;
}

// A built ranked cohort: the hoisted CTE (db.$with) + the semantic entity it ranks + its pk
// name, so a same-grain source tests `source.pk in (select pk from cohort)` and a cross-grain
// source wraps that membership in the lowerSemijoin EXISTS shell over the semantic child.
interface Cohort {
  // biome-ignore lint/suspicious/noExplicitAny: WithSubquery columns are keyed dynamically by the inner select shape.
  cte: any;
  entity: string; // the semantic entity the cohort ranks (owner of the embedding column)
  pk: string; // its pk db-name (the membership key)
}

// Resolve the SEMANTIC entity a sim_topk leaf ranks over: the entity that OWNS the embedding
// column `on`. A bare `on` (the committed crispify output) is local to the aggregate root; a
// dotted `on` resolves to-one/semijoin to the child that owns it (resolveJoinPlan reused
// UNCHANGED). The cohort is built over THIS entity, once, statement-level.
function topkSemanticEntity(
  model: AggregateModel,
  rootEntity: string,
  leaf: SimTopkLeaf,
): { entity: string; column: string } {
  const plan = resolveJoinPlan(model.analytics, rootEntity, leaf.on, 'filter');
  switch (plan.kind) {
    case 'local':
      return { entity: rootEntity, column: plan.column };
    case 'to-one':
      return { entity: plan.target, column: plan.column };
    case 'semijoin':
      return { entity: plan.child, column: plan.column };
    default:
      throw new Error(`${ENGINE_ERROR.AGGREGATE} ${plan.reason}`);
  }
}

// Build the statement-level ranked cohort CTE for a sim_topk leaf. GLOBAL when `per` is absent
// AND the query isn't grouping; PER-GROUP otherwise (partition key = `per`, else the group_by
// key). The cohort's WHERE folds the semantic entity's scope (#3) BEFORE the ORDER BY/LIMIT.
function buildTopkCohort(
  db: Db,
  model: AggregateModel,
  q: Aggregate,
  leaf: SimTopkLeaf,
  scopeFor?: ScopeFor,
  // CTE name suffix — unique per sim_topk leaf so multiple cohorts on one statement don't collide.
  cteIdx = 0,
): Cohort {
  const cteName = cteIdx === 0 ? 'relevant_cohort' : `relevant_cohort_${cteIdx}`;
  const { entity, column } = topkSemanticEntity(model, q.entity, leaf);
  const pkName = model.analytics[entity]?.pk;
  if (!pkName) throw new Error(`${ENGINE_ERROR.AGGREGATE} no pk registered for ${entity}`);
  const pkCol = colObj(model, entity, pkName);
  const { expr: embExpr } = nativeColSql(model, entity, column);
  const sim = simSql(embExpr, leaf.vector);
  const scope = scopeSqlFor(model, entity, scopeFor);
  const table = model.tables[entity]!;

  // PARTITION key: explicit `per`, else the group_by key when grouping, else none (GLOBAL).
  const perKey = leaf.per ?? ((q.group_by?.length ?? 0) > 0 ? q.group_by![0] : undefined);

  if (!perKey) {
    // GLOBAL — the k most-relevant rows overall. pk ASC = deterministic cutoff tiebreak.
    let qb = db
      .select({ pk: sql`${pkCol}`.as('pk') })
      .from(table)
      .$dynamic();
    if (scope) qb = qb.where(scope);
    qb = qb.orderBy(sql`${sim} desc`, sql`${pkCol} asc`).limit(Number(leaf.top_k));
    // biome-ignore lint/suspicious/noExplicitAny: WithSubquery columns keyed dynamically by inner shape.
    return { cte: db.$with(cteName).as(qb) as any, entity, pk: pkName };
  }

  // PER-GROUP — top-k WITHIN each partition. The partition expr resolves on the semantic entity
  // (its own column or a to-one-reached one); a NULL key is DROPPED (#group, compiler.ts NULL-
  // partition-key rule) so a NULL FK row can't collapse into one phantom group.
  const partLowered = lowerGroupDim(model, entity, perKey, scopeFor);
  const partExpr = partLowered.expr;
  const rn = sql`row_number() over (partition by ${partExpr} order by ${sim} desc, ${pkCol} asc)`;
  // Inner ranked select (the partition joins ride along); NULL partition keys excluded.
  const notNull = sql`${partExpr} is not null`;
  const innerWhere = scope ? sql`(${scope}) and ${notNull}` : notNull;
  // biome-ignore lint/suspicious/noExplicitAny: builder narrows per chained .leftJoin.
  let inner: any = db.select({ pk: sql`${pkCol}`.as('pk'), rn: rn.as('rn') }).from(table);
  const seen = new Set<string>([getTableName(table)]);
  for (const j of partLowered.joins) {
    const k = getTableName(j.table);
    if (seen.has(k)) continue;
    seen.add(k);
    inner = inner.leftJoin(j.table, j.on);
  }
  inner = inner.where(innerWhere);
  const sub = inner.as('ranked_cohort');
  // biome-ignore lint/suspicious/noExplicitAny: subquery columns keyed dynamically by alias.
  const subCols = sub as any;
  const outer = db
    .select({ pk: subCols.pk })
    .from(sub)
    .where(sql`${subCols.rn} <= ${Number(leaf.top_k)}`);
  // biome-ignore lint/suspicious/noExplicitAny: WithSubquery columns keyed dynamically by inner shape.
  return { cte: db.$with(cteName).as(outer) as any, entity, pk: pkName };
}

// Lower a sim_topk leaf for a given measure source → a MEMBERSHIP test against the hoisted
// cohort. Same-grain (source IS the semantic entity) → `source.pk in (select pk from cohort)`.
// Cross-grain (the semantic entity is a has_many child of source) → the lowerSemijoin EXISTS
// shell with inner `child.pk in (select pk from cohort)` (scope folded in the EXISTS body, #3).
// NEVER a JOIN to the ranked CTE on a non-unique key (invariant #2).
function lowerTopkMembership(
  model: AggregateModel,
  source: string,
  cohort: Cohort,
  scopeFor?: ScopeFor,
): SQL {
  const cohortPk = cohort.cte.pk;
  if (source === cohort.entity) {
    const pkCol = colObj(model, source, cohort.pk);
    return sql`${pkCol} in (select ${cohortPk} from ${cohort.cte})`;
  }
  // cross-grain: the semantic entity must be a direct has_many child of this source.
  const plan = resolveJoinPlan(model.analytics, source, `${cohort.entity}.${cohort.pk}`, 'filter');
  if (plan.kind !== 'semijoin') {
    throw new Error(
      `${ENGINE_ERROR.AGGREGATE} relevance cohort over ${cohort.entity} is not conformed to ${source} grain (a top_k cohort consumes as a same-grain membership test or a cross-grain has_many semijoin only)`,
    );
  }
  const fkCol = colObj(model, plan.child, plan.fk);
  const parentPkCol = colObj(model, source, plan.parentPk);
  const childPkCol = colObj(model, plan.child, cohort.pk);
  const childScope = scopeSqlFor(model, plan.child, scopeFor);
  const scopeClause = childScope ? sql` and ${childScope}` : sql``;
  return sql`exists (select 1 from ${model.tables[plan.child]!} where ${eq(fkCol, parentPkCol)} and ${childPkCol} in (select ${cohortPk} from ${cohort.cte})${scopeClause})`;
}

// Collect every sim_topk leaf in a predicate tree, REJECTING any that sits under `or`/`not`
// (a top_k cohort is a ranked MEMBERSHIP set — negating/disjoining it has no grain-safe meaning;
// fail loud). A sim_gte threshold leaf IS fine under or/not (it's a plain boolean), so only
// sim_topk is restricted. Returns the top-level/under-AND sim_topk leaves.
function collectTopkLeaves(pred: Predicate, underAnd = true): SimTopkLeaf[] {
  if (isLeaf(pred)) {
    if (pred.op === 'sim_topk') {
      if (!underAnd) {
        throw new Error(
          `${ENGINE_ERROR.AGGREGATE} a relevance top_k leaf is only allowed at the top level or under \`and\` — not under \`or\`/\`not\` (a ranked cohort membership has no grain-safe negation/disjunction; use \`threshold\` there)`,
        );
      }
      return [pred];
    }
    return [];
  }
  if ('and' in pred) return pred.and.flatMap((p) => collectTopkLeaves(p, underAnd));
  if ('or' in pred) return pred.or.flatMap((p) => collectTopkLeaves(p, false));
  return collectTopkLeaves(pred.not, false);
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
  model: AggregateModel,
  source: string,
  pred: Predicate,
  joins: Array<{ table: PgTable; on: SQL }>,
  scopeFor?: ScopeFor,
  cohorts?: Map<SimTopkLeaf, Cohort>,
): SQL {
  if ('and' in pred)
    return sql`(${sql.join(
      pred.and.map((p) => compileSourceFilter(model, source, p, joins, scopeFor, cohorts)),
      sql` and `,
    )})`;
  if ('or' in pred)
    return sql`(${sql.join(
      pred.or.map((p) => compileSourceFilter(model, source, p, joins, scopeFor, cohorts)),
      sql` or `,
    )})`;
  if ('not' in pred)
    return sql`(not ${compileSourceFilter(model, source, pred.not, joins, scopeFor, cohorts)})`;
  // sim_topk — a ranked-CTE MEMBERSHIP test (NOT a value leaf). The cohort was hoisted ABOVE the
  // per-source selects (one population for every source); here we lower the same-grain `pk in
  // (...)` or cross-grain EXISTS membership against it. AND-composes; never reaches valueLeaf.
  if (isLeaf(pred) && pred.op === 'sim_topk') {
    const cohort = cohorts?.get(pred);
    if (!cohort) {
      throw new Error(
        `${ENGINE_ERROR.AGGREGATE} a relevance top_k leaf reached compile without a hoisted cohort (internal: the cohort CTE must be built statement-level before per-source lowering)`,
      );
    }
    return lowerTopkMembership(model, source, cohort, scopeFor);
  }
  const { op, value } = valueLeaf(pred);
  const plan = resolveJoinPlan(model.analytics, source, pred.on, 'filter');
  switch (plan.kind) {
    case 'local': {
      const head = plan.column.split('.')[0]!;
      // EAV-bound field (resolved semantic layer): lower via the shared 1:1 field_values join,
      // mirroring the group-dim / measure EAV paths. Checked BEFORE the native path — colByDbName
      // only knows native columns and would reject it. This is the verb the EAV bypass used to miss.
      const eavField = model.analytics[source]?.fields[head];
      if (eavField?.eav) {
        // toIdentifier (sanitize), NOT assertIdent (reject): `head` is a HOST field key and EAV keys
        // are routinely PascalCase ("Amount", "StageName") — safe, just not lowercase-snake. The
        // alias is internal, so normalizing the case is harmless. assertIdent here was the bug.
        const { valueCol, join } = eavValueJoin(
          model,
          source,
          eavField.eav,
          `fvf_${toIdentifier(head)}`,
        );
        joins.push(join);
        return applyLeafOp(sql`${valueCol}`, eavField.type ?? 'string', op, value);
      }
      // The guard proved this leaf resolves on every compiled source, so the column is present;
      // the check is defensive (an absent column → 400, NEVER a silent `true` no-op).
      if (!model.colByDbName[source]?.[head]) {
        throw new Error(`${ENGINE_ERROR.AGGREGATE} unknown column "${plan.column}" on ${source}`);
      }
      const { expr, type } = nativeColSql(model, source, plan.column);
      return applyLeafOp(expr, type, op, value);
    }
    case 'to-one': {
      const lowered = lowerToOne(model, plan.hops, plan.target, plan.column, scopeFor);
      for (const j of lowered.joins) joins.push(j);
      return applyLeafOp(lowered.expr, lowered.type, op, value);
    }
    case 'semijoin':
      return lowerSemijoin(
        model,
        source,
        plan.child,
        plan.fk,
        plan.parentPk,
        plan.column,
        op,
        value,
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
  model: AggregateModel,
  source: string,
  dim: string,
  scopeFor?: ScopeFor,
): { alias: string; col: PgColumn | null; expr: SQL; joins: Array<{ table: PgTable; on: SQL }> } {
  // EAV DIMENSION (the resolved semantic layer): a select/text field exposed as a group dim on
  // THIS source. A 1:1 field_values LEFT JOIN (on entity_id + field_definition_id) — grain-safe
  // (groupable like a to-one dim, never fan-out). Mirrors the EAV-measure join (measureValue);
  // group by + project the value column under the dim's safe canonical name. Checked BEFORE
  // resolveJoinPlan (which only knows native columns + relation hops, and would reject the dim).
  const eavField = model.analytics[source]?.fields[dim];
  if (eavField?.eav) {
    if (eavField.role !== 'dimension')
      throw new Error(
        `${ENGINE_ERROR.AGGREGATE} "${dim}" is a ${eavField.role ?? 'non-dimension'} field, not a groupable dimension — group by a dimension (see describe), or aggregate it as a measure.`,
      );
    const { valueCol, join } = eavValueJoin(model, source, eavField.eav, `fvg_${assertIdent(dim)}`);
    return { alias: dim, col: valueCol, expr: sql`${valueCol}`, joins: [join] };
  }
  // ADR-0024 Amendment 4 — fail-loud guard for the bare-name to-one search. A bare dim that is a
  // PHYSICAL column on THIS source is SOURCE-OWNED: it must NEVER be rerouted to a same-named dim
  // on a to-one target (invariant #3 — a host column untagged in `analytics` must not silently
  // resolve to a foreign entity's dimension). The interior resolveJoinPlan checks "local" against
  // the role-tagged `analytics.fields` (a strict subset of physical columns), so it can't see an
  // untagged physical column; gate HERE where `colByDbName` is authoritative. A registered local
  // DIMENSION (also physical, e.g. `account_id`) passes through to resolveJoinPlan (→ local);
  // a physical column that is NOT a registered dimension REJECTS (dimensions-only; never reroute).
  if (!dim.includes('.') && model.colByDbName[source]?.[dim] && eavField?.role !== 'dimension') {
    throw new Error(
      `${ENGINE_ERROR.AGGREGATE} "${dim}" is a column on ${source} but not a groupable dimension (see describe) — group by a registered dimension, or aggregate it as a measure.`,
    );
  }
  const plan = resolveJoinPlan(model.analytics, source, dim, 'group');
  if (plan.kind === 'reject') throw new Error(`${ENGINE_ERROR.AGGREGATE} ${plan.reason}`);
  // GROUP-BY accepts DIMENSIONS only — describe() advertises exactly role:'dimension', so enforce
  // the same contract here (native + EAV, local + to-one): grouping by a MEASURE's raw value is a
  // footgun (one group per distinct value) — band it via a dimension, or aggregate it. The
  // own-entity EAV path above already gates on role:'dimension'; this covers the resolveJoinPlan
  // (local-native + to-one) paths so describe is authoritative both directions. NB: group-ONLY —
  // filtering on a measure (e.g. Amount > 100000) stays legal (that path never reaches here).
  const dimOwner = plan.kind === 'to-one' ? plan.target : source;
  const dimField = model.analytics[dimOwner]?.fields[plan.column];
  if (dimField && dimField.role !== 'dimension') {
    throw new Error(
      `${ENGINE_ERROR.AGGREGATE} "${dim}" is a ${dimField.role ?? 'non-dimension'} field, not a groupable dimension — group by a dimension (see describe), or aggregate it as a measure.`,
    );
  }
  const outAlias = dim;
  if (plan.kind === 'local') {
    const col = plan.column.includes('.') ? null : colObj(model, source, plan.column);
    const { expr } = nativeColSql(model, source, plan.column);
    return { alias: outAlias, col, expr, joins: [] };
  }
  if (plan.kind !== 'to-one') {
    // group role never yields a semijoin (a to-many group dim rejects above) — defensive.
    throw new Error(
      `${ENGINE_ERROR.AGGREGATE} dimension "${dim}" cannot be grouped at ${source} grain`,
    );
  }
  const lowered = lowerToOne(model, plan.hops, plan.target, plan.column, scopeFor);
  return { alias: outAlias, col: lowered.col, expr: lowered.expr, joins: lowered.joins };
}

// One source's pre-aggregated SELECT, built with the query builder. Group dims resolve
// through the conformed-dimension resolver (local column OR to-one belongs_to join);
// measures to aggregate exprs aliased by `as`. Returns the resolved group ALIASES (the
// output keys) so the multi-source join keys on them. Return type inferred (not AggQuery):
// the builder must keep its TypedQueryBuilder shape so db.$with().as() accepts it.
function sourceSelect(
  db: Db,
  model: AggregateModel,
  q: Aggregate,
  source: string,
  measures: Measure[],
  scopeFor?: ScopeFor,
  cohorts?: Map<SimTopkLeaf, Cohort>,
  // Cohort CTEs to hoist onto THIS statement (single-source path only — the multi-source
  // path hoists them itself via its own `.with(...)`). Empty → no `.with` prefix.
  hoist?: Cohort[],
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
    const { valExpr, isStar } = measureValue(model, source, m, joins, scopeFor);
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
  const filterSql = q.filter
    ? compileSourceFilter(model, source, q.filter, joins, scopeFor, cohorts)
    : null;
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
  // Hoist the ranked cohort CTE(s) onto THIS statement (single-source path) so the membership
  // `pk in (select pk from relevant_cohort)` resolves. The cohort is built ABOVE the per-source
  // select, embed resolved once. Multi-source hoists them in its own `.with(...)` instead.
  // biome-ignore lint/suspicious/noExplicitAny: builder type narrows per chained .leftJoin / .with; not statically typeable across a dynamic chain.
  let qb: any = hoist?.length
    ? db
        .with(...hoist.map((c) => c.cte))
        .select(shape)
        .from(table)
    : db.select(shape).from(table);
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
  model: AggregateModel,
  q: Aggregate,
  plan: AggregatePlan,
  scopeFor?: ScopeFor,
  cohorts?: Map<SimTopkLeaf, Cohort>,
  hoist?: Cohort[],
): AggQuery {
  const ctes = plan.sources.map((s, i) => {
    const { qb, groupAliases } = sourceSelect(
      db,
      model,
      q,
      s,
      q.measures.filter((m) => measureSource(q, m) === s),
      scopeFor,
      cohorts,
      // The cohort CTEs are hoisted ONCE on THIS multi-source statement's `.with(...)` below —
      // not per-source-CTE (a WITH item can't itself carry a sibling WITH). So `hoist` stays
      // unset here; the membership SQL references the cohort hoisted at the outer statement.
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
  // The ranked cohort CTE(s) come FIRST in the WITH list — each per-source CTE's membership
  // test references `relevant_cohort`, so it must be in scope before them. Embed resolved once,
  // one population for every source (the whole point of hoisting it statement-level).
  // biome-ignore lint/suspicious/noExplicitAny: builder type narrows per chained .fullJoin / .with.
  let qb: any = db
    .with(...(hoist ?? []).map((c) => c.cte), ...ctes.map((c) => c.cte))
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
            `${ENGINE_ERROR.AGGREGATE} order_by references unknown output "${o.on}" — expected a measure alias or a projected group_by column`,
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
  const legs = new Set(
    (q.composites ?? []).flatMap((c) =>
      c.kind === 'derived' ? c.legs.map((l) => l.alias) : [c.numerator, c.denominator],
    ),
  );
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
  model: AggregateModel,
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
  // Ranked cohort(s) for any sim_topk relevance leaf. Collected here (top-level/under-AND only —
  // collectTopkLeaves REJECTS sim_topk under or/not), built ONCE per grouped statement so the
  // embed resolves once and every measure source tests the SAME population. Rebuilt inside
  // makeGrouped because each WithSubquery binds to a single statement (main query vs group-count).
  const topkLeaves = q.filter ? collectTopkLeaves(q.filter) : [];

  const makeGrouped = (): AggQuery => {
    // Build the cohort CTE(s) fresh for THIS statement.
    const cohorts = new Map<SimTopkLeaf, Cohort>();
    const hoist: Cohort[] = [];
    topkLeaves.forEach((leaf, i) => {
      const cohort = buildTopkCohort(db, model, q, leaf, scopeFor, i);
      cohorts.set(leaf, cohort);
      hoist.push(cohort);
    });
    const groupedQ: AggQuery =
      plan.sources.length <= 1
        ? sourceSelect(
            db,
            model,
            q,
            plan.sources[0] ?? q.entity,
            q.measures,
            scopeFor,
            cohorts,
            hoist,
          ).qb
        : multiSourceSelect(db, model, q, plan, scopeFor, cohorts, hoist);
    const composites = q.composites ?? [];
    if (!q.having && composites.length === 0) return groupedQ;

    // biome-ignore lint/suspicious/noExplicitAny: subquery columns keyed dynamically by alias.
    const sub = (groupedQ as any).as('g');
    // The internal composite legs (__cmp_…) are NOT part of the output/filter contract:
    // excluded from the projection AND refused in HAVING (order_by already excludes them
    // via outputAliasSet) — so the reserved namespace never leaks as a public handle.
    const legs = new Set(
      composites.flatMap((c) =>
        c.kind === 'derived' ? c.legs.map((l) => l.alias) : [c.numerator, c.denominator],
      ),
    );
    // biome-ignore lint/suspicious/noExplicitAny: dynamic projection shape.
    let wrapped: any;
    if (composites.length) {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic projection shape.
      const shape: Record<string, any> = {};
      for (const c of projectedGroupCols) shape[c] = sub[c];
      for (const m of q.measures) if (!legs.has(m.as)) shape[m.as] = sub[m.as];
      for (const comp of composites) {
        // A derived composite is OUTER-SELECT arithmetic over the collapsed leg aliases —
        // walk its AST into numeric-safe SQL (per-leg null policy + closed-op set via
        // sql.raw). Short-circuits before the ratio code (which then narrows to RatioComposite).
        if (comp.kind === 'derived') {
          const legAgg = new Map(comp.legs.map((l) => [l.alias, l.agg]));
          shape[comp.as] = walkDerived(comp.expr, legAgg, sub).as(comp.as);
          continue;
        }
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
export function compileNaiveDrizzle(db: Db, model: AggregateModel, q: Aggregate): AggQuery {
  const root = q.entity;
  const joins: Array<{ table: PgTable; on: SQL }> = [];
  const joined = new Set<string>();
  const ensureChildJoin = (src: string) => {
    if (src === root || joined.has(src)) return;
    joined.add(src);
    const rel = Object.values(model.registry[root]!.relationships).find((r) => r.target === src)!;
    const on =
      rel.kind !== 'belongs_to'
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
    } else if (typeof m.on === 'object') {
      // EXPRESSION measure (D4) — reuse the same RowExpr walker so the eval-only naive path can
      // never silently miscompute a stringified object (won't occur in practice, but fail-safe).
      const counter = { n: 0 };
      valExpr = lowerRowExpr(model, src, m.on, assertIdent(m.as), joins, counter);
    } else {
      const head = measureField(m); // field relative to source — strips a dotted `on`'s relation prefix
      const field = model.analytics[src]?.fields[head];
      if (field?.eav) {
        // `_0` suffix so the string-path EAV alias can never collide with an object-path leaf alias.
        const { valueCol, join } = eavValueJoin(model, src, field.eav, `fv_${assertIdent(m.as)}_0`);
        joins.push(join);
        valExpr = sql`${valueCol}`;
      } else valExpr = nativeColSql(model, src, head).expr;
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
