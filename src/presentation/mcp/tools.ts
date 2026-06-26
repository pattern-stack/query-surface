// MCP tool surface — the agent-facing shape of the query-surface primitives.
//
// This is a DRIVING adapter (presentation/): it maps the five primitives of
// QueryApplicationService (describe / select / fetch / measure / compare) to MCP tools an
// agent can call. No engine logic lives here — only the tool *shape* (names, descriptions,
// input schemas) and a thin pass-through to the service. The shape is the deliverable: it's
// what an agent reasons over, so the descriptions are written FOR a small model.
//
// Filter inputs ride the forgiving Mongo/Prisma DSL (internal/language/filter-normalize) — the
// engine normalizes `{field: value}` / `{field: {op: val}}` / `{or:[…]}` itself, so tools accept
// loose JSON and let the engine translate + fail loud. Engine refusals (XOR violation, scope gap,
// non-conforming dimension) are surfaced verbatim as `isError` results — they're the trust story,
// the thing that teaches the agent to correct, not noise to swallow.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { CompareRequest } from '../../internal/analytics/index.ts';
import type { EntityName, FilterExpression } from '../../internal/language/types.ts';
import type {
  AggregateRequest,
  FetchOptions,
  QueryOptions,
} from '../../query.application-service.ts';
import type { QueryApplicationService } from '../../query.application-service.ts';

// ── shared schema fragments ──────────────────────────────────────────────────────────────────

/** The forgiving filter DSL. Passed through to the engine's normalizer untouched. */
const FILTER_DOC = [
  'Filter as a forgiving JSON object (Mongo/Prisma style). Accepted forms:',
  '  {"stage":"won"}                      → equals',
  '  {"amount":{"gt":100000}}             → operator (gt/gte/lt/lte/neq/contains/startswith/endswith)',
  '  {"type":{"in":["risk","objection"]}} → in / nin (bare array {"type":[...]} also = in)',
  '  {"amount":{"gte":1000,"lte":5000}}   → multiple ops on one field = AND',
  '  {"closedate":{"is_null":true}}       → null check (false = is_not_null)',
  '  {"stage":"won","amount":{"gt":1}}    → multiple fields = implicit AND',
  '  {"or":[…]} {"and":[…]} {"not":…}     → explicit logic',
  'RELEVANCE (semantic cohort): {"on":"<text col>","op":"relevant","query":"<concept>", "threshold":0.55}',
  '  — MUST carry exactly one of "threshold" (0..1 cosine) OR "top_k" (int). Neither = rejected.',
  '  A relevant leaf makes the response carry a CITATION (cohort definition + cutoff + matched exemplars).',
].join('\n');

const filterArg = z.record(z.string(), z.any()).describe(FILTER_DOC);

/** An inline measure OR a by-name reference to a catalog measure. */
const measureArg = z
  .union([
    z.object({
      on: z.string().describe('"*" (count rows) | fieldKey | "relation.fieldKey"'),
      agg: z.enum(['count', 'count_distinct', 'sum', 'avg', 'min', 'max']),
      as: z.string().describe('output column alias'),
      where: z
        .record(z.string(), z.any())
        .optional()
        .describe('source-local filter for THIS measure only (filtered aggregate)'),
      source: z.string().optional().describe('override source entity (else inferred from `on`)'),
    }),
    z.object({ ref: z.string().describe('name of a catalog measure'), as: z.string().optional() }),
  ])
  .describe(
    'A measure: inline {on,agg,as} or a catalog {ref}. Pre-aggregated in its own source CTE (fan-safe).',
  );

const orderByArg = z
  .array(z.object({ on: z.string(), dir: z.enum(['asc', 'desc']) }))
  .describe('order by output alias(es)');

// ── result helpers ───────────────────────────────────────────────────────────────────────────

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const ok = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});

// Surface engine refusals verbatim — they are the calibration signal (what to fix), not noise.
const fail = (e: unknown): ToolResult => ({
  content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
  isError: true,
});

/** Drop undefined keys so we never pass `field: undefined` into the service options. */
function prune<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

// node-postgres returns numerics (count/sum/bigint/numeric) as STRINGS to avoid precision loss. For
// an agent a count "100" is awkward to reason over, so LOSSLESSLY coerce: a string becomes a number
// ONLY when it round-trips exactly (`String(Number(v)) === v`) — so "100"→100 and "10929000"→10929000,
// while a precision-exceeding "115042.105263157895" or "0.000…" stays a string (no silent rounding),
// and non-numeric strings (names, uuids, dates) are untouched (regex + round-trip both reject them).
// Applied ONLY to the analytical responses (measure/compare), never to fetch()/select() rows — those
// carry arbitrary domain fields where a numeric-looking string may be a semantic id/zip/phone.
export function losslessNumber(v: string): number | string {
  if (v === '' || !/^-?\d+(\.\d+)?$/.test(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) && String(n) === v ? n : v;
}
export function coerceNumbers(v: unknown): unknown {
  if (typeof v === 'string') return losslessNumber(v);
  if (Array.isArray(v)) return v.map(coerceNumbers);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = coerceNumbers(val);
    return out;
  }
  return v;
}

// ── the tools ──────────────────────────────────────────────────────────────────────────────────

/** Tool-surface options. `surfaceFields` sets the DEFAULT field exposure in describe(entity) —
 *  the full catalog stays searchable via `find` regardless (see server.ts QuerySurfaceMcpOptions). */
export interface RegisterToolsOptions {
  surfaceFields?: 'all' | Record<string, string[]>;
}

export function registerQueryTools(
  server: McpServer,
  service: QueryApplicationService,
  opts: RegisterToolsOptions = {},
): void {
  const surfaceFields = opts.surfaceFields;
  // 1. DISCOVER — the agent's first call: the typed catalog + the graph-derived dimensions that
  //    are LEGAL to group_by/filter at this entity's grain (so it never proposes a fan-out dim).
  server.registerTool(
    'describe',
    {
      title: 'Describe the queryable surface',
      description:
        'Learn what you can query and aggregate. Omit `entity` for the entity list. With an entity ' +
        'you get its MEASURES (the `field.agg` combos you can aggregate, e.g. "Amount.sum") and its ' +
        'DIMENSIONS (the fields legal to group_by at that grain) — the curated capabilities, lead with ' +
        'these — plus KEY_FIELDS (the curated filterable fields + their allowed values, e.g. a type ' +
        'taxonomy) so you can write a typed filter without drilling. Hosts can carry thousands of ' +
        'fields, so the full field catalog is NOT dumped: a small ' +
        'sample + the total is returned, and you search the rest by name with `find` (e.g. ' +
        '{entity:"opportunities", find:"stage"}) when you need a column to filter on.',
      inputSchema: {
        entity: z.string().optional().describe('entity name, e.g. "opportunities"; omit for all'),
        find: z
          .string()
          .optional()
          .describe("substring to search this entity's full field catalog (for a filter column)"),
      },
    },
    async ({ entity, find }): Promise<ToolResult> => {
      try {
        if (!entity) {
          const entities = await service.describe();
          return ok({
            entities: entities.map((e) => ({
              entity: e.entity,
              field_count: e.fields.length,
              relationships: e.relationships.map((r) => `${r.name}:${r.kind}→${r.target}`),
            })),
          });
        }
        const catalog = await service.describe(entity as EntityName);
        // Saturated field catalog → a lean agent shape: name+type+eav only (drop the `sources`
        // provenance + the structural `enableRLS` phantom). The full list stays SEARCHABLE via `find`
        // — inclusive (nothing excluded), but never dumped wholesale.
        const fields = catalog.fields
          .filter((f) => f.key !== 'enableRLS')
          .map((f) => ({ name: f.key, type: f.type, eav: f.eav }));

        // Key fields up front WITH their value domains — the curated RETRIEVAL facets
        // (is_key_field) + any field carrying an enum, so an agent can build a typed
        // filter from describe ALONE (e.g. observations.type's taxonomy) without a drill.
        // The long tail stays in `fields` (sample + find); this is the same key-field
        // curation, just carrying the values an agent needs to write the predicate.
        const keyFields = catalog.fields
          .filter((f) => f.key !== 'enableRLS' && (f.preview || (f.enumValues?.length ?? 0) > 0))
          .map((f) => ({
            name: f.key,
            type: f.type,
            ...(f.enumValues?.length ? { values: f.enumValues } : {}),
          }));

        if (find) {
          const q = find.toLowerCase();
          return ok({
            entity,
            matched_fields: fields.filter((f) => f.name.toLowerCase().includes(q)),
          });
        }

        // Curated capabilities lead. Best-effort (an `unavailable` marker, not a hard fail).
        const guard = async <T>(p: Promise<T>): Promise<T | { unavailable: string }> =>
          p.catch((e) => ({ unavailable: e instanceof Error ? e.message : String(e) }));
        const [measures, dims] = await Promise.all([
          guard(service.describeMeasures(entity as EntityName)),
          guard(service.describeConformedDimensions(entity as EntityName)),
        ]);
        // Drop degenerate uuid/identity columns from the groupable view (id/account_id) — keep
        // string/enum/date/bool dims an agent would actually group by.
        const dimensions = Array.isArray(dims) ? dims.filter((d) => d.type !== 'uuid') : dims;

        // Field exposure — host-configurable (surfaceFields):
        //   'all'                    → every field inline (small known schema; no drill needed)
        //   {entity: [names]}        → the host-declared working set for THIS entity (skip the drill)
        //   omitted / no entry       → curated: a small sample + a `find` hint (large/open schema)
        const fmt = (f: { name: string; type: string }) => `${f.name}:${f.type}`;
        const working =
          surfaceFields && surfaceFields !== 'all' ? surfaceFields[entity] : undefined;
        let fieldsOut: Record<string, unknown>;
        if (surfaceFields === 'all') {
          fieldsOut = { total: fields.length, all: fields.map(fmt) };
        } else if (working) {
          const set = new Set(working);
          fieldsOut = {
            total: fields.length,
            fields: fields.filter((f) => set.has(f.name)).map(fmt),
            find_hint: `host working set (${working.length}); ${fields.length} total — describe({entity:"${entity}", find:"<substring>"}) to search the rest`,
          };
        } else {
          const SAMPLE = 12;
          const sample = fields.filter((f) => f.type !== 'uuid').slice(0, SAMPLE);
          fieldsOut = {
            total: fields.length,
            sample: sample.map(fmt),
            find_hint: `${fields.length} fields total — call describe({entity:"${entity}", find:"<substring>"}) to search them all for a filter column`,
          };
        }

        return ok({
          entity,
          measures,
          dimensions,
          key_fields: keyFields,
          relationships: catalog.relationships,
          fields: fieldsOut,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 2. SELECT — find matching IDs at row grain (+ optional preview rows, semantic rank, citation).
  server.registerTool(
    'select',
    {
      title: 'Find matching rows (grain preserved)',
      description:
        'Find records of one entity by STRUCTURED filters OR SEMANTIC/RELEVANCE similarity; returns their ' +
        'IDs and a light preview. Grain is PRESERVED — this selects rows, it does not collapse them. ' +
        'Semantic ranking via rank_by; relevance filtering via op:"relevant". Use this to inspect a cohort ' +
        'or gather IDs to fetch.',
      inputSchema: {
        entity: z.string().describe('entity to select from, e.g. "observations"'),
        filter: filterArg.optional(),
        rank_by: z
          .object({
            on: z
              .string()
              .optional()
              .describe("text column to rank on (defaults to the entity's text column)"),
            method: z.string().optional().describe('"semantic" (embeds query) or "lexical"'),
            query: z.string().optional().describe('the rank query string'),
            limit: z.number().int().positive().optional(),
          })
          .partial()
          .optional()
          .describe('rank + top-K by a search method; owns ordering + limit when present'),
        columns: z
          .array(z.string())
          .optional()
          .describe('preview projection (omit = curated preview fields)'),
        sort: z.array(z.object({ on: z.string(), dir: z.enum(['asc', 'desc']) })).optional(),
        limit: z.number().int().positive().optional().describe('page size (maps to page.limit)'),
        offset: z.number().int().nonnegative().optional(),
        preview: z.boolean().optional().describe('include preview rows (default true here)'),
        include_sql: z.boolean().optional().describe('echo the compiled SQL + bound params'),
        cite_boundary: z
          .boolean()
          .optional()
          .describe('with a relevant leaf, also read the strongest EXCLUDED row'),
      },
    },
    async (a): Promise<ToolResult> => {
      try {
        const opts: QueryOptions = prune({
          filter: a.filter as unknown as FilterExpression | undefined,
          rank_by: a.rank_by as QueryOptions['rank_by'],
          columns: a.columns,
          sort: a.sort,
          page:
            a.limit !== undefined || a.offset !== undefined
              ? prune({ limit: a.limit, offset: a.offset })
              : undefined,
          preview: a.preview ?? true,
          include_sql: a.include_sql,
          citation: a.cite_boundary ? { boundary: true } : undefined,
        }) as QueryOptions;
        return ok(await service.select(a.entity as EntityName, opts));
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 3. FETCH — hydrate known IDs into full rows (+ optional expand of to-one relations).
  server.registerTool(
    'fetch',
    {
      title: 'Hydrate IDs into rows',
      description:
        'Hydrate a set of IDs (from query) into full rows. Optionally refine with a filter and expand ' +
        'to-one relations. Use after query() when you need the full row, not just the preview.',
      inputSchema: {
        entity: z.string(),
        ids: z.array(z.string()).describe('the IDs to hydrate (from a prior query)'),
        filter: filterArg.optional().describe('optional refinement applied to the fetched set'),
        expand: z
          .array(z.string())
          .optional()
          .describe('to-one relations to inline, e.g. ["account"]'),
        include_sql: z.boolean().optional(),
      },
    },
    async (a): Promise<ToolResult> => {
      try {
        const opts: FetchOptions = prune({
          filter: a.filter as unknown as FilterExpression | undefined,
          expand: a.expand,
          include_sql: a.include_sql,
        }) as FetchOptions;
        return ok(await service.fetch(a.entity as EntityName, a.ids, opts));
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 4. MEASURE — collapse to grouped measures, grain-safe (each measure pre-aggregates in its
  //    own source CTE). A global filter must CONFORM on every measure source or the engine refuses.
  server.registerTool(
    'measure',
    {
      title: 'Collapse to grouped measures (grain-safe)',
      description:
        'Collapse an entity to grouped rows with measures (counts, sums, ratios, running totals — not ' +
        'only aggregations). Fan-safe: each measure ' +
        'pre-aggregates in its own source CTE. group_by only accepts CONFORMED dimensions (see describe). ' +
        'A global filter must conform on EVERY measure source or the request is rejected (no silent no-op); ' +
        'for source-local intent use a measure-level `where`. A relevant filter adds a citation.',
      inputSchema: {
        entity: z.string().describe('the anchor / root entity'),
        measures: z
          .array(measureArg)
          .min(1)
          .describe('one or more measures (inline or catalog refs)'),
        group_by: z.array(z.string()).optional().describe('conformed dimension columns'),
        filter: filterArg
          .optional()
          .describe('pre-aggregation filter; must conform on every measure source'),
        having: z
          .record(z.string(), z.any())
          .optional()
          .describe('post-aggregation filter over measure aliases'),
        order_by: orderByArg.optional(),
        limit: z.number().int().positive().optional(),
        include_sql: z.boolean().optional(),
        cite_boundary: z.boolean().optional(),
      },
    },
    async (a): Promise<ToolResult> => {
      try {
        const q: AggregateRequest = prune({
          measures: a.measures,
          group_by: a.group_by,
          filter: a.filter as unknown as FilterExpression | undefined,
          having: a.having as unknown as FilterExpression | undefined,
          order_by: a.order_by,
          limit: a.limit,
        }) as unknown as AggregateRequest;
        const opts = prune({
          include_sql: a.include_sql,
          citation: a.cite_boundary ? { boundary: true } : undefined,
        });
        return ok(coerceNumbers(await service.measure(a.entity as EntityName, q, opts)));
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 5. COMPARE — N labeled variants of one base aggregate, aligned by group key (PoP / A-vs-B).
  server.registerTool(
    'compare',
    {
      title: 'Compare N variants of one aggregate',
      description:
        'Run one base aggregate across ≥2 labeled variants (filter overrides), aligned by group key, ' +
        'with optional delta / pct_change / index vs a baseline variant. A relevance cohort, if any, is ' +
        'defined ONCE on the base filter — a relevant leaf inside a variant is rejected (one cohort for all).',
      inputSchema: {
        entity: z.string(),
        measures: z.array(measureArg).min(1).describe('base measures — the SAME for every variant'),
        variants: z
          .array(z.object({ label: z.string(), filter: filterArg.optional() }))
          .min(2)
          .describe('≥2 labeled variants; each filter overrides/extends the base'),
        group_by: z
          .array(z.string())
          .optional()
          .describe('the alignment key, shared by every variant'),
        filter: filterArg.optional().describe('base filter, ANDed into every variant'),
        baseline: z.string().optional().describe('variant label to derive deltas against'),
        order_by: orderByArg.optional(),
        limit: z.number().int().positive().optional(),
        delivery: z.enum(['stitched', 'separate']).optional(),
        cite_boundary: z.boolean().optional(),
      },
    },
    async (a): Promise<ToolResult> => {
      try {
        const req: CompareRequest = prune({
          measures: a.measures,
          variants: a.variants as unknown as CompareRequest['variants'],
          group_by: a.group_by,
          filter: a.filter as unknown as FilterExpression | undefined,
          compare: a.baseline ? { baseline: a.baseline } : undefined,
          order_by: a.order_by,
          limit: a.limit,
          delivery: a.delivery,
        }) as unknown as CompareRequest;
        const opts = prune({ citation: a.cite_boundary ? { boundary: true } : undefined });
        return ok(coerceNumbers(await service.compare(a.entity as EntityName, req, opts)));
      } catch (e) {
        return fail(e);
      }
    },
  );
}

/** The tool names this adapter registers, in agent-workflow order. Exported for tests/inspection. */
export const QUERY_TOOL_NAMES = ['describe', 'select', 'fetch', 'measure', 'compare'] as const;
