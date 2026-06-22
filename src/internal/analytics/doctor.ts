// Aggregation-safety lints — the manifest discipline made into compile-time
// refusals. Extends the package's existing doctor model (Finding/Severity).

import { ENGINE_ERROR } from '../language/error-messages';
import { groupGrain, measureField, measureSource } from './grain';
import type { AggRegistry, Aggregate } from './types';

export type AggFindingCode =
  | 'SUM_NON_ADDITIVE'
  | 'SEMI_OVER_TIME'
  | 'MEASURE_ON_DIMENSION'
  | 'MEASURE_NO_AGG_TAG'
  | 'UNKNOWN_FIELD';

export interface AggFinding {
  code: AggFindingCode;
  severity: 'error' | 'warning';
  message: string;
}

export function diagnoseAggregate(reg: AggRegistry, q: Aggregate): AggFinding[] {
  const findings: AggFinding[] = [];
  const grain = groupGrain(reg, q);
  const groupCols = new Set(
    (q.group_by ?? []).map((d) => (d.includes('.') ? d.split('.')[1]! : d)),
  );

  for (const m of q.measures) {
    if (m.on === '*') continue;
    const src = measureSource(q, m);
    const ent = reg[src];
    const head = measureField(m);
    const field = ent?.fields[head];
    if (!field) {
      findings.push({
        code: 'UNKNOWN_FIELD',
        severity: 'error',
        message: `measure "${m.on}" is not a registered field on ${src}`,
      });
      continue;
    }
    const isScalarAgg = m.agg === 'sum' || m.agg === 'avg' || m.agg === 'min' || m.agg === 'max';

    if (field.role === 'dimension' && isScalarAgg) {
      findings.push({
        code: 'MEASURE_ON_DIMENSION',
        severity: 'error',
        message: `"${m.on}" is a dimension; only count/count_distinct apply (got ${m.agg})`,
      });
    }
    if (field.role === 'measure' && !field.agg && !m.agg) {
      findings.push({
        code: 'MEASURE_NO_AGG_TAG',
        severity: 'warning',
        message: `measure "${m.on}" has no default agg tag`,
      });
    }
    if (m.agg === 'sum' && field.additivity === 'non') {
      findings.push({
        code: 'SUM_NON_ADDITIVE',
        severity: 'error',
        message: `cannot SUM "${m.on}" (additivity=non — a ratio/percentage). Use avg, or a weighted ratio.`,
      });
    }
    if (m.agg === 'sum' && field.additivity === 'semi') {
      // semi-additive may not be summed across time: a time dimension of the
      // measure's source must be present in group_by.
      const hasTimeDim = Object.entries(ent!.fields).some(
        ([k, f]) => f.time && groupCols.has(f.column ?? k),
      );
      if (!hasTimeDim) {
        findings.push({
          code: 'SEMI_OVER_TIME',
          severity: 'error',
          message: `cannot SUM semi-additive "${m.on}" without a time dimension in group_by (it is not additive across time)`,
        });
      }
    }
  }
  void grain;
  return findings;
}

export function assertAggregateSafe(reg: AggRegistry, q: Aggregate): void {
  const errors = diagnoseAggregate(reg, q).filter((f) => f.severity === 'error');
  if (errors.length > 0) {
    // ENGINE_ERROR.AGGREGATE prefix → the nest classifier maps these caller-input
    // failures to a 400 (not the catch-all 500): the doctor runs before any DB call.
    throw new Error(
      `${ENGINE_ERROR.AGGREGATE} ${errors.map((e) => `${e.code}: ${e.message}`).join(' | ')}`,
    );
  }
}
