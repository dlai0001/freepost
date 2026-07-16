/**
 * `freepost mcp serve` — argument handling and the served surface.
 *
 * The end-to-end "does it survive bundling and speak clean JSON-RPC over a real
 * pipe" check lives in scripts/smoke-cli.mjs; these tests cover the wiring the
 * bundle can't tell you about.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { run, type CliIo } from './index'

function io(cwd: string): CliIo & { out: () => string } {
  let buf = ''
  return { cwd, color: false, write: (s) => (buf += s), out: () => buf }
}

let root = ''

afterEach(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true })
  root = ''
})

function collection(): string {
  root = mkdtempSync(join(tmpdir(), 'freepost-serve-'))
  writeFileSync(join(root, 'Get.curl'), `#!/usr/bin/env bash\n\ncurl --request GET \\\n  --url 'http://example.com/x'\n`)
  return root
}

/** Start `mcp serve`, run `fn` against it, then trigger the SIGINT handler. */
async function serving(
  argv: string[],
  fn: (o: ReturnType<typeof io>) => Promise<void>
): Promise<number> {
  const dir = collection()
  const o = io(dir)
  let sigint: (() => void) | undefined
  const done = run(['mcp', 'serve', dir, ...argv], { ...o, onSigint: (cb) => (sigint = cb) })
  // Let connect() settle before poking at it.
  await new Promise((r) => setTimeout(r, 50))
  await fn(o)
  sigint?.()
  return await done
}

describe('freepost mcp serve — arguments', () => {
  it('requires a collection', async () => {
    const o = io(process.cwd())
    expect(await run(['mcp', 'serve'], o)).toBe(2)
    expect(o.out()).toContain('Missing <collection> path')
  })

  it('reports a collection that does not exist', async () => {
    const o = io(process.cwd())
    expect(await run(['mcp', 'serve', '/nope/not/here'], o)).toBe(2)
    expect(o.out()).toContain('Collection not found')
  })

  it('rejects an unknown option', async () => {
    const o = io(process.cwd())
    expect(await run(['mcp', 'serve', '.', '--wat'], o)).toBe(2)
    expect(o.out()).toContain('Unknown option: --wat')
  })

  it('refuses serve-only flags on snapshot/check, rather than ignoring them', async () => {
    const o = io(process.cwd())
    expect(await run(['mcp', 'check', '.', '--readonly'], o)).toBe(2)
    expect(o.out()).toContain("only apply to 'freepost mcp serve'")
  })

  it('lists serve in the help', async () => {
    const o = io(process.cwd())
    expect(await run(['--help'], o)).toBe(0)
    expect(o.out()).toContain('freepost mcp <snapshot|check|serve>')
    expect(o.out()).toContain('--readonly')
    expect(o.out()).toContain('--no-run')
  })
})

describe('freepost mcp serve — running', () => {
  it('starts, announces itself, and exits 0 on Ctrl-C', async () => {
    const code = await serving([], async (o) => {
      expect(o.out()).toContain('freepost MCP server on stdio')
      expect(o.out()).toContain('read/write')
      expect(o.out()).toContain('run enabled')
    })
    expect(code).toBe(0)
  })

  it('reports the restricted flags it was started with', async () => {
    await serving(['--readonly', '--no-run', '--no-mcp-spawn'], async (o) => {
      expect(o.out()).toContain('read-only')
      expect(o.out()).toContain('no run')
      expect(o.out()).toContain('no mcp spawn')
    })
  })
})

describe('freepost mcp serve — the served surface', () => {
  // The transport differs (stdio in production, in-memory here) but the server
  // is built by the same factory the CLI uses.
  it('serves the full tool surface over a transport', async () => {
    const dir = collection()
    const { createFreepostMcpServer } = await import('../main/mcp-server')
    const server = createFreepostMcpServer({
      getRoot: () => dir,
      readonly: false,
      allowRun: true,
      allowMcpSpawn: () => true,
      session: new Map()
    })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '1.0.0' })
    await Promise.all([server.connect(serverSide), client.connect(clientSide)])
    try {
      const { tools } = await client.listTools()
      expect(tools).toHaveLength(11)
      const res = await client.callTool({ name: 'list_collection', arguments: {} })
      expect((res.content as { text: string }[])[0].text).toContain('Get.curl')
    } finally {
      await client.close()
      await server.close()
    }
  })
})
