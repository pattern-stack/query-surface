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
//   entityTypeValue:'opportunity' }`. A field key like `amount` (money) or
//   `hs_deal_stage_probability` (percentage) resolves to a typed value column
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

// The org that owns dealbrain's opportunity field_definitions (org-owned defs,
// user_id NULL). Used to scope the ground-truth field_definition_id lookups so
// the SQL truth matches the engine's actor-scoped EAV resolution.
const ORG = 'e7e24eb2-49ba-45cb-88b1-43696d1e9ed8';
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

  it('filters opportunities on the EAV `amount` (money) key — count matches field_values truth', async () => {
    // TRUTH: opportunities with a value_number > 0 for the `amount` field_definition.
    const [{ n: gt0 }] = await truth(
      `select count(*)::int as n from opportunities o
         join field_values fv on fv.entity_id=o.id and fv.entity_type='opportunity'
           and fv.field_definition_id=${defId('amount')}
        where fv.value_number > 0`,
    ).then((r) => r as Array<{ n: number }>);

    const res = await h.service.query('opportunities', {
      filter: { on: 'amount', op: 'gt', value: 0 },
      page: { limit: 500 },
    });

    // Pinned live: 146.
    expect(res.total).toBe(146);
    expect(res.total).toBe(gt0);
    expect(res.ids.length).toBe(gt0);
  });

  it('EAV filter emits a field_values LEFT JOIN (the resolution seam)', async () => {
    const res = await h.service.query('opportunities', {
      filter: { on: 'amount', op: 'gt', value: 0 },
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
           and fv.field_definition_id=${defId('amount')}
        where fv.value_number is not null and fv.value_number >= 0`,
    )) as Array<{ n: number }>;
    const res = await h.service.query('opportunities', {
      filter: { on: 'amount', op: 'gte', value: 0 },
      page: { limit: 500 },
    });
    expect(res.total).toBe(nonNull);
    expect(res.total).toBe(146); // none are exactly 0 → same as gt 0
  });

  it('percentage EAV (`hs_deal_stage_probability`) is stored as a 0..1 fraction — filter compares against the stored scale', async () => {
    // SUSPECTED-DIVERGENCE: the label is "Deal probability" / data_type percentage,
    // but values are stored as fractions (0, 0.2, ... 1.0), so a caller must filter
    // by 0.5 (not 50) to mean "≥ 50%". The engine compares against the raw stored
    // value with NO scale normalization. Pinned as-is. — revisit
    const [{ n: ge }] = (await truth(
      `select count(*)::int as n from opportunities o
         join field_values fv on fv.entity_id=o.id and fv.entity_type='opportunity'
           and fv.field_definition_id=${defId('hs_deal_stage_probability')}
        where fv.value_number >= 0.5`,
    )) as Array<{ n: number }>;
    const res = await h.service.query('opportunities', {
      filter: { on: 'hs_deal_stage_probability', op: 'gte', value: 0.5 },
      page: { limit: 500 },
    });
    expect(res.total).toBe(85);
    expect(res.total).toBe(ge);
  });

  // --- SORT by an EAV field ----------------------------------------------------

  it('sorts opportunities by the EAV `amount` desc — top row matches SQL truth', async () => {
    const top = (await truth(
      `select o.id, fv.value_number as amount from opportunities o
         join field_values fv on fv.entity_id=o.id and fv.entity_type='opportunity'
           and fv.field_definition_id=${defId('amount')}
        where fv.value_number is not null
        order by fv.value_number desc, o.id asc limit 1`,
    )) as Array<{ id: string; amount: string }>;

    const res = await h.service.query('opportunities', {
      // NB: Sort uses `field`, not `on` (types.ts Sort).
      sort: [{ field: 'amount', dir: 'desc' }],
      page: { limit: 1 },
      preview: true,
      columns: ['amount'],
    });
    expect(res.ids[0]).toBe(top[0]!.id);
    // Pinned live: the highest-amount opportunity.
    expect(res.ids[0]).toBe('5dd1c040-e1c1-497d-9fa9-876cb4c1a1e1');
    expect(n(res.preview?.[0]?.amount)).toBe(700000);
  });

  // --- PROJECT an EAV field (preview) ------------------------------------------

  it('projects EAV keys into preview rows, keyed by the requested key', async () => {
    const res = await h.service.query('opportunities', {
      filter: { on: 'amount', op: 'gt', value: 0 },
      page: { limit: 3 },
      preview: true,
      columns: ['amount', 'dealname'],
    });
    expect(res.preview).toBeDefined();
    for (const row of res.preview ?? []) {
      expect(row).toHaveProperty('amount');
      expect(row).toHaveProperty('dealname');
    }
  });

  it('preview returns a numeric EAV value as a STRING (no numeric decode on the query path)', async () => {
    // SUSPECTED-DIVERGENCE: query() preview projects the raw drizzle numeric
    // (a JS string), e.g. amount = "700000", while fetch() hydration decodes the
    // same field to a JS number 700000 (see hydrateEavRows / extractTypedValue).
    // Two EAV read paths, two output types for the same field. Pinned as-is. — revisit
    const res = await h.service.query('opportunities', {
      sort: [{ field: 'amount', dir: 'desc' }],
      page: { limit: 1 },
      preview: true,
      columns: ['amount'],
    });
    expect(typeof res.preview?.[0]?.amount).toBe('string');
    expect(res.preview?.[0]?.amount).toBe('700000');
  });

  // --- FETCH hydrates EAV inline ----------------------------------------------

  it('fetch hydrates EAV cells inline (decoded to native types) alongside native columns', async () => {
    const ID = '5dd1c040-e1c1-497d-9fa9-876cb4c1a1e1';
    const f = await h.service.fetch('opportunities', [ID]);
    expect(f.count).toBe(1);
    const row = f.rows[0]!;
    // EAV fields appear inline, indistinguishable from native columns.
    expect(row.amount).toBe(700000); // decoded to a NUMBER here (contrast preview)
    expect(typeof row.amount).toBe('number');
    expect(row.dealname).toBe('AWS Activate — ISV Accelerate');

    // Hydration is value-presence driven: ONLY the EAV keys that have a stored
    // field_value row for THIS entity are merged in. A visible key with no value
    // row (here `closed_lost_reason` — this deal isn't closed-lost) is simply
    // ABSENT from the row, NOT present-as-null. The 14 keys below are exactly the
    // ones the SQL truth shows a field_value for; `closed_lost_reason` is not.
    const [{ keys }] = (await truth(
      `select array_agg(fd.key order by fd.key) as keys
         from field_values fv
         join field_definitions fd on fd.id=fv.field_definition_id
        where fv.entity_type='opportunity' and fv.entity_id='${ID}'
          and fd.organization_id='${ORG}' and fd.is_visible=true`,
    )) as Array<{ keys: string[] }>;
    expect(keys).toEqual([
      'amount',
      'closedate',
      'createdate',
      'days_to_close',
      'deal_currency_code',
      'dealname',
      'dealstage',
      'hs_deal_stage_probability',
      'hs_is_closed',
      'hs_is_closed_lost',
      'hs_is_closed_won',
      'hs_lastmodifieddate',
      'hubspot_owner_id',
      'pipeline',
    ]);
    for (const key of keys) expect(row).toHaveProperty(key);
    // The one visible-but-unset key is absent (presence-driven hydration).
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
      filter: { on: 'amount', op: 'gte', value: 0 },
      page: { limit: 500 },
    });
    // No duplication: distinct id count == returned id count == total.
    expect(new Set(res.ids).size).toBe(res.ids.length);
    expect(res.ids.length).toBe(res.total);
    expect(res.total).toBe(146);
  });

  // --- NATIVE-OVER-EAV PRECEDENCE ---------------------------------------------

  it('a native column resolves natively (NO field_values join) — the same-key precedence rule, native side', async () => {
    // compiler.ts resolveFrom final-segment: a native entity-row column ALWAYS
    // wins; only keys with no native column fall through to the EAV field map.
    // `state_of_deal_status` is a native opportunities column (all NULL in this
    // seed) — filtering on it must NOT emit a field_values join.
    const res = await h.service.query('opportunities', {
      filter: { on: 'state_of_deal_status', op: 'is_null' },
      page: { limit: 1 },
      include_sql: true,
    });
    expect(res.sql).not.toMatch(/field_values/);
    // All 198 opportunities have a null native status.
    const [{ n: all }] = (await truth(
      `select count(*)::int as n from opportunities where state_of_deal_status is null`,
    )) as Array<{ n: number }>;
    expect(res.total).toBe(all);
    expect(res.total).toBe(198);
  });

  it('describe() reports an EAV-only field with eav:true and field_definition-sourced mechanics', async () => {
    const cat = await h.service.describe('opportunities');
    const amount = cat.fields.find((f) => f.key === 'amount');
    expect(amount).toBeDefined();
    expect(amount?.eav).toBe(true);
    expect(amount?.type).toBe('number'); // money → number (columnTypeFromDataType)
    expect(amount?.column).toBeUndefined(); // no backing native column
    expect(amount?.sources?.type).toBe('field_definition');

    // A native column is eav:false with a backing camelCase column.
    const status = cat.fields.find((f) => f.key === 'state_of_deal_status');
    expect(status?.eav).toBe(false);
    expect(status?.column).toBe('stateOfDealStatus');

    // Live shape: 15 visible EAV keys + 4 native catalog fields = 19 total.
    const eavCount = cat.fields.filter((f) => f.eav).length;
    expect(eavCount).toBe(15);
    expect(cat.fields.filter((f) => !f.eav).length).toBe(4);
    expect(cat.fields.length).toBe(19);
  });

  it('an EAV key absent from the curation gate is unresolvable on query/fetch (is_visible gate)', async () => {
    // SUSPECTED-DIVERGENCE (documented intended behavior): query/fetch EAV is
    // GATED to is_visible=true (loadFieldMap), so the analytics handle
    // `weighted_amount` (key hs_projected_amount) — which the aggregate overlay
    // resolves UNGATED — is NOT a filterable key here. Filtering on it throws a
    // field-path error rather than silently matching nothing. Pinned as-is. — revisit
    const [{ exists }] = (await truth(
      `select (exists(select 1 from field_definitions
         where entity_type='opportunity' and key='hs_projected_amount'
           and organization_id='${ORG}' and is_visible=false))::int as exists`,
    )) as Array<{ exists: number }>;
    // Ground truth: it exists in the org but is hidden (is_visible=false).
    expect(exists).toBe(1);

    await expect(
      h.service.query('opportunities', {
        filter: { on: 'hs_projected_amount', op: 'gt', value: 0 },
        page: { limit: 1 },
      }),
    ).rejects.toThrow();
  });
});
