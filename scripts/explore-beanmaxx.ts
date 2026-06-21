// Throwaway exploration (safe to delete): drive the query-surface 5 primitives against beanmaxx
// observations the way the MCP exposes them, replicating the d001-01 retrieval scenario the
// dealbrain surface + flash-lite agent MISSED (the order-form $42k observations). Run:
//   DBURL=postgres://postgres:password@localhost:54321/dealbrain OPENAI_API_KEY=… bun run scripts/explore-beanmaxx.ts
import { makeQuerySurface } from '../src/characterization/harness.ts';

const DBURL = process.env.DBURL;
if (!DBURL) {
  console.error('set DBURL');
  process.exit(1);
}
const KEY = process.env.OPENAI_API_KEY;

function realEmbed() {
  const cache = new Map<string, number[]>();
  return async (text: string): Promise<number[]> => {
    const hit = cache.get(text);
    if (hit) return hit;
    const r = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: text, dimensions: 1536 }),
    });
    if (!r.ok) throw new Error(`embed ${r.status} ${await r.text()}`);
    const j = (await r.json()) as { data: { embedding: number[] }[] };
    const v = j.data[0]!.embedding;
    cache.set(text, v);
    return v;
  };
}

const DEAL_001 = 'b65e7705-4513-5e38-8166-cf292bcc8877'; // Augment Code
const svc = makeQuerySurface(DBURL, KEY ? { embed: realEmbed() } : {});
const service = svc.service as any;

const log = (label: string, data: unknown) => {
  console.log(`\n===== ${label} =====`);
  console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2).slice(0, 2600));
};
const previewLine = (r: any) =>
  (r?.preview ?? [])
    .map(
      (p: any, i: number) => `  ${i + 1}. [${p.type}] ${(p.normalized_text ?? '').slice(0, 130)}`,
    )
    .join('\n');

try {
  log('1) describe(observations) — catalog', await service.describe('observations'));
  try {
    log('1b) conformed dimensions', await service.describeConformedDimensions('observations'));
  } catch (e) {
    log('1b conformed', String(e));
  }

  // 2) semantic rank_by — does it surface the order-form / $42k observations flash-lite missed?
  const ranked = await service.query('observations', {
    filter: { opportunity_id: DEAL_001 },
    rank_by: {
      on: 'normalized_text',
      method: 'semantic',
      query: 'final order form total annual fee pricing tier office-active',
      limit: 6,
    },
    columns: ['type', 'normalized_text', 'occurred_at'],
    preview: true,
  });
  console.log(
    `\n===== 2) query rank_by semantic (pricing/order-form) — total=${ranked.total} =====`,
  );
  console.log(previewLine(ranked));
  console.log(
    `  $42k present in top-6? ${(ranked.preview ?? []).some((p: any) => (p.normalized_text ?? '').includes('42,000'))}`,
  );

  // 3) the NEW primitive — a relevance cohort with a CITATION (+ strongest excluded boundary row)
  const rel = await service.query('observations', {
    filter: {
      and: [
        { opportunity_id: DEAL_001 },
        {
          on: 'normalized_text',
          op: 'relevant',
          query: 'order form pricing total annual fee office-active tier',
          threshold: 0.42,
        },
      ],
    },
    columns: ['type', 'normalized_text'],
    preview: true,
    citation: { boundary: true },
  });
  log('3) RELEVANT cohort + citation (cohort def, cutoff, exemplars, boundary)', rel);
} catch (e) {
  log('ERROR (engine fail-loud)', e instanceof Error ? e.message : String(e));
} finally {
  await svc.close();
}
