// SCOPE IS MANDATORY + FAIL-CLOSED — the gate for the tenancy fix (the cross-tenant
// leak: an unscoped surface returned every org's rows). Two parts:
//
//   PART A — the new CONTRACT, pinned:
//     • `scope` is REQUIRED — constructing without it THROWS (no silent unscoped default).
//     • a real resolver returning undefined for the QUERIED/FETCHED ROOT entity (not declared
//       TENANT_GLOBAL) is a coverage gap → REFUSE (invariant #3, now total — was fail-OPEN at root).
//     • UNSCOPED is an explicit, first-class mode (single-tenant / BI / admin) — reads everything,
//       on purpose; never reachable by omission.
//     • a root declared TENANT_GLOBAL reads unscoped without refusal.
//
//   PART B — a MULTI-TENANT STRESS FALSIFIER. Beanmaxx is single-org, so we partition it by
//     ACCOUNT into pseudo-tenants A and B, bind a per-entity scope to A, and hunt for ANY B row
//     leaking through every read path (select / fetch / expand / measure). Ground-truthed by raw
//     SQL via the same pool. (Honest limit noted at the end: beanmaxx's FKs are account-coherent,
//     so this validates the root/expand/aggregate folds but cannot falsify the ADR-0028
//     traversed-JOIN gap — that needs a synthetic cross-tenant-FK row.)
//
//   DBURL=postgres://postgres:password@localhost:54321/dealbrain \
//     bun test src/characterization/__tests__/scope-mandatory.char.eval.spec.ts

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { POC_ACTOR_USER_ID } from '../../adapters/drizzle/eav/field-map.ts';
import { loadDealbrainModel } from '../../adapters/reference/model.dealbrain.ts';
import type { EntityName, FilterExpression } from '../../internal/language/types.ts';
import {
  QueryApplicationService,
  type ScopeResolver,
  UNSCOPED,
} from '../../query.application-service.ts';
import { DEALBRAIN_ORG, type QuerySurfaceHarness, makeQuerySurface } from '../harness.ts';

const DBURL = process.env.DBURL;
const suite = DBURL ? describe : describe.skip;

suite('scope mandatory + fail-closed (characterization)', () => {
  let h: QuerySurfaceHarness;
  beforeAll(() => {
    h = makeQuerySurface(DBURL!);
  });
  afterAll(async () => {
    await h.close();
  });

  const truth = async (q: string) =>
    (await h.db.execute(sql.raw(q))).rows as Record<string, unknown>[];
  const num = (v: unknown) => Number(v);

  const svc = (scope: ScopeResolver | typeof UNSCOPED, withModel = false) =>
    new QueryApplicationService(h.db, {
      actorUserId: POC_ACTOR_USER_ID,
      actorOrganizationId: DEALBRAIN_ORG,
      scope,
      ...(withModel ? { aggregateModel: () => loadDealbrainModel(h.db) } : {}),
    });

  // ========================================================================
  // PART A — the contract
  // ========================================================================

  it('A1 constructing WITHOUT a scope decision THROWS (no silent unscoped default)', () => {
    expect(
      () =>
        new QueryApplicationService(h.db, {
          actorUserId: POC_ACTOR_USER_ID,
          actorOrganizationId: DEALBRAIN_ORG,
        } as never),
    ).toThrow(/scope.*required/i);
  });

  it('A2 query ROOT uncovered by the resolver (not TENANT_GLOBAL) → REFUSE (invariant #3 at root)', async () => {
    // resolver covers only `accounts`; querying `observations` (root) → coverage gap → refuse.
    const s = svc((e) =>
      e === 'accounts' ? ({ on: 'id', op: 'is_not_null' } as FilterExpression) : undefined,
    );
    await expect(s.select('observations', { page: { limit: 10 } })).rejects.toThrow(/Scope:/);
  });

  it('A3 fetch ROOT uncovered → REFUSE (never read it unscoped)', async () => {
    const s = svc((e) =>
      e === 'accounts' ? ({ on: 'id', op: 'is_not_null' } as FilterExpression) : undefined,
    );
    await expect(s.fetch('observations', ['00000000-0000-0000-0000-000000000000'])).rejects.toThrow(
      /Scope:/,
    );
  });

  it('A4 UNSCOPED is explicit + reads EVERYTHING (first-class BI/admin/single-tenant mode)', async () => {
    const s = svc(UNSCOPED);
    const res = await s.select('observations', { page: { limit: 100000 } });
    const all = await truth('select count(*)::int n from observations');
    expect(res.total).toBe(num(all[0]!.n)); // the whole table, on purpose
  });

  it('A5 a root declared TENANT_GLOBAL reads unscoped without refusal', async () => {
    const s = new QueryApplicationService(h.db, {
      actorUserId: POC_ACTOR_USER_ID,
      actorOrganizationId: DEALBRAIN_ORG,
      scope: () => undefined, // covers nothing…
      tenantGlobalEntities: ['observations'], // …but observations is declared global
    });
    const res = await s.select('observations', { page: { limit: 100000 } });
    const all = await truth('select count(*)::int n from observations');
    expect(res.total).toBe(num(all[0]!.n));
  });

  // ========================================================================
  // PART B — multi-tenant stress falsifier (partition beanmaxx by account)
  // ========================================================================

  let A: string;
  let B: string;
  let aObs: number;
  beforeAll(async () => {
    const rows = await truth(
      'select account_id, count(*) n from observations where account_id is not null ' +
        'group by 1 order by 2 desc limit 2',
    );
    A = String(rows[0]!.account_id);
    B = String(rows[1]!.account_id);
    aObs = num(rows[0]!.n);
    expect(A).not.toBe(B);
  });

  // Per-entity tenancy scope to pseudo-tenant A across the entities these tests touch.
  const tenantA: ScopeResolver = (entity: EntityName) => {
    if (entity === 'observations' || entity === 'opportunities')
      return { on: 'account_id', op: 'eq', value: A } as FilterExpression;
    if (entity === 'accounts') return { on: 'id', op: 'eq', value: A } as FilterExpression;
    return undefined; // untouched entities — a touch would (correctly) refuse
  };

  it('S1 select(observations) under tenant A → EXACTLY A’s rows, never B’s', async () => {
    const res = await svc(tenantA).select('observations', { page: { limit: 100000 } });
    const aTruth = await truth(`select count(*)::int n from observations where account_id = '${A}'`);
    const full = await truth('select count(*)::int n from observations');
    expect(res.total).toBe(num(aTruth[0]!.n)); // exactly A's population
    expect(res.total).toBeLessThan(num(full[0]!.n)); // genuinely narrowed (not the whole table)
    expect(res.total).toBe(aObs);
  });

  it('S2 fetch() a MIX of A + B ids under tenant A → only A survives (B dropped)', async () => {
    const aIds = (
      await truth(`select id from observations where account_id = '${A}' order by id limit 3`)
    ).map((r) => String(r.id));
    const bIds = (
      await truth(`select id from observations where account_id = '${B}' order by id limit 3`)
    ).map((r) => String(r.id));
    const res = await svc(tenantA).fetch('observations', [...aIds, ...bIds]);
    const got = new Set(res.rows.map((r) => String(r.id)));
    for (const id of aIds) expect(got.has(id)).toBe(true); // A kept
    for (const id of bIds) expect(got.has(id)).toBe(false); // B leaked? — must NOT
    expect(res.rows.length).toBe(aIds.length);
  });

  it('S3 expand (has_many) folds scope: accounts[A].opportunities are A-only, no B child leaks', async () => {
    const res = await svc(tenantA).fetch('accounts', [A], { expand: ['opportunities'] });
    const opps = (res.rows[0]?.opportunities ?? []) as Array<Record<string, unknown>>;
    const gotOppIds = opps.map((o) => String(o.id));
    const bOppIds = new Set(
      (await truth(`select id from opportunities where account_id = '${B}'`)).map((r) =>
        String(r.id),
      ),
    );
    expect(gotOppIds.length).toBeGreaterThan(0);
    for (const id of gotOppIds) expect(bOppIds.has(id)).toBe(false); // no B opportunity attached
  });

  it('S4 measure(observations by type) under tenant A == A-only truth (scoped aggregate)', async () => {
    const res = await svc(tenantA, true).measure('observations', {
      group_by: ['type'],
      measures: [{ on: '*', agg: 'count', as: 'n' }],
    });
    const got = Object.fromEntries(res.rows.map((r) => [r.type, num(r.n)]));
    const ref = await truth(
      `select type, count(*)::int n from observations where account_id = '${A}' group by 1`,
    );
    for (const r of ref) expect(got[r.type as string]).toBe(num(r.n)); // every group == A-only count
    const total = (Object.values(got) as number[]).reduce((a, b) => a + b, 0);
    expect(total).toBe(aObs); // sum across groups == A's population, no B rows folded in
  });

  // HONEST LIMIT: the traversed-JOIN gap (ADR-0028 invariant-#3 residual on query()'s to-one
  // join ON / cross-grain cohort) cannot be falsified here — beanmaxx's FKs are account-coherent
  // (an A-account observation's opportunity is an A opportunity), so no cross-tenant link exists to
  // leak. Structurally closing + testing that path needs a SYNTHETIC cross-tenant-FK row (the same
  // asymmetric-fixture theme as ADR-0028). Documented, not silently skipped.
});
