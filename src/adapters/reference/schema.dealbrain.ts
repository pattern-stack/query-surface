// Real Drizzle schema + relations() for the dealbrain analytics entities.
// The package's buildRegistry() derives the belongs_to/has_many cardinality
// graph from these relations() — same source of truth the retrieval surface uses.
//
// observations belongs_to opportunities belongs_to accounts;
// weighted_amount / deal_probability are EAV custom fields on opportunities
// (field_values, typed-columns shape).

import { relations } from 'drizzle-orm';
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

// relations() — the cardinality graph buildRegistry introspects.
export const accountsRelations = relations(accounts, ({ many }) => ({
  opportunities: many(opportunities),
  observations: many(observations),
}));

export const opportunitiesRelations = relations(opportunities, ({ one, many }) => ({
  account: one(accounts, { fields: [opportunities.accountId], references: [accounts.id] }),
  observations: many(observations),
}));

export const observationsRelations = relations(observations, ({ one }) => ({
  opportunity: one(opportunities, {
    fields: [observations.opportunityId],
    references: [opportunities.id],
  }),
  account: one(accounts, { fields: [observations.accountId], references: [accounts.id] }),
}));
