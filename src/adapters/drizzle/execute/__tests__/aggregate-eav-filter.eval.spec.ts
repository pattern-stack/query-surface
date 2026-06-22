// EAV-dimension FILTER in aggregate/compare — the verb the EAV bypass used to miss. EAV dims were
// groupable + measurable but not filterable (the filter lowering had no EAV branch; the gate only
// checked native colByDbName). This pins: an EAV-dim filter narrows correctly (== field_values
// truth), composes with EAV group/measure, AND a cross-source EAV filter still REJECTS (conformance
// preserved — EAV-ness is orthogonal to the conformed-dimension rule).
//
//   DBURL=postgres://postgres:PW@localhost:54321/dealbrain bun test aggregate-eav-filter.eval

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { type DealbrainModel, loadDealbrainModel } from '../../../reference/model.dealbrain';
import { type DrizzleDb, makeDb } from '../drizzle-db';
import { runAggregateDrizzle } from '../run-drizzle';

const DBURL = process.env.DBURL;
const suite = DBURL ? describe : describe.skip;
// StageName is an EAV select field on opportunities (field_values.value_text). Key the truth-SQL
// the SAME way the engine resolves the dim (by field_definitions.key), not a display label.
const STAGE_DEF = `(select id from field_definitions where entity_type='opportunity' and key='StageName')`;

suite(
  'aggregate EAV-dim filter — narrows, composes, conformance preserved (live dealbrain)',
  () => {
    let db: DrizzleDb;
    let close: () => Promise<void>;
    let model: DealbrainModel;
    const truth = async (text: string) =>
      (await db.execute(sql.raw(text))).rows as Record<string, unknown>[];
    const num = (v: unknown) => Number(v);

    beforeAll(async () => {
      ({ db, close } = makeDb(DBURL!));
      // load WITH a `stage` EAV dimension (← field_def StageName) — the default specs register none.
      model = await loadDealbrainModel(db, undefined, [{ name: 'stage', key: 'StageName' }]);
    });
    afterAll(async () => {
      await close?.();
    });

    it('E1 EAV-dim filter narrows == field_values truth, ≠ unfiltered', async () => {
      const filtered = await runAggregateDrizzle(db, model, {
        entity: 'opportunities',
        filter: { on: 'stage', op: 'eq', value: 'closed_won' },
        measures: [{ on: '*', agg: 'count' as const, as: 'n' }],
      });
      const all = await runAggregateDrizzle(db, model, {
        entity: 'opportunities',
        measures: [{ on: '*', agg: 'count' as const, as: 'n' }],
      });
      const ref = await truth(
        `select count(*)::int n from opportunities o join field_values fv on fv.entity_id=o.id and fv.field_definition_id=${STAGE_DEF} where fv.value_text='closed_won'`,
      );
      expect(num(filtered.rows[0]!.n)).toBe(num(ref[0]!.n)); // the EAV filter applied
      expect(num(ref[0]!.n)).toBeLessThan(num(all.rows[0]!.n)); // it genuinely narrows
    });

    it('E2 EAV filter composes with an EAV measure (sum within the filtered set)', async () => {
      const res = await runAggregateDrizzle(db, model, {
        entity: 'opportunities',
        filter: { on: 'stage', op: 'eq', value: 'closed_won' },
        measures: [{ on: 'Amount', agg: 'sum' as const, as: 'usd' }],
      });
      const ref = await truth(
        `select sum(amt.value_number) s from opportunities o
         join field_values st on st.entity_id=o.id and st.field_definition_id=${STAGE_DEF} and st.value_text='closed_won'
         join field_values amt on amt.entity_id=o.id and amt.field_definition_id=(select id from field_definitions where entity_type='opportunity' and key='Amount')`,
      );
      expect(num(res.rows[0]!.usd)).toBeCloseTo(num(ref[0]!.s), 2);
    });

    it('E3 EAV filter `in` composes with an EAV group_by dim', async () => {
      const res = await runAggregateDrizzle(db, model, {
        entity: 'opportunities',
        filter: { on: 'stage', op: 'in', value: ['closed_won', 'closed_lost'] },
        group_by: ['stage'],
        measures: [{ on: '*', agg: 'count' as const, as: 'n' }],
      });
      const got = Object.fromEntries(res.rows.map((r) => [r.stage, num(r.n)]));
      const ref = await truth(
        `select fv.value_text stage, count(*)::int n from opportunities o join field_values fv on fv.entity_id=o.id and fv.field_definition_id=${STAGE_DEF} where fv.value_text in ('closed_won','closed_lost') group by 1`,
      );
      for (const r of ref) expect(got[r.stage as string]).toBe(num(r.n));
      expect(res.rows.every((r) => r.stage === 'closed_won' || r.stage === 'closed_lost')).toBe(
        true,
      );
    });

    it('E4 cross-source EAV filter REJECTS — conformance preserved (stage not on observations)', async () => {
      await expect(
        runAggregateDrizzle(db, model, {
          entity: 'opportunities',
          filter: { on: 'stage', op: 'eq', value: 'closed_won' },
          measures: [
            { on: '*', agg: 'count' as const, as: 'n' },
            { source: 'observations', on: '*', agg: 'count' as const, as: 'obs' },
          ],
        }),
      ).rejects.toThrow(/not queryable on observations/);
    });

    it('E5 filter by a PascalCase EAV measure key (Amount) — alias sanitizes, not rejects', async () => {
      // regression: the filter alias used assertIdent(head), which rejects PascalCase EAV keys
      // ("Amount") as "unsafe identifier"; toIdentifier sanitizes them. Also exercises a numeric
      // (value_number) EAV filter, not just value_text.
      const res = await runAggregateDrizzle(db, model, {
        entity: 'opportunities',
        filter: { on: 'Amount', op: 'gte', value: 100000 },
        measures: [{ on: '*', agg: 'count' as const, as: 'n' }],
      });
      const ref = await truth(
        `select count(*)::int n from opportunities o join field_values fv on fv.entity_id=o.id and fv.field_definition_id=(select id from field_definitions where entity_type='opportunity' and key='Amount') where fv.value_number >= 100000`,
      );
      expect(num(res.rows[0]!.n)).toBe(num(ref[0]!.n));
      expect(num(res.rows[0]!.n)).toBeGreaterThan(0);
    });
  },
);
