// The named-measure CATALOG floor (B2). Simple measures are DERIVED from the
// role:'measure' FieldMeta tags (measuresFromRegistry) — never hand-authored — so the
// catalog NAMES the field tags rather than duplicating them. Composite measures
// (ratio/PoP) extend MeasureDef in later branches; query-side {ref} consumption is B3.
//
// Registration is VALIDATED against the analytics manifest: a def's (source, on) must
// resolve to a real field, and its additivity may not be LOOSER than the field's. The
// doctor still reads additivity from the registry at query time (it never trusts a
// catalog claim); this just refuses an incoherent registration early and keeps the
// catalog from ever NAMING a non-additive field as summable.

import { ENGINE_ERROR } from '../error-messages';
import type { Additivity, Agg, AggRegistry, Aggregate, Measure, Predicate } from './types';

/** A simple (single-column) measure: an aggregate over one field of one source. */
export interface AtomicMeasureDef {
  kind: 'atomic';
  /** field key (or 'relation.field') on `source`; EAV fields resolve as columns */
  on: string;
  agg: Agg;
  /** the entity the field lives on */
  source: string;
  /** optional FILTER (WHERE …) — a conditional measure */
  where?: Predicate;
  /** field-authoritative: equal-or-stricter than the registry field, never looser */
  additivity: Additivity;
  label?: string;
}

/** A ratio metric: numerator / denominator, each naming an ATOMIC catalog measure.
 *  Computed as outer-SELECT arithmetic over the two collapsed legs (never a CTE) — so
 *  it inherits fan-safety from its atomic legs. Always non-additive. */
export interface RatioMeasureDef {
  kind: 'ratio';
  numerator: string; // catalog name of an atomic measure
  denominator: string; // catalog name of an atomic measure
  label?: string;
}

/** A cumulative (running-total) metric: a window function (SUM/COUNT OVER ORDER BY t),
 *  which PRESERVES rows rather than collapsing them — so it is NOT an aggregate() shape.
 *  The catalog can ENUMERATE it (agent/editor discoverability), but aggregate() REFUSES
 *  it and points the caller at query({ window }) (the agg() OVER (PARTITION BY …) path
 *  that already ships). Routing marker, not an aggregate code path. */
export interface CumulativeMeasureDef {
  kind: 'cumulative';
  /** the atomic catalog measure to accumulate */
  measure: string;
  /** the time/sequence column to order the running total by */
  order_by: string;
  /** optional reset boundary — the running total restarts per partition */
  partition_by?: string;
  label?: string;
}

/** A catalog entry. (B5 will add 'pop'; cumulative is enumerable but routes to query().) */
export type MeasureDef = AtomicMeasureDef | RatioMeasureDef | CumulativeMeasureDef;

/** name → definition. Referenced from a query by `{ ref: name }` (consumed in B3). */
export type MeasureCatalog = Record<string, MeasureDef>;

/** A by-name reference to a catalog measure, usable wherever an inline Measure is.
 *  `as` overrides the output alias (defaults to the ref name). */
export interface MeasureRef {
  ref: string;
  as?: string;
}

/** An aggregate request whose `measures` may be inline Measures OR catalog {ref}s.
 *  normalizeAggregate (B3) expands every ref to its inline Measure, yielding the
 *  canonical `Aggregate` (measures: Measure[]) the engine compiles. */
export interface AggregateInput extends Omit<Aggregate, 'measures'> {
  measures: Array<Measure | MeasureRef>;
}

// additive ⊂ semi ⊂ non — a def may TIGHTEN (move right) but never LOOSEN (move left).
const ADDITIVITY_RANK: Record<Additivity, number> = { additive: 0, semi: 1, non: 2 };

/** Validate a measure def against the analytics manifest at REGISTRATION time:
 *  (1) its (source, on) must resolve to a registered field — UNKNOWN_FIELD at
 *  definition time, not a raw error at query time; (2) its additivity may not be
 *  looser than the field's (an unset field additivity is treated as the loosest). */
export function validateMeasureDef(
  analytics: AggRegistry,
  name: string,
  def: AtomicMeasureDef,
): void {
  const head = def.on.split('.')[0]!;
  const field = analytics[def.source]?.fields[head];
  if (!field) {
    throw new Error(
      `${ENGINE_ERROR.AGGREGATE} measure "${name}": field "${def.on}" is not registered on "${def.source}"`,
    );
  }
  const fieldRank = ADDITIVITY_RANK[field.additivity ?? 'additive'];
  if (ADDITIVITY_RANK[def.additivity] < fieldRank) {
    throw new Error(
      `${ENGINE_ERROR.AGGREGATE} measure "${name}": additivity "${def.additivity}" is looser than ` +
        `the registry field's "${field.additivity}" — a catalog measure may not loosen a field's additivity`,
    );
  }
}

/** Validate a ratio def: both legs must name ATOMIC catalog measures (no nested
 *  composites — a ratio's legs are pre-aggregated atoms). Checked when a ratio {ref}
 *  is expanded (→ 400 on a bad ratio), and available for host registration. */
export function validateRatioDef(
  catalog: MeasureCatalog,
  name: string,
  def: RatioMeasureDef,
): void {
  for (const leg of [def.numerator, def.denominator]) {
    const legDef = catalog[leg];
    if (!legDef) {
      throw new Error(
        `${ENGINE_ERROR.AGGREGATE} ratio "${name}": leg measure "${leg}" is not in the catalog`,
      );
    }
    if (legDef.kind !== 'atomic') {
      throw new Error(
        `${ENGINE_ERROR.AGGREGATE} ratio "${name}": leg "${leg}" is not an atomic measure (a ratio's legs may not themselves be composites)`,
      );
    }
  }
}

/** DERIVE the simple-measure catalog from the analytics manifest: one atomic measure
 *  per field tagged role:'measure' that carries BOTH a default agg and an additivity
 *  (a measure missing either isn't auto-cataloggable — reference it inline with an
 *  explicit agg). Keyed by field name; a name shared by measures on two entities is
 *  ambiguous for a bare `{ref}` → refused. */
export function measuresFromRegistry(analytics: AggRegistry): MeasureCatalog {
  const catalog: MeasureCatalog = {};
  const owner: Record<string, string> = {};
  for (const [source, ent] of Object.entries(analytics)) {
    for (const [field, meta] of Object.entries(ent.fields)) {
      if (meta.role !== 'measure' || !meta.agg || !meta.additivity) continue;
      if (owner[field]) {
        throw new Error(
          `${ENGINE_ERROR.AGGREGATE} ambiguous measure name "${field}" (on "${owner[field]}" and ` +
            `"${source}") — measure field names must be unique across entities to be auto-cataloged`,
        );
      }
      owner[field] = source;
      const def: AtomicMeasureDef = {
        kind: 'atomic',
        on: field,
        agg: meta.agg,
        source,
        additivity: meta.additivity,
      };
      validateMeasureDef(analytics, field, def);
      catalog[field] = def;
    }
  }
  return catalog;
}
