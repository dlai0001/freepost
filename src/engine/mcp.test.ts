import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { callMcp, coerceToolArgs, McpSessionClient } from './mcp'

/**
 * A real MCP server (no mocks, per grpc.test.ts / mqtt.test.ts): a `get-sum`
 * tool, a `boom` tool that reports a TOOL-level failure (isError), a resource,
 * and a prompt. `stringy` exists to prove schema-aware coercion keeps "20" a
 * string when the schema says string.
 */
function buildServer(): McpServer {
  const server = new McpServer({ name: 'freepost-test', version: '1.0.0' })

  server.registerTool(
    'get-sum',
    { description: 'add', inputSchema: { a: z.number(), b: z.number() } },
    ({ a, b }) => ({ content: [{ type: 'text', text: `sum:${a + b}` }] })
  )

  /** Emits progress notifications while it works. */
  server.registerTool(
    'slow',
    { description: 'emits progress', inputSchema: { steps: z.number() } },
    async ({ steps }, { sendNotification, _meta }) => {
      const token = _meta?.progressToken
      for (let i = 1; i <= steps; i++) {
        if (token !== undefined) {
          await sendNotification({
            method: 'notifications/progress',
            params: { progressToken: token, progress: i, total: steps, message: `step ${i}` }
          })
        }
      }
      return { content: [{ type: 'text', text: `done:${steps}` }] }
    }
  )

  server.registerTool(
    'stringy',
    { description: 'echo a string', inputSchema: { v: z.string() } },
    ({ v }) => ({ content: [{ type: 'text', text: `got:${typeof v}:${v}` }] })
  )

  // The tool RAN and reported failure — the second failure axis, not a protocol error.
  server.registerTool('boom', { description: 'always fails' }, () => ({
    content: [{ type: 'text', text: 'exploded' }],
    isError: true
  }))

  server.registerResource(
    'greeting',
    'demo://greeting',
    { mimeType: 'text/plain' },
    async (uri) => ({ contents: [{ uri: uri.href, text: 'hello resource' }] })
  )

  server.registerPrompt(
    'greet',
    { description: 'greet someone', argsSchema: { who: z.string() } },
    ({ who }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Hello ${who}` } }] })
  )

  return server
}

/**
 * The same server, as a standalone stdio script (a real spawned subprocess).
 *
 * The F4 call-back tools (sampling / elicitation) live HERE rather than on the
 * HTTP fixture: a server->client request needs the session that carries the
 * initialize handshake, and the HTTP fixture is deliberately stateless (a fresh
 * server per POST), so its per-request server never learns what the client can
 * do. stdio keeps one process — and one session — for the whole call.
 */
const STDIO_SERVER = `
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'freepost-stdio-test', version: '1.0.0' })
server.registerTool('get-sum', { description: 'add', inputSchema: { a: z.number(), b: z.number() } },
  ({ a, b }) => ({ content: [{ type: 'text', text: 'sum:' + (a + b) }] }))
server.registerTool('whoami', { description: 'read env' }, () => ({
  content: [{ type: 'text', text: 'env:' + (process.env.WHO ?? 'nobody') }]
}))

// F4: the server calls back to the client for an LLM completion.
server.registerTool('ask-model', { description: 'requests sampling' }, async () => {
  const reply = await server.server.createMessage({
    messages: [{ role: 'user', content: { type: 'text', text: 'what is 2+2?' } }],
    maxTokens: 100
  })
  const text = reply.content.type === 'text' ? reply.content.text : '(non-text)'
  return { content: [{ type: 'text', text: 'model said: ' + text }] }
})

// F4: the server asks the user a question.
server.registerTool('ask-user', { description: 'requests elicitation' }, async () => {
  const reply = await server.server.elicitInput({
    message: 'What city?',
    requestedSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
  })
  return { content: [{ type: 'text', text: 'user ' + reply.action + ': ' + JSON.stringify(reply.content ?? null) }] }
})

await server.connect(new StdioServerTransport())
`

let http: Server
let url = ''
let dir = ''
let stdioScript = ''

beforeAll(async () => {
  // Stateless Streamable HTTP: a fresh server+transport per request. Reusing a
  // single stateless transport across requests 500s on the second POST.
  http = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      let body: unknown
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        body = undefined
      }
      void (async (): Promise<void> => {
        const mcp = buildServer()
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
        res.on('close', () => {
          void transport.close()
          void mcp.close()
        })
        await mcp.connect(transport)
        await transport.handleRequest(req, res, body)
      })()
    })
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`

  // The stdio server is a REAL spawned subprocess, so its script must sit where
  // node can resolve @modelcontextprotocol/sdk — i.e. inside the project, not
  // in the OS temp dir.
  dir = mkdtempSync(join(process.cwd(), '.tmp-mcp-test-'))
  stdioScript = join(dir, 'server.mjs')
  writeFileSync(stdioScript, STDIO_SERVER)
})

afterAll(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()))
  rmSync(dir, { recursive: true, force: true })
})

describe('callMcp over Streamable HTTP', () => {
  it('calls a tool and returns its content', async () => {
    const r = await callMcp({
      transport: 'http',
      url,
      method: 'tools/call',
      toolName: 'get-sum',
      toolArgs: [
        { name: 'a', value: '20' },
        { name: 'b', value: '22' }
      ]
    })
    expect(r.error).toBeUndefined()
    expect(r.isError).toBe(false)
    expect(JSON.parse(r.body).content[0].text).toBe('sum:42')
    expect(r.timeMs).toBeGreaterThanOrEqual(0)
  })

  it('reports a TOOL failure as isError, not a protocol error', async () => {
    const r = await callMcp({ transport: 'http', url, method: 'tools/call', toolName: 'boom' })
    expect(r.isError).toBe(true)
    expect(r.error).toBeUndefined() // the two axes stay distinct
    expect(JSON.parse(r.body).content[0].text).toBe('exploded')
  })

  it('reports an unknown tool as a TOOL error (isError), not a thrown protocol error', async () => {
    // Verified against SDK 1.29: the high-level McpServer turns an unknown tool
    // into an ordinary isError result carrying "MCP error -32602", it does not
    // throw. Protocol errors are for transport/connection failures and for
    // non-tool methods (see the resources/read case below).
    const r = await callMcp({ transport: 'http', url, method: 'tools/call', toolName: 'nope' })
    expect(r.isError).toBe(true)
    expect(r.error).toBeUndefined()
    expect(JSON.parse(r.body).content[0].text).toMatch(/-32602/)
  })

  it('reports an unknown resource URI as a PROTOCOL error', async () => {
    const r = await callMcp({ transport: 'http', url, method: 'resources/read', uri: 'demo://nope' })
    expect(r.error).toBeDefined()
    expect(r.isError).toBe(false)
  })

  it('surfaces a schema violation as a tool error (isError)', async () => {
    const r = await callMcp({
      transport: 'http',
      url,
      method: 'tools/call',
      toolName: 'get-sum',
      toolArgs: [{ name: 'a', value: 'not-a-number' }]
    })
    expect(r.isError).toBe(true)
  })

  it('lists tools, resources and prompts', async () => {
    const tools = await callMcp({ transport: 'http', url, method: 'tools/list' })
    expect(JSON.parse(tools.body).tools.map((t: { name: string }) => t.name)).toContain('get-sum')

    const resources = await callMcp({ transport: 'http', url, method: 'resources/list' })
    expect(JSON.parse(resources.body).resources[0].uri).toBe('demo://greeting')

    const prompts = await callMcp({ transport: 'http', url, method: 'prompts/list' })
    expect(JSON.parse(prompts.body).prompts[0].name).toBe('greet')
  })

  it('reads a resource and gets a prompt', async () => {
    const res = await callMcp({ transport: 'http', url, method: 'resources/read', uri: 'demo://greeting' })
    expect(JSON.parse(res.body).contents[0].text).toBe('hello resource')

    const p = await callMcp({
      transport: 'http',
      url,
      method: 'prompts/get',
      promptName: 'greet',
      promptArgs: [{ name: 'who', value: 'dave' }]
    })
    expect(JSON.parse(p.body).messages[0].content.text).toBe('Hello dave')
  })

  it('never rejects on a bad endpoint — it returns a protocol error', async () => {
    const r = await callMcp({ transport: 'http', url: 'http://127.0.0.1:1/mcp', method: 'tools/list' })
    expect(r.error).toBeDefined()
    expect(JSON.parse(r.body).error).toBeDefined()
  })
})

/**
 * Spawning a node subprocess that imports the MCP SDK routinely exceeds
 * vitest's 5s default once the full suite is running in parallel — hence the
 * explicit budget on every test that starts a real server process.
 */
const SPAWN_TIMEOUT = 30_000

describe('callMcp over stdio (real subprocess)', () => {
  it('spawns the server and calls a tool', async () => {
    const r = await callMcp({
      transport: 'stdio',
      command: process.execPath,
      args: [stdioScript],
      method: 'tools/call',
      toolName: 'get-sum',
      toolArgs: [
        { name: 'a', value: '1' },
        { name: 'b', value: '2' }
      ]
    })
    expect(r.error).toBeUndefined()
    expect(JSON.parse(r.body).content[0].text).toBe('sum:3')
  }, SPAWN_TIMEOUT)

  it('passes -e environment through to the subprocess', async () => {
    const r = await callMcp({
      transport: 'stdio',
      command: process.execPath,
      args: [stdioScript],
      env: { WHO: 'freepost' },
      method: 'tools/call',
      toolName: 'whoami'
    })
    expect(JSON.parse(r.body).content[0].text).toBe('env:freepost')
  }, SPAWN_TIMEOUT)

  it('returns a protocol error when the command does not exist', async () => {
    const r = await callMcp({
      transport: 'stdio',
      command: join(dir, 'no-such-binary'),
      method: 'tools/list'
    })
    expect(r.error).toBeDefined()
  }, SPAWN_TIMEOUT)

  it('returns a protocol error when no command is given', async () => {
    const r = await callMcp({ transport: 'stdio', method: 'tools/list' })
    expect(r.error).toMatch(/requires a server command/)
  })
})

/**
 * F4 — a test client must be able to ANSWER a server that calls back mid-request.
 * Doing this *scriptably* (rather than by hand in a UI) is the novel part.
 * Sampling/elicitation run over stdio because they need a persistent session.
 */
describe('server-initiated flows', () => {
  const stdio = (over: Record<string, unknown>): Parameters<typeof callMcp>[0] => ({
    transport: 'stdio',
    command: process.execPath,
    args: [stdioScript],
    method: 'tools/call',
    ...over
  })

  it(
    'answers a sampling request with the scripted response',
    async () => {
      const r = await callMcp(
        stdio({
          toolName: 'ask-model',
          sampling: () => ({
            role: 'assistant' as const,
            content: { type: 'text' as const, text: 'four' },
            model: 'canned'
          })
        })
      )
      expect(r.error).toBeUndefined()
      expect(JSON.parse(r.body).content[0].text).toBe('model said: four')
    },
    SPAWN_TIMEOUT
  )

  it(
    'refuses sampling when none is configured — Freepost never silently stubs an LLM',
    async () => {
      const r = await callMcp(stdio({ toolName: 'ask-model' }))
      // The server's call-back is refused, so the TOOL fails: an isError result.
      expect(r.isError).toBe(true)
      expect(r.body).toMatch(/sampling/i)
    },
    SPAWN_TIMEOUT
  )

  it(
    'answers an elicitation request with the scripted action and content',
    async () => {
      const r = await callMcp(
        stdio({
          toolName: 'ask-user',
          elicitation: () => ({ action: 'accept' as const, content: { city: 'Oakland' } })
        })
      )
      expect(JSON.parse(r.body).content[0].text).toBe('user accept: {"city":"Oakland"}')
    },
    SPAWN_TIMEOUT
  )

  it(
    'declines elicitation by default, so a headless run never hangs waiting on a human',
    async () => {
      const r = await callMcp(stdio({ toolName: 'ask-user' }))
      expect(JSON.parse(r.body).content[0].text).toContain('user decline')
    },
    SPAWN_TIMEOUT
  )

  it('captures progress notifications emitted during a call', async () => {
    const seen: number[] = []
    const r = await callMcp({
      transport: 'http',
      url,
      method: 'tools/call',
      toolName: 'slow',
      toolArgs: [{ name: 'steps', value: '3' }],
      onProgress: (p) => seen.push(p.progress)
    })
    expect(JSON.parse(r.body).content[0].text).toBe('done:3')
    expect(seen).toEqual([1, 2, 3])
    expect(r.progress.map((p) => p.message)).toEqual(['step 1', 'step 2', 'step 3'])
  })
})

describe('coerceToolArgs', () => {
  it('coerces to the declared schema type', () => {
    const schema = { n: { type: 'number' }, s: { type: 'string' }, b: { type: 'boolean' } }
    expect(coerceToolArgs([{ name: 'n', value: '20' }], schema)).toEqual({ n: 20 })
    // The load-bearing case: a string property keeps "20" as text.
    expect(coerceToolArgs([{ name: 's', value: '20' }], schema)).toEqual({ s: '20' })
    expect(coerceToolArgs([{ name: 'b', value: 'true' }], schema)).toEqual({ b: true })
  })

  it('passes a bad value through so the SERVER reports the schema violation', () => {
    expect(coerceToolArgs([{ name: 'n', value: 'abc' }], { n: { type: 'number' } })).toEqual({ n: 'abc' })
  })

  it('falls back to JSON shape without a schema', () => {
    expect(coerceToolArgs([{ name: 'x', value: '5' }])).toEqual({ x: 5 })
    expect(coerceToolArgs([{ name: 'x', value: '{"a":1}' }])).toEqual({ x: { a: 1 } })
    expect(coerceToolArgs([{ name: 'x', value: 'hello' }])).toEqual({ x: 'hello' })
  })

  it('honours a string schema even when the value looks like a string type', () => {
    const s = coerceToolArgs([{ name: 'v', value: '20' }], { v: { type: 'string' } })
    expect(typeof s.v).toBe('string')
  })
})

describe('McpSessionClient', () => {
  it('connects, introspects, and calls tools on an open session', async () => {
    const client = new McpSessionClient()
    const info = await new Promise<Awaited<ReturnType<McpSessionClient['introspect']>>>((resolve, reject) => {
      client.on('open', resolve).on('error', reject)
      void client.connect({ transport: 'http', url })
    })

    expect(client.state).toBe('open')
    expect((info.tools as { name: string }[]).map((t) => t.name)).toEqual(
      expect.arrayContaining(['get-sum', 'boom', 'stringy'])
    )
    expect((info.resources as { uri: string }[])[0].uri).toBe('demo://greeting')
    expect((info.prompts as { name: string }[])[0].name).toBe('greet')
    expect(info.serverInfo.name).toBe('freepost-test')

    const r = await client.callTool('get-sum', [
      { name: 'a', value: '2' },
      { name: 'b', value: '3' }
    ])
    expect(JSON.parse(r.body).content[0].text).toBe('sum:5')

    // Schema-aware coercion holds on the session path too.
    const s = await client.callTool('stringy', [{ name: 'v', value: '20' }])
    expect(JSON.parse(s.body).content[0].text).toBe('got:string:20')

    await client.close()
    expect(client.state).toBe('closed')
  })

  it('emits error (not a rejection) when the server is unreachable', async () => {
    const client = new McpSessionClient()
    const err = await new Promise<Error>((resolve) => {
      client.on('error', resolve)
      void client.connect({ transport: 'http', url: 'http://127.0.0.1:1/mcp' })
    })
    expect(err).toBeInstanceOf(Error)
    expect(client.state).toBe('closed')
  })
})
