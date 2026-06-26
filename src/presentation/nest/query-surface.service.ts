import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { EntityCatalog } from '../../adapters/drizzle/registry/catalog.ts';
import { registerSchema } from '../../adapters/drizzle/registry/schema-registry.ts';
import type { CompareRequest } from '../../internal/analytics/index.ts';
import {
  type AggregateRequest,
  type FetchOptions,
  QueryApplicationService,
  type QueryOptions,
  type ViewingScope,
} from '../../query.application-service.ts';
import type { QuerySurfaceModuleOptions, QuerySurfaceRequester, ScopeUser } from './options.ts';
import { QUERY_SURFACE_DRIZZLE, QUERY_SURFACE_OPTIONS } from './tokens.ts';

// biome-ignore lint/suspicious/noExplicitAny: engine is schema-agnostic; Drizzle's DB type is generic over the host schema, unknown at the package level
type AnyDb = NodePgDatabase<any>;

/**
 * Generic read capability over the host's curated entity set: one
 * describe/query/fetch surface for REST, MCP tools, tRPC, or agent runtimes
 * to project.
 *
 * Scoping is AMBIENT: every method obtains the requester via the
 * host-injected `getRequester` (typically the host's ALS reader) and
 * force-injects that requester's tenancy scope + EAV field-map. Callers never
 * pass identity; a missing boundary throws loudly instead of leaking
 * unscoped data. The engine itself stays scope-agnostic (explicit
 * `QueryServiceOptions`) — this service is the ambient adapter in front
 * of it.
 */
@Injectable()
export class QuerySurfaceService implements OnModuleInit {
  // One engine per requester identity: the engine caches the requester's EAV
  // field-map promise, so reuse avoids re-loading field_definitions per call.
  // Bounded by active users × orgs in practice.
  private readonly engines = new Map<string, QueryApplicationService>();

  constructor(
    @Inject(QUERY_SURFACE_DRIZZLE) private readonly db: AnyDb,
    @Inject(QUERY_SURFACE_OPTIONS)
    private readonly options: QuerySurfaceModuleOptions,
  ) {}

  /** Host's native-column allowlist; consumed by the public use-cases' projection. */
  get exposeColumns(): QuerySurfaceModuleOptions['exposeColumns'] {
    return this.options.exposeColumns;
  }

  onModuleInit(): void {
    // Register the host's curated tables + relations + EAV overlay into the
    // surface once at startup (introspection-derived).
    registerSchema(this.options.schema as never, {
      ...(this.options.eav ? { eav: this.options.eav } : {}),
      ...(this.options.fieldMeta ? { fieldMeta: this.options.fieldMeta } : {}),
      ...(this.options.computed ? { computed: this.options.computed } : {}),
    });
  }

  private engine(asUser?: string): QueryApplicationService {
    const requester = this.options.getRequester();
    const opts = asUser ? { asUser } : undefined;
    // Resolved attribution grain (ADR-0027): part of the cache key so a scope
    // change yields a distinct engine (never a stale-scope cache hit).
    const viewingScope = this.options.viewingScopeFor?.(requester, opts) ?? 'personal';
    const key = this.engineKey(requester, asUser, viewingScope);
    const cached = this.engines.get(key);
    if (cached) return cached;

    const engine = new QueryApplicationService(this.db, {
      actorUserId: requester.userId,
      ...(requester.organizationId ? { actorOrganizationId: requester.organizationId } : {}),
      scope: this.options.scopeFor(requester, opts),
      viewingScope,
      ...(this.options.aggregateModel ? { aggregateModel: this.options.aggregateModel } : {}),
      ...(this.options.tenantGlobalEntities
        ? { tenantGlobalEntities: this.options.tenantGlobalEntities }
        : {}),
      ...(this.options.embed ? { embed: this.options.embed } : {}),
      ...(this.options.semanticColumns ? { semanticColumns: this.options.semanticColumns } : {}),
    });
    this.engines.set(key, engine);
    return engine;
  }

  private engineKey(
    requester: QuerySurfaceRequester,
    asUser?: string,
    viewingScope: ViewingScope = 'personal',
  ): string {
    return `${requester.userId}|${requester.organizationId ?? ''}|${asUser ?? ''}|${viewingScope}`;
  }

  /**
   * Resolve a `scope.user` value (id or email) to a canonical org user id.
   * Returns null when no resolver is bound or the user isn't in the org; the
   * use-case surfaces that as a 400 rather than silently widening scope.
   */
  async resolveAsUser(value: string): Promise<string | null> {
    const resolve = this.options.resolveAsUser;
    if (!resolve) return null;
    return resolve(this.options.getRequester(), value);
  }

  /** Org roster the requester may scope to — for `describe` discovery. */
  listUsers(): Promise<ScopeUser[]> {
    return this.options.listUsers?.(this.options.getRequester()) ?? Promise.resolve([]);
  }

  /** Typed field catalog (incl. the requester's EAV virtual columns). */
  describe(): Promise<EntityCatalog[]>;
  describe(entity: string): Promise<EntityCatalog>;
  describe(entity?: string): Promise<EntityCatalog[] | EntityCatalog> {
    const q = this.engine();
    return entity ? q.describe(entity as never) : q.describe();
  }

  /** Find IDs (+ preview rows) matching a filter. Scope is AND-injected.
   *  `asUser` (a resolved user id) narrows to that user's owned rows. */
  select(entity: string, opts: QueryOptions = {}, asUser?: string) {
    return this.engine(asUser).select(entity as never, opts);
  }

  /** Hydrate IDs into full rows, with optional relational expand. Scope-checked. */
  fetch(entity: string, ids: string[], opts: FetchOptions = {}, asUser?: string) {
    return this.engine(asUser).fetch(entity as never, ids, opts);
  }

  /** Collapse an entity into grouped measure rows. Scope is folded PER SOURCE
   *  into each CTE pre-aggregation; `asUser` narrows the same way select/fetch do. */
  measure(
    entity: string,
    q: AggregateRequest,
    opts: { include_sql?: boolean } = {},
    asUser?: string,
  ) {
    return this.engine(asUser).measure(entity as never, q, opts);
  }

  /** Compare a base aggregate across N labeled variants (aligned + derived, or
   *  delivered separately). Each variant inherits scope via the per-requester engine. */
  compare(entity: string, req: CompareRequest, asUser?: string) {
    return this.engine(asUser).compare(entity as never, req);
  }
}
