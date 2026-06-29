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
import { normalizeFilter } from '../language/filter-normalize';
import { toIdentifier } from '../language/identifier';
import type { FilterExpression, RelevantLeaf, SimGteLeaf, SimTopkLeaf } from '../language/types';
import { mapLeaves } from './filter-columns';
import {
  type AggregateInput,
  type AtomicMeasureDef,
  type DerivedExpr,
  type DerivedMeasureDef,
  type MeasureCatalog,
  validateDerivedDef,
  validateRatioDef,
} from './measure-catalog';
import type {
  Agg,
  Aggregate,
  CompiledDerivedExpr,
  CompositeColumn,
  Measure,
  Predicate,
} from './types';

const legAlias = (as: string, side: 'num' | 'den') => `__cmp_${as}_${side}`;
// Derived legs reuse the reserved `__cmp_` prefix (distinct from _num/_den) so they ride the
// same claim() uniqueness set + compiler leg-exclusion as ratio legs.
const derivedLegAlias = (as: string, i: number) => `__cmp_${as}_d${i}`;

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
    // A catalog ref like `Amount.sum` is a discovery NAME, not a SQL identifier — coerce it to a
    // safe output alias (`amount_sum`) so a bare `{ref:'Amount.sum'}` lands a safe column; an
    // explicit `as` still wins.
    const as = item.as ?? toIdentifier(item.ref);
    // A cumulative metric is a WINDOW (running total, rows preserved), not a collapse —
    // it belongs on query({ window }), not aggregate(). Refuse with a clear pointer
    // BEFORE claiming the alias (nothing to emit). This is the collapse/window split:
    // aggregate() collapses to groups; running totals annotate rows on query().
    if (def.kind === 'cumulative') {
      throw new Error(
        `${ENGINE_ERROR.AGGREGATE} measure "${item.ref}" is cumulative (a running total) — it is a window function that preserves rows, not a collapse. Use query({ window: [{ on, agg, partition_by }] }) instead of aggregate() (CUMULATIVE_IS_WINDOW).`,
      );
    }
    claim(as);
    if (def.kind === 'atomic') {
      measures.push(atomicToMeasure(def, as));
      continue;
    }
    if (def.kind === 'derived') {
      // derived: N DISTINCT atomic legs (fan-safe, in their own CTEs) + an outer-SELECT
      // arithmetic expression. The Map IS the dedupe — the same atomic referenced twice =>
      // one leg; legByRef.size indexes the alias; agg carries the per-leg null-policy.
      validateDerivedDef(catalog, item.ref, def as DerivedMeasureDef);
      const legByRef = new Map<string, { alias: string; agg: Agg }>();
      const collect = (node: DerivedExpr): void => {
        if ('op' in node) {
          collect(node.left);
          collect(node.right);
        } else if ('ref' in node && !legByRef.has(node.ref)) {
          const atom = catalog[node.ref] as AtomicMeasureDef;
          legByRef.set(node.ref, { alias: derivedLegAlias(as, legByRef.size), agg: atom.agg });
        }
      };
      collect((def as DerivedMeasureDef).expr);
      for (const [ref, leg] of legByRef) {
        claim(leg.alias);
        measures.push(atomicToMeasure(catalog[ref] as AtomicMeasureDef, leg.alias));
      }
      const rewrite = (node: DerivedExpr): CompiledDerivedExpr => {
        if ('op' in node) {
          return { op: node.op, left: rewrite(node.left), right: rewrite(node.right) };
        }
        if ('ref' in node) {
          // biome-ignore lint/style/noNonNullAssertion: every ref was collected above.
          return { ref: legByRef.get(node.ref)!.alias };
        }
        return { lit: node.lit };
      };
      composites.push({
        kind: 'derived',
        as,
        expr: rewrite((def as DerivedMeasureDef).expr),
        legs: [...legByRef.values()],
      });
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

  // ONE expression language (invariant #4): normalize the forgiving Mongo/Prisma DSL on EVERY
  // predicate input — global `filter`, post-agg `having`, and each measure-local `where` — into the
  // canonical AST, exactly as compiler.ts does for query/fetch at its front door. Without this the
  // aggregate compiler receives un-normalized leaves (no `.on`) and crashes on a forgiving filter.
  // (This is the tactical half of ADR-0024 §F — the two compilers still differ; the front-door
  // normalization is now shared.) normalizeFilter is idempotent on canonical leaves and preserves a
  // service-stamped relevant leaf's vector.
  const normalizedMeasures = measures.map((m) =>
    m.where ? { ...m, where: normalizeFilter(m.where) } : m,
  );
  return {
    ...input,
    measures: normalizedMeasures,
    ...(input.filter ? { filter: normalizeFilter(input.filter) } : {}),
    ...(input.having ? { having: normalizeFilter(input.having) } : {}),
    ...(composites.length ? { composites } : {}),
  };
}

// ---------------------------------------------------------------------------
// Relevance defuzzify (Wave-2 — ADR-0024 §A/Amendment 2) — Step 4
// ---------------------------------------------------------------------------
// `crispifyRelevant` lowers every service-stamped `op:'relevant'` leaf into a PRIVATE
// crisp shape (sim_gte | sim_topk) the predicate compilers know how to emit. It runs
// AFTER the service's async embed walk has stamped {vector, embeddingColumn} onto each
// relevant leaf, and BEFORE compile (in run-drizzle, before the fail-closed conform guard,
// so the crisp leaf's embedding-column `on` rides the wave-1 conform-or-reject guard #5
// unchanged).
//
// This module is DIALECT-FREE (no drizzle import) — it emits only STRUCTURAL leaves; the
// drizzle predicate compiler lowers sim_gte → a `<=>`-distance `>=` test and sim_topk → a
// ranked-CTE membership test. Crispify REWRITES `on` from the semantic TEXT column to the
// resolved EMBEDDING column so the wave-1 join-plan/conform resolver lands on a real column.

const E = ENGINE_ERROR.FILTER;

/** Lower ONE service-stamped relevant leaf into its crisp sim_gte | sim_topk form. Re-asserts
 *  the XOR (exactly one of threshold|top_k) and vector-present DEFENSIVELY — throws, never
 *  silently skips (a relevance op that reached compile uncrispified is the valueLeaf landmine). */
function crispifyLeaf(rel: RelevantLeaf): SimGteLeaf | SimTopkLeaf {
  if (!rel.vector || rel.vector.length === 0) {
    throw new Error(
      `${E} a 'relevant' leaf on '${rel.on}' reached crispify without a resolved vector — the service must stamp {vector, embeddingColumn} before compile`,
    );
  }
  if (!rel.embeddingColumn) {
    throw new Error(
      `${E} a 'relevant' leaf on '${rel.on}' reached crispify without a resolved embeddingColumn — the service must stamp it before compile`,
    );
  }
  const hasThreshold = rel.threshold !== undefined;
  const hasTopK = rel.top_k !== undefined;
  if (hasThreshold === hasTopK) {
    throw new Error(
      `${E} a 'relevant' leaf requires EXACTLY ONE of "threshold" or "top_k" (got ${
        hasThreshold ? 'both' : 'neither'
      }) — the crisp set must be explicit, no silent default`,
    );
  }
  // Crispify rewrites `on` from the semantic text column to the resolved embedding column so the
  // wave-1 conform/semijoin resolver lowers it over a REAL column. For a CROSS-GRAIN leaf the
  // dotted prefix is LOAD-BEARING (it names the child entity the compiler ranks/EXISTS over), so
  // rewrite ONLY the final segment (text column → embedding column) and keep the prefix:
  // `observations.normalized_text` → `observations.embedding`; a bare `on` stays bare.
  const dot = rel.on.lastIndexOf('.');
  const crispOn = dot < 0 ? rel.embeddingColumn : `${rel.on.slice(0, dot)}.${rel.embeddingColumn}`;
  if (hasThreshold) {
    return {
      on: crispOn,
      op: 'sim_gte',
      vector: rel.vector,
      embeddingColumn: rel.embeddingColumn,
      threshold: rel.threshold as number,
    };
  }
  return {
    on: crispOn,
    op: 'sim_topk',
    vector: rel.vector,
    embeddingColumn: rel.embeddingColumn,
    top_k: rel.top_k as number,
    ...(rel.per !== undefined ? { per: rel.per } : {}),
  };
}

/**
 * Recursively rewrite a Predicate, replacing every `op:'relevant'` leaf with its crisp
 * sim_gte | sim_topk form (defuzzify). Same and/or/not+leaf recursion as `filterColumnPaths`
 * (reuses `mapLeaves` — no second walker), IMMUTABLE (the input tree is untouched). Value leaves
 * and the boolean structure pass through unchanged. No-op when no relevant leaf is present.
 */
export function crispifyRelevant(pred: Predicate): Predicate {
  return mapLeaves(pred, (leaf) => {
    if ((leaf as { op?: unknown }).op !== 'relevant') return leaf;
    return crispifyLeaf(leaf as RelevantLeaf) as FilterExpression;
  });
}
