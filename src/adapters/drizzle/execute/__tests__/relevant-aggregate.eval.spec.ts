// Wave-2 RELEVANCE-AS-FILTER (ADR-0024 §A / Amendment 2) — aggregate() FALSIFIER against LIVE
// dealbrain. Proves the `op:'relevant'` leaf collapses through aggregate() correctly end-to-end:
//   • THRESHOLD COHORT IDENTITY  — a grouped count over a threshold cohort == the SQL cohort
//     (member rows partitioned across groups), and citation.match_count == the exact cutoff count
//   • TOP_K DUAL-MODE            — GLOBAL (no group_by/per → k rows total, ruling a) vs PER-GROUP
//     (group_by default-partition, or an explicit `per` → row_number() partition); XOR enforced
//   • CITATION + DECISION BOUNDARY — exemplars(id,sim) == SQL top-N by sim; boundary
//     lowest_included/highest_excluded straddle the cutoff (ON-REQUEST: citation:{boundary:true})
//   • Q6 CONFORM-ON-EVERY-SOURCE — measures on >1 source + a relevant leaf whose embedding column
//     doesn't resolve on every source is REJECTED (invariant #5; the crisp leaf rides the wave-1
//     conform-or-reject guard unchanged), never a silent per-source no-op
//   • FAN-SAFETY                 — the cohort consumes as a same-grain MEMBERSHIP test; the grouped
//     count == the SQL membership count, NEVER an inflated fanning JOIN to the ranked CTE
//   • FAIL-CLOSED SCOPE          — a scope that doesn't cover the semantic/cohort entity REFUSES
//   • EMBED-SPY LANDMINE         — aggregate() must INVOKE embed() (net-new path; the relevance
//     vector is service-resolved once, before compile)
//
// DETERMINISM (no live embed model): the harness-style embed() stub ILIKE-resolves a phrase to a
// REAL stored observation embedding (ordered by id). The SAME phrase, resolved through the SAME
// pool in SQL, gives the anchor vector — so the engine's vector and the spec's truth vector are
// identical BY CONSTRUCTION. Every expected value is computed at test time (the fixture is
// non-hermetic — NEVER hard-code counts). similarity = 1 - (embedding <=> vector) ∈ [0,1] (the
// EXACT formula at compiler.ts simExpr). NEVER SELECT DISTINCT over the vector(1536) column (OOM
// guardrail); every ranked/LIMIT scan adds a deterministic id ASC secondary sort.
//
//   DBURL=postgres://postgres:PW@localhost:54321/dealbrain bun test relevant-aggregate.eval

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { POC_ACTOR_USER_ID } from '../../../../adapters/drizzle/eav/field-map';
import { configureQueryRegistry } from '../../../../adapters/drizzle/registry/registry';
import {
  accounts,
  accountsRelations,
  fieldValues,
  opportunities,
  opportunitiesRelations,
} from '../../../../adapters/reference/schema.dealbrain';
import {
  DEALBRAIN_ORG,
  observationsExt,
  observationsExtRelations,
} from '../../../../characterization/harness';
import type { FilterExpression } from '../../../../internal/language/types';
import { QueryApplicationService } from '../../../../query.application-service';
import { loadDealbrainModel } from '../../../reference/model.dealbrain';
import { type DrizzleDb, makeDb } from '../drizzle-db';

const DBURL = process.env.DBURL;
const suite = DBURL ? describe : describe.skip;

// A distinctive normalized_text prefix — ILIKE-resolves to the FIRST pricing_signal observation by
// id (a type-anchored vector). The embed stub and the spec's SQL anchor both resolve THIS phrase
// the same way, so the engine's query vector == the spec's truth vector by construction.
const ANCHOR_PHRASE = 'beanmaxxing offered Tabnine a conditional';

suite('relevance-as-filter — aggregate() live dealbrain (ADR-0024 §A / Amendment 2)', () => {
  let db: DrizzleDb;
  let close: () => Promise<void>;
  let service: QueryApplicationService;
  let embedCalls: number;
  // The anchor vector, resolved in SQL via the SAME phrase the embed stub uses (a `[..]` literal
  // for the ::vector cast in truth queries; the array form for nothing else — every truth runs
  // through SQL, never recomputed in JS).
  let anchorVecLit: string;

  const truth = async (text: string) =>
    (await db.execute(sql.raw(text))).rows as Record<string, unknown>[];
  const num = (v: unknown) => Number(v);

  beforeAll(async () => {
    ({ db, close } = makeDb(DBURL!));
    // Register the SAME 3 dealbrain entities the harness uses (observations is the EXTENDED table
    // that carries embedding + normalized_text). The module-global registry must be populated
    // before any compile().
    configureQueryRegistry([
      { name: 'accounts', table: accounts, relations: accountsRelations },
      {
        name: 'opportunities',
        table: opportunities,
        relations: opportunitiesRelations,
        eav: { kind: 'typed-columns', valueTable: fieldValues, entityTypeValue: 'opportunity' },
      },
      { name: 'observations', table: observationsExt, relations: observationsExtRelations },
    ]);

    // Spy-wrapped embed stub (mirrors harness.embed): ILIKE-resolve the phrase to a real stored
    // embedding, ordered by id (deterministic). The COUNTER proves aggregate() invokes embed().
    embedCalls = 0;
    const embedCache = new Map<string, number[]>();
    const embed = async (text: string): Promise<number[]> => {
      embedCalls++;
      const cached = embedCache.get(text);
      if (cached) return cached;
      const res = await db.execute(
        sql`select embedding::text as e from observations
            where embedding is not null and normalized_text is not null
            and normalized_text ilike ${`%${text}%`}
            order by id limit 1`,
      );
      const e = (res.rows[0] as { e?: string } | undefined)?.e;
      const vec = e ? (JSON.parse(e) as number[]) : new Array(1536).fill(0);
      embedCache.set(text, vec);
      return vec;
    };

    service = new QueryApplicationService(db, {
      actorUserId: POC_ACTOR_USER_ID,
      actorOrganizationId: DEALBRAIN_ORG,
      aggregateModel: () => loadDealbrainModel(db),
      semanticColumns: { observations: { normalized_text: 'embedding' } },
      embed,
    });

    // The anchor vector as a `[..]` literal, resolved through the SAME pool/phrase — so truth
    // queries cast it with ::vector and compute the identical similarity the engine does.
    const anchor = await truth(
      `select embedding::text e from observations
       where embedding is not null and normalized_text is not null
         and normalized_text ilike '%${ANCHOR_PHRASE}%' order by id limit 1`,
    );
    anchorVecLit = String(anchor[0]!.e); // already a `[..]` pgvector text literal
    expect(anchorVecLit.startsWith('[')).toBe(true);
  });

  afterAll(async () => {
    await close?.();
  });

  // A relevant leaf authored at the wire (vector/embeddingColumn are service-stamped before
  // compile — never authored here).
  const relevant = (extra: Record<string, unknown>): FilterExpression =>
    ({ on: 'normalized_text', op: 'relevant', query: ANCHOR_PHRASE, ...extra }) as FilterExpression;

  // ── 1. THRESHOLD COHORT IDENTITY + MATCH-COUNT ─────────────────────────────────────────────
  it('R1 threshold: grouped count == the SQL cohort partitioned by group; embed INVOKED', async () => {
    const before = embedCalls;
    const res = await service.aggregate('observations', {
      group_by: ['type'],
      measures: [{ on: '*', agg: 'count', as: 'n' }],
      filter: relevant({ threshold: 0.6 }),
    });
    // LANDMINE: aggregate() must INVOKE embed (the relevance vector is resolved before compile).
    expect(embedCalls).toBeGreaterThan(before);

    // Per-group truth: the cohort (sim>=0.6) grouped by type — id ASC secondary sort is moot for a
    // COUNT but the cohort predicate is the membership the engine applies.
    const ref = await truth(
      `with q as (select '${anchorVecLit}'::vector e)
       select coalesce(type,'∅') as type, count(*)::int n
       from observations o, q where (1 - (o.embedding <=> q.e)) >= 0.6
       group by type order by type asc`,
    );
    const refByType = new Map(ref.map((r) => [String(r.type), num(r.n)]));
    for (const row of res.rows) {
      const key = row.type == null ? '∅' : String(row.type);
      expect(refByType.has(key)).toBe(true);
      expect(num(row.n)).toBe(refByType.get(key)!);
    }
    // The grouped counts SUM to the whole cohort (members partitioned across groups, no fan).
    const total = num(
      (
        await truth(
          `with q as (select '${anchorVecLit}'::vector e)
           select count(*)::int n from observations o, q where (1 - (o.embedding <=> q.e)) >= 0.6`,
        )
      )[0]!.n,
    );
    expect(res.rows.reduce((s, r) => s + num(r.n), 0)).toBe(total);
  });

  it('R2 threshold COHORT IDENTITY: the returned member set == the SQL cohort id set (exact)', async () => {
    // Group by the row pk so each group is one member → the GROUP KEY SET is the cohort id set.
    const res = await service.aggregate('observations', {
      group_by: ['id'],
      measures: [{ on: '*', agg: 'count', as: 'n' }],
      filter: relevant({ threshold: 0.5 }),
    });
    const gotIds = res.rows.map((r) => String(r.id)).sort();
    const ref = await truth(
      `with q as (select '${anchorVecLit}'::vector e)
       select o.id from observations o, q where (1 - (o.embedding <=> q.e)) >= 0.5 order by o.id asc`,
    );
    const wantIds = ref.map((r) => String(r.id)).sort();
    expect(gotIds).toEqual(wantIds);
    expect(res.rows.every((r) => num(r.n) === 1)).toBe(true); // pk-grouped → each group is 1 row
  });

  it('R3 citation: match_count + DECISION BOUNDARY straddle the exact cutoff (boundary ON-REQUEST)', async () => {
    const res = await service.aggregate(
      'observations',
      {
        group_by: ['type'],
        measures: [{ on: '*', agg: 'count', as: 'n' }],
        filter: relevant({ threshold: 0.6 }),
      },
      { citation: { boundary: true } },
    );
    const cit = res.citation;
    expect(cit).toBeDefined();
    expect(cit!.mode).toBe('threshold');
    expect(cit!.cutoff).toBe(0.6);
    // match_count == the SQL count at the exact cutoff.
    const cnt = num(
      (
        await truth(
          `with q as (select '${anchorVecLit}'::vector e)
           select count(*)::int n from observations o, q where (1 - (o.embedding <=> q.e)) >= 0.6`,
        )
      )[0]!.n,
    );
    expect(cit!.match_count).toBe(cnt);
    // BOUNDARY: lowest_included = weakest member (ORDER BY sim ASC LIMIT 1 within members);
    // highest_excluded = strongest non-member (ORDER BY sim DESC LIMIT 1 below the cutoff).
    const lowIncl = await truth(
      `with q as (select '${anchorVecLit}'::vector e)
       select o.id, (1 - (o.embedding <=> q.e)) sim from observations o, q
       where (1 - (o.embedding <=> q.e)) >= 0.6 order by sim asc, o.id desc limit 1`,
    );
    const highExcl = await truth(
      `with q as (select '${anchorVecLit}'::vector e)
       select o.id, (1 - (o.embedding <=> q.e)) sim from observations o, q
       where (1 - (o.embedding <=> q.e)) < 0.6 order by sim desc, o.id asc limit 1`,
    );
    expect(cit!.boundary.lowest_included.id).toBe(String(lowIncl[0]!.id));
    expect(cit!.boundary.lowest_included.similarity).toBeCloseTo(num(lowIncl[0]!.sim), 6);
    expect(cit!.boundary.highest_excluded).toBeDefined();
    expect(cit!.boundary.highest_excluded!.id).toBe(String(highExcl[0]!.id));
    expect(cit!.boundary.highest_excluded!.similarity).toBeCloseTo(num(highExcl[0]!.sim), 6);
    // The boundary is a true decision line: included sim >= cutoff > excluded sim.
    expect(cit!.boundary.lowest_included.similarity).toBeGreaterThanOrEqual(0.6);
    expect(cit!.boundary.highest_excluded!.similarity).toBeLessThan(0.6);
  });

  it('R4 citation EXEMPLARS WITH SIMILARITY: exemplars(id,sim) == SQL top-N by sim (scores to 6dp)', async () => {
    const res = await service.aggregate('observations', {
      group_by: ['type'],
      measures: [{ on: '*', agg: 'count', as: 'n' }],
      filter: relevant({ threshold: 0.6 }),
    });
    const ex = res.citation!.exemplars;
    expect(ex.length).toBeGreaterThan(0);
    const ref = await truth(
      `with q as (select '${anchorVecLit}'::vector e)
       select o.id, (1 - (o.embedding <=> q.e)) sim from observations o, q
       where (1 - (o.embedding <=> q.e)) >= 0.6 order by sim desc, o.id asc limit ${ex.length}`,
    );
    expect(ex.map((e) => e.id)).toEqual(ref.map((r) => String(r.id)));
    ex.forEach((e, i) => expect(e.similarity).toBeCloseTo(num(ref[i]!.sim), 6));
    // The type-anchored row is the strongest match (similarity ≈ 1).
    expect(ex[0]!.similarity).toBeCloseTo(1, 6);
  });

  // ── 2. TOP_K DUAL-MODE ─────────────────────────────────────────────────────────────────────
  it('R5 top_k GLOBAL (no group_by/per → k rows total, ruling a) == ORDER BY emb<=>q.e LIMIT k', async () => {
    const k = 10;
    const res = await service.aggregate('observations', {
      measures: [{ on: '*', agg: 'count', as: 'n' }],
      filter: relevant({ top_k: k }),
    });
    // GLOBAL cohort: exactly k rows total (no per-parent split) → the single ungrouped count is k.
    expect(res.rows).toHaveLength(1);
    expect(num(res.rows[0]!.n)).toBe(k);
    // citation member set == the SQL global top-k id set (deterministic id ASC secondary sort).
    const ref = await truth(
      `with q as (select '${anchorVecLit}'::vector e)
       select o.id, (1 - (o.embedding <=> q.e)) sim from observations o, q
       where o.embedding is not null order by o.embedding <=> q.e asc, o.id asc limit ${k}`,
    );
    expect(res.citation!.mode).toBe('top_k');
    expect(res.citation!.match_count).toBe(k);
    expect(res.citation!.exemplars.map((e) => e.id)).toEqual(
      ref.slice(0, res.citation!.exemplars.length).map((r) => String(r.id)),
    );
    // cutoff = the weakest member's similarity (the k-th / lowest-included sim).
    expect(res.citation!.cutoff).toBeCloseTo(num(ref[k - 1]!.sim), 6);
  });

  it('R6 top_k PER-GROUP (explicit per) == row_number() PARTITION top-k per key', async () => {
    const k = 3;
    const res = await service.aggregate('observations', {
      group_by: ['account_id'],
      measures: [{ on: '*', agg: 'count', as: 'n' }],
      filter: relevant({ top_k: k, per: 'account_id' }),
    });
    // Per-account top-k: each account contributes min(k, its obs count) members. Truth via
    // row_number() over the partition; NULL account_id partitions are DROPPED (no phantom group).
    const ref = await truth(
      `with q as (select '${anchorVecLit}'::vector e),
            ranked as (
              select o.account_id,
                     row_number() over (partition by o.account_id
                       order by o.embedding <=> q.e asc, o.id asc) rn
              from observations o, q
              where o.embedding is not null and o.account_id is not null)
       select account_id, count(*)::int n from ranked where rn <= ${k}
       group by account_id order by account_id asc`,
    );
    const refByAcct = new Map(ref.map((r) => [String(r.account_id), num(r.n)]));
    // Engine drops the NULL-account partition too → compare only the non-null groups.
    const gotGroups = res.rows.filter((r) => r.account_id != null);
    expect(gotGroups.length).toBe(refByAcct.size);
    for (const row of gotGroups) {
      expect(refByAcct.has(String(row.account_id))).toBe(true);
      expect(num(row.n)).toBe(refByAcct.get(String(row.account_id))!);
    }
    // total members == sum of per-partition top-k (the cohort is the union of partition winners).
    const totalRef = num(
      (
        await truth(
          `with q as (select '${anchorVecLit}'::vector e),
                ranked as (select row_number() over (partition by o.account_id
                             order by o.embedding <=> q.e asc, o.id asc) rn
                           from observations o, q
                           where o.embedding is not null and o.account_id is not null)
           select count(*)::int n from ranked where rn <= ${k}`,
        )
      )[0]!.n,
    );
    expect(gotGroups.reduce((s, r) => s + num(r.n), 0)).toBe(totalRef);
    expect(res.citation!.mode).toBe('top_k');
    expect(res.citation!.per).toBe('account_id');
  });

  it('R7 top_k GROUPED with no `per` defaults the partition to the group_by key (per-group, not global)', async () => {
    // ruling a applies only to "no group_by/per". WITH group_by + no per, the cohort partitions by
    // the group_by key — so each account gets its own top-k (NOT a single global k split across
    // accounts). Witness: total members == per-account top-k sum, NOT k.
    const k = 10;
    const res = await service.aggregate('observations', {
      group_by: ['account_id'],
      measures: [{ on: '*', agg: 'count', as: 'n' }],
      filter: relevant({ top_k: k }),
    });
    const totalRef = num(
      (
        await truth(
          `with q as (select '${anchorVecLit}'::vector e),
                ranked as (select row_number() over (partition by o.account_id
                             order by o.embedding <=> q.e asc, o.id asc) rn
                           from observations o, q
                           where o.embedding is not null and o.account_id is not null)
           select count(*)::int n from ranked where rn <= ${k}`,
        )
      )[0]!.n,
    );
    const gotTotal = res.rows.filter((r) => r.account_id != null).reduce((s, r) => s + num(r.n), 0);
    expect(gotTotal).toBe(totalRef);
    expect(gotTotal).toBeGreaterThan(k); // per-group, NOT a single global cohort of k
  });

  it('R8 XOR: a relevant leaf with NEITHER threshold nor top_k is rejected; BOTH is rejected', async () => {
    await expect(
      service.aggregate('observations', {
        measures: [{ on: '*', agg: 'count', as: 'n' }],
        filter: relevant({}), // neither
      }),
    ).rejects.toThrow(/EXACTLY ONE of "threshold" or "top_k".*neither/i);
    await expect(
      service.aggregate('observations', {
        measures: [{ on: '*', agg: 'count', as: 'n' }],
        filter: relevant({ threshold: 0.6, top_k: 10 }), // both
      }),
    ).rejects.toThrow(/EXACTLY ONE of "threshold" or "top_k".*both/i);
  });

  // ── 3. Q6 CONFORM-ON-EVERY-SOURCE (invariant #5) ───────────────────────────────────────────
  it('R9 Q6: measures on >1 source + a relevant leaf LOCAL to one source → REJECT (conform on every source)', async () => {
    // root=observations, measures on observations + opportunities. A BARE relevant leaf
    // (`normalized_text`) is LOCAL to the observations grain — it crispifies to a leaf whose `on`
    // is observations' own `embedding` column. opportunities has NO `embedding` column and it is
    // not to-one reachable → the crisp leaf rides the wave-1 conform-or-reject guard (invariant #5)
    // and REJECTS, rather than silently applying on the obs measure + no-op on the opp measure (a
    // fabricated cross-measure comparison — the Q6 landmine). Source-local intent → a
    // measure-level `where`; a true cross-grain cohort uses a DOTTED leaf that semijoins on EVERY
    // source (proven separately by R6/R7's grouped cross-grain cohorts).
    await expect(
      service.aggregate('observations', {
        measures: [
          { on: '*', agg: 'count', as: 'obs' },
          { source: 'opportunities', on: '*', agg: 'count', as: 'opp' },
        ],
        filter: relevant({ top_k: 10 }), // bare, local-to-observations cohort
      }),
    ).rejects.toThrow(/not queryable on opportunities|not conformed|embedding/i);
    // SAME reject in threshold mode (sim_gte is a boolean leaf, still must conform on every source).
    await expect(
      service.aggregate('observations', {
        measures: [
          { on: '*', agg: 'count', as: 'obs' },
          { source: 'opportunities', on: '*', agg: 'count', as: 'opp' },
        ],
        filter: relevant({ threshold: 0.6 }),
      }),
    ).rejects.toThrow(/not queryable on opportunities|not conformed|embedding/i);
  });

  it('R9b a DOTTED cross-grain relevant cohort CONFORMS on every source (semijoin) — applied, not rejected', async () => {
    // The legitimate multi-source case: root=accounts, measures on opportunities + observations, a
    // DOTTED relevant leaf (`observations.normalized_text`) crispifies to a ranked cohort over
    // observations consumed as a same-grain membership on the obs measure AND a has_many SEMIJOIN
    // on the opp measure (opportunities→observations). It conforms on BOTH → applied uniformly.
    const k = 10;
    const res = await service.aggregate(
      'accounts',
      {
        measures: [
          { source: 'opportunities', on: '*', agg: 'count', as: 'opp' },
          { source: 'observations', on: '*', agg: 'count', as: 'obs' },
        ],
        filter: {
          on: 'observations.normalized_text',
          op: 'relevant',
          query: ANCHOR_PHRASE,
          top_k: k,
        } as FilterExpression,
      },
      { include_sql: true },
    );
    // obs leg: count of cohort members (global k); opp leg: opportunities with ≥1 cohort-member obs.
    const obsRef = num(
      (
        await truth(
          `with q as (select '${anchorVecLit}'::vector e),
                cohort as (select o.id from observations o, q
                           where o.embedding is not null order by o.embedding <=> q.e asc, o.id asc limit ${k})
           select count(*)::int n from observations where id in (select id from cohort)`,
        )
      )[0]!.n,
    );
    const oppRef = num(
      (
        await truth(
          `with q as (select '${anchorVecLit}'::vector e),
                cohort as (select o.id from observations o, q
                           where o.embedding is not null order by o.embedding <=> q.e asc, o.id asc limit ${k})
           select count(*)::int n from opportunities p
           where exists (select 1 from observations c where c.opportunity_id = p.id and c.id in (select id from cohort))`,
        )
      )[0]!.n,
    );
    expect(num(res.rows[0]!.obs)).toBe(obsRef);
    expect(num(res.rows[0]!.opp)).toBe(oppRef);
    // The opp leg conforms via a has_many EXISTS semijoin, NOT a fan-out join (invariant #2).
    expect((res.sql ?? '').toLowerCase()).toContain('exists');
    // include_sql echoes the bound params too (parity with query()/fetch()): the query vector is
    // a param (never inlined — invariant #1), so a 1536-d entry is present alongside the scalars.
    expect(Array.isArray(res.params)).toBe(true);
    expect(
      (res.params ?? []).some((p) => {
        const a = Array.isArray(p)
          ? p
          : typeof p === 'string' && p.startsWith('[')
            ? JSON.parse(p)
            : null;
        return Array.isArray(a) && a.length === 1536;
      }),
    ).toBe(true);
  });

  // ── 4. FAN-SAFETY (cohort membership ≠ a fanning JOIN) ─────────────────────────────────────
  it('R10 FAN-SAFETY: the GLOBAL cohort count == the SQL MEMBERSHIP count, never an inflated join', async () => {
    // The cohort consumes as `pk in (select pk from cohort)` (a same-grain membership test), NOT a
    // fan-inducing JOIN to the ranked CTE. A GLOBAL cohort (no group_by, no per → ruling a) has
    // exactly k members → the ungrouped count is k. A fanning join would multiply by the join's
    // non-unique cardinality (here observations→opportunities has_many would inflate well past k).
    const k = 25;
    const res = await service.aggregate(
      'observations',
      {
        measures: [{ on: '*', agg: 'count', as: 'n' }],
        filter: relevant({ top_k: k }), // GLOBAL (no group_by/per) → exactly k members
      },
      { include_sql: true },
    );
    expect(res.rows).toHaveLength(1);
    expect(num(res.rows[0]!.n)).toBe(k); // exactly k — membership, not a fanned join
    // Cross-check against the SQL membership count (id ASC secondary sort = deterministic cutoff).
    const ref = num(
      (
        await truth(
          `with q as (select '${anchorVecLit}'::vector e),
                cohort as (select o.id from observations o, q
                           where o.embedding is not null order by o.embedding <=> q.e asc, o.id asc limit ${k})
           select count(*)::int n from observations where id in (select id from cohort)`,
        )
      )[0]!.n,
    );
    expect(num(res.rows[0]!.n)).toBe(ref);
    // The compiled SQL uses a MEMBERSHIP test against the ranked cohort, never a JOIN to it.
    const lowered = (res.sql ?? '').toLowerCase();
    expect(lowered).toContain('relevant_cohort');
    expect(lowered).toContain(' in (select');
    // NEVER a join onto the cohort (the fan-out an `in (..)` membership precludes).
    expect(lowered).not.toMatch(/join\s+"?relevant_cohort/);
  });

  // ── 5. FAIL-CLOSED SCOPE through the cohort body (invariant #3) ─────────────────────────────
  it('R11 fail-closed: a scope that does NOT cover the semantic/cohort entity REFUSES', async () => {
    const scopedService = new QueryApplicationService(db, {
      actorUserId: POC_ACTOR_USER_ID,
      actorOrganizationId: DEALBRAIN_ORG,
      aggregateModel: () => loadDealbrainModel(db),
      semanticColumns: { observations: { normalized_text: 'embedding' } },
      embed: async () => JSON.parse(anchorVecLit) as number[],
      // observations (the cohort/semantic entity) gets NO scope answer → coverage gap.
      scope: (entity) =>
        entity === 'observations'
          ? undefined
          : ({ on: 'id', op: 'is_not_null' } as FilterExpression),
    });
    await expect(
      scopedService.aggregate('observations', {
        measures: [{ on: '*', agg: 'count', as: 'n' }],
        filter: relevant({ top_k: 10 }),
      }),
    ).rejects.toThrow(/no tenancy scope|coverage gap|refusing/i);
  });

  it('R12 a COVERED scope folds INTO the cohort body — the cohort honors the scope predicate', async () => {
    // Scope observations to type<>'pricing_signal'; a top_k cohort then excludes pricing_signal
    // rows from the ranked population. Proves the scope predicate lands in the cohort WHERE before
    // the ORDER BY/LIMIT (#3), not merely the outer query. Truth: the same row_number() ranking
    // with the scope folded into the inner WHERE.
    const scopedService = new QueryApplicationService(db, {
      actorUserId: POC_ACTOR_USER_ID,
      actorOrganizationId: DEALBRAIN_ORG,
      aggregateModel: () => loadDealbrainModel(db),
      semanticColumns: { observations: { normalized_text: 'embedding' } },
      embed: async () => JSON.parse(anchorVecLit) as number[],
      scope: (entity) =>
        entity === 'observations'
          ? ({ on: 'type', op: 'neq', value: 'pricing_signal' } as FilterExpression)
          : ({ on: 'id', op: 'is_not_null' } as FilterExpression),
    });
    const k = 10;
    const res = await scopedService.aggregate('observations', {
      measures: [{ on: '*', agg: 'count', as: 'n' }],
      filter: relevant({ top_k: k }),
    });
    expect(num(res.rows[0]!.n)).toBe(k); // still k members, but drawn from the SCOPED population
    // The scoped cohort members == the SQL top-k over the scoped population (anchor row itself, a
    // pricing_signal, is excluded → the cohort shifts).
    const ref = await truth(
      `with q as (select '${anchorVecLit}'::vector e)
       select o.id from observations o, q
       where o.embedding is not null and o.type <> 'pricing_signal'
       order by o.embedding <=> q.e asc, o.id asc limit ${k}`,
    );
    const refIds = ref.map((r) => String(r.id));
    expect(res.citation!.exemplars.map((e) => e.id)).toEqual(
      refIds.slice(0, res.citation!.exemplars.length),
    );
    // The anchor (a pricing_signal) is the global #1 match — its exclusion here PROVES the scope
    // reached the cohort body (an unscoped cohort would have ranked it first).
    const anchorId = String(
      (
        await truth(
          `select id from observations where normalized_text ilike '%${ANCHOR_PHRASE}%' order by id limit 1`,
        )
      )[0]!.id,
    );
    expect(refIds).not.toContain(anchorId);
    expect(res.citation!.exemplars.map((e) => e.id)).not.toContain(anchorId);
  });
});
