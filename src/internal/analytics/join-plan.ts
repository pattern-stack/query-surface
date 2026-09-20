// join-plan.ts — the dialect-neutral join-plan resolver (ADR-0024 wave 1).
//
// A PURE graph walk over the cardinality graph (AggRegistry.rels). Given a dotted
// dimension/filter path, it returns a tagged descriptor of HOW that path reaches its
// column — a to-one LEFT-JOIN chain (belongs_to / has_one hops), a has_many semijoin (filter only),
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

/** One to-one hop: LEFT JOIN `to` ON (`from`.`fromCol` = `to`.`toCol`).
 *  belongs_to (fk on `from`): fromCol = the fk, toCol = `to`'s pk.
 *  has_one    (fk on `to`):   fromCol = `from`'s pk, toCol = the fk.
 *  Either way the join is 1:1 — it cannot fan the source rows. */
export interface JoinHop {
  from: string;
  to: string;
  kind: 'belongs_to' | 'has_one';
  fromCol: string; // column (db name) on `from`
  toCol: string; // column (db name) on `to`
}

export type JoinPlan =
  | { kind: 'local'; column: string }
  | { kind: 'to-one'; target: string; column: string; hops: JoinHop[]; traversed: string[] }
  | { kind: 'semijoin'; child: string; fk: string; parentPk: string; column: string }
  | { kind: 'reject'; code: JoinPlanRejectCode; reason: string };

/** Every simple to-one path from→to (≤ maxDepth), over belongs_to AND has_one edges.
 *  length>1 ⇒ the diamond. */
export function toOnePaths(reg: AggRegistry, from: string, to: string, maxDepth = 6): JoinHop[][] {
  const out: JoinHop[][] = [];
  const dfs = (cur: string, path: JoinHop[], seen: ReadonlySet<string>) => {
    if (path.length >= maxDepth) return;
    const ent = reg[cur];
    if (!ent) return;
    for (const rel of Object.values(ent.rels)) {
      if (rel.kind === 'has_many') continue;
      const tgt = reg[rel.target];
      if (!tgt || seen.has(rel.target)) continue;
      const hop: JoinHop =
        rel.kind === 'belongs_to'
          ? { from: cur, to: rel.target, kind: 'belongs_to', fromCol: rel.fk, toCol: tgt.pk }
          : { from: cur, to: rel.target, kind: 'has_one', fromCol: ent.pk, toCol: rel.fk };
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

/** @deprecated renamed to {@link toOnePaths} (it now walks has_one edges too). */
export const belongsToPaths = toOnePaths;

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
    // ADR-0024 Amendment 4 — a BARE group dim that is NOT a field on the source may be a
    // dimension OWNED BY A TO-ONE TARGET (conformed at this grain by invariant #5): e.g.
    // `stage` (an EAV dim on opportunities) at the `observations` grain. describe() already
    // advertises it (conformedDimensions, via:'to-one'); resolve it exactly like the dotted
    // `opportunities.stage` form so EVERY measure leg keys on the SAME bare alias. GROUP-ONLY:
    // the FILTER path's cross-source conformance is enforced by the run-drizzle guard, which
    // pins the bare-name reject (aggregate-eav-filter E4) — leave filter untouched. A name that
    // IS a field on the source (native `account_id`; an own-entity EAV dim on its owner) stays
    // LOCAL and is NEVER searched.
    if (
      role === 'group' &&
      parts.length === 1 &&
      head !== sourceEntity &&
      !reg[sourceEntity]?.fields[head]
    ) {
      const hits: { target: string; hops: JoinHop[] }[] = [];
      for (const t of Object.keys(reg)) {
        if (t === sourceEntity) continue;
        const paths = toOnePaths(reg, sourceEntity, t);
        if (paths.length !== 1) continue; // 0 = unreachable / not-to-one; >1 = diamond (excluded)
        // T must own this name AS A DIMENSION (native OR EAV) — a bare group dim resolves only to a
        // conformed DIMENSION on the target, never to a measure (group-by is dimensions-only).
        if (reg[t]?.fields[head]?.role !== 'dimension') continue;
        hits.push({ target: t, hops: paths[0]! });
      }
      if (hits.length === 1) {
        const { target: tgt, hops } = hits[0]!;
        return {
          kind: 'to-one',
          target: tgt,
          column: head,
          hops,
          traversed: hops.map((h) => h.to),
        };
      }
      if (hits.length > 1) {
        return {
          kind: 'reject',
          code: 'ambiguous',
          reason: `dimension "${dotted}" is a to-one dimension on ${hits.length} distinct targets from ${sourceEntity} (${hits.map((h) => h.target).join(', ')}) — ambiguous; qualify it as <entity>.${head}`,
        };
      }
      // 0 hits → fall through to the local fallback (the clean unknown-column error survives).
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

  const toOne = toOnePaths(reg, sourceEntity, target);
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
      reason: `dimension "${dotted}" is not conformed to ${sourceEntity} grain (${sourceEntity}→${target} is to-many; grouping by it would fan out the measure). Only to-one (belongs_to / has_one) dimensions are groupable.`,
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
 *  conformed set `describe` advertises per metric. Covers BOTH native (registry-tagged)
 *  and EAV (field-map-tagged) dims: an EAV dim on a to-one target is executable — the
 *  lowering composes the 1:1 field_values join THROUGH the to-one LEFT JOIN
 *  (compile-drizzle lowerToOne), so describe/execute parity holds for it. */
export interface ConformedDim {
  /** what the caller passes in group_by/filter: `col` (own) | `entity.col` (to-one). */
  path: string;
  column: string;
  type: AggColType;
  owner: string;
  via: 'local' | 'to-one';
  /** `'declared'` = a known value domain (native enum / select_options) the agent can read for
   *  free from describe `key_fields`; `'open'` = free-string / to-one with no declared list —
   *  enumerate live values with `measure(group_by:[path])` (scoped) or size with `count_distinct`
   *  first. Declared is a PRIOR, not exhaustive (real data drifts past it). */
  valueDomain: 'declared' | 'open';
}

export function conformedDimensions(reg: AggRegistry, sourceEntity: string): ConformedDim[] {
  const out: ConformedDim[] = [];
  const ent = reg[sourceEntity];
  if (!ent) return out;
  for (const [col, f] of Object.entries(ent.fields)) {
    if (f.role === 'dimension') {
      out.push({
        path: col,
        column: col,
        type: f.type,
        owner: sourceEntity,
        via: 'local',
        valueDomain: f.hasDeclaredDomain ? 'declared' : 'open',
      });
    }
  }
  for (const target of Object.keys(reg)) {
    if (target === sourceEntity) continue;
    // unambiguous to-one only — a diamond target is excluded (the resolver rejects it).
    if (toOnePaths(reg, sourceEntity, target).length !== 1) continue;
    for (const [col, f] of Object.entries(reg[target]!.fields)) {
      if (f.role === 'dimension') {
        out.push({
          path: `${target}.${col}`,
          column: col,
          type: f.type,
          owner: target,
          via: 'to-one',
          valueDomain: f.hasDeclaredDomain ? 'declared' : 'open',
        });
      }
    }
  }
  return out;
}
