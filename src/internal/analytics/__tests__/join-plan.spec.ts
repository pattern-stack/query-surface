// Pure unit tests for the dialect-neutral join-plan resolver (ADR-0024 wave 1). No DB —
// the resolver walks the cardinality graph (AggRegistry.rels) and decides reachability +
// cardinality + the join shape. Mirrors the dealbrain reference graph, including the
// observations→accounts DIAMOND (direct obs.account_id AND obs→opp→account) the
// characterization net proved the retrieval path silently mis-resolves.

import { describe, expect, it } from 'bun:test';
import { belongsToPaths, conformedDimensions, resolveJoinPlan } from '../join-plan';
import type { AggRegistry } from '../types';

const reg: AggRegistry = {
  accounts: {
    table: 'accounts',
    pk: 'id',
    rels: {
      opportunities: { kind: 'has_many', target: 'opportunities', fk: 'account_id' },
      observations: { kind: 'has_many', target: 'observations', fk: 'account_id' },
    },
    fields: {
      id: { type: 'uuid', role: 'dimension' },
      name: { type: 'string', role: 'dimension' },
    },
  },
  opportunities: {
    table: 'opportunities',
    pk: 'id',
    rels: {
      account: { kind: 'belongs_to', target: 'accounts', fk: 'account_id' },
      observations: { kind: 'has_many', target: 'observations', fk: 'opportunity_id' },
    },
    fields: {
      id: { type: 'uuid', role: 'dimension' },
      account_id: { type: 'uuid', role: 'dimension' },
      state_of_deal_status: { type: 'string', role: 'dimension' },
      weighted_amount: { type: 'number', role: 'measure', agg: 'sum', additivity: 'additive' },
    },
  },
  observations: {
    table: 'observations',
    pk: 'id',
    rels: {
      opportunity: { kind: 'belongs_to', target: 'opportunities', fk: 'opportunity_id' },
      account: { kind: 'belongs_to', target: 'accounts', fk: 'account_id' },
    },
    fields: {
      id: { type: 'uuid', role: 'dimension' },
      account_id: { type: 'uuid', role: 'dimension' },
      opportunity_id: { type: 'uuid', role: 'dimension' },
      type: { type: 'string', role: 'dimension' },
    },
  },
};

describe('belongsToPaths (the to-one walker)', () => {
  it('opportunities→accounts is a single to-one path', () => {
    const paths = belongsToPaths(reg, 'opportunities', 'accounts');
    expect(paths).toHaveLength(1);
    expect(paths[0]).toEqual([
      { from: 'opportunities', to: 'accounts', fk: 'account_id', toPk: 'id' },
    ]);
  });
  it('observations→accounts is a DIAMOND — two distinct to-one paths (direct + via opportunity)', () => {
    expect(belongsToPaths(reg, 'observations', 'accounts')).toHaveLength(2);
  });
  it('observations→opportunities is a single to-one path', () => {
    expect(belongsToPaths(reg, 'observations', 'opportunities')).toHaveLength(1);
  });
  it('accounts→opportunities has NO to-one path (it is to-many)', () => {
    expect(belongsToPaths(reg, 'accounts', 'opportunities')).toHaveLength(0);
  });
});

describe('resolveJoinPlan — group role', () => {
  it('a bare own column resolves local', () => {
    expect(resolveJoinPlan(reg, 'opportunities', 'state_of_deal_status', 'group')).toEqual({
      kind: 'local',
      column: 'state_of_deal_status',
    });
  });
  it('an explicit self-prefix strips to local', () => {
    expect(
      resolveJoinPlan(reg, 'opportunities', 'opportunities.state_of_deal_status', 'group'),
    ).toEqual({ kind: 'local', column: 'state_of_deal_status' });
  });
  it('a to-one parent dim resolves with a belongs_to join chain', () => {
    const plan = resolveJoinPlan(reg, 'opportunities', 'accounts.name', 'group');
    expect(plan.kind).toBe('to-one');
    if (plan.kind !== 'to-one') throw new Error('expected to-one');
    expect(plan.target).toBe('accounts');
    expect(plan.column).toBe('name');
    expect(plan.hops).toEqual([
      { from: 'opportunities', to: 'accounts', fk: 'account_id', toPk: 'id' },
    ]);
    expect(plan.traversed).toEqual(['accounts']);
  });
  it('a to-many dim is REJECTED (would fan out the measure)', () => {
    const plan = resolveJoinPlan(reg, 'accounts', 'opportunities.state_of_deal_status', 'group');
    expect(plan.kind).toBe('reject');
    if (plan.kind !== 'reject') throw new Error('expected reject');
    expect(plan.code).toBe('to-many');
    expect(plan.reason).toMatch(/to-many|fan out|not conformed/i);
  });
  it('a DIAMOND dim is REJECTED as ambiguous (no silent edge-pick)', () => {
    const plan = resolveJoinPlan(reg, 'observations', 'accounts.name', 'group');
    expect(plan.kind).toBe('reject');
    if (plan.kind !== 'reject') throw new Error('expected reject');
    expect(plan.code).toBe('ambiguous');
  });
  it('an unambiguous multi-candidate reduces correctly: observations→opportunities is to-one', () => {
    const plan = resolveJoinPlan(
      reg,
      'observations',
      'opportunities.state_of_deal_status',
      'group',
    );
    expect(plan.kind).toBe('to-one');
    if (plan.kind !== 'to-one') throw new Error('expected to-one');
    expect(plan.hops).toEqual([
      { from: 'observations', to: 'opportunities', fk: 'opportunity_id', toPk: 'id' },
    ]);
  });
  it('an entity with no column is unsupported', () => {
    const plan = resolveJoinPlan(reg, 'opportunities', 'accounts', 'group');
    expect(plan.kind).toBe('reject');
  });
});

describe('resolveJoinPlan — filter role', () => {
  it('a child dim resolves as a semijoin (EXISTS), not a fan-out join', () => {
    const plan = resolveJoinPlan(reg, 'accounts', 'observations.type', 'filter');
    expect(plan.kind).toBe('semijoin');
    if (plan.kind !== 'semijoin') throw new Error('expected semijoin');
    expect(plan.child).toBe('observations');
    expect(plan.fk).toBe('account_id');
    expect(plan.parentPk).toBe('id');
    expect(plan.column).toBe('type');
  });
  it('a to-one parent dim resolves as a join (same as group)', () => {
    expect(resolveJoinPlan(reg, 'opportunities', 'accounts.name', 'filter').kind).toBe('to-one');
  });
  it('a DIAMOND filter is ambiguous too (the to-one check runs first)', () => {
    const plan = resolveJoinPlan(reg, 'observations', 'accounts.name', 'filter');
    expect(plan.kind).toBe('reject');
    if (plan.kind !== 'reject') throw new Error('expected reject');
    expect(plan.code).toBe('ambiguous');
  });
});

describe('conformedDimensions (the describe surface)', () => {
  it('opportunities: own dims ∪ to-one accounts dims; NO observations (to-many)', () => {
    const dims = conformedDimensions(reg, 'opportunities');
    const paths = dims.map((d) => d.path).sort();
    expect(paths).toContain('state_of_deal_status');
    expect(paths).toContain('account_id');
    expect(paths).toContain('accounts.name');
    expect(paths).toContain('accounts.id');
    // a role:'measure' field is NOT a dimension
    expect(paths).not.toContain('weighted_amount');
    // observations is a has_many child → not conformed
    expect(paths.some((p) => p.startsWith('observations.'))).toBe(false);
  });
  it('observations: own ∪ to-one opportunities dims; NO accounts (the diamond is excluded)', () => {
    const paths = conformedDimensions(reg, 'observations').map((d) => d.path);
    expect(paths).toContain('type');
    expect(paths).toContain('opportunities.state_of_deal_status');
    // accounts is reachable only via an AMBIGUOUS diamond → excluded from the advertised set,
    // exactly as resolveJoinPlan would reject it.
    expect(paths.some((p) => p.startsWith('accounts.'))).toBe(false);
  });
  it('accounts: own dims only (no to-one parent out of accounts)', () => {
    const paths = conformedDimensions(reg, 'accounts')
      .map((d) => d.path)
      .sort();
    expect(paths).toEqual(['id', 'name']);
  });
});

// ADR-0024 Amendment 4 — a BARE group dim owned by a to-one TARGET resolves to-one (the execute
// path the eav-to-one work already advertises via conformedDimensions), with the unsafe directions
// still refused. Group-role only; dimensions-only; physical-local names are gated at the adapter.
describe('resolveJoinPlan — bare-name conformed group dim (Amendment 4)', () => {
  it('bare dim owned by ONE to-one target resolves to-one', () => {
    // state_of_deal_status is a dimension on opportunities; observations→opportunities is one to-one
    // path; not on observations; accounts is a diamond (excluded) → unique owner = opportunities.
    const plan = resolveJoinPlan(reg, 'observations', 'state_of_deal_status', 'group');
    expect(plan.kind).toBe('to-one');
    if (plan.kind === 'to-one') {
      expect(plan.target).toBe('opportunities');
      expect(plan.column).toBe('state_of_deal_status');
    }
  });

  it('a bare name that IS a field on the source stays LOCAL (never searched)', () => {
    expect(resolveJoinPlan(reg, 'observations', 'type', 'group')).toEqual({
      kind: 'local',
      column: 'type',
    });
    expect(resolveJoinPlan(reg, 'observations', 'account_id', 'group')).toEqual({
      kind: 'local',
      column: 'account_id',
    });
  });

  it('a bare name that is a MEASURE on the target is NOT rerouted (dimensions-only) → local fallback', () => {
    // weighted_amount is role:'measure' on opportunities → not a dimension candidate → 0 hits → local.
    expect(resolveJoinPlan(reg, 'observations', 'weighted_amount', 'group')).toEqual({
      kind: 'local',
      column: 'weighted_amount',
    });
  });

  it('a bare name owned only via a DIAMOND target is excluded → local fallback (fails loud downstream)', () => {
    // `name` lives on accounts, reachable from observations by 2 paths (direct + via opportunities) →
    // belongsToPaths length 2 → skipped → 0 hits → local (then unknown-column at lowering).
    expect(resolveJoinPlan(reg, 'observations', 'name', 'group')).toEqual({
      kind: 'local',
      column: 'name',
    });
  });

  it('the bare-name search is GROUP-ONLY — a filter-role bare name stays local (not rerouted)', () => {
    expect(resolveJoinPlan(reg, 'observations', 'state_of_deal_status', 'filter')).toEqual({
      kind: 'local',
      column: 'state_of_deal_status',
    });
  });
});
