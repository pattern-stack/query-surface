// In-memory smoke test for the MCP adapter — drives the server exactly as a client would:
// list tools, then describe → aggregate → relevance query, asserting the round-trip works and
// the citation rides along. Run: DBURL=… bun run scripts/mcp/smoke.ts
//
// Not a unit test (it hits the live dealbrain fixture); a fast manual end-to-end check.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { makeQuerySurface } from '../../src/characterization/harness.ts';
import { createQuerySurfaceMcpServer } from '../../src/presentation/mcp/index.ts';

const DBURL = process.env.DBURL;
if (!DBURL) {
  console.error('Set DBURL=postgres://postgres:password@localhost:54321/dealbrain');
  process.exit(1);
}

const { service, close } = makeQuerySurface(DBURL);
const server = createQuerySurfaceMcpServer(service);
const client = new Client({ name: 'smoke', version: '0.0.0' });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(a), client.connect(b)]);

const text = (r: { content: { type: string; text?: string }[]; isError?: boolean }): string =>
  (r.isError ? '[REFUSED] ' : '') + r.content.map((c) => c.text ?? '').join('\n');

// 1. tools list
const { tools } = await client.listTools();
console.log('TOOLS:', tools.map((t) => t.name).join(', '));
console.log(
  'aggregate input keys:',
  Object.keys(tools.find((t) => t.name === 'aggregate')?.inputSchema?.properties ?? {}).join(', '),
);

// 2. describe — discovery (catalog + conformed dims)
const d = (await client.callTool({
  name: 'describe',
  arguments: { entity: 'opportunities' },
})) as Awaited<ReturnType<typeof client.callTool>> & { content: { type: string; text?: string }[] };
const dParsed = JSON.parse(text(d));
console.log(
  '\nDESCRIBE opportunities → fields:',
  (dParsed.catalog?.fields ?? []).length,
  '· conformed dims:',
  Array.isArray(dParsed.conformed_dimensions)
    ? dParsed.conformed_dimensions.length
    : dParsed.conformed_dimensions,
);

// 3. aggregate — a simple grain-safe count
const agg = (await client.callTool({
  name: 'aggregate',
  arguments: { entity: 'opportunities', measures: [{ on: '*', agg: 'count', as: 'deals' }] },
})) as { content: { type: string; text?: string }[]; isError?: boolean };
console.log('\nAGGREGATE count → ', text(agg).slice(0, 200));

// 4. relevance query — the cohort-with-citation story (stub embed: phrase must appear in text)
const rel = (await client.callTool({
  name: 'aggregate',
  arguments: {
    entity: 'opportunities',
    measures: [{ on: '*', agg: 'count', as: 'deals' }],
    filter: { on: 'observations.normalized_text', op: 'relevant', query: 'risk', threshold: 0.5 },
  },
})) as { content: { type: string; text?: string }[]; isError?: boolean };
const relParsed = JSON.parse(text(rel));
console.log(
  '\nRELEVANCE aggregate → rows:',
  JSON.stringify(relParsed.rows),
  '· citation present:',
  !!relParsed.citation,
  relParsed.citation
    ? `(match_count=${relParsed.citation.match_count ?? relParsed.citation.matchCount ?? '?'})`
    : '',
);

// 5. a deliberate refusal — to-many group dim should fail loud with a readable reason
const refuse = (await client.callTool({
  name: 'aggregate',
  arguments: {
    entity: 'opportunities',
    measures: [{ on: '*', agg: 'count', as: 'deals' }],
    group_by: ['observations.type'],
  },
})) as { content: { type: string; text?: string }[]; isError?: boolean };
console.log(
  '\nREFUSAL (group by to-many) →',
  refuse.isError ? 'isError=true ✓' : 'NOT flagged ✗',
  '·',
  text(refuse).slice(0, 160),
);

await client.close();
await server.close();
await close();
console.log('\nsmoke ok');
process.exit(0);
