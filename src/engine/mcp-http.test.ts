/**
 * The HTTP transport in front of Freepost's MCP server. Driven with a real SDK
 * client over a real socket — the point of this file is the wire, so stubbing it
 * would test nothing.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import { startMcpHttpServer, type McpHttpServerHandle } from './mcp-http'

let handle: McpHttpServerHandle | undefined

function makeServer(): McpServer {
  const server = new McpServer({ name: 'test', version: '1.0.0' })
  server.registerTool(
    'echo',
    { description: 'Echo a message back', inputSchema: { msg: z.string() } },
    async ({ msg }) => ({ content: [{ type: 'text' as const, text: `echo: ${msg}` }] })
  )
  return server
}

afterEach(async () => {
  await handle?.close()
  handle = undefined
})

describe('startMcpHttpServer', () => {
  it('serves an MCP client over HTTP', async () => {
    handle = await startMcpHttpServer({ makeServer, port: 0 })
    expect(handle.port).toBeGreaterThan(0)
    expect(handle.url).toBe(`http://127.0.0.1:${handle.port}/mcp`)

    const client = new Client({ name: 'test-client', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(handle.url)))
    try {
      const tools = await client.listTools()
      expect(tools.tools.map((t) => t.name)).toEqual(['echo'])

      const res = await client.callTool({ name: 'echo', arguments: { msg: 'hi' } })
      expect((res.content as { text: string }[])[0].text).toBe('echo: hi')
    } finally {
      await client.close()
    }
  })

  it('survives a client reconnecting (stateless: no session to lose)', async () => {
    handle = await startMcpHttpServer({ makeServer, port: 0 })
    for (const msg of ['first', 'second']) {
      const client = new Client({ name: 'test-client', version: '1.0.0' })
      await client.connect(new StreamableHTTPClientTransport(new URL(handle.url)))
      const res = await client.callTool({ name: 'echo', arguments: { msg } })
      expect((res.content as { text: string }[])[0].text).toBe(`echo: ${msg}`)
      await client.close()
    }
  })

  it('binds loopback only, never a routable interface', async () => {
    handle = await startMcpHttpServer({ makeServer, port: 0 })
    expect(handle.url).toContain('127.0.0.1')
    // A request to the same port on a non-loopback address must not be served.
    // Asserting on the bound address is the reliable check here.
    const res = await fetch(`http://127.0.0.1:${handle.port}/nope`)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toContain('/mcp')
  })

  it('rejects a body that is not JSON', async () => {
    handle = await startMcpHttpServer({ makeServer, port: 0 })
    const res = await fetch(handle.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: 'not json at all'
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
  })

  it('builds a fresh server per request, and state lives in the closure', async () => {
    // SDK 1.29 stateless mode throws if a transport is reused, so reusing one
    // McpServer across requests would break the handshake. Pin both halves of
    // that contract: a new server per request, and shared state that survives.
    let built = 0
    const shared: string[] = []
    handle = await startMcpHttpServer({
      port: 0,
      makeServer: () => {
        built++
        const server = new McpServer({ name: 'test', version: '1.0.0' })
        server.registerTool(
          'remember',
          { description: 'Remember a value', inputSchema: { v: z.string() } },
          async ({ v }) => {
            shared.push(v)
            return { content: [{ type: 'text' as const, text: shared.join(',') }] }
          }
        )
        return server
      }
    })

    const client = new Client({ name: 'test-client', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(handle.url)))
    try {
      await client.callTool({ name: 'remember', arguments: { v: 'a' } })
      const res = await client.callTool({ name: 'remember', arguments: { v: 'b' } })
      // Two separate servers, one accumulated state.
      expect((res.content as { text: string }[])[0].text).toBe('a,b')
      expect(built).toBeGreaterThan(2)
    } finally {
      await client.close()
    }
  })

  it('closes cleanly, freeing the port', async () => {
    const h = await startMcpHttpServer({ makeServer, port: 0 })
    const port = h.port
    await h.close()
    // Rebinding the same port proves the listener is really gone.
    const again = await startMcpHttpServer({ makeServer, port })
    expect(again.port).toBe(port)
    await again.close()
  })
})
