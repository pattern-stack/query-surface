// buildRegistry() — derives the query registry at boot by introspecting
// Drizzle's relations() declarations + column metadata. Replaces the
// hand-authored, codegen-owned registry of the v1 approach.
//
// Why runtime introspection instead of codegen:
//   - Single source of truth: the relational graph lives in `<entity>Relations`,
//     declared next to the Drizzle table. Engineers maintain one file per entity
//     instead of `entity.yaml + entity.ts + the generated registry`.
//   - No YAMLs to throw away. No codegen step to run before drizzle-kit push.
//   - Types and enum values come from Drizzle's column introspection — they
//     can't drift from the schema.
//
// What we still need humans to declare (per-entity, in the .entity.ts file):
//   - relations(table, ({ one, many }) => ({...}))  ← idiomatic Drizzle
//
// What we DERIVE from Drizzle metadata:
//   - belongs_to: target table from one()'s referencedTable; fk from config.fields[0]
//   - has_many: target table from many()'s referencedTable; fk found by inverse one() lookup
//   - searchableColumns: every text column that isn't an ID/UUID/enum
//   - column types + enum values: directly from PgColumn introspection

import type { Relations } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

import type { EntityName } from '../../../internal/language/types.ts';
import type { EntityMeta, FieldMetaMap } from './define-entity.ts';
import { evaluateRelations, tableColumns, tableName } from './introspect.ts';

// ---------------------------------------------------------------------------
// Output shape — matches what compiler.ts / expand.ts / preview.ts read. Same
// interface as the v1 codegen registry, new (introspected) derivation.
// ---------------------------------------------------------------------------

export type RelDescriptor =
  | { kind: 'belongs_to'; target: EntityName; fk: string }
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
  relations?: Relations;
  /** EAV strategy when the entity's fields are value-table-backed. */
  eav?: EavStrategy;
  fieldMeta?: FieldMetaMap;
  meta?: EntityMeta;
}

// Drizzle introspection helpers (tableName / tableColumns / evaluateRelations)
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
    if (col.dataType !== 'string') continue;
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

  // Pass 1: build descriptors with belongs_to filled in. has_many FKs left
  // as placeholders to resolve in pass 2 (Drizzle's many() doesn't carry
  // the FK — it lives on the inverse one() declaration).
  const out = {} as Record<string, EntityDescriptor>;

  for (const spec of entities) {
    const cfg = spec.relations ? evaluateRelations(spec.relations, spec.table) : {};
    const relationships: Record<string, RelDescriptor> = {};

    for (const [relName, rel] of Object.entries(cfg)) {
      const target = tableToEntity[tableName(rel.referencedTable)];
      if (!target) continue;

      if (rel.constructor.name === 'One') {
        // NB: a drizzle One-relation always carries config with at least one field
        const fkName = rel.config!.fields[0].name;
        relationships[relName] = { kind: 'belongs_to', target, fk: fkName };
      } else if (rel.constructor.name === 'Many') {
        // FK resolved in pass 2 — leave a marker.
        relationships[relName] = { kind: 'has_many', target, fk: '' };
      }
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
    };
  }

  // Pass 2: for each has_many, find the inverse belongs_to on the target
  // entity and copy its FK column name.
  for (const desc of Object.values(out)) {
    for (const rel of Object.values(desc.relationships)) {
      if (rel.kind !== 'has_many' || rel.fk !== '') continue;
      const targetDesc = out[rel.target];
      const inverse = Object.values(targetDesc.relationships).find(
        (r) => r.kind === 'belongs_to' && r.target === desc.name,
      );
      if (inverse) {
        rel.fk = inverse.fk;
      } else {
        // Shouldn't happen if relations() is symmetric. Throw a clear error.
        throw new Error(
          `buildRegistry: has_many '${desc.name}' → '${rel.target}' has no inverse belongs_to. ` +
            `Add a 'one(${desc.name})' declaration to ${rel.target}Relations.`,
        );
      }
    }
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
