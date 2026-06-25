// ADR-0024 wave 1 — conformed-dimension falsifier against LIVE dealbrain. Proves the
// graph-derived behavior end-to-end on real data:
//   • a to-one parent dim (account.*) is groupable/filterable via a belongs_to LEFT JOIN
//   • a cross-grain boolean filter compiles to a SEMIJOIN (EXISTS), never a fan-out join
//   • a to-many group dim is REJECTED; a diamond dim is REJECTED as ambiguous (not silently picked)
//   • tenancy scope folds THROUGH a join (fail-closed on an uncovered joined entity)
//   • the conformed-dimension set is graph-derived per source
//
//   DBURL=postgres://postgres:PW@localhost:54321/dealbrain bun test conformed-dimensions.eval

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { conformedDimensions } from '../../../../internal/analytics/join-plan';
import { TENANT_GLOBAL } from '../../../../internal/analytics/types';
import { type AggregateModel, loadDealbrainModel } from '../../../reference/model.dealbrain';
import { type DrizzleDb, makeDb } from '../drizzle-db';
import { runAggregateDrizzle } from '../run-drizzle';

const DBURL = process.env.DBURL;
const suite = DBURL ? describe : describe.skip;

suite('conformed dimensions — live dealbrain (ADR-0024 wave 1)', () => {
  let db: DrizzleDb;
  let close: () => Promise<void>;
  let model: AggregateModel;
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

  // --- to-one group_by (the showcase): opp metric grouped by a parent dim via belongs_to ---
  it('C1 group an opportunity measure by accounts.name (to-one belongs_to join) — matches truth, no fan', async () => {
    const res = await runAggregateDrizzle(
      db,
      model,
      {
        entity: 'opportunities',
        group_by: ['accounts.name'],
        measures: [{ on: '*', agg: 'count', as: 'cnt' }],
      },
      undefined,
    );
    const byName = (n: string) => res.rows.find((r) => r['accounts.name'] === n);
    // GROUND TRUTH (psql): select a.name, count(o.id) from opportunities o join accounts a
    //   on a.id=o.account_id group by a.name → Bean Maxx is 1:1 (100 accounts, 100 opps, each
    //   account owns exactly one opp) → every group is 1: Anthropic=1, Brex=1, Captions=1, ...
    expect(num(byName('Anthropic')?.cnt)).toBe(1);
    expect(num(byName('Brex')?.cnt)).toBe(1);
    expect(num(byName('Captions')?.cnt)).toBe(1);
    // NO FAN-OUT: count(*) over the LEFT JOIN counts every opp row exactly once → sum == total.
    const total = num((await truth('select count(*) as n from opportunities'))[0]?.n);
    const summed = res.rows.reduce((s, r) => s + num(r.cnt), 0);
    expect(summed).toBe(total);
    // It's a real belongs_to LEFT JOIN to accounts, not a per-source bare column.
    expect(res.sql.toLowerCase()).toContain('left join');
    expect(res.sql.toLowerCase()).toContain('accounts');
  });

  it('C2 order_by + group_count work on a conformed (joined) dimension', async () => {
    const res = await runAggregateDrizzle(db, model, {
      entity: 'opportunities',
      group_by: ['accounts.name'],
      measures: [{ on: '*', agg: 'count', as: 'cnt' }],
      order_by: [{ on: 'cnt', dir: 'desc' }],
      limit: 1,
    });
    expect(res.rows).toHaveLength(1);
    expect(num(res.rows[0]?.cnt)).toBe(1); // Bean Maxx is 1:1 → the top account has 1 opp
    // group_count = distinct accounts the opps roll up to (a NULL-account group may exist).
    const distinct = num(
      (
        await truth(
          'select count(*) as n from (select account_id from opportunities group by account_id) g',
        )
      )[0]?.n,
    );
    expect(res.group_count).toBe(distinct);
  });

  // --- to-one filter ---
  it('C3 filter an opportunity measure by accounts.name (to-one join in WHERE) — Anthropic has 1 opp', async () => {
    const res = await runAggregateDrizzle(db, model, {
      entity: 'opportunities',
      measures: [{ on: '*', agg: 'count', as: 'cnt' }],
      filter: { on: 'accounts.name', op: 'eq', value: 'Anthropic' },
    });
    // GROUND TRUTH: select count(o.id) from opportunities o join accounts a on a.id=o.account_id
    //   where a.name='Anthropic' → 1 (Bean Maxx is 1:1).
    expect(num(res.rows[0]?.cnt)).toBe(1);
  });

  // --- cross-grain boolean filter → SEMIJOIN (EXISTS), never a fan-out join ---
  it('C4 filter accounts by a child predicate (observations.type) compiles to a SEMIJOIN — 100 of 100', async () => {
    const total = num((await truth('select count(*) as n from accounts'))[0]?.n);
    expect(total).toBe(100);
    const res = await runAggregateDrizzle(db, model, {
      entity: 'accounts',
      measures: [{ on: '*', agg: 'count', as: 'cnt' }],
      filter: { on: 'observations.type', op: 'eq', value: 'risk' },
    });
    // GROUND TRUTH: 100 accounts have ≥1 'risk' observation via EXISTS (the corpus is dense — every
    // account carries risk obs). DISCRIMINATION PRESERVED: a fan-out join would over-count to 2160
    // (= total 'risk' observations: `select count(*) from observations where type='risk'`); the
    // semijoin counts each matching account exactly once (100 ≠ 2160).
    expect(num(res.rows[0]?.cnt)).toBe(100);
    expect(res.sql.toLowerCase()).toContain('exists');
    expect(res.sql.toLowerCase()).toContain('observations');
  });

  // --- rejections (clear messages, never a silent wrong number) ---
  it('C5 a to-many group dim is REJECTED (would fan out the measure)', async () => {
    expect(
      runAggregateDrizzle(db, model, {
        entity: 'opportunities',
        group_by: ['observations.type'], // opportunities → observations is has_many
        measures: [{ on: '*', agg: 'count', as: 'cnt' }],
      }),
    ).rejects.toThrow(/to-many|fan out|not conformed/i);
  });

  it('C6 a diamond dim is REJECTED as ambiguous (no silent edge-pick) — the net diamond finding', async () => {
    // observations→accounts is reachable both directly (obs.account_id) and via opportunity.
    // The retrieval path silently picks the direct (61%-null) edge; the aggregate resolver
    // refuses instead.
    expect(
      runAggregateDrizzle(db, model, {
        entity: 'observations',
        group_by: ['accounts.name'],
        measures: [{ on: '*', agg: 'count', as: 'cnt' }],
      }),
    ).rejects.toThrow(/ambiguous|diamond|distinct to-one/i);
  });

  // --- scope folds THROUGH the join (the design-hardening leak proof) ---
  it('C7 tenancy scope folds through a to-one join — fail-closed on an uncovered joined entity', async () => {
    // The opportunities measure source is whitelisted, but the JOINED accounts entity has no
    // scope answer → the engine REFUSES to read it unscoped (a join to an unscoped parent
    // would otherwise disclose parent rows the requester's scope forbids).
    expect(
      runAggregateDrizzle(
        db,
        model,
        {
          entity: 'opportunities',
          group_by: ['accounts.name'],
          measures: [{ on: '*', agg: 'count', as: 'cnt' }],
        },
        (src) => (src === 'opportunities' ? TENANT_GLOBAL : undefined),
      ),
    ).rejects.toThrow(/no tenancy scope|coverage gap|refusing/i);
  });

  it('C8 a scoped joined entity folds the predicate INTO the join ON (out-of-scope parent → excluded)', async () => {
    // Scope accounts to "name <> 'Anthropic'": the join ON gains the predicate, so Anthropic's opps
    // join to NULL and 'Anthropic' never appears as a group. Proves scope reaches the JOIN, not
    // just the source CTE.
    const res = await runAggregateDrizzle(
      db,
      model,
      {
        entity: 'opportunities',
        group_by: ['accounts.name'],
        measures: [{ on: '*', agg: 'count', as: 'cnt' }],
      },
      (src) => (src === 'accounts' ? { on: 'name', op: 'neq', value: 'Anthropic' } : TENANT_GLOBAL),
    );
    expect(res.rows.find((r) => r['accounts.name'] === 'Anthropic')).toBeUndefined();
    // a different account is unaffected
    expect(res.rows.some((r) => r['accounts.name'] === 'Brex')).toBe(true);
    // The scope is in the JOIN ON (a LEFT JOIN), NOT the source-CTE WHERE: so out-of-scope
    // parents become NULL-group rows rather than DROPPING the (in-scope) opp rows — the total
    // opp count is still conserved. (A WHERE-applied scope would drop Holman's 3 opps entirely.)
    expect(res.sql.toLowerCase()).toMatch(/left join "accounts" on .*name/);
    const total = num((await truth('select count(*) as n from opportunities'))[0]?.n);
    expect(res.rows.reduce((s, r) => s + num(r.cnt), 0)).toBe(total);
  });

  // --- the graph-derived conformed set, against the LIVE registry (incl. the diamond) ---
  it('C9 conformedDimensions is graph-derived per source on the live model', async () => {
    const opp = conformedDimensions(model.analytics, 'opportunities').map((d) => d.path);
    expect(opp).toContain('accounts.name'); // to-one parent dim
    expect(opp).toContain('state_of_deal_status'); // own dim
    expect(opp.some((p) => p.startsWith('observations.'))).toBe(false); // to-many child: excluded

    const obs = conformedDimensions(model.analytics, 'observations').map((d) => d.path);
    expect(obs).toContain('opportunities.state_of_deal_status'); // unambiguous to-one
    expect(obs.some((p) => p.startsWith('accounts.'))).toBe(false); // the diamond is excluded
  });

  // --- cross-source filter: a GLOBAL filter must conform on EVERY measure source, else REJECT
  //     (ADR-0024 §Decision.4). A leaf that resolves on one measure source but not another would
  //     silently leave THAT measure unfiltered → a fabricated cross-measure comparison (the Q6
  //     landmine). Source-local intent uses a measure-level `where`; cross-source intent uses a
  //     dimension that conforms on every source. (No silent per-source no-op.) ---
  it('C10 a cross-source filter (resolves on one measure source, not another) is REJECTED', async () => {
    // state_of_deal_status is opportunities-only — it does not resolve on the observations measure
    // source. Refuse rather than silently leave the obs measure on the full corpus.
    expect(
      runAggregateDrizzle(db, model, {
        entity: 'accounts',
        measures: [
          { source: 'opportunities', on: '*', agg: 'count', as: 'opp' },
          { source: 'observations', on: '*', agg: 'count', as: 'obs' },
        ],
        filter: { on: 'state_of_deal_status', op: 'eq', value: 'won' },
      }),
    ).rejects.toThrow(/not queryable on observations/i);
  });

  it('C11 source-local intent uses a measure-level `where` — filters ONE measure, the other stays explicitly unfiltered', async () => {
    // The (A)-world way to scope only the opp measure: a measure-level `where` (source-local by
    // design) — explicit per measure, never a global filter that silently means different things
    // per source. Ground-truthed both legs so the assertion isn't vacuous.
    const res = await runAggregateDrizzle(db, model, {
      entity: 'accounts',
      measures: [
        {
          source: 'opportunities',
          on: '*',
          agg: 'count',
          as: 'opp',
          where: { on: 'account_id', op: 'is_not_null' },
        },
        { source: 'observations', on: '*', agg: 'count', as: 'obs' },
      ],
    });
    const oppT = num(
      (await truth('select count(*) as n from opportunities where account_id is not null'))[0]?.n,
    );
    const obsT = num((await truth('select count(*) as n from observations'))[0]?.n);
    expect(num(res.rows[0]?.opp)).toBe(oppT); // opp scoped by its own where
    expect(num(res.rows[0]?.obs)).toBe(obsT); // obs explicitly unfiltered
  });

  it('C12 a CONFORMED cross-source filter (resolves to-one on every measure source) applies on ALL', async () => {
    // `opportunities.account_id` resolves LOCAL on the opp measure and TO-ONE on the obs measure
    // (observations→opportunities). It conforms on both → applied uniformly (not rejected, not
    // silently dropped). Matches the JOIN truth on both legs.
    const res = await runAggregateDrizzle(db, model, {
      entity: 'observations',
      measures: [
        { source: 'opportunities', on: '*', agg: 'count', as: 'opp' },
        { on: '*', agg: 'count', as: 'obs' },
      ],
      filter: { on: 'opportunities.account_id', op: 'is_not_null' },
    });
    const oppT = num(
      (await truth('select count(*) as n from opportunities where account_id is not null'))[0]?.n,
    );
    const obsT = num(
      (
        await truth(
          'select count(*) as n from observations o join opportunities p on p.id=o.opportunity_id where p.account_id is not null',
        )
      )[0]?.n,
    );
    expect(num(res.rows[0]?.opp)).toBe(oppT);
    expect(num(res.rows[0]?.obs)).toBe(obsT);
  });

  // --- semijoin scope folds INTO the EXISTS body (the lowerSemijoin security claim) ---
  it('C13 a semijoin folds the child scope INSIDE the EXISTS — fail-closed on an uncovered child', async () => {
    // accounts is whitelisted; the semijoin child `observations` has no scope answer → refuse
    // (an unscoped EXISTS could fabricate cross-tenant membership).
    expect(
      runAggregateDrizzle(
        db,
        model,
        {
          entity: 'accounts',
          measures: [{ on: '*', agg: 'count', as: 'cnt' }],
          filter: { on: 'observations.type', op: 'eq', value: 'risk' },
        },
        (src) => (src === 'accounts' ? TENANT_GLOBAL : undefined),
      ),
    ).rejects.toThrow(/no tenancy scope|coverage gap|refusing/i);
  });

  it('C15 a filter clean on one measure source but a DIAMOND on another is REJECTED (must conform on every source)', async () => {
    // entity=observations, measures on opportunities + observations. `accounts.name` is a clean
    // to-one from opportunities but an AMBIGUOUS diamond from observations. A global filter must
    // resolve on every measure source → REJECT (rather than apply on opp + silently no-op on the
    // obs measure, which would fabricate a cross-measure comparison). The caller uses a
    // measure-level `where`, or a dimension that conforms on both.
    expect(
      runAggregateDrizzle(db, model, {
        entity: 'observations',
        measures: [
          { source: 'opportunities', on: '*', agg: 'count', as: 'opp' },
          { on: '*', agg: 'count', as: 'obs' },
        ],
        filter: { on: 'accounts.name', op: 'eq', value: 'Holman' },
      }),
    ).rejects.toThrow(/ambiguous|diamond|distinct to-one/i);
  });

  it('C14 a scoped semijoin child ANDs the scope inside EXISTS (scope ∧ filter → empty cohort)', async () => {
    // Scope observations to type<>'risk' while filtering for type='risk' → the EXISTS body
    // becomes (type='risk' AND type<>'risk') → matches nothing → 0 accounts. Proves the scope
    // predicate lands INSIDE the correlated subquery, not in the outer WHERE.
    const res = await runAggregateDrizzle(
      db,
      model,
      {
        entity: 'accounts',
        measures: [{ on: '*', agg: 'count', as: 'cnt' }],
        filter: { on: 'observations.type', op: 'eq', value: 'risk' },
      },
      (src) => (src === 'observations' ? { on: 'type', op: 'neq', value: 'risk' } : TENANT_GLOBAL),
    );
    expect(num(res.rows[0]?.cnt)).toBe(0);
    expect(res.sql.toLowerCase()).toContain('exists');
  });
});
