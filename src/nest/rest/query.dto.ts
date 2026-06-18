/**
 * Request/response schemas for the generic query REST endpoints
 * (`/v1/query/...`). Package-owned: these are the wire contract of the
 * capability, identical for every host.
 *
 * Two flavors per recursive shape:
 *  - runtime schemas (`filterExpressionSchema`) — true recursive validation
 *    used by `ZodValidationPipe` at the controller boundary;
 *  - doc schemas (`*DocSchema`) — depth-limited variants for OpenAPI
 *    registries, because `@anatine/zod-openapi` collapses `z.lazy` to an
 *    empty schema. Swagger shows two nesting levels plus a description; the
 *    runtime accepts arbitrary depth.
 */
import { z } from 'zod';
import type { FilterExpression } from '../../types.ts';

export const FILTER_OPS = [
  'eq',
  'neq',
  'in',
  'nin',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'contains',
  'startswith',
  'endswith',
  'matches',
  'is_null',
  'is_not_null',
] as const;

const leafFilterSchema = z.object({
  on: z
    .string()
    .min(1)
    .describe(
      'Column key or dotted relation path (e.g. "stage", "account.name", "opportunityContacts.contact.last_name"). EAV fields resolve as columns.',
    ),
  op: z.enum(FILTER_OPS),
  value: z.unknown().optional(),
});

// The wire schema is intentionally permissive: it accepts the NATURAL filter DSL
// ({field: value}, {field: {op: val}}, implicit-AND of fields, and/or/not groups) AND the
// legacy explicit {on,op,value} leaf. Both are normalized to the canonical AST by
// `normalizeFilter` at the engine front door, which performs the real semantic validation and
// raises a 400-mapped `filter:`-prefixed error on a bad shape. Validating the open-ended
// natural grammar in zod would duplicate that logic and reject valid field-named objects, so we
// only assert "it's a non-empty object" here. (`leafFilterSchema` is still consumed by the
// OpenAPI doc schemas below, so it is not dead.)
export const filterExpressionSchema: z.ZodType<FilterExpression> = z
  .record(z.string(), z.unknown())
  .refine((o) => Object.keys(o).length > 0, {
    message: 'filter must be a non-empty object',
  }) as unknown as z.ZodType<FilterExpression>;

const sortSchema = z.object({
  field: z.string().min(1),
  dir: z.enum(['asc', 'desc']),
});

const pageSchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional(),
});

/**
 * Scope selector. Default (omitted, or {as:'org'}) reads the whole org book;
 * {as:'user', user} narrows to one user's owned rows (org anchor still applies).
 * `user` accepts a user id (uuid) OR an email — see GET /describe for the roster.
 */
const scopeSchema = z
  .object({
    as: z.enum(['org', 'user']).default('org'),
    user: z.string().min(1).optional().describe('When as=user: a user id (uuid) or email.'),
  })
  .refine((s) => s.as !== 'user' || !!s.user, {
    message: "scope.user is required when scope.as is 'user'",
  });

/**
 * Rank results by a search method against one text column — a RANKING (order +
 * top-K), distinct from the boolean `filter`. Owns ordering + `limit` when
 * present; any `sort` is ignored (a non-fatal `warnings[]` entry is returned).
 */
const rankBySchema = z
  .object({
    on: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Text column to rank on. OPTIONAL — defaults to the entity's sole rankable text column (e.g. observations → normalized_text), so you usually omit it. See GET /describe for ranking support.",
      ),
    query: z.string().min(1).describe('The search text to rank by.'),
    method: z
      .string()
      .optional()
      .describe(
        'lexical = Postgres full-text (ts_rank, stemmed); semantic = vector similarity. OPTIONAL — defaults to semantic when the entity has an embedding column, else lexical. Value-aliases accepted (similarity/cosine/vector → semantic, keyword/fts/text → lexical).',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe('Top-K after ranking (overrides page.limit).'),
    min_score: z
      .number()
      .optional()
      .describe('Optional score cutoff. Uncalibrated for lexical — prefer limit.'),
    partition_by: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Per-group top-K: partition the ranking by this field and keep the best `limit` rows WITHIN each group instead of overall — e.g. partition_by:"account_id" = the top K most similar per account, across all accounts. Aliases accepted: group_by, per, per_group.',
      ),
    // passthrough: alias keys (group_by, per, top_k, …) must survive validation to reach the
    // service-side normalizeRankBy; unknown keys are dropped there, not 400'd here.
  })
  .passthrough();

export const querySearchRequestSchema = z.object({
  filter: filterExpressionSchema.optional(),
  sort: z.array(sortSchema).optional(),
  page: pageSchema.optional(),
  columns: z.array(z.string()).optional(),
  rank_by: rankBySchema.optional(),
  // Windowed measures: agg() OVER (PARTITION BY …) annotation columns on preview
  // rows (grain preserved). The "selection within query" face of aggregation.
  window: z
    .array(
      z.object({
        on: z.string().min(1),
        agg: z.enum(['sum', 'count', 'count_distinct', 'avg', 'min', 'max']),
        partition_by: z.array(z.string().min(1)),
        as: z.string().regex(/^[a-z_][a-z0-9_]*$/i),
      }),
    )
    .optional(),
  preview: z.boolean().optional(),
  include_sql: z.boolean().optional(),
  scope: scopeSchema.optional(),
});
export type QuerySearchRequestDto = z.infer<typeof querySearchRequestSchema>;

export const queryFetchRequestSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  expand: z.array(z.string()).optional(),
  // Optional refinement filter — runFetch/FetchOptions honor it, so the DTO
  // must allow it through (Zod strips unknown keys, silently dropping it).
  filter: filterExpressionSchema.optional(),
  include_sql: z.boolean().optional(),
  scope: scopeSchema.optional(),
});
export type QueryFetchRequestDto = z.infer<typeof queryFetchRequestSchema>;

// ── Aggregate (collapse to grouped rows) ─────────────────────────────────────

const AGG_OPS = ['count', 'count_distinct', 'sum', 'avg', 'min', 'max'] as const;

const aggMeasureSchema = z.object({
  on: z
    .string()
    .min(1)
    .describe('"*" (count rows), a field key, or "relation.field". EAV fields resolve as columns.'),
  agg: z.enum(AGG_OPS),
  // Source-entity override; else inferred from `on` / the query root. A measure on a
  // different entity is pre-aggregated in its OWN CTE (grain-safe — no fan-out).
  source: z.string().min(1).optional(),
  // Filtered (conditional) measure → agg(...) FILTER (WHERE <predicate>). Canonical
  // FilterExpression leaf/and/or/not (same dialect as `filter`).
  where: filterExpressionSchema.optional(),
  as: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/i)
    .describe('Output column alias (identifier).'),
});

// A by-name reference to a catalog measure (see GET /describe). Expanded to its
// inline definition before validation/compile; usable anywhere an inline measure is.
const measureRefSchema = z.object({
  ref: z.string().min(1).describe('Catalog measure name.'),
  as: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/i)
    .optional()
    .describe('Output alias; defaults to the ref name.'),
});

const aggOrderSchema = z.object({
  on: z.string().min(1).describe('A measure alias or a group-by column.'),
  dir: z.enum(['asc', 'desc']),
});

/**
 * Aggregate request: collapse `entity` (+ each measure's source) into grouped
 * rows. `filter` is the pre-aggregation WHERE (row-local); `having` filters over
 * measure aliases post-aggregation. Tenancy scope is folded PER SOURCE into each
 * CTE underneath — non-bypassable, the caller's `filter` can only narrow it.
 */
// Bare column or dotted "relation.field" path — identifier chars only (the
// engine also assert-idents these; this is the wire-level first line of defense).
const columnPath = z
  .string()
  .min(1)
  .regex(/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)*$/i, 'must be a column key or dotted path');

export const aggregateRequestSchema = z.object({
  measures: z.array(z.union([aggMeasureSchema, measureRefSchema])).min(1),
  group_by: z.array(columnPath).optional(),
  filter: filterExpressionSchema.optional(),
  having: filterExpressionSchema.optional(),
  order_by: z.array(aggOrderSchema).optional(),
  limit: z.number().int().min(1).max(10000).optional(),
  include_sql: z.boolean().optional(),
  scope: scopeSchema.optional(),
});
export type AggregateRequestDto = z.infer<typeof aggregateRequestSchema>;

// ── Compare (base aggregate × N variants, aligned + derived) ─────────────────

const compareVariantSchema = z.object({
  label: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/i)
    .describe('Identifier — becomes the column suffix (<measure>__<label>).'),
  filter: filterExpressionSchema.optional().describe('Variant filter, ANDed with the base filter.'),
});

/**
 * Compare request: run `measures` under each `variant` (a filter override), aligned by
 * `group_by`. `compare.derive` adds delta/pct_change/index vs `compare.baseline` (default
 * = first variant). `delivery:'stitched'` (default) returns one aligned row per group;
 * 'separate' returns the N results unstitched. `order_by`/`limit` rank the STITCHED rows
 * (same top-N compared across variants); `per_variant_top` instead keeps each variant's
 * own top-N and aligns the union (the "how the top-N changed" churn view).
 */
export const compareRequestSchema = z.object({
  measures: z.array(z.union([aggMeasureSchema, measureRefSchema])).min(1),
  variants: z.array(compareVariantSchema).min(2),
  group_by: z.array(columnPath).optional(),
  filter: filterExpressionSchema.optional(),
  compare: z
    .object({
      baseline: z.string().min(1).optional(),
      derive: z.array(z.enum(['delta', 'pct_change', 'index'])).optional(),
    })
    .optional(),
  delivery: z.enum(['stitched', 'separate']).optional(),
  order_by: z.array(aggOrderSchema).optional(),
  limit: z.number().int().min(1).max(10000).optional(),
  per_variant_top: z
    .object({ by: z.string().min(1), n: z.number().int().min(1).max(10000) })
    .optional(),
  scope: scopeSchema.optional(),
});
export type CompareRequestDto = z.infer<typeof compareRequestSchema>;

// ── Doc schemas (for the host's OpenAPI registry) ────────────────────────────

const filterGroupDocLevel = z.union([
  leafFilterSchema,
  z.object({ and: z.array(leafFilterSchema) }),
  z.object({ or: z.array(leafFilterSchema) }),
  z.object({ not: leafFilterSchema }),
]);

export const filterExpressionDocSchema = z
  .union([
    leafFilterSchema,
    z.object({ and: z.array(filterGroupDocLevel) }),
    z.object({ or: z.array(filterGroupDocLevel) }),
    z.object({ not: filterGroupDocLevel }),
  ])
  .describe(
    'Recursive filter expression: a leaf {on, op, value} or an and/or/not combinator of nested filter expressions. Nesting depth is unlimited at runtime; this doc schema shows two levels.',
  );

export const querySearchRequestDocSchema = querySearchRequestSchema.extend({
  filter: filterExpressionDocSchema.optional(),
});

export const querySearchResultDocSchema = z.object({
  ids: z.array(z.string().uuid()),
  total: z.number().int(),
  has_more: z.boolean(),
  preview: z
    .array(z.record(z.unknown()))
    .optional()
    .describe(
      'Preview rows (when preview=true). Text-op matches add a _snippets entry per matched column.',
    ),
  sql: z.string().optional(),
  params: z.array(z.unknown()).optional(),
});

export const queryFetchResponseDocSchema = z.object({
  entity: z.string(),
  rows: z.array(z.record(z.unknown())),
  count: z.number().int(),
  sql: z.string().optional(),
  params: z.array(z.unknown()).optional(),
});

export const aggregateRequestDocSchema = aggregateRequestSchema.extend({
  filter: filterExpressionDocSchema.optional(),
  having: filterExpressionDocSchema.optional(),
});

export const aggregateResponseDocSchema = z.object({
  entity: z.string(),
  rows: z
    .array(z.record(z.unknown()))
    .describe('Grouped rows: each group-by column + each measure alias.'),
  row_count: z.number().int(),
  group_count: z
    .number()
    .int()
    .nullable()
    .describe('Distinct group count (null when the query is not grouped).'),
  warnings: z.array(z.string()).optional(),
  sql: z.string().optional(),
});

export const compareRequestDocSchema = compareRequestSchema.extend({
  filter: filterExpressionDocSchema.optional(),
});

// Discriminated on `delivery` so the published contract matches the runtime union
// exactly: stitched ALWAYS carries group_by/measures/derives/rows; separate carries the
// N labeled result sets (and never the stitched fields).
export const compareResponseDocSchema = z.discriminatedUnion('delivery', [
  z.object({
    delivery: z.literal('stitched'),
    entity: z.string(),
    baseline: z.string(),
    group_by: z.array(z.string()),
    variants: z.array(z.string()).describe('Variant labels, in order.'),
    measures: z.array(z.string()),
    derives: z.array(z.enum(['delta', 'pct_change', 'index'])),
    rows: z
      .array(z.record(z.unknown()))
      .describe('Aligned rows: group keys + <measure>__<variant> (+ __<derive>) columns.'),
    warnings: z.array(z.string()).optional(),
  }),
  z.object({
    delivery: z.literal('separate'),
    entity: z.string(),
    baseline: z.string(),
    variants: z.array(
      z.object({
        label: z.string(),
        rows: z.array(z.record(z.unknown())),
        row_count: z.number().int(),
      }),
    ),
    warnings: z.array(z.string()).optional(),
  }),
]);

export const queryEntityCatalogDocSchema = z.object({
  entity: z.string(),
  fields: z.array(
    z.object({
      key: z.string().describe('Filter/sort handle (snake_case).'),
      label: z.string().optional().describe('Human-friendly name.'),
      type: z.string(),
      nullable: z.boolean(),
      searchable: z.boolean().describe('True when the field supports text-search operators.'),
      note: z.string().optional(),
      enumValues: z.array(z.string()).optional(),
    }),
  ),
  relationships: z.array(
    z.object({
      name: z.string(),
      kind: z.string().describe('belongs_to | has_many'),
      target: z.string().describe('Target entity name.'),
    }),
  ),
});

/**
 * Name → Zod schema map the HOST registers into its OpenAPI registry so the
 * controller's `$ref`-based `@Api*` decorators resolve. The package stays
 * registry-agnostic; the host owns document assembly.
 */
export const QUERY_SURFACE_OPENAPI_SCHEMAS = {
  FilterExpression: filterExpressionDocSchema,
  QuerySearchRequestDto: querySearchRequestDocSchema,
  QueryFetchRequestDto: queryFetchRequestSchema,
  QuerySearchResultDto: querySearchResultDocSchema,
  QueryFetchResponseDto: queryFetchResponseDocSchema,
  QueryEntityCatalogDto: queryEntityCatalogDocSchema,
  AggregateRequestDto: aggregateRequestDocSchema,
  AggregateResponseDto: aggregateResponseDocSchema,
  CompareRequestDto: compareRequestDocSchema,
  CompareResponseDto: compareResponseDocSchema,
} as const;
