// buildRegistry() — derives the query registry at boot by introspecting
// Drizzle's relational config (1.0 `defineRelations()`) + column metadata.
//
// This is the path for hosts WITHOUT a declared model. A host that already knows
// its graph (e.g. generated from entity YAML) builds an `AggregateModel` directly
// — `registry` is just `Record<string, EntityDescriptor>` — and never calls this.
//
// What we still need humans to declare:
//   - defineRelations(schema, (r) => ({ ... }))  ← idiomatic Drizzle 1.0
//
// What we DERIVE from Drizzle metadata:
//   - belongs_to: r.one.T({ from: src.fk, to: T.pk })  → fk on the source
//   - has_one:    r.one.T({ from: src.pk, to: T.fk })  → fk on the target (to-one)
//   - has_many:   r.many.T(...)                        → fk on the target
//     (Drizzle resolves an omitted from/to off the reverse relation, so the FK is
//     already on the relation — no inverse lookup pass.)
//   - searchableColumns: every text column that isn't an ID/UUID/enum
//   - column types + enum values: directly from PgColumn introspection

import type { RelationsRecord } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

import type { EntityName, Op } from '../../../internal/language/types.ts';
// Type-only import (erased at compile) — keeps the catalog↔registry cycle
// type-level; catalog.ts value-imports `registry`, never the reverse at runtime.
import type { ColumnType } from './catalog.ts';
import type { EntityMeta, FieldMetaMap } from './define-entity.ts';
import { classifyRelations, columnDataType, tableColumns, tableName } from './introspect.ts';

// ---------------------------------------------------------------------------
// Output shape — matches what compiler.ts / expand.ts / preview.ts read. Same
// interface as the v1 codegen registry, new (introspected) derivation.
// ---------------------------------------------------------------------------

/** A relationship edge. `fk` is the FK column's DB name — on THIS entity for `belongs_to`,
 *  on the TARGET for `has_one` / `has_many`. `belongs_to` and `has_one` are to-one (a join
 *  never fans); `has_many` is to-many. A `has_one` is trusted to be 1:1 (the host declares
 *  it; back it with a UNIQUE on the target's fk). */
export type RelDescriptor =
  | { kind: 'belongs_to'; target: EntityName; fk: string }
  | { kind: 'has_one'; target: EntityName; fk: string }
  | { kind: 'has_many'; target: EntityName; fk: string };

/**
 * Static EAV strategy for an entity whose fields live in a value table.
 * Discriminated by storage shape — the compiler picks the resolution path off
 * `kind`. Only the static, schema-derived part lives here; the per-actor field
 * map (key → field_definition_id + data_type) is loaded at runtime (field-map.ts).
 * Together they make the EAV seam invisible to the agent regardless of shape.
 *
 *  - 'typed-columns' (Shape A, dealbrain): value lives in one of four typed
 *    columns picked by valueColumnForDataType(); resolution returns a real
 *    PgColumn (rides the kind:'column' path).
 *  - 'jsonb-value' (Shape B, codegen-patterns): value lives in a single jsonb
 *    column with inline temporal validity; resolution returns an SQL cast
 *    expression (the eav_expr path). `currentOnly` adds `valid_to IS NULL` to
 *    the join so only the current value is matched (one row per field).
 */
export type EavStrategy =
  | {
      kind: 'typed-columns';
      valueTable: PgTable;
      entityTypeValue: string;
    }
  | {
      kind: 'jsonb-value';
      valueTable: PgTable;
      entityTypeValue: string;
      valueColumn: string; // property key of the jsonb column (e.g. 'value')
      currentOnly: boolean; // true → join predicate adds `valid_to IS NULL`
      validToColumn: string; // property key of the valid_to column (e.g. 'validTo')
    };

/**
 * A computed metric: a cheap aggregate over an EXISTING relationship, surfaced
 * as a first-class field (filterable, sortable, projected inline). Declared
 * host-side and resolved at query time from the introspected relational graph —
 * no materialized column, no write-path, always correct. The SQL synthesis lives
 * in adapters/drizzle/compile/computed.ts.
 *
 * Examples:
 *   { key: 'observation_count', agg: 'count', over: 'observations', type: 'integer' }
 *   { key: 'last_activity_at',  agg: 'max',   over: 'observations', field: 'occurred_at', type: 'datetime' }
 */
export interface ComputedFieldSpec {
  /** Consumer-facing snake_case key (what the agent filters/sorts/reads). */
  key: string;
  /** Aggregate function. `count` ignores `field`; the rest require it. */
  agg: 'count' | 'max' | 'min' | 'sum';
  /** has_many relationship name(s) on THIS entity to aggregate over. An array
   *  (max/min only) folds per-relationship aggregates via GREATEST/LEAST. */
  over: string | string[];
  /** Target column (snake_case) on the related entity for max/min/sum. */
  field?: string;
  /** Catalog type of the result (drives describe + value coercion). */
  type: ColumnType;
  label?: string;
  description?: string;
  /** Surface in default preview rows (first-pass search), not just on fetch. */
  preview?: boolean;
  previewOrder?: number;
  /** Optional predicate AND-ed inside the aggregate subquery, over the related
   *  entity's columns — e.g. observations carry retracted_at IS NULL + scope='deal'
   *  so the count matches the agent-retrievable evidence set. */
  filter?: ComputedFilterLeaf[];
}

/** A predicate leaf inside a computed metric's sub-filter, over a column of the
 *  related (child) entity. `on` is the child column key (snake_case). */
export interface ComputedFilterLeaf {
  on: string;
  op: Op;
  value?: unknown;
}

export interface EntityDescriptor {
  name: EntityName;
  table: PgTable;
  primaryKey: string;
  columns: Record<string, PgColumn>;
  relationships: Record<string, RelDescriptor>;
  searchableColumns: string[];
  /** Present when this entity's fields are EAV-backed (e.g. opportunity). */
  eav?: EavStrategy;
  /** Attribute-level native-column semantics (qField), keyed by column property. */
  fieldMeta?: FieldMetaMap;
  /** Entity-level semantics (summary, …). */
  meta?: EntityMeta;
  /** Aggregate-over-relationship metrics surfaced as first-class fields. */
  computed?: ComputedFieldSpec[];
}

// ---------------------------------------------------------------------------
// Registration — the CONSUMER's declaration of which Drizzle tables to expose,
// with optional EAV strategy + field metadata. The package ships none of its
// own; entities are registered at bootstrap via configureQueryRegistry() (or,
// most commonly, registerSchema()). Drizzle uses table names (plural) internally; `name`
// is the consumer's logical handle (what they pass to describe/query/fetch).
// ---------------------------------------------------------------------------

export interface EntityRegistration {
  name: EntityName;
  table: PgTable;
  /** This table's relations — the entry's `.relations` from Drizzle 1.0 `defineRelations()`
   *  (e.g. `rels.accounts.relations`). */
  relations?: RelationsRecord;
  /** EAV strategy when the entity's fields are value-table-backed. */
  eav?: EavStrategy;
  fieldMeta?: FieldMetaMap;
  meta?: EntityMeta;
  /** Aggregate-over-relationship metrics for this entity. */
  computed?: ComputedFieldSpec[];
}

// Drizzle introspection helpers (tableName / tableColumns / classifyRelations)
// live in ./introspect — the single home for Drizzle-internal access.

// ---------------------------------------------------------------------------
// Searchable columns — type-driven default.
//
// Include every string-typed column EXCEPT structural identifiers (IDs, FKs,
// external_id) and enum-typed columns (those use `eq`/`in` ops, not text
// matching). Result is broader than a curated list — `creator_email`,
// `language`, etc. become searchable on transcripts — but no per-entity
// metadata is needed.
//
// Override path: a column's `qField({ searchable })` wins over the heuristic —
// `true` opts a column in, `false` opts it out (removes heuristic noise like
// creator_email / language / in_reply_to). `isVisible: false` is never searchable.
// ---------------------------------------------------------------------------

function deriveSearchableColumns(table: PgTable, fieldMeta?: FieldMetaMap): string[] {
  const out: string[] = [];
  for (const [prop, col] of Object.entries(tableColumns(table))) {
    const meta = fieldMeta?.[prop];
    const dbName = col.name;
    if (meta?.isVisible === false) continue; // hidden → never searchable
    if (meta?.searchable === true) {
      out.push(dbName);
      continue;
    } // explicit opt-in
    if (meta?.searchable === false) continue; // explicit opt-out
    // Type-driven heuristic fallback: text columns that aren't IDs / FKs / enums.
    if (columnDataType(col) !== 'string') continue;
    const cName = (col as unknown as { columnType: string }).columnType;
    if (cName === 'PgUUID' || cName === 'PgEnumColumn') continue;
    if (dbName === 'id' || dbName === 'external_id' || dbName.endsWith('_id')) continue;
    out.push(dbName);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

export function buildRegistry(
  entities: readonly EntityRegistration[],
): Record<string, EntityDescriptor> {
  // Lookup: Drizzle's table name (plural) → the consumer's logical entity name.
  const tableToEntity: Record<string, EntityName> = {};
  for (const e of entities) tableToEntity[tableName(e.table)] = e.name;

  const out = {} as Record<string, EntityDescriptor>;

  for (const spec of entities) {
    const relationships: Record<string, RelDescriptor> = {};
    // Unsupported relations (through / composite / view) are skipped here and
    // reported by the doctor; an edge to an unregistered table is dropped likewise.
    for (const rel of classifyRelations(spec.relations).relations) {
      const target = tableToEntity[tableName(rel.targetTable)];
      if (!target) continue;
      relationships[rel.name] = { kind: rel.kind, target, fk: rel.fk };
    }

    out[spec.name] = {
      name: spec.name,
      table: spec.table,
      primaryKey: 'id',
      columns: spec.table as unknown as Record<string, PgColumn>,
      relationships,
      searchableColumns: deriveSearchableColumns(spec.table, spec.fieldMeta),
      eav: spec.eav,
      fieldMeta: spec.fieldMeta,
      meta: spec.meta,
      computed: spec.computed,
    };
  }

  return out;
}

// Mutable registry holder — populated by configureQueryRegistry() at bootstrap
// (directly, or via registerSchema()). The package ships no entities of its own; the consumer
// registers theirs. Engine code imports this stable reference and reads it at
// query time (after configuration). Empty until configured.
export const registry: Record<string, EntityDescriptor> = {};

/** Build the registry from consumer-registered entities and install it in place. */
export function configureQueryRegistry(entities: readonly EntityRegistration[]): void {
  const built = buildRegistry(entities);
  for (const k of Object.keys(registry)) delete registry[k];
  Object.assign(registry, built);
}
