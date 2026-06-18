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
} from '../adapters/drizzle/registry/catalog.ts';
import { projectCatalog, publicKeySet } from '../presentation/nest/projection.ts'; // NOT in index.ts — internal reach
import { type QuerySurfaceHarness, makeQuerySurface } from './harness.ts';

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

    it('derives both has_many relationships from relations()', async () => {
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

      // EAV keys are the RAW field_definitions keys (amount, dealname,
      // hs_deal_stage_probability, ...), NOT the aggregate-only logical handles
      // (weighted_amount/deal_probability). Sorted by previewOrder then key —
      // here all previewOrder are absent so it's pure key.localeCompare order.
      expect(eav).toEqual([
        'amount',
        'closed_lost_reason',
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

      // native block precedes the EAV block in field order.
      const keys = cat.fields.map((f) => f.key);
      expect(keys.indexOf('state_of_deal_status')).toBeLessThan(keys.indexOf('amount'));
    });

    it('EAV field set == the is_visible field_definitions for the org (curation-gated)', async () => {
      // The query/fetch EAV path is GATED to is_visible=true. SUSPECTED-DIVERGENCE
      // worth noting: the aggregate analytics overlay loads the SAME org's defs
      // UNGATED (408 defs) and resolves measures by KEY remapped to logical
      // names — two divergent EAV read paths. Current intended behavior (curation
      // gate vs analytics). — revisit
      const cat = await h.service.describe('opportunities');
      const eavKeys = cat.fields
        .filter((f) => f.eav)
        .map((f) => f.key)
        .sort();

      // GROUND TRUTH: visible opportunity defs for the dealbrain org.
      // truth: select key from field_definitions where
      //   organization_id='e7e24eb2-49ba-45cb-88b1-43696d1e9ed8'
      //   and entity_type='opportunity' and is_visible=true
      const rows = await truth(
        "select key from field_definitions where organization_id='e7e24eb2-49ba-45cb-88b1-43696d1e9ed8' and entity_type='opportunity' and is_visible=true order by key",
      );
      const truthKeys = rows.map((r) => r.key as string).sort();
      expect(truthKeys.length).toBe(15);
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
        "select key, data_type from field_definitions where organization_id='e7e24eb2-49ba-45cb-88b1-43696d1e9ed8' and entity_type='opportunity' and is_visible=true",
      );
      for (const r of rows) {
        const key = r.key as string;
        const dt = r.data_type as string;
        const field = byKey.get(key);
        expect(field, `EAV field ${key} present`).toBeDefined();
        expect(field?.type, `${key} (${dt})`).toBe(columnTypeFromDataType(dt));
      }

      // Spot-checks of the data_type → ColumnType contract:
      expect(byKey.get('amount')?.type).toBe('number'); // money   → number
      expect(byKey.get('hs_deal_stage_probability')?.type).toBe('number'); // percentage → number
      expect(byKey.get('days_to_close')?.type).toBe('number'); // number  → number
      expect(byKey.get('closedate')?.type).toBe('datetime'); // datetime → datetime
      expect(byKey.get('hs_is_closed')?.type).toBe('boolean'); // boolean → boolean
      expect(byKey.get('dealname')?.type).toBe('string'); // text    → string
      expect(byKey.get('closed_lost_reason')?.type).toBe('string'); // longtext → string
      expect(byKey.get('hubspot_owner_id')?.type).toBe('string'); // reference → string
      expect(byKey.get('deal_currency_code')?.type).toBe('enum'); // select → enum
      expect(byKey.get('dealstage')?.type).toBe('enum'); // select → enum
    });

    it('EAV string-typed fields are searchable; number/date/enum/boolean are not', async () => {
      // catalog.ts: EAV `searchable = (type === 'string')`. So the text-ish
      // fields opt in, the rest stay eq/in-only.
      const cat = await h.service.describe('opportunities');
      const byKey = new Map(cat.fields.map((f) => [f.key, f]));
      // string → searchable
      for (const k of ['dealname', 'closed_lost_reason', 'hubspot_owner_id', 'pipeline']) {
        expect(byKey.get(k)?.searchable, k).toBe(true);
      }
      // non-string → not searchable
      for (const k of ['amount', 'closedate', 'deal_currency_code', 'hs_is_closed']) {
        expect(byKey.get(k)?.searchable, k).toBe(false);
      }
    });

    it('every EAV field is nullable and labeled from field_definitions', async () => {
      const cat = await h.service.describe('opportunities');
      const eav = cat.fields.filter((f) => f.eav);
      // EAV fields are always nullable:true (no per-field NOT NULL on field_values).
      expect(eav.every((f) => f.nullable === true)).toBe(true);
      // labels carried straight from field_definitions.label.
      const byKey = new Map(eav.map((f) => [f.key, f]));
      expect(byKey.get('amount')?.label).toBe('Amount');
      expect(byKey.get('deal_currency_code')?.label).toBe('Currency');
    });

    it('SUSPECTED-DIVERGENCE: non-enum EAV fields still carry enumValues: []', async () => {
      // SUSPECTED-DIVERGENCE: catalog.ts sets `enumValues = def.selectOptions ??
      // undefined`. HubSpot stores selectOptions as [] (not null) for EVERY
      // field, so even a 'number'/'datetime' EAV field gets enumValues: [] —
      // an empty array on a non-enum field. (It is dropped later by projection's
      // length>0 guard, but the internal CatalogField carries it.) — revisit
      const cat = await h.service.describe('opportunities');
      const byKey = new Map(cat.fields.map((f) => [f.key, f]));
      expect(byKey.get('amount')?.type).toBe('number');
      expect(byKey.get('amount')?.enumValues).toEqual([]); // empty array on a number field
      // And the genuine enum field ALSO carries [] because its DB select_options
      // are empty — so there's no enum-vs-non-enum distinction at this layer.
      expect(byKey.get('deal_currency_code')?.type).toBe('enum');
      expect(byKey.get('deal_currency_code')?.enumValues).toEqual([]);

      // GROUND TRUTH: deal_currency_code's select_options really is [] in the DB
      // (so the empty enum is the data, not a dropped value); dealstage has 7.
      // truth: select key, json_array_length(select_options) from field_definitions ...
      const rows = await truth(
        "select key, coalesce(jsonb_array_length(select_options),-1) as n from field_definitions where organization_id='e7e24eb2-49ba-45cb-88b1-43696d1e9ed8' and entity_type='opportunity' and key in ('deal_currency_code','dealstage','amount')",
      );
      const n = Object.fromEntries(rows.map((r) => [r.key as string, r.n as number]));
      expect(n.deal_currency_code).toBe(0); // [] in DB
      expect(n.dealstage).toBe(7); // 7 stages
      expect(n.amount).toBe(0); // money field, [] in DB
    });

    it('a select EAV field WITH options surfaces them as enumValues (dealstage → 7 stages)', async () => {
      // Contrast with deal_currency_code (empty []): when the DB select_options
      // is a non-empty array, the catalog DOES carry it as enumValues. So the
      // empty-enum behavior above is a data artifact (HubSpot stores [] for
      // currency), not a catalog dropping bug — the merge propagates whatever
      // selectOptions the field_definitions row holds.
      const cat = await h.service.describe('opportunities');
      const byKey = new Map(cat.fields.map((f) => [f.key, f]));
      expect(byKey.get('dealstage')?.type).toBe('enum');
      const enumValues = byKey.get('dealstage')?.enumValues ?? [];
      expect(enumValues).toContain('closedwon');
      expect(enumValues.length).toBe(7);

      // GROUND TRUTH: the catalog's enumValues equals the DB's stored stages.
      // truth: select select_options from field_definitions where ... key='dealstage'
      const rows = await truth(
        "select select_options::text as opts from field_definitions where organization_id='e7e24eb2-49ba-45cb-88b1-43696d1e9ed8' and entity_type='opportunity' and key='dealstage' and is_visible=true",
      );
      const opts = JSON.parse(rows[0]?.opts as string) as string[];
      expect([...enumValues].sort()).toEqual([...opts].sort());
    });

    it('no EAV field is preview (no is_key_field=true in the org defs)', async () => {
      const cat = await h.service.describe('opportunities');
      expect(cat.fields.filter((f) => f.eav).every((f) => f.preview === false)).toBe(true);

      // GROUND TRUTH: zero visible opportunity defs are flagged is_key_field.
      // truth: count(*) ... is_visible=true and is_key_field=true  => 0
      const cnt = await truth(
        "select count(*)::int as n from field_definitions where organization_id='e7e24eb2-49ba-45cb-88b1-43696d1e9ed8' and entity_type='opportunity' and is_visible=true and is_key_field=true",
      );
      expect(cnt[0]?.n).toBe(0);
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
      // `type` is registered as varchar() → catalogs as 'string', NOT 'enum',
      // and carries NO enumValues — even though the column holds a fixed set of
      // observation types in the data. The catalog reflects the DRIZZLE column
      // shape (varchar), not the de-facto enum in the rows.
      expect(byKey.get('type')).toMatchObject({ type: 'string', eav: false });
      expect(byKey.get('type')?.enumValues).toBeUndefined();
      expect(byKey.get('occurred_at')?.type).toBe('datetime');
      expect(byKey.get('structured_data')?.type).toBe('json');
      expect(byKey.get('normalized_text')?.type).toBe('string');
    });

    it('SUSPECTED-DIVERGENCE: the pgvector `embedding` column catalogs as string', async () => {
      // SUSPECTED-DIVERGENCE: `embedding` is a pgvector customType; columnTypeFromPg
      // has no case for it, so it falls through to the default → 'string'. A
      // 1536-dim vector reported as a string field. Pinned as-is. — revisit
      const cat = await h.service.describe('observations');
      const emb = cat.fields.find((f) => f.key === 'embedding');
      expect(emb).toMatchObject({ type: 'string', eav: false });

      // GROUND TRUTH: the DB column is a USER-DEFINED (vector) type, not text.
      // truth: select data_type from information_schema.columns
      //        where table_name='observations' and column_name='embedding'
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
      expect(keys).toContain('amount'); // EAV passes
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
      for (const k of ['amount', 'dealname', 'deal_currency_code']) {
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

    it('SUSPECTED-DIVERGENCE: an enum field with empty options loses its enumValues key in projection', async () => {
      // toPublicField only emits enumValues when length>0. deal_currency_code is
      // type 'enum' but its options are [] → the public field is an enum with NO
      // enumValues key, indistinguishable from a plain string at the public
      // layer. Pinned as-is. — revisit
      const cat = await h.service.describe('opportunities');
      const pub = projectCatalog(cat);
      const cc = pub.fields.find((f) => f.key === 'deal_currency_code');
      expect(cc?.type).toBe('enum');
      expect(cc).not.toHaveProperty('enumValues'); // empty array dropped
      // a number EAV field's empty enumValues is also dropped (same guard).
      const amount = pub.fields.find((f) => f.key === 'amount');
      expect(amount).not.toHaveProperty('enumValues');
    });

    it('label/note survive projection; note comes from field_definitions.description', async () => {
      const cat = await h.service.describe('opportunities');
      const pub = projectCatalog(cat);
      const amount = pub.fields.find((f) => f.key === 'amount');
      expect(amount?.label).toBe('Amount');
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
      expect(ks.has('amount')).toBe(true);
      expect(ks.has('dealname')).toBe(true);
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
