// Runtime registry — populate the query registry from DATA, not code.
//
// `configureQueryRegistry` takes EntityRegistration[]. Those carry live Drizzle
// objects (table / relations), which must exist in code (and the physical tables
// in the DB). But *which* of them to expose, under what name, with what EAV
// strategy, can be driven at runtime from the `entity_registrations` table:
//
//   code TABLE_CATALOG (the inventory of available tables)
//     ⨝  entity_registrations rows (which to expose + name + eav + enabled)
//     →  EntityRegistration[]  →  configureQueryRegistry()
//
// Toggle `enabled`, change `name`, or repoint `eav` in the DB and re-run the
// loader → the exposed ERD changes, no redeploy. See docs/architecture.md.

import type { RelationsRecord } from 'drizzle-orm';
import { asc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgTable } from 'drizzle-orm/pg-core';
import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { EntityMeta, FieldMetaMap } from './define-entity.ts';
import type { EavStrategy, EntityRegistration } from './registry.ts';

// ---------------------------------------------------------------------------
// The runtime profile table — one row per exposed entity.
// ---------------------------------------------------------------------------

export const entityRegistrations = pgTable('entity_registrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Logical entity name the consumer queries (describe/query/fetch). */
  name: text('name').notNull(),
  /** Key into the code-side TableCatalog — which Drizzle table this exposes. */
  tableKey: text('table_key').notNull(),
  /** Toggle the entity in/out of the exposed ERD. */
  enabled: boolean('enabled').notNull().default(true),
  /** EAV strategy as data; `valueTableKey` resolves against the ValueTableCatalog. */
  eav: jsonb('eav').$type<EavJson>(),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

interface EavJson {
  kind: 'typed-columns' | 'jsonb-value';
  entityTypeValue: string;
  valueTableKey: string;
  valueColumn?: string;
  currentOnly?: boolean;
  validToColumn?: string;
}

// ---------------------------------------------------------------------------
// Code-side catalogs — the inventory of what CAN be exposed. The live Drizzle
// objects can only come from code (and the physical tables from migrations);
// the runtime profile selects + configures from these.
// ---------------------------------------------------------------------------

export interface CatalogEntry {
  table: PgTable;
  /** The table's `defineRelations()` entry `.relations`. */
  relations?: RelationsRecord;
  fieldMeta?: FieldMetaMap;
  meta?: EntityMeta;
}
export type TableCatalog = Record<string, CatalogEntry>;
export type ValueTableCatalog = Record<string, PgTable>;

// ---------------------------------------------------------------------------
// The loader
// ---------------------------------------------------------------------------

/**
 * Build EntityRegistration[] from the `entity_registrations` table joined against
 * the code catalogs. Only `enabled` rows are returned, ordered by `sortOrder`.
 * Feed the result to configureQueryRegistry().
 */
export async function loadRegistrations(
  // biome-ignore lint/suspicious/noExplicitAny: engine is schema-agnostic; Drizzle's DB type is generic over the host schema, unknown at the package level
  db: NodePgDatabase<any>,
  catalog: TableCatalog,
  valueTables: ValueTableCatalog,
): Promise<EntityRegistration[]> {
  const rows = await db
    .select()
    .from(entityRegistrations)
    .where(eq(entityRegistrations.enabled, true))
    .orderBy(asc(entityRegistrations.sortOrder));

  const out: EntityRegistration[] = [];
  for (const row of rows) {
    const entry = catalog[row.tableKey];
    if (!entry) continue; // row references a table not in the code catalog — skip

    let eav: EavStrategy | undefined;
    const e = row.eav;
    if (e) {
      const valueTable = valueTables[e.valueTableKey];
      if (valueTable) {
        eav =
          e.kind === 'jsonb-value'
            ? {
                kind: 'jsonb-value',
                valueTable,
                entityTypeValue: e.entityTypeValue,
                valueColumn: e.valueColumn ?? 'value',
                currentOnly: e.currentOnly ?? true,
                validToColumn: e.validToColumn ?? 'validTo',
              }
            : {
                kind: 'typed-columns',
                valueTable,
                entityTypeValue: e.entityTypeValue,
              };
      }
    }

    out.push({
      name: row.name,
      table: entry.table,
      relations: entry.relations,
      fieldMeta: entry.fieldMeta,
      meta: entry.meta,
      eav,
    });
  }
  return out;
}
