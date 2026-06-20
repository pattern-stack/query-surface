// Preview selection — derived from the field catalog (no hand-maintained list).
//
// When `query(preview: true)` is called, we return a curated slice of columns
// alongside each ID. The curated set is the catalog's preview fields
// (CatalogField.preview — from qField `isKeyField` on native columns, or
// field_definitions.isKeyField on EAV fields), ordered by previewOrder. Native
// preview fields project real columns; EAV preview fields project through
// field_values joins. The consumer sees one flat row.

import type { SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { EntityName } from '../../../internal/language/types.ts';
import { computedSelectShape } from '../compile/computed.ts';
import type { FieldMap } from '../eav/field-map.ts';
import { buildEntityCatalog } from '../registry/catalog.ts';
import { registry } from '../registry/registry.ts';

export interface PreviewSelection {
  /** Real columns to SELECT, keyed by camelCase alias. */
  nativeColumns: Record<string, PgColumn>;
  /** EAV field keys to project via field_values joins. */
  eavKeys: string[];
  /** Computed metrics flagged for preview, keyed by snake_case metric key. */
  computed: Record<string, SQL.Aliased>;
}

/** Curated preview fields for an entity, split into native columns + EAV keys. */
export function catalogPreview(entity: EntityName, fieldMap?: FieldMap): PreviewSelection {
  const cat = buildEntityCatalog(entity, fieldMap);
  const cols = registry[entity].columns as Record<string, PgColumn>;
  const preview = cat.fields
    .filter((f) => f.preview)
    .sort((a, b) => (a.previewOrder ?? 999) - (b.previewOrder ?? 999));

  const nativeColumns: Record<string, PgColumn> = {};
  const eavKeys: string[] = [];
  for (const f of preview) {
    if (f.computed) continue; // computed previews come from computedSelectShape
    if (f.eav) eavKeys.push(f.key);
    else if (f.column && cols[f.column]) nativeColumns[f.key] = cols[f.column];
  }
  const computed = computedSelectShape(entity, { previewOnly: true });
  return { nativeColumns, eavKeys, computed };
}

/**
 * Full native SELECT shape for /fetch + expand, keyed by the consumer-facing
 * snake_case key (`CatalogField.key`) — the SAME dialect describe,
 * `exposeColumns`, and `projectRow` speak.
 *
 * A bare `db.select()` keys rows by Drizzle's camelCase JS prop, so any
 * multi-word column (`external_id`, `occurred_at`, …) misses the snake_case
 * allowlist and gets dropped by projection. Aliasing every column to its
 * `col.name` here is the one translation point that keeps row keys and the
 * contract in the same dialect.
 *
 * Includes `id` and every `belongs_to` FK column (by its snake name) so expand
 * can read the FK off a row via `rel.fk`. Visibility curation is inherited from
 * the catalog (hidden tenant columns / ciphertext are never selected); the
 * belongs_to FK loop re-adds an FK the catalog hid, since expand still needs it.
 */
export function nativeSelectShape(
  entity: EntityName,
  fieldMap?: FieldMap,
): Record<string, PgColumn> {
  const desc = registry[entity];
  const cols = desc.columns as Record<string, PgColumn>;
  const shape: Record<string, PgColumn> = {};
  for (const f of buildEntityCatalog(entity, fieldMap).fields) {
    if (!f.eav && f.column && cols[f.column]) shape[f.key] = cols[f.column];
  }
  shape[desc.primaryKey] = cols[desc.primaryKey];
  for (const rel of Object.values(desc.relationships)) {
    if (rel.kind !== 'belongs_to' || !rel.fk) continue;
    const fkCol = Object.values(cols).find(
      (c) => (c as unknown as { name: string }).name === rel.fk,
    );
    if (fkCol) shape[rel.fk] = fkCol;
  }
  return shape;
}
