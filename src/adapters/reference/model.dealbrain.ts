// The Drizzle-native model: the package's real registry (cardinality graph + EAV
// strategy + FieldMeta analytics tags, from Drizzle relations()) PLUS an EAV
// measure overlay (tags can't ride dealbrain's field_definitions). The analytics
// manifest is DERIVED from the registry (analyticsFromRegistry) — the field tags
// are live, not hand-built.

import { getTableColumns, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import {
  type AtomicMeasureDef,
  type MeasureCatalog,
  measuresFromRegistry,
  validateDerivedDef,
  validateMeasureDef,
  validateRatioDef,
} from '../../internal/analytics/measure-catalog';
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
 *  retained as the reference instance's local name (loadDealbrainModel's return
 *  type). Callers outside this adapter use AggregateModel directly; re-exported
 *  here for the eval specs that load this fixture. */
export type DealbrainModel = AggregateModel;
export type { AggregateModel };

// Native dimension tags ride on FieldMeta (keyed by column PROPERTY name).
const accountsMeta: FieldMetaMap = { id: { role: 'dimension' }, name: { role: 'dimension' } };
const opportunitiesMeta: FieldMetaMap = {
  id: { role: 'dimension' },
  accountId: { role: 'dimension' },
  stateOfDealStatus: { role: 'dimension' },
}; // measures (Amount, ExpectedRevenue, Probability — by allowed aggs) are EAV → overlay below
/** The deal-type taxonomy — observation semantic types. Used as the STATIC
 *  fallback for observations.type.selectOptions when the data-driven SELECT
 *  DISTINCT (loadDealbrainModel) can't run (e.g. no live DB). The live corpus
 *  also carries org-scope playbook types (workflow_playbook, role_policy, …),
 *  which the data-driven path surfaces; this list is the deal-scope core. */
export const OBSERVATION_TYPE_TAXONOMY = [
  'product_request',
  'requirement',
  'pain',
  'risk',
  'objection',
  'pricing_signal',
  'competitor_signal',
  'stakeholder_signal',
  'commitment',
  'timeline',
  'urgency',
  'buying_intent',
  'seller_intent',
  'discovery',
  'risk_resolution',
  'product_information',
  'implementation_information',
  'commercial_information',
  'summary',
  'background',
  'questions',
  'coaching',
] as const;

/** Observations FieldMeta. `type.selectOptions` is overridden DATA-DRIVEN at
 *  model-load (SELECT DISTINCT type) when the DB is available — see
 *  loadDealbrainModel; this declaration carries the static taxonomy default plus
 *  the retrieval-surface semantics (searchable text, hidden embedding/tenancy
 *  columns, provenance + scope dimensions). */
export const observationsMeta: FieldMetaMap = {
  id: { role: 'dimension' },
  organizationId: { role: 'dimension', isVisible: false }, // tenancy — structural, hidden from the catalog
  accountId: { role: 'dimension' },
  opportunityId: { role: 'dimension' },
  artifactId: {
    role: 'dimension',
    description:
      'ID of the source artifact (email, note, meeting record) the observation was extracted from',
  },
  type: {
    role: 'dimension',
    isKeyField: true,
    selectOptions: [...OBSERVATION_TYPE_TAXONOMY],
    description:
      'Observation semantic type — the intent/signal this captures (the deal-type taxonomy)',
  },
  scope: {
    role: 'dimension',
    selectOptions: ['deal', 'organization'],
    searchable: false, // a closed 2-value enum dimension — filter by eq, not full-text search
    description: 'Visibility scope: deal-local or organization-wide',
  },
  occurredAt: {
    role: 'dimension',
    time: true,
    isKeyField: true,
    description: 'When this observation was recorded',
  },
  structuredData: { role: 'dimension' },
  normalizedText: {
    isKeyField: true,
    searchable: true,
    description: 'Normalized prose text — the semantic ranking surface (lexical + vector)',
  },
  sourceRefs: {
    role: 'dimension',
    description: 'Provenance citation: quoted text excerpt + artifact reference',
  },
  embedding: {
    isVisible: false,
    description: 'pgvector embedding of normalized_text for semantic search',
  },
  retractedAt: {
    isVisible: false,
    description: 'Soft-delete timestamp; NULL ⇒ active, set ⇒ retracted',
  },
};

/** An EAV field exposed as an aggregatable MEASURE. The field IS the measure — its real name (the
 *  field_definitions.key, e.g. 'Amount') is surfaced as-is — and aggregation is a CONFIG on it:
 *  `aggs` lists the allowed aggregations, so the catalog exposes `Amount.sum`, `Amount.avg`, … This
 *  unwinds the old named-variant model (`weighted_amount` for `sum(ExpectedRevenue)`), which divorced
 *  the surfaced name from the field and forced per-measure curation. `additivity` is the field's
 *  summable-ness (the doctor refuses SUM on a `non` percentage). Host-resolvable (field-management
 *  app) or the built-in default set. */
export interface DealbrainMeasureSpec {
  key: string; // the dealbrain EAV field_definitions.key AND the surfaced field name (e.g. 'Amount')
  aggs: ('sum' | 'avg' | 'count' | 'count_distinct' | 'min' | 'max')[];
  additivity?: 'additive' | 'semi' | 'non'; // summable-ness; default 'additive'
}

const DEFAULT_MEASURE_SPECS: DealbrainMeasureSpec[] = [
  { key: 'Amount', aggs: ['sum', 'avg', 'min', 'max'], additivity: 'additive' },
  { key: 'ExpectedRevenue', aggs: ['sum', 'avg', 'min', 'max'], additivity: 'additive' },
  { key: 'Probability', aggs: ['avg', 'min', 'max'], additivity: 'non' }, // percentage → not summable
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
  // Host-named measure definitions (instances-by-data) — merged onto the auto-derived `Field.agg`
  // catalog AFTER it's built, so an agent can call a measure by a STABLE SLUG (e.g. {ref:'total_revenue'})
  // instead of guessing on/agg. Each atomic def's underlying field must already be a registered
  // measure (i.e. its key is in measureSpecs) so the EAV binding + role exist; a ratio's legs must
  // name atomic catalog entries. Validated here — a bad def is a model-load error, not a query-time
  // surprise. A slug that collides with an auto-derived key is refused (no silent shadowing).
  measureDefs: MeasureCatalog = {},
): Promise<DealbrainModel> {
  // DATA-DRIVEN type taxonomy: SELECT DISTINCT type at model-load (the same
  // pattern the EAV field-defs use below), so observations.type.selectOptions
  // reflects the LIVE corpus — which carries more types than the deal-scope core
  // (org-scope playbook types: workflow_playbook, role_policy, …). Falls back to
  // the static taxonomy when the query yields nothing.
  const typeRes = await db.execute(
    sql`select distinct type from observations where type is not null order by type`,
  );
  const liveTypes = (typeRes.rows as Array<{ type: string }>).map((r) => r.type);
  const observationsMetaEffective: FieldMetaMap = {
    ...observationsMeta,
    type: {
      ...observationsMeta.type,
      selectOptions: liveTypes.length > 0 ? liveTypes : [...OBSERVATION_TYPE_TAXONOMY],
    },
  };

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
      fieldMeta: observationsMetaEffective,
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
  // built-in default). The field is registered under its REAL name (s.key) carrying the allowed
  // `aggs`; the catalog then exposes `<key>.<agg>`. additivity stays EXPLICIT (money & percentage
  // both resolve to value_number, uninferable). Each key resolves its EAV binding via eavByKey.
  const eavOverlay: Record<string, Record<string, AggFieldMeta>> = {
    opportunities: {
      ...Object.fromEntries(
        measureSpecs.map((s) => [
          s.key,
          {
            type: 'number',
            role: 'measure',
            aggs: s.aggs,
            additivity: s.additivity ?? 'additive',
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
  // The measure catalog is DERIVED from the analytics tags (B2) — for dealbrain that's the
  // field.agg combos: Amount.{sum,avg,min,max}, ExpectedRevenue.{…}, Probability.{avg,min,max}.
  const catalog = measuresFromRegistry(analytics);
  // Merge host-named measure defs onto the auto-derived catalog. A slug may never shadow an existing
  // key (auto-derived OR another host def). TWO passes so a ratio can name a host atomic slug
  // regardless of object key order: (1) atomics — validate (field registered + additivity not looser)
  // + add; (2) ratios — validate (legs are atomic catalog entries, now all present) + add.
  for (const slug of Object.keys(measureDefs)) {
    if (catalog[slug]) {
      throw new Error(
        `loadDealbrainModel: measure slug "${slug}" collides with an existing catalog measure`,
      );
    }
  }
  for (const [slug, def] of Object.entries(measureDefs)) {
    if (def.kind !== 'atomic') continue;
    validateMeasureDef(analytics, slug, def as AtomicMeasureDef);
    catalog[slug] = def;
  }
  for (const [slug, def] of Object.entries(measureDefs)) {
    if (def.kind === 'atomic') continue;
    if (def.kind === 'ratio') validateRatioDef(catalog, slug, def);
    if (def.kind === 'derived') validateDerivedDef(catalog, slug, def);
    catalog[slug] = def;
  }
  return { registry, analytics, tables, colByDbName, catalog };
}
