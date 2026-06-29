// CONFORMED MULTI-SOURCE GROUP DIM (ADR-0024 Amendment 4) — a conformed group dim resolves at
// EVERY measure leg source in a multi-source measure(), not just the query root. The headline:
// measure('opportunities', group_by ['stage'], measures [rev on opportunities, obs count on
// observations]) — `stage` is an EAV dim on opportunities; observations belongs_to opportunities
// (to-one), so opportunities.stage is conformed at the observations grain (invariant #5). PRE-FIX
// this threw "unknown column stage on observations" (the non-root leg's bare-name resolution
// short-circuited to {kind:'local'} with no existence check). POST-FIX the bare name resolves
// to-one through the belongs_to + field_values join — the SAME path the dotted form
// (group_by ['opportunities.stage']) already proved (eav-to-one-dim E1).
//
// GROUND TRUTH is computed INDEPENDENTLY: each leg is aggregated ALONE via the SAME public
// surface (rev single-source on opportunities; obs via the proven to-one
// group_by ['opportunities.stage'] path on observations), then compared per stage value.
//
// NULL-bucket note: the multi-source FULL OUTER JOIN keys on the bare `stage` alias with a
// coalesce, and NULL≠NULL, so the NULL-stage bucket arrives as TWO leg-disjoint rows. Every
// truth assertion therefore BUCKET-SUMS by a null-sentinelled stage value (exact for non-null
// single rows AND the split null bucket). This NULL split is pre-existing multi-source behavior,
// orthogonal to Amendment 4.
//
//   DBURL=postgres://postgres:password@localhost:54321/dealbrain \
//     bun test src/adapters/drizzle/execute/__tests__/conformed-multisource.eval.spec.ts

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  type QuerySurfaceHarness,
  makeQuerySurface,
} from '../../../../characterization/harness.ts';

const DBURL = process.env.DBURL;
const suite = DBURL ? describe : describe.skip;

const DIMENSION_SPECS = [{ name: 'stage', key: 'StageName' }];

// Bucket-SUM rows by a null-sentinelled key value (absorbs the full-outer-join NULL-stage split).
const bucket = (rows: Record<string, unknown>[], keyField: string, valField: string) => {
  const m = new Map<string, number>();
  for (const r of rows) {
    const raw = r[keyField];
    const k = raw == null ? '<null>' : String(raw);
    m.set(k, (m.get(k) ?? 0) + Number(r[valField] ?? 0));
  }
  return m;
};

suite(
  'conformed multi-source group dim — every measure leg resolves it (ADR-0024 Amendment 4)',
  () => {
    let h: QuerySurfaceHarness;

    beforeAll(() => {
      h = makeQuerySurface(DBURL!, { dimensionSpecs: DIMENSION_SPECS });
    });
    afterAll(async () => {
      await h.close();
    });

    // ── CM1 HEADLINE — a NON-derived multi-source aggregate grouped by an EAV dim, BOTH legs ──────
    it('CM1 group_by [stage] over a rev (root) + obs (observations) measure — both un-inflated', async () => {
      // PRE-FIX this threw "unknown column stage on observations".
      const combined = await h.service.measure('opportunities', {
        group_by: ['stage'],
        measures: [
          { on: 'ExpectedRevenue', agg: 'sum', as: 'rev' },
          { on: 'id', agg: 'count', source: 'observations', as: 'obs' } as never,
        ],
      });
      // independent ground truth: each leg aggregated ALONE.
      const revT = await h.service.measure('opportunities', {
        group_by: ['stage'],
        measures: [{ on: 'ExpectedRevenue', agg: 'sum', as: 'rev' }],
      });
      const obsT = await h.service.measure('observations', {
        group_by: ['opportunities.stage'],
        measures: [{ on: 'id', agg: 'count', as: 'obs' } as never],
      });

      const revBy = bucket(revT.rows as Record<string, unknown>[], 'stage', 'rev');
      const obsBy = bucket(obsT.rows as Record<string, unknown>[], 'opportunities.stage', 'obs');
      const gotRev = bucket(combined.rows as Record<string, unknown>[], 'stage', 'rev');
      const gotObs = bucket(combined.rows as Record<string, unknown>[], 'stage', 'obs');

      expect(gotRev.size).toBeGreaterThan(0);
      const keys = new Set([...revBy.keys(), ...obsBy.keys()]);
      for (const k of keys) {
        expect(gotRev.get(k) ?? 0).toBeCloseTo(revBy.get(k) ?? 0, 4); // rev un-inflated
        expect(gotObs.get(k) ?? 0).toBe(obsBy.get(k) ?? 0); // obs un-inflated, reached via to-one
      }
      // non-degeneracy: more than one non-null stage AND some obs reached via the non-root to-one.
      expect([...obsBy.keys()].filter((k) => k !== '<null>').length).toBeGreaterThan(1);
      expect([...obsBy.values()].some((v) => v > 0)).toBe(true);
      // obs TOTAL conserved (un-inflated across the whole population).
      expect([...gotObs.values()].reduce((a, b) => a + b, 0)).toBe(
        [...obsBy.values()].reduce((a, b) => a + b, 0),
      );
    });

    // ── CM2 SQL-shape witness — the non-root leg lowered the composed belongs_to + field_values ───
    it('CM2 SQL: root EAV-on-source join (fvg_stage) + non-root to-one EAV join (fvt_opportunities_stage)', async () => {
      const r = await h.service.measure(
        'opportunities',
        {
          group_by: ['stage'],
          measures: [
            { on: 'ExpectedRevenue', agg: 'sum', as: 'rev' },
            { on: 'id', agg: 'count', source: 'observations', as: 'obs' } as never,
          ],
        },
        { include_sql: true },
      );
      const s = r.sql!.toLowerCase();
      expect(s).toContain('field_values');
      expect(s).toContain('fvg_stage'); // root opportunities EAV-on-source group join
      expect(s).toContain('fvt_opportunities_stage'); // observations-leg to-one EAV join
      expect(s).toContain('left join'); // the belongs_to + field_values inner-CTE joins
      expect(s).toContain('full join'); // the multi-source outer join on the shared bare alias
      expect(s).not.toContain('select distinct');
    });

    // ── CM3 LOCAL-STAYS-LOCAL — a name that IS a native field on the source is NEVER searched ─────
    it('CM3 group_by [account_id] (native on BOTH) resolves LOCAL on every leg, no EAV search', async () => {
      const r = await h.service.measure(
        'opportunities',
        {
          group_by: ['account_id'],
          measures: [
            { on: 'ExpectedRevenue', agg: 'sum', as: 'rev' },
            { on: 'id', agg: 'count', source: 'observations', as: 'obs' } as never,
          ],
        },
        { include_sql: true },
      );
      // account_id is a NATIVE column on BOTH opportunities and observations → resolved LOCAL, never
      // via a to-one/EAV search (the existence check keeps it local). NO field_values join for it.
      expect(r.sql!.toLowerCase()).not.toMatch(/fvt_[a-z_]*account_id/);

      const revT = await h.service.measure('opportunities', {
        group_by: ['account_id'],
        measures: [{ on: 'ExpectedRevenue', agg: 'sum', as: 'rev' }],
      });
      const obsT = await h.service.measure('opportunities', {
        group_by: ['account_id'],
        measures: [{ on: 'id', agg: 'count', source: 'observations', as: 'obs' } as never],
      });
      const revBy = bucket(revT.rows as Record<string, unknown>[], 'account_id', 'rev');
      const obsBy = bucket(obsT.rows as Record<string, unknown>[], 'account_id', 'obs');
      const gotRev = bucket(r.rows as Record<string, unknown>[], 'account_id', 'rev');
      const gotObs = bucket(r.rows as Record<string, unknown>[], 'account_id', 'obs');
      expect(gotRev.size).toBeGreaterThan(0);
      const keys = new Set([...revBy.keys(), ...obsBy.keys()]);
      for (const k of keys) {
        expect(gotRev.get(k) ?? 0).toBeCloseTo(revBy.get(k) ?? 0, 4);
        expect(gotObs.get(k) ?? 0).toBe(obsBy.get(k) ?? 0);
      }
    });

    // ── CM4 SAFETY BOUNDARY (the CLEAN to-many pin) — a to-many-owned group dim REJECTS (dotted) ──
    it('CM4 multi-source group_by [opportunities.stage] from accounts (to-many) REJECTS — no fan', async () => {
      // accounts→opportunities is has_many, so the accounts root leg's lowerGroupDim→resolveJoinPlan
      // (dotted) hits the existing group-role to-many reject BEFORE any lowering. This is the canonical
      // typed boundary pin (precise "to-many … would fan out" message), now exercised in a MULTI-source
      // query (sources = accounts + observations) so the new bare-name search opens no fan hole.
      await expect(
        h.service.measure('accounts', {
          group_by: ['opportunities.stage'],
          measures: [
            { on: '*', agg: 'count', as: 'nacc' },
            { on: 'id', agg: 'count', source: 'observations', as: 'nobs' } as never,
          ],
        }),
      ).rejects.toThrow(/to-many|fan out|not conformed/i);
    });

    // ── CM5 SAFETY BOUNDARY (the bare-name variant) — a name owned ONLY by a to-many child REFUSES ─
    it('CM5 multi-source group_by [stage] from accounts (to-many child owns stage) FAILS LOUD', async () => {
      // bare `stage` at the accounts root leg: reg['accounts'].fields['stage'] is absent AND
      // belongsToPaths(accounts, opportunities) = [] (to-many) ⇒ 0 to-one candidates ⇒ local
      // fallback ⇒ nativeColSql throws unknown-column. Proves the new bare-name search degrades to a
      // LOUD refusal (it only walks belongsToPaths = to-one paths), never invents a fan join.
      // NOTE: the fixture cannot express a bare dim BOTH absent on the parent AND owned by a to-many
      // child with a typed message, so CM4's dotted form is the canonical typed pin; CM5 pins that the
      // bare-name path fails loud (closest available refusal for the bare path).
      await expect(
        h.service.measure('accounts', {
          group_by: ['stage'],
          measures: [
            { on: '*', agg: 'count', as: 'nacc' },
            { on: 'id', agg: 'count', source: 'observations', as: 'nobs' } as never,
          ],
        }),
      ).rejects.toThrow(/unknown column|not a groupable dimension|stage/i);
    });

    // ── CM6 fail-loud guard — a PHYSICAL column on the source that is NOT a registered dimension is
    // SOURCE-OWNED and must REJECT, never silently reroute to a same-named dim on a to-one target ──
    it('CM6 group_by [normalized_text] (a physical, non-dimension column on observations) REJECTS', async () => {
      // observations.normalized_text is a real column but NOT role:'dimension' (untagged in analytics).
      // The bare-name search guard (Amendment 4) must NOT reroute it to a to-one target's same-named
      // dim AND must refuse it as not-a-groupable-dimension — the fail-loud contract that protects a
      // host whose source has an untagged physical column colliding with a parent's dimension.
      await expect(
        h.service.measure('observations', {
          group_by: ['normalized_text'],
          measures: [{ on: '*', agg: 'count', as: 'n' }],
        }),
      ).rejects.toThrow(/not a groupable dimension|column on observations/i);
    });
  },
);
