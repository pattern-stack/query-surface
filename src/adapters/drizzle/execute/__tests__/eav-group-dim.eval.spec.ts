// EAV-FIELDS-AS-CONFORMED-DIMENSIONS — aggregate() group_by an EAV select/text field (ADR-0025 §3,
// the field-management semantic-layer binding). An EAV dim is a 1:1 field_values LEFT JOIN, grain-safe
// (groupable like a to-one dim, NEVER a fan-out). Referenced by its safe canonical name (e.g. 'stage'),
// which maps to the dealbrain key ('StageName') via the host-supplied dimensionSpecs.
//
// DETERMINISM: every expected value is recomputed from raw SQL through the SAME pool AT TEST TIME
// (the Bean Maxx fixture is non-hermetic). Run:
//   DBURL=postgres://postgres:password@localhost:54321/dealbrain \
//     bun test src/adapters/drizzle/execute/__tests__/eav-group-dim.eval.spec.ts

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import {
  type QuerySurfaceHarness,
  makeQuerySurface,
} from '../../../../characterization/harness.ts';

const DBURL = process.env.DBURL;
const suite = DBURL ? describe : describe.skip;

suite('EAV fields as conformed group dimensions — aggregate() (ADR-0025 §3)', () => {
  let h: QuerySurfaceHarness;
  beforeAll(() => {
    h = makeQuerySurface(DBURL!, {
      measureSpecs: [{ key: 'ExpectedRevenue', aggs: ['sum'], additivity: 'additive' }],
      dimensionSpecs: [
        { name: 'stage', key: 'StageName' },
        { name: 'deal_size_band', key: 'deal_size_band' },
      ],
    });
  });
  afterAll(async () => {
    await h.close();
  });

  const truth = async <T = Record<string, unknown>>(q: string) =>
    (await h.db.execute(sql.raw(q))).rows as T[];
  const num = (v: unknown) => Number(v);

  // A field_values CTE for a given dealbrain field key — the 1:1 (entity → value) the engine joins.
  const fv = (key: string, col: 'value_text' | 'value_number') =>
    `(select fv.entity_id eid, fv.${col} v from field_values fv
        join field_definitions fd on fd.id = fv.field_definition_id where fd.key = '${key}')`;

  it('R1 group_by an EAV dim (deal_size_band): per-group Σ weighted_amount == SQL ground truth', async () => {
    const expected = await truth<{ band: string; pipeline: string; deals: string }>(
      `select b.v as band, sum(e.v)::bigint as pipeline, count(distinct o.id) as deals
         from opportunities o
         join ${fv('deal_size_band', 'value_text')} b on b.eid = o.id
         left join ${fv('ExpectedRevenue', 'value_number')} e on e.eid = o.id
        group by b.v order by pipeline desc`,
    );

    const res = await h.service.measure(
      'opportunities',
      {
        group_by: ['deal_size_band'],
        measures: [
          { on: 'ExpectedRevenue', agg: 'sum', as: 'pipeline' },
          { on: '*', agg: 'count', as: 'deals' },
        ],
        order_by: [{ on: 'pipeline', dir: 'desc' }],
      },
      { include_sql: true },
    );

    // Set identity: the engine's grouped rows == the SQL ground truth, group-for-group.
    const got = new Map(res.rows.map((r) => [String(r.deal_size_band), r]));
    expect(res.rows.length).toBe(expected.length);
    for (const e of expected) {
      const r = got.get(e.band);
      expect(r).toBeDefined();
      expect(num(r!.pipeline)).toBe(num(e.pipeline));
      expect(num(r!.deals)).toBe(num(e.deals));
    }

    // GRAIN-SAFETY: a 1:1 field_values JOIN (not a fan). SQL shows the join + group by the value
    // column; NOT a SELECT DISTINCT over a multiplying join.
    expect(res.sql?.toLowerCase()).toContain('field_values');
    expect(res.sql?.toLowerCase()).toContain('value_text');
    expect(res.sql?.toLowerCase()).not.toContain('select distinct');
  });

  it('R2 grain-safety: per-group deal counts sum to the total population (no EAV-join fan-out)', async () => {
    // deal_size_band covers ~all opps; the grouped count must not exceed the opp count (a fan would
    // inflate it). We assert Σ(group deals) == count of opps that HAVE a deal_size_band value.
    const [{ n: withBand }] = await truth<{ n: string }>(
      `select count(distinct o.id) n from opportunities o
         join ${fv('deal_size_band', 'value_text')} b on b.eid = o.id`,
    );
    const res = await h.service.measure('opportunities', {
      group_by: ['deal_size_band'],
      measures: [{ on: '*', agg: 'count', as: 'deals' }],
    });
    const summed = res.rows.reduce((s, r) => s + num(r.deals), 0);
    expect(summed).toBe(num(withBand)); // exact — a fan-out join would over-count
  });

  it('R3 EAV dim WITHIN a relevance cohort: grouped Σ over the cohort == SQL ground truth', async () => {
    const ANCHOR = 'security review';
    const THRESHOLD = 0.55;
    // Ground truth: opps with a matching observation (EXISTS), grouped by their deal_size_band.
    const Q = `(select embedding e from observations where embedding is not null and normalized_text is not null
                and normalized_text ilike '%${ANCHOR}%' order by id limit 1)`;
    const expected = await truth<{ band: string; pipeline: string }>(
      `with q as ${Q}
       select b.v as band, sum(er.v)::bigint as pipeline
         from opportunities o
         join ${fv('deal_size_band', 'value_text')} b on b.eid = o.id
         left join ${fv('ExpectedRevenue', 'value_number')} er on er.eid = o.id
        where exists (select 1 from observations ob, q where ob.opportunity_id = o.id
                      and ob.embedding is not null and (1 - (ob.embedding <=> q.e)) >= ${THRESHOLD})
        group by b.v order by pipeline desc`,
    );

    const res = await h.service.measure('opportunities', {
      group_by: ['deal_size_band'],
      measures: [{ on: 'ExpectedRevenue', agg: 'sum', as: 'pipeline' }],
      filter: {
        on: 'observations.normalized_text',
        op: 'relevant',
        query: ANCHOR,
        threshold: THRESHOLD,
      },
      order_by: [{ on: 'pipeline', dir: 'desc' }],
    });

    const got = new Map(res.rows.map((r) => [String(r.deal_size_band), num(r.pipeline)]));
    expect(res.rows.length).toBe(expected.length);
    for (const e of expected) expect(got.get(e.band)).toBe(num(e.pipeline));
  });

  it('R4 an UNDECLARED EAV field is NOT groupable (closed-by-default): rejects, never silently drops', async () => {
    // 'champion_status' exists in dealbrain but is NOT in dimensionSpecs here → not conformed → reject.
    await expect(
      h.service.measure('opportunities', {
        group_by: ['champion_status'],
        measures: [{ on: 'ExpectedRevenue', agg: 'sum', as: 'p' }],
      }),
    ).rejects.toThrow(/champion_status/);
  });
});
