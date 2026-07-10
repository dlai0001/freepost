/**
 * Mock HTTP server: replays a collection's saved response examples. Part of
 * src/engine — the only place allowed to open a socket. Unlike the rest of the
 * engine this opens a *listening* socket, but only one the user explicitly
 * starts, and it is bound to loopback by default. Routing/selection logic is
 * pure and lives in src/core/mock/router.ts; this file is just the listener.
 */
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import type { MockRequestLogEntry } from '../shared/model'
import type { MockRoute } from '../core/mock/router'
import { matchRoute, pickExample } from '../core/mock/router'

export type MockState = 'idle' | 'listening' | 'stopped'

export interface MockStartArgs {
  routes: MockRoute[]
  /** 0 (default) picks an ephemeral port. */
  port?: number
  /** Defaults to 127.0.0.1 — never bind 0.0.0.0 implicitly. */
  host?: string
}

export interface MockServerEvents {
  request: (entry: MockRequestLogEntry) => void
  error: (err: Error) => void
}

/** Response headers we regenerate rather than copy from the saved example. */
const SKIP_HEADERS = new Set([
  'content-length',
  'transfer-encoding',
  'content-encoding',
  'connection',
  'keep-alive'
])

/** Human-readable route pattern, e.g. `GET /users/:id`. */
function routePattern(r: MockRoute): string {
  const p = r.segments.map((s) => ('literal' in s ? s.literal : `:${s.param}`)).join('/')
  return `${r.method} /${p}`
}

export class MockServer {
  private server?: Server
  private readonly sockets = new Set<Socket>()
  private routes: MockRoute[] = []
  private _state: MockState = 'idle'
  private _port?: number
  private readonly listeners: { [E in keyof MockServerEvents]: MockServerEvents[E][] } = {
    request: [],
    error: []
  }

  get state(): MockState {
    return this._state
  }
  get port(): number | undefined {
    return this._port
  }

  on<E extends keyof MockServerEvents>(event: E, cb: MockServerEvents[E]): this {
    this.listeners[event].push(cb)
    return this
  }

  private emit<E extends keyof MockServerEvents>(
    event: E,
    ...args: Parameters<MockServerEvents[E]>
  ): void {
    for (const cb of this.listeners[event]) {
      ;(cb as (...a: Parameters<MockServerEvents[E]>) => void)(...args)
    }
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const method = req.method ?? 'GET'
    const url = new URL(req.url ?? '/', 'http://localhost')
    const match = matchRoute(this.routes, method, url.pathname)
    const at = new Date().toISOString()

    if (match === null) {
      const body = JSON.stringify(
        {
          error: 'no matching mock route',
          method,
          path: url.pathname,
          availableRoutes: this.routes.map(routePattern)
        },
        null,
        2
      )
      res.statusCode = 404
      res.setHeader('Content-Type', 'application/json')
      res.end(body)
      this.emit('request', { method, path: url.pathname, status: 404, matched: false, at })
      return
    }

    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k.toLowerCase()] = v
    }
    const example = pickExample(match.route, { headers, query: url.searchParams })
    if (example === undefined) {
      res.statusCode = 404
      res.end('no example')
      this.emit('request', {
        method,
        path: url.pathname,
        status: 404,
        matched: false,
        sourcePath: match.route.sourcePath,
        at
      })
      return
    }

    res.statusCode = example.response.status
    for (const h of example.response.headers) {
      if (!SKIP_HEADERS.has(h.name.toLowerCase())) {
        try {
          res.setHeader(h.name, h.value)
        } catch {
          /* skip an invalid saved header name/value */
        }
      }
    }
    res.end(example.response.bodyText)
    this.emit('request', {
      method,
      path: url.pathname,
      status: example.response.status,
      matched: true,
      exampleName: example.name,
      sourcePath: match.route.sourcePath,
      at
    })
  }

  /** Start listening. Rejects if the (pinned) port can't be bound. */
  async start(args: MockStartArgs): Promise<{ port: number }> {
    if (this._state === 'listening') throw new Error('Mock server is already running')
    this.routes = args.routes
    const host = args.host ?? '127.0.0.1'
    const server = createServer((req, res) => this.handle(req, res))
    this.server = server
    server.on('connection', (sock: Socket) => {
      this.sockets.add(sock)
      sock.on('close', () => this.sockets.delete(sock))
    })

    const port = await new Promise<number>((resolve, reject) => {
      const onError = (e: Error): void => reject(e)
      server.once('error', onError)
      server.listen(args.port ?? 0, host, () => {
        server.removeListener('error', onError)
        resolve((server.address() as AddressInfo).port)
      })
    })

    server.on('error', (e) => this.emit('error', e))
    this._port = port
    this._state = 'listening'
    return { port }
  }

  /** Stop listening, force-closing any lingering keep-alive sockets. */
  async stop(): Promise<void> {
    const server = this.server
    if (server === undefined) {
      this._state = 'stopped'
      return
    }
    await new Promise<void>((resolve) => {
      let done = false
      const finish = (): void => {
        if (!done) {
          done = true
          resolve()
        }
      }
      server.close(() => finish())
      const t = setTimeout(() => {
        for (const s of this.sockets) s.destroy()
      }, 500)
      if (typeof t.unref === 'function') t.unref()
    })
    this.sockets.clear()
    this.server = undefined
    this._port = undefined
    this._state = 'stopped'
  }
}
