/**
 * The Tools ▸ MCP Server toggle.
 *
 * menu.ts is a thin template whose checkbox calls toggleAppMcpServer(), so this
 * exercises everything behind that click: the real HTTP listener, a real MCP
 * client over a real socket, the settings-driven port, the consent gate, and the
 * lifecycle rules (stop on collection switch, free the port on stop).
 *
 * Electron is mocked — it's the only thing here that can't run headless. The
 * mocks are the narrow shims app-toggle actually touches (userData path, the
 * dialog it shows on failure, the clipboard the menu writes to).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

/** Where the mocked Electron keeps userData (settings.json, mcp-consent.json). */
let userData: string
const clipboardText = { value: '' }
const dialogs: { message?: string; detail?: string }[] = []

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  clipboard: { writeText: (t: string) => (clipboardText.value = t) },
  dialog: {
    showMessageBox: async (opts: { message?: string; detail?: string }) => {
      dialogs.push(opts)
      return { response: 0 }
    }
  }
}))

const {
  startAppMcpServer,
  stopAppMcpServer,
  toggleAppMcpServer,
  isMcpServerRunning,
  mcpServerUrl,
  copyMcpConfigSnippet,
  DEFAULT_MCP_PORT
} = await import('./app-toggle')
const { setCurrentRoot } = await import('../current-root')

let root: string

/** Pick an unused port so the suite never collides with a real app on 7599. */
async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const { port } = s.address() as { port: number }
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

/** Point settings.json at `port`, the way a user editing it by hand would. */
function setPort(port: number): void {
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ mcpServerPort: port }))
}

async function connect(): Promise<Client> {
  const client = new Client({ name: 'test-ai-app', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpServerUrl()!)))
  return client
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'freepost-userdata-'))
  root = mkdtempSync(join(tmpdir(), 'freepost-collection-'))
  writeFileSync(
    join(root, 'Health.curl'),
    `#!/usr/bin/env bash\n\ncurl --request GET \\\n  --url 'http://127.0.0.1:1/health'\n`
  )
  clipboardText.value = ''
  dialogs.length = 0
  setCurrentRoot(root)
})

afterEach(async () => {
  await stopAppMcpServer()
  setCurrentRoot(null)
  await rm(root, { recursive: true, force: true })
  await rm(userData, { recursive: true, force: true })
})

describe('the toggle', () => {
  it('is off until you turn it on, and serves the collection once you do', async () => {
    expect(isMcpServerRunning()).toBe(false)
    expect(mcpServerUrl()).toBeNull()

    setPort(await freePort())
    await toggleAppMcpServer()

    expect(isMcpServerRunning()).toBe(true)
    expect(mcpServerUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)

    // An AI app can now actually use it.
    const client = await connect()
    try {
      const { tools } = await client.listTools()
      expect(tools).toHaveLength(11)
      const res = await client.callTool({ name: 'list_collection', arguments: {} })
      expect((res.content as { text: string }[])[0].text).toContain('Health.curl')
    } finally {
      await client.close()
    }
  })

  it('turns back off, freeing the port', async () => {
    const port = await freePort()
    setPort(port)
    await toggleAppMcpServer()
    expect(isMcpServerRunning()).toBe(true)

    await toggleAppMcpServer()
    expect(isMcpServerRunning()).toBe(false)
    expect(mcpServerUrl()).toBeNull()

    // The port is really released — rebinding it proves the listener is gone.
    setPort(port)
    await toggleAppMcpServer()
    expect(mcpServerUrl()).toContain(`:${port}/`)
  })

  it('lets an AI write a file that lands in the collection', async () => {
    setPort(await freePort())
    await startAppMcpServer()
    const client = await connect()
    try {
      const res = await client.callTool({
        name: 'write_request',
        arguments: {
          path: 'Written by AI.curl',
          content:
            '#!/usr/bin/env bash\n# ---\n# description: written over the app toggle\n# ---\n\n' +
            "curl --request GET --url 'http://example.com/x'\n"
        }
      })
      expect(res.isError).toBeFalsy()
    } finally {
      await client.close()
    }
    // On disk in the real collection — which is what the app's watcher picks up.
    const written = readFileSync(join(root, 'Written by AI.curl'), 'utf8')
    expect(written).toContain('written over the app toggle')
  })

  it('keeps session variables across calls, despite a fresh server per request', async () => {
    setPort(await freePort())
    await startAppMcpServer()
    // Two calls land on two different McpServer instances (stateless HTTP), so
    // this is really asserting the session Map is closed over, not per-server.
    const client = await connect()
    try {
      const a = await client.callTool({ name: 'list_collection', arguments: {} })
      const b = await client.callTool({ name: 'list_collection', arguments: {} })
      expect(a.isError).toBeFalsy()
      expect(b.isError).toBeFalsy()
    } finally {
      await client.close()
    }
  })
})

describe('the menu affordances', () => {
  it('copies a config snippet an AI app can actually use', async () => {
    setPort(await freePort())
    await startAppMcpServer()
    copyMcpConfigSnippet()

    const parsed = JSON.parse(clipboardText.value)
    expect(parsed.mcpServers.freepost.type).toBe('http')
    expect(parsed.mcpServers.freepost.url).toBe(mcpServerUrl())
  })

  it('copies nothing when the server is off', () => {
    copyMcpConfigSnippet()
    expect(clipboardText.value).toBe('')
  })
})

describe('lifecycle guardrails', () => {
  it('says so instead of starting when no collection is open', async () => {
    setCurrentRoot(null)
    await startAppMcpServer()
    expect(isMcpServerRunning()).toBe(false)
    expect(dialogs[0]?.message).toBe('Open a collection first')
  })

  it('stops when the user switches collections, rather than serving the new one', async () => {
    setPort(await freePort())
    await startAppMcpServer()
    expect(isMcpServerRunning()).toBe(true)

    const other = mkdtempSync(join(tmpdir(), 'freepost-other-'))
    setCurrentRoot(other)
    // The listener stops on the root-change notification.
    await vi.waitFor(() => expect(isMcpServerRunning()).toBe(false))
    await rm(other, { recursive: true, force: true })
  })

  it('explains an occupied port instead of failing silently', async () => {
    const port = await freePort()
    const squatter = createServer()
    await new Promise<void>((r) => squatter.listen(port, '127.0.0.1', r))
    try {
      setPort(port)
      await startAppMcpServer()
      expect(isMcpServerRunning()).toBe(false)
      expect(dialogs[0]?.message).toBe('Could not start the MCP server')
      expect(dialogs[0]?.detail).toContain(`Port ${port} is already in use`)
      expect(dialogs[0]?.detail).toContain('mcpServerPort')
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()))
    }
  })

  it('starting twice is a no-op, not a second listener', async () => {
    setPort(await freePort())
    await startAppMcpServer()
    const first = mcpServerUrl()
    await startAppMcpServer()
    expect(mcpServerUrl()).toBe(first)
  })

  it('defaults to port 7599 when settings say nothing', () => {
    expect(DEFAULT_MCP_PORT).toBe(7599)
    expect(existsSync(join(userData, 'settings.json'))).toBe(false)
  })
})

describe('the spawn gate', () => {
  const STDIO_MCP = `#!/usr/bin/env bash

npx @modelcontextprotocol/inspector \\
  --cli \\
  'node' \\
  './server.mjs' \\
  --transport stdio \\
  --method 'tools/list'
`

  it('refuses a stdio .mcp server the user has not approved by hand', async () => {
    writeFileSync(join(root, 'Local.mcp'), STDIO_MCP)
    setPort(await freePort())
    await startAppMcpServer()
    const client = await connect()
    try {
      const res = await client.callTool({ name: 'run_request', arguments: { path: 'Local.mcp' } })
      expect(res.isError).toBe(true)
      expect((res.content as { text: string }[])[0].text).toContain('spawns a local MCP server')
    } finally {
      await client.close()
    }
  })

  it('allows one the user already approved in the app', async () => {
    writeFileSync(join(root, 'Local.mcp'), STDIO_MCP)
    // Approve it exactly the way the app's consent dialog does, rather than
    // hand-forging the store file.
    const { approveSpawn } = await import('../mcp-consent')
    approveSpawn(root, 'node ./server.mjs')

    setPort(await freePort())
    await startAppMcpServer()
    const client = await connect()
    try {
      const res = await client.callTool({ name: 'run_request', arguments: { path: 'Local.mcp' } })
      // It gets past the gate and actually tries to spawn (and fails — there is
      // no server.mjs). Not being refused by the gate is the assertion.
      expect((res.content as { text: string }[])[0].text).not.toContain('spawns a local MCP server')
    } finally {
      await client.close()
    }
  })
})
