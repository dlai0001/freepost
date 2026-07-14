/**
 * Fixture: an MCP server over Streamable HTTP (port 3011, endpoint /mcp).
 *
 * Exercises everything a `.mcp` request can do:
 *   tools      — get-sum (numbers), echo (string, proves schema-aware coercion),
 *                boom (isError: the TOOL failure axis), slow (progress
 *                notifications), weather (structuredContent + outputSchema)
 *   resources  — demo://greeting, demo://config
 *   prompts    — greet(who)
 *
 * Note the stateless pattern: a FRESH server + transport per request. Reusing a
 * single stateless transport across requests 500s on the second POST.
 */
import { createServer } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

const PORT = Number(process.env.PORT ?? 3011)

function buildServer() {
  const server = new McpServer({ name: 'freepost-fixture-http', version: '1.0.0' })

  server.registerTool(
    'get-sum',
    { description: 'Add two numbers', inputSchema: { a: z.number(), b: z.number() } },
    ({ a, b }) => ({ content: [{ type: 'text', text: `The sum of ${a} and ${b} is ${a + b}.` }] })
  )

  // `--tool-arg v=20` must arrive as the STRING "20" here, not the number 20.
  server.registerTool(
    'echo',
    { description: 'Echo a string back', inputSchema: { v: z.string() } },
    ({ v }) => ({ content: [{ type: 'text', text: `echo(${typeof v}): ${v}` }] })
  )

  server.registerTool('boom', { description: 'Always fails (tool-level)' }, () => ({
    content: [{ type: 'text', text: 'the tool exploded' }],
    isError: true
  }))

  server.registerTool(
    'slow',
    { description: 'Emits progress notifications', inputSchema: { steps: z.number().default(3) } },
    async ({ steps }, { sendNotification, _meta }) => {
      const token = _meta?.progressToken
      for (let i = 1; i <= steps; i++) {
        if (token !== undefined) {
          await sendNotification({
            method: 'notifications/progress',
            params: { progressToken: token, progress: i, total: steps, message: `step ${i}/${steps}` }
          })
        }
        await new Promise((r) => setTimeout(r, 150))
      }
      return { content: [{ type: 'text', text: `done in ${steps} steps` }] }
    }
  )

  server.registerTool(
    'weather',
    {
      description: 'Structured output example',
      inputSchema: { city: z.string() },
      outputSchema: { city: z.string(), tempC: z.number(), conditions: z.string() }
    },
    ({ city }) => {
      const structured = { city, tempC: 21, conditions: 'fog' }
      return { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured }
    }
  )

  server.registerResource(
    'greeting',
    'demo://greeting',
    { mimeType: 'text/plain', description: 'A greeting' },
    async (uri) => ({ contents: [{ uri: uri.href, text: 'hello from the freepost MCP fixture' }] })
  )

  server.registerResource(
    'config',
    'demo://config',
    { mimeType: 'application/json', description: 'Fake config' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ env: 'fixture', debug: true }, null, 2) }]
    })
  )

  server.registerPrompt(
    'greet',
    { description: 'Greet someone', argsSchema: { who: z.string() } },
    ({ who }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Say hello to ${who}.` } }] })
  )

  return server
}

const http = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, server: 'mcp-http' }))
    return
  }
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    let body
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      body = undefined
    }
    const server = buildServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      transport.close()
      server.close()
    })
    server
      .connect(transport)
      .then(() => transport.handleRequest(req, res, body))
      .catch((e) => {
        console.error('[mcp-http] error:', e.message)
        if (!res.headersSent) res.writeHead(500).end()
      })
  })
})

http.listen(PORT, () => {
  console.log(`[mcp-http] MCP Streamable HTTP server on http://localhost:${PORT}/mcp`)
  console.log('[mcp-http] tools: get-sum, echo, boom, slow, weather | resources: demo://greeting, demo://config | prompts: greet')
})
