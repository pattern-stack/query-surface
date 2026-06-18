// The analytics model the aggregate engine runs against. Host-supplied and
// treated as opaque by the package: the cardinality/EAV registry, the DERIVED
// analytics manifest (role/agg/additivity/time tags per field), and the Drizzle
// table + column refs. See model.dealbrain.ts for the reference instance (the
// dealbrain loader); a host builds its own and injects it via
// QueryServiceOptions.aggregateModel.

import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { EntityDescriptor } from '../../registry';
import type { MeasureCatalog } from './measure-catalog';
import type { AggRegistry } from './types';

export interface AggregateModel {
  registry: Record<string, EntityDescriptor>;
  analytics: AggRegistry;
  tables: Record<string, PgTable>;
  colByDbName: Record<string, Record<string, PgColumn>>;
  /** Named-measure catalog (B2): simple measures DERIVED from the role:'measure'
   *  FieldMeta tags via measuresFromRegistry, plus any host composites (B4+).
   *  Referenced from a query by `{ ref }` (consumed in B3). Defaults to {}. */
  catalog?: MeasureCatalog;
}
