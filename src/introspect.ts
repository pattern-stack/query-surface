// Drizzle introspection seam — the ONE place that reaches into Drizzle's
// internals (private symbols, unevaluated relations() callbacks, table config).
//
// Why a dedicated module: these accessors are coupled to Drizzle's internal
// shape, which moves between versions (the 0.30 → 0.45 bump broke exactly this
// code). Centralizing it means the next bump is a one-file fix. Two consumers
// sit on top of these raw facts:
//   - registry.ts  → buildRegistry(): the runtime registry (strict, throws)
//   - doctor.ts    → diagnose(): findings (lenient, never throws)
// Neither should touch Drizzle symbols directly.

import { type Relations, createMany, createOne } from 'drizzle-orm';
import { type PgColumn, type PgTable, getTableConfig } from 'drizzle-orm/pg-core';

const TABLE_NAME = Symbol.for('drizzle:Name');
const TABLE_COLUMNS = Symbol.for('drizzle:Columns');

/** Drizzle's internal table name (the SQL table name, e.g. `accounts`). */
export function tableName(t: PgTable): string {
  return (t as unknown as Record<symbol, string>)[TABLE_NAME];
}

/** Columns keyed by JS property name; each `PgColumn.name` is the DB column. */
export function tableColumns(t: PgTable): Record<string, PgColumn> {
  return (t as unknown as Record<symbol, Record<string, PgColumn>>)[TABLE_COLUMNS];
}

// Drizzle stores relations() callbacks unevaluated on the Relations object. We
// pass it Drizzle's own one()/many() builders to walk the config. `One` carries
// the FK (config.fields); `Many` does not — the FK lives on the inverse One.
export type RelationsConfig = Record<
  string,
  {
    constructor: { name: string };
    referencedTable: PgTable;
    config?: { fields: PgColumn[] };
  }
>;

export function evaluateRelations(rels: Relations, table: PgTable): RelationsConfig {
  const helpers = { one: createOne(table), many: createMany(table) };
  return (rels as unknown as { config: (h: unknown) => RelationsConfig }).config(helpers);
}

/** A declared foreign-key constraint, resolved to both DB and JS names. */
export interface ForeignKeyInfo {
  /** Source column DB names (composite-FK aware, though we expect one). */
  fromColumns: string[];
  /** Source column JS property names (for generating relations() snippets). */
  fromProps: string[];
  /** Referenced table's DB name. */
  toTable: string;
  /** Referenced column DB names. */
  toColumns: string[];
}

/**
 * Foreign-key constraints declared via `.references()` — read from Drizzle's
 * table config. This is what `relations()` does NOT give us: a `.references()`
 * FK with no relations() entry is invisible to the registry. The doctor reads
 * both and reports the gap. (Diagnostic only — the query engine resolves joins
 * through relations(), never raw FKs.)
 */
export function foreignKeys(table: PgTable): ForeignKeyInfo[] {
  const cfg = getTableConfig(table);
  // DB column name → JS property name, for snippet generation.
  const dbToProp: Record<string, string> = {};
  for (const [prop, col] of Object.entries(tableColumns(table))) dbToProp[col.name] = prop;

  return cfg.foreignKeys.map((fk) => {
    const ref = (
      fk as unknown as {
        reference: () => {
          columns: PgColumn[];
          foreignTable: PgTable;
          foreignColumns: PgColumn[];
        };
      }
    ).reference();
    const fromColumns = ref.columns.map((c) => c.name);
    return {
      fromColumns,
      fromProps: fromColumns.map((db) => dbToProp[db] ?? db),
      toTable: tableName(ref.foreignTable),
      toColumns: ref.foreignColumns.map((c) => c.name),
    };
  });
}
