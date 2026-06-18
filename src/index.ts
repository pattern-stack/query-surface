// Public surface of the query package.

export type {
  CatalogField,
  ColumnType,
  EntityCatalog,
  ExampleFilter,
  RelationshipInfo,
} from './catalog.ts';
export {
  buildEntityCatalog,
  columnTypeFromDataType,
  columnTypeFromPg,
} from './catalog.ts';
export type {
  EntityKind,
  EntityMeta,
  FieldMeta,
  FieldMetaMap,
} from './define-entity.ts';
export { qEntity, qField, qJunction, readEntityMeta } from './define-entity.ts';
export type {
  DiagnoseOptions,
  Finding,
  FindingCode,
  FormatOptions,
  Severity,
} from './doctor.ts';
export { diagnose, formatFindings } from './doctor.ts';
export { compile } from './engine/compiler.ts';
// Aggregate (collapse to grouped rows) — the governed, grain-safe stage.
export {
  TENANT_GLOBAL,
  aggregate,
  analyticsFromRegistry,
  andFilter,
  assertAggregateSafe,
  belongsToPaths,
  conformedDimensions,
  diagnoseAggregate,
  measuresFromRegistry,
  normalizeAggregate,
  resolveJoinPlan,
  runAggregateDrizzle,
  runCompare,
  stitchCompare,
  validateMeasureDef,
  validateRatioDef,
} from './engine/aggregate/index.ts';
export type {
  Additivity,
  Agg,
  AggColType,
  AggFieldMeta,
  Aggregate,
  AggregateInput,
  AggregateModel,
  AggregatePlan,
  AggregateResponse,
  AggRegistry,
  AtomicMeasureDef,
  ConformedDim,
  DimRole,
  JoinHop,
  JoinPlan,
  CompareDerive,
  CompareRequest,
  CompareResponse,
  CompareSeparateResponse,
  CompareVariant,
  CompositeColumn,
  CumulativeMeasureDef,
  Measure,
  MeasureCatalog,
  MeasureDef,
  MeasureRef,
  RatioMeasureDef,
  ScopeFor,
} from './engine/aggregate/index.ts';
export { runFetch, runSearch, runSearchMulti } from './engine/runners.ts';
export type {
  AggregateRequest,
  FetchOptions,
  QueryOptions,
  QueryServiceOptions,
  ScopeResolver,
} from './query.application-service.ts';
export { QueryApplicationService } from './query.application-service.ts';
export type {
  EavStrategy,
  EntityDescriptor,
  EntityRegistration,
  RelDescriptor,
} from './registry.ts';
export { buildRegistry, configureQueryRegistry, registry } from './registry.ts';
export type {
  CatalogEntry,
  TableCatalog,
  ValueTableCatalog,
} from './runtime-registry.ts';
export { entityRegistrations, loadRegistrations } from './runtime-registry.ts';
export type { RegisterSchemaOptions } from './schema-registry.ts';
export {
  buildRegistrationsFromSchema,
  registerFromDb,
  registerSchema,
} from './schema-registry.ts';
export type {
  EntityName,
  FetchRequest,
  FetchResponse,
  FilterExpression,
  LeafFilter,
  Op,
  SearchEntityResult,
  SearchRequest,
  SearchResponse,
  SingleSearchQuery,
  Sort,
} from './types.ts';
