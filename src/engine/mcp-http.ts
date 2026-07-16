/**
 * Local HTTP listener for Freepost's own MCP server (Streamable HTTP transport).
 *
 * The CLI serves MCP over stdio, which needs no socket. The desktop app can't:
 * an AI app that wants to talk to the *running* app has to reach it over a URL.
 * That makes this an inbound listener, so — like the mock server — it lives in
 * the engine, the only module allowed to open a socket (PLAN.md "Network
 * policy").
 *
 * Bound to 127.0.0.1 only. It is off by default and the user turns it on from
 * the Tools menu, which is the authorisation; there is no token, so anything
 * already running as the user on this machine can reach it while it is on.
 *
 * STATELESS, AND THAT MEANS PER-REQUEST: SDK 1.29 throws "Stateless transport
 * cannot be reused across requests" if you hand it a second one, so this takes a
 * FACTORY and builds a fresh McpServer + transport for every HTTP request. That
 * is why `makeServer` exists instead of a `server` argument. Any state that must
 * survive across calls (Freepost's pm.* session tier) belongs in the context the
 * factory closes over, never on the server object.
 *
 * The tradeoff of stateless: the server cannot call back into the client
 * (sampling/elicitation), because a fresh server per POST never sees the
 * initialize handshake. Freepost's tools are all request/response, so there is
 * nothing to lose — and in exchange there is no session table to leak or expire,
 * and a client that reconnects just works.
 */
import { createServer, type Server } from 'http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export interface McpHttpServerHandle {
  /** The port actually bound (resolves 0 to the ephemeral port the OS picked). */
  port: number
  /** The URL to put in an AI app's MCP config. */
  url: string
  close: () => Promise<void>
}

export interface McpHttpStartArgs {
  /**
   * Builds a server for ONE request, with its tools already registered.
   * Called per HTTP request — see the stateless note above.
   */
  makeServer: () => McpServer
  /** Port to bind; 0 picks an ephemeral one. */
  port: number
  /** Path the transport answers on. Defaults to /mcp. */
  path?: string
}

export async function startMcpHttpServer(args: McpHttpStartArgs): Promise<McpHttpServerHandle> {
  const path = args.path ?? '/mcp'

  const http: Server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0]
    if (url !== path) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: `Not found. The MCP endpoint is ${path}.` }))
      return
    }
    void (async () => {
      const server = args.makeServer()
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      // Tear down with the response — an SSE response stays open until the
      // client goes away, so 'close' (not the handleRequest return) is when this
      // request's server is actually done.
      res.on('close', () => {
        void transport.close()
        void server.close()
      })
      await server.connect(transport)
      // The body is deliberately NOT pre-read: the transport rebuilds a web
      // Request from the raw stream, so consuming it here would leave it empty.
      await transport.handleRequest(req, res)
    })().catch((e: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }))
      } else {
        res.end()
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    // 127.0.0.1, never 0.0.0.0: this must not be reachable from the network.
    http.listen(args.port, '127.0.0.1', () => {
      http.removeListener('error', reject)
      resolve()
    })
  })

  const addr = http.address()
  const port = typeof addr === 'object' && addr !== null ? addr.port : args.port

  return {
    port,
    url: `http://127.0.0.1:${port}${path}`,
    close: () => new Promise<void>((resolve) => http.close(() => resolve()))
  }
}
