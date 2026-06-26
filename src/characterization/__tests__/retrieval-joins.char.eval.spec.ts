// RETRIEVAL — belongs_to JOINs + has_many EXISTS (compiler.ts resolveFrom CORE).
//
// CHARACTERIZATION net: pins what the engine does TODAY for dotted-path filters,
// sorts, and projections through the relational graph. The graph (from
// schema.dealbrain relations()):
//   accounts        has_many opportunities, has_many observations
//   opportunities   belongs_to account (fk account_id), has_many observations
//   observations    belongs_to opportunity (fk opportunity_id),
//                   belongs_to account     (fk account_id)
//
// resolveFrom (compiler.ts) walks segments[0..n-2] as relationship hops, then
// resolves the final segment as a column / EAV value:
//   - belongs_to  → LEFT JOIN, advance to target, resolve final there
//   - has_many    → correlated EXISTS (semijoin) with the tail rooted at the child
//   - belongs_to → has_many  THROWS  ("belongs_to → has_many is not supported in path")
//   - has_many   → has_many  THROWS  ("has_many → has_many is not supported in path")
//
// All assertions go through the PUBLIC surface (h.service.query / fetch); each
// number is checked against a raw-SQL ground truth (the `truth` query is the
// comment above each expect).
//
//   DBURL=postgres://postgres:password@localhost:54321/dealbrain \
//     bun test src/characterization/retrieval-joins.char.eval.spec.ts

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { type QuerySurfaceHarness, makeQuerySurface } from '../harness.ts';

const DBURL = process.env.DBURL;
const suite = DBURL ? describe : describe.skip;

suite('retrieval (belongs_to JOIN + has_many EXISTS) — characterization', () => {
  let h: QuerySurfaceHarness;
  beforeAll(() => {
    h = makeQuerySurface(DBURL!);
  });
  afterAll(async () => {
    await h.close();
  });

  // Ground truth (rule 3): raw SQL via the SAME pool.
  const truth = async (q: string) =>
    (await h.db.execute(sql.raw(q))).rows as Record<string, unknown>[];
  const n = async (q: string) => Number((await truth(q))[0]?.n ?? 0);

  // ==========================================================================
  // belongs_to LEFT JOIN — 1 hop
  // ==========================================================================

  it('opportunities filtered by account.name (1-hop belongs_to LEFT JOIN)', async () => {
    // truth: select count(*) as n from opportunities o
    //        join accounts a on o.account_id=a.id where a.name='Abnormal Security'
    const want = await n(
      "select count(*) as n from opportunities o join accounts a on o.account_id=a.id where a.name='Abnormal Security'",
    );
    expect(want).toBe(1); // pin the live value (1 opportunity under Abnormal Security — Bean Maxx is 1 opp/account)

    const res = await h.service.select('opportunities', {
      filter: { on: 'account.name', op: 'eq', value: 'Abnormal Security' },
      page: { limit: 100 },
    });
    // total == EXISTS-free belongs_to count: the fk→pk join is single-row
    // (account_id → accounts.id), so the LEFT JOIN cannot inflate the count.
    expect(res.total).toBe(want);
    expect(res.ids.length).toBe(want);
  });

  it('opportunities sort by account.name surfaces the joined column (belongs_to JOIN for ORDER BY)', async () => {
    // The sort path forces the belongs_to join even with no filter on it.
    // truth: the first account name alphabetically that owns an opportunity.
    const firstName = String(
      (
        await truth(
          'select a.name as name from opportunities o join accounts a on o.account_id=a.id where a.name is not null order by a.name asc limit 1',
        )
      )[0]?.name,
    );
    const res = await h.service.select('opportunities', {
      sort: [{ field: 'account.name', dir: 'asc' }],
      columns: ['account.name'],
      page: { limit: 1 },
      preview: true,
    });
    // The projected dotted column is keyed by the EXACT string passed in columns.
    expect(res.preview?.[0]?.['account.name']).toBe(firstName);
  });

  // ==========================================================================
  // belongs_to LEFT JOIN — observations rooted, 1 hop on the *opportunity* edge
  // (a native opp column) AND the 2-hop diamond opportunity.account.name.
  // ==========================================================================

  it('observations filtered by opportunity.amount (EAV resolved through a belongs_to hop)', async () => {
    // The final segment 'Amount' has no native opp column → resolves through the
    // EAV field map for the CURRENT entity at that point (opportunities). So a
    // belongs_to hop lands on an EAV value column behind the field_values join.
    // Bean Maxx field key is 'Amount' (Salesforce-shaped, capitalized) — the EAV
    // field map is keyed by the exact field_definitions.key, case-sensitive.
    // truth (org-owned 'Amount' field_definition; value in field_values.value_number):
    const want = await n(
      "select count(*) as n from observations ob join opportunities o on ob.opportunity_id=o.id join field_values fv on fv.entity_id=o.id and fv.entity_type='opportunity' and fv.field_definition_id=(select id from field_definitions where key='Amount' and entity_type='opportunity' and organization_id='a30c290d-6798-4da7-b3af-7b48c50212b8') where fv.value_number > 50000",
    );
    expect(want).toBe(21953); // pin the live value

    const res = await h.service.select('observations', {
      filter: { on: 'opportunity.Amount', op: 'gt', value: 50000 },
      page: { limit: 30000 },
    });
    expect(res.total).toBe(want);
  });

  it('observations filtered by opportunity.account.name (2-hop belongs_to chain — the diamond, via-opportunity leg)', async () => {
    // observations → opportunity (belongs_to) → account (belongs_to) → name.
    // truth: every non-orphan observation's opportunity_id is populated
    // (29039/29092; 53 orphans carry NULL on BOTH fks), so the via-opportunity
    // leg reaches ALL observations for an account's opps.
    const want = await n(
      "select count(*) as n from observations ob join opportunities o on ob.opportunity_id=o.id join accounts a on o.account_id=a.id where a.name='Abnormal Security'",
    );
    expect(want).toBe(295); // pin the live value

    const res = await h.service.select('observations', {
      filter: { on: 'opportunity.account.name', op: 'eq', value: 'Abnormal Security' },
      page: { limit: 1000 },
    });
    expect(res.total).toBe(want);
  });

  // ==========================================================================
  // THE DIAMOND — observations→accounts resolves BOTH directly (obs.account_id)
  // and via opportunity (obs.opportunity_id → opp.account_id). Characterize
  // WHICH path the compiler takes for a dotted obs filter, and that the two can
  // DISAGREE.
  // ==========================================================================

  it('observations.account.name takes the DIRECT belongs_to (obs.account_id), and in Bean Maxx the symmetric diamond makes it COINCIDE with via-opportunity', async () => {
    // resolveFrom reads registry['observations'].relationships['account'] — the
    // DIRECT belongs_to (fk account_id) — so the dotted 'account.name' compiles
    // to a join on obs.account_id, never through opportunity.
    //
    // DIVERGENCE FROM OLD DEALBRAIN — the diamond no longer DISAGREES. In Bean
    // Maxx, every non-orphan observation carries BOTH a direct account_id AND an
    // opportunity_id pointing to the SAME account (29039/29092 populated on both,
    // 53 orphans NULL on both, 0 cross-linked). So the direct leg and the
    // via-opportunity leg return the IDENTICAL count for EVERY account — the
    // disagreement this test was built to characterize is absent from the fixture.
    // We still pin that the engine resolves the DIRECT edge (its count), but the
    // not.toBe(viaOpp) discrimination is data-impossible here and is replaced by
    // toBe(viaOpp), the genuine Bean Maxx relationship. — FLAGGED divergence.
    const direct = await n(
      "select count(*) as n from observations ob join accounts a on ob.account_id=a.id where a.name='Abnormal Security'",
    );
    const viaOpp = await n(
      "select count(*) as n from observations ob join opportunities o on ob.opportunity_id=o.id join accounts a on o.account_id=a.id where a.name='Abnormal Security'",
    );
    expect(direct).toBe(295); // Abnormal Security's observations carry the direct account_id
    expect(viaOpp).toBe(295); // …and reach the same account via their opportunity — they COINCIDE

    const res = await h.service.select('observations', {
      filter: { on: 'account.name', op: 'eq', value: 'Abnormal Security' },
      page: { limit: 1000 },
    });
    // The engine matches the DIRECT leg (obs.account_id); in Bean Maxx that
    // equals the via-opportunity leg because the diamond is symmetric.
    expect(res.total).toBe(direct);
    expect(res.total).toBe(viaOpp);
  });

  it('observations.account.name AGREES with via-opportunity when the direct account_id IS populated (Abridge)', async () => {
    // The diamond agrees wherever obs.account_id is populated. In Bean Maxx every
    // non-orphan observation carries BOTH a direct account_id and an opportunity
    // under the same account, so both legs return the same count. (Use a SECOND
    // account distinct from the test above to keep independent coverage.)
    // truth: direct == via_opp == 379 for Abridge.
    const direct = await n(
      "select count(*) as n from observations ob join accounts a on ob.account_id=a.id where a.name='Abridge'",
    );
    const viaOpp = await n(
      "select count(*) as n from observations ob join opportunities o on ob.opportunity_id=o.id join accounts a on o.account_id=a.id where a.name='Abridge'",
    );
    expect(direct).toBe(379);
    expect(viaOpp).toBe(379);

    const res = await h.service.select('observations', {
      filter: { on: 'account.name', op: 'eq', value: 'Abridge' },
      page: { limit: 1000 },
    });
    expect(res.total).toBe(direct);
  });

  // ==========================================================================
  // has_many EXISTS (semijoin) — must NOT inflate the parent count.
  // ==========================================================================

  it('accounts filtered by observations.type (has_many → correlated EXISTS; no fan-out)', async () => {
    // resolveFrom turns the has_many first hop into EXISTS(select 1 from
    // observations where observations.account_id = accounts.id and type='risk').
    // A naive JOIN would inflate (one parent row per child); EXISTS is a semijoin
    // so the parent count is DISTINCT parents.
    // truth: EXISTS = 100 distinct accounts; naive join = 2160 child rows.
    const exists = await n(
      "select count(*) as n from accounts a where exists (select 1 from observations ob where ob.account_id=a.id and ob.type='risk')",
    );
    const naiveJoinRows = await n(
      "select count(*) as n from accounts a join observations ob on ob.account_id=a.id where ob.type='risk'",
    );
    expect(exists).toBe(100); // Bean Maxx: every account has a 'risk' observation (all 100)
    expect(naiveJoinRows).toBe(2160); // a JOIN would over-count by ~21.6x (2160 risk obs across 100 accounts)

    const res = await h.service.select('accounts', {
      filter: { on: 'observations.type', op: 'eq', value: 'risk' },
      page: { limit: 500 },
    });
    // The engine reports DISTINCT parents (EXISTS), not the inflated join count.
    expect(res.total).toBe(exists);
    expect(res.total).not.toBe(naiveJoinRows);
    // ids are unique parent account ids — no duplicates from fan-out.
    expect(new Set(res.ids).size).toBe(res.ids.length);
    expect(res.ids.length).toBe(exists);
  });

  it('accounts filtered by opportunities.amount (has_many EXISTS with an EAV inner leg) — BROKEN SQL today', async () => {
    // CHARACTERIZATION OF A BUG (pinned as-is). The has_many → EXISTS tail can
    // resolve an EAV value column on the child opportunity, which puts an aliased
    // field_values join (alias 'fv_opportunities_amount') INSIDE the EXISTS. But
    // compileLeaf's has_many branch emits the inner join as a bare
    // `inner join ${j.table}` where j.table is the drizzle alias() — rendering
    // ONLY the alias NAME, never the `field_values AS fv_opportunities_Amount`
    // declaration. The generated SQL references a relation that is never
    // declared, so Postgres throws:
    //     relation "fv_opportunities_Amount" does not exist  (SQLSTATE 42P01)
    //
    // What it WOULD return if it worked: 71 accounts have an opportunity with
    // Amount > 50000 (truth below; Bean Maxx is 1 opp/account), so the intended
    // semijoin count is 71.
    const want = await n(
      "select count(*) as n from accounts a where exists (select 1 from opportunities o join field_values fv on fv.entity_id=o.id and fv.entity_type='opportunity' and fv.field_definition_id=(select id from field_definitions where key='Amount' and entity_type='opportunity' and organization_id='a30c290d-6798-4da7-b3af-7b48c50212b8') where o.account_id=a.id and fv.value_number>50000)",
    );
    expect(want).toBe(71); // the intended (currently-unreachable) count

    // SUSPECTED-DIVERGENCE: a has_many EXISTS whose inner (tail) leg resolves an
    // EAV value column emits SQL referencing an UNDECLARED field_values alias and
    // crashes at execution (42P01). The EAV alias is created via drizzle alias()
    // but the EXISTS clause is hand-rendered (`inner join ${aliasRef}`), so the
    // `original AS alias` declaration is lost. Native-column inner legs (e.g.
    // observations.type above) work; only the EAV inner leg is broken. Pinned
    // AS-IS — the refactor's IR must declare the alias inside the EXISTS. — revisit
    await expect(
      h.service.select('accounts', {
        filter: { on: 'opportunities.Amount', op: 'gt', value: 50000 },
        page: { limit: 500 },
      }),
    ).rejects.toThrow('fv_opportunities_Amount');
  });

  // ==========================================================================
  // REFUSALS — the unsupported traversal shapes throw at compile time.
  // ==========================================================================

  it('belongs_to → has_many THROWS (an EXISTS cannot correlate to an intermediate joined table)', async () => {
    // observations → opportunity (belongs_to, pushes a join) → observations
    // (has_many, but joins.length>0) → throws.
    await expect(
      h.service.select('observations', {
        filter: { on: 'opportunity.observations.type', op: 'eq', value: 'risk' },
      }),
    ).rejects.toThrow('belongs_to → has_many is not supported in path');
  });

  it('has_many → has_many THROWS (no nested correlation)', async () => {
    // accounts → opportunities (has_many) → observations (has_many) → throws.
    await expect(
      h.service.select('accounts', {
        filter: { on: 'opportunities.observations.type', op: 'eq', value: 'risk' },
      }),
    ).rejects.toThrow('has_many → has_many is not supported in path');
  });

  it('an invalid relationship segment THROWS a Field-path error', async () => {
    // 'widgets' is not a relationship on observations.
    await expect(
      h.service.select('observations', {
        filter: { on: 'widgets.name', op: 'eq', value: 'x' },
      }),
    ).rejects.toThrow('Field path');
  });

  it('cannot sort by a has_many path (THROWS)', async () => {
    await expect(
      h.service.select('accounts', {
        sort: [{ field: 'observations.type', dir: 'asc' }],
      }),
    ).rejects.toThrow('Cannot sort by has_many path');
  });

  // ==========================================================================
  // 'text' MAGIC fan-out across the entity's searchableColumns.
  // ==========================================================================

  it("'text' filter on observations fans out OR across [type, normalized_text] (searchableColumns)", async () => {
    // deriveSearchableColumns keeps string-typed columns that aren't id / *_id /
    // uuid / enum: on observations that is `type` (varchar) + `normalized_text`
    // (text). 'text' magic rewrites the leaf into OR(type contains X,
    // normalized_text contains X).
    // truth: OR over both columns.
    const want = await n(
      "select count(*) as n from observations where type ilike '%risk%' or normalized_text ilike '%risk%'",
    );
    const typeOnly = await n("select count(*) as n from observations where type ilike '%risk%'");
    expect(want).toBe(3233);
    expect(typeOnly).toBe(2429); // strictly less — proves normalized_text is also in the fan-out

    const res = await h.service.select('observations', {
      filter: { on: 'text', op: 'contains', value: 'risk' },
      page: { limit: 1000 },
    });
    expect(res.total).toBe(want);
    expect(res.total).toBeGreaterThan(typeOnly); // the fan-out adds normalized_text hits
  });

  it("'text' filter on accounts (single searchable column 'name') compiles to a single leaf", async () => {
    // accounts has exactly one searchable column (name) → expandTextMagic returns
    // a single {on:'name'} leaf, not an OR.
    // truth: accounts whose name ilike '%ai%' (Bean Maxx has no '%man%' match; 'ai'
    // matches 17 — a non-degenerate single-column substring on `name`).
    const want = await n("select count(*) as n from accounts where name ilike '%ai%'");
    expect(want).toBe(17);

    const res = await h.service.select('accounts', {
      filter: { on: 'text', op: 'contains', value: 'ai' },
      page: { limit: 500 },
    });
    expect(res.total).toBe(want);
  });

  // ==========================================================================
  // fetch() exercises the SAME belongs_to JOIN compile path via expand.
  // ==========================================================================

  it('fetch() with expand hydrates a belongs_to parent inline', async () => {
    // First narrow to a few observation ids under a known opportunity, then fetch
    // + expand the belongs_to 'opportunity'. The expand path goes through the
    // same relationship graph the compiler walks.
    const oppRow = (
      await truth(
        'select id::text as id from opportunities where account_id is not null order by id limit 1',
      )
    )[0] as { id: string };
    const obsIds = (
      await truth(
        `select id::text as id from observations where opportunity_id='${oppRow.id}' order by id limit 3`,
      )
    ).map((r) => String(r.id));
    // Only assert when this opportunity actually has observations (data-shape guard).
    if (obsIds.length === 0) return;

    const fetched = await h.service.fetch('observations', obsIds, { expand: ['opportunity'] });
    expect(fetched.count).toBe(obsIds.length);
    // Each fetched row carries the expanded belongs_to parent keyed by the
    // relationship name 'opportunity'.
    const first = fetched.rows[0] as Record<string, unknown>;
    const parent = first.opportunity as Record<string, unknown> | undefined;
    expect(parent).toBeDefined();
    expect(String(parent?.id)).toBe(oppRow.id);
  });
});
