// The Drizzle-native model: the package's real registry (cardinality graph + EAV
// strategy + FieldMeta analytics tags, from Drizzle relations()) PLUS an EAV
// measure overlay (tags can't ride dealbrain's field_definitions). The analytics
// manifest is DERIVED from the registry (analyticsFromRegistry) — the field tags
// are live, not hand-built.

import { getTableColumns, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { measuresFromRegistry } from '../../internal/analytics/measure-catalog';
import type { AggFieldMeta } from '../../internal/analytics/types';
import { valueColumnForDataType } from '../drizzle/eav/mapping';
import type { DrizzleDb } from '../drizzle/execute/drizzle-db';
import { analyticsFromRegistry } from '../drizzle/registry/analytics-from-registry';
import type { FieldMetaMap } from '../drizzle/registry/define-entity';
import type { AggregateModel } from '../drizzle/registry/model';
import { buildRegistry } from '../drizzle/registry/registry';
import {
  accounts,
  accountsRelations,
  fieldValues,
  observations,
  observationsRelations,
  opportunities,
  opportunitiesRelations,
} from './schema.dealbrain';

/** The dealbrain reference instance is a plain AggregateModel — the alias is
 *  retained for the engine internals + eval specs that reference it by name. */
export type DealbrainModel = AggregateModel;

// Native dimension tags ride on FieldMeta (keyed by column PROPERTY name).
const accountsMeta: FieldMetaMap = { id: { role: 'dimension' }, name: { role: 'dimension' } };
const opportunitiesMeta: FieldMetaMap = {
  id: { role: 'dimension' },
  accountId: { role: 'dimension' },
  stateOfDealStatus: { role: 'dimension' },
}; // measures (weighted_amount, deal_probability) are EAV → overlay below
const observationsMeta: FieldMetaMap = {
  id: { role: 'dimension' },
  accountId: { role: 'dimension' },
  opportunityId: { role: 'dimension' },
  type: { role: 'dimension' },
  occurredAt: { role: 'dimension', time: true },
  structuredData: { role: 'dimension' },
};

/** A measure the host (the field-management app) resolved from its field configs — the EAV field
 *  key + how to aggregate it. Lets the analytics model be DRIVEN BY DATA (a curated semantic layer)
 *  instead of hand-coded here. Omitted → the built-in default set (eval specs are unaffected). */
export interface DealbrainMeasureSpec {
  name: string; // the measure name exposed in the surface (e.g. 'weighted_amount')
  key: string; // the dealbrain EAV field_definitions.key (e.g. 'ExpectedRevenue')
  agg: 'sum' | 'avg' | 'count' | 'count_distinct' | 'min' | 'max';
  additivity: 'additive' | 'non';
}

const DEFAULT_MEASURE_SPECS: DealbrainMeasureSpec[] = [
  { name: 'weighted_amount', key: 'ExpectedRevenue', agg: 'sum', additivity: 'additive' },
  { name: 'deal_probability', key: 'Probability', agg: 'avg', additivity: 'non' },
];

/** An EAV field exposed as a groupable DIMENSION (the host's resolved semantic layer). Referenced
 *  in group_by by its SAFE canonical `name` (e.g. 'stage'); the dealbrain `key` (e.g. 'StageName')
 *  is used only to resolve the EAV value binding. A select/text field is a 1:1 field_values join →
 *  grain-safe (groupable like a to-one dim, never a fan-out). */
export interface DealbrainDimensionSpec {
  name: string; // safe canonical name used in group_by (e.g. 'stage')
  key: string; // the dealbrain field_definitions.key (e.g. 'StageName')
}

export async function loadDealbrainModel(
  db: DrizzleDb,
  measureSpecs: DealbrainMeasureSpec[] = DEFAULT_MEASURE_SPECS,
  dimensionSpecs: DealbrainDimensionSpec[] = [],
): Promise<DealbrainModel> {
  const registry = buildRegistry([
    { name: 'accounts', table: accounts, relations: accountsRelations, fieldMeta: accountsMeta },
    {
      name: 'opportunities',
      table: opportunities,
      relations: opportunitiesRelations,
      eav: { kind: 'typed-columns', valueTable: fieldValues, entityTypeValue: 'opportunity' },
      fieldMeta: opportunitiesMeta,
    },
    {
      name: 'observations',
      table: observations,
      relations: observationsRelations,
      fieldMeta: observationsMeta,
    },
  ]);

  const tables: Record<string, PgTable> = { accounts, opportunities, observations };
  const colByDbName: Record<string, Record<string, PgColumn>> = {};
  for (const [name, tbl] of Object.entries(tables)) {
    const m: Record<string, PgColumn> = {};
    for (const col of Object.values(getTableColumns(tbl)) as PgColumn[]) m[col.name] = col;
    colByDbName[name] = m;
  }

  // EAV-via-field-map: resolve measures by their field_definitions KEY through an
  // ANALYTICS field-map (org-scoped, UNGATED — analytics aggregates over fields the
  // read-UI curation hides; hs_projected_amount is is_visible=false). Value column
  // from valueColumnForDataType(data_type); no injected defIds.
  const PROP_TO_COL: Record<
    string,
    'value_number' | 'value_text' | 'value_date' | 'value_boolean'
  > = {
    valueNumber: 'value_number',
    valueText: 'value_text',
    valueDate: 'value_date',
    valueBoolean: 'value_boolean',
  };
  const fdRes = await db.execute(
    sql`select id, key, data_type from field_definitions where entity_type='opportunity' and organization_id is not null`,
  );
  const fieldMap = new Map<string, { defId: string; dataType: string }>();
  for (const r of fdRes.rows as Array<{ id: string; key: string; data_type: string }>) {
    if (!fieldMap.has(r.key)) fieldMap.set(r.key, { defId: r.id, dataType: r.data_type });
  }
  const eavByKey = (key: string): NonNullable<AggFieldMeta['eav']> => {
    const fd = fieldMap.get(key);
    if (!fd) throw new Error(`EAV field_definition not found for key: ${key}`);
    return { valueColumn: PROP_TO_COL[valueColumnForDataType(fd.dataType)]!, defId: fd.defId };
  };

  // EAV measure tags, DERIVED from measureSpecs (the host's resolved semantic layer — or the
  // built-in default). additivity stays EXPLICIT (money & percentage both resolve to value_number,
  // uninferable). Each spec's key resolves to its EAV binding via eavByKey (fail-loud if absent).
  const eavOverlay: Record<string, Record<string, AggFieldMeta>> = {
    opportunities: {
      ...Object.fromEntries(
        measureSpecs.map((s) => [
          s.name,
          {
            type: 'number',
            role: 'measure',
            agg: s.agg,
            additivity: s.additivity,
            eav: eavByKey(s.key),
          } satisfies AggFieldMeta,
        ]),
      ),
      // EAV DIMENSIONS — a select/text field exposed as a groupable dim (1:1 field_values join,
      // grain-safe). Keyed by the safe canonical name; the EAV binding resolves the dealbrain key.
      ...Object.fromEntries(
        dimensionSpecs.map((s) => [
          s.name,
          { type: 'string', role: 'dimension', eav: eavByKey(s.key) } satisfies AggFieldMeta,
        ]),
      ),
    },
  };

  const analytics = analyticsFromRegistry(registry, eavOverlay);
  // The named-measure catalog is DERIVED from the analytics tags (B2) — for dealbrain
  // that's weighted_amount (sum/additive) + deal_probability (avg/non), both EAV.
  const catalog = measuresFromRegistry(analytics);
  return { registry, analytics, tables, colByDbName, catalog };
}
