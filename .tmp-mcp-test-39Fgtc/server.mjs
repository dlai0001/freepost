
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'freepost-stdio-test', version: '1.0.0' })
server.registerTool('get-sum', { description: 'add', inputSchema: { a: z.number(), b: z.number() } },
  ({ a, b }) => ({ content: [{ type: 'text', text: 'sum:' + (a + b) }] }))
server.registerTool('whoami', { description: 'read env' }, () => ({
  content: [{ type: 'text', text: 'env:' + (process.env.WHO ?? 'nobody') }]
}))
await server.connect(new StdioServerTransport())
