/**
 * DI tokens the HOST app binds when mounting `QuerySurfaceModule` — the same
 * package/host seam pattern as `@repo/integrations` (`Symbol.for`, so tokens
 * match by value across package/host import boundaries).
 *
 * The package owns the capability (engine + Nest service); the host owns the
 * policy: which database, which curated entity set, how requests are scoped,
 * and where the ambient requester comes from.
 */

/** Drizzle database handle (host binds its own DRIZZLE provider). */
export const QUERY_SURFACE_DRIZZLE = Symbol.for('QUERY_SURFACE_DRIZZLE');

/** `QuerySurfaceModuleOptions` — curated schema, EAV overlay, scope policy,
 *  requester source. See `options.ts`. */
export const QUERY_SURFACE_OPTIONS = Symbol.for('QUERY_SURFACE_OPTIONS');

/** The host's real auth guard (a `CanActivate`) for the package REST routes —
 *  e.g. dealbrain binds its ApiKeyGuard. Consumed by `QuerySurfaceAuthGuard`. */
export const QUERY_SURFACE_AUTH_GUARD = Symbol.for('QUERY_SURFACE_AUTH_GUARD');
