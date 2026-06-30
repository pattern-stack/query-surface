// Derive the analytics manifest FROM the registry's FieldMeta tags — so the
// role/agg/additivity/time marks on the field are LIVE (consumed), not
// validated-and-dropped. Native dimensions/measures come from desc.fieldMeta;
// EAV measures (whose tags would live on field_definitions, a DB column we don't
// control on dealbrain) are supplied as an overlay.

import { getTableColumns, getTableName } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { AggColType, AggFieldMeta, AggRegistry } from '../../../internal/analytics/types';
import type { EntityDescriptor } from './registry';

function colType(col: PgColumn): AggColType {
  const ct = (col as unknown as { columnType?: string }).columnType;
  if (ct === 'PgUUID') return 'uuid';
  switch (col.dataType) {
    case 'date':
      return 'datetime';
    case 'json':
      return 'json';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'string';
  }
}

/** registry (cardinality + FieldMeta tags) + EAV overlay → the aggregate manifest. */
export function analyticsFromRegistry(
  registry: Record<string, EntityDescriptor>,
  eavOverlay: Record<string, Record<string, AggFieldMeta>> = {},
): AggRegistry {
  const out: AggRegistry = {};
  for (const [name, desc] of Object.entries(registry)) {
    const cols = getTableColumns(desc.table) as Record<string, PgColumn>;
    const fields: Record<string, AggFieldMeta> = {};
    // native dims/measures from FieldMeta tags (keyed by DB column name)
    for (const [prop, meta] of Object.entries(desc.fieldMeta ?? {})) {
      if (!meta.role) continue;
      const col = cols[prop];
      if (!col) continue;
      fields[col.name] = {
        type: colType(col),
        role: meta.role,
        ...(meta.agg ? { agg: meta.agg } : {}),
        ...(meta.aggs ? { aggs: meta.aggs } : {}),
        ...(meta.additivity ? { additivity: meta.additivity } : {}),
        ...(meta.time ? { time: meta.time } : {}),
        // Declared domain: a native pg-enum OR a qField-declared select_options list. Mirrors
        // catalog.ts's `nativeEnum ?? meta.selectOptions` (the enumValues source) so describe's
        // dimension marker and key_fields agree on what counts as "has a known value domain".
        ...(colType(col) === 'enum' || meta.selectOptions?.length
          ? { hasDeclaredDomain: true }
          : {}),
      };
    }
    // EAV measures (tags can't ride field_definitions on dealbrain → overlay)
    Object.assign(fields, eavOverlay[name] ?? {});
    out[name] = {
      table: getTableName(desc.table),
      pk: desc.primaryKey,
      rels: { ...desc.relationships },
      fields,
    };
  }
  return out;
}
