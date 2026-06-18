// Actor-scoped EAV field map — the DYNAMIC half of the registry.
//
// `field_definitions` are per-user, so "which fields does `opportunity` have,
// and what are their ids/types" can't be a module-load singleton like the
// static registry (tables, columns, relationships). This loads that map for a
// given (userId, entityType) and caches it in-process. The compiler reads it
// (via the EavContext threaded into compile()) to resolve an EAV field path
// like `opportunity.StageName` to a field_definition_id + value column.
//
// POC scope: cached at first use for process lifetime; query_describe and the
// search/fetch path share the cache. A real consumer would key the cache by
// the authenticated actor and invalidate it on field-definition writes.

import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { EntityName } from '../../../internal/language/types.ts';
import { registry } from '../registry/registry.ts';
import { fieldDefinitions } from './schema.ts';

export interface FieldDef {
  fieldDefinitionId: string;
  dataType: string;
  /** select / multipicklist option list, when the field is an enumerated type. */
  selectOptions: string[] | null;
  label: string;
  /**
   * Catalog semantics carried straight from field_definitions — the agent-facing
   * layer reads these instead of hand-authoring notes / preview lists.
   *   - description    → the per-field "note" (units, conventions, meaning)
   *   - isKeyField     → curated "show this field" flag (drives preview)
   *   - keyFieldOrder  → sort position within the curated preview set
   * See docs/field-catalog-design.md.
   */
  description: string | null;
  isKeyField: boolean;
  keyFieldOrder: number | null;
}

/** key (e.g. 'StageName') → its definition for this actor. */
export type FieldMap = ReadonlyMap<string, FieldDef>;

/** EAV resolution context threaded into compile(): the actor's field maps per entity. */
export interface EavContext {
  fieldMaps: Partial<Record<EntityName, FieldMap>>;
}

// POC single-tenant actor — equals the seed USER_ID (src/seed-data/deal-types.ts).
// A real consumer injects the authenticated actor instead of this constant.
export const POC_ACTOR_USER_ID = '11111111-1111-1111-1111-111111111111';

/**
 * The actor whose field definitions resolve as EAV virtual columns.
 * With `organizationId` set, definitions load by organization ownership
 * (org-owned defs carry user_id NULL); otherwise by legacy per-user ownership.
 */
export interface Requester {
  userId: string;
  organizationId?: string | null;
}

// biome-ignore lint/suspicious/noExplicitAny: engine is schema-agnostic; Drizzle's DB type is generic over the host schema, unknown at the package level
type AnyDb = NodePgDatabase<any>;

/**
 * Load the field map for one actor + entity_type, FRESH on every call.
 *
 * Deliberately uncached: `field_definitions.is_visible` is live curation a
 * seller edits at runtime, and a process-lifetime cache made those edits
 * invisible until a restart (no invalidation was wired on field-definition
 * writes). The read is a single indexed lookup, and `loadFieldMaps` fires one
 * per EAV entity concurrently — cheap enough to pay per request for a read API
 * that must always reflect current curation.
 */
export async function loadFieldMap(
  db: AnyDb,
  requester: Requester,
  entityType: string,
): Promise<FieldMap> {
  const rows = await db
    .select({
      id: fieldDefinitions.id,
      key: fieldDefinitions.key,
      dataType: fieldDefinitions.dataType,
      selectOptions: fieldDefinitions.selectOptions,
      label: fieldDefinitions.label,
      description: fieldDefinitions.description,
      isKeyField: fieldDefinitions.isKeyField,
      keyFieldOrder: fieldDefinitions.keyFieldOrder,
    })
    .from(fieldDefinitions)
    .where(
      and(
        requester.organizationId
          ? eq(fieldDefinitions.organizationId, requester.organizationId)
          : eq(fieldDefinitions.userId, requester.userId),
        eq(fieldDefinitions.entityType, entityType),
        // Curation gate: only seller-selected fields exist on the query
        // surface. Hidden definitions are invisible everywhere — describe,
        // filter resolution, preview — not merely undocumented.
        eq(fieldDefinitions.isVisible, true),
      ),
    );

  const map = new Map<string, FieldDef>();
  for (const r of rows) {
    map.set(r.key, {
      fieldDefinitionId: r.id,
      dataType: r.dataType,
      selectOptions: (r.selectOptions as string[] | null) ?? null,
      label: r.label,
      description: r.description ?? null,
      isKeyField: r.isKeyField,
      keyFieldOrder: r.keyFieldOrder ?? null,
    });
  }
  return map;
}

/** Load field maps for every EAV-enabled entity in the registry, for one actor. */
export async function loadFieldMaps(db: AnyDb, requester: Requester): Promise<EavContext> {
  // Each entity's field map is an independent query — fire them concurrently
  // rather than serially awaiting one DB round-trip per EAV entity.
  const eavEntities = Object.values(registry).flatMap((desc) =>
    desc.eav ? [{ name: desc.name, entityType: desc.eav.entityTypeValue }] : [],
  );
  const maps = await Promise.all(
    eavEntities.map(({ entityType }) => loadFieldMap(db, requester, entityType)),
  );
  const fieldMaps: Partial<Record<EntityName, FieldMap>> = {};
  eavEntities.forEach(({ name }, i) => {
    fieldMaps[name] = maps[i];
  });
  return { fieldMaps };
}

/**
 * No-op, retained for API compatibility. The field map is no longer cached
 * (see `loadFieldMap`), so there is nothing to clear — reads are always fresh.
 */
export function clearFieldMapCache(): void {}
