// Proves the Drizzle pivot foundation: the belongs_to/has_many cardinality graph
// the aggregate engine relies on is derived by the PACKAGE'S OWN buildRegistry()
// from idiomatic Drizzle relations() — not a hand-built map. Pure, no DB.

import { describe, expect, it } from 'bun:test';
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

describe('dealbrain Drizzle registry — cardinality graph from relations()', () => {
  const reg = buildRegistry([
    { name: 'accounts', table: accounts, relations: accountsRelations },
    {
      name: 'opportunities',
      table: opportunities,
      relations: opportunitiesRelations,
      eav: { kind: 'typed-columns', valueTable: fieldValues, entityTypeValue: 'opportunity' },
    },
    { name: 'observations', table: observations, relations: observationsRelations },
  ]);

  it('derives belongs_to with the correct fk column', () => {
    expect(reg.observations!.relationships.opportunity).toEqual({
      kind: 'belongs_to',
      target: 'opportunities',
      fk: 'opportunity_id',
    });
    expect(reg.observations!.relationships.account).toEqual({
      kind: 'belongs_to',
      target: 'accounts',
      fk: 'account_id',
    });
    expect(reg.opportunities!.relationships.account).toEqual({
      kind: 'belongs_to',
      target: 'accounts',
      fk: 'account_id',
    });
  });

  it('resolves has_many fk from the inverse belongs_to (pass 2)', () => {
    expect(reg.opportunities!.relationships.observations).toEqual({
      kind: 'has_many',
      target: 'observations',
      fk: 'opportunity_id',
    });
    expect(reg.accounts!.relationships.opportunities).toEqual({
      kind: 'has_many',
      target: 'opportunities',
      fk: 'account_id',
    });
    expect(reg.accounts!.relationships.observations).toEqual({
      kind: 'has_many',
      target: 'observations',
      fk: 'account_id',
    });
  });

  it('carries the EAV strategy on opportunities', () => {
    expect(reg.opportunities!.eav?.kind).toBe('typed-columns');
  });
});
