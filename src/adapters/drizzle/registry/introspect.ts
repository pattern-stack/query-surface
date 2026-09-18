// Drizzle introspection seam — the ONE place that reaches into Drizzle's
// internals (private symbols, relational config, table config).
//
// Why a dedicated module: these accessors are coupled to Drizzle's internal
// shape, which moves between versions (the 0.30 → 0.45 bump broke exactly this
// code; 1.0 removed the v1 `relations()` API outright). Centralizing it means the
// next bump is a one-file fix. Two consumers sit on top of these raw facts:
//   - registry.ts  → buildRegistry(): the runtime registry (strict, throws)
//   - doctor.ts    → diagnose(): findings (lenient, never throws)
// Neither should touch Drizzle symbols directly.
//
// Relations are Drizzle 1.0's `defineRelations()` output (relational queries v2).
// That object is already PROCESSED: every `r.many.x()` / inverse `r.one.x()` that
// omitted `from`/`to` has had its columns filled in from the reverse relation, so a
// single relation carries both sides — no second pass over the inverse is needed.
//
// NB: introspection is the path for hosts WITHOUT a declared model. A host that
// already knows its graph (e.g. a code generator emitting from entity YAML) should
// build an `AggregateModel` directly and skip this module entirely.

import { Many, One, type RelationsRecord, is } from 'drizzle-orm';
import { type PgColumn, PgTable, getTableConfig } from 'drizzle-orm/pg-core';

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

/**
 * A column's coarse runtime data type — `'string' | 'number' | 'boolean' | 'date' | 'json' |
 * 'bigint' | 'array' | 'buffer' | 'custom' | …`. Drizzle 1.0 made `column.dataType` compound
 * (`'string uuid'`, `'object date'`, `'number int32'`, `'object json'`); this folds it back to
 * the single token the engine keys on (the 0.x vocabulary): the base type, except `object`,
 * which is only meaningful by its constraint (`date` / `json` / `buffer` / …).
 */
export function columnDataType(col: PgColumn): string {
  // Tolerates a non-column (a table's own method reached by a property walk) → 'unknown'.
  const dt: unknown = col.dataType;
  if (typeof dt !== 'string') return 'unknown';
  const [base, constraint] = dt.split(' ');
  return base === 'object' && constraint ? constraint : (base ?? 'custom');
}

/** The relationship kinds the engine understands. `belongs_to` and `has_one` are both
 *  TO-ONE (joinable without fan-out); `has_many` is to-many. They differ in where the FK
 *  lives: on the SOURCE for belongs_to, on the TARGET for has_one / has_many. */
export type RelKind = 'belongs_to' | 'has_one' | 'has_many';

/** One relation of a table, classified. `fk` is the FK's DB column name — on the source
 *  table for `belongs_to`, on the target table for `has_one` / `has_many`. */
export interface IntrospectedRelation {
  name: string;
  kind: RelKind;
  targetTable: PgTable;
  fk: string;
}

/** A relation the engine cannot model (surfaced by the doctor, skipped by the registry). */
export interface UnsupportedRelation {
  name: string;
  targetTable: PgTable | null;
  reason: string;
}

/** A table's primary-key columns, from Drizzle's own metadata: a column-level
 *  `.primaryKey()` or a table-level `primaryKey({ columns })` (composite). A table that
 *  declares no primary key at all falls back to its `id` column — the convention the
 *  registry assumes (EntityDescriptor.primaryKey = 'id'). */
export function primaryKeyColumns(table: PgTable): PgColumn[] {
  const cols = Object.values(tableColumns(table));
  const declared = [
    ...cols.filter((c) => c.primary),
    ...getTableConfig(table).primaryKeys.flatMap((pk) => pk.columns as PgColumn[]),
  ];
  return declared.length > 0 ? declared : cols.filter((c) => c.name === 'id');
}

/** Is the db column `dbName` unique on its own (sole PK, column `.unique()`, a
 *  single-column unique constraint, or a single-column unique index)? Diagnostic — decides
 *  whether a belongs_to's missing inverse should be a has_one or a has_many. */
export function isUniqueColumn(table: PgTable, dbName: string): boolean {
  const col = Object.values(tableColumns(table)).find((c) => c.name === dbName);
  if (!col) return false;
  if (col.isUnique || isSolePk(col, table)) return true;
  const cfg = getTableConfig(table);
  const single = (names: (string | undefined)[]) => names.length === 1 && names[0] === dbName;
  return (
    cfg.uniqueConstraints.some((u) => single(u.columns.map((c) => c.name))) ||
    cfg.indexes.some(
      (i) =>
        i.config.unique &&
        single(i.config.columns.map((c) => (c as { name?: string } | undefined)?.name)),
    )
  );
}

/** `col` IS its table's primary key (the sole PK column — a single-column relation can't
 *  address a composite key). */
function isSolePk(col: PgColumn, table: unknown): boolean {
  if (!is(table, PgTable)) return false;
  const pk = primaryKeyColumns(table);
  return pk.length === 1 && pk[0]!.name === col.name;
}

/**
 * Classify one table's relations (a `defineRelations()` entry's `.relations`).
 *
 *  - `r.one.T({ from: src.fk, to: T.pk })`       → belongs_to (fk on source)
 *  - `r.one.T({ from: src.pk, to: T.fk })`       → has_one    (fk on target)
 *  - `r.one.T({ from: src.pk, to: T.pk })`       → has_one    (shared-PK 1:1; fk = T.pk)
 *  - `r.many.T(...)` (explicit or via inverse)   → has_many   (fk on target)
 *
 * Primary keys come from the tables' PK metadata, never a column name. A shared-PK 1:1 is
 * `has_one` in BOTH directions: neither side is finer, so neither may add a grain rank (a
 * `belongs_to` each way would rank each side below the other).
 *
 * Unsupported (returned separately, never guessed): `.through()` many-to-many (the engine
 * needs a direct FK edge — register the junction as an entity instead), a relation to a
 * view, a composite-column relation, and a relation keyed on neither side's primary key.
 */
export function classifyRelations(rels: RelationsRecord | undefined): {
  relations: IntrospectedRelation[];
  unsupported: UnsupportedRelation[];
} {
  const relations: IntrospectedRelation[] = [];
  const unsupported: UnsupportedRelation[] = [];
  for (const [name, rel] of Object.entries(rels ?? {})) {
    const target = rel.targetTable;
    if (!is(target, PgTable)) {
      unsupported.push({ name, targetTable: null, reason: 'targets a view, not a table' });
      continue;
    }
    if (rel.throughTable) {
      unsupported.push({
        name,
        targetTable: target,
        reason: 'is a .through() many-to-many — register the junction table as an entity instead',
      });
      continue;
    }
    const src = rel.sourceColumns as PgColumn[];
    const tgt = rel.targetColumns as PgColumn[];
    if (src.length !== 1 || tgt.length !== 1) {
      unsupported.push({ name, targetTable: target, reason: 'is a composite-column relation' });
      continue;
    }
    const [s, t] = [src[0]!, tgt[0]!];
    const srcPk = isSolePk(s, rel.sourceTable);
    const tgtPk = isSolePk(t, target);
    if (is(rel, Many) && srcPk) {
      relations.push({ name, kind: 'has_many', targetTable: target, fk: t.name });
    } else if (is(rel, One) && srcPk) {
      // PK→FK, or PK→PK (shared-PK 1:1): the target holds at most one row per source row.
      relations.push({ name, kind: 'has_one', targetTable: target, fk: t.name });
    } else if (is(rel, One) && tgtPk) {
      relations.push({ name, kind: 'belongs_to', targetTable: target, fk: s.name });
    } else {
      unsupported.push({
        name,
        targetTable: target,
        reason: "is keyed on neither side's primary key",
      });
    }
  }
  return { relations, unsupported };
}

/** A declared foreign-key constraint, resolved to both DB and JS names. */
export interface ForeignKeyInfo {
  /** Source column DB names (composite-FK aware, though we expect one). */
  fromColumns: string[];
  /** Source column JS property names (for generating relation snippets). */
  fromProps: string[];
  /** Referenced table's DB name. */
  toTable: string;
  /** Referenced column DB names. */
  toColumns: string[];
}

/**
 * Foreign-key constraints declared via `.references()` — read from Drizzle's
 * table config. This is what the relational config does NOT give us: a `.references()`
 * FK with no relation entry is invisible to the registry. The doctor reads
 * both and reports the gap. (Diagnostic only — the query engine resolves joins
 * through declared relations, never raw FKs.)
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
