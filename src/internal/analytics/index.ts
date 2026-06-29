// Public surface of the pure analytics interior (dialect-free).
// Drizzle-coupled symbols (aggregate, runAggregateDrizzle, analyticsFromRegistry,
// AggregateModel, compileGroupedDrizzle/compileNaiveDrizzle) live in their
// adapter homes and are imported directly from there.
export * from './types.ts';
export {
  diagnoseAggregate,
  assertAggregateSafe,
  type AggFinding,
  type AggFindingCode,
} from './doctor.ts';
export {
  groupGrain,
  grainRank,
  measureSource,
  measureFans,
  groupKeyColumns,
  planAggregate,
} from './grain.ts';
export {
  measuresFromRegistry,
  validateDerivedDef,
  validateMeasureDef,
  validateRatioDef,
  type AggregateInput,
  type AtomicMeasureDef,
  type CumulativeMeasureDef,
  type DerivedExpr,
  type DerivedMeasureDef,
  type MeasureCatalog,
  type MeasureDef,
  type MeasureRef,
  type RatioMeasureDef,
} from './measure-catalog.ts';
export { normalizeAggregate } from './normalize.ts';
export {
  belongsToPaths,
  conformedDimensions,
  resolveJoinPlan,
  type ConformedDim,
  type DimRole,
  type JoinHop,
  type JoinPlan,
} from './join-plan.ts';
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
} from './compare.ts';
