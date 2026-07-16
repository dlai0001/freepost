/**
 * Freepost's MCP server: the inverse of the `.mcp` request kind. Where a .mcp
 * file makes Freepost an MCP *client*, this makes a collection something an AI
 * app can drive — create requests, write test scripts, run them, iterate.
 *
 * Two entry points share this factory: `freepost mcp serve` over stdio (for
 * Claude Desktop's config) and the app's Tools ▸ MCP Server toggle over local
 * HTTP. Both get the identical tool surface; they differ only in the
 * ServerContext they build (chiefly who may spawn a stdio MCP subprocess).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerFreepostTools } from './tools'
import type { ServerContext } from './context'

export type { ServerContext } from './context'
export { registerFreepostTools } from './tools'

export function createFreepostMcpServer(ctx: ServerContext): McpServer {
  const server = new McpServer(
    { name: 'freepost', version: '0.2.0' },
    {
      instructions:
        'Freepost is an API client whose collections are plain-text request files on disk. ' +
        'Use list_collection to see what exists, get_format_spec before writing your first ' +
        'request file (the format is a strict bash grammar), write_request to create or edit ' +
        'requests and their test scripts, and run_request to check the tests pass. ' +
        'For GraphQL, start with describe_graphql_schema; for REST specs, import_openapi.'
    }
  )
  registerFreepostTools(server, ctx)
  return server
}
