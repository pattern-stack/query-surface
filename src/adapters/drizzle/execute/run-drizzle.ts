// Drizzle-native runner: doctor → compile (builder query) → await → result.
import { type SQL, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { assertAggregateSafe } from '../../../internal/analytics/doctor';
import { filterColumnPaths } from '../../../internal/analytics/filter-columns';
import { planAggregate } from '../../../internal/analytics/grain';
import { resolveJoinPlan } from '../../../internal/analytics/join-plan';
import type { AggregateInput } from '../../../internal/analytics/measure-catalog';
import { crispifyRelevant, normalizeAggregate } from '../../../internal/analytics/normalize';
import type {
  AggregateResponse,
  AggregateResult,
  Predicate,
  RelevanceCitation,
  ScopeFor,
} from '../../../internal/analytics/types';
import { ENGINE_ERROR } from '../../../internal/language/error-messages';
import type { RelevantLeaf } from '../../../internal/language/types';
import { buildTruncatedSnippet } from '../../../internal/retrieval/snippets';
import { applyLeafOp, compileGroupedDrizzle } from '../compile/compile-drizzle';
import type { AggregateModel } from '../registry/model';

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
  const expanded = normalizeAggregate(model.catalog ?? {}, input);
  // Defuzzify: lower every service-stamped `op:'relevant'` leaf to its crisp sim_gte/sim_topk
  // form HERE — after measure expansion, before the fail-closed conform guard below — so the
  // crisp leaf's EMBEDDING-column `on` rides the wave-1 conform-or-reject guard (#5) unchanged.
  const q = expanded.filter ? { ...expanded, filter: crispifyRelevant(expanded.filter) } : expanded;
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
          `${ENGINE_ERROR.AGGREGATE} filter references column(s) [${on}] not queryable on ${s} — not a registered field there nor conformed (to-one reachable). A global filter must resolve on every measure source; use a measure-level \`where\` for source-local intent (see GET /query/describe/${q.entity}).`,
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

// ───────────────────────────────────────────────────────────────────────────────────────────
// Calibration-grade citation companion (Wave-2 — ADR-0024 §A, step 7)
// ───────────────────────────────────────────────────────────────────────────────────────────
// The collapsing aggregate/compare SQL yields GROUPED rows with no row id/text, so citation is
// computed by a SEPARATE row-grain scan over the SEMANTIC entity (the one owning the embedding
// column). It re-runs the crispified cohort predicate at row grain, reusing the service's already-
// resolved `vector` (NO second embed), ORDER BY sim DESC, pk ASC (the deterministic cutoff
// tiebreak; NEVER SELECT DISTINCT over the vector column — the OOM guardrail). The semantic
// entity's scope is folded into the WHERE (#3 — fail-closed; the service resolves the predicate
// and passes it here for lowering). similarity = 1 - (embedding <=> vector) ∈ [0,1] — the EXACT
// formula at compiler.ts simExpr.

const DEFAULT_EXEMPLARS = 4;

// similarity = 1 - (embedding <=> vector). `embExpr` is the resolved embedding column object.
function simSql(embCol: PgColumn, vector: number[]): SQL {
  const vecLit = `[${vector.join(',')}]`;
  return sql`(1 - (${embCol} <=> ${vecLit}::vector))`;
}

// Lower a scope Predicate (tenancy: same-entity value-op leaves, and/or/not) → SQL over the
// semantic entity's columns. Mirrors the compiler's per-source scope fold but stays local to
// run-drizzle (the compiler's compilePredicateSql is private); scope leaves are local value ops.
function lowerScope(model: AggregateModel, entity: string, pred: Predicate): SQL {
  if ('and' in pred)
    return sql`(${sql.join(
      pred.and.map((p) => lowerScope(model, entity, p)),
      sql` and `,
    )})`;
  if ('or' in pred)
    return sql`(${sql.join(
      pred.or.map((p) => lowerScope(model, entity, p)),
      sql` or `,
    )})`;
  if ('not' in pred) return sql`(not ${lowerScope(model, entity, pred.not)})`;
  const leaf = pred as { on: string; op: string; value?: unknown };
  const col = model.colByDbName[entity]?.[leaf.on];
  if (!col)
    throw new Error(
      `${ENGINE_ERROR.AGGREGATE} citation scope references unknown column "${leaf.on}" on ${entity}`,
    );
  const type = model.analytics[entity]?.fields[leaf.on]?.type ?? 'string';
  return applyLeafOp(sql`${col}`, type, leaf.op, leaf.value);
}

/** Resolve the SEMANTIC entity + text column for a resolved relevant leaf: a bare `on` is local
 *  to the root, a dotted `on` (`observations.normalized_text`) targets the prefix entity. */
function citationTarget(rootEntity: string, on: string): { entity: string; textColumn: string } {
  const dot = on.lastIndexOf('.');
  if (dot < 0) return { entity: rootEntity, textColumn: on };
  return { entity: on.slice(0, dot), textColumn: on.slice(dot + 1) };
}

/**
 * Build the MANDATORY citation for ONE resolved relevant leaf. A row-grain scan over the
 * semantic entity ordered by similarity (desc, pk asc) gives `lowest_included`, `match_count`,
 * and the exemplars for free; `highest_excluded` reads ONE row past the cutoff and is ON-REQUEST.
 *   - threshold mode: cutoff = the resolved threshold; members = sim >= cutoff.
 *   - top_k mode:     members = the top-k rows (per-partition when `per` is set); cutoff = the
 *                     weakest member's sim (the k-th / lowest-included similarity).
 * `scopeForEntity` is the semantic entity's tenancy predicate (or undefined for unscoped/global).
 */
export async function buildRelevanceCitation(
  db: Db,
  model: AggregateModel,
  rootEntity: string,
  leaf: RelevantLeaf,
  opts: { boundary?: boolean; exemplars?: number; scopeForEntity?: Predicate } = {},
): Promise<RelevanceCitation> {
  if (!leaf.vector || leaf.vector.length === 0) {
    throw new Error(
      `${ENGINE_ERROR.FILTER} citation requires a resolved vector on the relevant leaf`,
    );
  }
  const embeddingColumn = leaf.embeddingColumn;
  if (!embeddingColumn) {
    throw new Error(
      `${ENGINE_ERROR.FILTER} citation requires a resolved embeddingColumn on the relevant leaf`,
    );
  }
  const { entity, textColumn } = citationTarget(rootEntity, leaf.on);
  const pkName = model.analytics[entity]?.pk;
  if (!pkName) throw new Error(`${ENGINE_ERROR.AGGREGATE} no pk registered for ${entity}`);
  const pkCol = model.colByDbName[entity]?.[pkName];
  const embCol = model.colByDbName[entity]?.[embeddingColumn];
  const textCol = model.colByDbName[entity]?.[textColumn];
  const table = model.tables[entity];
  if (!pkCol || !embCol || !textCol || !table) {
    throw new Error(
      `${ENGINE_ERROR.AGGREGATE} citation cannot resolve column objects on ${entity}`,
    );
  }
  const sim = simSql(embCol, leaf.vector);
  const scopeSql = opts.scopeForEntity ? lowerScope(model, entity, opts.scopeForEntity) : undefined;
  const exemplarCount = opts.exemplars ?? DEFAULT_EXEMPLARS;
  const mode: 'threshold' | 'top_k' = leaf.threshold !== undefined ? 'threshold' : 'top_k';

  type ScanRow = { id: unknown; sim: number; txt: unknown };
  const select = {
    id: sql`${pkCol}`.as('id'),
    sim: sql`${sim}`.as('sim'),
    txt: sql`${textCol}`.as('txt'),
  };

  let members: ScanRow[];
  let cutoff: number;
  let excluded: ScanRow | undefined;

  if (mode === 'threshold') {
    const threshold = leaf.threshold as number;
    cutoff = threshold;
    // Members: sim >= threshold, ordered desc, pk asc. Fetch the whole cohort to count it.
    const where = scopeSql
      ? sql`(${sim}) >= ${threshold} and ${scopeSql}`
      : sql`(${sim}) >= ${threshold}`;
    members = (await db
      .select(select)
      .from(table)
      .where(where)
      .orderBy(sql`${sim} desc`, sql`${pkCol} asc`)) as ScanRow[];
    if (opts.boundary) {
      // highest_excluded = strongest non-member (sim < threshold), one row past the cutoff.
      const exWhere = scopeSql
        ? sql`(${sim}) < ${threshold} and ${scopeSql}`
        : sql`(${sim}) < ${threshold}`;
      const ex = (await db
        .select(select)
        .from(table)
        .where(exWhere)
        .orderBy(sql`${sim} desc`, sql`${pkCol} asc`)
        .limit(1)) as ScanRow[];
      excluded = ex[0];
    }
  } else {
    // top_k. Per-partition when `per` is set (or the cohort was per-group); otherwise GLOBAL.
    // The citation cohort = the union of per-partition top-k; cutoff = the weakest member sim.
    const k = leaf.top_k as number;
    const per = leaf.per;
    if (!per) {
      // GLOBAL — the k most relevant rows overall (+ 1 extra for highest_excluded on request).
      const fetchN = opts.boundary ? k + 1 : k;
      const base = scopeSql
        ? db.select(select).from(table).where(scopeSql)
        : db.select(select).from(table);
      const scanned = (await base
        .orderBy(sql`${sim} desc`, sql`${pkCol} asc`)
        .limit(fetchN)) as ScanRow[];
      members = scanned.slice(0, k);
      if (opts.boundary) excluded = scanned[k];
    } else {
      // PER-GROUP — top-k WITHIN each partition; the partition key resolves on the semantic
      // entity (its own column). NULL partition keys are DROPPED (no phantom group). The
      // companion fetches rank <= k (+ the rank=k+1 row per partition for highest_excluded).
      const partCol = model.colByDbName[entity]?.[per];
      if (!partCol) {
        throw new Error(
          `${ENGINE_ERROR.AGGREGATE} citation per-key "${per}" is not a column on ${entity}`,
        );
      }
      const rn = sql`row_number() over (partition by ${partCol} order by ${sim} desc, ${pkCol} asc)`;
      const notNull = sql`${partCol} is not null`;
      const innerWhere = scopeSql ? sql`(${scopeSql}) and ${notNull}` : notNull;
      const inner = db
        .select({
          id: sql`${pkCol}`.as('id'),
          sim: sql`${sim}`.as('sim'),
          txt: sql`${textCol}`.as('txt'),
          rn: rn.as('rn'),
        })
        .from(table)
        .where(innerWhere)
        .as('ranked');
      // biome-ignore lint/suspicious/noExplicitAny: subquery columns keyed dynamically by alias.
      const sub = inner as any;
      const keep = opts.boundary ? k + 1 : k;
      const scanned = (await db
        .select({ id: sub.id, sim: sub.sim, txt: sub.txt, rn: sub.rn })
        .from(inner)
        .where(sql`${sub.rn} <= ${keep}`)
        .orderBy(sql`${sub.sim} desc`, sql`${sub.id} asc`)) as Array<ScanRow & { rn: number }>;
      members = scanned.filter((r) => Number(r.rn) <= k);
      if (opts.boundary) {
        // strongest rank=k+1 row across partitions (the per-partition boundary, globally strongest).
        excluded = scanned.find((r) => Number(r.rn) === k + 1);
      }
    }
    // cutoff = the weakest included member's similarity (the k-th / lowest-included sim).
    cutoff = members.length ? Number(members[members.length - 1]!.sim) : 0;
  }

  const idOf = (r: ScanRow) => String(r.id);
  const exemplars = members.slice(0, exemplarCount).map((r) => {
    const { snippet, full_length } = buildTruncatedSnippet(r.txt);
    return { id: idOf(r), similarity: Number(r.sim), snippet, full_length };
  });
  const lowestRow = members.length ? members[members.length - 1]! : undefined;

  const citation: RelevanceCitation = {
    on: leaf.on,
    query: leaf.query,
    mode,
    ...(mode === 'top_k' && leaf.per !== undefined ? { per: leaf.per } : {}),
    cutoff,
    match_count: members.length,
    exemplars,
    boundary: {
      // lowest_included = the weakest member (the cutoff row). With an empty cohort there is
      // no member; surface a degenerate boundary so the shape is total (match_count=0 signals it).
      lowest_included: lowestRow
        ? {
            id: idOf(lowestRow),
            similarity: Number(lowestRow.sim),
            snippet: buildTruncatedSnippet(lowestRow.txt).snippet,
          }
        : { id: '', similarity: cutoff, snippet: '' },
    },
  };
  if (opts.boundary && excluded) {
    citation.boundary.highest_excluded = {
      id: idOf(excluded),
      similarity: Number(excluded.sim),
      snippet: buildTruncatedSnippet(excluded.txt).snippet,
    };
  }
  return citation;
}
