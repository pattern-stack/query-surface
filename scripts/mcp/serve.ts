// Local MCP boot — serves the query-surface primitives over stdio against the dealbrain reference
// fixture, so a local agent (e.g. a Haiku-level model) can drive the surface end to end.
//
//   DBURL=postgres://postgres:password@localhost:54321/dealbrain \
//     bun run scripts/mcp/serve.ts
//
// Then point any MCP client at `bun run scripts/mcp/serve.ts` (stdio transport). Optional:
//   OPENAI_API_KEY=…  → real free-text embeddings (else the deterministic ILIKE phrase stub).
//
// NB: stdio uses STDOUT as the JSON-RPC channel — every diagnostic here goes to STDERR. A single
// stray stdout write corrupts the protocol.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { makeQuerySurface } from '../../src/characterization/harness.ts';
import { createQuerySurfaceMcpServer } from '../../src/presentation/mcp/index.ts';

const DBURL = process.env.DBURL;
if (!DBURL) {
  console.error('Set DBURL, e.g. DBURL=postgres://postgres:password@localhost:54321/dealbrain');
  process.exit(1);
}

// Optional real embedder — same model that produced the stored vectors (1536-d). Without a key the
// harness falls back to its deterministic ILIKE phrase stub (engine is exercised either way).
function makeRealEmbed(): ((text: string) => Promise<number[]>) | undefined {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return undefined;
  const model = process.env.EMBED_MODEL ?? 'text-embedding-3-small';
  const cache = new Map<string, number[]>();
  return async (text: string): Promise<number[]> => {
    const hit = cache.get(text);
    if (hit) return hit;
    const r = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, input: text, dimensions: 1536 }),
    });
    if (!r.ok) throw new Error(`embed provider ${model} failed: ${r.status} ${await r.text()}`);
    const j = (await r.json()) as { data: { embedding: number[] }[] };
    const vec = j.data[0]!.embedding;
    cache.set(text, vec);
    return vec;
  };
}

const realEmbed = makeRealEmbed();
const { service, close } = makeQuerySurface(DBURL, realEmbed ? { embed: realEmbed } : {});
const server = createQuerySurfaceMcpServer(service);

const transport = new StdioServerTransport();
await server.connect(transport);

console.error(
  `query-surface MCP ready on stdio · embed: ${realEmbed ? `live · ${process.env.EMBED_MODEL ?? 'text-embedding-3-small'}` : 'stub · ILIKE phrase-match'}`,
);

const shutdown = async (): Promise<void> => {
  await server.close().catch(() => {});
  await close().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
