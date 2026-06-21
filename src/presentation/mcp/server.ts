// MCP server factory — wires the query-surface primitives onto an McpServer as tools.
//
// Transport-agnostic: this builds the server and registers the tools; the caller connects a
// transport (stdio for local agents, or any other). It is a thin DRIVING adapter — given a
// composed QueryApplicationService (the host owns composition: DB, registry, model, scope), it
// exposes describe/query/fetch/aggregate/compare as agent-callable tools.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { QueryApplicationService } from '../../query.application-service.ts';
import { registerQueryTools } from './tools.ts';

/** Server-level guidance sent to the client — the agent's operating manual for the surface. */
const INSTRUCTIONS = [
  'This server exposes a governed query + aggregation surface over a host data model.',
  '',
  'Workflow:',
  '  1. describe()            — learn the entities, fields, and which dimensions are legal to group_by.',
  '  2. query(entity, …)      — select rows at their natural grain (+ semantic rank / relevance).',
  '  3. fetch(entity, ids, …) — hydrate specific IDs into full rows.',
  '  4. aggregate(entity, …)  — collapse to grouped measures (grain-safe; conformed dimensions only).',
  '  5. compare(entity, …)    — N-variant aligned comparison (period-over-period / A-vs-B).',
  '',
  'Principles:',
  '  • Filters use a forgiving Mongo/Prisma JSON DSL; the engine normalizes it.',
  '  • A relevance cohort is op:"relevant" with exactly one of threshold|top_k — the response then',
  '    carries a CITATION (what defined the cohort + the cutoff + matched exemplars). Trust the citation.',
  '  • The engine FAILS LOUD: a refusal (non-conforming dimension, scope gap, unsafe fan-out) comes back',
  '    as an error with a reason. Read it and correct the request — do not work around it.',
].join('\n');

export interface QuerySurfaceMcpOptions {
  name?: string;
  version?: string;
}

/** Build an MCP server exposing the five primitives of `service` as tools. */
export function createQuerySurfaceMcpServer(
  service: QueryApplicationService,
  opts: QuerySurfaceMcpOptions = {},
): McpServer {
  const server = new McpServer(
    { name: opts.name ?? 'query-surface', version: opts.version ?? '0.1.0' },
    { instructions: INSTRUCTIONS },
  );
  registerQueryTools(server, service);
  return server;
}
