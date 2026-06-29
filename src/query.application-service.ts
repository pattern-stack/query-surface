// QueryApplicationService — the single composition point for the semantic query
// surface. Consumer-agnostic: an MCP tool, a web UI, the CLI, or a frontend
// filter-builder all construct this one class (`new QueryApplicationService(db)`)
// and call the same three primitives. No framework, no transport, no per-entity
// indirection.
//
//   describe(entity?) → the typed field catalog (queryable fields per model,
//                       assembled from EAV ⊕ Drizzle introspection)
//   select(entity,…)  → find IDs (+ optional preview) matching a FilterExpression
//                       (structured OR semantic/relevance); measure()/compare() collapse
//   fetch(entity,…)   → hydrate IDs into full rows (+ refinement filter / expand)
//
// The pure logic lives underneath (catalog.ts, compiler.ts, service.ts runners);
// this class composes it and owns the actor-scoped EAV context (loaded once,
// cached). See docs/field-catalog-design.md.

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { type EavContext, loadFieldMaps } from './adapters/drizzle/eav/field-map.ts';
import type { ExpandScopeResolver } from './adapters/drizzle/execute/expand.ts';
import {
  buildRelevanceCitation,
  aggregate as runAggregate,
} from './adapters/drizzle/execute/run-drizzle.ts';
import { runFetch, runSearch } from './adapters/drizzle/execute/runners.ts';
import { type EntityCatalog, buildEntityCatalog } from './adapters/drizzle/registry/catalog.ts';
import type { AggregateModel } from './adapters/drizzle/registry/model.ts';
import { registry } from './adapters/drizzle/registry/registry.ts';
import { mapLeaves, walkLeaves } from './internal/analytics/filter-columns.ts';
import { TENANT_GLOBAL, conformedDimensions, runCompare } from './internal/analytics/index.ts';
import type {
  Additivity,
  Agg,
  AggregateInput,
  AggregateResponse,
  CompareRequest,
  CompareResponse,
  CompareSeparateResponse,
  ConformedDim,
  RelevanceCitation,
  ScopeFor,
} from './internal/analytics/index.ts';
import { crispifyRelevant } from './internal/analytics/normalize.ts';
import { ENGINE_ERROR } from './internal/language/error-messages.ts';
import { normalizeRankBy } from './internal/language/rank-normalize.ts';
import type {
  EntityName,
  FetchResponse,
  FilterExpression,
  RankBy,
  RelevantLeaf,
  SearchEntityResult,
  Sort,
  WindowMeasure,
} from './internal/language/types.ts';

/**
 * Per-entity scope predicate — a mandatory, caller-derived filter AND-ed into
 * every query/fetch for that entity (tenancy: user/org). Return undefined to
 * leave an entity unscoped. The package stays domain-agnostic: the consumer
 * supplies this (mirroring their access contract, e.g. an Electric shape-defs
 * table). Scope is non-bypassable — the agent's own filter can only narrow it.
 */
export type ScopeResolver = (entity: EntityName) => FilterExpression | undefined;

/**
 * Explicit opt-out of tenancy scoping — a FIRST-CLASS mode, not an escape hatch.
 * Legitimate for single-tenant databases, company-wide BI / analytics, admin
 * tools, and the eval fixture, where reading across all rows is the intent.
 *
 * It exists so that unscoped is always a DELIBERATE, greppable choice: `scope` is
 * a REQUIRED construction field with no default, so a surface can never become
 * cross-tenant by forgetting to pass a resolver — it must either pass a
 * `ScopeResolver` (tenant-scoped) or `UNSCOPED` (read everything, on purpose).
 */
export const UNSCOPED = 'query-surface:UNSCOPED' as const;
export type Unscoped = typeof UNSCOPED;

/**
 * Read-time ATTRIBUTION grain for interaction-sourced queries (the behavioral
 * attribution fork — ADR-0027). NOT a tenancy filter (that is `ScopeResolver`);
 * this selects *whose activity an observation counts toward*:
 *
 *  - `personal`  — attribute to the interaction's own owner (`user_id`); the
 *                  interaction grain; today's behavior, unchanged. The FLOOR.
 *  - `org_wide`  — attribute to each real participant via the materialized
 *                  `interaction_party` edge grain (owner = `person_id`).
 *
 * The package receives a RESOLVED scope; mapping `actor → connection → scope`
 * is the host's job (it owns the connection directory). Fail-closed: an
 * unknown/absent scope resolves to `personal` — over-attribution must be an
 * explicit `org_wide` opt-in, never a silent default.
 */
export type ViewingScope = 'personal' | 'org_wide';

export interface QueryServiceOptions {
  /** EAV field-map actor — whose `field_definitions` define the virtual columns.
   *  REQUIRED at query time: a missing actor throws rather than silently
   *  resolving another identity's fields. Standalone demos pass an explicit
   *  constant. */
  actorUserId?: string;
  /** When set, field definitions load by org ownership (org-owned defs carry
   *  user_id NULL) instead of per-user ownership. */
  actorOrganizationId?: string;
  /** Per-entity tenancy scope, AND-ed into every select/fetch — and folded PER
   *  SOURCE into each CTE of measure() (a cross-entity measure is scoped to its
   *  OWN entity, not the query root). REQUIRED — no default: pass a `ScopeResolver`
   *  to scope reads to a tenant (user/org), or the explicit `UNSCOPED` sentinel for
   *  single-tenant / BI / admin reads. A real resolver that returns undefined for a
   *  touched entity not declared `tenantGlobalEntities` is a coverage gap → REFUSE
   *  (fail-closed, invariant #3) — never a silent cross-tenant read. */
  scope: ScopeResolver | Unscoped;
  /** Read-time attribution grain for interaction-sourced queries (ADR-0027 W1).
   *  Host-resolved from the viewing connection. Omit ⇒ `personal` (fail-closed).
   *  W1 only THREADS this — the grain-switch dispatch that consumes it is W3, so
   *  setting it is presently a no-op (availability, no behavior change). */
  viewingScope?: ViewingScope;
  /** Host-supplied builder for the analytics model the aggregate engine runs
   *  against (cardinality/EAV registry + DERIVED manifest + Drizzle table/column
   *  refs). Lazy-cached on first aggregate() call (the builder may hit the DB for
   *  the EAV field-map). REQUIRED to use aggregate(); query()/fetch() don't need
   *  it. See the aggregate engine's model.ts / model.dealbrain.ts. */
  aggregateModel?: () => Promise<AggregateModel>;
  /** Entities that intentionally carry NO tenancy (reference/lookup tables). When
   *  `scope` is set, aggregate() FAILS CLOSED on any measure source that `scope`
   *  doesn't cover — UNLESS it's listed here. This makes "tenant-global" an
   *  explicit, auditable decision instead of the silent default a forgotten/typo'd
   *  entity would otherwise get (which would aggregate it cross-tenant). */
  tenantGlobalEntities?: readonly EntityName[];
  /** Embed a query string for `rank_by { method: 'semantic' }` (same model that
   *  produced the stored vectors). Omit → semantic ranking is unsupported. */
  embed?: (text: string) => Promise<number[]>;
  /** `(entity → text column) → embedding column` map; gates which columns
   *  support semantic ranking. */
  semanticColumns?: Record<string, Record<string, string>>;
}

export interface QueryOptions {
  filter?: FilterExpression;
  sort?: Sort[];
  page?: { limit?: number; offset?: number };
  // Explicit projection for preview rows — see SingleSearchQuery.columns.
  // Omit → the entity's curated preview fields.
  columns?: string[];
  // Rank + top-K by a search method; owns ordering + limit when present.
  // Wire-shaped (snake) to flow through the use-case spread; mapped to the engine's `rankBy`
  // in `query()`. `method` is the RAW wire value (any string) — normalizeRankBy + the service
  // conform/default it to the canonical 'semantic'|'lexical' before compile.
  rank_by?: Omit<RankBy, 'method'> & { method?: string };
  // Windowed measures: agg() OVER (PARTITION BY …) annotation columns on preview
  // rows (grain preserved — the "selection within query" face of aggregation).
  window?: WindowMeasure[];
  preview?: boolean;
  include_sql?: boolean;
  // Citation calibration: when a `relevant` leaf is present, the auditable cohort definition
  // is ALWAYS attached. `boundary:true` additionally reads the highest_excluded row (the
  // strongest NON-member, one row past the cutoff) — ON-REQUEST (one extra row scan).
  citation?: { boundary?: boolean };
}

export interface FetchOptions {
  filter?: FilterExpression;
  expand?: string[];
  include_sql?: boolean;
}

/** The aggregate request minus `entity` (carried separately, like query/fetch).
 *  `measures` may be inline OR catalog {ref}s — normalizeAggregate expands them. */
export type AggregateRequest = Omit<AggregateInput, 'entity'>;

/** One advertised measure: a `field.agg` the agent can aggregate (ADR-0024 field-first model).
 *  `name` doubles as a catalog `{ref}` and decomposes to the inline `{ on, agg }`. */
export interface MeasureCatalogEntry {
  /** the catalog ref + discovery handle, e.g. `Amount.sum` */
  name: string;
  /** the LAYER (ADR-0029): a measure is one aggregation pass; always `'measure'` here. */
  layer: 'measure';
  /** the field aggregated, preserved as-is, e.g. `Amount` */
  on: string;
  agg: Agg;
  /** summable-ness of the underlying field (a `non` field refuses SUM) */
  additivity: Additivity;
}

/** One advertised METRIC (ADR-0029): a POST-aggregate composition over collapsed measure legs —
 *  not entity-scoped (its legs may span entities). `name` is the catalog `{ref}`. */
export interface MetricCatalogEntry {
  /** the catalog ref + discovery handle, e.g. `win_rate` */
  name: string;
  layer: 'metric';
  /** the composition shape — `ratio` ships; `cumulative` is type-enumerable (routed to query({window})). */
  kind: 'ratio' | 'cumulative' | 'derived';
  /** ratio: the two atomic leg refs */
  numerator?: string;
  denominator?: string;
  /** cumulative: the accumulated atomic measure (+ optional partition) */
  measure?: string;
  partition_by?: string;
  /** human label, if the host supplied one */
  label?: string;
}

export class QueryApplicationService {
  constructor(
    // biome-ignore lint/suspicious/noExplicitAny: engine is schema-agnostic; Drizzle's DB type is generic over the host schema, unknown at the package level
    private readonly db: NodePgDatabase<any>,
    private readonly options: QueryServiceOptions,
  ) {
    // Defense-in-depth for JS callers (TS already requires `scope`): refuse to
    // build a surface with NO scope decision — never default to cross-tenant reads.
    if ((this.options as { scope?: unknown }).scope === undefined) {
      throw new Error(
        'QueryApplicationService: `scope` is required — pass a ScopeResolver to scope reads to a ' +
          'tenant (user/org), or the explicit UNSCOPED sentinel for single-tenant / BI / admin ' +
          'reads. Refusing to default to unscoped (cross-tenant) reads.',
      );
    }
  }

  // Entities the host declared as carrying NO tenancy (reference/lookup tables) —
  // memoized; construction-fixed. The ONLY per-entity unscoped read inside a real
  // (non-UNSCOPED) resolver; everything else fails closed.
  private _tenantGlobals?: Set<string>;
  private get tenantGlobals(): Set<string> {
    return (this._tenantGlobals ??= new Set<string>(this.options.tenantGlobalEntities ?? []));
  }

  // The aggregate analytics model, lazy-built once on first aggregate() call.
  // The builder may hit the DB (EAV field-map), so it's async + memoized — same
  // pattern as the actor EAV context, but cacheable here because the analytics
  // manifest is structural (registry + tags), not live curation.
  private aggregateModelPromise?: Promise<AggregateModel>;

  // Actor-scoped EAV field maps — resolved FRESH on every call, never memoized.
  // The actor (whose field_definitions define the EAV virtual columns) comes
  // from options.actorUserId. It is REQUIRED: a missing actor must fail loudly
  // rather than silently resolve another identity's fields. Callers without a
  // real actor (e.g. the standalone POC demo) pass an explicit constant.
  //
  // Not cached: `field_definitions.is_visible` is live seller curation, and a
  // per-instance memo (combined with this engine being reused per-requester for
  // the process lifetime) made curation edits invisible until a restart. The
  // underlying read is uncached too (see loadFieldMap); the cost is a handful of
  // indexed lookups per request, paid so describe/query always reflect current
  // curation.
  private eav(): Promise<EavContext> {
    const actorUserId = this.options.actorUserId;
    if (!actorUserId) {
      throw new Error(
        'QueryApplicationService: options.actorUserId is required — EAV field ' +
          'resolution has no actor to scope to.',
      );
    }
    return loadFieldMaps(this.db, {
      userId: actorUserId,
      ...(this.options.actorOrganizationId
        ? { organizationId: this.options.actorOrganizationId }
        : {}),
    });
  }

  // AND the entity's tenancy scope into the caller's filter. Scope is
  // non-bypassable: it always applies; the caller's filter can only narrow it.
  // FAIL-CLOSED (invariant #3): a real resolver that returns undefined for the
  // ROOT entity — not declared tenant-global — is a coverage gap → REFUSE, never
  // read it unscoped. Only the explicit UNSCOPED mode (or a declared tenant-global
  // entity) reads without a predicate.
  private scoped(entity: EntityName, filter?: FilterExpression): FilterExpression | undefined {
    if (this.options.scope === UNSCOPED) return filter; // deliberate unscoped (BI / admin / single-tenant)
    const s = this.options.scope(entity);
    if (s) return filter ? { and: [s, filter] } : s;
    if (this.tenantGlobals.has(entity)) return filter; // declared no-tenancy → read unscoped, by decision
    throw new Error(
      `${ENGINE_ERROR.SCOPE}: entity "${entity}" has no tenancy scope and was not declared ` +
        'TENANT_GLOBAL — refusing to read it unscoped (scope coverage gap)',
    );
  }

  /**
   * The resolved viewing attribution grain (ADR-0027). FAIL-CLOSED: an unset or
   * unknown scope is `personal` — org_wide attribution is opt-in only. Exposed
   * (read-only) so the W3 grain-switch dispatch and tests can read it; W1 only
   * makes it AVAILABLE — no caller branches on it yet.
   */
  get viewingScope(): ViewingScope {
    return this.options.viewingScope === 'org_wide' ? 'org_wide' : 'personal';
  }

  /**
   * No-op, retained for API compatibility. The actor EAV context is no longer
   * memoized (it is resolved fresh per call), so there is nothing to reset.
   */
  resetCache(): void {}

  /** Typed field catalog for one entity, or all registered entities. */
  async describe(entity: EntityName): Promise<EntityCatalog>;
  async describe(): Promise<EntityCatalog[]>;
  async describe(entity?: EntityName): Promise<EntityCatalog | EntityCatalog[]> {
    const eav = await this.eav();
    if (entity) return buildEntityCatalog(entity, eav.fieldMaps[entity]);
    return (Object.keys(registry) as EntityName[]).map((e) =>
      buildEntityCatalog(e, eav.fieldMaps[e]),
    );
  }

  /**
   * Graph-derived conformed dimensions for an entity (ADR-0024): its own dimension fields
   * ∪ the dimension fields of every entity reachable by an UNAMBIGUOUS to-one (belongs_to)
   * path. These are the dimensions legal to `group_by` / filter at this entity's grain —
   * advertised PER metric source so an agent never proposes a dimension that would fan out.
   * Requires the aggregate model (the role-tagged analytics manifest); the conformed set is
   * derived from the join graph, never hand-listed. (REST/`describe` payload folding is
   * deferred to the hexagonal reorg — the EAV catalog/projection stays frozen for now.)
   */
  async describeConformedDimensions(entity: EntityName): Promise<ConformedDim[]> {
    const model = await this.aggregateModel();
    // Unknown entity → 404 (UNKNOWN_ENTITY), matching aggregate/query/fetch, rather than a
    // silent empty set (which would read as "this entity has no dimensions").
    if (!model.analytics[entity as string]) {
      throw new Error(`${ENGINE_ERROR.UNKNOWN_ENTITY}${entity}`);
    }
    return conformedDimensions(model.analytics, entity as string);
  }

  /**
   * The aggregatable measures advertised for an entity (ADR-0024 field-first model): the catalog's
   * atomic entries sourced on it — one `field.agg` per allowed aggregation (`Amount.sum`,
   * `Amount.avg`, …, `Probability.avg`). Surfaced so an agent DISCOVERS what it can aggregate
   * rather than guessing a measure name; the field name is preserved. Requires the aggregate model.
   */
  async describeMeasures(entity: EntityName): Promise<MeasureCatalogEntry[]> {
    const model = await this.aggregateModel();
    if (!model.analytics[entity as string]) {
      throw new Error(`${ENGINE_ERROR.UNKNOWN_ENTITY}${entity}`);
    }
    const measures: MeasureCatalogEntry[] = [];
    for (const [name, def] of Object.entries(model.catalog ?? {})) {
      // Only atomic measures are entity-sourced; metrics (ratio/cumulative/derived) compose them
      // across entities and are advertised by describeMetrics() (ADR-0029, not entity-scoped).
      if (def.kind !== 'atomic' || def.source !== (entity as string)) continue;
      measures.push({ name, layer: 'measure', on: def.on, agg: def.agg, additivity: def.additivity });
    }
    return measures.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * The METRIC layer (ADR-0029): every non-atomic catalog entry — post-aggregate compositions
   * (`ratio` now; `cumulative` is type-enumerable but routed to `query({ window })`; `derived` is
   * the planned subtractive/weighted kind). NOT entity-scoped — a metric's legs may span entities,
   * so unlike describeMeasures() this takes no entity. Surfaced so an agent/UI can group the
   * catalog by layer (measure vs metric) and call a metric by its `{ref}`.
   */
  async describeMetrics(): Promise<MetricCatalogEntry[]> {
    const model = await this.aggregateModel();
    const metrics: MetricCatalogEntry[] = [];
    for (const [name, def] of Object.entries(model.catalog ?? {})) {
      if (def.kind === 'atomic') continue;
      const label = 'label' in def && def.label ? { label: def.label } : {};
      if (def.kind === 'ratio') {
        metrics.push({ name, layer: 'metric', kind: 'ratio', numerator: def.numerator, denominator: def.denominator, ...label });
      } else if (def.kind === 'cumulative') {
        metrics.push({ name, layer: 'metric', kind: 'cumulative', measure: def.measure, ...(def.partition_by ? { partition_by: def.partition_by } : {}), ...label });
      }
    }
    return metrics.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Find IDs (+ optional preview rows) matching a filter. */
  async select(entity: EntityName, opts: QueryOptions = {}): Promise<SearchEntityResult> {
    const eav = await this.eav();
    // Normalize rank_by aliases (group_by/per → partition_by, top_k → limit, quoted keys),
    // then fill rank_by.on with the entity's default text column when the caller omits it —
    // the one field agents reliably forget, and almost always unambiguous.
    const rankBy = this.withDefaultMethod(
      entity,
      this.withDefaultRankOn(entity, normalizeRankBy(opts.rank_by)),
    );
    // Semantic rank: resolve the query vector + embedding column here (the
    // service owns the async embed() call; compile stays synchronous).
    const rankSemantic = await this.resolveSemanticRank(entity, rankBy);
    // Defuzzify any `op:'relevant'` filter leaf (embed → {vector, embeddingColumn}) BEFORE scope
    // is AND-ed on — scope leaves are value ops, so resolving the caller's filter first is safe.
    // Then crispify (relevant → sim_gte/sim_topk) HERE: compiler.ts's normalizeFilter is sync, so
    // the async embed walk + this defuzzify are service-owned, lowering the filter to crisp leaves
    // before compile (the aggregate path crispifies inside run-drizzle instead).
    const resolved = await this.resolveRelevantFilters(entity, opts.filter);
    const filter = resolved ? crispifyRelevant(resolved) : resolved;
    // Citation is MANDATORY whenever a relevant leaf is present — computed from the RESOLVED
    // (vector-stamped, pre-crispify) filter by a row-grain companion query, in parallel with
    // the main search (both await below). Absent when no relevant leaf fired.
    const [result, citation] = await Promise.all([
      runSearch(
        this.db,
        {
          entity,
          filter: this.scoped(entity, filter),
          sort: opts.sort,
          page: opts.page,
          columns: opts.columns,
          rankBy,
          rankSemantic,
          window: opts.window,
        },
        { preview: opts.preview, include_sql: opts.include_sql },
        eav,
      ),
      this.citationFor(entity, resolved, opts.citation?.boundary),
    ]);
    return citation ? { ...result, citation } : result;
  }

  /** Default `rank_by.on` to the entity's sole registered semantic text column when the caller
   *  omits it (small models reliably forget it, and it's almost always unambiguous). With 0 or
   *  >1 candidates we can't safely choose — surface a clear 400 rather than guess. */
  private withDefaultRankOn(entity: EntityName, rankBy?: RankBy): RankBy | undefined {
    if (!rankBy || rankBy.on) return rankBy;
    const candidates = Object.keys(this.options.semanticColumns?.[entity] ?? {});
    if (candidates.length === 1) return { ...rankBy, on: candidates[0] };
    throw new Error(
      `${ENGINE_ERROR.RANK} rank_by.on is required for '${entity}' (no single default text column to rank on)`,
    );
  }

  /** Default `rank_by.method` when omitted (small models often skip it), and reject an
   *  unrecognized value (normalizeRankBy already aliased the common synonyms). Default =
   *  'semantic' when an embedding column exists for `on` (or any), else 'lexical'. */
  private withDefaultMethod(entity: EntityName, rankBy?: RankBy): RankBy | undefined {
    if (!rankBy) return rankBy;
    if (rankBy.method === 'semantic' || rankBy.method === 'lexical') return rankBy;
    if (rankBy.method == null) {
      const cols = this.options.semanticColumns?.[entity] ?? {};
      const hasSemantic = rankBy.on ? !!cols[rankBy.on] : Object.keys(cols).length > 0;
      return { ...rankBy, method: hasSemantic ? 'semantic' : 'lexical' };
    }
    throw new Error(
      `${ENGINE_ERROR.RANK} unknown method '${rankBy.method}' — use 'semantic' or 'lexical' (aliases: similarity/cosine/vector → semantic, keyword/fts/text → lexical)`,
    );
  }

  /** For a `method:'semantic'` rank, resolve `{ vector, embeddingColumn }` from
   *  the host-injected embed() port + semantic-column registry. Fails loud (→
   *  400) when the column isn't semantically searchable or no embed is bound. */
  private async resolveSemanticRank(
    entity: EntityName,
    rankBy?: RankBy,
  ): Promise<{ vector: number[]; embeddingColumn: string } | undefined> {
    if (rankBy?.method !== 'semantic') return undefined;
    const embeddingColumn = rankBy.on
      ? this.options.semanticColumns?.[entity]?.[rankBy.on]
      : undefined;
    if (!embeddingColumn) {
      throw new Error(
        `${ENGINE_ERROR.RANK} column '${rankBy.on}' does not support semantic ranking on '${entity}'`,
      );
    }
    if (!this.options.embed) {
      throw new Error(`${ENGINE_ERROR.RANK} semantic ranking is not configured (no embed port)`);
    }
    const vector = await this.options.embed(rankBy.query);
    return { vector, embeddingColumn };
  }

  /**
   * Resolve every `op:'relevant'` leaf in a filter tree to its `{ vector, embeddingColumn }`
   * BEFORE compile (the service owns the async embed() call; compile stays synchronous) — the
   * tree-level generalization of `resolveSemanticRank`. Walks the predicate with the SAME
   * and/or/not+leaf recursion as `filterColumnPaths` (no second walker), embeds each leaf's
   * `query` in parallel, then IMMUTABLY rebuilds the tree stamping `{ vector, embeddingColumn }`
   * onto each relevant leaf (the caller's `filter` is never mutated).
   *
   * Cross-grain: a relevant leaf targets the entity its `on` names — a dotted `on`
   * (`observations.normalized_text`) targets the prefix entity (the CHILD), a bare `on` targets
   * `entity` (the root). The embedding column is resolved via
   * `semanticColumns[<target entity>][<text column>]`, so a cross-grain leaf keys on the child,
   * not the aggregate root. Fail-loud (ENGINE_ERROR-prefixed): no embed bound, the column isn't
   * semantically searchable, or the crisp set isn't EXACTLY ONE of threshold|top_k.
   *
   * Idempotent: a leaf already carrying a `vector` is skipped (compare() resolves base + every
   * variant up front, then delegates each variant to aggregate(), which must not re-embed).
   */
  private async resolveRelevantFilters(
    entity: EntityName,
    filter?: FilterExpression,
  ): Promise<FilterExpression | undefined> {
    if (!filter) return filter;
    const E = ENGINE_ERROR.FILTER;

    // Collect the leaves needing embedding (skip already-resolved ones — idempotency), validating
    // each as we go so a bad leaf fails before we spend any embed() calls.
    const pending: RelevantLeaf[] = [];
    walkLeaves(filter, (leaf) => {
      if ((leaf as { op?: unknown }).op !== 'relevant') return;
      const rel = leaf as RelevantLeaf;
      if (rel.vector) return; // already resolved (compare → variant delegation)
      // The crisp set is EXPLICIT + MANDATORY — EXACTLY ONE of threshold|top_k (the wave-1
      // conform-or-reject discipline: no silent default). Re-validated here even though the
      // front-door normalizer checks it, because a leaf may arrive via the typed object path.
      const hasThreshold = rel.threshold !== undefined;
      const hasTopK = rel.top_k !== undefined;
      if (hasThreshold === hasTopK) {
        throw new Error(
          `${E} a 'relevant' leaf requires EXACTLY ONE of "threshold" or "top_k" (got ${
            hasThreshold ? 'both' : 'neither'
          }) — the crisp set must be explicit, no silent default`,
        );
      }
      pending.push(rel);
    });
    if (pending.length === 0) return filter;

    const embed = this.options.embed;
    if (!embed) {
      throw new Error(`${E} semantic 'relevant' filtering is not configured (no embed port)`);
    }

    // Resolve each leaf's embedding column (against its TARGET entity) + embed its query in
    // parallel. The vector promises are collected then Promise.all-ed so independent embed() calls
    // overlap rather than serialize.
    const resolved = await Promise.all(
      pending.map(async (rel) => {
        const { targetEntity, textColumn } = this.relevantTarget(entity, rel.on);
        const embeddingColumn = this.options.semanticColumns?.[targetEntity]?.[textColumn];
        if (!embeddingColumn) {
          throw new Error(
            `${E} column '${rel.on}' does not support semantic 'relevant' filtering on '${targetEntity}'`,
          );
        }
        const vector = await embed(rel.query);
        return { rel, vector, embeddingColumn };
      }),
    );
    const byLeaf = new Map(resolved.map((r) => [r.rel, r]));

    // IMMUTABLY rebuild — stamp {vector, embeddingColumn} onto each resolved leaf; everything else
    // (including already-resolved relevant leaves and value leaves) passes through untouched.
    return mapLeaves(filter, (leaf) => {
      const hit = byLeaf.get(leaf as RelevantLeaf);
      if (!hit) return leaf;
      return {
        ...(leaf as RelevantLeaf),
        vector: hit.vector,
        embeddingColumn: hit.embeddingColumn,
      };
    }) as FilterExpression;
  }

  /** Split a relevant leaf's `on` into its TARGET entity + text column: a dotted path
   *  (`observations.normalized_text`) targets the prefix entity (cross-grain → the CHILD); a bare
   *  `on` targets the root `entity`. Only the LAST segment is the text column (multi-hop dotted
   *  paths take the final entity.column pair). */
  private relevantTarget(
    entity: EntityName,
    on: string,
  ): { targetEntity: EntityName; textColumn: string } {
    const dot = on.lastIndexOf('.');
    if (dot < 0) return { targetEntity: entity, textColumn: on };
    return { targetEntity: on.slice(0, dot), textColumn: on.slice(dot + 1) };
  }

  /** Hydrate IDs into full rows, with optional refinement filter + relational expand. */
  async fetch(entity: EntityName, ids: string[], opts: FetchOptions = {}): Promise<FetchResponse> {
    const eav = await this.eav();
    // Same defuzzify → crispify the query() refinement path runs: resolve any `op:'relevant'`
    // refinement leaf (async embed) then lower to crisp sim_gte/sim_topk before compile (sync).
    const resolved = await this.resolveRelevantFilters(entity, opts.filter);
    const filter = resolved ? crispifyRelevant(resolved) : resolved;
    return runFetch(
      this.db,
      {
        entity,
        ids,
        filter: this.scoped(entity, filter),
        expand: opts.expand,
        include_sql: opts.include_sql,
      },
      eav,
      // Fold tenancy scope through EVERY expanded relation, fail-closed (invariant #3):
      // the root rows are scoped above, but `expand` traverses to related entities — without
      // this they were read with a bare FK/PK `IN` and no scope (a cross-scope read leak).
      this.expandScopeResolver(),
    );
  }

  /**
   * The fail-closed tenancy-scope resolver `expand` folds through EVERY traversed
   * relation (invariant #3 — scope is per-source and folded through every traversed
   * entity). Mirrors the relevance-citation companion's discipline (`citationFor`): a
   * configured `scope` that returns undefined for a traversed entity — and that entity
   * isn't declared TENANT_GLOBAL — is a coverage gap → REFUSE (never read it unscoped).
   * No `scope` configured at all → undefined: expand runs unscoped, the same
   * trusted/standalone mode the verbs use when no resolver is supplied.
   */
  private expandScopeResolver(): ExpandScopeResolver | undefined {
    const scope = this.options.scope;
    if (scope === UNSCOPED) return undefined; // deliberate unscoped — expand reads unscoped, by decision
    const globals = this.tenantGlobals;
    return (entity: EntityName) => {
      const pred = scope(entity);
      if (pred) return pred;
      if (globals.has(entity)) return undefined; // declared tenant-global → read unscoped, by decision
      throw new Error(
        `${ENGINE_ERROR.EXPAND_SCOPE}: relation "${entity}" has no tenancy scope and was not declared TENANT_GLOBAL — refusing to read it unscoped (scope coverage gap)`,
      );
    };
  }

  // The host's analytics model, built once and memoized. REQUIRED for aggregate()
  // (a missing builder fails loud rather than silently aggregating an empty model).
  private aggregateModel(): Promise<AggregateModel> {
    const build = this.options.aggregateModel;
    if (!build) {
      throw new Error(
        'QueryApplicationService: options.aggregateModel is required to use aggregate() — ' +
          'the host must supply the analytics model builder.',
      );
    }
    // Cache on SUCCESS only: a rejected promise must NOT stick (a transient DB
    // failure on the first call would otherwise poison aggregate() for this
    // requester's whole engine lifetime). On rejection, clear the slot so the
    // next call retries.
    this.aggregateModelPromise ??= build().catch((e) => {
      this.aggregateModelPromise = undefined;
      throw e;
    });
    return this.aggregateModelPromise;
  }

  /**
   * Collapse an entity (+ its measure sources) into grouped aggregate rows.
   * Scope is folded PER SOURCE into each CTE's WHERE pre-aggregation — so a
   * cross-entity measure is scoped to its OWN entity, and scope is
   * non-bypassable (a caller `filter` can only narrow it, never widen). The
   * grain-safe engine (per-source pre-agg + key join) makes fan-out impossible.
   */
  async measure(
    entity: EntityName,
    q: AggregateRequest,
    opts: { include_sql?: boolean; citation?: { boundary?: boolean } } = {},
  ): Promise<AggregateResponse> {
    const model = await this.aggregateModel();
    const scope = this.options.scope;
    // Per-SOURCE scope (not this.scoped(), which folds ROOT scope onto every CTE
    // and would mis-grain a child source on a different entity). FAIL-CLOSED: a
    // source `scope` doesn't cover and isn't declared tenant-global resolves to
    // `undefined`, which the engine REFUSES — never silently unscoped. UNSCOPED →
    // no per-source scope, by deliberate decision (BI / admin / single-tenant).
    const globals = this.tenantGlobals;
    const scopeFor: ScopeFor | undefined =
      scope === UNSCOPED
        ? undefined
        : (src) => scope(src as EntityName) ?? (globals.has(src) ? TENANT_GLOBAL : undefined);
    // Defuzzify any `op:'relevant'` leaf in the global filter (net-new embed on this path).
    // Idempotent: a leaf already carrying a vector (compare → per-variant delegation) is skipped,
    // so this never re-embeds a filter compare() already resolved.
    const filter = await this.resolveRelevantFilters(entity, q.filter);
    // Citation is MANDATORY when a relevant leaf is present — a row-grain companion query (the
    // collapsing aggregate SQL has no row id/text to cite), run in parallel with the aggregate.
    const [result, citation] = await Promise.all([
      runAggregate(
        this.db,
        model,
        { ...q, entity, ...(filter !== undefined ? { filter } : {}) },
        { ...(scopeFor ? { scopeFor } : {}), include_sql: opts.include_sql },
      ),
      this.citationFor(entity, filter, opts.citation?.boundary),
    ]);
    return citation ? { ...result, citation } : result;
  }

  /**
   * Compare a base aggregate across N labeled variants (filter overrides), aligned by
   * group key, with optional delta/pct_change/index vs a baseline. Each variant runs
   * through aggregate() — so fan-safety + fail-closed scope are inherited per variant —
   * then `stitchCompare` (pure) aligns + derives. `delivery:'separate'` returns the N
   * results unstitched for the client to align with the SAME stitch function.
   */
  async compare(
    entity: EntityName,
    req: CompareRequest,
    opts: { citation?: { boundary?: boolean } } = {},
  ): Promise<CompareResponse | CompareSeparateResponse> {
    // A relevance cohort is defined ONCE — on the BASE filter only (ruling b). A variant-LOCAL
    // relevant leaf would fabricate a different cohort per variant (the very cross-variant
    // mismatch compare() exists to prevent), so REJECT it.
    for (const v of req.variants ?? []) {
      if (v.filter && this.hasRelevantLeaf(v.filter)) {
        throw new Error(
          `${ENGINE_ERROR.FILTER} a 'relevant' leaf is only allowed in compare()'s base filter, ` +
            `not in variant '${v.label}' — one cohort is defined for all variants`,
        );
      }
    }
    // Resolve the base filter's relevant leaves ONCE up front. Each variant then runs through
    // aggregate(), which is idempotent on already-resolved leaves — so the cohort vector is
    // embedded exactly once, not re-embedded per variant.
    const filter = await this.resolveRelevantFilters(entity, req.filter);
    const resolvedReq: CompareRequest = { ...req, ...(filter !== undefined ? { filter } : {}) };
    // Citation is MANDATORY when the BASE filter carries a relevant leaf (ruling b: ONE cohort
    // for all variants). Computed ONCE from the resolved base filter, attached to the result.
    const [result, citation] = await Promise.all([
      runCompare(entity, resolvedReq, (agg) => this.measure(entity, agg)),
      this.citationFor(entity, filter, opts.citation?.boundary),
    ]);
    return citation ? { ...result, citation } : result;
  }

  /** True iff a filter tree carries any `op:'relevant'` leaf (resolved or not). */
  private hasRelevantLeaf(filter: FilterExpression): boolean {
    return !!this.firstRelevantLeaf(filter);
  }

  /** The FIRST `op:'relevant'` leaf in a filter tree (undefined when none). Citation is one
   *  cohort per request, so the first relevant leaf defines it (a relevant leaf is the
   *  selection axis — multiple would be an unusual compound cohort; v1 cites the first). */
  private firstRelevantLeaf(filter?: FilterExpression): RelevantLeaf | undefined {
    if (!filter) return undefined;
    let hit: RelevantLeaf | undefined;
    walkLeaves(filter, (leaf) => {
      if (!hit && (leaf as { op?: unknown }).op === 'relevant') hit = leaf as RelevantLeaf;
    });
    return hit;
  }

  /**
   * Build the MANDATORY calibration citation for a request whose (already-resolved) filter
   * carries a relevant leaf. Runs a row-grain COMPANION query over the semantic entity
   * (run-drizzle.buildRelevanceCitation), reusing the leaf's already-resolved vector (NO second
   * embed). The semantic entity's tenancy scope is folded in (#3) via the same `scope` resolver
   * the verbs use. Returns undefined when no relevant leaf is present (citation is then absent).
   */
  private async citationFor(
    entity: EntityName,
    resolvedFilter?: FilterExpression,
    boundary?: boolean,
  ): Promise<RelevanceCitation | undefined> {
    const leaf = this.firstRelevantLeaf(resolvedFilter);
    if (!leaf) return undefined;
    const model = await this.aggregateModel();
    const { targetEntity } = this.relevantTarget(entity, leaf.on);
    // FAIL-CLOSED (#3): the citation companion reads the semantic entity at ROW grain, so its
    // tenancy scope must be folded in exactly like the verbs'. A configured `scope` that returns
    // undefined for targetEntity — and isn't declared TENANT_GLOBAL — is a coverage gap → REFUSE,
    // never read it unscoped (mirrors compile-drizzle's scopeSqlFor; the citation must not leak
    // rows the cohort number was computed without).
    const scope = this.options.scope;
    let scopeForEntity: FilterExpression | undefined;
    if (scope !== UNSCOPED) {
      const decision =
        scope(targetEntity) ?? (this.tenantGlobals.has(targetEntity) ? TENANT_GLOBAL : undefined);
      if (decision === undefined) {
        throw new Error(
          `${ENGINE_ERROR.AGGREGATE} relevance citation: source "${targetEntity}" has no tenancy scope and was not declared TENANT_GLOBAL — refusing to read it unscoped (scope coverage gap)`,
        );
      }
      scopeForEntity = decision === TENANT_GLOBAL ? undefined : decision;
    }
    return buildRelevanceCitation(this.db, model, entity, leaf, {
      ...(boundary ? { boundary } : {}),
      ...(scopeForEntity ? { scopeForEntity } : {}),
    });
  }
}
