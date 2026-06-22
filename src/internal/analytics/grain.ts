// The grain oracle — the load-bearing correctness control.
//
// Fan-safety is a property of the GROUP-BY grain vs each MEASURE's owning entity,
// NOT the query root (the bug the adversarial panel caught: a root-relative
// has_many check is blind to grain inversion). Here it's computed grain-relative.

import type { AggRegistry, Aggregate, AggregatePlan, Measure } from './types';

/** Coarse→fine rank: longest belongs_to chain from this entity upward.
 *  accounts=0, opportunities=1 (belongs_to accounts), observations=2. */
export function grainRank(
  reg: AggRegistry,
  entity: string,
  seen: ReadonlySet<string> = new Set(),
): number {
  const ent = reg[entity];
  if (!ent || seen.has(entity)) return 0;
  let max = 0;
  const next = new Set([...seen, entity]);
  for (const rel of Object.values(ent.rels)) {
    if (rel.kind === 'belongs_to') {
      max = Math.max(max, 1 + grainRank(reg, rel.target, next));
    }
  }
  return max;
}

/** Which entity a group_by dimension rolls up to.
 *  'entity.col' → entity; a belongs_to fk on the root → that target; else root. */
export function dimOwner(reg: AggRegistry, root: string, dim: string): string {
  if (dim.includes('.')) return dim.split('.')[0]!;
  const rootEnt = reg[root];
  if (rootEnt) {
    for (const rel of Object.values(rootEnt.rels)) {
      if (rel.kind === 'belongs_to' && rel.fk === dim) return rel.target;
    }
  }
  return root;
}

/** The coarsest entity among the group_by dimensions (or the root if none). */
export function groupGrain(reg: AggRegistry, q: Aggregate): string {
  const owners = (q.group_by ?? []).map((d) => dimOwner(reg, q.entity, d));
  if (owners.length === 0) return q.entity;
  return owners.reduce((a, b) => (grainRank(reg, a) <= grainRank(reg, b) ? a : b));
}

export function measureSource(q: Aggregate, m: Measure): string {
  if (m.source) return m.source;
  if (m.on.includes('.')) return m.on.split('.')[0]!;
  return q.entity;
}

/** A measure's field NAME relative to its source. A dotted `on` ("relation.field") names the source
 *  in its FIRST segment (see measureSource) and the FIELD in the rest — so the field is everything
 *  AFTER the first dot (a json subpath rides along: "rel.data.k" → "data.k"). A bare `on` already IS
 *  the field; `*` passes through. Mirrors group_by's dim handling (post-dot segment) so a measure and
 *  a group_by parse the SAME dotted syntax the same way — `on:"observations.id"` and
 *  `source:"observations", on:"id"` resolve identically. */
export function measureField(m: { on: string }): string {
  if (m.on === '*') return '*';
  return m.on.includes('.') ? m.on.split('.').slice(1).join('.') : m.on;
}

/** A measure FANS at the group grain iff its source is strictly finer
 *  (reached from the group grain across a has_many edge). */
export function measureFans(reg: AggRegistry, groupGrainEntity: string, source: string): boolean {
  return grainRank(reg, source) > grainRank(reg, groupGrainEntity);
}

/** The bare group-key columns (after stripping any 'entity.' prefix). */
export function groupKeyColumns(q: Aggregate): string[] {
  return (q.group_by ?? []).map((d) => (d.includes('.') ? d.split('.')[1]! : d));
}

/** Plan the aggregate: group grain, distinct measure sources, whether a CTE join
 *  is needed (>1 source), and whether a naive root-join would fan (danger flag). */
export function planAggregate(reg: AggRegistry, q: Aggregate): AggregatePlan {
  const grain = groupGrain(reg, q);
  const sources = [...new Set(q.measures.map((m) => measureSource(q, m)))];
  const rootJoinWouldFan = sources.some((s) => s !== q.entity);
  return { groupGrain: grain, needsCte: sources.length > 1, rootJoinWouldFan, sources };
}
