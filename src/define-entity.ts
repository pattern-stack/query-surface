// qEntity / qJunction / qField — attribute- and entity-level metadata for
// Drizzle tables (the `q` = Query, matching qField).
//
// Drizzle has no native `info=` / `.meta()` like SQLAlchemy/Pydantic, so we
// stamp metadata on the column builder (qField) and capture it when the table
// is built (qEntity). The result is co-located, attribute-level semantics
// that the field catalog reads alongside Drizzle's introspected mechanics.
//
//   const accountEntity = qEntity('accounts', {
//     id:   uuid('id').primaryKey().defaultRandom(),
//     name: qField(text('name'), { label: 'Account name', searchable: true, isKeyField: true, keyFieldOrder: 0 }),
//     userId: qField(uuid('user_id').notNull(), { isVisible: false }),
//   }, { summary: 'A company the user sells to.' });
//   export const accounts = accountEntity.table;          // the PgTable (typed)
//
// registerSchema() recovers the field/entity metadata from the table symbol
// itself (readEntityMeta) — no separate `accountsFieldMeta` export is needed.
//
// The EAV counterpart is a field_definitions row. FieldMeta deliberately mirrors
// that table's vocabulary (label / description / selectOptions / isKeyField /
// keyFieldOrder / group / isVisible) so native columns and EAV fields share ONE
// metadata layer — same field names, two storage homes — and both feed the same
// CatalogField. See docs/field-catalog-design.md.

import { type PgColumnBuilderBase, pgTable } from 'drizzle-orm/pg-core';

/**
 * Per-field semantics — the half Drizzle introspection can't give us, declared
 * with the SAME vocabulary as a `field_definitions` row (1:1 metadata layer).
 */
export interface FieldMeta {
  label?: string;
  /** Meaning / units / conventions. Mirrors field_definitions.description. */
  description?: string;
  /** Enum options. Native enums come from Drizzle; present here for parity. */
  selectOptions?: string[];
  /** Curated / displayed field — drives preview. Mirrors field_definitions.isKeyField. */
  isKeyField?: boolean;
  /** Sort position within the key-field set. Mirrors field_definitions.keyFieldOrder. */
  keyFieldOrder?: number;
  /** Layout grouping. Mirrors field_definitions.group. */
  group?: string;
  /** Exposed to the catalog. Defaults true; false ⇒ excluded (tenant/structural cols). */
  isVisible?: boolean;
  /** Override the type-derived searchable default (text-magic fan-out). */
  searchable?: boolean;

  // --- Analytics tags (the field-driven semantic layer). Mirror the columns an
  //     EAV field_definitions row would carry; consumed by analyticsFromRegistry
  //     to derive the aggregate manifest (NOT validated-and-dropped). ---
  /** Marks this field a measure or dimension for the aggregate stage. */
  role?: 'measure' | 'dimension';
  /** Default aggregation for a measure. */
  agg?: 'sum' | 'count' | 'count_distinct' | 'avg' | 'min' | 'max';
  /** additive | semi (not summable over time) | non (never sum). EXPLICIT — money
   *  and percentage both type as 'number', so additivity can't be inferred. */
  additivity?: 'additive' | 'semi' | 'non';
  /** Marks the time axis (semi-additive measures may not be summed across it). */
  time?: boolean;
}

/**
 * Structural classification of an entity — how the surface mechanically treats
 * it, independent of what business thing it is (domain meaning stays consumer-
 * /agent-side). `entity` is a first-class query root (route, picker, drill
 * target); `junction` is a link/edge table (still fully traversable, but not a
 * root — the picker hides it). Default when unset is `entity`. Closed set on
 * purpose: this package is an opinionated surface, and each kind is a contract
 * the query/route layer reasons about.
 */
export type EntityKind = 'entity' | 'junction';

/** Entity-level semantics (not tied to a single column). */
export interface EntityMeta {
  summary?: string;
  /** Structural role. Absent ⇒ treated as `entity`. See {@link EntityKind}. */
  kind?: EntityKind;
}

/** key (column property name) → its metadata. */
export type FieldMetaMap = Record<string, FieldMeta>;

const META = Symbol.for('qsp:fieldMeta');
// Stamped onto the built table so a schema-walker (registerSchema) can recover
// the metadata from the table alone — without the separate fieldMeta export.
const TABLE_FIELD_META = Symbol.for('qsp:tableFieldMeta');
const TABLE_ENTITY_META = Symbol.for('qsp:tableEntityMeta');

/** Attach metadata to a Drizzle column builder. Returns the builder unchanged. */
export function qField<B>(builder: B, meta: FieldMeta): B {
  (builder as unknown as Record<symbol, unknown>)[META] = meta;
  return builder;
}

/**
 * Build a pgTable AND harvest the qField metadata stamped on its columns.
 * Returns the typed table plus the captured field/entity metadata; the metadata
 * is also stamped onto the table object so it travels with it (see readEntityMeta).
 * The `q` prefix mirrors qField — both are the Query-surface annotation layer.
 */
export function qEntity<T extends Record<string, PgColumnBuilderBase>>(
  name: string,
  columns: T,
  meta: EntityMeta = {},
) {
  const fieldMeta: FieldMetaMap = {};
  for (const [key, builder] of Object.entries(columns)) {
    const m = (builder as unknown as Record<symbol, unknown>)[META] as FieldMeta | undefined;
    if (m) fieldMeta[key] = m;
  }
  const table = pgTable(name, columns);
  (table as unknown as Record<symbol, unknown>)[TABLE_FIELD_META] = fieldMeta;
  (table as unknown as Record<symbol, unknown>)[TABLE_ENTITY_META] = meta;
  return { table, fieldMeta, meta };
}

/**
 * Like {@link qEntity}, but stamps `kind: 'junction'` — the table is a
 * link/edge between two entities (e.g. a participants join table). Still fully
 * queryable and traversable; it's just classified out of the first-class entity
 * set (the Explore picker hides it). Sugar for `qEntity(n, c, { kind:
 * 'junction', ... })`, giving a subclass-style call-site and a home for any
 * junction-specific defaults later.
 */
export function qJunction<T extends Record<string, PgColumnBuilderBase>>(
  name: string,
  columns: T,
  meta: Omit<EntityMeta, 'kind'> = {},
) {
  return qEntity(name, columns, { ...meta, kind: 'junction' });
}

/** Recover qField metadata stamped on a table by qEntity (for schema-walking). */
export function readEntityMeta(table: unknown): {
  fieldMeta?: FieldMetaMap;
  meta?: EntityMeta;
} {
  const t = table as Record<symbol, unknown>;
  return {
    fieldMeta: t[TABLE_FIELD_META] as FieldMetaMap | undefined,
    meta: t[TABLE_ENTITY_META] as EntityMeta | undefined,
  };
}
