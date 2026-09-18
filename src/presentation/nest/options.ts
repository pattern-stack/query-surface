import type { TablesRelationalConfig } from 'drizzle-orm';
import type { AggregateModel } from '../../adapters/drizzle/registry/model.ts';
import type { RegisterSchemaOptions } from '../../adapters/drizzle/registry/schema-registry.ts';
import type { ScopeResolver, Unscoped, ViewingScope } from '../../query.application-service.ts';

/**
 * The identity a query runs as. Shape-compatible with the host's ambient
 * requester context (e.g. `@repo/shared/requester-context`'s
 * `RequesterContext`) without depending on it — the package stays portable;
 * the host injects how to obtain one via `getRequester`.
 */
export interface QuerySurfaceRequester {
  userId: string;
  /** Org-owned EAV field definitions resolve by this when present. */
  organizationId?: string | null;
}

/**
 * Static per-entity native-column allowlist (snake_case keys, the catalog's
 * field keys). Governs ONLY native columns — EAV fields are curated separately
 * via `is_visible`, and `id` always passes. Not configurable per-org; just the
 * columns the host logically returns for each object shape.
 */
export type ExposeColumns = Record<string, readonly string[]>;

/**
 * Per-request scope selector (the `scope` field on search/fetch). Default is
 * org-wide; `as: 'user'` narrows to one user's owned rows. `user` accepts a
 * user id OR an email — the host's `resolveAsUser` turns it into a canonical
 * org user id. The org anchor is always AND-ed underneath, so an out-of-org
 * target intersects to empty (narrowing only, never escalation).
 */
export interface ScopeInput {
  as: 'org' | 'user';
  /** When as='user': a user id (uuid) or email. */
  user?: string;
}

/** A user the caller may scope to — surfaced in `describe` for discovery. */
export interface ScopeUser {
  id: string;
  email: string;
  name: string | null;
}

/**
 * Host-supplied policy for the mounted query surface.
 *
 * Everything here is the host's domain knowledge: the curated entity set and
 * its relations, the EAV overlay, the tenancy predicate per entity, and the
 * source of the ambient requester. The package contributes the mechanics
 * (engine, per-requester caching, describe/query/fetch surface).
 */
export interface QuerySurfaceModuleOptions {
  /** The host's Drizzle 1.0 relational config — `defineRelations(schema, …)` output —
   *  passed to `registerSchema` once at module init. */
  relations: TablesRelationalConfig;
  /** EAV overlay per entity (see `RegisterSchemaOptions['eav']`). */
  eav?: RegisterSchemaOptions['eav'];
  /** Per-entity fieldMeta overrides (see `RegisterSchemaOptions['fieldMeta']`).
   *  Applied on top of any qField metadata stamped on the table — use for plain
   *  pgTable entities where annotations live host-side (e.g. observations). */
  fieldMeta?: RegisterSchemaOptions['fieldMeta'];
  /** Per-entity computed metrics (see `RegisterSchemaOptions['computed']`) —
   *  aggregate-over-relationship fields surfaced as first-class columns. */
  computed?: RegisterSchemaOptions['computed'];
  /** Non-bypassable per-entity tenancy scope for a requester — AND-ed into
   *  every select/fetch. `opts.asUser` (a resolved user id) narrows to one
   *  user's owned rows, composed AFTER the org anchor. Return the `UNSCOPED`
   *  sentinel for a deliberately unscoped surface (e.g. a company-BI REST host);
   *  it must be an explicit choice, never reachable by omission. */
  scopeFor: (
    requester: QuerySurfaceRequester,
    opts?: { asUser?: string },
  ) => ScopeResolver | Unscoped;
  /**
   * Read-time ATTRIBUTION grain for the requester (ADR-0027 W1) — distinct from
   * `scopeFor` (tenancy). Resolves the viewing connection's scope: `personal`
   * (owner grain, the floor) vs `org_wide` (participant/edge grain). Sync — the
   * host pre-resolves from the requester's connection context. Omit ⇒ every
   * engine is `personal` (fail-closed). Multi-connection mixed scope (OQ-1) and
   * async connection lookup are the host's concern / W5; W1 only THREADS the
   * resolved value (no caller branches on it until W3). */
  viewingScopeFor?: (requester: QuerySurfaceRequester, opts?: { asUser?: string }) => ViewingScope;
  /**
   * Host-supplied builder for the aggregate analytics model (cardinality/EAV
   * registry + DERIVED manifest + Drizzle table/column refs). Lazy-cached per
   * engine on first aggregate() call. REQUIRED to use the aggregate surface;
   * describe/query/fetch don't need it. Built once per requester engine — keep
   * it requester-agnostic (structural model, not per-user data).
   */
  aggregateModel?: () => Promise<AggregateModel>;
  /** Entities that intentionally carry no tenancy (reference/lookup tables). With
   *  scope active, aggregate() fails closed on any measure source not covered by
   *  `scopeFor` unless it's declared here — so a forgotten source denies, never
   *  silently aggregates cross-tenant. */
  tenantGlobalEntities?: readonly string[];
  /**
   * Resolve a `scope.user` value (a user id OR email) to a canonical org user
   * id, or null when no such user exists in the requester's org. Host-owned
   * (needs the user directory). Omit → `scope: { as: 'user' }` is unsupported.
   */
  resolveAsUser?: (requester: QuerySurfaceRequester, value: string) => Promise<string | null>;
  /**
   * The users the requester may scope to (their org's members) — surfaced in
   * `describe` so callers can discover ids/emails. Omit → empty roster.
   */
  listUsers?: (requester: QuerySurfaceRequester) => Promise<ScopeUser[]>;
  /**
   * Ambient requester source, called per operation. Hosts typically pass
   * their ALS reader (e.g. `requireRequester`); it should THROW when no
   * context is active — fail-loud beats unscoped reads.
   */
  getRequester: () => QuerySurfaceRequester;
  /**
   * Per-entity native-column allowlist. When present, native columns not listed
   * are dropped from `describe` and from returned rows (EAV fields and `id`
   * always pass). Omit to expose all native columns (facet-trim only).
   */
  exposeColumns?: ExposeColumns;
  /**
   * Embed a query string into a vector for `rank_by { method: 'semantic' }`.
   * MUST use the SAME embedding model that generated the entity's stored
   * vectors, or cosine similarity is meaningless. Omit → semantic ranking is
   * unsupported (returns 400).
   */
  embed?: (text: string) => Promise<number[]>;
  /**
   * Which `(entity → text column)` pairs support semantic ranking, mapped to the
   * vector column holding their embedding — e.g.
   * `{ observations: { normalized_text: 'embedding' } }`. A `rank_by` with
   * `method:'semantic'` on a pair not listed here returns 400.
   */
  semanticColumns?: Record<string, Record<string, string>>;
}
