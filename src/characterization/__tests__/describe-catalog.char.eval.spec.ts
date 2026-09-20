// CHARACTERIZATION NET — describe() field catalog + projection curation.
//
// Pins what the engine produces TODAY from the LIVE dealbrain DB for:
//   - describe('accounts'|'opportunities'|'observations'): native column field
//     types/nullable/searchable, relationships (name/kind/target), the EAV
//     fields surfaced for opportunities (data_type → ColumnType), native⊕EAV
//     merge + ordering.
//   - projectCatalog: facet-strip (no column/eav/sources/preview/fk) + the
//     exposeColumns allowlist (id always passes; EAV always passes; native
//     gated) and publicKeySet (adds rel names + the _rank/_snippet/_snippets
//     additive keys).
//
// CHARACTERIZATION, NOT ASPIRATION — several behaviors below look like bugs
// (a phantom `enableRLS` field, `enumValues: []` carried on non-enum EAV
// fields, the vector `embedding` column typed as 'string'). They are pinned
// AS-IS and tagged SUSPECTED-DIVERGENCE; the refactor decides, not this net.
//
// Public surface first (h.service.describe + the index-exported
// columnTypeFromDataType/columnTypeFromPg). projectCatalog/publicKeySet are NOT
// re-exported from index.ts, so they are deep-imported from
// ../presentation/nest/projection — the only internal reach here (noted in
// usedInternalImports).

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import {
  columnTypeFromDataType, // index-exported pure mapper
} from '../../adapters/drizzle/registry/catalog.ts';
import { projectCatalog, publicKeySet } from '../../presentation/nest/projection.ts'; // NOT in index.ts — internal reach
import { type QuerySurfaceHarness, makeQuerySurface } from '../harness.ts';

const DBURL = process.env.DBURL;
const suite = DBURL ? describe : describe.skip;

suite('describe-catalog — characterization', () => {
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

  // ----------------------------------------------------------------------
  // describe('accounts') — native-only entity (no EAV).
  // ----------------------------------------------------------------------
  describe("describe('accounts')", () => {
    it('catalogs the registered native columns with Drizzle-derived types', async () => {
      const cat = await h.service.describe('accounts');
      const byKey = new Map(cat.fields.map((f) => [f.key, f]));

      // The catalog reflects only the columns the registered Drizzle table
      // declares (schema.dealbrain's `accounts` = id + name), NOT the full DB
      // table (which also has user_id/website/organization_id/etc). So the
      // catalog is a registration-scoped projection, not a live-schema mirror.
      expect(byKey.get('id')).toMatchObject({ type: 'uuid', eav: false, nullable: false });
      expect(byKey.get('name')).toMatchObject({
        type: 'string',
        eav: false,
        searchable: true,
        // `name` is NOT NULL in the live DB, but the registered Drizzle column
        // omits .notNull(), so the catalog reports nullable:true. The catalog's
        // nullability tracks the DRIZZLE declaration, not the DB constraint.
        nullable: true,
      });

      // GROUND TRUTH: `accounts.name` is NOT NULL in the live DB — proving the
      // nullable:true above is a Drizzle-declaration artifact, not the DB truth.
      // truth: select is_nullable from information_schema.columns
      //        where table_name='accounts' and column_name='name'  => 'NO'
      const nameNull = await truth(
        "select is_nullable from information_schema.columns where table_name='accounts' and column_name='name'",
      );
      expect(nameNull[0]?.is_nullable).toBe('NO');
    });

    it('surfaces a phantom `enableRLS` field (Drizzle table method leaks in)', async () => {
      // SUSPECTED-DIVERGENCE: buildEntityCatalog walks Object.entries(table) to
      // enumerate columns, which also picks up Drizzle's `enableRLS` table
      // METHOD as if it were a column — it appears on EVERY entity, typed
      // 'string'. Not a real DB column. Pinned as-is. — revisit
      const cat = await h.service.describe('accounts');
      const rls = cat.fields.find((f) => f.key === 'enableRLS');
      expect(rls).toBeDefined();
      expect(rls).toMatchObject({ type: 'string', eav: false, column: 'enableRLS' });

      // GROUND TRUTH: there is no `enableRLS` column in the live DB.
      // truth: count(*) from information_schema.columns
      //        where table_name='accounts' and column_name='enableRLS'  => 0
      const cnt = await truth(
        "select count(*)::int as n from information_schema.columns where table_name='accounts' and column_name='enableRLS'",
      );
      expect(cnt[0]?.n).toBe(0);
    });

    it('derives both has_many relationships from defineRelations()', async () => {
      const cat = await h.service.describe('accounts');
      // Account→Opp and Account→Obs are both to-many (the FK lives on the child).
      const rels = Object.fromEntries(cat.relationships.map((r) => [r.name, r]));
      expect(rels.opportunities).toMatchObject({
        kind: 'has_many',
        target: 'opportunities',
        fk: 'account_id',
      });
      expect(rels.observations).toMatchObject({
        kind: 'has_many',
        target: 'observations',
        fk: 'account_id',
      });
    });

    it('searchableColumns = the single text column `name`', async () => {
      const cat = await h.service.describe('accounts');
      expect(cat.searchableColumns).toEqual(['name']);
    });

    it('carries no entity kind/summary (none registered)', async () => {
      const cat = await h.service.describe('accounts');
      expect(cat.kind).toBeUndefined();
      expect(cat.summary).toBeUndefined();
    });
  });

  // ----------------------------------------------------------------------
  // describe('opportunities') — native ⊕ EAV merge (the headline case).
  // ----------------------------------------------------------------------
  describe("describe('opportunities')", () => {
    it('merges native columns first, then the is_visible EAV fields', async () => {
      const cat = await h.service.describe('opportunities');
      const native = cat.fields.filter((f) => !f.eav).map((f) => f.key);
      const eav = cat.fields.filter((f) => f.eav).map((f) => f.key);

      // Native (registered cols only): id, account_id, state_of_deal_status,
      // plus the phantom enableRLS.
      expect(native).toEqual(['id', 'account_id', 'state_of_deal_status', 'enableRLS']);

      // EAV keys are the RAW field_definitions keys (Amount, StageName,
      // ExpectedRevenue, ...), NOT the aggregate-only logical handles
      // (weighted_amount/deal_probability). Sorted by previewOrder then key: the
      // defs carrying a key_field_order come FIRST in that order (StageName=1,
      // Amount=2, CloseDate=3, outcome=4, lead_pain=5, NextStep=6, ...), then the
      // rest in key.localeCompare order.
      //
      // GROUND TRUTH: the visible opportunity defs + their key_field_order, straight
      // from the DB, ordered by the SAME documented rule (in JS — a SQL `order by key`
      // would use the DB collation, not localeCompare). The literal 60-key list this
      // used to pin drifted (the live fixture is non-hermetic: 63 visible defs on
      // 2026-09-20, 9 of them key fields), so the contract is engine == this truth.
      // truth: select key, key_field_order from field_definitions where ... is_visible=true
      const rows = await truth(
        "select key, key_field_order from field_definitions where organization_id='a30c290d-6798-4da7-b3af-7b48c50212b8' and entity_type='opportunity' and is_visible=true",
      );
      const order = (r: Record<string, unknown>) =>
        r.key_field_order == null ? 999 : Number(r.key_field_order);
      const truthOrdered = [...rows]
        .sort((a, b) => order(a) - order(b) || (a.key as string).localeCompare(b.key as string))
        .map((r) => r.key as string);
      expect(truthOrdered.length).toBeGreaterThan(0); // non-vacuity bound
      expect(eav).toEqual(truthOrdered);
      // The ordering is genuinely two-block: at least one ordered (preview) def leads.
      expect(rows.some((r) => r.key_field_order != null)).toBe(true);

      // native block precedes the EAV block in field order.
      const keys = cat.fields.map((f) => f.key);
      expect(keys.indexOf('state_of_deal_status')).toBeLessThan(keys.indexOf('Amount'));
    });

    it('EAV field set == the is_visible field_definitions for the org (curation-gated)', async () => {
      // The query/fetch EAV path is GATED to is_visible=true. SUSPECTED-DIVERGENCE
      // worth noting: the aggregate analytics overlay loads the SAME org's defs
      // UNGATED (120 defs across opportunity/account/contact) and resolves
      // measures by KEY remapped to logical names — two divergent EAV read paths.
      // Current intended behavior (curation gate vs analytics). — revisit
      const cat = await h.service.describe('opportunities');
      const eavKeys = cat.fields
        .filter((f) => f.eav)
        .map((f) => f.key)
        .sort();

      // GROUND TRUTH: visible opportunity defs for the dealbrain org.
      // truth: select key from field_definitions where
      //   organization_id='a30c290d-6798-4da7-b3af-7b48c50212b8'
      //   and entity_type='opportunity' and is_visible=true
      const rows = await truth(
        "select key from field_definitions where organization_id='a30c290d-6798-4da7-b3af-7b48c50212b8' and entity_type='opportunity' and is_visible=true order by key",
      );
      const truthKeys = rows.map((r) => r.key as string).sort();
      // 63 seen 2026-09-20 (was 60) — live-fixture count, NOT pinned; the contract
      // is the set equality below.
      expect(truthKeys.length).toBeGreaterThan(0); // non-vacuity bound
      expect(eavKeys).toEqual(truthKeys);

      // GROUND TRUTH: weighted_amount / deal_probability are aggregate-only
      // logical handles — they are NOT field_definitions keys, so they never
      // appear on describe().
      expect(eavKeys).not.toContain('weighted_amount');
      expect(eavKeys).not.toContain('deal_probability');
    });

    it('EAV mechanics map data_type → ColumnType (matching the pure mapper)', async () => {
      const cat = await h.service.describe('opportunities');
      const byKey = new Map(cat.fields.map((f) => [f.key, f]));

      // GROUND TRUTH: each visible def's data_type, then assert the catalog's
      // type equals columnTypeFromDataType(data_type) — the pure index-exported
      // mapper — for every EAV field. Pins the merge applies the same rule.
      // truth: select key, data_type from field_definitions where ... is_visible=true
      const rows = await truth(
        "select key, data_type from field_definitions where organization_id='a30c290d-6798-4da7-b3af-7b48c50212b8' and entity_type='opportunity' and is_visible=true",
      );
      for (const r of rows) {
        const key = r.key as string;
        const dt = r.data_type as string;
        const field = byKey.get(key);
        expect(field, `EAV field ${key} present`).toBeDefined();
        expect(field?.type, `${key} (${dt})`).toBe(columnTypeFromDataType(dt));
      }

      // Spot-checks of the data_type → ColumnType contract:
      expect(byKey.get('Amount')?.type).toBe('number'); // money      → number
      expect(byKey.get('Probability')?.type).toBe('number'); // percentage → number
      expect(byKey.get('age_days')?.type).toBe('number'); // number     → number
      expect(byKey.get('CloseDate')?.type).toBe('date'); // date       → date
      expect(byKey.get('created_date')?.type).toBe('datetime'); // datetime   → datetime
      expect(byKey.get('is_closed')?.type).toBe('boolean'); // boolean    → boolean
      expect(byKey.get('Name')?.type).toBe('string'); // text       → string
      expect(byKey.get('bean_maxx_use_case')?.type).toBe('string'); // longtext   → string
      expect(byKey.get('owner_name')?.type).toBe('string'); // text       → string (no reference defs in Bean Maxx)
      expect(byKey.get('StageName')?.type).toBe('enum'); // select     → enum
      expect(byKey.get('outcome')?.type).toBe('enum'); // select     → enum
    });

    it('EAV string-typed fields are searchable; number/date/enum/boolean are not', async () => {
      // catalog.ts: EAV `searchable = (type === 'string')`. So the text-ish
      // fields opt in, the rest stay eq/in-only.
      const cat = await h.service.describe('opportunities');
      const byKey = new Map(cat.fields.map((f) => [f.key, f]));
      // string → searchable (text/longtext data_types map to type 'string')
      for (const k of ['Name', 'AccountName', 'bean_maxx_use_case', 'owner_name']) {
        expect(byKey.get(k)?.searchable, k).toBe(true);
      }
      // non-string → not searchable (number/date/enum/boolean)
      for (const k of ['Amount', 'CloseDate', 'StageName', 'is_closed']) {
        expect(byKey.get(k)?.searchable, k).toBe(false);
      }
    });

    it('every EAV field is nullable and labeled from field_definitions', async () => {
      const cat = await h.service.describe('opportunities');
      const eav = cat.fields.filter((f) => f.eav);
      // EAV fields are always nullable:true (no per-field NOT NULL on field_values).
      expect(eav.every((f) => f.nullable === true)).toBe(true);
      // labels carried straight from field_definitions.label (key != label —
      // Amount's label is 'ARR', StageName's is 'Stage').
      const byKey = new Map(eav.map((f) => [f.key, f]));
      expect(byKey.get('Amount')?.label).toBe('ARR');
      expect(byKey.get('StageName')?.label).toBe('Stage');
    });

    it('non-enum EAV fields carry NO enumValues (selectOptions null → undefined)', async () => {
      // catalog.ts sets `enumValues = def.selectOptions ?? undefined`. In Bean
      // Maxx, non-select fields store select_options = NULL (not [] as old HubSpot
      // did), so a 'number'/'date' EAV field gets enumValues: undefined — the
      // field carries no enum data at all. (The old fixture pinned an empty [] on
      // every field, a HubSpot data artifact that Bean Maxx does not reproduce.)
      const cat = await h.service.describe('opportunities');
      const byKey = new Map(cat.fields.map((f) => [f.key, f]));
      expect(byKey.get('Amount')?.type).toBe('number');
      expect(byKey.get('Amount')?.enumValues).toBeUndefined(); // no enum on a number field
      // The genuine enum field, by contrast, DOES carry its options.
      expect(byKey.get('StageName')?.type).toBe('enum');
      expect(byKey.get('StageName')?.enumValues).toBeDefined();

      // GROUND TRUTH: Amount's select_options is NULL in the DB (so undefined is
      // the data, not a dropped value); StageName has an 8-element array.
      // truth: select key, jsonb_typeof(select_options), jsonb_array_length(...)
      const rows = await truth(
        "select key, jsonb_typeof(select_options) as t, case when jsonb_typeof(select_options)='array' then jsonb_array_length(select_options) else -1 end as n from field_definitions where organization_id='a30c290d-6798-4da7-b3af-7b48c50212b8' and entity_type='opportunity' and key in ('StageName','Amount')",
      );
      const byk = Object.fromEntries(rows.map((r) => [r.key as string, r]));
      expect(byk.Amount?.t).toBe('null'); // select_options is a jsonb null → enumValues undefined
      expect(byk.StageName?.t).toBe('array');
      expect(byk.StageName?.n).toBe(8); // 8 stages
    });

    it('a select EAV field WITH options surfaces them as enumValues (StageName → 8 stages)', async () => {
      // When the DB select_options is a non-empty array, the catalog carries it
      // as enumValues. Bean Maxx stores options as {label,value} OBJECTS (not the
      // old flat string array), so enumValues is an array of objects — the merge
      // propagates whatever selectOptions the field_definitions row holds verbatim.
      const cat = await h.service.describe('opportunities');
      const byKey = new Map(cat.fields.map((f) => [f.key, f]));
      expect(byKey.get('StageName')?.type).toBe('enum');
      // NOTE: CatalogField.enumValues is declared `readonly string[]`, but Bean
      // Maxx carries {label,value} OBJECTS at runtime — the declared type lies
      // about the shape (a SUSPECTED-DIVERGENCE in the catalog typing), so we cast
      // through unknown to read the genuine object array.
      const enumValues = (byKey.get('StageName')?.enumValues ?? []) as unknown as Array<{
        label: string;
        value: string;
      }>;
      expect(enumValues.map((o) => o.value)).toContain('closed_won');
      expect(enumValues.length).toBe(8);

      // GROUND TRUTH: the catalog's enumValues equals the DB's stored stages.
      // truth: select select_options from field_definitions where ... key='StageName'
      const rows = await truth(
        "select select_options::text as opts from field_definitions where organization_id='a30c290d-6798-4da7-b3af-7b48c50212b8' and entity_type='opportunity' and key='StageName' and is_visible=true",
      );
      const opts = JSON.parse(rows[0]?.opts as string) as Array<{ label: string; value: string }>;
      expect([...enumValues].sort((a, b) => a.value.localeCompare(b.value))).toEqual(
        [...opts].sort((a, b) => a.value.localeCompare(b.value)),
      );
    });

    it('the is_key_field EAV defs surface as preview=true (== the org key-field defs)', async () => {
      const cat = await h.service.describe('opportunities');
      const previewEav = cat.fields
        .filter((f) => f.eav && f.preview)
        .map((f) => f.key)
        .sort();
      // Exactly the is_key_field defs are preview; every other EAV field is not. The
      // literal 6-key list this used to pin drifted (9 key fields on 2026-09-20 — the
      // live fixture is non-hermetic), so the set is asserted against SQL truth below.

      // GROUND TRUTH: the visible opportunity defs flagged is_key_field, derived
      // straight from the DB — the preview set MUST equal this key set.
      // truth: select key ... is_visible=true and is_key_field=true
      const rows = await truth(
        "select key from field_definitions where organization_id='a30c290d-6798-4da7-b3af-7b48c50212b8' and entity_type='opportunity' and is_visible=true and is_key_field=true order by key",
      );
      const keyFieldKeys = rows.map((r) => r.key as string).sort();
      expect(keyFieldKeys.length).toBeGreaterThan(0); // non-vacuity bound
      expect(previewEav).toEqual(keyFieldKeys);
      // ...and it is a STRICT subset: some visible EAV field is NOT preview.
      expect(previewEav.length).toBeLessThan(cat.fields.filter((f) => f.eav).length);
    });

    it('relationships: belongs_to account (to-one) + has_many observations', async () => {
      const cat = await h.service.describe('opportunities');
      const rels = Object.fromEntries(cat.relationships.map((r) => [r.name, r]));
      // Opp→Account is to-ONE (FK on opportunities.account_id).
      expect(rels.account).toMatchObject({
        kind: 'belongs_to',
        target: 'accounts',
        fk: 'account_id',
      });
      // Opp→Obs is to-many.
      expect(rels.observations).toMatchObject({
        kind: 'has_many',
        target: 'observations',
        fk: 'opportunity_id',
      });
    });
  });

  // ----------------------------------------------------------------------
  // describe('observations') — the harness's EXTENDED table (adds
  // embedding/normalized_text), no EAV.
  // ----------------------------------------------------------------------
  describe("describe('observations')", () => {
    it('catalogs the extended native columns with their Drizzle types', async () => {
      const cat = await h.service.describe('observations');
      const byKey = new Map(cat.fields.map((f) => [f.key, f]));

      expect(byKey.get('id')?.type).toBe('uuid');
      expect(byKey.get('account_id')?.type).toBe('uuid');
      expect(byKey.get('opportunity_id')?.type).toBe('uuid');
      // `type` is a varchar (catalogs as 'string', not 'enum'), but its qField
      // `selectOptions` declares the observation-type taxonomy, which the native
      // path surfaces as enumValues — so describe teaches the agent the legal
      // values (parity with EAV field_definitions.select_options).
      expect(byKey.get('type')).toMatchObject({ type: 'string', eav: false });
      expect(byKey.get('type')?.enumValues).toContain('pricing_signal');
      expect(byKey.get('occurred_at')?.type).toBe('datetime');
      expect(byKey.get('structured_data')?.type).toBe('json');
      expect(byKey.get('normalized_text')?.type).toBe('string');
    });

    it('the pgvector `embedding` column is hidden from the catalog (infra, isVisible:false)', async () => {
      // embedding powers semantic rank (wired via semanticColumns); it is not a
      // queryable field — observationsMeta marks it isVisible:false, so describe
      // excludes it entirely (no more vector-typed-as-string surfaced to the agent).
      const cat = await h.service.describe('observations');
      expect(cat.fields.find((f) => f.key === 'embedding')).toBeUndefined();

      // GROUND TRUTH: the column still EXISTS in the DB (USER-DEFINED vector) — it
      // is the CATALOG that hides it, not the schema.
      const dt = await truth(
        "select data_type from information_schema.columns where table_name='observations' and column_name='embedding'",
      );
      expect(dt[0]?.data_type).toBe('USER-DEFINED');
    });

    it('searchableColumns = type + normalized_text (the two text columns)', async () => {
      const cat = await h.service.describe('observations');
      expect(cat.searchableColumns.sort()).toEqual(['normalized_text', 'type']);
    });

    it('relationships: belongs_to opportunity AND account (both to-one)', async () => {
      const cat = await h.service.describe('observations');
      const rels = Object.fromEntries(cat.relationships.map((r) => [r.name, r]));
      expect(rels.opportunity).toMatchObject({
        kind: 'belongs_to',
        target: 'opportunities',
        fk: 'opportunity_id',
      });
      expect(rels.account).toMatchObject({
        kind: 'belongs_to',
        target: 'accounts',
        fk: 'account_id',
      });
    });
  });

  // ----------------------------------------------------------------------
  // describe() no-arg — catalogs for every registered entity.
  // ----------------------------------------------------------------------
  it('describe() with no entity returns a catalog per registered entity', async () => {
    const all = await h.service.describe();
    expect(all.map((c) => c.entity).sort()).toEqual(['accounts', 'observations', 'opportunities']);
  });

  // ----------------------------------------------------------------------
  // projectCatalog — facet-strip + exposeColumns allowlist.
  // ----------------------------------------------------------------------
  describe('projectCatalog (facet-strip + allowlist)', () => {
    it('strips implementation facets (column/eav/preview/sources/previewOrder; rel.fk)', async () => {
      const cat = await h.service.describe('opportunities');
      const pub = projectCatalog(cat); // no expose → native passes (facet-trim only)
      const sample = pub.fields[0];
      // Only the public facets survive.
      expect(Object.keys(sample).sort()).toEqual(['key', 'nullable', 'searchable', 'type'].sort());
      // Internal facets are gone on EVERY field.
      for (const f of pub.fields) {
        expect(f).not.toHaveProperty('column');
        expect(f).not.toHaveProperty('eav');
        expect(f).not.toHaveProperty('preview');
        expect(f).not.toHaveProperty('previewOrder');
        expect(f).not.toHaveProperty('sources');
      }
      // Relationships lose `fk` (kept name/kind/target).
      for (const r of pub.relationships) {
        expect(r).not.toHaveProperty('fk');
        expect(Object.keys(r).sort()).toEqual(['kind', 'name', 'target']);
      }
      // The projected entity catalog drops searchableColumns/summary/kind/examples.
      expect(pub).not.toHaveProperty('searchableColumns');
      expect(pub).not.toHaveProperty('kind');
    });

    it('no allowlist → ALL native columns pass (including the phantom enableRLS)', async () => {
      // SUSPECTED-DIVERGENCE (knock-on): with no exposeColumns, the phantom
      // `enableRLS` field reaches the public catalog. Pinned as-is. — revisit
      const cat = await h.service.describe('opportunities');
      const pub = projectCatalog(cat);
      const keys = pub.fields.map((f) => f.key);
      expect(keys).toContain('state_of_deal_status'); // native passes
      expect(keys).toContain('enableRLS'); // phantom native ALSO passes
      expect(keys).toContain('Amount'); // EAV passes
    });

    it('allowlist gates native columns; id always passes; EAV always passes', async () => {
      const cat = await h.service.describe('opportunities');
      const pub = projectCatalog(cat, { opportunities: ['state_of_deal_status'] });
      const keys = pub.fields.map((f) => f.key);

      expect(keys).toContain('id'); // id always passes
      expect(keys).toContain('state_of_deal_status'); // allow-listed native
      expect(keys).not.toContain('account_id'); // native NOT listed → dropped
      expect(keys).not.toContain('enableRLS'); // phantom native dropped by allowlist
      // every EAV field still passes (curated by is_visible upstream).
      for (const k of ['Amount', 'Name', 'StageName']) {
        expect(keys).toContain(k);
      }
    });

    it('empty allowlist → only id + all EAV (every other native dropped)', async () => {
      const cat = await h.service.describe('opportunities');
      const pub = projectCatalog(cat, { opportunities: [] });
      const keys = pub.fields.map((f) => f.key).sort();
      const native = cat.fields.filter((f) => !f.eav).map((f) => f.key);
      const eav = cat.fields.filter((f) => f.eav).map((f) => f.key);

      expect(keys).toContain('id');
      // every non-id native is dropped.
      for (const k of native.filter((k) => k !== 'id')) {
        expect(keys).not.toContain(k);
      }
      // every EAV field survives.
      expect(keys).toEqual(['id', ...eav].sort());
    });

    it('the enumValues length>0 guard: absent on non-enum, present on a populated enum', async () => {
      // toPublicField only emits enumValues when length>0. In Bean Maxx the
      // non-select fields carry no enumValues (selectOptions NULL → undefined), so
      // the guard drops the key entirely; a select field with a populated options
      // array keeps it. (The old fixture's empty-[] enum — an enum indistinguishable
      // from a plain string — does not occur in Bean Maxx: every select def has a
      // non-empty options array.)
      const cat = await h.service.describe('opportunities');
      const pub = projectCatalog(cat);
      // a number EAV field has no enumValues → guard drops the key.
      const amount = pub.fields.find((f) => f.key === 'Amount');
      expect(amount?.type).toBe('number');
      expect(amount).not.toHaveProperty('enumValues');
      // a populated enum field KEEPS its enumValues through projection.
      const stage = pub.fields.find((f) => f.key === 'StageName');
      expect(stage?.type).toBe('enum');
      expect(stage).toHaveProperty('enumValues');
      expect((stage?.enumValues ?? []).length).toBe(8);
    });

    it('label/note survive projection; note comes from field_definitions.description', async () => {
      const cat = await h.service.describe('opportunities');
      const pub = projectCatalog(cat);
      const amount = pub.fields.find((f) => f.key === 'Amount');
      expect(amount?.label).toBe('ARR'); // Amount's field_definitions.label is 'ARR'
      expect(typeof amount?.note).toBe('string'); // description carried as note
      expect((amount?.note ?? '').length).toBeGreaterThan(0);
    });
  });

  // ----------------------------------------------------------------------
  // publicKeySet — projected field keys + relationship names + additive meta.
  // ----------------------------------------------------------------------
  describe('publicKeySet', () => {
    it('includes the projected field keys, rel NAMES, and the _rank/_snippet meta keys', async () => {
      const cat = await h.service.describe('opportunities');
      const ks = publicKeySet(cat, { opportunities: [] });

      // id + every EAV field.
      expect(ks.has('id')).toBe(true);
      expect(ks.has('Amount')).toBe(true);
      expect(ks.has('Name')).toBe(true);
      // native NOT in the empty allowlist → absent.
      expect(ks.has('state_of_deal_status')).toBe(false);
      // relationship NAMES survive (so an expand survives projection).
      expect(ks.has('account')).toBe(true);
      expect(ks.has('observations')).toBe(true);
      // additive preview/rank meta keys are always added.
      expect(ks.has('_snippets')).toBe(true);
      expect(ks.has('_rank')).toBe(true);
      expect(ks.has('_snippet')).toBe(true);
    });

    it('with no allowlist also admits the phantom enableRLS native key', async () => {
      // SUSPECTED-DIVERGENCE (knock-on): enableRLS leaks into the row key set
      // when no allowlist is configured. Pinned as-is. — revisit
      const cat = await h.service.describe('observations');
      const ks = publicKeySet(cat); // no expose
      expect(ks.has('enableRLS')).toBe(true);
      expect(ks.has('normalized_text')).toBe(true);
      // rel names for observations survive.
      expect(ks.has('opportunity')).toBe(true);
      expect(ks.has('account')).toBe(true);
    });
  });
});
