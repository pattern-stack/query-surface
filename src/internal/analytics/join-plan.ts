// join-plan.ts — the dialect-neutral join-plan resolver (ADR-0024 wave 1).
//
// A PURE graph walk over the cardinality graph (AggRegistry.rels). Given a dotted
// dimension/filter path, it returns a tagged descriptor of HOW that path reaches its
// column — a belongs_to LEFT-JOIN chain (to-one), a has_many semijoin (filter only),
// a plain local column, or a typed reject. It NEVER emits Drizzle/SQL: the descriptor
// carries only entity + column + fk/pk NAMES. The Drizzle lowering (compile-drizzle.ts,
// the driven adapter) turns the descriptor into LEFT JOIN / EXISTS SQL and folds scope.
//
// This is the plan|lower seam the package is moving toward (hexagonal IR): when
// retrieval's compiler is cleaved into plan+lower, this is the shape it speaks. Keep it
// free of drizzle-orm imports — that is the whole point.
//
// Dialect: entity-prefix. `accounts.name` addresses the TARGET ENTITY `accounts` (the
// registered logical name) + the db column `name`; a head that is not a registered entity
// (or is the source entity) is a LOCAL column path (json subpaths included). A target
// reachable by >1 distinct to-one path (the diamond) is REJECTED as ambiguous rather than
// silently picking an edge — the retrieval path's silent edge-pick is a known divergence
// (see the characterization net), and ADR-0024 forbids silent cross-grain divergence.

import type { AggColType, AggRegistry } from './types';

export type DimRole = 'group' | 'filter';
export type JoinPlanRejectCode = 'to-many' | 'ambiguous' | 'unreachable' | 'unsupported';

/** One belongs_to hop: LEFT JOIN `to` ON (`from`.`fk` = `to`.`toPk`). */
export interface JoinHop {
  from: string;
  to: string;
  fk: string; // FK column (db name) on `from`
  toPk: string; // PK column (db name) on `to`
}

export type JoinPlan =
  | { kind: 'local'; column: string }
  | { kind: 'to-one'; target: string; column: string; hops: JoinHop[]; traversed: string[] }
  | { kind: 'semijoin'; child: string; fk: string; parentPk: string; column: string }
  | { kind: 'reject'; code: JoinPlanRejectCode; reason: string };

/** Every simple belongs_to-only path from→to (≤ maxDepth). length>1 ⇒ the diamond. */
export function belongsToPaths(
  reg: AggRegistry,
  from: string,
  to: string,
  maxDepth = 6,
): JoinHop[][] {
  const out: JoinHop[][] = [];
  const dfs = (cur: string, path: JoinHop[], seen: ReadonlySet<string>) => {
    if (path.length >= maxDepth) return;
    const ent = reg[cur];
    if (!ent) return;
    for (const rel of Object.values(ent.rels)) {
      if (rel.kind !== 'belongs_to') continue;
      const tgt = reg[rel.target];
      if (!tgt || seen.has(rel.target)) continue;
      const hop: JoinHop = { from: cur, to: rel.target, fk: rel.fk, toPk: tgt.pk };
      if (rel.target === to) {
        out.push([...path, hop]);
        continue;
      }
      dfs(rel.target, [...path, hop], new Set([...seen, rel.target]));
    }
  };
  dfs(from, [], new Set([from]));
  return out;
}

/** A direct has_many child edge source→child (the semijoin shape). */
function directHasMany(reg: AggRegistry, from: string, child: string): { fk: string } | null {
  const ent = reg[from];
  if (!ent) return null;
  for (const rel of Object.values(ent.rels)) {
    if (rel.kind === 'has_many' && rel.target === child) return { fk: rel.fk };
  }
  return null;
}

/** Is `to` reachable from `from` by ANY edge path (kind-agnostic)? Used only to tell a
 *  to-many reject ("would fan out") apart from an unreachable one ("not a relation"). */
function reachableAny(reg: AggRegistry, from: string, to: string): boolean {
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    const ent = reg[cur];
    if (!ent) continue;
    for (const rel of Object.values(ent.rels)) {
      if (rel.target === to) return true;
      if (!seen.has(rel.target) && reg[rel.target]) {
        seen.add(rel.target);
        queue.push(rel.target);
      }
    }
  }
  return false;
}

/** Resolve a dotted group_by/filter path to a join plan. Pure: graph + names only.
 *  Column EXISTENCE is validated by the lowering (nativeColSql against colByDbName) —
 *  this resolver only decides reachability + cardinality + the join shape. */
export function resolveJoinPlan(
  reg: AggRegistry,
  sourceEntity: string,
  dotted: string,
  role: DimRole,
): JoinPlan {
  const parts = dotted.split('.');
  const head = parts[0]!;
  const isCrossEntity = head in reg && head !== sourceEntity;

  if (!isCrossEntity) {
    // local: a column on the source (an explicit `source.` prefix is stripped).
    const column = head === sourceEntity ? parts.slice(1).join('.') : dotted;
    if (column.length === 0) {
      return { kind: 'reject', code: 'unsupported', reason: `"${dotted}" names no column` };
    }
    return { kind: 'local', column };
  }

  // cross-entity: head is the TARGET entity; the remainder is the column (+ json path).
  const target = head;
  const column = parts.slice(1).join('.');
  if (column.length === 0) {
    return {
      kind: 'reject',
      code: 'unsupported',
      reason: `"${dotted}" names entity ${target} without a column`,
    };
  }

  const toOne = belongsToPaths(reg, sourceEntity, target);
  if (toOne.length === 1) {
    const hops = toOne[0]!;
    return { kind: 'to-one', target, column, hops, traversed: hops.map((h) => h.to) };
  }
  if (toOne.length > 1) {
    return {
      kind: 'reject',
      code: 'ambiguous',
      reason: `dimension "${dotted}" is reachable from ${sourceEntity} by ${toOne.length} distinct to-one paths (a join diamond) — ambiguous; this slice rejects rather than silently picking an edge`,
    };
  }

  // no to-one path.
  if (role === 'filter') {
    const child = directHasMany(reg, sourceEntity, target);
    if (child) {
      return {
        kind: 'semijoin',
        child: target,
        fk: child.fk,
        parentPk: reg[sourceEntity]!.pk,
        column,
      };
    }
    if (reachableAny(reg, sourceEntity, target)) {
      return {
        kind: 'reject',
        code: 'unsupported',
        reason: `filter "${dotted}" crosses ${sourceEntity}→${target} via a multi-hop collection path — not supported (wave 1: a direct has_many child only)`,
      };
    }
    return {
      kind: 'reject',
      code: 'unreachable',
      reason: `filter "${dotted}": ${target} is not reachable from ${sourceEntity}`,
    };
  }

  // group role: any to-many in the path is illegal (would fan out the measure).
  if (reachableAny(reg, sourceEntity, target)) {
    return {
      kind: 'reject',
      code: 'to-many',
      reason: `dimension "${dotted}" is not conformed to ${sourceEntity} grain (${sourceEntity}→${target} is to-many; grouping by it would fan out the measure). Only to-one (belongs_to) dimensions are groupable.`,
    };
  }
  return {
    kind: 'reject',
    code: 'unreachable',
    reason: `dimension "${dotted}": ${target} is not reachable from ${sourceEntity}`,
  };
}

/** A dimension legal at `sourceEntity` grain: its own dimension fields ∪ the dimension
 *  fields of every entity reachable by an UNAMBIGUOUS to-one path. The graph-derived
 *  conformed set `describe` advertises per metric. Native (registry-tagged) dims only —
 *  EAV dimension tags are a later wave. */
export interface ConformedDim {
  /** what the caller passes in group_by/filter: `col` (own) | `entity.col` (to-one). */
  path: string;
  column: string;
  type: AggColType;
  owner: string;
  via: 'local' | 'to-one';
}

export function conformedDimensions(reg: AggRegistry, sourceEntity: string): ConformedDim[] {
  const out: ConformedDim[] = [];
  const ent = reg[sourceEntity];
  if (!ent) return out;
  for (const [col, f] of Object.entries(ent.fields)) {
    if (f.role === 'dimension') {
      out.push({ path: col, column: col, type: f.type, owner: sourceEntity, via: 'local' });
    }
  }
  for (const target of Object.keys(reg)) {
    if (target === sourceEntity) continue;
    // unambiguous to-one only — a diamond target is excluded (the resolver rejects it).
    if (belongsToPaths(reg, sourceEntity, target).length !== 1) continue;
    for (const [col, f] of Object.entries(reg[target]!.fields)) {
      if (f.role === 'dimension') {
        out.push({
          path: `${target}.${col}`,
          column: col,
          type: f.type,
          owner: target,
          via: 'to-one',
        });
      }
    }
  }
  return out;
}
