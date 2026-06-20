// Wave-2 demo server — "a metric over a relevance-defined cohort, with the cohort shown
// BEFORE the number" (ADR-0024 §A/Amendment 2, the alignment-integrity pitch).
//
// Boots the query-surface service ONCE against the live Bean Maxx fixture (via the same
// makeQuerySurface harness the evals use — embed stub + semanticColumns + the dealbrain model),
// serves a single static page, and exposes ONE endpoint that runs a real aggregate() with a
// cross-grain `relevant` leaf and returns the measure + the mandatory citation.
//
//   DBURL=postgres://postgres:password@localhost:54321/dealbrain \
//     bun run scripts/wave2-demo/server.ts            # → http://localhost:7878
//
// EMBED CAVEAT: the harness embed() is the deterministic ILIKE stub — the `query` must be a
// phrase that appears verbatim in some observation's normalized_text (it resolves to that row's
// real stored vector). So this demos the ENGINE (relevance-as-filter + citation) end-to-end; the
// free-text-concept version is the real-embed-provider follow-on. The preset chips are verified
// to resolve to meaningful cohorts.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeQuerySurface } from '../../src/characterization/harness.ts';

const DBURL = process.env.DBURL;
if (!DBURL) {
  console.error('Set DBURL, e.g. DBURL=postgres://postgres:password@localhost:54321/dealbrain');
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 7878);
const HTML = readFileSync(join(import.meta.dir, 'index.html'), 'utf8');

const h = makeQuerySurface(DBURL);

// The named measures the Bean Maxx catalog exposes (both EAV on opportunities).
const MEASURES: Record<string, { on: string; agg: 'sum' | 'avg'; as: string; label: string; fmt: 'usd' | 'pct' }> = {
  pipeline: { on: 'weighted_amount', agg: 'sum', as: 'pipeline', label: 'Weighted pipeline (Σ ExpectedRevenue)', fmt: 'usd' },
  win_rate: { on: 'deal_probability', agg: 'avg', as: 'win_rate', label: 'Avg win probability', fmt: 'pct' },
};

async function runRelevant(body: {
  query: string;
  measure?: string;
  mode?: 'threshold' | 'top_k';
  threshold?: number;
  top_k?: number;
  boundary?: boolean;
}) {
  const m = MEASURES[body.measure ?? 'pipeline'] ?? MEASURES.pipeline;
  const crisp =
    body.mode === 'top_k'
      ? { top_k: Math.max(1, Math.floor(body.top_k ?? 25)) }
      : { threshold: Math.min(1, Math.max(0, body.threshold ?? 0.55)) };

  const res = await h.service.aggregate('opportunities', {
    measures: [
      { on: m.on, agg: m.agg, as: m.as },
      // a cross-grain count of the matching child observations, for context
      { source: 'observations', on: '*', agg: 'count', as: 'matched_obs' },
    ],
    filter: {
      on: 'observations.normalized_text',
      op: 'relevant',
      query: body.query,
      ...crisp,
    },
    citation: { boundary: body.boundary !== false },
  });

  return {
    measure: { key: body.measure ?? 'pipeline', label: m.label, fmt: m.fmt, as: m.as },
    rows: res.rows,
    citation: res.citation,
  };
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (url.pathname === '/api/relevant' && req.method === 'POST') {
      try {
        const body = await req.json();
        const out = await runRelevant(body);
        return Response.json(out);
      } catch (e) {
        // The engine's fail-loud refusals (XOR violation, scope gap, non-conforming) land here —
        // surface them verbatim; they're the trust story, not noise.
        return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
      }
    }
    return new Response('not found', { status: 404 });
  },
});

console.log(`\n  Wave-2 relevance-as-filter demo  →  http://localhost:${server.port}\n`);
console.log('  (cross-grain: weighted pipeline over opportunities whose OBSERVATIONS match a concept)\n');
