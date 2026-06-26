// CHARACTERIZATION NET — RETRIEVAL: rank_by + window measures.
//
// Pins what query() does TODAY for the retrieval primitives:
//   • LEXICAL rank_by — ts_rank_cd ordering (OR-semantics tsquery), _snippet via
//     ts_headline, min_score cutoff (the uncalibrated warning), columns honored.
//   • partition_by    — per-group top-K (ROW_NUMBER() <= K), null-partition rows
//     dropped, total = group count, partition field projected onto rows.
//   • SEMANTIC rank_by — cosine over observations.embedding (harness embed stub):
//     a row matching its own stored embedding ranks #1 with _rank ≈ 1; _rank
//     present + descending; no _snippet for semantic.
//   • WINDOW measures — agg(col) OVER (PARTITION BY …) projected onto preview
//     rows, grain PRESERVED (no GROUP BY collapse).
//
// Asserted through the PUBLIC surface (QueryApplicationService via the shared
// harness). Ground truth (rule 3) is computed with raw SQL through the SAME pool
// and captured in comments next to each assertion.
//
// Run WITH the DB:
//   cd packages/query-surface && DBURL=postgres://postgres:password@localhost:54321/dealbrain \
//     bun test src/characterization/retrieval-rank-window.char.eval.spec.ts

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { type QuerySurfaceHarness, makeQuerySurface } from '../harness.ts';

const DBURL = process.env.DBURL;
const suite = DBURL ? describe : describe.skip;

suite('retrieval rank_by + window — characterization', () => {
  let h: QuerySurfaceHarness;
  beforeAll(() => {
    h = makeQuerySurface(DBURL!);
  });
  afterAll(async () => {
    await h.close();
  });

  // ground truth (rule 3): raw SQL via the SAME pool
  const truth = async (q: string) =>
    (await h.db.execute(sql.raw(q))).rows as Record<string, unknown>[];

  // The engine's lexical tsquery: plainto_tsquery with its implicit AND (' & ')
  // rewritten to OR (' | '), against to_tsvector('english', col::text). Used as
  // the ground-truth scoring expression for every lexical assertion below.
  const TSQ = (phrase: string) =>
    `replace(plainto_tsquery('english','${phrase}')::text,' & ',' | ')::tsquery`;
  const RANK = (phrase: string) =>
    `ts_rank_cd(to_tsvector('english', normalized_text), ${TSQ(phrase)})`;

  // ---------------------------------------------------------------------------
  // LEXICAL rank_by — ts_rank_cd ordering + _snippet + columns
  // ---------------------------------------------------------------------------
  it('lexical rank_by: _rank is the ts_rank_cd score, descending; _snippet headlines the match', async () => {
    const PHRASE = 'minimum commitment';
    const res = await h.service.select('observations', {
      rank_by: { method: 'lexical', on: 'normalized_text', query: PHRASE, limit: 8 },
      preview: true,
      columns: ['type'],
    });

    // Default behaviour for observations would be SEMANTIC (it has a registered
    // embedding column), so method:'lexical' is REQUIRED to exercise FTS here.
    expect(res.preview).toBeDefined();
    const rows = res.preview ?? [];
    expect(rows.length).toBe(8); // rb.limit caps the flat result

    // _rank present on every row; columns:['type'] honoured; id always present.
    for (const r of rows) {
      expect(typeof r._rank).toBe('number');
      expect(r.id).toBeDefined();
      expect(r).toHaveProperty('type');
    }

    // _rank is monotonically non-increasing (ORDER BY ts_rank DESC).
    // SUSPECTED-DIVERGENCE: the engine ORDER BY is `ts_rank desc` with NO
    // secondary tiebreak — ties (rampant: 147 rows share 0.2, 2776 share 0.1)
    // order non-deterministically, so WHICH rows land in the top-K is unstable
    // across runs. We only pin the score ordering, not row identity. — revisit
    const ranks = rows.map((r) => Number(r._rank));
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeLessThanOrEqual(ranks[i - 1]);
    }

    // Ground truth: the maximum ts_rank for this phrase across all observations.
    // truth: select max(<RANK>) from observations where normalized_text is not null
    const [{ m }] = await truth(
      `select round(max(${RANK(PHRASE)})::numeric, 6) as m from observations where normalized_text is not null`,
    );
    // The top returned row must carry that maximum score (it's ORDER BY rank DESC).
    expect(Number(rows[0]._rank)).toBeCloseTo(Number(m), 6);

    // _snippet is the ts_headline — present for lexical, and (for any row that
    // actually matched, _rank>0) wraps the matched lexemes in <b>…</b>.
    const matched = rows.filter((r) => Number(r._rank) > 0);
    expect(matched.length).toBeGreaterThan(0);
    for (const r of matched) {
      expect(typeof r._snippet).toBe('string');
      expect(String(r._snippet)).toContain('<b>');
    }
    // No warning when min_score is absent.
    expect(res.warnings).toBeUndefined();
  });

  it('lexical rank_by min_score: ts_rank cutoff filters candidates + emits the uncalibrated warning', async () => {
    const PHRASE = 'minimum commitment';

    // Ground truth: rows whose ts_rank >= 0.4 (the cutoff). The engine applies
    // `<RANK> >= min_score` as an extra WHERE — limit only caps the survivors.
    // truth: select count(*) ... where <RANK> >= 0.4  → 4
    const [{ c: c04 }] = await truth(
      `select count(*) as c from observations where normalized_text is not null and ${RANK(PHRASE)} >= 0.4`,
    );
    expect(Number(c04)).toBe(4);

    const res = await h.service.select('observations', {
      rank_by: {
        method: 'lexical',
        on: 'normalized_text',
        query: PHRASE,
        min_score: 0.4,
        limit: 100,
      },
      preview: true,
    });
    expect(res.ids.length).toBe(4); // matches the 0.4-cutoff ground truth
    for (const r of res.preview ?? []) expect(Number(r._rank)).toBeGreaterThanOrEqual(0.4);

    // The uncalibrated-min_score warning rides on the result for lexical.
    expect(res.warnings).toEqual([
      'min_score is uncalibrated for lexical ranking (ts_rank scores are not normalized); prefer limit',
    ]);

    // And the cutoff is a strict >= : at 0.5 there are ZERO survivors (the max
    // ts_rank for this phrase across the corpus is 0.4).
    // truth: select count(*) ... where <RANK> >= 0.5  → 0
    const [{ c: c05 }] = await truth(
      `select count(*) as c from observations where normalized_text is not null and ${RANK(PHRASE)} >= 0.5`,
    );
    expect(Number(c05)).toBe(0);
    const res2 = await h.service.select('observations', {
      rank_by: {
        method: 'lexical',
        on: 'normalized_text',
        query: PHRASE,
        min_score: 0.5,
        limit: 100,
      },
      preview: true,
    });
    expect(res2.ids.length).toBe(0);
  });

  it('lexical rank_by ignores any sort, with a warning that rank_by owns ordering', async () => {
    const res = await h.service.select('observations', {
      rank_by: { method: 'lexical', on: 'normalized_text', query: 'minimum commitment', limit: 5 },
      sort: [{ field: 'occurred_at', dir: 'asc' }],
      preview: true,
    });
    // The sort warning rides alongside (the result is still rank-ordered).
    expect(res.warnings).toContain('sort ignored: rank_by owns ordering');
  });

  // ---------------------------------------------------------------------------
  // partition_by — per-group top-K (ROW_NUMBER <= K), null partition dropped
  // ---------------------------------------------------------------------------
  it('partition_by: per-group top-K keeps K rows per non-null group; null-partition rows dropped; total = group count', async () => {
    const K = 2;
    const res = await h.service.select('observations', {
      rank_by: {
        method: 'lexical',
        on: 'normalized_text',
        query: 'discovery commitment',
        partition_by: 'account_id',
        limit: K,
      },
      preview: true,
      columns: ['type'],
    });

    // total reports the number of GROUPS (count(distinct partition key)), NOT a
    // candidate row count.
    // truth: select count(distinct account_id) from observations where account_id is not null → 100
    const [{ g }] = await truth(
      'select count(distinct account_id) as g from observations where account_id is not null',
    );
    expect(res.total).toBe(Number(g));
    expect(res.total).toBe(100);

    // Row count = sum over non-null-account groups of min(K, group_size). Because
    // rank_by does NOT filter the candidate set (no min_score), EVERY non-null
    // observation is a ranking candidate — so every group has >= K rows here.
    // SUSPECTED-DIVERGENCE: the `query` text on a partitioned lexical rank only
    // ORDERS within each group — it does NOT restrict candidates. So partition_by
    // returns the top-K *observations per account* regardless of relevance; rows
    // with _rank=0 (no lexical match at all) are returned. — revisit
    // truth: select sum(least(2,c)) from (select account_id,count(*) c from
    //   observations where account_id is not null group by account_id) t → 200
    const [{ n }] = await truth(
      `select sum(least(${K}, c)) as n from (select account_id, count(*) c from observations where account_id is not null group by account_id) t`,
    );
    const rows = res.preview ?? [];
    expect(rows.length).toBe(Number(n));
    expect(rows.length).toBe(200);

    // Null-partition rows are dropped: every returned row carries a non-null
    // partition key, and the partition field is PROJECTED onto each row (so the
    // consumer can reassemble groups) even though columns:['type'] omitted it.
    for (const r of rows) {
      expect(r.account_id).not.toBeNull();
      expect(r.account_id).toBeDefined();
      expect(r).toHaveProperty('type'); // requested column still present
      expect(typeof r._rank).toBe('number');
    }

    // At most K rows per account (ROW_NUMBER() <= K).
    const perGroup = new Map<string, number>();
    for (const r of rows) {
      const key = String(r.account_id);
      perGroup.set(key, (perGroup.get(key) ?? 0) + 1);
    }
    for (const count of perGroup.values()) expect(count).toBeLessThanOrEqual(K);

    // Partitioned has_more is "the flat cap clipped the result" — here it didn't
    // (92 < the partitioned flat cap of 500), so has_more is false.
    expect(res.has_more).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // SEMANTIC rank_by — cosine over observations.embedding (harness embed stub)
  // ---------------------------------------------------------------------------
  it('semantic rank_by: a row matching its own stored embedding ranks #1 with _rank ≈ 1; _rank descending; no _snippet', async () => {
    // The harness embed stub returns the REAL stored embedding for an obs whose
    // normalized_text ILIKE %phrase%, so that obs is at cosine distance 0 →
    // similarity 1 → ranks #1.
    const PHRASE = 'a minimum billing commitment';

    // Ground truth: the obs the stub will resolve the vector from (order by id,
    // first ILIKE match) — that exact row must come back ranked #1.
    // truth: select id from observations where embedding is not null and
    //   normalized_text ilike '%<phrase>%' order by id limit 1
    const [{ id: sourceId }] = await truth(
      `select id from observations where embedding is not null and normalized_text is not null and normalized_text ilike '%${PHRASE}%' order by id limit 1`,
    );

    const res = await h.service.select('observations', {
      rank_by: { method: 'semantic', query: PHRASE, limit: 3 },
      preview: true,
    });
    const rows = res.preview ?? [];
    expect(rows.length).toBe(3);

    // #1 is the source obs, similarity ≈ 1 (1 - cosine_distance(v,v) = 1).
    expect(res.ids[0]).toBe(String(sourceId));
    expect(Number(rows[0]._rank)).toBeCloseTo(1, 5);

    // _rank present + descending (ORDER BY similarity DESC).
    const ranks = rows.map((r) => Number(r._rank));
    for (const r of ranks) expect(typeof r).toBe('number');
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeLessThanOrEqual(ranks[i - 1]);
    }

    // NO _snippet for semantic ranking (there is no keyword to headline).
    for (const r of rows) expect(r._snippet).toBeUndefined();

    // No uncalibrated warning for semantic (cosine IS in [0,1]).
    expect(res.warnings).toBeUndefined();
  });

  it('semantic rank_by min_score: cosine cutoff is calibrated (NO uncalibrated warning)', async () => {
    const res = await h.service.select('observations', {
      rank_by: {
        method: 'semantic',
        query: 'a minimum billing commitment',
        min_score: 0.5,
        limit: 5,
      },
      preview: true,
    });
    // Unlike lexical, a semantic min_score emits no uncalibrated warning.
    expect(res.warnings).toBeUndefined();
    // Non-vacuity: the source obs (cosine sim 1) + its near-neighbours clear the
    // 0.5 cutoff, so survivors exist — the >= 0.5 assertion isn't vacuously true.
    expect((res.preview ?? []).length).toBeGreaterThan(0);
    for (const r of res.preview ?? []) expect(Number(r._rank)).toBeGreaterThanOrEqual(0.5);
  });

  // ---------------------------------------------------------------------------
  // WINDOW measures — agg(col) OVER (PARTITION BY …), grain preserved
  // ---------------------------------------------------------------------------
  it('window count(*) OVER (PARTITION BY type): each row annotated with its group total, grain preserved', async () => {
    // Filter to one type so every returned row shares a partition; the window
    // total must equal that type's full population (the window FROM is the whole
    // table, not the page).
    const res = await h.service.select('observations', {
      window: [{ on: '*', agg: 'count', partition_by: ['type'], as: 'type_total' }],
      filter: { on: 'type', op: 'eq', value: 'discovery' },
      preview: true,
      columns: ['type'],
      page: { limit: 3 },
    });

    const rows = res.preview ?? [];
    // Grain PRESERVED: no GROUP BY collapse — we get individual rows (page limit 3).
    expect(rows.length).toBe(3);

    // Ground truth: count of 'discovery' observations.
    // truth: select count(*) from observations where type = 'discovery' → 2697
    const [{ c }] = await truth(`select count(*) as c from observations where type = 'discovery'`);
    expect(Number(c)).toBe(2697);

    for (const r of rows) {
      expect(r.type).toBe('discovery');
      // SUSPECTED-DIVERGENCE: window count(*) comes back as a STRING ('792'),
      // not a number — Postgres count() is bigint and the driver returns bigint
      // as text; the window-measure path does no numeric coercion. (aggregate()
      // measures are coerced; window measures are not.) — revisit
      // Pin the TYPE (string), not just the value, so the divergence is frozen.
      expect(typeof r.type_total).toBe('string');
      expect(r.type_total).toBe('2697');
    }
  });

  it('window OVER (no partition_by): aggregates over the whole filtered set', async () => {
    // Empty partition_by → `count(*) over ()` = grand total of the filtered set.
    const res = await h.service.select('observations', {
      window: [{ on: '*', agg: 'count', partition_by: [], as: 'grand_total' }],
      filter: { on: 'type', op: 'eq', value: 'timeline' },
      preview: true,
      columns: ['type'],
      page: { limit: 2 },
    });
    // truth: select count(*) from observations where type = 'timeline' → 942
    const [{ c }] = await truth(`select count(*) as c from observations where type = 'timeline'`);
    expect(Number(c)).toBe(942);
    for (const r of res.preview ?? []) {
      // SUSPECTED-DIVERGENCE (same as type_total above): bigint window count
      // comes back as a STRING, not coerced to number. Pin the type, not just
      // the value. — revisit
      expect(typeof r.grand_total).toBe('string');
      expect(r.grand_total).toBe('942');
    }
  });

  it('window measures are PREVIEW-ONLY: omitted from the row when preview is false', async () => {
    const res = await h.service.select('observations', {
      window: [{ on: '*', agg: 'count', partition_by: ['type'], as: 'type_total' }],
      filter: { on: 'type', op: 'eq', value: 'discovery' },
      // no preview → ids only, no annotated rows
      page: { limit: 3 },
    });
    expect(res.preview).toBeUndefined();
    expect(res.ids.length).toBe(3);
  });
});
