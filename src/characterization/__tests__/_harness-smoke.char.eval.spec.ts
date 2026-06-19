// Smoke test for the characterization harness — proves makeQuerySurface() boots
// the query-surface against live dealbrain and the PUBLIC describe() surface
// returns the expected catalog. Area *.char.eval.spec.ts files copy this boot.
//
//   DBURL=postgres://postgres:password@localhost:54321/dealbrain \
//     bun test src/characterization/_harness-smoke.char.eval.spec.ts

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { DEALBRAIN_ORG, type QuerySurfaceHarness, makeQuerySurface } from '../harness.ts';

const DBURL = process.env.DBURL;
const suite = DBURL ? describe : describe.skip;

suite('characterization harness — smoke', () => {
  let h: QuerySurfaceHarness;
  beforeAll(() => {
    h = makeQuerySurface(DBURL!);
  });
  afterAll(async () => {
    await h.close();
  });

  it('boots: the org owning opportunity field_definitions is the wired one', async () => {
    // Ground truth — if a reseed changed the org, EAV would silently resolve 0
    // fields. Pin the live value the harness wires.
    const truth = await h.db.execute(
      sql`select distinct organization_id::text as org from field_definitions
          where entity_type='opportunity' and organization_id is not null`,
    );
    const orgs = (truth.rows as Array<{ org: string }>).map((r) => r.org);
    expect(orgs).toEqual([DEALBRAIN_ORG]);
  });

  it("describe('accounts') exposes the 'name' field + a relationship to opportunities", async () => {
    const cat = await h.service.describe('accounts');
    expect(cat.entity).toBe('accounts');
    // 'name' is a native column on accounts (varchar).
    expect(cat.fields.map((f) => f.key)).toContain('name');
    // belongs_to/has_many graph derived from accountsRelations: accounts has_many
    // opportunities + observations.
    const rels = cat.relationships;
    const toOpps = rels.find((r) => r.target === 'opportunities');
    expect(toOpps).toBeDefined();
    expect(toOpps?.kind).toBe('has_many');
    expect(rels.find((r) => r.target === 'observations')).toBeDefined();
  });

  it('describe() over all entities returns the 3 registered dealbrain entities', async () => {
    const all = await h.service.describe();
    expect(all.map((c) => c.entity).sort()).toEqual(['accounts', 'observations', 'opportunities']);
  });
});
