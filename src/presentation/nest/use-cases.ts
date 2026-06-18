import { Injectable } from '@nestjs/common';
import type { CompareRequest } from '../../internal/analytics/index.ts';
import type {
  AggregateRequest,
  FetchOptions,
  QueryOptions,
} from '../../query.application-service.ts';
import { InvalidQueryError, UnknownEntityError, translateEngineErrors } from './errors.ts';
import type { ScopeInput, ScopeUser } from './options.ts';
import {
  type PublicEntityCatalog,
  buildProjectionIndex,
  projectCatalog,
  projectRow,
  projectRowDeep,
  publicKeySet,
} from './projection.ts';
import type { QuerySurfaceService } from './query-surface.service.ts';

export interface DescribeAllResult {
  entities: PublicEntityCatalog[];
  users: ScopeUser[];
}

/**
 * Turn the request `scope` into a resolved user id (or undefined for org-wide).
 * Throws InvalidQueryError (→ 400) on a missing/unknown user — never silently
 * falls back to org-wide, which would over-return.
 */
async function resolveScope(
  querySurface: QuerySurfaceService,
  scope?: ScopeInput,
): Promise<string | undefined> {
  if (!scope || scope.as !== 'user') return undefined;
  if (!scope.user) {
    throw new InvalidQueryError("scope.user is required when scope.as is 'user'");
  }
  const asUser = await querySurface.resolveAsUser(scope.user);
  if (!asUser) {
    throw new InvalidQueryError(`Unknown user for scope: ${scope.user}`);
  }
  return asUser;
}

/**
 * INTERNAL external-call-path use-cases — deliberately NOT exported from the
 * package barrel. Every protocol presentation the package ships (REST router
 * today, MCP projection later) goes through these, so call-path policy lives
 * exactly once: typed-error translation, and the CONSUMER PROJECTION (lean
 * field shape + native-column allowlist) so the contract never leaks the
 * engine's introspection internals or un-curated columns.
 *
 * Hosts integrating querying into their OWN use-cases inject
 * `QuerySurfaceService` instead — that returns the RAW shape (full columns,
 * all facets); the public projection is external-call-path policy only.
 *
 * Identity is protocol-ignorant by construction: these take ONLY the request
 * payload (entity, filter, ids). The service resolves the host-injected
 * `getRequester()` per call; the boundary is the only place that enters a
 * context.
 */

@Injectable()
export class DescribeUseCase {
  constructor(private readonly querySurface: QuerySurfaceService) {}

  all(): Promise<DescribeAllResult> {
    return translateEngineErrors(async () => {
      const [catalogs, users] = await Promise.all([
        this.querySurface.describe(),
        this.querySurface.listUsers(),
      ]);
      return {
        entities: catalogs.map((c) => projectCatalog(c, this.querySurface.exposeColumns)),
        users,
      };
    });
  }

  async one(entity: string): Promise<PublicEntityCatalog> {
    const catalog = await translateEngineErrors(() => this.querySurface.describe(entity));
    if (!catalog) throw new UnknownEntityError(entity);
    return projectCatalog(catalog, this.querySurface.exposeColumns);
  }
}

@Injectable()
export class SearchUseCase {
  constructor(private readonly querySurface: QuerySurfaceService) {}

  execute(entity: string, opts: QueryOptions & { scope?: ScopeInput } = {}) {
    return translateEngineErrors(async () => {
      const { scope, ...queryOpts } = opts;
      const asUser = await resolveScope(this.querySurface, scope);
      const result = await this.querySurface.query(entity, queryOpts, asUser);
      if (!result.preview || result.preview.length === 0) return result;
      const catalog = await this.querySurface.describe(entity);
      const keys = publicKeySet(catalog, this.querySurface.exposeColumns);
      return {
        ...result,
        preview: result.preview.map((r) => projectRow(r, keys)),
      };
    });
  }
}

@Injectable()
export class AggregateUseCase {
  constructor(private readonly querySurface: QuerySurfaceService) {}

  execute(
    entity: string,
    body: AggregateRequest & { scope?: ScopeInput; include_sql?: boolean } = { measures: [] },
  ) {
    return translateEngineErrors(async () => {
      const { scope, include_sql, ...q } = body;
      const asUser = await resolveScope(this.querySurface, scope);
      // No row projection: grouped rows carry no entity id and no EAV virtual
      // columns to allowlist — the result is named measure aliases + group keys.
      return this.querySurface.aggregate(entity, q, { include_sql }, asUser);
    });
  }
}

@Injectable()
export class CompareUseCase {
  constructor(private readonly querySurface: QuerySurfaceService) {}

  execute(entity: string, body: CompareRequest & { scope?: ScopeInput }) {
    return translateEngineErrors(async () => {
      const { scope, ...req } = body;
      const asUser = await resolveScope(this.querySurface, scope);
      // No row projection: stitched rows are group keys + variant/derive columns (no
      // entity id, no EAV virtual columns to allowlist); separate rows are aggregate rows.
      return this.querySurface.compare(entity, req, asUser);
    });
  }
}

@Injectable()
export class FetchUseCase {
  constructor(private readonly querySurface: QuerySurfaceService) {}

  execute(entity: string, ids: string[], opts: FetchOptions & { scope?: ScopeInput } = {}) {
    return translateEngineErrors(async () => {
      const { scope, ...fetchOpts } = opts;
      const asUser = await resolveScope(this.querySurface, scope);
      // Project the full row tree: the root row AND any `expand`ed relations,
      // each against its own entity's allowlist — so expanded relations can't
      // leak tenant FKs / provider_metadata the parent's allowlist drops.
      // `fetch` and `describe` are independent reads (each resolves the EAV
      // field-map fresh now that it's uncached), so run them concurrently
      // rather than paying two serial field-map round-trips.
      const [result, catalogs] = await Promise.all([
        this.querySurface.fetch(entity, ids, fetchOpts, asUser),
        this.querySurface.describe(),
      ]);
      const index = buildProjectionIndex(catalogs, this.querySurface.exposeColumns);
      return {
        ...result,
        rows: result.rows.map((r) => projectRowDeep(r, entity, index)),
      };
    });
  }
}
