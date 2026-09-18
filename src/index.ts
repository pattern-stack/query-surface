// Public surface of the query package.

export type {
  CatalogField,
  ColumnType,
  EntityCatalog,
  ExampleFilter,
  RelationshipInfo,
} from './adapters/drizzle/registry/catalog.ts';
export {
  buildEntityCatalog,
  columnTypeFromDataType,
  columnTypeFromPg,
} from './adapters/drizzle/registry/catalog.ts';
export type {
  EntityKind,
  EntityMeta,
  FieldMeta,
  FieldMetaMap,
} from './adapters/drizzle/registry/define-entity.ts';
export {
  qEntity,
  qField,
  qJunction,
  readEntityMeta,
} from './adapters/drizzle/registry/define-entity.ts';
export type {
  DiagnoseOptions,
  Finding,
  FindingCode,
  FormatOptions,
  Severity,
} from './adapters/drizzle/diagnostics/doctor.ts';
export { diagnose, formatFindings } from './adapters/drizzle/diagnostics/doctor.ts';
export { compile } from './adapters/drizzle/compile/compiler.ts';
// Aggregate (collapse to grouped rows) — the governed, grain-safe stage.
export {
  TENANT_GLOBAL,
  andFilter,
  assertAggregateSafe,
  belongsToPaths,
  toOnePaths,
  conformedDimensions,
  diagnoseAggregate,
  measuresFromRegistry,
  normalizeAggregate,
  resolveJoinPlan,
  runCompare,
  stitchCompare,
  validateMeasureDef,
  validateRatioDef,
} from './internal/analytics/index.ts';
export { aggregate, runAggregateDrizzle } from './adapters/drizzle/execute/run-drizzle.ts';
export { analyticsFromRegistry } from './adapters/drizzle/registry/analytics-from-registry.ts';
export type {
  Additivity,
  Agg,
  AggColType,
  AggFieldMeta,
  Aggregate,
  AggregateInput,
  AggregatePlan,
  AggregateResponse,
  AggEntity,
  AggRegistry,
  AggRelationship,
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
  DerivedExpr,
  DerivedMeasureDef,
  Measure,
  MeasureCatalog,
  MeasureDef,
  MeasureRef,
  RatioMeasureDef,
  ScopeFor,
} from './internal/analytics/index.ts';
export type { AggregateModel } from './adapters/drizzle/registry/model.ts';
export { runFetch, runSearch, runSearchMulti } from './adapters/drizzle/execute/runners.ts';
export type {
  AggregateRequest,
  FetchOptions,
  QueryOptions,
  QueryServiceOptions,
  ScopeResolver,
  Unscoped,
  ViewingScope,
} from './query.application-service.ts';
export { QueryApplicationService, UNSCOPED, tenantScope } from './query.application-service.ts';
export type {
  ComputedFieldSpec,
  ComputedFilterLeaf,
  EavStrategy,
  EntityDescriptor,
  EntityRegistration,
  RelDescriptor,
} from './adapters/drizzle/registry/registry.ts';
export {
  buildRegistry,
  configureQueryRegistry,
  registry,
} from './adapters/drizzle/registry/registry.ts';
export type {
  CatalogEntry,
  TableCatalog,
  ValueTableCatalog,
} from './adapters/drizzle/registry/runtime-registry.ts';
export {
  entityRegistrations,
  loadRegistrations,
} from './adapters/drizzle/registry/runtime-registry.ts';
export type { RegisterSchemaOptions } from './adapters/drizzle/registry/schema-registry.ts';
export {
  buildRegistrationsFromSchema,
  registerFromDb,
  registerSchema,
} from './adapters/drizzle/registry/schema-registry.ts';
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
} from './internal/language/types.ts';
