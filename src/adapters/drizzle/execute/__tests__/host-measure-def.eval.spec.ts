// HOST-NAMED MEASURE DEFS — the `measureDefs` registration hook (instances-by-data). A host can
// register a STABLE SLUG → MeasureDef on top of the auto-derived `Field.agg` catalog, so an agent
// calls a measure by name ({ref:'total_revenue'}) instead of guessing on/agg. The slug is the
// agent-facing contract; the display name rides as the def's label.
//
// Pins: (E1) a custom slug resolves identically to its inline measure (the ref is just a NAME for the
// same atomic); (E2) describeMeasures advertises the slug (discoverable); (E3) a slug that shadows an
// auto-derived key is refused at model load; (E4) a def over an unregistered field is refused.
//
//   DBURL=postgres://postgres:password@localhost:54321/dealbrain \
//     bun test src/adapters/drizzle/execute/__tests__/host-measure-def.eval.spec.ts

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type QuerySurfaceHarness, makeQuerySurface } from '../../../../characterization/harness.ts';
import { loadDealbrainModel } from '../../../reference/model.dealbrain';

const DBURL = process.env.DBURL;
const suite = DBURL ? describe : describe.skip;

// stage (EAV dim) so we can group; ExpectedRevenue is a DEFAULT measure field → its EAV binding +
// role already exist, so a host def over it validates + compiles.
const DIMENSION_SPECS = [{ name: 'stage', key: 'StageName' }];
const MEASURE_DEFS = {
  total_revenue: {
    kind: 'atomic' as const,
    on: 'ExpectedRevenue',
    agg: 'sum' as const,
    source: 'opportunities',
    additivity: 'additive' as const,
    label: 'Total Revenue',
  },
};

suite('host measure defs — call a measure by its stable slug ({ref})', () => {
  let h: QuerySurfaceHarness;

  beforeAll(() => {
    h = makeQuerySurface(DBURL!, { dimensionSpecs: DIMENSION_SPECS, measureDefs: MEASURE_DEFS });
  });
  afterAll(async () => {
    await h.close();
  });

  it('E1 {ref:"total_revenue"} resolves identically to its inline measure (grouped by stage)', async () => {
    const bySlug = await h.service.measure('opportunities', {
      group_by: ['stage'],
      measures: [{ ref: 'total_revenue', as: 'total_revenue' } as never],
    });
    const inline = await h.service.measure('opportunities', {
      group_by: ['stage'],
      measures: [{ on: 'ExpectedRevenue', agg: 'sum', as: 'total_revenue' }],
    });
    const norm = (rows: Record<string, unknown>[]) =>
      new Map(rows.map((r) => [String(r.stage), Number(r.total_revenue)]));
    const a = norm(bySlug.rows);
    const b = norm(inline.rows);
    expect(a.size).toBeGreaterThan(0);
    expect(a.size).toBe(b.size);
    for (const [k, v] of a) expect(v).toBe(b.get(k)!);
  });

  it('E1b a count(id) host def over the entity PK equals count(*) per group', async () => {
    // count(id) is registerable (id is a real field) AND ≡ count(*) (PK is non-null) — so an entity
    // COUNT can be a first-class catalog measure, unlike count(*) which the field-keyed catalog can't name.
    const h2 = makeQuerySurface(DBURL!, {
      dimensionSpecs: DIMENSION_SPECS,
      measureDefs: {
        opportunity_count: {
          kind: 'atomic',
          on: 'id',
          agg: 'count',
          source: 'opportunities',
          additivity: 'additive',
          label: 'Opportunity Count',
        },
      },
    });
    try {
      const byRef = await h2.service.measure('opportunities', {
        group_by: ['stage'],
        measures: [{ ref: 'opportunity_count', as: 'n' } as never],
      });
      const star = await h2.service.measure('opportunities', {
        group_by: ['stage'],
        measures: [{ on: '*', agg: 'count', as: 'n' }],
      });
      const norm = (rows: Record<string, unknown>[]) =>
        new Map(rows.map((r) => [String(r.stage), Number(r.n)]));
      const a = norm(byRef.rows);
      const b = norm(star.rows);
      expect(a.size).toBe(b.size);
      for (const [k, v] of a) expect(v).toBe(b.get(k)!);
    } finally {
      await h2.close();
    }
  });

  it('E2 describeMeasures advertises the slug (discoverable by name)', async () => {
    const measures = await h.service.describeMeasures('opportunities');
    const entry = measures.find((m) => m.name === 'total_revenue');
    expect(entry).toBeDefined();
    expect(entry?.on).toBe('ExpectedRevenue');
    expect(entry?.agg).toBe('sum');
  });

  it('E2b describe() advertises the primary key (so a count(pk) measure needs no hardcoded id)', async () => {
    for (const e of ['opportunities', 'accounts', 'observations'] as const) {
      const cat = await h.service.describe(e);
      expect(cat.primaryKey).toBe('id');
    }
  });

  it('E3 a slug that shadows an auto-derived catalog key is refused at model load', async () => {
    await expect(
      loadDealbrainModel(h.db, undefined, DIMENSION_SPECS, {
        'ExpectedRevenue.sum': { ...MEASURE_DEFS.total_revenue },
      }),
    ).rejects.toThrow(/collides/i);
  });

  it('E4 a def over an unregistered field is refused', async () => {
    await expect(
      loadDealbrainModel(h.db, undefined, DIMENSION_SPECS, {
        bogus_measure: {
          kind: 'atomic',
          on: 'not_a_registered_field',
          agg: 'sum',
          source: 'opportunities',
          additivity: 'additive',
        },
      }),
    ).rejects.toThrow();
  });
});
