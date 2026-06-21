// One-shot MCP tool caller — drive the query-surface MCP tools by hand (the operator IS the agent).
// Boots the in-memory MCP once and runs a sequence of calls, printing each result as a real client
// would see it. Used to feel the tool SHAPE and find the rough edges.
//
//   DBURL=… bun run scripts/mcp/call.ts '{"tool":"describe","args":{"entity":"opportunities"}}'
//   DBURL=… bun run scripts/mcp/call.ts '[{"tool":"aggregate","args":{...}}, {"tool":"query","args":{...}}]'

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { makeQuerySurface } from '../../src/characterization/harness.ts';
import { createQuerySurfaceMcpServer } from '../../src/presentation/mcp/index.ts';

const DBURL = process.env.DBURL;
if (!DBURL) {
  console.error('Set DBURL=postgres://postgres:password@localhost:54321/dealbrain');
  process.exit(1);
}
const raw = process.argv[2];
if (!raw) {
  console.error('Pass a JSON step {tool,args} or an array of them.');
  process.exit(1);
}
const CAP = Number(process.env.CAP ?? 3000);
const parsed = JSON.parse(raw) as
  | { tool: string; args?: Record<string, unknown> }
  | { tool: string; args?: Record<string, unknown> }[];
const steps = Array.isArray(parsed) ? parsed : [parsed];

const { service, close } = makeQuerySurface(DBURL);
// SURFACE_FIELDS=all | entity:a,b;entity2:c → exercise the describe field-exposure modes.
const sf = process.env.SURFACE_FIELDS?.trim();
const surfaceFields =
  !sf || sf === 'all'
    ? (sf as 'all' | undefined)
    : Object.fromEntries(
        sf.split(';').map((g) => {
          const [e, n] = g.split(':');
          return [e!.trim(), (n ?? '').split(',').map((s) => s.trim())];
        }),
      );
const server = createQuerySurfaceMcpServer(service, surfaceFields ? { surfaceFields } : {});
const client = new Client({ name: 'call', version: '0.0.0' });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(a), client.connect(b)]);

// Collapse the 1536-d embedding vector params so SQL echoes stay readable.
const trim = (s: string): string => {
  let t = s.replace(/\[(-?\d+\.\d+,){20,}-?\d+\.\d+\]/g, '⟨…embedding vector…⟩');
  if (t.length > CAP) t = `${t.slice(0, CAP)}\n… [${t.length} chars total]`;
  return t;
};

for (const step of steps) {
  console.log(`\n→ ${step.tool}(${JSON.stringify(step.args ?? {})})`);
  try {
    const res = (await client.callTool({ name: step.tool, arguments: step.args ?? {} })) as {
      content: { type: string; text?: string }[];
      isError?: boolean;
    };
    const text = res.content.map((c) => c.text ?? '').join('\n');
    console.log(`${res.isError ? '⟵ REFUSED:\n' : '⟵ '}${trim(text)}`);
  } catch (e) {
    console.log(`⟵ THREW: ${e instanceof Error ? e.message : String(e)}`);
  }
}

await client.close();
await server.close();
await close();
process.exit(0);
