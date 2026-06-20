// Characterization harness — boots the query-surface package against the LIVE
// dealbrain DB and exposes the PUBLIC surface (QueryApplicationService:
// describe / query / fetch / aggregate / compare).
//
// This is the shared helper the area *.char.eval.spec.ts files import. It pins
// the wiring the engine needs so each area spec only has to characterize
// behavior, not re-derive boot.
//
// What it wires:
//   1. configureQueryRegistry(...) with the SAME 3 dealbrain entities used by
//      model.dealbrain (accounts / opportunities / observations). compiler.ts
//      reads the MODULE-GLOBAL `registry`, so the retrieval path
//      (query / fetch / describe) is dead unless this runs first. makeQuerySurface
//      calls it eagerly in the constructor.
//   2. options.aggregateModel = () => loadDealbrainModel(db) — the SAME builder
//      the aggregate evals use, so aggregate() characterization matches the
//      Drizzle-native eval superset.
//   3. options.actorOrganizationId — dealbrain's opportunity field_definitions
//      are ORG-owned (user_id NULL, organization_id set), so query/fetch EAV
//      resolution must load by org ownership. The org id is read from the DB at
//      boot (DEALBRAIN_ORG below is the live value, asserted at boot to catch a
//      reseed). EAV fields on query/fetch are GATED to is_visible=true (15 keys),
//      UNLIKE the aggregate analytics overlay which is org-scoped UNGATED — a
//      real divergence between the two EAV read paths, see notes.
//   4. options.semanticColumns + options.embed — a DETERMINISTIC embed stub that
//      pulls a real stored observation embedding from the DB for a known phrase,
//      so a semantic-rank spec can assert that row ranks #1 with similarity≈1.
//      NOTE: semantic rank needs the `embedding` column to be a REGISTERED
//      Drizzle column. model.dealbrain's observations table omits it, so the
//      harness registers an EXTENDED observations table (schema.dealbrain's
//      columns + embedding + normalized_text). The cardinality graph + EAV
//      behavior are unchanged — the extra columns are purely additive.

import { relations, sql } from 'drizzle-orm';
import { POC_ACTOR_USER_ID } from '../adapters/drizzle/eav/field-map.ts';
import { type DrizzleDb, makeDb } from '../adapters/drizzle/execute/drizzle-db.ts';
import { configureQueryRegistry } from '../adapters/drizzle/registry/registry.ts';
import { loadDealbrainModel } from '../adapters/reference/model.dealbrain.ts';
import {
  accounts,
  accountsRelations,
  fieldValues,
  opportunities,
  opportunitiesRelations,
} from '../adapters/reference/schema.dealbrain.ts';
import { QueryApplicationService } from '../query.application-service.ts';

import { customType, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

// pgvector column — registered so the compiler's semantic-rank path
// (`${embCol} <=> ${vec}::vector`) can resolve `observations.embedding`.
const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return 'vector';
  },
});

// Observations table EXTENDED with the columns model.dealbrain.ts omits
// (embedding / normalized_text), so semantic + lexical ranking are exercisable
// through the public surface. Same db table, same relations — purely additive.
export const observationsExt = pgTable('observations', {
  id: uuid('id').primaryKey(),
  accountId: uuid('account_id'),
  opportunityId: uuid('opportunity_id'),
  type: varchar('type'),
  occurredAt: timestamp('occurred_at'),
  structuredData: jsonb('structured_data'),
  normalizedText: text('normalized_text'),
  embedding: vector('embedding'),
});

export const observationsExtRelations = relations(observationsExt, ({ one }) => ({
  opportunity: one(opportunities, {
    fields: [observationsExt.opportunityId],
    references: [opportunities.id],
  }),
  account: one(accounts, {
    fields: [observationsExt.accountId],
    references: [accounts.id],
  }),
}));

// The live dealbrain organization that owns the opportunity field_definitions.
// Asserted at boot (makeQuerySurface) so a reseed that changes it fails loudly
// instead of silently resolving zero EAV fields.
export const DEALBRAIN_ORG = 'a30c290d-6798-4da7-b3af-7b48c50212b8';

export interface QuerySurfaceHarness {
  service: QueryApplicationService;
  db: DrizzleDb;
  close: () => Promise<void>;
}

/**
 * Boot the query-surface against live dealbrain.
 *
 * configureQueryRegistry runs EAGERLY here (the module-global registry must be
 * populated before any compile()), with the same 3 entities as model.dealbrain
 * — opportunities carries the typed-columns EAV strategy so EAV keys resolve on
 * query/fetch; observations is the EXTENDED table (adds embedding/normalized_text
 * for ranking).
 */
export function makeQuerySurface(
  dburl: string,
  opts?: {
    embed?: (text: string) => Promise<number[]>;
    // Host-resolved measures (the field-management app's semantic layer). Omitted → the built-in
    // default set. When provided, the aggregate model's measures are DATA-DRIVEN + gated.
    measureSpecs?: import('../adapters/reference/model.dealbrain.ts').DealbrainMeasureSpec[];
    // Host-resolved EAV dimensions (groupable select/text fields). Omitted → none.
    dimensionSpecs?: import('../adapters/reference/model.dealbrain.ts').DealbrainDimensionSpec[];
  },
): QuerySurfaceHarness {
  const { db, close } = makeDb(dburl);

  configureQueryRegistry([
    { name: 'accounts', table: accounts, relations: accountsRelations },
    {
      name: 'opportunities',
      table: opportunities,
      relations: opportunitiesRelations,
      eav: { kind: 'typed-columns', valueTable: fieldValues, entityTypeValue: 'opportunity' },
    },
    {
      name: 'observations',
      table: observationsExt,
      relations: observationsExtRelations,
    },
  ]);

  // Deterministic embed stub: for a known phrase, return a REAL stored embedding
  // so that observation ranks #1 with similarity ≈ 1; otherwise return a zero
  // vector (every similarity ≈ 0 — semantic rank still runs, just flat). The
  // phrase→embedding lookup is by exact normalized_text prefix match, cached.
  const embedCache = new Map<string, number[]>();
  const embed = async (text: string): Promise<number[]> => {
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

  const service = new QueryApplicationService(db, {
    // actorUserId is REQUIRED by eav() even when org-scoped — the WHERE branches
    // on organizationId (loadFieldMap), so userId only satisfies the guard. The
    // POC constant is fine: dealbrain's defs are org-owned (user_id NULL).
    actorUserId: POC_ACTOR_USER_ID,
    actorOrganizationId: DEALBRAIN_ORG,
    aggregateModel: () => loadDealbrainModel(db, opts?.measureSpecs, opts?.dimensionSpecs),
    semanticColumns: { observations: { normalized_text: 'embedding' } },
    // Default: the deterministic ILIKE stub (specs are hermetic). A caller (e.g. the demo) may
    // inject a REAL embed provider to exercise true free-text concepts against the stored vectors.
    embed: opts?.embed ?? embed,
  });

  return { service, db, close };
}
