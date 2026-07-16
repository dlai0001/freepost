import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { run, type CliIo } from './index'

/**
 * `freepost run` / `freepost mcp snapshot|check` against a real MCP server.
 * `drop` lets a test remove a tool mid-run to simulate a server that shipped a
 * BREAKING schema change — the exact thing F5 exists to catch.
 */
let http: Server
let url = ''
let root = ''
const dropped = new Set<string>()

function buildServer(): McpServer {
  const s = new McpServer({ name: 'cli-fixture', version: '1.0.0' })
  s.registerTool(
    'get-sum',
    { description: 'add', inputSchema: { a: z.number(), b: z.number() } },
    ({ a, b }) => ({ content: [{ type: 'text', text: `sum:${a + b}` }] })
  )
  if (!dropped.has('extra')) {
    s.registerTool('extra', { description: 'extra' }, () => ({ content: [{ type: 'text', text: 'x' }] }))
  }
  return s
}

function io(cwd: string): CliIo & { out: () => string } {
  let buf = ''
  return { cwd, color: false, write: (s) => (buf += s), out: () => buf }
}

beforeAll(async () => {
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

  root = mkdtempSync(join(process.cwd(), '.tmp-climcp-'))
  writeFileSync(
    join(root, 'Sum.mcp'),
    `#!/usr/bin/env bash
# ---
# scripts:
#   test: |-
#     pm.test("sums", () => pm.expect(pm.response.json().content[0].text).to.equal("sum:42"));
# ---

npx @modelcontextprotocol/inspector \\
  --cli \\
  '${url}' \\
  --transport http \\
  --method 'tools/call' \\
  --tool-name 'get-sum' \\
  --tool-arg 'a=20' \\
  --tool-arg 'b=22'
`
  )
})

afterAll(async () => {
  await new Promise<void>((r) => http.close(() => r()))
  rmSync(root, { recursive: true, force: true })
})

describe('freepost run with .mcp requests', () => {
  it('runs an MCP tool call and reports its assertions', async () => {
    const o = io(root)
    const code = await run(['run', root], o)
    expect(code).toBe(0)
    expect(o.out()).toContain('✓ sums')
  })

  it('skips stdio MCP requests under --no-mcp-spawn', async () => {
    const dir = mkdtempSync(join(process.cwd(), '.tmp-climcp-skip-'))
    writeFileSync(
      join(dir, 'Spawn.mcp'),
      `npx @modelcontextprotocol/inspector \\
  --cli \\
  'node' \\
  'server.mjs' \\
  --transport stdio \\
  --method 'tools/list'
`
    )
    const o = io(dir)
    const code = await run(['run', dir, '--no-mcp-spawn'], o)
    expect(code).toBe(0)
    expect(o.out()).toContain('1 stdio MCP request(s) skipped')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('freepost mcp snapshot|check (F5 drift)', () => {
  it('records a snapshot, then reports no drift', async () => {
    const snap = await run(['mcp', 'snapshot', root], io(root))
    expect(snap).toBe(0)

    const written = readFileSync(join(root, 'Sum.mcp.snapshot.json'), 'utf8')
    expect(JSON.parse(written).tools.map((t: { name: string }) => t.name)).toEqual(['extra', 'get-sum'])

    const o = io(root)
    const check = await run(['mcp', 'check', root], o)
    expect(check).toBe(0)
    expect(o.out()).toContain('no drift')
  })

  it('FAILS (exit 1) when the live server drops a tool the snapshot recorded', async () => {
    await run(['mcp', 'snapshot', root], io(root))

    dropped.add('extra') // the server ships a breaking change
    try {
      const o = io(root)
      const code = await run(['mcp', 'check', root], o)
      expect(code).toBe(1)
      expect(o.out()).toContain('BREAKING')
      expect(o.out()).toContain('tool "extra" was removed')
      expect(o.out()).toContain('1 with breaking changes')
    } finally {
      dropped.delete('extra')
    }
  })

  it('fails the check when no snapshot has been recorded', async () => {
    const dir = mkdtempSync(join(process.cwd(), '.tmp-climcp-nosnap-'))
    writeFileSync(
      join(dir, 'X.mcp'),
      `npx @modelcontextprotocol/inspector --cli '${url}' --transport http --method 'tools/list'\n`
    )
    const o = io(dir)
    const code = await run(['mcp', 'check', dir], o)
    expect(code).toBe(1)
    expect(o.out()).toContain("run 'freepost mcp snapshot' first")
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects an unknown mcp action', async () => {
    const o = io(root)
    const code = await run(['mcp', 'bogus', root], o)
    expect(code).toBe(2)
    expect(o.out()).toContain("'snapshot', 'check' or 'serve'")
  })
})
