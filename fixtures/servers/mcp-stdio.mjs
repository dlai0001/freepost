/**
 * Fixture: an MCP server over stdio (a SUBPROCESS — the transport Freepost gates
 * behind per-server spawn consent).
 *
 * Never write to stdout here: stdout IS the JSON-RPC channel, and a stray
 * console.log corrupts the stream. This is the single most-reported footgun in
 * the MCP ecosystem, so diagnostics go to stderr.
 *
 * Run it via a .mcp request (the app spawns it), not by hand.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'freepost-fixture-stdio', version: '1.0.0' })

server.registerTool(
  'get-sum',
  { description: 'Add two numbers', inputSchema: { a: z.number(), b: z.number() } },
  ({ a, b }) => ({ content: [{ type: 'text', text: `The sum of ${a} and ${b} is ${a + b}.` }] })
)

server.registerTool('boom', { description: 'Always fails (tool-level)' }, () => ({
  content: [{ type: 'text', text: 'the tool exploded' }],
  isError: true
}))

/** Proves `-e KEY=VALUE` reaches the subprocess environment. */
server.registerTool('whoami', { description: 'Read the WHO env var' }, () => ({
  content: [{ type: 'text', text: `WHO=${process.env.WHO ?? '(unset)'}` }]
}))

server.registerResource(
  'greeting',
  'demo://greeting',
  { mimeType: 'text/plain', description: 'A greeting' },
  async (uri) => ({ contents: [{ uri: uri.href, text: 'hello from the stdio MCP fixture' }] })
)

server.registerPrompt(
  'greet',
  { description: 'Greet someone', argsSchema: { who: z.string() } },
  ({ who }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Say hello to ${who}.` } }] })
)

console.error('[mcp-stdio] ready (diagnostics go to stderr; stdout is the protocol channel)')
await server.connect(new StdioServerTransport())
