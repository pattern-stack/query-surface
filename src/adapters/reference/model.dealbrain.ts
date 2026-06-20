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

export async function loadDealbrainModel(db: DrizzleDb): Promise<DealbrainModel> {
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

  // EAV measure tags (additivity EXPLICIT — money & percentage both resolve to
  // value_number, additivity uninferable). Bean Maxx (Salesforce-shaped) field keys:
  // weighted/projected amount = `ExpectedRevenue` (money); win % = `Probability` (percentage).
  const eavOverlay: Record<string, Record<string, AggFieldMeta>> = {
    opportunities: {
      weighted_amount: {
        type: 'number',
        role: 'measure',
        agg: 'sum',
        additivity: 'additive',
        eav: eavByKey('ExpectedRevenue'),
      },
      deal_probability: {
        type: 'number',
        role: 'measure',
        agg: 'avg',
        additivity: 'non',
        eav: eavByKey('Probability'),
      },
    },
  };

  const analytics = analyticsFromRegistry(registry, eavOverlay);
  // The named-measure catalog is DERIVED from the analytics tags (B2) — for dealbrain
  // that's weighted_amount (sum/additive) + deal_probability (avg/non), both EAV.
  const catalog = measuresFromRegistry(analytics);
  return { registry, analytics, tables, colByDbName, catalog };
}
