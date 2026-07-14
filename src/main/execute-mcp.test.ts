import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { writeRequestFile } from '../core/format'
import type { McpRequestModel, RequestFile } from '../shared/model'
import { executeRequest } from './execute'

/**
 * End-to-end proof of the thing no competitor has: assertions (pm.* + chai)
 * against an MCP tool call, executed headlessly. Mirrors execute-grpc.test.ts.
 */
let root = ''
let http: Server
let url = ''

function buildServer(): McpServer {
  const s = new McpServer({ name: 'exec-test', version: '1.0.0' })
  s.registerTool(
    'get-sum',
    { description: 'add', inputSchema: { a: z.number(), b: z.number() } },
    ({ a, b }) => ({ content: [{ type: 'text', text: `sum:${a + b}` }] })
  )
  s.registerTool('boom', { description: 'fails' }, () => ({
    content: [{ type: 'text', text: 'exploded' }],
    isError: true
  }))
  s.registerResource('greeting', 'demo://greeting', { mimeType: 'text/plain' }, async (uri) => ({
    contents: [{ uri: uri.href, text: 'hello resource' }]
  }))
  return s
}

beforeAll(async () => {
  root = mkdtempSync(join(process.cwd(), '.tmp-execmcp-'))
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
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`
})

afterAll(async () => {
  await new Promise<void>((r) => http.close(() => r()))
  rmSync(root, { recursive: true, force: true })
})

const httpModel = (over: Partial<McpRequestModel> = {}): McpRequestModel => ({
  transport: 'http',
  url,
  args: [],
  env: [],
  headers: [],
  method: 'tools/call',
  toolName: 'get-sum',
  toolArgs: [
    { name: 'a', value: '20' },
    { name: 'b', value: '22' }
  ],
  promptArgs: [],
  ...over
})

function writeMcp(rel: string, file: RequestFile): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, writeRequestFile(file))
}

const run = (rel: string): ReturnType<typeof executeRequest> =>
  executeRequest({ root, path: rel, session: new Map() })

describe('executeRequest for .mcp', () => {
  it('calls a tool and passes an assertion against the result', async () => {
    writeMcp('Sum.mcp', {
      kind: 'mcp',
      frontmatter: {
        scripts: {
          test: 'pm.test("sums", () => pm.expect(pm.response.json().content[0].text).to.equal("sum:42"));'
        }
      },
      variables: [],
      mcp: httpModel(),
      comments: []
    })
    const report = await run('Sum.mcp')
    expect(report.errored).toBe(false)
    expect(report.response?.status).toBe(200)
    expect(report.response?.statusText).toBe('OK')
    expect(report.testScript?.tests).toEqual([{ name: 'sums', passed: true }])
  })

  it('exposes a TOOL failure as status 500 / TOOL_ERROR, assertable via isError', async () => {
    writeMcp('Boom.mcp', {
      kind: 'mcp',
      frontmatter: {
        scripts: {
          test: 'pm.test("is a tool error", () => pm.expect(pm.response.json().isError).to.equal(true));'
        }
      },
      variables: [],
      mcp: httpModel({ toolName: 'boom', toolArgs: [] }),
      comments: []
    })
    const report = await run('Boom.mcp')
    // The tool ran and reported failure: errored, but NOT a transport error.
    expect(report.response?.status).toBe(500)
    expect(report.response?.statusText).toBe('TOOL_ERROR')
    expect(report.transportError).toBeUndefined()
    expect(report.errored).toBe(true)
    expect(report.testScript?.tests).toEqual([{ name: 'is a tool error', passed: true }])
  })

  it('exposes a PROTOCOL failure as 502 / PROTOCOL_ERROR with a transport error', async () => {
    writeMcp('Dead.mcp', {
      kind: 'mcp',
      frontmatter: {},
      variables: [],
      mcp: httpModel({ url: 'http://127.0.0.1:1/mcp', method: 'tools/list', toolName: undefined, toolArgs: [] }),
      comments: []
    })
    const report = await run('Dead.mcp')
    expect(report.response?.status).toBe(502)
    expect(report.response?.statusText).toBe('PROTOCOL_ERROR')
    expect(report.transportError).toBeDefined()
    expect(report.errored).toBe(true)
  })

  it('fails the run when an assertion fails (the CI gate)', async () => {
    writeMcp('Wrong.mcp', {
      kind: 'mcp',
      frontmatter: {
        scripts: { test: 'pm.test("wrong", () => pm.expect(pm.response.json().content[0].text).to.equal("sum:0"));' }
      },
      variables: [],
      mcp: httpModel(),
      comments: []
    })
    const report = await run('Wrong.mcp')
    expect(report.errored).toBe(true)
    expect(report.testScript?.tests[0].passed).toBe(false)
  })

  it('substitutes ${VAR} into the endpoint and tool args', async () => {
    writeMcp('Vars.mcp', {
      kind: 'mcp',
      frontmatter: {
        scripts: { test: 'pm.test("sums", () => pm.expect(pm.response.json().content[0].text).to.equal("sum:7"));' }
      },
      variables: [
        { name: 'MCP_URL', defaultValue: url, required: false },
        { name: 'LEFT', defaultValue: '3', required: false }
      ],
      mcp: httpModel({
        url: '${MCP_URL}',
        toolArgs: [
          { name: 'a', value: '${LEFT}' },
          { name: 'b', value: '4' }
        ]
      }),
      comments: []
    })
    const report = await run('Vars.mcp')
    expect(report.errored).toBe(false)
    expect(report.resolvedUrl).toBe(url)
    expect(report.testScript?.tests).toEqual([{ name: 'sums', passed: true }])
  })

  it('reports an unresolved required variable instead of connecting', async () => {
    writeMcp('Missing.mcp', {
      kind: 'mcp',
      frontmatter: {},
      variables: [{ name: 'TOKEN', required: true }],
      mcp: httpModel({ headers: [{ name: 'Authorization', value: 'Bearer ${TOKEN}' }] }),
      comments: []
    })
    const report = await run('Missing.mcp')
    expect(report.errored).toBe(true)
    expect(report.unresolved).toEqual(['TOKEN'])
    expect(report.response).toBeUndefined()
  })

  it('reads a resource', async () => {
    writeMcp('Res.mcp', {
      kind: 'mcp',
      frontmatter: {
        scripts: {
          test: 'pm.test("reads", () => pm.expect(pm.response.json().contents[0].text).to.equal("hello resource"));'
        }
      },
      variables: [],
      mcp: httpModel({ method: 'resources/read', uri: 'demo://greeting', toolName: undefined, toolArgs: [] }),
      comments: []
    })
    const report = await run('Res.mcp')
    expect(report.errored).toBe(false)
    expect(report.testScript?.tests).toEqual([{ name: 'reads', passed: true }])
  })

  it('runs a stdio server as a real subprocess, end to end', async () => {
    const script = join(root, 'stdio-server.mjs')
    writeFileSync(
      script,
      `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
const s = new McpServer({ name: 'stdio', version: '1.0.0' })
s.registerTool('ping', { description: 'ping' }, () => ({ content: [{ type: 'text', text: 'pong' }] }))
await s.connect(new StdioServerTransport())
`
    )
    writeMcp('Stdio.mcp', {
      kind: 'mcp',
      frontmatter: {
        scripts: { test: 'pm.test("pongs", () => pm.expect(pm.response.json().content[0].text).to.equal("pong"));' }
      },
      variables: [],
      mcp: {
        transport: 'stdio',
        command: process.execPath,
        args: [script],
        env: [],
        headers: [],
        method: 'tools/call',
        toolName: 'ping',
        toolArgs: [],
        promptArgs: []
      },
      comments: []
    })
    const report = await run('Stdio.mcp')
    expect(report.errored).toBe(false)
    expect(report.testScript?.tests).toEqual([{ name: 'pongs', passed: true }])
    // Spawning a node subprocess that imports the MCP SDK blows vitest's 5s
    // default once the whole suite runs in parallel.
  }, 30_000)
})
