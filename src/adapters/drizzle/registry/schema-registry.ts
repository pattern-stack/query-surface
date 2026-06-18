// Auto-expose — point the query surface at a Drizzle schema (or a db) and have
// it register every table automatically. No hand-written EntityRegistration[].
//
//   import * as schema from './schema.ts';
//   registerSchema(schema, { eav: { opportunities: {...} } });
//
// A Drizzle schema barrel is just an object of pgTable + relations() exports
// (the same thing you pass to drizzle(pool, { schema })). We walk it, find the
// tables, pair each with its relations, recover any qField metadata stamped on
// the table, and build EntityRegistration[] → configureQueryRegistry.
//
// What still needs declaration (can't be introspected): the EAV `eav` overlay
// (which tables are value-backed + shape) and exclusions for substrate/join
// tables. The native relational graph + column metadata auto-expose fully.

import { Relations, getTableName, is } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PgTable } from 'drizzle-orm/pg-core';
import { fieldDefinitions, fieldValues, fieldValuesJsonb } from '../eav/schema.ts';
import type { FieldMetaMap } from './define-entity.ts';
import { readEntityMeta } from './define-entity.ts';
import { type EavStrategy, type EntityRegistration, configureQueryRegistry } from './registry.ts';

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
}

/** Walk a Drizzle schema object → EntityRegistration[] (no code-side list needed). */
export function buildRegistrationsFromSchema(
  schema: Record<string, unknown>,
  options: RegisterSchemaOptions = {},
): EntityRegistration[] {
  const exclude = new Set([...DEFAULT_EXCLUDE, ...(options.exclude ?? [])]);

  const tables: PgTable[] = [];
  const relationsByTable = new Map<string, Relations>();
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) {
      tables.push(value);
    } else if (is(value, Relations)) {
      // A Relations object carries the table it was declared on.
      const t = (value as unknown as { table?: PgTable }).table;
      if (t) relationsByTable.set(getTableName(t), value);
    }
  }

  const out: EntityRegistration[] = [];
  for (const table of tables) {
    const tableName = getTableName(table);
    if (exclude.has(tableName)) continue;
    const name = options.names?.[tableName] ?? tableName;
    const { fieldMeta: tableMeta, meta } = readEntityMeta(table);
    const override = options.fieldMeta?.[name];
    const fieldMeta = override ? { ...(tableMeta ?? {}), ...override } : tableMeta;
    out.push({
      name,
      table,
      relations: relationsByTable.get(tableName),
      fieldMeta,
      meta,
      eav: options.eav?.[name] ?? options.eav?.[tableName],
    });
  }
  return out;
}

/** Auto-register every table in a Drizzle schema barrel. */
export function registerSchema(
  schema: Record<string, unknown>,
  options?: RegisterSchemaOptions,
): EntityRegistration[] {
  const regs = buildRegistrationsFromSchema(schema, options);
  configureQueryRegistry(regs);
  return regs;
}

/** Auto-register from a live Drizzle db instance (pulls the schema off it). */
export function registerFromDb(
  // biome-ignore lint/suspicious/noExplicitAny: engine is schema-agnostic; Drizzle's DB type is generic over the host schema, unknown at the package level
  db: NodePgDatabase<any>,
  options?: RegisterSchemaOptions,
): EntityRegistration[] {
  // Drizzle stashes the schema on the client; fall back across known shapes.
  const internal = (
    db as unknown as {
      _?: {
        fullSchema?: Record<string, unknown>;
        schema?: Record<string, unknown>;
      };
    }
  )._;
  const schema = internal?.fullSchema ?? internal?.schema ?? {};
  return registerSchema(schema, options);
}
