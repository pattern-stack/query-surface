// compare() DOGFOOD harness — fires realistic analyst questions at the live compare()
// verb through the SAME path the service uses (runCompare → runAggregateDrizzle) and
// pretty-prints results. NOT a test suite; a usability + correctness probe by USE.
//
//   DBURL=postgres://postgres:password@localhost:54321/dealbrain \
//     bun scripts/compare-qa.ts            # run all questions
//   ... bun scripts/compare-qa.ts q7       # run just one
//
// Each scenario prints the request intent, the stitched/separate output, and any
// warnings. Truth checks live alongside in the report (psql), not here.

import { type CompareRequest, runCompare, stitchCompare } from '../src/engine/aggregate/compare';
import { makeDb } from '../src/engine/aggregate/drizzle-db';
import type { AggregateInput } from '../src/engine/aggregate/measure-catalog';
import { loadDealbrainModel } from '../src/engine/aggregate/model.dealbrain';
import { runAggregateDrizzle } from '../src/engine/aggregate/run-drizzle';

const DBURL = process.env.DBURL;
if (!DBURL) {
  console.error('Set DBURL, e.g. DBURL=postgres://postgres:password@localhost:54321/dealbrain');
  process.exit(1);
}

const { db, close } = makeDb(DBURL);
const model = await loadDealbrainModel(db);

const run = (entity: string, req: CompareRequest) =>
  runCompare(entity, req, (agg: Omit<AggregateInput, 'entity'>) =>
    runAggregateDrizzle(db, model, { ...agg, entity }).then((r) => ({
      rows: r.rows,
      warnings: r.warnings,
    })),
  );

// ── printers ─────────────────────────────────────────────────────────────────
function table(rows: Record<string, unknown>[], max = 14): void {
  if (rows.length === 0) {
    console.log('  (no rows)');
    return;
  }
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const show = rows.slice(0, max);
  const cell = (v: unknown) => {
    if (v == null) return '·';
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3);
    return String(v);
  };
  const widths = cols.map((c) => Math.max(c.length, ...show.map((r) => cell(r[c]).length)));
  const line = (vals: string[]) => '  ' + vals.map((v, i) => v.padEnd(widths[i]!)).join('  ');
  console.log(line(cols));
  console.log('  ' + widths.map((w) => '─'.repeat(w)).join('  '));
  for (const r of show) console.log(line(cols.map((c) => cell(r[c]))));
  if (rows.length > max) console.log(`  … ${rows.length - max} more rows`);
}

function header(n: string, q: string): void {
  console.log(`\n${'═'.repeat(90)}\n▶ ${n}\n  Q: ${q}\n${'─'.repeat(90)}`);
}
function note(s: string): void {
  console.log(`  · ${s}`);
}
function warnings(ws?: string[]): void {
  if (ws?.length) for (const w of ws) console.log(`  ⚠ ${w}`);
}
async function printStitched(req: CompareRequest, entity = 'observations'): Promise<void> {
  const res = await run(entity, req);
  if (res.delivery === 'stitched') {
    console.log(
      `  variants=[${res.variants.join(', ')}]  baseline=${res.baseline}  rows=${res.rows.length}`,
    );
    table(res.rows);
    warnings(res.warnings);
  } else {
    console.log(`  separate delivery — ${res.variants.length} parts:`);
    for (const v of res.variants) {
      console.log(`  • ${v.label} (${v.row_count} rows):`);
      table(v.rows, 6);
    }
    warnings(res.warnings);
  }
}

// ── the questions ──────────────────────────────────────────────────────────
const scenarios: Record<string, () => Promise<void>> = {
  // Q1 — PoP by type, two time windows, delta + pct_change.
  async q1() {
    header(
      'Q1 — Period-over-period (time windows)',
      'How did each observation type trend from Q4-2025 to Q1-2026?',
    );
    await printStitched({
      group_by: ['type'],
      measures: [{ on: '*', agg: 'count', as: 'obs' }],
      variants: [
        {
          label: 'q4_2025',
          filter: {
            and: [
              { on: 'occurred_at', op: 'gte', value: '2025-10-01' },
              { on: 'occurred_at', op: 'lt', value: '2026-01-01' },
            ],
          },
        },
        {
          label: 'q1_2026',
          filter: {
            and: [
              { on: 'occurred_at', op: 'gte', value: '2026-01-01' },
              { on: 'occurred_at', op: 'lt', value: '2026-04-01' },
            ],
          },
        },
      ],
      compare: { baseline: 'q4_2025', derive: ['delta', 'pct_change'] },
      order_by: [{ on: 'obs__q1_2026', dir: 'desc' }],
    });
  },

  // Q2 — variant-vs-variant on type, per account, with index derive.
  async q2() {
    header(
      'Q2 — Variant-vs-variant + index',
      'For top accounts, how does risk volume index against commitment volume (commitment=100)?',
    );
    await printStitched({
      group_by: ['account_id'],
      measures: [{ on: '*', agg: 'count', as: 'obs' }],
      variants: [
        { label: 'commitment', filter: { on: 'type', op: 'eq', value: 'commitment' } },
        { label: 'risk', filter: { on: 'type', op: 'eq', value: 'risk' } },
      ],
      compare: { baseline: 'commitment', derive: ['index'] },
      order_by: [{ on: 'obs__commitment', dir: 'desc' }],
      limit: 8,
    });
  },

  // Q3 — N>2 variants: discovery / commitment / risk / objection, global.
  async q3() {
    header(
      'Q3 — N>2 variants (global)',
      'Overall, how do discovery / commitment / risk / objection volumes compare (vs discovery)?',
    );
    await printStitched({
      measures: [{ on: '*', agg: 'count', as: 'obs' }],
      variants: [
        { label: 'discovery', filter: { on: 'type', op: 'eq', value: 'discovery' } },
        { label: 'commitment', filter: { on: 'type', op: 'eq', value: 'commitment' } },
        { label: 'risk', filter: { on: 'type', op: 'eq', value: 'risk' } },
        { label: 'objection', filter: { on: 'type', op: 'eq', value: 'objection' } },
      ],
      compare: { baseline: 'discovery', derive: ['delta', 'pct_change', 'index'] },
    });
  },

  // Q4 — churn / top-N shift via per_variant_top.
  async q4() {
    header(
      'Q4 — Top-N shift (per_variant_top / churn)',
      'Which accounts are top-5 by discovery vs top-5 by commitment? Who shifted?',
    );
    await printStitched({
      group_by: ['account_id'],
      measures: [{ on: '*', agg: 'count', as: 'obs' }],
      variants: [
        { label: 'discovery', filter: { on: 'type', op: 'eq', value: 'discovery' } },
        { label: 'commitment', filter: { on: 'type', op: 'eq', value: 'commitment' } },
      ],
      compare: { baseline: 'discovery', derive: ['delta'] },
      per_variant_top: { by: 'obs', n: 5 },
    });
  },

  // Q5 — global single-row compare, multi-measure.
  async q5() {
    header(
      'Q5 — Global multi-measure',
      'Across the whole book: commitment vs risk — total observations AND distinct opportunities touched?',
    );
    await printStitched({
      measures: [
        { on: '*', agg: 'count', as: 'obs' },
        { on: 'opportunity_id', agg: 'count_distinct', as: 'opps' },
      ],
      variants: [
        { label: 'commitment', filter: { on: 'type', op: 'eq', value: 'commitment' } },
        { label: 'risk', filter: { on: 'type', op: 'eq', value: 'risk' } },
      ],
      compare: { baseline: 'commitment', derive: ['delta', 'pct_change'] },
    });
  },

  // Q6 — catalog {ref} measure on opportunities: weighted pipeline, won-ish vs the rest? (state is all null)
  //   Use a non-time cohort: opportunities WITH an account vs … actually compare by visibility.
  async q6() {
    header(
      'Q6 — Catalog {ref} measures on opportunities',
      'Visible vs hidden opportunities: total weighted pipeline + avg deal probability?',
    );
    await printStitched(
      {
        measures: [
          { ref: 'weighted_amount', as: 'pipeline' },
          { ref: 'deal_probability', as: 'prob' },
        ],
        variants: [
          { label: 'visible', filter: { on: 'is_visible', op: 'eq', value: true } },
          { label: 'hidden', filter: { on: 'is_visible', op: 'eq', value: false } },
        ],
        compare: { baseline: 'visible', derive: ['delta', 'pct_change'] },
      },
      'opportunities',
    );
  },

  // Q7 — separate delivery + client-stitch parity.
  async q7() {
    header(
      'Q7 — Separate delivery',
      'Give me the raw per-account commitment and risk result sets, unstitched (I will align client-side).',
    );
    const base: CompareRequest = {
      group_by: ['account_id'],
      measures: [{ on: '*', agg: 'count', as: 'obs' }],
      variants: [
        { label: 'commitment', filter: { on: 'type', op: 'eq', value: 'commitment' } },
        { label: 'risk', filter: { on: 'type', op: 'eq', value: 'risk' } },
      ],
      compare: { baseline: 'commitment', derive: ['delta', 'pct_change'] },
    };
    await printStitched({ ...base, delivery: 'separate' });
    // parity: server stitched === client re-stitch of separate parts
    const server = await run('observations', base);
    const sep = await run('observations', { ...base, delivery: 'separate' });
    if (server.delivery === 'stitched' && sep.delivery === 'separate') {
      const client = stitchCompare(
        sep.variants.map((v) => ({ label: v.label, rows: v.rows })),
        { groupBy: ['account_id'], baseline: 'commitment', derive: ['delta', 'pct_change'] },
      );
      const norm = (rows: Record<string, unknown>[]) =>
        new Map(rows.map((r) => [String(r.account_id), JSON.stringify(r)]));
      const s = norm(server.rows);
      const c = norm(client.rows);
      let mism = 0;
      for (const [k, v] of s) if (c.get(k) !== v) mism++;
      console.log(
        `  parity: server=${s.size} client=${c.size} mismatches=${mism} → ${mism === 0 && s.size === c.size ? '✅' : '❌'}`,
      );
    }
  },

  // Q8 — absent-baseline derive: rare type baseline → many null pct + warning.
  async q8() {
    header(
      'Q8 — Sparse baseline',
      'Per account, how does discovery volume compare to urgency volume (urgency=baseline, rare)?',
    );
    await printStitched({
      group_by: ['account_id'],
      measures: [{ on: '*', agg: 'count', as: 'obs' }],
      variants: [
        { label: 'urgency', filter: { on: 'type', op: 'eq', value: 'urgency' } },
        { label: 'discovery', filter: { on: 'type', op: 'eq', value: 'discovery' } },
      ],
      compare: { baseline: 'urgency', derive: ['pct_change'] },
      order_by: [{ on: 'obs__discovery', dir: 'desc' }],
      limit: 8,
    });
  },

  // ── EDGES: things compare likely struggles with ───────────────────────────

  // Q9 — 3+ period TREND (not just PoP). Want a sequential index across Q3→Q4→Q1→Q2.
  async q9() {
    header(
      'Q9 — Multi-period TREND (EDGE)',
      'Show the quarter-by-quarter trend of total observations across 4 quarters, indexed to Q3.',
    );
    await printStitched({
      measures: [{ on: '*', agg: 'count', as: 'obs' }],
      variants: [
        {
          label: 'q3_2025',
          filter: {
            and: [
              { on: 'occurred_at', op: 'gte', value: '2025-07-01' },
              { on: 'occurred_at', op: 'lt', value: '2025-10-01' },
            ],
          },
        },
        {
          label: 'q4_2025',
          filter: {
            and: [
              { on: 'occurred_at', op: 'gte', value: '2025-10-01' },
              { on: 'occurred_at', op: 'lt', value: '2026-01-01' },
            ],
          },
        },
        {
          label: 'q1_2026',
          filter: {
            and: [
              { on: 'occurred_at', op: 'gte', value: '2026-01-01' },
              { on: 'occurred_at', op: 'lt', value: '2026-04-01' },
            ],
          },
        },
        {
          label: 'q2_2026',
          filter: {
            and: [
              { on: 'occurred_at', op: 'gte', value: '2026-04-01' },
              { on: 'occurred_at', op: 'lt', value: '2026-07-01' },
            ],
          },
        },
      ],
      compare: { baseline: 'q3_2025', derive: ['index', 'pct_change'] },
    });
  },

  // Q10 — rank by a CROSS-VARIANT computed quantity: "accounts where risk grew most vs commitment".
  //   compare exposes the delta column, so order_by on it should work — test the limit of that.
  async q10() {
    header(
      'Q10 — Rank by cross-variant delta (EDGE)',
      'Which accounts have the LARGEST risk-minus-commitment gap (risk-heavy accounts)?',
    );
    await printStitched({
      group_by: ['account_id'],
      measures: [{ on: '*', agg: 'count', as: 'obs' }],
      variants: [
        { label: 'commitment', filter: { on: 'type', op: 'eq', value: 'commitment' } },
        { label: 'risk', filter: { on: 'type', op: 'eq', value: 'risk' } },
      ],
      compare: { baseline: 'commitment', derive: ['delta'] },
      order_by: [{ on: 'obs__risk__delta', dir: 'desc' }],
      limit: 8,
    });
  },

  // Q11 — RATIO of two comparisons / post-stitch arithmetic. Want: (risk/commitment) ratio per account,
  //   ranked. compare has no post-stitch arithmetic beyond delta/pct/index. Probe what we CAN'T do.
  async q11() {
    header(
      'Q11 — Ratio metric per group, ranked (EDGE)',
      'Which accounts have the highest RISK:COMMITMENT ratio (a risk-signal density), ranked?',
    );
    note(
      'Attempt A: index derive == (variant/baseline)*100, i.e. the ratio×100. Closest compare gets.',
    );
    await printStitched({
      group_by: ['account_id'],
      measures: [{ on: '*', agg: 'count', as: 'obs' }],
      variants: [
        { label: 'commitment', filter: { on: 'type', op: 'eq', value: 'commitment' } },
        { label: 'risk', filter: { on: 'type', op: 'eq', value: 'risk' } },
      ],
      compare: { baseline: 'commitment', derive: ['index'] },
      order_by: [{ on: 'obs__risk__index', dir: 'desc' }],
      limit: 8,
    });
  },

  // Q12 — "which variant is the MAX per group" (argmax). compare gives the values; the
  //   argmax label is a post-stitch reduction it does not express. Probe it.
  async q12() {
    header(
      'Q12 — Argmax variant per group (EDGE)',
      "For each account, which signal type dominates among discovery/commitment/risk? (the type's NAME, per row)",
    );
    await printStitched({
      group_by: ['account_id'],
      measures: [{ on: '*', agg: 'count', as: 'obs' }],
      variants: [
        { label: 'discovery', filter: { on: 'type', op: 'eq', value: 'discovery' } },
        { label: 'commitment', filter: { on: 'type', op: 'eq', value: 'commitment' } },
        { label: 'risk', filter: { on: 'type', op: 'eq', value: 'risk' } },
      ],
      compare: { baseline: 'discovery', derive: [] },
      order_by: [{ on: 'obs__discovery', dir: 'desc' }],
      limit: 8,
    });
  },
};

const only = process.argv[2];
const toRun = only ? { [only]: scenarios[only] } : scenarios;
if (only && !scenarios[only]) {
  console.error(`Unknown scenario "${only}". Available: ${Object.keys(scenarios).join(', ')}`);
  await close();
  process.exit(1);
}
try {
  for (const fn of Object.values(toRun)) await fn!();
  console.log(`\n${'═'.repeat(90)}\nDone.`);
} finally {
  await close();
}
