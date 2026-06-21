// Public surface of the MCP driving adapter (subpath export: `@pattern-stack/query-surface/mcp`).
//
// The host composes a QueryApplicationService (DB + registry + model + scope) and passes it to
// createQuerySurfaceMcpServer to get an McpServer; the host then connects a transport. See
// scripts/mcp/serve.ts for a runnable stdio boot against the dealbrain reference fixture.

export { createQuerySurfaceMcpServer } from './server.ts';
export type { QuerySurfaceMcpOptions } from './server.ts';
export { registerQueryTools, QUERY_TOOL_NAMES } from './tools.ts';
