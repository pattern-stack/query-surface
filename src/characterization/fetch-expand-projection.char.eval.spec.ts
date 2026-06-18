// CHARACTERIZATION NET — fetch() hydrate + expand + row projection.
//
// Pins the engine's ACTUAL behavior today (the safety gate for the upcoming
// dialect-neutral IR / QueryBackend refactor). Asserts current output AS-IS; a
// behavior that looks wrong is pinned anyway and tagged // SUSPECTED-DIVERGENCE.
//
// Three faces of this area:
//   1. fetch(entity, ids, {expand}) — hydrates flat rows (registered native
//      columns + inline EAV) and attaches expanded relations (belongs_to → child
//      object, has_many → array). Public surface (h.service.fetch).
//   2. The tenant-leak guard. NOTE the architecture: service.fetch() returns RAW
//      rows — it does NOT run projectRowDeep. The projection (the allowlist /
//      tenant-leak guard) lives one layer up, at the nest use-cases boundary
//      (FetchUseCase → projectRowDeep). So the *service* never emits
//      organization_id/user_id/provider_metadata for a DIFFERENT reason than the
//      projection: those columns are simply NOT REGISTERED Drizzle columns in the
//      dealbrain test model, so nativeSelectShape never selects them. We pin BOTH
//      guards: (a) the service-level "non-registration" floor against the live DB,
//      and (b) projectRowDeep itself (deep-imported from ../nest/projection,
//      since the service path can't reach it) as the contract that WOULD strip
//      those columns if a model registered them.
//   3. publicKeySet survives _snippet/_rank meta; an unknown entity fails closed
//      to {}.
//
// Public-surface-first (rule 2): faces 1 + 2a go through h.service.fetch. Face 2b
// + 3 reach into ../nest/projection — the pure projectRowDeep / publicKeySet /
// buildProjectionIndex unit cases genuinely can't be exercised from the public
// API (the service returns the raw shape by design; only the nest layer projects).

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { type CatalogField, type EntityCatalog, buildEntityCatalog } from '../catalog.ts';
import {
  buildProjectionIndex,
  projectRow,
  projectRowDeep,
  publicKeySet,
} from '../nest/projection.ts';
import { RANK_SCORE_KEY, RANK_SNIPPET_KEY, SNIPPETS_KEY } from '../types.ts';
import { type QuerySurfaceHarness, makeQuerySurface } from './harness.ts';

const DBURL = process.env.DBURL;
const suite = DBURL ? describe : describe.skip;

suite('fetch + expand + projection — characterization', () => {
  let h: QuerySurfaceHarness;
  beforeAll(() => {
    h = makeQuerySurface(DBURL!);
  });
  afterAll(async () => {
    await h.close();
  });

  // ground truth (rule 3): raw SQL via the SAME pool.
  const truth = async (q: string) =>
    (await h.db.execute(sql.raw(q))).rows as Record<string, unknown>[];

  // ==========================================================================
  // FACE 1 — fetch() hydrate + expand (public surface)
  // ==========================================================================

  describe('fetch() hydrates flat rows of registered native columns', () => {
    it('returns one row per id with the registered observation columns, ground-truthed', async () => {
      // TRUTH: pick 2 observations that have BOTH a non-null account + opportunity.
      const t = await truth(
        `select id, type, account_id, opportunity_id, occurred_at
           from observations
          where account_id is not null and opportunity_id is not null
          order by id limit 2`,
      );
      const ids = t.map((r) => String(r.id));
      expect(ids.length).toBe(2);

      const res = await h.service.fetch('observations', ids);
      expect(res.entity).toBe('observations');
      expect(res.count).toBe(2);
      expect(res.rows.length).toBe(2);
      expect(res.rows.map((r) => String(r.id)).sort()).toEqual([...ids].sort());

      // The flat row carries ONLY the registered Drizzle columns of observationsExt
      // (schema.dealbrain cols + embedding/normalized_text). This is the actual
      // wire shape today.
      const byId = new Map(res.rows.map((r) => [String(r.id), r]));
      for (const tr of t) {
        const row = byId.get(String(tr.id))!;
        expect(row.type).toBe(tr.type);
        expect(String(row.account_id)).toBe(String(tr.account_id));
        expect(String(row.opportunity_id)).toBe(String(tr.opportunity_id));
        // structured_data (jsonb) and the registered text/vector columns hydrate.
        expect(row).toHaveProperty('structured_data');
        expect(row).toHaveProperty('occurred_at');
      }
    });

    it('pins the exact flat key set on a fetched observation row (the wire contract)', async () => {
      const t = await truth(
        `select id from observations
          where account_id is not null and opportunity_id is not null
          order by id limit 1`,
      );
      const id = String(t[0].id);
      const res = await h.service.fetch('observations', [id]);
      const keys = Object.keys(res.rows[0]).sort();
      // EXACT: the registered observationsExt columns, snake_cased. NB this
      // includes `embedding` (the raw 1536-dim pgvector) and `normalized_text`.
      // SUSPECTED-DIVERGENCE: a raw fetch ships the full embedding vector + full
      // normalized_text body inline — heavy and arguably not consumer-facing — but
      // this is current behavior (the service returns the raw registered shape; the
      // nest projection layer, not the service, is where curation happens). — revisit
      expect(keys).toEqual(
        [
          'account_id',
          'embedding',
          'id',
          'normalized_text',
          'occurred_at',
          'opportunity_id',
          'structured_data',
          'type',
        ].sort(),
      );
    });

    it('returns count 0 + empty rows for an empty / unknown id list', async () => {
      const res = await h.service.fetch('observations', ['00000000-0000-0000-0000-000000000000']);
      expect(res.count).toBe(0);
      expect(res.rows).toEqual([]);
    });
  });

  describe('fetch({expand}) attaches relations', () => {
    it('belongs_to → a child object projected to the TARGET registered columns', async () => {
      // TRUTH: an observation + its account name.
      const t = await truth(
        `select o.id as oid, o.account_id, a.name as account_name
           from observations o join accounts a on a.id = o.account_id
          order by o.id limit 1`,
      );
      const oid = String(t[0].oid);

      const res = await h.service.fetch('observations', [oid], { expand: ['account'] });
      const row = res.rows[0];
      const account = row.account as Record<string, unknown>;
      expect(account).toBeTruthy();
      expect(String(account.id)).toBe(String(t[0].account_id));
      expect(account.name).toBe(t[0].account_name);
      // The accounts table is registered with ONLY {id, name} (schema.dealbrain),
      // so website / organization_id / user_id / provider_metadata — which DO
      // exist on the live accounts table — are absent from the expanded child by
      // virtue of NON-REGISTRATION (the service-level floor; see the projectRowDeep
      // cases for the second, allowlist guard).
      expect(Object.keys(account).sort()).toEqual(['id', 'name']);
    });

    it('SERVICE-LEVEL tenant-leak floor: live tenant columns are absent because they are unregistered', async () => {
      // TRUTH: the live accounts row DOES carry organization_id / user_id /
      // website / provider_metadata.
      const t = await truth(
        `select o.id as oid, a.id as aid, a.organization_id, a.user_id, a.website
           from observations o join accounts a on a.id = o.account_id
          where a.organization_id is not null
          order by o.id limit 1`,
      );
      expect(t[0].organization_id).toBeTruthy(); // they EXIST in the DB
      expect(t[0].user_id).toBeTruthy();

      const res = await h.service.fetch('observations', [String(t[0].oid)], {
        expand: ['account'],
      });
      const account = res.rows[0].account as Record<string, unknown>;
      // …yet none of them survive onto the expanded child.
      expect(account.organization_id).toBeUndefined();
      expect(account.user_id).toBeUndefined();
      expect(account.website).toBeUndefined();
      expect(account.provider_metadata).toBeUndefined();
    });

    it('belongs_to → opportunity carries inline EAV fields (is_visible-gated keys)', async () => {
      const t = await truth(
        `select o.id as oid, o.opportunity_id
           from observations o
          where o.opportunity_id is not null
          order by o.id limit 1`,
      );
      const res = await h.service.fetch('observations', [String(t[0].oid)], {
        expand: ['opportunity'],
      });
      const opp = res.rows[0].opportunity as Record<string, unknown>;
      expect(String(opp.id)).toBe(String(t[0].opportunity_id));
      // EAV keys merge inline (the is_visible=true curated set on query/fetch).
      // `amount` is the canonical curated EAV key (15-key gated set). Ground-truth
      // its value from field_values.
      const av = await truth(
        `select fv.value_number as amount
           from field_values fv
           join field_definitions fd on fd.id = fv.field_definition_id
          where fv.entity_id = '${String(t[0].opportunity_id)}'
            and fv.entity_type = 'opportunity'
            and fd.key = 'amount' limit 1`,
      );
      if (av.length > 0 && av[0].amount != null) {
        expect(Number(opp.amount)).toBe(Number(av[0].amount));
      }
      // dealname is an is_visible curated EAV key → present.
      expect(opp).toHaveProperty('dealname');
    });

    it('has_many → an array of child rows, count ground-truthed', async () => {
      // TRUTH: an account and its observation count.
      const t = await truth(
        `select a.id as aid, count(o.*)::int as n
           from accounts a join observations o on o.account_id = a.id
          group by a.id order by a.id limit 1`,
      );
      const aid = String(t[0].aid);
      const n = Number(t[0].n);

      const res = await h.service.fetch('accounts', [aid], { expand: ['observations'] });
      const obs = res.rows[0].observations as Array<Record<string, unknown>>;
      expect(Array.isArray(obs)).toBe(true);
      expect(obs.length).toBe(n);
      // Each child is the registered observationsExt shape (snake-cased).
      expect(obs[0]).toHaveProperty('type');
      expect(obs[0]).toHaveProperty('account_id');
    });

    it('nested expand: observation → opportunity.account (recursive belongs_to)', async () => {
      const t = await truth(
        `select o.id as oid, o.opportunity_id, op.account_id, a.name as account_name
           from observations o
           join opportunities op on op.id = o.opportunity_id
           join accounts a on a.id = op.account_id
          where o.opportunity_id is not null and op.account_id is not null
          order by o.id limit 1`,
      );
      const res = await h.service.fetch('observations', [String(t[0].oid)], {
        expand: ['opportunity.account'],
      });
      const opp = res.rows[0].opportunity as Record<string, unknown>;
      const acct = opp.account as Record<string, unknown>;
      expect(String(acct.id)).toBe(String(t[0].account_id));
      expect(acct.name).toBe(t[0].account_name);
    });

    it('an invalid expand path throws (relationship not on the entity)', async () => {
      const t = await truth(`select id from observations order by id limit 1`);
      await expect(
        h.service.fetch('observations', [String(t[0].id)], { expand: ['not_a_relation'] }),
      ).rejects.toThrow(/Expand path 'not_a_relation' invalid/);
    });
  });

  // ==========================================================================
  // FACE 2b — projectRowDeep: the allowlist / tenant-leak guard (deep-imported)
  //   The public service returns the raw shape by design (FetchUseCase, the nest
  //   layer, is what projects). So these pin projectRowDeep directly, but built
  //   from the SAME catalogs the harness's registry produces (buildEntityCatalog),
  //   not synthetic stubs — so the index reflects the real dealbrain shape.
  // ==========================================================================

  describe('projectRowDeep (nest layer) — the tenant-leak guard', () => {
    // Built in beforeAll: buildEntityCatalog reads the MODULE-GLOBAL registry,
    // which makeQuerySurface (the outer beforeAll) configures — so catalog
    // construction must NOT run at describe-body eval time (registry still empty).
    let indexOpen: ReturnType<typeof buildProjectionIndex>;
    let indexAllow: ReturnType<typeof buildProjectionIndex>;
    beforeAll(() => {
      // Real catalogs from the harness's registered entities.
      const catalogs: EntityCatalog[] = [
        buildEntityCatalog('observations'),
        buildEntityCatalog('opportunities'),
        buildEntityCatalog('accounts'),
      ];
      // With NO exposeColumns, native columns pass through (facet-trim only) — pins
      // the default (no-allowlist) behavior. accounts is registered as {id,name}.
      indexOpen = buildProjectionIndex(catalogs);
      // With an exposeColumns allowlist, only listed native cols (+ EAV + id) survive.
      indexAllow = buildProjectionIndex(catalogs, {
        observations: ['id', 'type'],
        accounts: ['id'],
        opportunities: ['id'],
      });
    });

    it('open (no allowlist): drops nothing native — every registered column survives', () => {
      const row = { id: 'o1', type: 'discovery', account_id: 'a1', opportunity_id: 'p1' };
      const out = projectRowDeep(row, 'observations', indexOpen);
      // SUSPECTED-DIVERGENCE: with no exposeColumns, projectRowDeep is a pass-through
      // for native columns — the tenant-leak guard is INERT until the host supplies
      // an allowlist. account_id/opportunity_id (FKs) survive. This is current
      // intended behavior (host opts in), but it means the guard does NOT
      // fail-closed on a forgotten allowlist. — revisit
      expect(out).toEqual(row);
    });

    it('with allowlist: drops native columns not on the list, keeps id + listed', () => {
      const row = { id: 'o1', type: 'discovery', account_id: 'a1', opportunity_id: 'p1' };
      const out = projectRowDeep(row, 'observations', indexAllow);
      expect(out).toEqual({ id: 'o1', type: 'discovery' });
      expect(out.account_id).toBeUndefined();
    });

    it('projects a belongs_to child against the TARGET allowlist (no tenant/metadata leak)', () => {
      // Synthesize a child that DOES carry the forbidden columns (as if a model
      // registered them) to prove the guard would strip them.
      const row = {
        id: 'o1',
        type: 'discovery',
        account: {
          id: 'a1',
          name: 'Acme',
          organization_id: 'org1',
          user_id: 'u1',
          provider_metadata: { vendor: 'hubspot' },
        },
      };
      const out = projectRowDeep(row, 'observations', indexAllow);
      const account = out.account as Record<string, unknown>;
      // accounts allowlist = ['id'] → only id survives; name (not listed) + the
      // tenant FKs + provider_metadata are all dropped against the TARGET's rule.
      expect(account).toEqual({ id: 'a1' });
      expect(account.organization_id).toBeUndefined();
      expect(account.user_id).toBeUndefined();
      expect(account.provider_metadata).toBeUndefined();
    });

    it('projects every entry of a has_many array against the target allowlist', () => {
      const row = {
        id: 'a1',
        observations: [
          { id: 'o1', type: 'discovery', organization_id: 'org1' },
          { id: 'o2', type: 'risk', organization_id: 'org1' },
        ],
      };
      const out = projectRowDeep(row, 'accounts', indexAllow);
      // observations allowlist = ['id','type'] → organization_id stripped on each.
      expect(out.observations).toEqual([
        { id: 'o1', type: 'discovery' },
        { id: 'o2', type: 'risk' },
      ]);
    });

    it('passes a null relation value through untouched', () => {
      const out = projectRowDeep({ id: 'o1', account: null }, 'observations', indexAllow);
      expect(out).toEqual({ id: 'o1', account: null });
    });

    it('fails closed: an unknown entity drops to {}', () => {
      const out = projectRowDeep({ id: 'x', secret: 'leak' }, 'not_a_real_entity', indexAllow);
      expect(out).toEqual({});
    });

    it('END-TO-END: project the REAL raw fetch row → tenant-safe, ids ground-truthed', async () => {
      // Pull a real raw row from the service, then run it through the nest-layer
      // projection the FetchUseCase would apply. Confirms the two stages compose:
      // raw fetch (service) → projectRowDeep (nest).
      const t = await truth(
        `select o.id as oid, a.name as account_name
           from observations o join accounts a on a.id = o.account_id
          order by o.id limit 1`,
      );
      const oid = String(t[0].oid);
      const res = await h.service.fetch('observations', [oid], { expand: ['account'] });
      const projected = projectRowDeep(res.rows[0], 'observations', indexAllow);
      // allowlist observations:['id','type'] → embedding/normalized_text/FKs dropped.
      expect(Object.keys(projected).sort()).toEqual(['account', 'id', 'type'].sort());
      const account = projected.account as Record<string, unknown>;
      expect(account).toEqual({ id: String((res.rows[0].account as Record<string, unknown>).id) });
      expect(account.name).toBeUndefined(); // accounts:['id'] → name dropped
    });
  });

  // ==========================================================================
  // FACE 3 — publicKeySet: rank/snippet meta survival
  // ==========================================================================

  describe('publicKeySet — _snippet/_rank meta survives projection', () => {
    it('always includes the rank + snippet virtual keys', () => {
      const cat = buildEntityCatalog('observations');
      const keys = publicKeySet(cat); // no exposeColumns → open
      expect(keys.has(SNIPPETS_KEY)).toBe(true);
      expect(keys.has(RANK_SCORE_KEY)).toBe(true);
      expect(keys.has(RANK_SNIPPET_KEY)).toBe(true);
    });

    it('survives even under an allowlist that lists none of them', () => {
      const cat = buildEntityCatalog('observations');
      const keys = publicKeySet(cat, { observations: ['id'] });
      // The 3 virtual keys are added UNCONDITIONALLY, independent of exposeColumns.
      expect(keys.has(SNIPPETS_KEY)).toBe(true);
      expect(keys.has(RANK_SCORE_KEY)).toBe(true);
      expect(keys.has(RANK_SNIPPET_KEY)).toBe(true);
      // projectRow keeps a _rank that a preview row carries.
      const out = projectRow({ id: 'o1', type: 'discovery', [RANK_SCORE_KEY]: 0.87 }, keys);
      expect(out[RANK_SCORE_KEY]).toBe(0.87);
      expect(out.type).toBeUndefined(); // not allow-listed
      expect(out.id).toBe('o1');
    });

    it('relationship names survive (so an expanded relation is not stripped)', () => {
      const cat = buildEntityCatalog('observations');
      const keys = publicKeySet(cat, { observations: ['id'] });
      // observations has belongs_to opportunity + account.
      expect(keys.has('opportunity')).toBe(true);
      expect(keys.has('account')).toBe(true);
    });
  });

  // ==========================================================================
  // Catalog-shape note pinned as a guard (NOT the area focus, but load-bearing
  // for projection: the catalog feeds the allowlist + key set).
  // ==========================================================================

  describe('catalog shape that drives projection (pinned)', () => {
    it('observations catalog exposes the registered native fields + an enableRLS artifact', () => {
      const cat = buildEntityCatalog('observations');
      const fieldKeys = cat.fields.map((f: CatalogField) => f.key);
      // SUSPECTED-DIVERGENCE: `enableRLS` (a Drizzle table-builder internal, not a
      // real column) leaks into the field catalog as a field key. It is harmless
      // in practice (no such row key exists, so projection never emits it), but it
      // pollutes describe() and any allowlist derived from the catalog. — revisit
      expect(fieldKeys).toContain('enableRLS');
      // The genuinely registered columns are all present.
      for (const k of [
        'id',
        'type',
        'account_id',
        'opportunity_id',
        'embedding',
        'normalized_text',
      ]) {
        expect(fieldKeys).toContain(k);
      }
    });
  });
});
