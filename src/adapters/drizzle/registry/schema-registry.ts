// Auto-expose — point the query surface at a Drizzle 1.0 relational config (or a
// db) and have it register every table automatically. No hand-written
// EntityRegistration[].
//
//   import * as schema from './schema.ts';
//   const relations = defineRelations(schema, (r) => ({ ... }));
//   registerSchema(relations, { eav: { opportunities: {...} } });
//
// `defineRelations()` output is the same thing you pass to
// drizzle({ client, relations }): one entry per table ({ table, name, relations }).
// We walk it, pair each table with its relations, recover any qField metadata
// stamped on the table, and build EntityRegistration[] → configureQueryRegistry.
//
// This is the path for hosts WITHOUT a declared model. A host that already knows
// its graph (e.g. generated from entity YAML) supplies an `AggregateModel` instead.
//
// What still needs declaration (can't be introspected): the EAV `eav` overlay
// (which tables are value-backed + shape) and exclusions for substrate/join
// tables. The native relational graph + column metadata auto-expose fully.

import { type TablesRelationalConfig, getTableName, is } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PgTable } from 'drizzle-orm/pg-core';
import { fieldDefinitions, fieldValues, fieldValuesJsonb } from '../eav/schema.ts';
import type { FieldMetaMap } from './define-entity.ts';
import { readEntityMeta } from './define-entity.ts';
import {
  type ComputedFieldSpec,
  type EavStrategy,
  type EntityRegistration,
  configureQueryRegistry,
} from './registry.ts';

// EAV substrate + the runtime-registry table are plumbing, not domain entities.
// Names are derived from the actual table objects so they can't silently drift
// out of sync with eav/schema.ts; `entity_registrations` has no table object here.
const DEFAULT_EXCLUDE = [
  ...[fieldDefinitions, fieldValues, fieldValuesJsonb].map(getTableName),
  'entity_registrations',
];

export interface RegisterSchemaOptions {
  /** Table names to skip (added to the default substrate excludes). */
  exclude?: string[];
  /** EAV strategy overlay, keyed by exposed entity name (or table name). */
  eav?: Record<string, EavStrategy>;
  /** Remap a table name to a different exposed entity name. */
  names?: Record<string, string>;
  /** Per-entity fieldMeta overrides (keyed by exposed entity name). Applied on
   *  top of any qField metadata stamped on the table — useful for entities
   *  defined with plain pgTable (no qEntity) or when the host wants to add
   *  isKeyField / label / isVisible annotations without touching the DB schema. */
  fieldMeta?: Record<string, FieldMetaMap>;
  /** Per-entity computed metrics (keyed by exposed entity name) — aggregate-over-
   *  relationship fields surfaced as first-class, filterable/sortable columns. */
  computed?: Record<string, ComputedFieldSpec[]>;
}

/** Walk a Drizzle 1.0 relational config (`defineRelations()` output) →
 *  EntityRegistration[] (no code-side list needed). */
export function buildRegistrationsFromSchema(
  relations: TablesRelationalConfig,
  options: RegisterSchemaOptions = {},
): EntityRegistration[] {
  const exclude = new Set([...DEFAULT_EXCLUDE, ...(options.exclude ?? [])]);

  const out: EntityRegistration[] = [];
  for (const entry of Object.values(relations)) {
    const table = entry.table;
    if (!is(table, PgTable)) continue; // views carry no entity
    const tableName = getTableName(table);
    if (exclude.has(tableName)) continue;
    const name = options.names?.[tableName] ?? tableName;
    const { fieldMeta: tableMeta, meta } = readEntityMeta(table);
    const override = options.fieldMeta?.[name];
    const fieldMeta = override ? { ...(tableMeta ?? {}), ...override } : tableMeta;
    out.push({
      name,
      table,
      relations: entry.relations,
      fieldMeta,
      meta,
      eav: options.eav?.[name] ?? options.eav?.[tableName],
      computed: options.computed?.[name] ?? options.computed?.[tableName],
    });
  }
  return out;
}

/** Auto-register every table in a Drizzle 1.0 relational config. */
export function registerSchema(
  relations: TablesRelationalConfig,
  options?: RegisterSchemaOptions,
): EntityRegistration[] {
  const regs = buildRegistrationsFromSchema(relations, options);
  configureQueryRegistry(regs);
  return regs;
}

/** Auto-register from a live Drizzle db instance built with
 *  `drizzle({ client, relations })` (reads the relational config off it). */
export function registerFromDb(
  // biome-ignore lint/suspicious/noExplicitAny: engine is schema-agnostic; Drizzle's DB type is generic over the host relations, unknown at the package level
  db: NodePgDatabase<any>,
  options?: RegisterSchemaOptions,
): EntityRegistration[] {
  return registerSchema(db._.relations, options);
}
