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

import { inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { EntityName } from '../../../internal/language/types.ts';
import type { EavContext } from '../eav/field-map.ts';
import { hydrateEavRows } from '../eav/read.ts';
import { registry } from '../registry/registry.ts';
import { nativeSelectShape } from './preview.ts';

const MAX_DEPTH = 3;

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
      await expandBelongsTo(db, rows, rel, relName, targetDesc, targetCols, subTree, eav, depth);
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
  const targetRows = (await db
    .select(nativeSelectShape(rel.target, eav?.fieldMaps[rel.target]))
    // biome-ignore lint/suspicious/noExplicitAny: runtime schema-registry descriptor; table shape is resolved dynamically at query time
    .from((targetDesc as any).table)
    .where(inArray(pkCol, fkValues))) as Array<Record<string, unknown>>;

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
    await expandRows(db, rel.target, targetRows, subTree, eav, depth + 1);
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
  const childRows = (await db
    .select(nativeSelectShape(rel.target, eav?.fieldMaps[rel.target]))
    // biome-ignore lint/suspicious/noExplicitAny: runtime schema-registry descriptor; table shape is resolved dynamically at query time
    .from((targetDesc as any).table)
    .where(inArray(fkCol, parentIds))) as Array<Record<string, unknown>>;

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
    await expandRows(db, rel.target, childRows, subTree, eav, depth + 1);
  }
}
