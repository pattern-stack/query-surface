// Drizzle-native runner: doctor → compile (builder query) → await → result.
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { ENGINE_ERROR } from '../error-messages';
import { compileGroupedDrizzle } from './compile-drizzle';
import { assertAggregateSafe } from './doctor';
import { filterColumnPaths } from './filter-columns';
import { planAggregate } from './grain';
import { resolveJoinPlan } from './join-plan';
import type { AggregateInput } from './measure-catalog';
import type { AggregateModel } from './model';
import { normalizeAggregate } from './normalize';
import type { AggregateResponse, AggregateResult, ScopeFor } from './types';

// biome-ignore lint/suspicious/noExplicitAny: schema-agnostic db (matches the compiler); both the eval's DrizzleDb and the service's NodePgDatabase<any> flow in.
type Db = NodePgDatabase<any>;

export async function runAggregateDrizzle(
  db: Db,
  model: AggregateModel,
  input: AggregateInput,
  scopeFor?: ScopeFor,
): Promise<AggregateResult> {
  // ORDER: expand {ref}s → inline Measures FIRST, so the doctor + compiler + grain
  // oracle + scope all see canonical Measures (never a catalog claim). Inline passes
  // through unchanged.
  const q = normalizeAggregate(model.catalog ?? {}, input);
  assertAggregateSafe(model.analytics, q);
  const plan = planAggregate(model.analytics, q);
  // Refuse a bogus root/source entity FIRST → 404 (UNKNOWN_ENTITY), BEFORE the filter guard,
  // so an unknown entity is a clean 404 (matching search/fetch) rather than a 400 from the
  // guard. (compileGroupedDrizzle re-checks; this just orders the error contract.)
  for (const e of [q.entity, ...plan.sources]) {
    if (!model.tables[e]) throw new Error(`${ENGINE_ERROR.UNKNOWN_ENTITY}${e}`);
  }
  // FAIL CLOSED unless a `filter` leaf resolves (conforms) on EVERY compiled measure source —
  // BEFORE compile, so this actionable message wins over a raw "unknown column" from the lowering.
  // A leaf is "queryable" on a source iff it resolves through the JOIN GRAPH to a REAL column there:
  // local (own column), to-one (belongs_to-reached column), or semijoin (has_many child column). A
  // GLOBAL filter must mean the SAME population across every measure — so a leaf that resolves on
  // SOME measure source but not another is REJECTED (ADR-0024 §Decision.4: non-conformed → reject,
  // no silent drops). Silently leaving the non-conforming measure unfiltered is the Q6 landmine: it
  // fabricates cross-measure comparisons (a compare delta of 0 over different populations). For
  // SOURCE-LOCAL intent ("filter only this measure") use a measure-level `where`. Iterate the
  // COMPILED measure sources (plan.sources) — q.entity is compiled only when it is itself a source.
  if (q.filter) {
    for (const on of filterColumnPaths(q.filter)) {
      for (const s of plan.sources) {
        const r = resolveJoinPlan(model.analytics, s, on, 'filter');
        if (r.kind !== 'reject') {
          const owner = r.kind === 'local' ? s : r.kind === 'to-one' ? r.target : r.child;
          if (model.colByDbName[owner]?.[r.column.split('.')[0]!]) continue; // resolves here
        } else if (r.code === 'ambiguous' || r.code === 'unsupported') {
          // a join diamond / multi-hop collection path on this source — informative reason.
          throw new Error(`${ENGINE_ERROR.AGGREGATE} ${r.reason}`);
        }
        // local-absent / unreachable on THIS compiled measure source → reject the whole filter.
        throw new Error(
          `${ENGINE_ERROR.AGGREGATE} filter references column(s) [${on}] not queryable on ${s} — ` +
            'not a registered field there nor conformed (to-one reachable). A global filter must ' +
            'resolve on every measure source; use a measure-level `where` for source-local intent ' +
            `(see GET /query/describe/${q.entity}).`,
        );
      }
    }
  }
  const { query, groupCountQuery } = compileGroupedDrizzle(db, model, q, scopeFor);
  const rows = (await query) as Record<string, unknown>[];
  let group_count: number | null = null;
  if (q.group_by?.length) {
    group_count = groupCountQuery
      ? Number((await groupCountQuery)[0]?.group_count ?? rows.length)
      : rows.length;
  }
  // Surface a NULL-ratio count per composite: a null ratio means a zero/absent
  // denominator (the coalesce/NULLIF null-policy) — usually expected, but flagged so a
  // missing-join-row bug isn't hidden as a silent div-by-zero.
  const warnings: string[] = [];
  for (const comp of q.composites ?? []) {
    const nulls = rows.filter((r) => r[comp.as] == null).length;
    if (nulls > 0) {
      warnings.push(`${comp.as}: ${nulls} group(s) have a null ratio (zero or absent denominator)`);
    }
  }
  // Builder-native: .toSQL() gives the parameterized text (placeholders, not bound
  // values) for include_sql — debug surface, never load-bearing.
  return {
    rows,
    row_count: rows.length,
    group_count,
    sql: query.toSQL().sql,
    plan,
    ...(warnings.length ? { warnings } : {}),
  };
}

/** Public surface entry — parallel to query()/fetch(): returns the package-shaped
 *  AggregateResponse (plan stays internal). `scopeFor` folds a per-source tenancy
 *  predicate into each source CTE's WHERE pre-aggregation (non-bypassable: a caller
 *  filter can only narrow it). `include_sql` echoes the compiled SQL for debugging. */
export async function aggregate(
  db: Db,
  model: AggregateModel,
  input: AggregateInput,
  opts: { scopeFor?: ScopeFor; include_sql?: boolean } = {},
): Promise<AggregateResponse> {
  const r = await runAggregateDrizzle(db, model, input, opts.scopeFor);
  return {
    entity: input.entity,
    rows: r.rows,
    row_count: r.row_count,
    group_count: r.group_count,
    warnings: r.warnings,
    ...(opts.include_sql ? { sql: r.sql } : {}),
  };
}
