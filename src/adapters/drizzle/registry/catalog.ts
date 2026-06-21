// Field Catalog — the single assembly point for "what fields does an entity
// have, and what does a consumer need to know about each."
//
// A CatalogField merges three sources, by FACET (precedence in
// docs/field-catalog-design.md):
//   - mechanics (type / nullable / enum)  ← Drizzle introspection (native cols)
//                                            or field_definitions.dataType (EAV-only)
//   - semantics (label / note / preview)  ← field_definitions (EAV) OR the
//                                            attribute-level qField meta (native),
//                                            else a derived default
//
// Native semantics and EAV semantics use the SAME vocabulary (label /
// description / selectOptions / isKeyField / keyFieldOrder / isVisible) — one
// metadata layer, two storage homes (a qField column stamp vs a field_definitions
// row). describe(), preview, etc. all project from here.

import type { PgColumn } from 'drizzle-orm/pg-core';
import type { EntityName } from '../../../internal/language/types.ts';
import type { FieldMap } from '../eav/field-map.ts';
import type { EntityKind } from './define-entity.ts';
import { registry } from './registry.ts';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export type ColumnType =
  | 'uuid'
  | 'string'
  | 'integer'
  | 'number'
  | 'datetime'
  | 'date'
  | 'boolean'
  | 'json'
  | 'enum';

export type Facet =
  | 'type'
  | 'nullable'
  | 'enumValues'
  | 'label'
  | 'note'
  | 'searchable'
  | 'preview';

export type FacetSource = 'drizzle' | 'field_definition' | 'field_meta' | 'derived';

export interface CatalogField {
  /** What the consumer puts in `on:` — snake_case for native cols, the field key for EAV. */
  key: string;
  /** Backing camelCase real column; absent for EAV-only fields. */
  column?: string;
  /** True when this field is resolved through field_values (EAV), not a real column. */
  eav: boolean;
  /** True when this field is a computed aggregate over a relationship (no backing
   *  column; derived at read time). Mutually exclusive with `eav`. */
  computed?: boolean;
  // mechanics
  type: ColumnType;
  nullable: boolean;
  enumValues?: readonly string[];
  // semantics
  label?: string;
  note?: string;
  // behavior
  searchable: boolean;
  preview: boolean;
  previewOrder?: number;
  /** Provenance per facet — for debugging / reconciliation. */
  sources: Partial<Record<Facet, FacetSource>>;
}

export interface ExampleFilter {
  description: string;
  filter: Record<string, unknown>;
}

export interface RelationshipInfo {
  name: string;
  kind: 'belongs_to' | 'has_many';
  target: EntityName;
  /** The FK column joining the two entities (on the child for has_many). */
  fk: string;
}

export interface EntityCatalog {
  entity: EntityName;
  summary?: string;
  /** Structural role — absent ⇒ 'entity'. 'junction' tables are traversable but
   *  not first-class query roots (the Explore picker hides them). */
  kind?: EntityKind;
  fields: CatalogField[];
  relationships: RelationshipInfo[];
  searchableColumns: string[];
  examples?: ExampleFilter[];
}

// ---------------------------------------------------------------------------
// Drizzle column introspection — the mechanical facts, never hand-typed.
// ---------------------------------------------------------------------------

interface PgColumnIntrospect {
  name: string;
  dataType?: string;
  columnType?: string;
  notNull?: boolean;
  enumValues?: readonly string[];
}

/** Map a Drizzle PgColumn to the catalog ColumnType (+ enum values). */
export function columnTypeFromPg(col: PgColumn): {
  type: ColumnType;
  enumValues?: readonly string[];
} {
  const c = col as unknown as PgColumnIntrospect;
  switch (c.columnType) {
    case 'PgUUID':
      return { type: 'uuid' };
    case 'PgEnumColumn':
      return { type: 'enum', enumValues: c.enumValues };
    case 'PgBoolean':
      return { type: 'boolean' };
    case 'PgInteger':
    case 'PgSmallInt':
    case 'PgBigInt53':
    case 'PgBigInt64':
      return { type: 'integer' };
    case 'PgNumeric':
    case 'PgReal':
    case 'PgDoublePrecision':
      return { type: 'number' };
    case 'PgDate':
      return { type: 'date' };
    case 'PgTimestamp':
    case 'PgTimestampString':
      return { type: 'datetime' };
    case 'PgJson':
    case 'PgJsonb':
      return { type: 'json' };
    case 'PgText':
    case 'PgVarchar':
    case 'PgChar':
      return { type: 'string' };
    default:
      break;
  }
  switch (c.dataType) {
    case 'boolean':
      return { type: 'boolean' };
    case 'number':
      return { type: 'number' };
    case 'date':
      return { type: 'datetime' };
    case 'json':
      return { type: 'json' };
    default:
      return { type: 'string' };
  }
}

/** Map a field_definitions.data_type to the catalog ColumnType (EAV-only fields). */
export function columnTypeFromDataType(dataType: string): ColumnType {
  switch (dataType) {
    case 'number':
    case 'money':
    case 'percentage':
    case 'decimal':
      return 'number';
    case 'integer':
      return 'integer';
    case 'date':
      return 'date';
    case 'datetime':
      return 'datetime';
    case 'boolean':
      return 'boolean';
    case 'select':
    case 'picklist':
    case 'multipicklist':
    case 'multiselect':
      return 'enum';
    default: // text, longtext, reference, email, url, id, json
      return 'string';
  }
}

function tableColumns(desc: { columns: unknown }): Record<string, PgColumn> {
  return desc.columns as Record<string, PgColumn>;
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

export function buildEntityCatalog(entity: EntityName, fieldMap?: FieldMap): EntityCatalog {
  const desc = registry[entity];
  const cols = tableColumns(desc);
  const fieldMeta = desc.fieldMeta;
  const searchableSet = new Set(desc.searchableColumns);

  // Link native columns to a same-named field_definitions row (case-insensitive),
  // so a CRM field that's ALSO a real column gets catalog semantics.
  const fieldByLowerKey = new Map<
    string,
    { key: string; def: ReturnType<NonNullable<FieldMap>['get']> }
  >();
  if (fieldMap) {
    for (const [key, def] of fieldMap) fieldByLowerKey.set(key.toLowerCase(), { key, def });
  }

  const fields: CatalogField[] = [];
  const claimedFieldKeys = new Set<string>();

  // 1) Native columns — mechanics from Drizzle, semantics from field_def → qField meta → derived.
  for (const [prop, col] of Object.entries(cols)) {
    const meta = fieldMeta?.[prop];
    if (meta?.isVisible === false) continue; // hidden — tenant/structural columns

    const c = col as unknown as PgColumnIntrospect;
    const key = c.name;
    const { type, enumValues: nativeEnum } = columnTypeFromPg(col);
    // A native varchar carries no Drizzle enum; a qField `selectOptions` declares its
    // domain (parity with EAV field_definitions.select_options) so describe still teaches
    // the agent the legal values — e.g. the observations.type taxonomy.
    const enumValues = nativeEnum ?? meta?.selectOptions;
    const sources: CatalogField['sources'] = {
      type: 'drizzle',
      nullable: 'drizzle',
    };
    if (enumValues) sources.enumValues = nativeEnum ? 'drizzle' : 'field_meta';

    const linked = fieldByLowerKey.get(key.toLowerCase());
    if (linked?.def) claimedFieldKeys.add(linked.key);

    // label / note — field_definitions wins, then qField meta (same vocabulary).
    let label: string | undefined;
    let note: string | undefined;
    if (linked?.def?.label) {
      label = linked.def.label;
      sources.label = 'field_definition';
    } else if (meta?.label) {
      label = meta.label;
      sources.label = 'field_meta';
    }
    if (linked?.def?.description) {
      note = linked.def.description;
      sources.note = 'field_definition';
    } else if (meta?.description) {
      note = meta.description;
      sources.note = 'field_meta';
    }

    // searchable — derived default unless qField meta overrides.
    let searchable = searchableSet.has(key);
    sources.searchable = 'derived';
    if (meta?.searchable !== undefined) {
      searchable = meta.searchable;
      sources.searchable = 'field_meta';
    }

    // preview — field_definitions.isKeyField → qField meta.isKeyField → false.
    let preview = false;
    let previewOrder: number | undefined;
    if (linked?.def?.isKeyField) {
      preview = true;
      previewOrder = linked.def.keyFieldOrder ?? undefined;
      sources.preview = 'field_definition';
    } else if (meta?.isKeyField) {
      preview = true;
      previewOrder = meta.keyFieldOrder;
      sources.preview = 'field_meta';
    }

    fields.push({
      key,
      column: prop,
      eav: false,
      type,
      nullable: c.notNull !== true,
      enumValues,
      label,
      note,
      searchable,
      preview,
      previewOrder,
      sources,
    });
  }

  // 2) EAV-only fields — mechanics from data_type; semantics from field_definitions.
  if (fieldMap && desc.eav) {
    for (const [key, def] of fieldMap) {
      if (claimedFieldKeys.has(key)) continue;
      if (cols[key] !== undefined) continue;
      const type = columnTypeFromDataType(def.dataType);
      const enumValues = def.selectOptions ?? undefined;
      const sources: CatalogField['sources'] = {
        type: 'field_definition',
        nullable: 'derived',
        ...(enumValues ? { enumValues: 'field_definition' as const } : {}),
        ...(def.label ? { label: 'field_definition' as const } : {}),
        ...(def.description ? { note: 'field_definition' as const } : {}),
        searchable: 'derived',
        preview: def.isKeyField ? 'field_definition' : 'derived',
      };
      fields.push({
        key,
        eav: true,
        type,
        nullable: true,
        enumValues,
        label: def.label || undefined,
        note: def.description ?? undefined,
        // Free-text EAV fields (text/textarea/longtext/email/url → type 'string')
        // support text ops — the engine ILIKEs the field_values value column, as
        // proven against dealname. enum/number/date/boolean keep eq/in semantics.
        // This is the per-field flag; the `on:"text"` magic fan-out stays
        // native-only (governed separately by searchableColumns).
        searchable: type === 'string',
        preview: def.isKeyField,
        previewOrder: def.keyFieldOrder ?? undefined,
        sources,
      });
    }
  }

  // 3) Computed metrics — aggregate-over-relationship fields. Mechanics from the
  //    spec (type; count never null, max/min/sum nullable). Always exposed
  //    (derived, not a raw column), non-searchable, optionally previewed.
  for (const spec of desc.computed ?? []) {
    fields.push({
      key: spec.key,
      eav: false,
      computed: true,
      type: spec.type,
      nullable: spec.agg !== 'count',
      label: spec.label,
      note: spec.description,
      searchable: false,
      preview: spec.preview ?? false,
      previewOrder: spec.previewOrder,
      sources: { type: 'derived', nullable: 'derived' },
    });
  }

  // Native first; EAV after, ordered by keyFieldOrder.
  fields.sort((a, b) => {
    if (a.eav !== b.eav) return a.eav ? 1 : -1;
    if (a.eav && b.eav)
      return (a.previewOrder ?? 999) - (b.previewOrder ?? 999) || a.key.localeCompare(b.key);
    return 0;
  });

  const relationships: RelationshipInfo[] = Object.entries(desc.relationships).map(
    ([name, rel]) => ({
      name,
      kind: rel.kind,
      target: rel.target,
      fk: rel.fk,
    }),
  );

  return {
    entity,
    summary: desc.meta?.summary,
    kind: desc.meta?.kind,
    fields,
    relationships,
    searchableColumns: desc.searchableColumns,
  };
}
