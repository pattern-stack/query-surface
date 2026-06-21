// Walk a canonical Predicate AST and collect the `on` paths each leaf references. Used by the
// graph-aware fail-closed guard (run-drizzle) to resolve every filter leaf through the join graph
// and reject one that doesn't conform on every compiled measure source (ADR-0024 §Decision.4).

import type { Predicate } from './types';

/** The FULL `on` path of every leaf (dotted path intact, e.g. `accounts.name`), so the guard
 *  resolves it through the join graph rather than mis-reading a dotted path as a bare column. */
export function filterColumnPaths(pred: Predicate): string[] {
  const out = new Set<string>();
  walkLeaves(pred, (leaf) => {
    const on = (leaf as { on?: unknown }).on;
    if (typeof on === 'string' && on.length > 0) out.add(on);
  });
  return [...out];
}

/**
 * The ONE leaf recursion (and/or/not + leaf) over a Predicate tree — the same shape
 * `filterColumnPaths` walks, factored out so vector-resolution (relevance defuzzify) reuses it
 * rather than authoring a second walker. `visit` is called once per leaf (a node that is not
 * and/or/not). Read-only: this collects, it does not rebuild — see `mapLeaves` for that.
 */
export function walkLeaves(pred: Predicate, visit: (leaf: Predicate) => void): void {
  if ('and' in pred) {
    for (const c of pred.and) walkLeaves(c, visit);
    return;
  }
  if ('or' in pred) {
    for (const c of pred.or) walkLeaves(c, visit);
    return;
  }
  if ('not' in pred) {
    walkLeaves(pred.not, visit);
    return;
  }
  visit(pred);
}

/**
 * IMMUTABLY rebuild a Predicate tree, replacing each leaf with `map(leaf)` (return the leaf
 * unchanged to keep it). Same and/or/not recursion as `walkLeaves` — never mutates the input;
 * boolean nodes are reconstructed so the caller's filter object is untouched. Used by the
 * relevance defuzzify step to stamp `{ vector, embeddingColumn }` onto each relevant leaf.
 */
export function mapLeaves(pred: Predicate, map: (leaf: Predicate) => Predicate): Predicate {
  if ('and' in pred) {
    return { and: pred.and.map((c) => mapLeaves(c, map)) };
  }
  if ('or' in pred) {
    return { or: pred.or.map((c) => mapLeaves(c, map)) };
  }
  if ('not' in pred) {
    return { not: mapLeaves(pred.not, map) };
  }
  return map(pred);
}
