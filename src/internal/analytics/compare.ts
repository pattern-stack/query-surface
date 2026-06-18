// compare() — run the SAME base aggregate under N labeled VARIANTS (each a filter
// override), align by group key, and (optionally) derive delta/pct_change/index vs a
// baseline. Period-over-period is the time special case; variant-vs-variant (cohort,
// region, won/lost) is the same machinery with non-time filters.
//
// CORRECTNESS IS INHERITED: every variant IS a plain aggregate() call (fan-safe per-source
// CTEs, fail-closed scope, grain-alignment, the doctor) — compare adds no SQL. The ALIGN +
// DERIVE step is `stitchCompare`, a PURE function over already-collapsed rows: no db, no
// Nest, no SQL. It is exported so the SAME code runs server-side (pre-stitch → one result)
// and client-side (frontend fires N aggregates and stitches) — the two can never disagree.

import { ENGINE_ERROR } from '../language/error-messages';
import type { AggregateInput, MeasureRef } from './measure-catalog';
import type { FilterExpression, Measure, Predicate } from './types';

type Row = Record<string, unknown>;

/** A labeled slice of the comparison: the base aggregate run under this extra filter. */
export interface CompareVariant {
  /** identifier-safe; becomes the column suffix (`<measure>__<label>`) */
  label: string;
  /** variant-specific filter, ANDed with the base filter (same per-source soft-drop
   *  semantics as any aggregate filter — a variant can only narrow, never widen scope) */
  filter?: Predicate;
}

export type CompareDerive = 'delta' | 'pct_change' | 'index';

/** The compare request (minus `entity`, carried separately like aggregate). */
export interface CompareRequest {
  group_by?: string[]; // the ALIGNMENT key — shared by every variant
  measures: Array<Measure | MeasureRef>; // base measures — SAME for every variant
  variants: CompareVariant[]; // ≥2
  filter?: Predicate; // base filter, ANDed into every variant
  compare?: { baseline?: string; derive?: CompareDerive[] };
  delivery?: 'stitched' | 'separate';
  /** stitched-result ordering/limit (the "same top-N compared across variants" intent) */
  order_by?: { on: string; dir: 'asc' | 'desc' }[];
  limit?: number;
  /** opt-in CHURN view: each variant independently ranks by `by` and keeps top `n`; the
   *  stitch aligns the UNION of keysets (a key in one variant's top-N but not another's
   *  → nulls for the others — so you SEE the top-N shift). Mutually exclusive with the
   *  default aligned-all keyset that order_by/limit slice. */
  per_variant_top?: { by: string; n: number };
}

/** Stitched delivery: one aligned row per group key, value + derive columns per variant. */
export interface CompareResponse {
  delivery: 'stitched';
  entity: string;
  group_by: string[];
  variants: string[];
  baseline: string;
  measures: string[];
  derives: CompareDerive[];
  rows: Row[];
  warnings?: string[];
}

/** Separate delivery: the N labeled aggregate results, unstitched (client aligns). */
export interface CompareSeparateResponse {
  delivery: 'separate';
  entity: string;
  baseline: string;
  variants: Array<{ label: string; rows: Row[]; row_count: number }>;
  warnings?: string[];
}

/** AND a base filter with a variant filter (either may be absent). */
export function andFilter(base?: Predicate, variant?: Predicate): Predicate | undefined {
  if (base && variant) return { and: [base, variant] } as FilterExpression;
  return variant ?? base;
}

const numOrNull = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// delta needs both operands; pct_change/index additionally need a non-zero baseline.
function deriveValue(kind: CompareDerive, base: unknown, variant: unknown): number | null {
  const a = numOrNull(base);
  const b = numOrNull(variant);
  if (kind === 'delta') return a == null || b == null ? null : b - a;
  if (a == null || a === 0 || b == null) return null;
  return kind === 'pct_change' ? (b - a) / a : (b / a) * 100;
}

export interface VariantRows {
  label: string;
  rows: Row[];
}

export interface StitchOptions {
  groupBy: string[];
  /** must be one of the variant labels */
  baseline: string;
  derive?: CompareDerive[];
  /** explicit measure output columns; else inferred as (row keys − groupBy) */
  measures?: string[];
}

export interface StitchResult {
  rows: Row[];
  measures: string[];
  warnings: string[];
}

/**
 * PURE alignment + derive over already-collapsed variant rows. Aligns by the group-by
 * key (UNION of keys across variants — a group missing in a variant → null for its
 * columns), emits `<measure>__<label>` per variant and `<measure>__<label>__<derive>`
 * for each non-baseline variant. No db/Nest/SQL — runs identically on server and client.
 */
export function stitchCompare(variants: VariantRows[], opts: StitchOptions): StitchResult {
  const { groupBy, baseline, derive = [] } = opts;
  const labels = variants.map((v) => v.label);
  const measures =
    opts.measures ??
    (() => {
      const set = new Set<string>();
      for (const v of variants) {
        for (const r of v.rows) {
          for (const k of Object.keys(r)) if (!groupBy.includes(k)) set.add(k);
        }
      }
      return [...set];
    })();

  // The `__` separator is non-injective if a label or measure alias contains `__`, so
  // two distinct (measure, variant[, derive]) cells could render to the SAME column and
  // silently clobber each other. PLAN every output column up front and refuse a collision
  // (incl. a clash with a group-by column) — a hard 400, never a silent wrong value. (The
  // runCompare label `__` ban fails this faster for the common case; this is the catch-all
  // that also covers measure aliases, which may arrive via {ref} expansion.)
  const colOwner = new Map<string, string>();
  const claimCol = (col: string, owner: string) => {
    if (groupBy.includes(col) || colOwner.has(col)) {
      throw new Error(
        `${ENGINE_ERROR.AGGREGATE} compare column collision on "${col}" — variant labels and ` +
          'measure aliases must not contain "__" (the reserved column separator)',
      );
    }
    colOwner.set(col, owner);
  };
  for (const meas of measures) {
    for (const label of labels) claimCol(`${meas}__${label}`, `value:${meas}/${label}`);
    for (const d of derive) {
      for (const label of labels) {
        if (label !== baseline) claimCol(`${meas}__${label}__${d}`, `derive:${meas}/${label}/${d}`);
      }
    }
  }

  const keyOf = (r: Row) => JSON.stringify(groupBy.map((c) => r[c] ?? null));
  const byLabel: Record<string, Map<string, Row>> = {};
  const keyOrder: string[] = [];
  const seen = new Set<string>();
  const keyVals: Record<string, Row> = {};
  for (const v of variants) {
    const m = new Map<string, Row>();
    for (const r of v.rows) {
      const k = keyOf(r);
      m.set(k, r);
      if (!seen.has(k)) {
        seen.add(k);
        keyOrder.push(k);
        keyVals[k] = r;
      }
    }
    byLabel[v.label] = m;
  }

  const nullBaseline: Record<string, number> = {};
  const rows: Row[] = keyOrder.map((k) => {
    const out: Row = {};
    for (const c of groupBy) out[c] = keyVals[k]![c] ?? null;
    const baseRow = byLabel[baseline]?.get(k);
    for (const meas of measures) {
      for (const label of labels) out[`${meas}__${label}`] = byLabel[label]?.get(k)?.[meas] ?? null;
      for (const d of derive) {
        for (const label of labels) {
          if (label === baseline) continue;
          const variantVal = byLabel[label]?.get(k)?.[meas];
          out[`${meas}__${label}__${d}`] = deriveValue(d, baseRow?.[meas], variantVal);
          // count a derive that a zero/absent baseline blocked despite a real variant value
          if (
            d !== 'delta' &&
            variantVal != null &&
            deriveValue(d, baseRow?.[meas], variantVal) == null
          ) {
            const key = `${meas}__${d}`;
            nullBaseline[key] = (nullBaseline[key] ?? 0) + 1;
          }
        }
      }
    }
    return out;
  });

  const warnings = Object.entries(nullBaseline).map(
    ([col, n]) => `${col}: ${n} group(s) undefined (zero or absent baseline)`,
  );
  // A wholly-empty baseline variant makes EVERY derive null (incl. delta, which the
  // per-group counter above intentionally skips) — surface one explicit signal so an
  // auto-defaulted/typo'd/scope-narrowed baseline doesn't read as a clean comparison.
  if (derive.length > 0 && (byLabel[baseline]?.size ?? 0) === 0) {
    warnings.push(`baseline variant "${baseline}" returned 0 rows — all derives are null`);
  }
  return { rows, measures, warnings };
}

const LABEL = /^[a-z_][a-z0-9_]*$/i;
const DEFAULT_DERIVE: CompareDerive[] = ['delta', 'pct_change'];

/** What a variant run returns to the orchestrator (the shape of an AggregateResponse). */
export interface VariantRunResult {
  rows: Row[];
  warnings?: string[];
}

/** Sort stitched rows by the order_by spec — numeric when both finite, else string,
 *  nulls last; validated against the stitched output columns (a typo → 400). */
function orderStitched(
  rows: Row[],
  orderBy: { on: string; dir: 'asc' | 'desc' }[],
  legal: Set<string>,
): void {
  for (const o of orderBy) {
    if (!legal.has(o.on)) {
      throw new Error(
        `${ENGINE_ERROR.AGGREGATE} order_by references unknown compare column "${o.on}"`,
      );
    }
  }
  rows.sort((ra, rb) => {
    for (const o of orderBy) {
      const a = ra[o.on];
      const b = rb[o.on];
      if (a == null && b == null) continue;
      if (a == null) return 1; // nulls last
      if (b == null) return -1;
      const na = Number(a);
      const nb = Number(b);
      const cmp =
        Number.isFinite(na) && Number.isFinite(nb)
          ? na - nb
          : String(a) < String(b)
            ? -1
            : String(a) > String(b)
              ? 1
              : 0;
      if (cmp !== 0) return o.dir === 'desc' ? -cmp : cmp;
    }
    return 0;
  });
}

/**
 * Orchestrate a compare: run each variant as a base aggregate (with its filter ANDed in,
 * and per-variant top-N pushed down when requested), then stitch or deliver separately.
 * `runVariant` MUST be the tenancy-scoped aggregate (the service passes
 * `(agg) => this.aggregate(entity, agg)`), so every variant inherits fan-safety +
 * FAIL-CLOSED per-source scope. Do NOT inject an unscoped runner — that would drop the
 * tenancy contract. Kept injected for unit-testability.
 */
export async function runCompare(
  entity: string,
  req: CompareRequest,
  runVariant: (agg: Omit<AggregateInput, 'entity'>) => Promise<VariantRunResult>,
): Promise<CompareResponse | CompareSeparateResponse> {
  if (!req.variants || req.variants.length < 2) {
    throw new Error(`${ENGINE_ERROR.AGGREGATE} compare needs at least 2 variants`);
  }
  const labels = req.variants.map((v) => v.label);
  const seenLabel = new Set<string>();
  for (const l of labels) {
    // No `__`: it's the reserved stitch separator (<measure>__<label>__<derive>), so a
    // label containing it could render a column that collides with another cell.
    if (!LABEL.test(l) || l.includes('__')) {
      throw new Error(
        `${ENGINE_ERROR.AGGREGATE} invalid variant label "${l}" (identifier, no "__")`,
      );
    }
    if (seenLabel.has(l)) {
      throw new Error(`${ENGINE_ERROR.AGGREGATE} duplicate variant label "${l}"`);
    }
    seenLabel.add(l);
  }
  const baseline = req.compare?.baseline ?? labels[0]!;
  if (!seenLabel.has(baseline)) {
    throw new Error(
      `${ENGINE_ERROR.AGGREGATE} compare baseline "${baseline}" is not a variant label`,
    );
  }

  const groupBy = req.group_by ?? [];
  const top = req.per_variant_top;
  // per_variant_top (churn keyset = union of each variant's own top-N) is mutually
  // exclusive with the default aligned-all keyset that order_by/limit slice — a
  // post-stitch limit would silently truncate the very union the churn view exists to show.
  if (top && (req.order_by?.length || req.limit != null)) {
    throw new Error(
      `${ENGINE_ERROR.AGGREGATE} per_variant_top is mutually exclusive with order_by/limit`,
    );
  }
  if (top) {
    // `by` ranks each variant's own groups — only a measure alias is a meaningful churn key
    // (a group-by column or a stitch-only derive is not). Reject early with a clear message.
    const measureAliases = new Set(req.measures.map((m) => ('ref' in m ? (m.as ?? m.ref) : m.as)));
    if (!measureAliases.has(top.by)) {
      throw new Error(
        `${ENGINE_ERROR.AGGREGATE} per_variant_top.by "${top.by}" must be one of the measure aliases`,
      );
    }
  }
  // Each variant: the base aggregate under (base filter AND variant filter), with per-variant
  // top-N pushed into the variant's own aggregate when requested (churn keyset).
  const variantResults = await Promise.all(
    req.variants.map(async (v) => {
      const filter = andFilter(req.filter, v.filter);
      const agg: Omit<AggregateInput, 'entity'> = {
        ...(groupBy.length ? { group_by: groupBy } : {}),
        measures: req.measures,
        ...(filter ? { filter } : {}),
        ...(top ? { order_by: [{ on: top.by, dir: 'desc' as const }], limit: top.n } : {}),
      };
      // FAIL CLOSED on an unqueryable filter column is INHERITED: each variant is a plain
      // aggregate(), and the engine now throws when a filter column resolves on no source
      // (rather than silently dropping it — see runAggregateDrizzle). So a variant whose
      // distinguishing filter references a typo'd/unregistered column hard-errors here
      // instead of silently running on the full population (the Q6 landmine). Nothing extra
      // to do — the throw propagates out of Promise.all and aborts the compare.
      const res = await runVariant(agg);
      return { label: v.label, rows: res.rows, warnings: res.warnings ?? [] };
    }),
  );

  const variantWarnings = variantResults.flatMap((r) => r.warnings.map((w) => `[${r.label}] ${w}`));

  if (req.delivery === 'separate') {
    return {
      delivery: 'separate',
      entity,
      baseline,
      variants: variantResults.map((r) => ({
        label: r.label,
        rows: r.rows,
        row_count: r.rows.length,
      })),
      ...(variantWarnings.length ? { warnings: variantWarnings } : {}),
    };
  }

  const derive = req.compare?.derive ?? DEFAULT_DERIVE;
  const stitched = stitchCompare(
    variantResults.map((r) => ({ label: r.label, rows: r.rows })),
    { groupBy, baseline, derive },
  );

  // Legal stitched columns for order_by: group keys ∪ value cols ∪ derive cols.
  const legal = new Set<string>(groupBy);
  for (const meas of stitched.measures) {
    for (const label of labels) {
      legal.add(`${meas}__${label}`);
      for (const d of derive) if (label !== baseline) legal.add(`${meas}__${label}__${d}`);
    }
  }
  if (req.order_by?.length) orderStitched(stitched.rows, req.order_by, legal);
  const rows = req.limit != null ? stitched.rows.slice(0, req.limit) : stitched.rows;

  return {
    delivery: 'stitched',
    entity,
    group_by: groupBy,
    variants: labels,
    baseline,
    measures: stitched.measures,
    derives: derive,
    rows,
    ...(stitched.warnings.length || variantWarnings.length
      ? { warnings: [...variantWarnings, ...stitched.warnings] }
      : {}),
  };
}
