// SCOPE FOLDS THROUGH THE TO-ONE JOIN `ON` — the cross-tenant-FK falsifier.
//
// This closes the documented HONEST LIMIT of scope-mandatory.char.eval.spec.ts (its PART B note,
// ~line 184): beanmaxx's FKs are account-coherent (an A-account observation's opportunity is an A
// opportunity), so partitioning the fixture by account can falsify the ROOT / expand / per-source
// aggregate scope folds — but NOT the ADR-0028 invariant-#3 residual on the conformed-dimension
// to-one JOIN `ON` (compile-drizzle.ts lowerToOne, ~lines 319-323): scope is ANDed INTO the parent
// JOIN `ON`, so an out-of-scope parent must yield NULL columns (a de-attributed child), NEVER a
// dropped child and NEVER a leaked parent dimension. With no cross-tenant link in the data, that
// fold is asserted-by-construction, not falsified.
//
// We manufacture the missing link: ONE synthetic observation owned by tenant A whose
// `opportunity_id` points at a tenant-B opportunity (state = sB). The NOT-NULL FK columns
// (organization_id / artifact_id / observation_run_id / embedding / …) are borrowed from a real A
// observation, so only the account_id↔opportunity tenancy is deliberately crossed.
//
// Under a per-account scope bound to A, measure(observations GROUP BY opportunities.<dim>):
//   • the synthetic row PASSES the observations scope (its account_id = A) → it is in the corpus;
//   • the observations→opportunities to-one JOIN folds the OPPORTUNITIES scope (account_id = A)
//     into the `ON`; the B-opportunity fails it → its columns are NULL;
//   • so the synthetic row lands in the NULL group, and B's state value sB is NEVER attributed to
//     an A-scoped read. A NAIVE join (FK-equality only, no scope in the `ON`) WOULD count it under
//     sB — that +1 is exactly the cross-tenant leak the fold prevents.
//
//   DBURL=postgres://postgres:password@localhost:54321/dealbrain \
//     bun test src/characterization/__tests__/scope-cross-tenant-fk.char.eval.spec.ts

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { POC_ACTOR_USER_ID } from '../../adapters/drizzle/eav/field-map.ts';
import { loadDealbrainModel } from '../../adapters/reference/model.dealbrain.ts';
import type { EntityName, FilterExpression } from '../../internal/language/types.ts';
import { QueryApplicationService, type ScopeResolver } from '../../query.application-service.ts';
import { DEALBRAIN_ORG, type QuerySurfaceHarness, makeQuerySurface } from '../harness.ts';

const DBURL = process.env.DBURL;
const suite = DBURL ? describe : describe.skip;

// A fixed, greppable id so a crashed run leaves an obvious, self-cleaning sentinel (purged in
// beforeAll AND afterAll). The hex tail spells "c0fefe" — synthetic, never a real beanmaxx row.
const SENTINEL_OBS = '00000000-0000-0000-0000-0000c0fefe00';
const DIM = 'opportunities.state_of_deal_status'; // the unambiguous to-one conformed dim (C9)

suite(
  'scope folds through the to-one JOIN ON — cross-tenant-FK falsifier (characterization)',
  () => {
    let h: QuerySurfaceHarness;
    beforeAll(() => {
      h = makeQuerySurface(DBURL!);
    });
    afterAll(async () => {
      // Guarantee teardown even on a failing assertion — the dealbrain dev DB is shared.
      await h.db.execute(sql.raw(`delete from observations where id = '${SENTINEL_OBS}'`));
      await h.close();
    });

    const truth = async (q: string) =>
      (await h.db.execute(sql.raw(q))).rows as Record<string, unknown>[];
    const num = (v: unknown) => Number(v);

    const svc = (scope: ScopeResolver) =>
      new QueryApplicationService(h.db, {
        actorUserId: POC_ACTOR_USER_ID,
        actorOrganizationId: DEALBRAIN_ORG,
        scope,
        aggregateModel: () => loadDealbrainModel(h.db),
      });

    let A: string; // pseudo-tenant A (the read's tenant)
    let B: string; // pseudo-tenant B (the foreign owner the synthetic FK points to)
    let bOpp: string; // a B-owned opportunity
    let sB: string; // its state_of_deal_status — the value that must NEVER leak into an A read

    // Per-entity scope bound to pseudo-tenant A — observations + opportunities by account_id, accounts
    // by id. Any other entity is left uncovered (a touch would correctly refuse).
    const tenantA: ScopeResolver = (entity: EntityName) => {
      if (entity === 'observations' || entity === 'opportunities')
        return { on: 'account_id', op: 'eq', value: A } as FilterExpression;
      if (entity === 'accounts') return { on: 'id', op: 'eq', value: A } as FilterExpression;
      return undefined;
    };

    // The measure() count for one group value (null = the de-attributed / NULL-parent group).
    const groupCount = (rows: Record<string, unknown>[], value: string | null): number => {
      const hit = rows.find((r) => (r[DIM] ?? null) === value);
      return hit ? num(hit.n) : 0;
    };

    let baselineSB: number;
    let baselineNull: number;

    beforeAll(async () => {
      // Partition beanmaxx into pseudo-tenants A/B by the two largest observation owners.
      const accs = await truth(
        'select account_id, count(*) n from observations where account_id is not null group by 1 order by 2 desc limit 2',
      );
      A = String(accs[0]!.account_id);
      B = String(accs[1]!.account_id);
      expect(A).not.toBe(B);

      // A B-owned opportunity with a NON-NULL state — so its leaked value is distinguishable from the
      // synthetic row's NULL fall-through.
      const opp = await truth(
        `select id, state_of_deal_status from opportunities where account_id = '${B}' and state_of_deal_status is not null order by id limit 1`,
      );
      bOpp = String(opp[0]!.id);
      sB = String(opp[0]!.state_of_deal_status);

      // Baseline (PRE-insert) measure under tenant A, captured as a leak reference.
      const base = (await svc(tenantA).measure('observations', {
        group_by: [DIM],
        measures: [{ on: '*', agg: 'count', as: 'n' }],
      })) as { rows: Record<string, unknown>[] };
      baselineSB = groupCount(base.rows, sB);
      baselineNull = groupCount(base.rows, null);

      // Manufacture the cross-tenant link: a SINGLE synthetic observation, account_id = A but
      // opportunity_id = a B-owned opportunity. Borrow every other NOT-NULL / FK column from a real A
      // observation so the ONLY anomaly is the account↔opportunity tenancy crossing.
      await h.db.execute(sql.raw(`delete from observations where id = '${SENTINEL_OBS}'`)); // purge a crashed prior run
      await h.db.execute(
        sql.raw(
          `insert into observations
           (id, organization_id, account_id, opportunity_id, artifact_id, observation_run_id,
            schema_key, schema_version, type, normalized_text, source_refs, embedding,
            occurred_at, created_at, updated_at, scope)
         select '${SENTINEL_OBS}', organization_id, '${A}', '${bOpp}', artifact_id, observation_run_id,
            schema_key, schema_version, type, 'SYNTHETIC cross-tenant FK falsifier', source_refs, embedding,
            occurred_at, now(), now(), scope
         from observations
         where account_id = '${A}' and opportunity_id is not null
         order by id limit 1`,
        ),
      );
    });

    it('X0 the fixture is POTENT — the synthetic row is a real cross-tenant FK a naive join WOULD leak', async () => {
      // The synthetic A-observation links to a B-owned opportunity: the very edge beanmaxx lacks.
      const link = await truth(
        `select count(*)::int n from observations o join opportunities p on p.id = o.opportunity_id
       where o.id = '${SENTINEL_OBS}' and o.account_id = '${A}' and p.account_id = '${B}'`,
      );
      expect(num(link[0]!.n)).toBe(1); // an A-observation pointing at a B-opportunity — exists now

      // And a NAIVE (unscoped-ON) join WOULD attribute it to B's state value sB: that is the leak.
      const naiveSB = await truth(
        `select count(*)::int n from observations o join opportunities p on p.id = o.opportunity_id
       where o.account_id = '${A}' and p.state_of_deal_status = '${sB}'`,
      );
      const scopedSB = await truth(
        `select count(*)::int n from observations o
         join opportunities p on p.id = o.opportunity_id and p.account_id = '${A}'
       where o.account_id = '${A}' and p.state_of_deal_status = '${sB}'`,
      );
      expect(num(naiveSB[0]!.n)).toBe(num(scopedSB[0]!.n) + 1); // the +1 is the cross-tenant leak the ON-fold must kill
    });

    it('X1 measure(obs GROUP BY opportunities.state) under A — B’s state NEVER attributed; synthetic de-attributed to NULL', async () => {
      const res = (await svc(tenantA).measure('observations', {
        group_by: [DIM],
        measures: [{ on: '*', agg: 'count', as: 'n' }],
      })) as { rows: Record<string, unknown>[] };

      // No leak: B's state group is UNCHANGED vs baseline (the synthetic A-row did NOT join to its
      // B-opportunity — the scope folded into the JOIN ON scoped that parent out).
      expect(groupCount(res.rows, sB)).toBe(baselineSB);
      // De-attributed: the synthetic row WAS in the corpus (it passed the observations scope), but its
      // out-of-scope parent yielded NULL → it lands in the NULL group, +1 over baseline.
      expect(groupCount(res.rows, null)).toBe(baselineNull + 1);
    });

    it('X2 the engine result equals the RAW fold (scope in the JOIN ON, not the WHERE) — group-for-group, incl NULL', async () => {
      const res = (await svc(tenantA).measure('observations', {
        group_by: [DIM],
        measures: [{ on: '*', agg: 'count', as: 'n' }],
      })) as { rows: Record<string, unknown>[] };

      // Ground truth: a LEFT JOIN with the opportunities scope folded into the ON (`and p.account_id=A`)
      // — exactly what lowerToOne emits. An out-of-scope parent → NULL group, never a dropped child.
      const ref = await truth(
        `select p.state_of_deal_status as g, count(*)::int n
       from observations o
       left join opportunities p on p.id = o.opportunity_id and p.account_id = '${A}'
       where o.account_id = '${A}'
       group by 1`,
      );
      const refMap = new Map(ref.map((r) => [r.g === null ? null : String(r.g), num(r.n)]));
      const engMap = new Map(
        res.rows.map((r) => [(r[DIM] ?? null) === null ? null : String(r[DIM]), num(r.n)]),
      );
      expect(engMap).toEqual(refMap); // engine folds scope into the ON exactly like the reference
    });
  },
);
