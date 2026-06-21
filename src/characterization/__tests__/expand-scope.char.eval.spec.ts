// EXPAND SCOPE — tenancy scope folds through fetch() relational expand (invariant #3).
//
// CHARACTERIZATION net for the scope-leak fix: before the fix, expand read related
// entities with a bare FK/PK `IN` and no tenancy predicate (expand.ts expandBelongsTo
// / expandHasMany), and expandRows was never even handed a scope resolver — so a
// fetch() with `expand` could hydrate rows the caller's scope forbids (a cross-scope
// read leak). The service now passes a FAIL-CLOSED ExpandScopeResolver down into
// expand; every traversed relation folds its per-entity scope, and an uncovered
// (non-TENANT_GLOBAL) traversed entity REFUSES rather than reading unscoped.
//
// All assertions go through the PUBLIC surface (service.fetch); fixtures are pulled
// from the live DB so no hard-coded id drifts.
//
//   DBURL=postgres://postgres:password@localhost:54321/dealbrain \
//     bun test src/characterization/__tests__/expand-scope.char.eval.spec.ts

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import type { EntityName, FilterExpression } from '../../internal/language/types.ts';
import type { ScopeResolver } from '../../query.application-service.ts';
import { type QuerySurfaceHarness, makeQuerySurface } from '../harness.ts';

const DBURL = process.env.DBURL;
const suite = DBURL ? describe : describe.skip;

suite('expand scope — tenancy folds through fetch() expand (characterization)', () => {
  let base: QuerySurfaceHarness;
  const toClose: QuerySurfaceHarness[] = [];

  // Two distinct accounts, each with an opportunity — A is the in-scope fixture,
  // B supplies an out-of-scope value. Pulled live (no hard-coded ids).
  let A: { accountId: string; accountName: string; oppId: string };
  let B: { accountName: string };

  const truth = async (q: string) =>
    (await base.db.execute(sql.raw(q))).rows as Record<string, unknown>[];

  // A scoped service for one scenario; tracked for teardown.
  const scoped = (scope: ScopeResolver, tenantGlobalEntities?: readonly EntityName[]) => {
    const h = makeQuerySurface(DBURL!, {
      scope,
      ...(tenantGlobalEntities ? { tenantGlobalEntities } : {}),
    });
    toClose.push(h);
    return h.service;
  };

  beforeAll(async () => {
    base = makeQuerySurface(DBURL!);
    const rows = await truth(
      'select distinct on (a.id) a.id as account_id, a.name as account_name, o.id as opp_id ' +
        'from accounts a join opportunities o on o.account_id = a.id ' +
        'where a.name is not null order by a.id, o.id limit 2',
    );
    A = {
      accountId: String(rows[0].account_id),
      accountName: String(rows[0].account_name),
      oppId: String(rows[0].opp_id),
    };
    B = { accountName: String(rows[1].account_name) };
    expect(A.accountName).not.toBe(B.accountName); // the two fixtures are genuinely distinct
  });

  afterAll(async () => {
    await base.close();
    await Promise.all(toClose.map((h) => h.close()));
  });

  // accounts scope keyed to a name; everything else unscoped-but-covered (returns a
  // tautology-free predicate only for accounts, undefined elsewhere — fine because the
  // only TRAVERSED entity in these tests is the expand target).
  const accountsScopedTo =
    (name: string): ScopeResolver =>
    (entity: EntityName) =>
      entity === 'accounts'
        ? ({ on: 'name', op: 'eq', value: name } as FilterExpression)
        : undefined;

  it('belongs_to expand: an IN-SCOPE parent hydrates', async () => {
    const svc = scoped(accountsScopedTo(A.accountName));
    const res = await svc.fetch('opportunities', [A.oppId], { expand: ['account'] });
    const acct = res.rows[0]?.account as Record<string, unknown> | null;
    expect(acct).not.toBeNull();
    expect(acct?.name).toBe(A.accountName);
  });

  it('belongs_to expand: an OUT-OF-SCOPE parent is filtered to null (the leak, closed)', async () => {
    // Scope accounts to a DIFFERENT account → A's opportunity keeps its account_id,
    // but the expand read excludes that account, so the relation resolves to null.
    // Before the fix this returned the full account row regardless of scope.
    const svc = scoped(accountsScopedTo(B.accountName));
    const res = await svc.fetch('opportunities', [A.oppId], { expand: ['account'] });
    expect(res.rows[0]?.account ?? null).toBeNull();
  });

  it('has_many expand: only IN-SCOPE children are attached', async () => {
    // Scope opportunities to exactly A's opp → expanding an account's opportunities
    // returns only that one, never the account's other (out-of-scope) opps.
    const svc = scoped((entity) =>
      entity === 'opportunities'
        ? ({ on: 'id', op: 'eq', value: A.oppId } as FilterExpression)
        : undefined,
    );
    const res = await svc.fetch('accounts', [A.accountId], { expand: ['opportunities'] });
    const opps = (res.rows[0]?.opportunities ?? []) as Array<Record<string, unknown>>;
    expect(opps.map((o) => String(o.id))).toEqual([A.oppId]);
  });

  it('FAIL-CLOSED: a traversed relation with NO scope coverage REFUSES (invariant #3)', async () => {
    // scope covers opportunities (the root) but NOT accounts (the expand target), and
    // accounts is not declared TENANT_GLOBAL → expanding it is a coverage gap → refuse.
    const svc = scoped((entity) =>
      entity === 'opportunities'
        ? ({ on: 'id', op: 'eq', value: A.oppId } as FilterExpression)
        : undefined,
    );
    await expect(svc.fetch('opportunities', [A.oppId], { expand: ['account'] })).rejects.toThrow(
      'Expand scope',
    );
  });

  it('TENANT_GLOBAL: an uncovered relation declared global reads unscoped (no refusal)', async () => {
    // Same uncovered-accounts scope, but accounts is declared TENANT_GLOBAL → allowed
    // to read unscoped, so the expand hydrates instead of refusing.
    const svc = scoped(
      (entity) =>
        entity === 'opportunities'
          ? ({ on: 'id', op: 'eq', value: A.oppId } as FilterExpression)
          : undefined,
      ['accounts'],
    );
    const res = await svc.fetch('opportunities', [A.oppId], { expand: ['account'] });
    expect((res.rows[0]?.account as Record<string, unknown> | null)?.name).toBe(A.accountName);
  });
});
