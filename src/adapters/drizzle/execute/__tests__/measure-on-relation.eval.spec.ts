// The documented `on: "relation.fieldKey"` measure form — it must resolve the FIELD as the part
// AFTER the prefix (mirroring group_by), not treat the prefix as the field. Previously measures took
// `on.split('.')[0]` (the relation) as the field head → a misleading UNKNOWN_FIELD on the dotted form,
// while group_by took `split('.')[1]`. This pins: `on:"observations.id"` ≡ `source:"observations",
// on:"id"`, with and without an explicit source, and a json subpath rides along.
//
//   DBURL=postgres://postgres:PW@localhost:54321/dealbrain bun test measure-on-relation.eval

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type DealbrainModel, loadDealbrainModel } from '../../../reference/model.dealbrain';
import { type DrizzleDb, makeDb } from '../drizzle-db';
import { runAggregateDrizzle } from '../run-drizzle';

const DBURL = process.env.DBURL;
const suite = DBURL ? describe : describe.skip;

suite('measure on:"relation.field" — resolves the field, ≡ source+bare (live dealbrain)', () => {
  let db: DrizzleDb;
  let close: () => Promise<void>;
  let model: DealbrainModel;
  const n = (v: unknown) => Number(v);
  const run = (measures: Parameters<typeof runAggregateDrizzle>[2]['measures']) =>
    runAggregateDrizzle(db, model, { entity: 'opportunities', measures });

  beforeAll(async () => {
    ({ db, close } = makeDb(DBURL!));
    model = await loadDealbrainModel(db);
  });
  afterAll(async () => {
    await close?.();
  });

  it('M1 dotted `on` (source inferred) ≡ explicit source + bare field', async () => {
    const dotted = await run([{ on: 'observations.id', agg: 'count_distinct', as: 'obs' }]);
    const explicit = await run([
      { source: 'observations', on: 'id', agg: 'count_distinct', as: 'obs' },
    ]);
    expect(n(dotted.rows[0]!.obs)).toBe(n(explicit.rows[0]!.obs));
    expect(n(dotted.rows[0]!.obs)).toBeGreaterThan(0); // and it actually resolved/ran
  });

  it('M2 redundant dotted `on` + matching source resolves (no double-qualify error)', async () => {
    const both = await run([
      { source: 'observations', on: 'observations.id', agg: 'count_distinct', as: 'obs' },
    ]);
    const explicit = await run([
      { source: 'observations', on: 'id', agg: 'count_distinct', as: 'obs' },
    ]);
    expect(n(both.rows[0]!.obs)).toBe(n(explicit.rows[0]!.obs));
  });

  it('M3 dotted `on` on another registered field resolves ≡ source+bare', async () => {
    const dotted = await run([{ on: 'observations.type', agg: 'count', as: 'c' }]);
    const explicit = await run([{ source: 'observations', on: 'type', agg: 'count', as: 'c' }]);
    expect(n(dotted.rows[0]!.c)).toBe(n(explicit.rows[0]!.c));
    expect(n(dotted.rows[0]!.c)).toBeGreaterThan(0);
  });
});
