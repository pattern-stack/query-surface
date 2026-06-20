import type { CatalogField, EntityCatalog } from '../../adapters/drizzle/registry/catalog.ts';
import { RANK_SCORE_KEY, RANK_SNIPPET_KEY, SNIPPETS_KEY } from '../../internal/language/types.ts';
import type { ExposeColumns } from './options.ts';

/**
 * Consumer-facing projection of the engine's internal catalog + rows.
 *
 * Two jobs, applied once at the public call-path (the use-cases), never in the
 * service (host code composing on the service wants the raw shape):
 *  1. Strip implementation facets — `column`, `eav`, `preview`, `sources`,
 *     relationship `fk`, entity `searchableColumns` — that leak introspection
 *     internals into the contract.
 *  2. Curate the field set — a native column reaches the consumer only if it is
 *     allow-listed in `exposeColumns[entity]`; EAV fields are already
 *     is_visible-curated by the engine, so they pass through. `id` always
 *     passes (the row handle). With no allowlist configured, native columns
 *     pass through unchanged (facet-trim only) — the host opts in by providing
 *     the map.
 */

export interface PublicCatalogField {
  key: string;
  label?: string;
  type: string;
  nullable: boolean;
  searchable: boolean;
  note?: string;
  enumValues?: readonly string[];
}

export interface PublicRelationship {
  name: string;
  kind: string;
  target: string;
}

export interface PublicEntityCatalog {
  entity: string;
  fields: PublicCatalogField[];
  relationships: PublicRelationship[];
}

function isPublicField(field: CatalogField, entity: string, expose?: ExposeColumns): boolean {
  if (field.eav) return true;
  // Computed metrics are curated by declaration (not raw columns), so they pass
  // the native-column allowlist the same way EAV fields do.
  if (field.computed) return true;
  if (field.key === 'id') return true;
  if (!expose) return true;
  return (expose[entity] ?? []).includes(field.key);
}

function toPublicField(f: CatalogField): PublicCatalogField {
  return {
    key: f.key,
    ...(f.label ? { label: f.label } : {}),
    type: f.type,
    nullable: f.nullable,
    searchable: f.searchable,
    ...(f.note ? { note: f.note } : {}),
    ...(f.enumValues && f.enumValues.length > 0 ? { enumValues: f.enumValues } : {}),
  };
}

/** Lean describe shape: facets stripped, native columns filtered to the allowlist. */
export function projectCatalog(
  catalog: EntityCatalog,
  expose?: ExposeColumns,
): PublicEntityCatalog {
  const entity = catalog.entity as string;
  return {
    entity,
    fields: catalog.fields.filter((f) => isPublicField(f, entity, expose)).map(toPublicField),
    relationships: catalog.relationships.map((r) => ({
      name: r.name,
      kind: r.kind,
      target: r.target as string,
    })),
  };
}

/**
 * Row keys a consumer may see for an entity: the public field set plus
 * relationship names, so `expand`ed relations survive projection.
 */
export function publicKeySet(catalog: EntityCatalog, expose?: ExposeColumns): Set<string> {
  const entity = catalog.entity as string;
  const keys = new Set<string>();
  for (const f of catalog.fields) {
    if (isPublicField(f, entity, expose)) keys.add(f.key);
  }
  for (const r of catalog.relationships) keys.add(r.name);
  keys.add(SNIPPETS_KEY); // additive preview-row meta survives projection
  keys.add(RANK_SCORE_KEY); // rank_by `_rank` score survives projection
  keys.add(RANK_SNIPPET_KEY); // rank_by `_snippet` survives projection
  return keys;
}

/** Pick only the allowed keys from a raw row. */
export function projectRow(
  row: Record<string, unknown>,
  keys: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(row)) {
    if (keys.has(k)) out[k] = row[k];
  }
  return out;
}

/**
 * Per-entity projection rule: the allow-listed scalar field keys, and the
 * relationship names mapped to their TARGET entity so an expanded relation is
 * projected against the target's own allowlist (not the parent's).
 */
export interface ProjectionEntry {
  fields: Set<string>;
  rels: Map<string, string>;
}

/**
 * Build the projection rule for every entity once, so a fetched row tree (root
 * + `expand`ed relations) can be projected recursively. Without this, the
 * top-level row is filtered but expanded relations pass through RAW — leaking
 * tenant FKs (`organization_id`/`user_id`) and `provider_metadata` blobs the
 * parent's allowlist was meant to drop.
 */
export function buildProjectionIndex(
  catalogs: EntityCatalog[],
  expose?: ExposeColumns,
): Map<string, ProjectionEntry> {
  const index = new Map<string, ProjectionEntry>();
  for (const c of catalogs) {
    const entity = c.entity as string;
    const fields = new Set<string>();
    for (const f of c.fields) {
      if (isPublicField(f, entity, expose)) fields.add(f.key);
    }
    fields.add(SNIPPETS_KEY); // additive preview-row meta survives projection
    fields.add(RANK_SCORE_KEY);
    fields.add(RANK_SNIPPET_KEY);
    const rels = new Map<string, string>();
    for (const r of c.relationships) rels.set(r.name, r.target as string);
    index.set(entity, { fields, rels });
  }
  return index;
}

/**
 * Project a fetched row and any `expand`ed relations recursively. Each nested
 * relation value is projected against its TARGET entity's allowlist; a scalar
 * field survives only if allow-listed for its OWN entity. An unrecognized
 * entity fails closed (drops to empty) rather than leaking raw columns.
 */
export function projectRowDeep(
  row: Record<string, unknown>,
  entity: string,
  index: Map<string, ProjectionEntry>,
): Record<string, unknown> {
  const entry = index.get(entity);
  if (!entry) return {};
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(row)) {
    const target = entry.rels.get(k);
    if (target !== undefined) {
      const v = row[k];
      if (Array.isArray(v)) {
        out[k] = v.map((item) =>
          item && typeof item === 'object'
            ? projectRowDeep(item as Record<string, unknown>, target, index)
            : item,
        );
      } else if (v && typeof v === 'object') {
        out[k] = projectRowDeep(v as Record<string, unknown>, target, index);
      } else {
        out[k] = v; // null / absent relation
      }
      continue;
    }
    if (entry.fields.has(k)) out[k] = row[k];
  }
  return out;
}
