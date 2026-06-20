// Wave-2 demo server — the relevance-as-selection explorer.
//
// Boots the query-surface service ONCE against the live Bean Maxx fixture (the same
// makeQuerySurface harness the evals use), serves a single multi-tab page, and exposes the
// primitives so you can see the WHOLE story: the metric, the cohort that defined it, the SQL that
// computed it, the evidence rows behind it, and the host-supplied catalog it all derives from.
//
//   DBURL=postgres://postgres:password@localhost:54321/dealbrain \
//     bun run scripts/wave2-demo/server.ts            # → http://localhost:7878
//
// EMBED CAVEAT: the harness embed() is the deterministic ILIKE stub — the `query` must be a phrase
// that appears verbatim in some observation's normalized_text (it resolves to that row's real
// stored vector). So this demos the ENGINE (relevance-as-filter + citation + grain-safety) fully;
// the free-text-concept version is the real-embed-provider follow-on. Preset chips are verified.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { format as formatSql } from 'sql-formatter';
import { makeQuerySurface } from '../../src/characterization/harness.ts';

// Pretty-print the compiled SQL for the demo (the sql-formatter package, Postgres dialect).
// Best-effort: a formatting hiccup falls back to the raw single line, never breaks the response.
const pretty = (sql?: string): string | undefined => {
  if (!sql) return sql;
  try {
    return formatSql(sql, { language: 'postgresql', keywordCase: 'lower', tabWidth: 2, expressionWidth: 64 });
  } catch {
    return sql;
  }
};

// Compact the bound params for display: a relevance vector param is the full 1536-d embedding —
// show it as a labeled, truncated preview (NOT 16KB of floats), keep scalars (uuid/threshold/k) as-is.
function displayParams(params: unknown[] | undefined, query: string): { i: number; kind: 'vector' | 'scalar'; value: string }[] {
  if (!params) return [];
  return params.map((p, idx) => {
    // pgvector params arrive as a stringified array ("[0.01,..]") or a real number[].
    const arr =
      Array.isArray(p) ? (p as number[])
        : typeof p === 'string' && p.startsWith('[') && p.length > 100 ? (JSON.parse(p) as number[])
          : null;
    if (arr && arr.length > 32) {
      const head = arr.slice(0, 4).map((n) => n.toFixed(4)).join(', ');
      return { i: idx + 1, kind: 'vector' as const, value: `⟨embedding of “${query}” · ${arr.length}-d⟩  [${head}, …]` };
    }
    return { i: idx + 1, kind: 'scalar' as const, value: String(p) };
  });
}

const DBURL = process.env.DBURL;
if (!DBURL) {
  console.error('Set DBURL, e.g. DBURL=postgres://postgres:password@localhost:54321/dealbrain');
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 7878);
const HTML = readFileSync(join(import.meta.dir, 'index.html'), 'utf8');
const h = makeQuerySurface(DBURL);

// The named measures the Bean Maxx catalog exposes (both EAV on opportunities) + a plain count.
type MDef = { source?: string; on: string; agg: 'sum' | 'avg' | 'count'; as: string; label: string; fmt: 'usd' | 'pct' | 'int' };
const MEASURES: Record<string, MDef> = {
  pipeline: { on: 'weighted_amount', agg: 'sum', as: 'pipeline', label: 'Weighted pipeline (Σ ExpectedRevenue)', fmt: 'usd' },
  win_rate: { on: 'deal_probability', agg: 'avg', as: 'win_rate', label: 'Avg win probability', fmt: 'pct' },
  deals: { on: '*', agg: 'count', as: 'deals', label: 'Opportunity count', fmt: 'int' },
};

function crispFrom(body: { mode?: string; threshold?: number; top_k?: number }) {
  return body.mode === 'top_k'
    ? { top_k: Math.max(1, Math.floor(body.top_k ?? 25)) }
    : { threshold: Math.min(1, Math.max(0, body.threshold ?? 0.55)) };
}

// ── the cohort metric: aggregate() with a cross-grain relevant leaf + the mandatory citation ──
async function apiRelevant(body: any) {
  const m = MEASURES[body.measure as string] ?? MEASURES.pipeline;
  const t0 = performance.now();
  const res = await h.service.aggregate(
    'opportunities',
    {
      measures: [
        { on: m.on, agg: m.agg, as: m.as },
        // The cohort SIZE at the MEASURED grain: how many distinct opportunities own ≥1 matching
        // observation (EXISTS, counted once). Distinct from the citation's match_count, which is
        // the number of matching OBSERVATIONS (the evidence) — usually more, since a deal can have
        // several. M observations → N deals → Σ metric over those N.
        ...(m.agg === 'count' && m.on === '*' ? [] : [{ on: '*', agg: 'count' as const, as: 'cohort_deals' }]),
      ],
      filter: { on: 'observations.normalized_text', op: 'relevant', query: body.query, ...crispFrom(body) },
    },
    { include_sql: true, citation: { boundary: true } },
  );
  return {
    measure: { key: body.measure ?? 'pipeline', label: m.label, fmt: m.fmt, as: m.as },
    rows: res.rows,
    citation: res.citation,
    sql: pretty(res.sql),
    params: displayParams(res.params, body.query),
    ms: Math.round(performance.now() - t0),
  };
}

// ── explore the cohort's EVIDENCE: query() the matching observations, ranked + scored ──
async function apiExplore(body: any) {
  const t0 = performance.now();
  const res = await h.service.query('observations', {
    filter: { on: 'normalized_text', op: 'relevant', query: body.query, ...crispFrom(body) },
    rank_by: { on: 'normalized_text', method: 'semantic', query: body.query, limit: Math.min(200, body.limit ?? 25) },
    columns: ['type', 'normalized_text', 'account_id', 'opportunity_id'],
    preview: true,
    include_sql: true,
  });
  return {
    total: res.total,
    rows: res.preview ?? [],
    sql: pretty(res.sql),
    params: displayParams(res.params, body.query),
    ms: Math.round(performance.now() - t0),
  };
}

// ── conformed dimensions: group the cohort by a dimension; the GRAPH decides what's legal ──
// A to-one dim (accounts.name) → a grain-safe LEFT JOIN. A to-many dim (observations.type) →
// REFUSED (it would fan out the measure). The legality is derived from the join graph, not listed.
async function apiGroup(body: any) {
  const dim = String(body.dim ?? 'accounts.name');
  const t0 = performance.now();
  const res = await h.service.aggregate(
    'opportunities',
    {
      group_by: [dim],
      measures: [
        { on: 'weighted_amount', agg: 'sum', as: 'pipeline' },
        { on: '*', agg: 'count', as: 'deals' },
      ],
      filter: { on: 'observations.normalized_text', op: 'relevant', query: body.query, ...crispFrom(body) },
      order_by: [{ on: 'pipeline', dir: 'desc' }],
      limit: 25,
    },
    { include_sql: true },
  );
  return {
    dim,
    rows: res.rows,
    sql: pretty(res.sql),
    params: displayParams(res.params, body.query),
    ms: Math.round(performance.now() - t0),
  };
}

// ── the host-supplied catalog: describe(entity) — native ⊕ EAV fields + the relation graph ──
async function apiDescribe(entity: string) {
  const t0 = performance.now();
  const d: any = await h.service.describe(entity);
  return { ...d, ms: Math.round(performance.now() - t0) };
}

const ROUTES: Record<string, (body: any) => Promise<unknown>> = {
  '/api/relevant': apiRelevant,
  '/api/explore': apiExplore,
  '/api/group': apiGroup,
};

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (url.pathname === '/api/describe') {
      try {
        return Response.json(await apiDescribe(url.searchParams.get('entity') ?? 'opportunities'));
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
      }
    }
    const route = ROUTES[url.pathname];
    if (route && req.method === 'POST') {
      try {
        return Response.json(await route(await req.json()));
      } catch (e) {
        // The engine's fail-loud refusals (XOR violation, scope gap, non-conforming) land here —
        // surface them verbatim; they're the trust story, not noise.
        return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
      }
    }
    return new Response('not found', { status: 404 });
  },
});

console.log(`\n  query-surface · relevance explorer  →  http://localhost:${server.port}\n`);
