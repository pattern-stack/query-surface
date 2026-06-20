// Hands-on exploration of compare() against live dealbrain. NOT a test — it fires real
// compare requests through the SAME path the service uses (runCompare → runAggregateDrizzle)
// and pretty-prints the stitched/separate output so you can eyeball PoP, churn, N-variant,
// and the client-stitch-parity claim by hand.
//
//   DBURL=postgres://postgres:password@localhost:54321/dealbrain \
//     bun packages/query-surface/scripts/compare-explore.ts
//
// Optional: pass a scenario name to run just one — e.g. `... compare-explore.ts pop`.

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

// The variant runner the orchestrator drives — exactly what the service injects.
const run = (entity: string, req: CompareRequest) =>
  runCompare(entity, req, (agg: Omit<AggregateInput, 'entity'>) =>
    runAggregateDrizzle(db, model, { ...agg, entity }).then((r) => ({
      rows: r.rows,
      warnings: r.warnings,
    })),
  );

// ── tiny table printer ───────────────────────────────────────────────────────
function table(rows: Record<string, unknown>[], max = 12): void {
  if (rows.length === 0) {
    console.log('  (no rows)');
    return;
  }
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const show = rows.slice(0, max);
  const cell = (v: unknown) => (v == null ? '·' : String(v));
  const widths = cols.map((c) => Math.max(c.length, ...show.map((r) => cell(r[c]).length)));
  const line = (vals: string[]) => `  ${vals.map((v, i) => v.padEnd(widths[i]!)).join('  ')}`;
  console.log(line(cols));
  console.log(`  ${widths.map((w) => '─'.repeat(w)).join('  ')}`);
  for (const r of show) console.log(line(cols.map((c) => cell(r[c]))));
  if (rows.length > max) console.log(`  … ${rows.length - max} more`);
}

function header(n: string, desc: string): void {
  console.log(`\n${'═'.repeat(78)}\n▶ ${n} — ${desc}\n${'─'.repeat(78)}`);
}

function warnings(ws?: string[]): void {
  if (ws?.length) for (const w of ws) console.log(`  ⚠ ${w}`);
}

// ── scenarios ──────────────────────────────────────────────────────────────
const scenarios: Record<string, () => Promise<void>> = {
  // 1. Variant-vs-variant on type, N=3 (discovery / commitment / risk), per account,
  //    top 5 by discovery, with delta + pct_change vs discovery.
  async pvp() {
    header(
      'PvP (N=3 variants)',
      'discovery vs commitment vs risk, per account, top 5 by discovery',
    );
    const res = await run('observations', {
      group_by: ['account_id'],
      measures: [{ on: '*', agg: 'count', as: 'obs' }],
      variants: [
        { label: 'discovery', filter: { on: 'type', op: 'eq', value: 'discovery' } },
        { label: 'commitment', filter: { on: 'type', op: 'eq', value: 'commitment' } },
        { label: 'risk', filter: { on: 'type', op: 'eq', value: 'risk' } },
      ],
      compare: { baseline: 'discovery', derive: ['delta', 'pct_change'] },
      order_by: [{ on: 'obs__discovery', dir: 'desc' }],
      limit: 5,
    });
    if (res.delivery !== 'stitched') throw new Error('expected stitched');
    console.log(`  variants=${res.variants.join(', ')}  baseline=${res.baseline}`);
    table(res.rows);
    warnings(res.warnings);
  },

  // 2. The actual PoP: a TIME-WINDOW variant. Q4-2025 vs Q1-2026, grouped by type,
  //    delta + pct_change. (occurredAt spans 2025-09 → 2026-06.)
  async pop() {
    header('PoP (time window)', 'Q4-2025 vs Q1-2026 observation counts by type');
    const res = await run('observations', {
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
      limit: 10,
    });
    if (res.delivery !== 'stitched') throw new Error('expected stitched');
    table(res.rows);
    warnings(res.warnings);
  },

  // 3. Global compare (no group_by) → one stitched row.
  async global() {
    header('Global (no group_by)', 'total commitment vs risk + delta/pct');
    const res = await run('observations', {
      measures: [{ on: '*', agg: 'count', as: 'obs' }],
      variants: [
        { label: 'commitment', filter: { on: 'type', op: 'eq', value: 'commitment' } },
        { label: 'risk', filter: { on: 'type', op: 'eq', value: 'risk' } },
      ],
      compare: { baseline: 'commitment', derive: ['delta', 'pct_change', 'index'] },
    });
    if (res.delivery !== 'stitched') throw new Error('expected stitched');
    table(res.rows);
    warnings(res.warnings);
  },

  // 4. Churn view: each variant keeps its OWN top-3 accounts, aligned by the union.
  async churn() {
    header(
      'Churn (per_variant_top)',
      'each of discovery/commitment keeps own top-3 accounts; union aligned',
    );
    const res = await run('observations', {
      group_by: ['account_id'],
      measures: [{ on: '*', agg: 'count', as: 'obs' }],
      variants: [
        { label: 'discovery', filter: { on: 'type', op: 'eq', value: 'discovery' } },
        { label: 'commitment', filter: { on: 'type', op: 'eq', value: 'commitment' } },
      ],
      compare: { baseline: 'discovery', derive: ['delta'] },
      per_variant_top: { by: 'obs', n: 3 },
    });
    if (res.delivery !== 'stitched') throw new Error('expected stitched');
    table(res.rows);
    warnings(res.warnings);
  },

  // 5. THE CLAIM: separate delivery + client-side stitch == stitched server result.
  //    Fire once 'separate', stitch the parts client-side with the SAME function, and
  //    diff against the server's 'stitched' output. Prints PASS/FAIL.
  async parity() {
    header(
      'Client-stitch parity',
      "separate parts re-stitched client-side === server's stitched result",
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
    const server = await run('observations', base);
    const sep = await run('observations', { ...base, delivery: 'separate' });
    if (server.delivery !== 'stitched' || sep.delivery !== 'separate') {
      throw new Error('unexpected deliveries');
    }
    // Client stitches the separate parts with the EXACT exported function.
    const client = stitchCompare(
      sep.variants.map((v) => ({ label: v.label, rows: v.rows })),
      { groupBy: ['account_id'], baseline: 'commitment', derive: ['delta', 'pct_change'] },
    );
    // Compare as order-independent keyed maps (server may have applied order_by; here none).
    const key = (r: Record<string, unknown>) => String(r.account_id);
    const srv = new Map(server.rows.map((r) => [key(r), JSON.stringify(r)]));
    const cli = new Map(client.rows.map((r) => [key(r), JSON.stringify(r)]));
    let mismatch = 0;
    for (const [k, v] of srv) if (cli.get(k) !== v) mismatch++;
    const ok = mismatch === 0 && srv.size === cli.size;
    console.log(`  server rows=${srv.size}  client rows=${cli.size}  mismatches=${mismatch}`);
    console.log(ok ? '  ✅ PARITY: client stitch === server stitch' : '  ❌ DIVERGENCE');
    console.log('  sample (first 4 server rows):');
    table(server.rows, 4);
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
  console.log(`\n${'═'.repeat(78)}\nDone.`);
} finally {
  await close();
}
