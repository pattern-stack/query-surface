// RETRIEVAL — EAV resolution (Shape A, typed columns) — CHARACTERIZATION net.
//
// Pins what the engine ACTUALLY does today when filtering / sorting / projecting
// an EAV field through the public surface (query / fetch / describe), so the
// upcoming dialect-neutral IR + QueryBackend port refactor has a frozen contract
// to preserve. This is NOT aspirational — where the engine looks buggy, the
// behavior is still pinned AS-IS and tagged // SUSPECTED-DIVERGENCE.
//
// Area scope (Shape A only — dealbrain's only EAV shape):
//   opportunities carries `eav: { kind:'typed-columns', valueTable: field_values,
//   entityTypeValue:'opportunity' }`. A field key like `Amount` (money) or
//   `Probability` (percentage) resolves to a typed value column
//   (value_number) behind a LEFT JOIN to field_values keyed on
//   (entity_id, entity_type, field_definition_id). See compiler.ts resolveFrom
//   final-segment branch + eav/mapping.ts.
//
// Run WITH the live DB:
//   cd packages/query-surface && \
//   DBURL=postgres://postgres:password@localhost:54321/dealbrain \
//   bun test src/characterization/retrieval-eav.char.eval.spec.ts

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { type QuerySurfaceHarness, makeQuerySurface } from '../harness.ts';

const DBURL = process.env.DBURL;
const suite = DBURL ? describe : describe.skip;

// The org that owns Bean Maxx's opportunity field_definitions (org-owned defs,
// user_id NULL). Used to scope the ground-truth field_definition_id lookups so
// the SQL truth matches the engine's actor-scoped EAV resolution. Equals
// harness DEALBRAIN_ORG.
const ORG = 'a30c290d-6798-4da7-b3af-7b48c50212b8';
const defId = (key: string) =>
  `(select id from field_definitions where entity_type='opportunity' and key='${key}' and organization_id='${ORG}')`;

suite('retrieval — EAV (Shape A typed-columns) — characterization', () => {
  let h: QuerySurfaceHarness;
  beforeAll(() => {
    h = makeQuerySurface(DBURL!);
  });
  afterAll(async () => {
    await h.close();
  });

  // Ground truth (rule 3): raw SQL through the SAME pool.
  const truth = async (q: string) =>
    (await h.db.execute(sql.raw(q))).rows as Record<string, unknown>[];
  const n = (v: unknown) => Number(v);

  // --- FILTER through an EAV field ---------------------------------------------

  it('filters opportunities on the EAV `Amount` (money) key — count matches field_values truth', async () => {
    // TRUTH: opportunities with a value_number > 0 for the `Amount` field_definition.
    const [{ n: gt0 }] = await truth(
      `select count(*)::int as n from opportunities o
         join field_values fv on fv.entity_id=o.id and fv.entity_type='opportunity'
           and fv.field_definition_id=${defId('Amount')}
        where fv.value_number > 0`,
    ).then((r) => r as Array<{ n: number }>);

    const res = await h.service.query('opportunities', {
      filter: { on: 'Amount', op: 'gt', value: 0 },
      page: { limit: 500 },
    });

    // Pinned live (Bean Maxx): 95.
    expect(res.total).toBe(95);
    expect(res.total).toBe(gt0);
    expect(res.ids.length).toBe(gt0);
  });

  it('EAV filter emits a field_values LEFT JOIN (the resolution seam)', async () => {
    const res = await h.service.query('opportunities', {
      filter: { on: 'Amount', op: 'gt', value: 0 },
      page: { limit: 1 },
      include_sql: true,
    });
    expect(res.sql).toMatch(/field_values/);
  });

  it('coerces a JSON number against a money EAV field — `gte 0` = rows with any non-null amount', async () => {
    // The value column is numeric (drizzle string), but the field-definition
    // data_type (money) carries the coercion hint, so a JS number filter works.
    const [{ n: nonNull }] = (await truth(
      `select count(*)::int as n from opportunities o
         join field_values fv on fv.entity_id=o.id and fv.entity_type='opportunity'
           and fv.field_definition_id=${defId('Amount')}
        where fv.value_number is not null and fv.value_number >= 0`,
    )) as Array<{ n: number }>;
    const res = await h.service.query('opportunities', {
      filter: { on: 'Amount', op: 'gte', value: 0 },
      page: { limit: 500 },
    });
    expect(res.total).toBe(nonNull);
    expect(res.total).toBe(95); // none are exactly 0 → same as gt 0
  });

  it('percentage EAV (`Probability`) is stored on a 0..100 scale — filter compares against the stored scale', async () => {
    // Bean Maxx stores Probability as a whole-number percentage (0, 35, 55, 80, 100
    // — NOT the old dealbrain 0..1 fraction), so a caller filters by 50 (not 0.5) to
    // mean "≥ 50%". The engine compares against the raw stored value with NO scale
    // normalization — the caller must know the stored scale. Intent preserved: "≥ 50%".
    const [{ n: ge }] = (await truth(
      `select count(*)::int as n from opportunities o
         join field_values fv on fv.entity_id=o.id and fv.entity_type='opportunity'
           and fv.field_definition_id=${defId('Probability')}
        where fv.value_number >= 50`,
    )) as Array<{ n: number }>;
    const res = await h.service.query('opportunities', {
      filter: { on: 'Probability', op: 'gte', value: 50 },
      page: { limit: 500 },
    });
    expect(res.total).toBe(29);
    expect(res.total).toBe(ge);
  });

  // --- SORT by an EAV field ----------------------------------------------------

  it('sorts opportunities by the EAV `Amount` desc — top row matches SQL truth', async () => {
    // Bean Maxx has a TIE at the max Amount (293000 appears on 2 opportunities), and
    // the engine's sort emits NO secondary tie-break — just `order by value_number
    // desc nulls last limit 1` (verified in include_sql). The two tied rows sort by
    // physical heap order, which empirically resolves to the lexically-lower UUID
    // (376945a9… < f4d3f237…). The SQL truth below mirrors that with an explicit
    // `o.id asc` tie-break so the assertion stays deterministic against the engine's
    // observed output. — see divergences (no engine tie-break is a fragility carried
    // over by the dense Bean Maxx fixture's tie at the top).
    const top = (await truth(
      `select o.id, fv.value_number as amount from opportunities o
         join field_values fv on fv.entity_id=o.id and fv.entity_type='opportunity'
           and fv.field_definition_id=${defId('Amount')}
        where fv.value_number is not null
        order by fv.value_number desc, o.id asc limit 1`,
    )) as Array<{ id: string; amount: string }>;

    const res = await h.service.query('opportunities', {
      // NB: Sort uses `field`, not `on` (types.ts Sort).
      sort: [{ field: 'Amount', dir: 'desc' }],
      page: { limit: 1 },
      preview: true,
      columns: ['Amount'],
    });
    expect(res.ids[0]).toBe(top[0]!.id);
    // Pinned live (Bean Maxx): the highest-Amount opportunity (tie resolved to the
    // lexically-lower UUID).
    expect(res.ids[0]).toBe('376945a9-6a3d-575d-8399-8eb8d1d0f4a9');
    expect(n(res.preview?.[0]?.Amount)).toBe(293000);
  });

  // --- PROJECT an EAV field (preview) ------------------------------------------

  it('projects EAV keys into preview rows, keyed by the requested key', async () => {
    const res = await h.service.query('opportunities', {
      filter: { on: 'Amount', op: 'gt', value: 0 },
      page: { limit: 3 },
      preview: true,
      columns: ['Amount', 'Name'],
    });
    expect(res.preview).toBeDefined();
    for (const row of res.preview ?? []) {
      expect(row).toHaveProperty('Amount');
      expect(row).toHaveProperty('Name');
    }
  });

  it('preview returns a numeric EAV value as a STRING (no numeric decode on the query path)', async () => {
    // SUSPECTED-DIVERGENCE: query() preview projects the raw drizzle numeric
    // (a JS string), e.g. Amount = "293000", while fetch() hydration decodes the
    // same field to a JS number 293000 (see hydrateEavRows / extractTypedValue).
    // Two EAV read paths, two output types for the same field. Pinned as-is. — revisit
    const res = await h.service.query('opportunities', {
      sort: [{ field: 'Amount', dir: 'desc' }],
      page: { limit: 1 },
      preview: true,
      columns: ['Amount'],
    });
    expect(typeof res.preview?.[0]?.Amount).toBe('string');
    expect(res.preview?.[0]?.Amount).toBe('293000');
  });

  // --- FETCH hydrates EAV inline ----------------------------------------------

  it('fetch hydrates EAV cells inline (decoded to native types) alongside native columns', async () => {
    const ID = '376945a9-6a3d-575d-8399-8eb8d1d0f4a9'; // the max-Amount opportunity
    const f = await h.service.fetch('opportunities', [ID]);
    expect(f.count).toBe(1);
    const row = f.rows[0]!;
    // EAV fields appear inline, indistinguishable from native columns.
    expect(row.Amount).toBe(293000); // decoded to a NUMBER here (contrast preview)
    expect(typeof row.Amount).toBe('number');
    expect(row.Name).toBe('Cyera - Secure Office Coffee Analytics Global Rollout');

    // Hydration is value-presence driven: the EAV keys with a stored field_value row
    // for THIS entity are merged in. Bean Maxx is a DENSE fixture — every opportunity
    // carries a field_value row for ALL 60 visible keys (verified: min=max=60 rows/opp,
    // so the old "visible-but-unset key is absent" negative case is undemonstrable in
    // this seed — see divergences). The exact-SET assertion below is STRONGER than the
    // old positive-only loop: it pins that the hydrated EAV-key set EQUALS the SQL
    // visible-key set with NO missing and NO fabricated keys.
    const [{ keys }] = (await truth(
      `select array_agg(fd.key order by fd.key) as keys
         from field_values fv
         join field_definitions fd on fd.id=fv.field_definition_id
        where fv.entity_type='opportunity' and fv.entity_id='${ID}'
          and fd.organization_id='${ORG}' and fd.is_visible=true`,
    )) as Array<{ keys: string[] }>;
    expect(keys.length).toBe(60); // dense: all 60 visible EAV keys have a value row
    const nativeKeys = new Set(['id', 'account_id', 'state_of_deal_status']);
    const hydratedEavKeys = new Set(Object.keys(row).filter((k) => !nativeKeys.has(k)));
    expect(hydratedEavKeys).toEqual(new Set(keys)); // exact: no missing, no fabricated
    for (const key of keys) expect(row).toHaveProperty(key);

    // Presence-driven hydration does NOT fabricate keys: an EAV key with no stored
    // field_value row for this entity is absent. (Bean Maxx has no visible-but-unset
    // key, so this is exercised with a key that has NO field_value row at all.)
    expect(Object.hasOwn(row, 'closed_lost_reason')).toBe(false);

    // Native columns are ALWAYS present (selected directly, not hydrated):
    // state_of_deal_status / account_id / id appear even when null.
    expect(row).toHaveProperty('state_of_deal_status');
    expect(row).toHaveProperty('account_id');
    expect(row.id).toBe(ID);
  });

  // --- SINGLE-ROW JOIN INVARIANT (no fan) -------------------------------------

  it('EAV join stays 1 row per field — no fan-out (ids are distinct, count == matches)', async () => {
    // TRUTH: field_values is unique per (entity_id, entity_type, field_definition_id)
    // → the LEFT JOIN can never multiply a parent row.
    const [{ mx }] = (await truth(
      `select max(c)::int as mx from (
         select entity_id, field_definition_id, count(*) c
           from field_values where entity_type='opportunity'
          group by entity_id, field_definition_id) t`,
    )) as Array<{ mx: number }>;
    expect(mx).toBe(1); // the storage invariant the engine relies on

    const res = await h.service.query('opportunities', {
      filter: { on: 'Amount', op: 'gte', value: 0 },
      page: { limit: 500 },
    });
    // No duplication: distinct id count == returned id count == total.
    expect(new Set(res.ids).size).toBe(res.ids.length);
    expect(res.ids.length).toBe(res.total);
    expect(res.total).toBe(95);
  });

  // --- NATIVE-OVER-EAV PRECEDENCE ---------------------------------------------

  it('a native column resolves natively (NO field_values join) — the same-key precedence rule, native side', async () => {
    // compiler.ts resolveFrom final-segment: a native entity-row column ALWAYS
    // wins; only keys with no native column fall through to the EAV field map.
    // `state_of_deal_status` is a native opportunities column — filtering on it
    // must NOT emit a field_values join. (In Bean Maxx every opportunity carries a
    // non-null native status, so the is_null predicate genuinely matches ZERO rows;
    // the assertion under test is the native-resolution seam, not the count.)
    const res = await h.service.query('opportunities', {
      filter: { on: 'state_of_deal_status', op: 'is_null' },
      page: { limit: 1 },
      include_sql: true,
    });
    expect(res.sql).not.toMatch(/field_values/);
    // No Bean Maxx opportunity has a null native status.
    const [{ n: all }] = (await truth(
      'select count(*)::int as n from opportunities where state_of_deal_status is null',
    )) as Array<{ n: number }>;
    expect(res.total).toBe(all);
    expect(res.total).toBe(0);
  });

  it('describe() reports an EAV-only field with eav:true and field_definition-sourced mechanics', async () => {
    const cat = await h.service.describe('opportunities');
    const amount = cat.fields.find((f) => f.key === 'Amount');
    expect(amount).toBeDefined();
    expect(amount?.eav).toBe(true);
    expect(amount?.type).toBe('number'); // money → number (columnTypeFromDataType)
    expect(amount?.column).toBeUndefined(); // no backing native column
    expect(amount?.sources?.type).toBe('field_definition');

    // A native column is eav:false with a backing camelCase column.
    const status = cat.fields.find((f) => f.key === 'state_of_deal_status');
    expect(status?.eav).toBe(false);
    expect(status?.column).toBe('stateOfDealStatus');

    // Live shape (Bean Maxx): 60 visible EAV keys + 4 native catalog fields = 64 total.
    const eavCount = cat.fields.filter((f) => f.eav).length;
    expect(eavCount).toBe(60);
    expect(cat.fields.filter((f) => !f.eav).length).toBe(4);
    expect(cat.fields.length).toBe(64);
  });

  it('an EAV key absent from the query surface is unresolvable on query/fetch (curation gate)', async () => {
    // query/fetch EAV is GATED to is_visible=true (loadFieldMap): a key not on the
    // visible curation surface is NOT filterable — the engine THROWS a field-path
    // error rather than silently matching nothing. The old dealbrain fixture proved
    // this with a key resolvable in the UNGATED analytics overlay but hidden
    // (is_visible=false) from query; Bean Maxx has ZERO hidden opportunity defs (all
    // 60 visible — see divergences), so that gated-vs-overlay split is undemonstrable
    // here. The throw-on-unresolvable-key behavior itself is still pinned, exercised
    // with a key absent from field_definitions entirely.
    const [{ n: hidden }] = (await truth(
      `select count(*)::int as n from field_definitions
         where entity_type='opportunity' and organization_id='${ORG}' and is_visible=false`,
    )) as Array<{ n: number }>;
    // Ground truth (Bean Maxx): no opportunity field def is hidden.
    expect(hidden).toBe(0);

    const [{ n: nonexistent }] = (await truth(
      `select count(*)::int as n from field_definitions
         where entity_type='opportunity' and organization_id='${ORG}'
           and key='hs_projected_amount'`,
    )) as Array<{ n: number }>;
    // The key under test exists on neither the visible nor any surface.
    expect(nonexistent).toBe(0);

    await expect(
      h.service.query('opportunities', {
        filter: { on: 'hs_projected_amount', op: 'gt', value: 0 },
        page: { limit: 1 },
      }),
    ).rejects.toThrow();
  });
});
