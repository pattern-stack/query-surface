// CHARACTERIZATION NET — RELEVANCE-AS-FILTER on query() / fetch() (Wave-2, ADR-0024 §A/Amend 2).
//
// Pins what the `op:'relevant'` predicate leaf does TODAY on the retrieval surface — the
// semantic-match-as-a-Predicate-leaf path (hard rule #9: ONE expression language, no second
// filter dialect). The service defuzzifies `relevant` → a crisp `sim_gte` (threshold) | `sim_topk`
// (ranked cohort) BEFORE compile, embedding the `query` once via the injected embed() port, then
// the retrieval compiler lowers each crisp leaf:
//   • SAME-GRAIN threshold → (1 - (embedding <=> q::vector)) >= cutoff  (a plain boolean WHERE).
//   • SAME-GRAIN top_k     → pk in (select pk … order by sim desc, pk asc limit k)  (membership,
//     NEVER a fan-inducing join — invariant #2; pk ASC = deterministic cutoff tiebreak).
//   • CROSS-GRAIN (a relevant leaf whose `on` is a has_many dotted path, accounts ⇒
//     observations.normalized_text) → an EXISTS semijoin over the child, ranking/cutting the
//     CHILD (invariant #2 — never a fan-out join). With no group_by/per the top_k cohort is GLOBAL
//     (ruling a: the k most-relevant child rows overall, then "does this parent own one?").
//   • CITATION — MANDATORY whenever a relevant leaf fires: a row-grain companion scan over the
//     semantic entity yields cutoff / match_count / exemplars(id,sim) / boundary, reusing the
//     already-resolved vector (NO second embed). highest_excluded is ON-REQUEST (citation.boundary).
//   • The XOR landmine — EXACTLY ONE of threshold|top_k (neither/both both REJECT, no silent
//     default), the same fail-closed discipline as conform-on-every-source.
//
// Asserted through the PUBLIC surface (QueryApplicationService via the shared harness). DETERMINISM
// (the fixture is non-hermetic — hard-coded counts drift): the harness embed() stub ILIKE-resolves
// a phrase to ONE real stored observation embedding (`order by id limit 1`); EVERY expected value is
// recomputed from THAT SAME anchor vector via raw SQL through the SAME pool AT TEST TIME. The anchor
// phrase resolves to the first pricing_signal observation; similarity = 1 - (embedding <=> q::vector)
// ∈ [0,1] (the EXACT simExpr the engine emits). NEVER SELECT DISTINCT over the vector(1536) column.
//
// Run WITH the DB:
//   DBURL=postgres://postgres:password@localhost:54321/dealbrain \
//     bun test src/characterization/__tests__/relevant-filter.char.eval.spec.ts

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { POC_ACTOR_USER_ID } from '../../adapters/drizzle/eav/field-map.ts';
import { loadDealbrainModel } from '../../adapters/reference/model.dealbrain.ts';
import { QueryApplicationService, UNSCOPED } from '../../query.application-service.ts';
import { DEALBRAIN_ORG, type QuerySurfaceHarness, makeQuerySurface } from '../harness.ts';

const DBURL = process.env.DBURL;
const suite = DBURL ? describe : describe.skip;

// The deterministic anchor: a distinctive phrase from the first pricing_signal observation. The
// harness embed() stub resolves it (ILIKE %phrase%, order by id limit 1) to ONE stored embedding;
// the same lookup gives us the ground-truth vector. Live-verified sweep on this anchor (as first
// recorded — the live fixture drifts, e.g. 0.5 → 1344 on 2026-09-20):
//   sim>=0.4 → 5349, 0.5 → 1345, 0.6 → 178, 0.7 → 5.
const ANCHOR = 'conditional, not-yet-agreed concession off the';

suite('relevance-as-filter (query/fetch) — characterization', () => {
  let h: QuerySurfaceHarness;
  beforeAll(() => {
    h = makeQuerySurface(DBURL!);
  });
  afterAll(async () => {
    await h.close();
  });

  // Ground truth (rule 3): the SAME pool. `anchorVec()` returns the literal the engine binds
  // (`[v1,v2,…]`) for the anchor embedding the stub resolves — so every expected sim/cohort is
  // computed against the EXACT vector the service embeds, not an independent re-embed.
  const truth = async <T = Record<string, unknown>>(q: string) =>
    (await h.db.execute(sql.raw(q))).rows as T[];

  // A SQL fragment that re-derives the anchor vector inside Postgres (the stub's exact lookup),
  // so ground-truth queries never have to materialize the 1536-dim literal in JS.
  const Q = `(select embedding as e from observations
              where embedding is not null and normalized_text is not null
              and normalized_text ilike '%${ANCHOR}%' order by id limit 1)`;
  const SIM = '(1 - (o.embedding <=> q.e))';

  // ---------------------------------------------------------------------------
  // (1) THRESHOLD COHORT IDENTITY — same-grain `relevant` threshold leaf on observations.
  // The returned id SET == the SQL cohort SET at the exact cutoff.
  // ---------------------------------------------------------------------------
  it('same-grain threshold: the returned id set is EXACTLY {sim >= cutoff} at the resolved vector', async () => {
    const THRESHOLD = 0.6;

    // Ground truth cohort: every observation whose similarity to the anchor vector >= 0.6.
    // truth: with q as <anchor> select count(*) where (1-(emb<=>q.e)) >= 0.6 → 178
    const expectedIds = (
      await truth<{ id: string }>(
        `with q as ${Q} select o.id from observations o, q where o.embedding is not null and ${SIM} >= ${THRESHOLD} order by o.id`,
      )
    ).map((r) => r.id);
    expect(expectedIds.length).toBe(178); // non-vacuity pin (drifts if the fixture is reseeded)

    const res = await h.service.select('observations', {
      filter: { on: 'normalized_text', op: 'relevant', query: ANCHOR, threshold: THRESHOLD },
      page: { limit: 5000 }, // lift the default page cap so ids carries the WHOLE cohort
      include_sql: true,
    });

    // total reports the full cohort size (page-independent); ids (uncapped here) is the whole set.
    expect(res.total).toBe(178);
    expect(res.ids.length).toBe(178);
    expect(res.has_more).toBe(false);
    // Set identity: the cohort the engine selected == the SQL cohort, exactly.
    expect([...res.ids].sort()).toEqual(expectedIds);

    // The lowering is a boolean WHERE over the embedding column with the bound ::vector + cutoff
    // — NOT a SELECT DISTINCT over the vector (the OOM guardrail), NOT a fan-inducing join.
    expect(res.sql).toContain('<=> $1::vector');
    expect(res.sql?.toLowerCase()).not.toContain('select distinct');
  });

  // ---------------------------------------------------------------------------
  // (2) MATCH-COUNT + DECISION BOUNDARY — citation calibration at the exact cutoff.
  // ---------------------------------------------------------------------------
  it('citation: match_count == the cohort count at the cutoff; boundary == the rows straddling it', async () => {
    const THRESHOLD = 0.5;

    // Ground truth at the cutoff.
    // truth: count where sim >= 0.5 → 1344 seen 2026-09-20 (was 1345 — the fixture is live and
    // non-hermetic, so the literal is NOT pinned; the contract is engine == this SQL truth).
    const [{ c: matchCount }] = await truth<{ c: number }>(
      `with q as ${Q} select count(*)::int as c from observations o, q where o.embedding is not null and ${SIM} >= ${THRESHOLD}`,
    );
    expect(Number(matchCount)).toBeGreaterThan(0); // non-vacuity bound

    // lowest_included = the WEAKEST member (sim desc, pk asc → last row of the cohort): the row the
    // cutoff is decided on. highest_excluded = the STRONGEST non-member (one row past the cutoff).
    const [lowestIncluded] = await truth<{ id: string; sim: number }>(
      `with q as ${Q} select o.id, ${SIM} as sim from observations o, q where o.embedding is not null and ${SIM} >= ${THRESHOLD} order by sim desc, o.id asc offset ${Number(matchCount) - 1} limit 1`,
    );
    const [highestExcluded] = await truth<{ id: string; sim: number }>(
      `with q as ${Q} select o.id, ${SIM} as sim from observations o, q where o.embedding is not null and ${SIM} < ${THRESHOLD} order by sim desc, o.id asc limit 1`,
    );

    const res = await h.service.select('observations', {
      filter: { on: 'normalized_text', op: 'relevant', query: ANCHOR, threshold: THRESHOLD },
      citation: { boundary: true }, // highest_excluded is ON-REQUEST
    });

    const cit = res.citation;
    expect(cit).toBeDefined();
    expect(cit?.on).toBe('normalized_text'); // cites the AUTHORED column, not the rewritten embedding col
    expect(cit?.query).toBe(ANCHOR);
    expect(cit?.mode).toBe('threshold');
    expect(cit?.cutoff).toBe(THRESHOLD); // threshold mode: cutoff IS the resolved threshold
    expect(cit?.match_count).toBe(Number(matchCount)); // engine == SQL truth at the cutoff

    // Boundary rows match the SQL straddle, similarity to 6 dp.
    expect(cit?.boundary.lowest_included.id).toBe(lowestIncluded.id);
    expect(cit?.boundary.lowest_included.similarity).toBeCloseTo(Number(lowestIncluded.sim), 6);
    expect(cit?.boundary.lowest_included.similarity).toBeGreaterThanOrEqual(THRESHOLD);
    expect(cit?.boundary.highest_excluded?.id).toBe(highestExcluded.id);
    expect(cit?.boundary.highest_excluded?.similarity).toBeCloseTo(Number(highestExcluded.sim), 6);
    expect(cit?.boundary.highest_excluded?.similarity).toBeLessThan(THRESHOLD);
  });

  it('citation: highest_excluded is ABSENT unless citation.boundary is requested', async () => {
    const res = await h.service.select('observations', {
      filter: { on: 'normalized_text', op: 'relevant', query: ANCHOR, threshold: 0.6 },
      // no citation.boundary
    });
    expect(res.citation).toBeDefined();
    expect(res.citation?.boundary.lowest_included).toBeDefined(); // always present
    expect(res.citation?.boundary.highest_excluded).toBeUndefined(); // on-request only
  });

  // ---------------------------------------------------------------------------
  // (3) TOP_K — both modes (GLOBAL membership cohort + ranked cutoff) + the XOR.
  // ---------------------------------------------------------------------------
  it('same-grain top_k (global): id set == the k most-relevant rows; cutoff == the k-th similarity', async () => {
    const K = 10;

    // Ground truth: the k most relevant rows overall (order by distance asc, pk asc — the engine's
    // deterministic tiebreak), and the k-th (weakest member) similarity = the citation cutoff.
    const topk = await truth<{ id: string; sim: number }>(
      `with q as ${Q} select o.id, ${SIM} as sim from observations o, q where o.embedding is not null order by (o.embedding <=> q.e) asc, o.id asc limit ${K}`,
    );
    const expectedIds = topk.map((r) => r.id).sort();
    const kthSim = Number(topk[K - 1]!.sim);

    const res = await h.service.select('observations', {
      filter: { on: 'normalized_text', op: 'relevant', query: ANCHOR, top_k: K },
      page: { limit: 5000 },
      include_sql: true,
    });

    expect(res.total).toBe(K); // exactly k (capped at available)
    expect([...res.ids].sort()).toEqual(expectedIds);

    // Membership lowering: `pk in (select … order by sim desc, pk asc limit k)` — NOT a join, NOT
    // a SELECT DISTINCT over the vector column.
    expect(res.sql?.toLowerCase()).toContain(' in (select ');
    expect(res.sql).toContain('limit $2');
    expect(res.sql?.toLowerCase()).not.toContain('select distinct');

    // Citation: top_k mode; cutoff = the k-th / lowest-included similarity (NOT a threshold).
    expect(res.citation?.mode).toBe('top_k');
    expect(res.citation?.match_count).toBe(K);
    expect(res.citation?.cutoff).toBeCloseTo(kthSim, 6);
    expect(res.citation?.per).toBeUndefined(); // global cohort — no partition (ruling a)
  });

  it('top_k XOR: neither threshold nor top_k REJECTS; both REJECT; exactly one is required', async () => {
    // neither → reject (no silent default).
    await expect(
      h.service.select('observations', {
        filter: { on: 'normalized_text', op: 'relevant', query: ANCHOR },
      }),
    ).rejects.toThrow(/EXACTLY ONE of "threshold" or "top_k".*neither/);

    // both → reject (ambiguous crisp set).
    await expect(
      h.service.select('observations', {
        filter: { on: 'normalized_text', op: 'relevant', query: ANCHOR, threshold: 0.5, top_k: 10 },
      }),
    ).rejects.toThrow(/EXACTLY ONE of "threshold" or "top_k".*both/);
  });

  // ---------------------------------------------------------------------------
  // (4) CITATION EXEMPLARS WITH SIMILARITY — the top-N matches, id + sim to 6 dp.
  // ---------------------------------------------------------------------------
  it('citation exemplars: the top-4 matches by similarity (id + sim), scores to 6 dp', async () => {
    // Ground truth: top-4 by similarity (the engine default exemplar count).
    const top4 = await truth<{ id: string; sim: number }>(
      `with q as ${Q} select o.id, ${SIM} as sim from observations o, q where o.embedding is not null order by (o.embedding <=> q.e) asc, o.id asc limit 4`,
    );

    const res = await h.service.select('observations', {
      filter: { on: 'normalized_text', op: 'relevant', query: ANCHOR, threshold: 0.5 },
    });
    const ex = res.citation?.exemplars ?? [];
    expect(ex.length).toBe(4);

    // The anchor itself is the vector source → similarity 1.0 (1 - distance(v,v)) → exemplar #1.
    expect(ex[0]!.similarity).toBeCloseTo(1, 6);

    // Exemplar id + similarity match the SQL top-4, in order, to 6 dp; snippet + full_length present.
    for (let i = 0; i < 4; i++) {
      expect(ex[i]!.id).toBe(top4[i]!.id);
      expect(ex[i]!.similarity).toBeCloseTo(Number(top4[i]!.sim), 6);
      expect(typeof ex[i]!.snippet).toBe('string');
      expect(ex[i]!.full_length).toBeGreaterThan(0);
    }
    // Exemplars are sorted by similarity descending.
    for (let i = 1; i < ex.length; i++) {
      expect(ex[i]!.similarity).toBeLessThanOrEqual(ex[i - 1]!.similarity);
    }
  });

  // ---------------------------------------------------------------------------
  // CROSS-GRAIN — accounts filtered by OBSERVATION relevance via an EXISTS semijoin (invariant #2:
  // never a fan-out join). The relevant leaf's `on` is the has_many dotted path
  // accounts → observations.normalized_text; membership/ranking happens on the CHILD.
  // ---------------------------------------------------------------------------
  it('cross-grain threshold: accounts EXIST-joined to a relevant observation (no fan-out join)', async () => {
    const THRESHOLD = 0.6;

    // Ground truth: accounts owning at least one observation with sim >= 0.6.
    const [{ c: expected }] = await truth<{ c: number }>(
      `select count(distinct a.id)::int as c from accounts a where exists (
         select 1 from observations o, ${Q} q where o.account_id = a.id and o.embedding is not null and ${SIM} >= ${THRESHOLD})`,
    );
    expect(Number(expected)).toBeGreaterThan(0); // non-vacuity

    const res = await h.service.select('accounts', {
      filter: {
        on: 'observations.normalized_text',
        op: 'relevant',
        query: ANCHOR,
        threshold: THRESHOLD,
      },
      page: { limit: 5000 },
      include_sql: true,
    });

    expect(res.total).toBe(Number(expected));

    // The set identity: exactly the accounts the EXISTS ground truth picks.
    const expectedAccts = (
      await truth<{ id: string }>(
        `select a.id from accounts a where exists (
           select 1 from observations o, ${Q} q where o.account_id = a.id and o.embedding is not null and ${SIM} >= ${THRESHOLD}) order by a.id`,
      )
    ).map((r) => r.id);
    expect([...res.ids].sort()).toEqual(expectedAccts);

    // Lowered as an EXISTS semijoin over the child (NOT a join to a non-unique key, NOT DISTINCT).
    expect(res.sql?.toLowerCase()).toContain('exists (select 1 from "observations"');
    expect(res.sql).toContain('"observations"."account_id" = "accounts"."id"');
    expect(res.sql?.toLowerCase()).not.toContain('select distinct');

    // Citation is cross-grain too — cites the AUTHORED dotted `on`, over the child (semantic) entity.
    expect(res.citation?.on).toBe('observations.normalized_text');
    expect(res.citation?.mode).toBe('threshold');
    expect(res.citation?.match_count).toBe(178); // the observation cohort (rows), per the sweep
  });

  it('cross-grain top_k (global cohort, ruling a): accounts owning one of the k most-relevant observations', async () => {
    const K = 20;

    // Ground truth: the GLOBAL top-k observations (no per-parent), then the DISTINCT accounts that
    // own one. Ruling (a): no group_by/per → ONE global cohort, not per-account.
    const [{ c: expected }] = await truth<{ c: number }>(
      `with q as ${Q}, cohort as (
         select o.id, o.account_id from observations o, q where o.embedding is not null
         order by (o.embedding <=> q.e) asc, o.id asc limit ${K})
       select count(distinct account_id)::int as c from cohort where account_id is not null`,
    );

    const res = await h.service.select('accounts', {
      filter: { on: 'observations.normalized_text', op: 'relevant', query: ANCHOR, top_k: K },
      page: { limit: 5000 },
      include_sql: true,
    });

    expect(res.total).toBe(Number(expected));

    // The EXISTS shell wraps a child-pk membership against the GLOBALLY-ranked top-k cohort.
    expect(res.sql?.toLowerCase()).toContain('exists (select 1 from "observations"');
    expect(res.sql?.toLowerCase()).toContain(' in (select ');
    expect(res.sql?.toLowerCase()).not.toContain('select distinct');

    // Citation cohort = the k observations (top_k mode), independent of how many accounts own them.
    expect(res.citation?.mode).toBe('top_k');
    expect(res.citation?.match_count).toBe(K);
  });

  // ---------------------------------------------------------------------------
  // fetch() — the relevance refinement path: narrow an explicit id list by semantic relevance.
  // ---------------------------------------------------------------------------
  it('fetch() refinement: a relevant leaf narrows the id list to its relevant members', async () => {
    // Seed an id list (pricing_signal observations), then refine it by relevance to the anchor.
    const seed = await h.service.select('observations', {
      filter: { on: 'type', op: 'eq', value: 'pricing_signal' },
      page: { limit: 60 },
    });
    expect(seed.ids.length).toBeGreaterThan(0);

    const THRESHOLD = 0.5;
    // Ground truth: of THESE ids, how many clear the cutoff. Computed over the same id list.
    const idList = seed.ids.map((id) => `'${id}'`).join(',');
    const [{ c: expected }] = await truth<{ c: number }>(
      `with q as ${Q} select count(*)::int as c from observations o, q
         where o.id in (${idList}) and o.embedding is not null and ${SIM} >= ${THRESHOLD}`,
    );

    const res = await h.service.fetch('observations', seed.ids, {
      filter: { on: 'normalized_text', op: 'relevant', query: ANCHOR, threshold: THRESHOLD },
      include_sql: true,
    });

    // The refinement narrows within the id set (count <= seed) and matches the SQL refinement.
    expect(res.count).toBe(Number(expected));
    expect(res.count).toBeLessThanOrEqual(seed.ids.length);
    // Every hydrated row clears the cutoff (the refinement is fail-closed, not a no-op).
    const hydratedIds = res.rows.map((r) => String(r.id)).sort();
    const expectedIds = (
      await truth<{ id: string }>(
        `with q as ${Q} select o.id from observations o, q
           where o.id in (${idList}) and o.embedding is not null and ${SIM} >= ${THRESHOLD} order by o.id`,
      )
    ).map((r) => r.id);
    expect(hydratedIds).toEqual(expectedIds);
    // Lowered as a boolean sim_gte WHERE (the bound ::vector cutoff), AND-ed with the id-list
    // narrowing — so the embedding param trails the id params (its index is not $1 here).
    expect(res.sql).toContain('::vector)) >=');
    expect(res.sql?.toLowerCase()).not.toContain('select distinct');
  });

  // ---------------------------------------------------------------------------
  // INVARIANT LANDMINE (a) — PROVE query()/fetch() actually invoke embed() (net-new on these
  // paths). A counting embed spy on a sibling service over the SAME db: a relevant query MUST call
  // it; a plain value-op query MUST NOT (no wasted embed when no relevant leaf is present).
  // ---------------------------------------------------------------------------
  it('embed() is invoked by query()/fetch() ONLY when a relevant leaf is present', async () => {
    let embedCalls = 0;
    // The spy mirrors the harness stub's deterministic lookup, but counts invocations. The registry
    // is already configured (makeQuerySurface ran in beforeAll), so this sibling service reuses it.
    const spyEmbed = async (text: string): Promise<number[]> => {
      embedCalls++;
      const r = await h.db.execute(
        sql`select embedding::text as e from observations
            where embedding is not null and normalized_text is not null
            and normalized_text ilike ${`%${text}%`} order by id limit 1`,
      );
      const e = (r.rows[0] as { e?: string } | undefined)?.e;
      return e ? (JSON.parse(e) as number[]) : new Array(1536).fill(0);
    };
    const spy = new QueryApplicationService(h.db, {
      scope: UNSCOPED,
      actorUserId: POC_ACTOR_USER_ID,
      actorOrganizationId: DEALBRAIN_ORG,
      // citation runs a row-grain companion query over the analytics model, so the spy needs it too.
      aggregateModel: () => loadDealbrainModel(h.db),
      semanticColumns: { observations: { normalized_text: 'embedding' } },
      embed: spyEmbed,
    });

    // A plain value-op query → NO embed.
    await spy.select('observations', {
      filter: { on: 'type', op: 'eq', value: 'pricing_signal' },
      page: { limit: 1 },
    });
    expect(embedCalls).toBe(0);

    // A relevant query → embed is invoked exactly once (the cohort vector + the citation reuse it,
    // NO second embed).
    const res = await spy.select('observations', {
      filter: { on: 'normalized_text', op: 'relevant', query: ANCHOR, threshold: 0.7 },
      page: { limit: 100 },
    });
    expect(embedCalls).toBe(1);
    expect(res.citation).toBeDefined(); // citation rode the SAME embed (no re-embed)

    // A relevant fetch refinement → embed is invoked again (the fetch path embeds its own leaf).
    await spy.fetch('observations', res.ids, {
      filter: { on: 'normalized_text', op: 'relevant', query: ANCHOR, threshold: 0.7 },
    });
    expect(embedCalls).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // INVARIANT LANDMINE (c) — the citation companion query is FAIL-CLOSED on a scope-coverage gap
  // (#3). The companion reads the semantic entity at ROW grain; if a configured `scope` leaves
  // that entity uncovered AND it is not declared TENANT_GLOBAL, the citation MUST REFUSE rather
  // than read it unscoped (the cohort number would be computed over rows the citation then leaks).
  // ---------------------------------------------------------------------------
  it('citation is FAIL-CLOSED: refuses when scope() leaves the semantic entity uncovered', async () => {
    const stubEmbed = async (text: string): Promise<number[]> => {
      const r = await h.db.execute(
        sql`select embedding::text as e from observations
            where embedding is not null and normalized_text is not null
            and normalized_text ilike ${`%${text}%`} order by id limit 1`,
      );
      const e = (r.rows[0] as { e?: string } | undefined)?.e;
      return e ? (JSON.parse(e) as number[]) : new Array(1536).fill(0);
    };
    // A scope that covers everything EXCEPT observations (the semantic entity) — a coverage gap,
    // and observations is NOT in tenantGlobalEntities. So the relevance citation over observations
    // must fail closed.
    const gappy = new QueryApplicationService(h.db, {
      actorUserId: POC_ACTOR_USER_ID,
      actorOrganizationId: DEALBRAIN_ORG,
      aggregateModel: () => loadDealbrainModel(h.db),
      semanticColumns: { observations: { normalized_text: 'embedding' } },
      embed: stubEmbed,
      scope: (e) =>
        e === 'observations'
          ? undefined // ← the gap: no tenancy predicate for the semantic entity
          : { on: 'organization_id', op: 'eq', value: DEALBRAIN_ORG },
      // tenantGlobalEntities omitted → observations is NOT declared global → the gap fails closed.
    });

    await expect(
      gappy.select('observations', {
        filter: { on: 'normalized_text', op: 'relevant', query: ANCHOR, threshold: 0.6 },
      }),
    ).rejects.toThrow(/refusing to read it unscoped|scope coverage gap/i);
  });
});
