// The resolution pass: AggregateInput (which may reference catalog measures by {ref},
// including composite RATIO metrics) → canonical Aggregate the engine compiles. THE
// ORDERING IS LOAD-BEARING: normalizeAggregate runs BEFORE the doctor and BEFORE compile
// (run-drizzle.ts), so every downstream stage sees fully-inlined Measures — the doctor
// reads additivity from the REGISTRY (never a catalog claim), the grain oracle routes
// expanded legs as ordinary measures (so fan-safety + cross-source grain-alignment are
// the SAME guard that protects any measure), and scope can't be bypassed by a name.
//
// A ratio expands into TWO atomic LEG measures (computed fan-safely in their own source
// CTEs) plus a CompositeColumn that the compiler emits as outer-SELECT division — never
// a CTE join, so it adds no fan-out. Leg aliases use a reserved `__cmp_` prefix and are
// tracked in the uniqueness set, so a user alias can never silently collide with one.

import { ENGINE_ERROR } from '../language/error-messages';
import {
  type AggregateInput,
  type AtomicMeasureDef,
  type MeasureCatalog,
  validateRatioDef,
} from './measure-catalog';
import type { Aggregate, CompositeColumn, Measure } from './types';

const legAlias = (as: string, side: 'num' | 'den') => `__cmp_${as}_${side}`;

function atomicToMeasure(def: AtomicMeasureDef, as: string): Measure {
  return {
    on: def.on,
    agg: def.agg,
    source: def.source,
    ...(def.where ? { where: def.where } : {}),
    as,
  };
}

export function normalizeAggregate(catalog: MeasureCatalog, input: AggregateInput): Aggregate {
  const measures: Measure[] = [];
  const composites: CompositeColumn[] = [];
  const seen = new Set<string>();
  const claim = (alias: string) => {
    // Uniqueness across EVERY output + leg alias — user-vs-user, ref-vs-user, and
    // user-vs-generated-leg all refuse here (no silent shadowing / namespace collision).
    if (seen.has(alias)) {
      throw new Error(`${ENGINE_ERROR.AGGREGATE} duplicate measure alias "${alias}"`);
    }
    seen.add(alias);
  };

  for (const item of input.measures) {
    if (!('ref' in item)) {
      claim(item.as);
      measures.push(item);
      continue;
    }
    const def = catalog[item.ref];
    if (!def) {
      throw new Error(`${ENGINE_ERROR.AGGREGATE} unknown measure ref "${item.ref}"`);
    }
    const as = item.as ?? item.ref;
    // A cumulative metric is a WINDOW (running total, rows preserved), not a collapse —
    // it belongs on query({ window }), not aggregate(). Refuse with a clear pointer
    // BEFORE claiming the alias (nothing to emit). This is the collapse/window split:
    // aggregate() collapses to groups; running totals annotate rows on query().
    if (def.kind === 'cumulative') {
      throw new Error(
        `${ENGINE_ERROR.AGGREGATE} measure "${item.ref}" is cumulative (a running total) — ` +
          'it is a window function that preserves rows, not a collapse. Use query({ window: ' +
          `[{ on, agg, partition_by }] }) instead of aggregate() (CUMULATIVE_IS_WINDOW).`,
      );
    }
    claim(as);
    if (def.kind === 'atomic') {
      measures.push(atomicToMeasure(def, as));
      continue;
    }
    // ratio: two atomic legs (fan-safe, in their own CTEs) + an outer-SELECT division.
    validateRatioDef(catalog, item.ref, def);
    const numDef = catalog[def.numerator] as AtomicMeasureDef;
    const numAs = legAlias(as, 'num');
    const denAs = legAlias(as, 'den');
    claim(numAs);
    claim(denAs);
    measures.push(atomicToMeasure(numDef, numAs));
    measures.push(atomicToMeasure(catalog[def.denominator] as AtomicMeasureDef, denAs));
    composites.push({
      kind: 'ratio',
      as,
      numerator: numAs,
      denominator: denAs,
      numeratorAgg: numDef.agg,
    });
  }

  return { ...input, measures, ...(composites.length ? { composites } : {}) };
}
