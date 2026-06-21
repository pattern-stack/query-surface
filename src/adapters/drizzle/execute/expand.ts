// Expand — relational hydration on /fetch.
//
// Given a list of rows from one entity and an array of dotted expand paths,
// attach related entities inline. belongs_to becomes a child object on the
// row; has_many becomes an array.
//
// Batched: ONE SELECT per expand segment using `WHERE id IN (...)` (or
// `WHERE fk IN (...)` for has_many). Avoids N+1.
//
// Recursive for nested paths: `expand: ['opportunity.account']` runs the
// `opportunity` batch first, then recursively expands `account` on the
// attached opportunity objects.
//
// Depth-limited at 3 hops to prevent runaway expansion.

import { type SQL, and, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { EntityName, FilterExpression } from '../../../internal/language/types.ts';
import { compile } from '../compile/compiler.ts';
import type { EavContext } from '../eav/field-map.ts';
import { hydrateEavRows } from '../eav/read.ts';
import { registry } from '../registry/registry.ts';
import { nativeSelectShape } from './preview.ts';

const MAX_DEPTH = 3;

/**
 * Per-entity tenancy-scope resolver the SERVICE supplies so expand folds scope
 * through EVERY traversed relation (invariant #3 — scope is per-source, fail-closed,
 * folded through every traversed entity). Returns the scope predicate to AND into a
 * relation's batch read; `undefined` when the entity is unscoped-by-design (no
 * resolver configured) or declared TENANT_GLOBAL; and THROWS on a coverage gap (a
 * configured resolver that does not cover a traversed entity) — never read it
 * unscoped. Without this, expand reads related entities with a bare FK/PK `IN` and
 * no scope (a cross-scope read leak).
 */
export type ExpandScopeResolver = (entity: EntityName) => FilterExpression | undefined;

/**
 * AND the traversed relation's tenancy scope into its batch-read WHERE. The scope
 * predicate is compiled through the SAME filter compiler the verbs use (one
 * expression language, invariant #4), so a dotted/EAV scope leaf resolves
 * identically; its joins (rare — scope is usually a local column) are returned for
 * the caller to leftJoin. `scopeFor` may THROW (fail-closed coverage gap).
 */
function scopedRead(
  target: EntityName,
  baseCond: SQL,
  scopeFor: ExpandScopeResolver | undefined,
  eav: EavContext | undefined,
): { where: SQL; joins: { table: PgTable; on: SQL }[] } {
  const pred = scopeFor?.(target); // may THROW on a coverage gap (fail-closed)
  if (!pred) return { where: baseCond, joins: [] };
  const sc = compile({ entity: target, filter: pred }, eav);
  return { where: sc.where ? (and(baseCond, sc.where) as SQL) : baseCond, joins: sc.joins };
}

// Tree structure built from the dotted paths.
//   ['opportunity', 'opportunity.account', 'chunks']
// becomes:
//   { opportunity: { account: {} }, chunks: {} }
interface ExpandTree {
  [relName: string]: ExpandTree;
}

function camel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function parseExpandPaths(paths: string[]): ExpandTree {
  const tree: ExpandTree = {};
  for (const p of paths) {
    const segments = p.split('.').filter((s) => s.length > 0);
    let cursor = tree;
    for (const seg of segments) {
      if (!cursor[seg]) cursor[seg] = {};
      cursor = cursor[seg];
    }
  }
  return tree;
}

// Run an expand tree against a row set rooted at `entityName`. Mutates rows
// in place — attaches each relationship as a property on each row.
export async function expandRows(
  // biome-ignore lint/suspicious/noExplicitAny: engine is schema-agnostic; Drizzle's DB type is generic over the host schema, unknown at the package level
  db: NodePgDatabase<any>,
  entityName: EntityName,
  rows: Array<Record<string, unknown>>,
  tree: ExpandTree,
  eav?: EavContext,
  scopeFor?: ExpandScopeResolver,
  depth = 0,
): Promise<void> {
  if (rows.length === 0 || Object.keys(tree).length === 0) return;
  if (depth >= MAX_DEPTH) {
    throw new Error(
      `Expand depth exceeded ${MAX_DEPTH} hops at entity '${entityName}'. Tighten the expand paths or break into separate /fetch calls.`,
    );
  }

  const desc = registry[entityName];

  for (const [relName, subTree] of Object.entries(tree)) {
    const rel = desc.relationships[relName];
    if (!rel) {
      throw new Error(
        `Expand path '${relName}' invalid on entity '${entityName}'. ` +
          `Available relationships: ${Object.keys(desc.relationships).join(', ') || '(none)'}`,
      );
    }

    const targetDesc = registry[rel.target];
    const targetCols = targetDesc.columns as Record<string, PgColumn>;

    if (rel.kind === 'belongs_to') {
      await expandBelongsTo(
        db,
        rows,
        rel,
        relName,
        targetDesc,
        targetCols,
        subTree,
        eav,
        scopeFor,
        depth,
      );
    } else if (rel.kind === 'has_many') {
      await expandHasMany(
        db,
        rows,
        desc,
        rel,
        relName,
        targetDesc,
        targetCols,
        subTree,
        eav,
        scopeFor,
        depth,
      );
    }
  }
}

async function expandBelongsTo(
  // biome-ignore lint/suspicious/noExplicitAny: engine is schema-agnostic; Drizzle's DB type is generic over the host schema, unknown at the package level
  db: NodePgDatabase<any>,
  rows: Array<Record<string, unknown>>,
  rel: { kind: 'belongs_to'; target: EntityName; fk: string },
  relName: string,
  targetDesc:
    | ReturnType<(typeof registry)[EntityName] extends infer T ? () => T : never>
    | (typeof registry)[EntityName],
  targetCols: Record<string, PgColumn>,
  subTree: ExpandTree,
  eav: EavContext | undefined,
  scopeFor: ExpandScopeResolver | undefined,
  depth: number,
): Promise<void> {
  // Rows are snake_case keyed (nativeSelectShape), so read the FK by rel.fk.
  // Collect distinct non-null FK values across all rows
  const fkValues = [
    ...new Set(
      rows.map((r) => r[rel.fk]).filter((v): v is string => typeof v === 'string' && v.length > 0),
    ),
  ];

  if (fkValues.length === 0) {
    // No FKs to resolve — every row gets null for this relationship
    for (const r of rows) r[relName] = null;
    return;
  }

  const pkCol = targetCols[(targetDesc as { primaryKey: string }).primaryKey];
  // Fold the target's tenancy scope into the batch read (invariant #3): an
  // out-of-scope parent then resolves to null below (byId miss), never leaks.
  const { where, joins } = scopedRead(rel.target, inArray(pkCol, fkValues), scopeFor, eav);
  // biome-ignore lint/suspicious/noExplicitAny: runtime schema-registry descriptor + dynamic leftJoin accumulator
  let tq: any = db
    .select(nativeSelectShape(rel.target, eav?.fieldMaps[rel.target]))
    // biome-ignore lint/suspicious/noExplicitAny: runtime schema-registry descriptor; table shape is resolved dynamically at query time
    .from((targetDesc as any).table);
  for (const j of joins) tq = tq.leftJoin(j.table, j.on);
  const targetRows = (await tq.where(where)) as Array<Record<string, unknown>>;

  // Build id → row map
  const byId = new Map<string, Record<string, unknown>>();
  const pkKey = (targetDesc as { primaryKey: string }).primaryKey;
  for (const tr of targetRows) {
    const id = tr[pkKey];
    if (typeof id === 'string') byId.set(id, tr);
  }

  // Merge EAV fields into the materialized targets so an expanded EAV entity
  // (e.g. opportunity) carries StageName/Amount/etc. inline like a real row.
  await hydrateEavRows(db, rel.target, targetRows, eav?.fieldMaps[rel.target]);

  // Attach
  for (const r of rows) {
    const fk = r[rel.fk];
    r[relName] = typeof fk === 'string' ? (byId.get(fk) ?? null) : null;
  }

  // Recurse on the attached children if the subTree asks for deeper expansion
  if (Object.keys(subTree).length > 0) {
    await expandRows(db, rel.target, targetRows, subTree, eav, scopeFor, depth + 1);
  }
}

async function expandHasMany(
  // biome-ignore lint/suspicious/noExplicitAny: engine is schema-agnostic; Drizzle's DB type is generic over the host schema, unknown at the package level
  db: NodePgDatabase<any>,
  rows: Array<Record<string, unknown>>,
  parentDesc: (typeof registry)[EntityName],
  rel: { kind: 'has_many'; target: EntityName; fk: string },
  relName: string,
  targetDesc: (typeof registry)[EntityName],
  targetCols: Record<string, PgColumn>,
  subTree: ExpandTree,
  eav: EavContext | undefined,
  scopeFor: ExpandScopeResolver | undefined,
  depth: number,
): Promise<void> {
  const parentPkKey = parentDesc.primaryKey;
  const parentIds = [
    ...new Set(
      rows
        .map((r) => r[parentPkKey])
        .filter((v): v is string => typeof v === 'string' && v.length > 0),
    ),
  ];

  if (parentIds.length === 0) {
    for (const r of rows) r[relName] = [];
    return;
  }

  // camel(rel.fk) indexes the Drizzle table object (keyed by JS prop) to get the
  // PgColumn for the WHERE; the child ROW is snake_case keyed, so read cr[rel.fk].
  const fkCol = targetCols[camel(rel.fk)];
  // Fold the child's tenancy scope into the batch read (invariant #3): out-of-scope
  // children are excluded pre-grouping, so a parent only gets the children it may see.
  const { where, joins } = scopedRead(rel.target, inArray(fkCol, parentIds), scopeFor, eav);
  // biome-ignore lint/suspicious/noExplicitAny: runtime schema-registry descriptor + dynamic leftJoin accumulator
  let cq: any = db
    .select(nativeSelectShape(rel.target, eav?.fieldMaps[rel.target]))
    // biome-ignore lint/suspicious/noExplicitAny: runtime schema-registry descriptor; table shape is resolved dynamically at query time
    .from((targetDesc as any).table);
  for (const j of joins) cq = cq.leftJoin(j.table, j.on);
  const childRows = (await cq.where(where)) as Array<Record<string, unknown>>;

  // Group by FK value
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const cr of childRows) {
    const fkVal = cr[rel.fk];
    if (typeof fkVal !== 'string') continue;
    if (!groups.has(fkVal)) groups.set(fkVal, []);
    // NB: the line above guarantees the key exists (groups.set when absent)
    groups.get(fkVal)!.push(cr);
  }

  // Merge EAV fields into the materialized children before attaching.
  await hydrateEavRows(db, rel.target, childRows, eav?.fieldMaps[rel.target]);

  // Attach
  for (const r of rows) {
    const pk = r[parentPkKey];
    r[relName] = typeof pk === 'string' ? (groups.get(pk) ?? []) : [];
  }

  // Recurse on attached children (flat list across all parents — same depth+1)
  if (Object.keys(subTree).length > 0) {
    await expandRows(db, rel.target, childRows, subTree, eav, scopeFor, depth + 1);
  }
}
