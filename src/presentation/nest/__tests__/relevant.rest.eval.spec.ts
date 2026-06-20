// The Wave-2 `relevant` leaf + its MANDATORY relevance citation, driven through the FULL
// Nest REST presentation chain verbatim — the layers ABOVE the engine: the ZodValidationPipe,
// QueryController (incl. its typed-error→HTTP mapping), Search/AggregateUseCase, QuerySurfaceService,
// and QueryApplicationService.{query,aggregate} with the async embed() walk → crispify → compile →
// row-grain citation companion. Every other relevance test would drive the service directly and
// bypass all of this; this one feeds the controller the SAME body the pipe produces so the
// pipe → handler → 200-with-citation path is faithful end to end.
//
// It builds the real provider chain by hand (constructors, not DI), exactly like compare.rest.eval,
// and does NOT spin an Express server (the HTTP transport is Nest plumbing, not relevance logic).
//
// DETERMINISM (no live embed model). The embed() port is the harness's existing-vector trick: it
// ILIKE-resolves a phrase to a REAL stored observation embedding (the anchor) — so a `relevant`
// query is anchored to a concrete vector with no model call. EVERY expected value (cohort id set,
// match_count, cutoff, exemplar similarities, top-k membership) is computed from raw SQL through the
// SAME pool AT TEST TIME against that exact anchor vector; nothing is hard-coded (the fixture is
// non-hermetic — counts drift on reseed, identities don't). similarity = 1 - (embedding <=> vector),
// the EXACT formula at run-drizzle.simSql / compiler.simExpr.
//
//   DBURL=postgres://postgres:password@localhost:54321/dealbrain bun test relevant.rest.eval

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type ArgumentMetadata, BadRequestException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { type DrizzleDb, makeDb } from '../../../adapters/drizzle/execute/drizzle-db';
import { loadDealbrainModel } from '../../../adapters/reference/model.dealbrain';
import {
  accounts,
  accountsRelations,
  fieldValues,
  observations,
  observationsRelations,
  opportunities,
  opportunitiesRelations,
} from '../../../adapters/reference/schema.dealbrain';
import { QuerySurfaceService } from '../query-surface.service';
import { QueryController } from '../rest/query.controller';
import { aggregateRequestSchema, querySearchRequestSchema } from '../rest/query.dto';
import { ZodValidationPipe } from '../rest/zod-validation.pipe';
import {
  AggregateUseCase,
  CompareUseCase,
  DescribeUseCase,
  FetchUseCase,
  SearchUseCase,
} from '../use-cases';

const DBURL = process.env.DBURL;
const suite = DBURL ? describe : describe.skip;

// A phrase that ILIKE-resolves (ORDER BY id LIMIT 1) to a stable, type-anchored observation: the
// first `pricing_signal` row by id. The anchor vector is whatever THAT row's embedding is — read
// fresh below, never assumed — so the test is self-consistent across reseeds.
const ANCHOR_PHRASE = 'conditional, not-yet-agreed concession';

suite('relevant leaf + citation — REST presentation chain (live dealbrain)', () => {
  let db: DrizzleDb;
  let close: () => Promise<void>;
  let controller: QueryController;
  let embedCalls = 0; // landmine (a): PROVE the relevance path actually invokes embed().

  const searchPipe = new ZodValidationPipe(querySearchRequestSchema);
  const aggPipe = new ZodValidationPipe(aggregateRequestSchema);
  const META = { type: 'body' } as ArgumentMetadata;

  // The anchor vector as a `[...]::vector` literal, resolved once at boot so every expected-value
  // SQL re-uses the EXACT same vector the embed() stub returned to the engine.
  let anchorLit: string;

  beforeAll(async () => {
    ({ db, close } = makeDb(DBURL!));

    // The deterministic embed stub (the harness trick), wrapped with a call counter. It pulls a
    // REAL stored embedding for the phrase, so the engine's `relevant` query lowers to a concrete
    // vector with no model. Returns a zero vector on no match (never reached here — the anchor
    // phrase matches), keeping the port total.
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

    const svc = new QuerySurfaceService(db, {
      schema: {
        accounts,
        opportunities,
        observations, // schema.dealbrain's observations now carries embedding + normalized_text
        fieldValues,
        accountsRelations,
        opportunitiesRelations,
        observationsRelations,
      },
      // dealbrain test tables carry no tenancy column → tenant-global so the relevance path runs
      // unscoped (fail-closed would otherwise deny an uncovered source).
      scopeFor: () => () => undefined,
      tenantGlobalEntities: ['observations', 'opportunities', 'accounts'],
      aggregateModel: () => loadDealbrainModel(db),
      semanticColumns: { observations: { normalized_text: 'embedding' } },
      embed,
      getRequester: () => ({ userId: 'rest-eval' }),
    } as never);
    svc.onModuleInit(); // registerSchema, exactly as Nest would on boot
    controller = new QueryController(
      new DescribeUseCase(svc),
      new SearchUseCase(svc),
      new FetchUseCase(svc),
      new AggregateUseCase(svc),
      new CompareUseCase(svc),
    );

    // Resolve the anchor vector literal once — the SAME ILIKE resolution the embed stub uses, so
    // expected-value SQL is computed against the exact vector the engine saw.
    const a = await db.execute(
      sql`select embedding::text as e from observations
          where embedding is not null and normalized_text is not null
          and normalized_text ilike ${`%${ANCHOR_PHRASE}%`}
          order by id limit 1`,
    );
    const e = (a.rows[0] as { e?: string } | undefined)?.e;
    if (!e) throw new Error('anchor phrase resolved no embedding — fixture drift');
    anchorLit = e; // already a postgres vector text literal: "[v0,v1,...]"
  });
  afterAll(async () => {
    await close?.();
  });

  // ── 1. THRESHOLD COHORT IDENTITY + match_count + cutoff (high threshold → cohort fits one page) ──
  it('R1 threshold relevant leaf → 200; returned ids == the SQL cohort, citation pins the cutoff', async () => {
    const THRESH = 0.7; // sweep-verified to be a handful of rows — fits under the default page cap
    const simExpr = sql`(1 - (observations.embedding <=> ${anchorLit}::vector))`;

    // Ground truth, computed at test time against the anchor vector the engine will embed.
    const cohort = await db.execute(
      sql`select id from observations where ${simExpr} >= ${THRESH} order by id`,
    );
    const expectedIds = (cohort.rows as Array<{ id: string }>).map((r) => r.id).sort();
    expect(expectedIds.length).toBeGreaterThan(0);
    expect(expectedIds.length).toBeLessThanOrEqual(25); // sanity: cohort fits the default page

    const before = embedCalls;
    const body = searchPipe.transform(
      {
        filter: { on: 'normalized_text', op: 'relevant', query: ANCHOR_PHRASE, threshold: THRESH },
      },
      META,
    );
    const res = await controller.search('observations', body);
    if ('results' in res) throw new Error('expected single-entity search result');

    // The relevance path actually called embed() (landmine a) — the cohort is not fabricated.
    expect(embedCalls).toBe(before + 1);

    // COHORT IDENTITY: the returned id set == the SQL cohort at the cutoff.
    expect([...res.ids].sort()).toEqual(expectedIds);
    expect(res.total).toBe(expectedIds.length);

    // The MANDATORY citation rides the wire verbatim.
    const c = res.citation;
    if (!c) throw new Error('expected a citation on a relevant-leaf search');
    expect(c.on).toBe('normalized_text');
    expect(c.query).toBe(ANCHOR_PHRASE);
    expect(c.mode).toBe('threshold');
    expect(c.cutoff).toBe(THRESH);
    expect(c.match_count).toBe(expectedIds.length);
    // boundary.lowest_included always present; highest_excluded is ON-REQUEST and the search DTO
    // exposes no `citation:{boundary}` knob → it must be absent over this REST path.
    expect(c.boundary.lowest_included).toBeDefined();
    expect(c.boundary.highest_excluded).toBeUndefined();
  });

  // ── 2. CITATION EXEMPLARS WITH SIMILARITY (id + score) match the SQL top-N by similarity ────────
  it('R2 citation exemplars == SQL top-N by similarity; scores match to 6 places', async () => {
    const THRESH = 0.5; // a large cohort — exemplars are still just the top few by sim
    const simExpr = sql`(1 - (observations.embedding <=> ${anchorLit}::vector))`;

    const matchCountRow = await db.execute(
      sql`select count(*)::int as n from observations where ${simExpr} >= ${THRESH}`,
    );
    const expectedMatchCount = Number((matchCountRow.rows[0] as { n: number }).n);

    // The top-4 (DEFAULT_EXEMPLARS) members by similarity desc, id asc.
    const topN = await db.execute(
      sql`select id, ${simExpr} as s from observations
          where ${simExpr} >= ${THRESH}
          order by observations.embedding <=> ${anchorLit}::vector asc, id asc
          limit 4`,
    );
    const expected = (topN.rows as Array<{ id: string; s: number }>).map((r) => ({
      id: r.id,
      similarity: Number(r.s),
    }));

    const body = searchPipe.transform(
      {
        filter: { on: 'normalized_text', op: 'relevant', query: ANCHOR_PHRASE, threshold: THRESH },
      },
      META,
    );
    const res = await controller.search('observations', body);
    if ('results' in res) throw new Error('expected single-entity search result');
    const c = res.citation;
    if (!c) throw new Error('expected a citation');

    expect(c.match_count).toBe(expectedMatchCount);
    expect(c.exemplars.map((e) => e.id)).toEqual(expected.map((e) => e.id));
    c.exemplars.forEach((ex, i) => {
      expect(ex.similarity).toBeCloseTo(expected[i]!.similarity, 6);
      expect(typeof ex.snippet).toBe('string');
      expect(ex.full_length).toBeGreaterThanOrEqual(0);
    });
    // The strongest exemplar is the anchor itself (similarity ≈ 1).
    expect(c.exemplars[0]!.similarity).toBeCloseTo(1, 6);
  });

  // ── 3. TOP_K mode: cohort == ORDER BY emb<=>q LIMIT k; citation mode flips to top_k ─────────────
  it('R3 top_k relevant leaf → ids == SQL ORDER BY similarity LIMIT k; citation.mode==top_k', async () => {
    const K = 10;

    const top = await db.execute(
      sql`select id from observations
          order by observations.embedding <=> ${anchorLit}::vector asc, id asc
          limit ${K}`,
    );
    const expectedIds = (top.rows as Array<{ id: string }>).map((r) => r.id).sort();
    expect(expectedIds.length).toBe(K);

    const body = searchPipe.transform(
      { filter: { on: 'normalized_text', op: 'relevant', query: ANCHOR_PHRASE, top_k: K } },
      META,
    );
    const res = await controller.search('observations', body);
    if ('results' in res) throw new Error('expected single-entity search result');

    expect([...res.ids].sort()).toEqual(expectedIds);
    expect(res.total).toBe(K);

    const c = res.citation;
    if (!c) throw new Error('expected a citation on a top_k relevant leaf');
    expect(c.mode).toBe('top_k');
    expect(c.match_count).toBe(K);
    // cutoff = the weakest (k-th) member's similarity.
    const kth = await db.execute(
      sql`select ${sql`(1 - (observations.embedding <=> ${anchorLit}::vector))`} as s
          from observations
          order by observations.embedding <=> ${anchorLit}::vector asc, id asc
          limit 1 offset ${K - 1}`,
    );
    const expectedCutoff = Number((kth.rows[0] as { s: number }).s);
    expect(c.cutoff).toBeCloseTo(expectedCutoff, 6);
  });

  // ── 4. AGGREGATE REST path: a top-level relevant filter → grouped count + citation, embed fired ─
  it('R4 aggregate(count) under a relevant threshold filter → row count == SQL cohort; citation present', async () => {
    const THRESH = 0.5;
    const simExpr = sql`(1 - (observations.embedding <=> ${anchorLit}::vector))`;
    const countRow = await db.execute(
      sql`select count(*)::int as n from observations where ${simExpr} >= ${THRESH}`,
    );
    const expectedCount = Number((countRow.rows[0] as { n: number }).n);

    const before = embedCalls;
    const body = aggPipe.transform(
      {
        measures: [{ on: '*', agg: 'count', as: 'n' }],
        filter: { on: 'normalized_text', op: 'relevant', query: ANCHOR_PHRASE, threshold: THRESH },
      },
      META,
    );
    const res = await controller.aggregate('observations', body);

    // landmine (a) net-new on aggregate(): the collapse path embedded the cohort vector.
    expect(embedCalls).toBe(before + 1);
    expect(res.rows).toHaveLength(1); // no group_by → one global row
    expect(Number(res.rows[0]!.n)).toBe(expectedCount);

    const c = res.citation;
    if (!c) throw new Error('expected a citation on a relevant-filter aggregate');
    expect(c.mode).toBe('threshold');
    expect(c.cutoff).toBe(THRESH);
    expect(c.match_count).toBe(expectedCount);
  });

  // ── 5. XOR validation: exactly one of threshold|top_k — neither and both 400 at the front door ──
  it('R5 relevant leaf with NEITHER threshold nor top_k → 400 (BadRequestException) over the wire', async () => {
    const body = searchPipe.transform(
      { filter: { on: 'normalized_text', op: 'relevant', query: ANCHOR_PHRASE } },
      META,
    );
    await expect(controller.search('observations', body)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('R6 relevant leaf with BOTH threshold and top_k → 400 (BadRequestException) over the wire', async () => {
    const body = searchPipe.transform(
      {
        filter: {
          on: 'normalized_text',
          op: 'relevant',
          query: ANCHOR_PHRASE,
          threshold: 0.5,
          top_k: 10,
        },
      },
      META,
    );
    await expect(controller.search('observations', body)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
