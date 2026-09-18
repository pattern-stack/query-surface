// tenantScope — a ScopeResolver that reads the tenant at QUERY time, so an
// AsyncLocalStorage request context seeds it from the same boundary the host's
// repositories scope by. Pure, no DB.

import { describe, expect, it } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { tenantScope } from '../query.application-service.ts';

const als = new AsyncLocalStorage<{ tenantId?: string }>();
const getTenantId = () => als.getStore()?.tenantId;

describe('tenantScope', () => {
  it('reads the tenant from the ambient context on every call (never captured at build)', () => {
    const scope = tenantScope({ getTenantId, column: 'tenant_id' });
    expect(als.run({ tenantId: 't1' }, () => scope('accounts'))).toEqual({
      on: 'tenant_id',
      op: 'eq',
      value: 't1',
    });
    expect(als.run({ tenantId: 't2' }, () => scope('accounts'))).toEqual({
      on: 'tenant_id',
      op: 'eq',
      value: 't2',
    });
  });

  it('fails closed: no tenant in context → undefined (the engine refuses the read)', () => {
    const scope = tenantScope({ getTenantId, column: 'tenant_id' });
    expect(scope('accounts')).toBeUndefined();
    expect(als.run({}, () => scope('accounts'))).toBeUndefined();
  });

  it('per-entity column map: an unmapped entity resolves undefined (coverage gap)', () => {
    const scope = tenantScope({
      getTenantId,
      column: { accounts: 'tenant_id', opportunities: 'org_id' },
    });
    als.run({ tenantId: 't1' }, () => {
      expect(scope('opportunities')).toEqual({ on: 'org_id', op: 'eq', value: 't1' });
      expect(scope('observations')).toBeUndefined();
    });
  });
});
