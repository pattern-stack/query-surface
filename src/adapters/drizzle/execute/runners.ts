// Query runners — compile a request and run it against Drizzle.
//
// Two flows:
//   runSearch — narrow + return IDs (+ optional preview rows)
//   runFetch  — hydrate IDs into full rows (+ optional refinement filter)

import { type SQL, count, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { ENGINE_ERROR } from '../../../internal/language/error-messages.ts';
import type {
  EntityName,
  FetchRequest,
  FetchResponse,
  FilterExpression,
  SearchEntityResult,
  SingleSearchQuery,
} from '../../../internal/language/types.ts';
import {
  RANK_SCORE_KEY,
  RANK_SNIPPET_KEY,
  SNIPPETS_KEY,
} from '../../../internal/language/types.ts';
import { buildSnippets } from '../../../internal/retrieval/snippets.ts';
import { PARTITION_RN_KEY, compile } from '../compile/compiler.ts';
import type { EavContext } from '../eav/field-map.ts';
import { hydrateEavRows } from '../eav/read.ts';
import { registry } from '../registry/registry.ts';
import { expandRows, parseExpandPaths } from './expand.ts';
import { catalogPreview, nativeSelectShape } from './preview.ts';

// ============================================================================
// /search — narrow + return IDs (+ optional preview)
// ============================================================================

export async function runSearch(
  db: NodePgDatabase<Record<string, unknown>>,
  query: SingleSearchQuery,
  opts: { preview?: boolean; include_sql?: boolean },
  eav?: EavContext,
): Promise<SearchEntityResult> {
  // What columns do preview rows carry? Two routes, both resolved through the
  // SAME compiler machinery (compile()'s 3rd arg), so native columns, EAV
  // Shape A/B, and belongs_to dotted paths all project uniformly:
  //   • projection — an explicit `columns` list from the caller (overrides the
  //     curated set; lets a UI choose exactly which fields appear as columns).
  //   • default    — the catalog's curated preview fields (qField isKeyField /
  //     field_definitions.isKeyField), split into native columns + EAV keys.
  // Either route is moot without preview rows, so both collapse to "ids only".
  const projecting = !!opts.preview && Array.isArray(query.columns);
  const pv =
    opts.preview && !projecting ? catalogPreview(query.entity, eav?.fieldMaps[query.entity]) : null;

  // Fields handed to the compiler to resolve into SELECT expressions:
  //   projecting      → the caller's columns (native + EAV + belongs_to)
  //   default preview → just the EAV preview keys (native ones come from `pv`)
  // Virtual rank keys (_rank, _snippet, _snippets) injected by rankSelect are not
  // real columns — silently drop them from the projection list so a caller that
  // passes columns:['type','_rank'] gets type + the auto-injected _rank, not a 400.
  const VIRTUAL_KEYS = new Set([RANK_SCORE_KEY, RANK_SNIPPET_KEY, SNIPPETS_KEY]);
  const projectFields = projecting
    ? (query.columns ?? []).filter((c) => !VIRTUAL_KEYS.has(c))
    : (pv?.eavKeys ?? []);

  // Compile once — same JOIN chain serves the COUNT and the SELECT-ID queries.
  const compiled = compile(
    {
      entity: query.entity,
      filter: query.filter,
      sort: query.sort,
      page: query.page,
      rankBy: query.rankBy,
      rankSemantic: query.rankSemantic,
      window: query.window,
    },
    eav,
    projectFields,
  );

  const desc = registry[query.entity];
  const idCol = (desc.columns as Record<string, PgColumn>)[desc.primaryKey];

  // 1) Total count — same WHERE + JOINs, no ORDER BY / LIMIT. For a partitioned (per-group
  // top-K) query the row-count of the candidate pool is meaningless to the consumer (the
  // result IS the complete per-group top-K), so count DISTINCT groups instead — `total` then
  // means "how many groups", and `has_more` is derived from the flat cap below.
  const totalSelect = compiled.partition
    ? { total: sql<number>`count(distinct ${compiled.partition.keyExpr})` }
    : { total: count() };
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle query-builder type narrows per chained leftJoin; the accumulator cannot be statically typed across a dynamic join list
  let cq: any = db.select(totalSelect).from(compiled.rootTable);
  for (const j of compiled.joins) cq = cq.leftJoin(j.table, j.on);
  if (compiled.where) cq = cq.where(compiled.where);
  const totalRows = await cq;
  const total = Number(totalRows[0]?.total ?? 0);

  // 2) Paginated SELECT — ids (+ projected/preview columns if requested).
  // PgColumn for real/Shape-A columns; SQL.Aliased for Shape-B jsonb cast exprs.
  const selectShape: Record<string, PgColumn | SQL.Aliased> = { id: idCol };

  // Default-preview native columns (keyed by snake_case field key, the dialect
  // projectRow speaks). Null when projecting — projected native columns arrive
  // via compiled.eavPreview below.
  const previewCols = pv?.nativeColumns ?? null;
  if (previewCols) {
    for (const [alias, col] of Object.entries(previewCols)) {
      selectShape[alias] = col;
    }
  }

  // Compiler-resolved projection columns, keyed by the requested field key. In
  // default mode this carries only the curated EAV preview fields (StageName,
  // Amount, …); in projection mode it carries EVERY requested column — native,
  // EAV, and belongs_to dotted paths alike — since compile() resolves any field
  // path the same way. has_many paths were dropped during compile.
  for (const [alias, col] of Object.entries(compiled.projection)) {
    selectShape[alias] = col;
  }

  // rank_by contributes `_rank` (score) and `_snippet` (ts_headline) — preview only.
  if (opts.preview) {
    for (const [alias, expr] of Object.entries(compiled.rankSelect)) {
      selectShape[alias] = expr;
    }
  }

  // window measures — agg() OVER (PARTITION BY …) annotation columns — preview only.
  // The partition branch carries them into the inner subquery shape automatically.
  if (opts.preview) {
    for (const [alias, expr] of Object.entries(compiled.windowSelect)) {
      selectShape[alias] = expr;
    }
  }

  // Auto-extend the SELECT so any column a text-match descriptor points at is
  // pulled (in-SQL) for snippet extraction even when it isn't in the
  // projected/preview set — e.g. text-magic on a transcript fans out across
  // [title, transcript, summary, …] but only some are curated/projected. These
  // columns are stripped from the response row once snippets are built: the
  // snippet already carries the match window, so the full body is redundant.
  const autoExtended: string[] = [];
  if (opts.preview) {
    const entityCols = registry[query.entity].columns as Record<string, PgColumn>;
    for (const m of compiled.textMatches) {
      if (!(m.column in selectShape) && entityCols[m.column]) {
        selectShape[m.column] = entityCols[m.column];
        autoExtended.push(m.column);
      }
    }
  }

  let debug: { sql: string; params: unknown[] };
  let rows: Array<Record<string, unknown>>;
  if (compiled.partition) {
    // Per-group top-K (rank_by.partition_by): wrap the SELECT in a subquery carrying the
    // window row number, keep rows where _rn <= perLimit, order by (group, rank-within-group).
    // The inner query has no ORDER BY/LIMIT — the window owns ranking; the flat limit/offset
    // bound the total result on the outer query.
    const part = compiled.partition;
    const innerShape = { ...selectShape, [PARTITION_RN_KEY]: part.rowNumber };
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle query-builder type narrows per chained leftJoin; the accumulator cannot be statically typed across a dynamic join list
    let iq: any = db.select(innerShape).from(compiled.rootTable);
    for (const j of compiled.joins) iq = iq.leftJoin(j.table, j.on);
    for (const j of compiled.previewJoins) iq = iq.leftJoin(j.table, j.on);
    if (compiled.where) iq = iq.where(compiled.where);
    const sub = iq.as('ranked');
    // biome-ignore lint/suspicious/noExplicitAny: subquery columns are keyed dynamically by the select-shape aliases
    const subCols = sub as any;
    // biome-ignore lint/suspicious/noExplicitAny: see subCols
    let oq: any = db
      .select()
      .from(sub)
      .where(sql`${subCols[PARTITION_RN_KEY]} <= ${part.perLimit}`)
      .orderBy(sql`${subCols[part.key]} asc nulls last`, sql`${subCols[PARTITION_RN_KEY]} asc`);
    oq = oq.limit(compiled.limit).offset(compiled.offset);
    debug = (oq as { toSQL: () => { sql: string; params: unknown[] } }).toSQL();
    rows = await oq;
    // _rn is runner-internal (rank within group is implied by row order) — strip it.
    for (const r of rows) delete r[PARTITION_RN_KEY];
  } else {
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle query-builder type narrows per chained leftJoin; the accumulator cannot be statically typed across a dynamic join list
    let pq: any = db.select(selectShape).from(compiled.rootTable);
    for (const j of compiled.joins) pq = pq.leftJoin(j.table, j.on);
    for (const j of compiled.previewJoins) pq = pq.leftJoin(j.table, j.on);
    if (compiled.where) pq = pq.where(compiled.where);
    if (compiled.orderBy.length) pq = pq.orderBy(...compiled.orderBy);
    pq = pq.limit(compiled.limit).offset(compiled.offset);

    debug = (pq as { toSQL: () => { sql: string; params: unknown[] } }).toSQL();
    rows = await pq;
  }

  const ids = rows.map((r) => String(r.id));

  // Attach `_snippets` to preview rows that have a text-op match in this row,
  // THEN strip the auto-extended columns. Snippets carry the match window +
  // offsets + full_length, so the full column body is redundant on the wire.
  // Curated preview columns stay intact — those are what the consumer
  // uses for at-a-glance row identity.
  //
  // Agents that need the full body should `query_fetch` the row IDs — the
  // two-stage "search to decide, fetch to read" pattern.
  if (opts.preview && compiled.textMatches.length > 0) {
    for (const row of rows) {
      const snippets = buildSnippets(row, compiled.textMatches);
      if (snippets.length > 0) {
        row[SNIPPETS_KEY] = snippets;
      }
      for (const col of autoExtended) {
        delete row[col];
      }
    }
  }

  const result: SearchEntityResult = {
    ids,
    total,
    // Non-partitioned: more rows exist beyond this page. Partitioned: the window returns the
    // complete per-group top-K, so "more" only means the flat cap clipped it — i.e. we returned
    // exactly `limit` rows. (`total` is the group count there, not a row count, so the row-based
    // page check doesn't apply.)
    has_more: compiled.partition
      ? rows.length >= compiled.limit
      : compiled.offset + rows.length < total,
  };
  if (opts.preview) result.preview = rows;
  if (compiled.warnings.length > 0) result.warnings = compiled.warnings;
  if (opts.include_sql) {
    result.sql = debug.sql;
    result.params = debug.params;
  }
  return result;
}

export async function runSearchMulti(
  db: NodePgDatabase<Record<string, unknown>>,
  queries: SingleSearchQuery[],
  opts: { preview?: boolean; include_sql?: boolean },
  eav?: EavContext,
): Promise<Partial<Record<EntityName, SearchEntityResult>>> {
  // Parallel — each entity hits its own table; no shared dependency.
  const settled = await Promise.all(
    queries.map(async (q) => ({
      entity: q.entity,
      result: await runSearch(db, q, opts, eav),
    })),
  );
  const out: Partial<Record<EntityName, SearchEntityResult>> = {};
  for (const { entity, result } of settled) out[entity] = result;
  return out;
}

// ============================================================================
// /fetch — hydrate IDs into full rows
// ============================================================================

export async function runFetch(
  db: NodePgDatabase<Record<string, unknown>>,
  req: FetchRequest,
  eav?: EavContext,
): Promise<FetchResponse> {
  const desc = registry[req.entity];
  if (!desc) throw new Error(`${ENGINE_ERROR.UNKNOWN_ENTITY}${req.entity}`);

  // Build the effective filter: AND(id IN ids, optional refinement)
  const idFilter: FilterExpression = {
    on: desc.primaryKey,
    op: 'in',
    value: req.ids,
  };
  const effectiveFilter: FilterExpression = req.filter ? { and: [idFilter, req.filter] } : idFilter;

  const compiled = compile(
    {
      entity: req.entity,
      filter: effectiveFilter,
      page: { limit: Math.max(req.ids.length, 1), offset: 0 },
    },
    eav,
  );

  // Alias the SELECT to snake_case consumer keys (col.name) so fetched rows
  // speak the same dialect as describe / exposeColumns / projectRow. A bare
  // db.select() would key rows by Drizzle's camelCase prop and any multi-word
  // column would be dropped by projection. Flat shape → rows are flat even with
  // filter leftJoins (no rootTable nesting to unwrap).
  const selectShape = nativeSelectShape(req.entity, eav?.fieldMaps[req.entity]);
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle query-builder type narrows per chained leftJoin; the accumulator cannot be statically typed across a dynamic join list
  let q: any = db.select(selectShape).from(compiled.rootTable);
  for (const j of compiled.joins) q = q.leftJoin(j.table, j.on);
  if (compiled.where) q = q.where(compiled.where);
  q = q.limit(compiled.limit);

  const debug = (q as { toSQL: () => { sql: string; params: unknown[] } }).toSQL();
  const rows = (await q) as Array<Record<string, unknown>>;

  // Merge EAV fields inline so fetched rows carry StageName/Amount/etc. — the
  // agent sees one flat row, never the field_values seam.
  await hydrateEavRows(db, req.entity, rows, eav?.fieldMaps[req.entity]);

  // Expand relationships inline. Each expand path is parsed into a tree, then
  // we walk it depth-first with batched IN queries per segment. Mutates rows
  // in place; original columns stay untouched.
  if (req.expand && req.expand.length > 0) {
    const tree = parseExpandPaths(req.expand);
    await expandRows(db, req.entity, rows, tree, eav);
  }

  return {
    entity: req.entity,
    rows,
    count: rows.length,
    ...(req.include_sql ? { sql: debug.sql, params: debug.params } : {}),
  };
}

export type { EntityName, FetchRequest, FetchResponse, SearchEntityResult };
