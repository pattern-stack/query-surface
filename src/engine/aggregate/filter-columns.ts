// Walk a canonical Predicate AST and collect the `on` paths each leaf references. Used by the
// graph-aware fail-closed guard (run-drizzle) to resolve every filter leaf through the join graph
// and reject one that doesn't conform on every compiled measure source (ADR-0024 §Decision.4).

import type { Predicate } from './types';

/** The FULL `on` path of every leaf (dotted path intact, e.g. `accounts.name`), so the guard
 *  resolves it through the join graph rather than mis-reading a dotted path as a bare column. */
export function filterColumnPaths(pred: Predicate): string[] {
  const out = new Set<string>();
  const walk = (p: Predicate): void => {
    if ('and' in p) {
      for (const c of p.and) walk(c);
      return;
    }
    if ('or' in p) {
      for (const c of p.or) walk(c);
      return;
    }
    if ('not' in p) {
      walk(p.not);
      return;
    }
    const on = (p as { on?: unknown }).on;
    if (typeof on === 'string' && on.length > 0) out.add(on);
  };
  walk(pred);
  return [...out];
}
