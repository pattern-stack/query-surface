// B1 falsifiers: scope is folded PRE-aggregation, PER source CTE, and is
// non-bypassable — proven against live dealbrain data (the engine path AND the
// QueryApplicationService.aggregate() public path).
//
//   DBURL=postgres://postgres:PW@localhost:54321/dealbrain bun test aggregate-scope.eval

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { TENANT_GLOBAL } from '../../../../internal/analytics/types';
import type { ScopeFor } from '../../../../internal/analytics/types';
import { QueryApplicationService } from '../../../../query.application-service';
import { type DealbrainModel, loadDealbrainModel } from '../../../reference/model.dealbrain';
import { type DrizzleDb, makeDb } from '../drizzle-db';
import { aggregate, runAggregateDrizzle } from '../run-drizzle';

const DBURL = process.env.DBURL;
const suite = DBURL ? describe : describe.skip;
// Bean Maxx: the `weighted_amount` measure resolves via eavByKey('ExpectedRevenue')
// (see model.dealbrain.ts) — key the truth-SQL the SAME way the engine does, not on a
// (now-absent) display label.
const WA = `(select id from field_definitions where entity_type='opportunity' and key='ExpectedRevenue')`;

// Tenancy stand-in for the dealbrain test tables (no real user/org column): an
// ordinary observations column used AS the scope predicate, so the MECHANIC
// (scope → per-source pre-agg WHERE) is provable on real data. Non-observations
// sources are EXPLICITLY declared TENANT_GLOBAL — the fail-closed contract refuses
// a source the resolver returns undefined for (see S7).
const obsScope: ScopeFor = (s) =>
  s === 'observations' ? { on: 'type', op: 'eq', value: 'commitment' } : TENANT_GLOBAL;

suite('aggregate scope — pre-aggregation, per-source, non-bypassable (live dealbrain)', () => {
  let db: DrizzleDb;
  let close: () => Promise<void>;
  let model: DealbrainModel;
  const truth = async (text: string) =>
    (await db.execute(sql.raw(text))).rows as Record<string, unknown>[];
  const num = (v: unknown) => Number(v);

  beforeAll(async () => {
    ({ db, close } = makeDb(DBURL!));
    model = await loadDealbrainModel(db);
  });
  afterAll(async () => {
    await close?.();
  });

  it('S1 scope folds PRE-aggregation: scoped == pre-filtered truth, ≠ unscoped', async () => {
    const q = { entity: 'observations', measures: [{ on: '*', agg: 'count' as const, as: 'n' }] };
    const scoped = await runAggregateDrizzle(db, model, q, obsScope);
    const unscoped = await runAggregateDrizzle(db, model, q);
    const ref = await truth(`select count(*)::int n from observations where type='commitment'`);
    const all = await truth('select count(*)::int n from observations');
    expect(num(scoped.rows[0]!.n)).toBe(num(ref[0]!.n)); // pre-agg WHERE applied
    expect(num(unscoped.rows[0]!.n)).toBe(num(all[0]!.n));
    expect(num(ref[0]!.n)).toBeLessThan(num(all[0]!.n)); // the predicate genuinely narrows
  });

  it('S2 multi-source: each source scoped INDEPENDENTLY (obs scoped, opps whitelisted)', async () => {
    const res = await runAggregateDrizzle(
      db,
      model,
      {
        entity: 'opportunities',
        group_by: ['account_id'],
        measures: [
          { on: 'weighted_amount', agg: 'sum' as const, as: 'weighted' },
          { source: 'observations', on: '*', agg: 'count' as const, as: 'obs' },
        ],
      },
      obsScope,
    );
    expect(res.plan.needsCte).toBe(true);
    // Each source CTE groups by account_id then full-outer-joins, so summing a
    // measure across result rows == that source's total under ITS OWN scope.
    const sumObs = res.rows.reduce((a, r) => a + num(r.obs), 0);
    const sumW = res.rows.reduce((a, r) => a + num(r.weighted), 0);
    const refObs = await truth(`select count(*)::int n from observations where type='commitment'`);
    const refW = await truth(
      `select sum(value_number) s from field_values where field_definition_id=${WA}`,
    );
    expect(sumObs).toBe(num(refObs[0]!.n)); // observations CTE got the scope
    expect(num(sumW)).toBeCloseTo(num(refW[0]!.s), 2); // opportunities CTE did NOT (whitelisted → undefined)
  });

  it('S3 scope on an ABSENT column HARD-THROWS (no silent cross-tenant leak)', async () => {
    const badScope: ScopeFor = () => ({ on: 'nonexistent_col', op: 'eq', value: 'x' });
    expect(
      runAggregateDrizzle(
        db,
        model,
        { entity: 'observations', measures: [{ on: '*', agg: 'count', as: 'n' }] },
        badScope,
      ),
    ).rejects.toThrow(/unknown column/i);
  });

  it('S3b a caller FILTER on a column that resolves NOWHERE now HARD-THROWS (no silent drop)', async () => {
    // Was previously a silent soft-drop (returned the full count). We no longer answer a
    // DIFFERENT question than asked: a typo'd/unregistered filter column is a 400-mapped error
    // naming the column, not a quietly-ignored condition.
    expect(
      runAggregateDrizzle(db, model, {
        entity: 'observations',
        measures: [{ on: '*', agg: 'count', as: 'n' }],
        filter: { on: 'nonexistent_col', op: 'eq', value: 'x' },
      }),
    ).rejects.toThrow(/\[nonexistent_col\] not queryable on observations/i);
  });

  it('S3c the public aggregate() path throws the same actionable error (→ 400)', async () => {
    expect(
      aggregate(db, model, {
        entity: 'observations',
        measures: [{ on: '*', agg: 'count', as: 'n' }],
        filter: { on: 'nonexistent_col', op: 'eq', value: 'x' },
      }),
    ).rejects.toThrow(/not a registered field/i);
  });

  it('S3d a CROSS-SOURCE filter that does not conform on EVERY measure source is REJECTED (ADR-0024 §Decision.4)', async () => {
    // `type` lives on observations, not opportunities. A GLOBAL filter must mean the SAME
    // population on every measure source — silently leaving the opportunities (weighted_amount)
    // measure unfiltered would fabricate a cross-measure comparison (the Q6 landmine), so it
    // REJECTS, naming the source it can't resolve on. (Source-local intent → a measure-level
    // `where`; cross-grain intent → a conformed form like `observations.type`, a semijoin from
    // opportunities, that resolves on every source.) Supersedes the old "applies where it
    // resolves" soft-drop this slice retires.
    expect(
      runAggregateDrizzle(db, model, {
        entity: 'opportunities',
        group_by: ['account_id'],
        measures: [
          { on: 'weighted_amount', agg: 'sum', as: 'w' },
          { source: 'observations', on: '*', agg: 'count', as: 'o' },
        ],
        filter: { on: 'type', op: 'eq', value: 'commitment' },
      }),
    ).rejects.toThrow(/\[type\] not queryable on opportunities/i);
  });

  it('S4 scope is NON-BYPASSABLE: caller filter can only NARROW (intersection)', async () => {
    // scope: type=commitment, caller filter: type=risk → empty intersection.
    const res = await runAggregateDrizzle(
      db,
      model,
      {
        entity: 'observations',
        measures: [{ on: '*', agg: 'count', as: 'n' }],
        filter: { on: 'type', op: 'eq', value: 'risk' },
      },
      obsScope,
    );
    expect(num(res.rows[0]!.n)).toBe(0);
  });

  it('S5 include_sql: scope lands in WHERE BEFORE GROUP BY; absent when unscoped', async () => {
    const q = {
      entity: 'observations',
      group_by: ['account_id'],
      measures: [{ on: '*', agg: 'count' as const, as: 'n' }],
    };
    const scoped = await aggregate(db, model, q, { scopeFor: obsScope, include_sql: true });
    const plain = await aggregate(db, model, q, { include_sql: true });
    const s = scoped.sql?.toLowerCase() ?? '';
    const p = plain.sql?.toLowerCase() ?? '';
    expect(s).toContain('where');
    expect(s.indexOf('where')).toBeGreaterThan(-1);
    expect(s.indexOf('where')).toBeLessThan(s.indexOf('group by')); // pre-aggregation
    expect(p).not.toContain('where'); // unscoped, unfiltered → no WHERE at all
  });

  it('S6 service path: QueryApplicationService.aggregate() applies options.scope per source', async () => {
    const svc = new QueryApplicationService(db, {
      aggregateModel: () => loadDealbrainModel(db),
      scope: (entity) =>
        entity === 'observations' ? { on: 'type', op: 'eq', value: 'commitment' } : undefined,
    });
    const res = await svc.aggregate(
      'observations' as never,
      { measures: [{ on: '*', agg: 'count', as: 'n' }] },
      { include_sql: true },
    );
    const ref = await truth(`select count(*)::int n from observations where type='commitment'`);
    expect(num(res.rows[0]!.n)).toBe(num(ref[0]!.n));
    expect(res.sql?.toLowerCase()).toContain('where');
  });

  it('S6b service path: aggregate() without aggregateModel fails loud', async () => {
    const svc = new QueryApplicationService(db, {});
    expect(
      svc.aggregate('observations' as never, { measures: [{ on: '*', agg: 'count', as: 'n' }] }),
    ).rejects.toThrow(/aggregateModel is required/);
  });

  it('S7 FAIL-CLOSED: a source the resolver returns undefined for is REFUSED, not unscoped', async () => {
    // opportunities is neither scoped nor declared TENANT_GLOBAL → coverage gap → deny.
    const partial: ScopeFor = (s) =>
      s === 'observations' ? { on: 'type', op: 'eq', value: 'commitment' } : undefined;
    expect(
      runAggregateDrizzle(
        db,
        model,
        {
          entity: 'opportunities',
          group_by: ['account_id'],
          measures: [
            { on: 'weighted_amount', agg: 'sum', as: 'w' },
            { source: 'observations', on: '*', agg: 'count', as: 'o' },
          ],
        },
        partial,
      ),
    ).rejects.toThrow(/has no tenancy scope|tenant_global/i);
  });

  it('S8 unknown root/source entity is refused (UNKNOWN_ENTITY → 404), not malformed SQL', async () => {
    expect(
      runAggregateDrizzle(db, model, {
        entity: 'made_up_entity',
        measures: [{ on: '*', agg: 'count', as: 'n' }],
      }),
    ).rejects.toThrow(/unknown entity/i);
  });

  it('S9 hostile multi-source group_by is rejected (assertIdent), never raw-interpolated', async () => {
    expect(
      runAggregateDrizzle(db, model, {
        entity: 'opportunities',
        // would rewrite the JOIN ON clause if raw-interpolated
        group_by: ['account_id) = cte_1.account_id or (1=1'],
        measures: [
          { on: 'weighted_amount', agg: 'sum', as: 'w' },
          { source: 'observations', on: '*', agg: 'count', as: 'o' },
        ],
      }),
    ).rejects.toThrow(/unsafe identifier/i);
  });

  it('S10 service path: tenantGlobalEntities lets an uncovered source through; omission denies', async () => {
    const scope = (entity: string) =>
      entity === 'observations' ? { on: 'type', op: 'eq', value: 'commitment' } : undefined;
    const q = {
      entity: 'opportunities',
      group_by: ['account_id'],
      measures: [
        { on: 'weighted_amount', agg: 'sum' as const, as: 'w' },
        { source: 'observations', on: '*', agg: 'count' as const, as: 'o' },
      ],
    };
    // Declared global → allowed.
    const ok = new QueryApplicationService(db, {
      aggregateModel: () => loadDealbrainModel(db),
      scope: scope as never,
      tenantGlobalEntities: ['opportunities', 'accounts'] as never,
    });
    const res = await ok.aggregate('opportunities' as never, q);
    expect(res.rows.length).toBeGreaterThan(0);
    // NOT declared → denied (opportunities uncovered + not global).
    const denied = new QueryApplicationService(db, {
      aggregateModel: () => loadDealbrainModel(db),
      scope: scope as never,
    });
    expect(denied.aggregate('opportunities' as never, q)).rejects.toThrow(
      /has no tenancy scope|tenant_global/i,
    );
  });
});
