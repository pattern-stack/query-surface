// Real Drizzle schema + defineRelations() for the dealbrain analytics entities.
// The package's buildRegistry() derives the belongs_to/has_many cardinality
// graph from these relations — same source of truth the retrieval surface uses.
//
// observations belongs_to opportunities belongs_to accounts;
// weighted_amount / deal_probability are EAV custom fields on opportunities
// (field_values, typed-columns shape).

import { defineRelations } from 'drizzle-orm';
import {
  boolean,
  customType,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

// pgvector column — registered so the compiler's semantic-rank path
// (`${embCol} <=> ${vec}::vector`) can resolve `observations.embedding`. The
// observations table below is the CANONICAL retrieval surface (normalized_text +
// embedding + the provenance/scope columns), so the harness no longer needs an
// extended shim. Mirrors that customType.
const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return 'vector';
  },
});

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey(),
  name: varchar('name'),
});

export const opportunities = pgTable('opportunities', {
  id: uuid('id').primaryKey(),
  accountId: uuid('account_id'),
  stateOfDealStatus: varchar('state_of_deal_status'),
});

export const observations = pgTable('observations', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organization_id'), // tenancy — the org allowed to read this observation
  accountId: uuid('account_id'),
  opportunityId: uuid('opportunity_id'),
  artifactId: uuid('artifact_id'), // source artifact (email / note / meeting record) the obs was extracted from
  type: varchar('type'),
  scope: varchar('scope'), // 'deal' | 'organization' — deal-local vs org-wide visibility
  occurredAt: timestamp('occurred_at'),
  structuredData: jsonb('structured_data'),
  normalizedText: text('normalized_text'),
  sourceRefs: jsonb('source_refs'), // provenance: quoted text excerpt + artifact reference
  embedding: vector('embedding'),
  retractedAt: timestamp('retracted_at'), // soft-delete marker; NULL ⇒ active
});

export const fieldValues = pgTable('field_values', {
  id: uuid('id').primaryKey(),
  entityId: uuid('entity_id'),
  fieldDefinitionId: uuid('field_definition_id'),
  entityType: varchar('entity_type'),
  valueNumber: numeric('value_number'),
  valueText: text('value_text'),
  valueDate: timestamp('value_date'),
  valueBoolean: boolean('value_boolean'),
});

// defineRelations() — the cardinality graph buildRegistry introspects. The many()
// sides omit from/to: Drizzle resolves them off the reverse one().
export const dealbrainRelations = defineRelations(
  { accounts, opportunities, observations },
  (r) => ({
    accounts: {
      opportunities: r.many.opportunities(),
      observations: r.many.observations(),
    },
    opportunities: {
      account: r.one.accounts({ from: r.opportunities.accountId, to: r.accounts.id }),
      observations: r.many.observations(),
    },
    observations: {
      opportunity: r.one.opportunities({
        from: r.observations.opportunityId,
        to: r.opportunities.id,
      }),
      account: r.one.accounts({ from: r.observations.accountId, to: r.accounts.id }),
    },
  }),
);

// Per-table slices, for EntityRegistration.relations.
export const accountsRelations = dealbrainRelations.accounts.relations;
export const opportunitiesRelations = dealbrainRelations.opportunities.relations;
export const observationsRelations = dealbrainRelations.observations.relations;
