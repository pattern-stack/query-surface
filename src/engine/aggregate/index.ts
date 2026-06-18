// Public surface of the governed aggregation stage (Drizzle-native).
export * from './types';
export type { AggregateModel } from './model';
export {
  diagnoseAggregate,
  assertAggregateSafe,
  type AggFinding,
  type AggFindingCode,
} from './doctor';
export {
  groupGrain,
  grainRank,
  measureSource,
  measureFans,
  groupKeyColumns,
  planAggregate,
} from './grain';
export {
  compileGroupedDrizzle,
  compileNaiveDrizzle,
  type CompiledDrizzle,
} from './compile-drizzle';
export { runAggregateDrizzle, aggregate } from './run-drizzle';
export { analyticsFromRegistry } from './analytics-from-registry';
export {
  measuresFromRegistry,
  validateMeasureDef,
  validateRatioDef,
  type AggregateInput,
  type AtomicMeasureDef,
  type CumulativeMeasureDef,
  type MeasureCatalog,
  type MeasureDef,
  type MeasureRef,
  type RatioMeasureDef,
} from './measure-catalog';
export { normalizeAggregate } from './normalize';
export {
  belongsToPaths,
  conformedDimensions,
  resolveJoinPlan,
  type ConformedDim,
  type DimRole,
  type JoinHop,
  type JoinPlan,
} from './join-plan';
export {
  runCompare,
  stitchCompare,
  andFilter,
  type CompareDerive,
  type CompareRequest,
  type CompareResponse,
  type CompareSeparateResponse,
  type CompareVariant,
  type StitchOptions,
  type StitchResult,
  type VariantRows,
} from './compare';
