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
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

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
  accountId: uuid('account_id'),
  opportunityId: uuid('opportunity_id'),
  type: varchar('type'),
  occurredAt: timestamp('occurred_at'),
  structuredData: jsonb('structured_data'),
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
