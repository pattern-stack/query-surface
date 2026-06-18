/**
 * NestJS presentation seam for the query-surface engine — import as
 * `@swe-brain/query-surface/nest`. Kept out of the package root export so the
 * engine core stays consumable without @nestjs/common installed.
 *
 * Deliberately NOT exported: the internal use-cases (`use-cases.ts`). External
 * callers integrate via a package presentation (REST module here, MCP
 * projection later), which routes through them; hosts composing querying into
 * their own use-cases inject `QuerySurfaceService`.
 */
export { InvalidQueryError, UnknownEntityError } from './errors.ts';
export type {
  QuerySurfaceModuleOptions,
  QuerySurfaceRequester,
  ScopeInput,
  ScopeUser,
} from './options.ts';
export { QuerySurfaceModule } from './query-surface.module.ts';
export { QuerySurfaceService } from './query-surface.service.ts';
export {
  QUERY_SURFACE_OPENAPI_SCHEMAS,
  type AggregateRequestDto,
  type CompareRequestDto,
  type QueryFetchRequestDto,
  type QuerySearchRequestDto,
} from './rest/query.dto.ts';
export { QuerySurfaceRestModule } from './rest/query-surface-rest.module.ts';
export {
  QUERY_SURFACE_AUTH_GUARD,
  QUERY_SURFACE_DRIZZLE,
  QUERY_SURFACE_OPTIONS,
} from './tokens.ts';
