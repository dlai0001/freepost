import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as h2Connect, createServer as createH2Server } from 'node:http2'
import { connect as netConnect } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import WebSocket, { WebSocketServer } from 'ws'
import type { RecordedExchange } from '../shared/model'
import { PROXY_BODY_CAP, RecordProxyServer, WS_FRAME_CAP, WS_PREVIEW_CAP } from './record-proxy'

const servers: RecordProxyServer[] = []
const targets: Server[] = []
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()))
  await Promise.all(
    targets.splice(0).map((t) => new Promise<void>((r) => t.close(() => r())))
  )
  for (const c of cleanups.splice(0)) await c()
})

function track(s: RecordProxyServer): RecordProxyServer {
  servers.push(s)
  return s
}

/** Start an in-test upstream target; returns its origin URL. */
async function startTarget(
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void
): Promise<string> {
  const t = createServer(handler)
  targets.push(t)
  await new Promise<void>((r) => t.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(t.address() as AddressInfo).port}`
}

/** Start a proxy against `target`, collecting its exchanges. */
async function startProxy(target: string): Promise<{ base: string; exchanges: RecordedExchange[] }> {
  const proxy = track(new RecordProxyServer())
  const exchanges: RecordedExchange[] = []
  proxy.on('exchange', (e) => exchanges.push(e))
  const { port } = await proxy.start({ target })
  return { base: `http://127.0.0.1:${port}`, exchanges }
}

describe('RecordProxyServer pass-through', () => {
  it('forwards method, path, status, headers and body faithfully', async () => {
    const target = await startTarget((req, res) => {
      res.writeHead(201, { 'content-type': 'application/json', 'x-fixture': 'yes' })
      res.end(JSON.stringify({ path: req.url, method: req.method }))
    })
    const { base } = await startProxy(target)

    const res = await fetch(`${base}/users?limit=2`, { method: 'POST' })
    expect(res.status).toBe(201)
    expect(res.headers.get('x-fixture')).toBe('yes')
    expect(await res.json()).toEqual({ path: '/users?limit=2', method: 'POST' })
  })

  it('rewrites the host header and strips hop-by-hop headers on the way up', async () => {
    const target = await startTarget((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(req.headers))
    })
    const { base } = await startProxy(target)

    const res = await fetch(`${base}/echo`, {
      headers: { 'x-keep': 'kept', 'proxy-connection': 'keep-alive' }
    })
    const seen = (await res.json()) as Record<string, string>
    expect(seen['host']).toBe(new URL(target).host) // not the proxy's host
    expect(seen['x-keep']).toBe('kept')
    expect(seen['proxy-connection']).toBeUndefined()
  })

  it('streams a chunked response through unchanged', async () => {
    const target = await startTarget((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }) // no content-length -> chunked
      res.write('part-one/')
      setTimeout(() => res.end('part-two'), 20)
    })
    const { base, exchanges } = await startProxy(target)

    const res = await fetch(`${base}/chunks`)
    expect(await res.text()).toBe('part-one/part-two')
    await vi.waitFor(() => expect(exchanges).toHaveLength(1))
    expect(exchanges[0].responseBody?.text).toBe('part-one/part-two')
  })

  it('delivers SSE events before the stream ends', async () => {
    let endStream: () => void = () => {}
    const target = await startTarget((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: one\n\n')
      endStream = () => res.end('data: two\n\n')
    })
    const { base, exchanges } = await startProxy(target)

    const res = await fetch(`${base}/events`)
    const reader = res.body!.getReader()
    // The first event arrives while the upstream response is still open.
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain('data: one')
    endStream()
    let rest = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      rest += new TextDecoder().decode(value)
    }
    expect(rest).toContain('data: two')
    await vi.waitFor(() => expect(exchanges).toHaveLength(1))
    expect(exchanges[0].protocol).toBe('sse')
  })
})

describe('RecordProxyServer target base path', () => {
  it('prefixes the target path on HTTP/1.1 forwards and in the recorded url', async () => {
    const target = await startTarget((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ path: req.url }))
    })
    const { base, exchanges } = await startProxy(`${target}/api/v1/`)

    const res = await fetch(`${base}/users?limit=2`)
    expect(await res.json()).toEqual({ path: '/api/v1/users?limit=2' })
    await vi.waitFor(() => expect(exchanges).toHaveLength(1))
    expect(exchanges[0].url).toBe(`${target}/api/v1/users?limit=2`)
  })

  it('prefixes the target path in :path on the h2c branch', async () => {
    const h2Target = createH2Server()
    h2Target.on('stream', (stream: import('node:http2').ServerHttp2Stream, headers: import('node:http2').IncomingHttpHeaders) => {
      stream.respond({ ':status': 200, 'content-type': 'application/json' })
      stream.end(JSON.stringify({ path: headers[':path'] }))
    })
    await new Promise<void>((r) => h2Target.listen(0, '127.0.0.1', r))
    cleanups.push(() => new Promise<void>((r) => h2Target.close(() => r())))
    const target = `http://127.0.0.1:${(h2Target.address() as AddressInfo).port}`

    const { base, exchanges } = await startProxy(`${target}/api`)
    const session = h2Connect(base)
    cleanups.push(() => session.destroy())
    const reply = await new Promise<string>((resolve, reject) => {
      const req = session.request({ ':method': 'GET', ':path': '/things' })
      let buf = ''
      req.on('data', (c) => (buf += c))
      req.on('end', () => resolve(buf))
      req.on('error', reject)
      req.end()
    })
    expect(JSON.parse(reply)).toEqual({ path: '/api/things' })
    await vi.waitFor(() => expect(exchanges).toHaveLength(1))
    expect(exchanges[0].url).toBe(`${target}/api/things`)
  })

  it('prefixes the target path on WebSocket upgrades', async () => {
    const paths: string[] = []
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    wss.on('connection', (socket, req) => {
      paths.push(req.url ?? '')
      socket.close(1000)
    })
    await new Promise<void>((r) => wss.on('listening', r))
    cleanups.push(() => new Promise<void>((r) => wss.close(() => r())))
    const target = `http://127.0.0.1:${(wss.address() as AddressInfo).port}`

    const { base, exchanges } = await startProxy(`${target}/socket`)
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/live?room=1`)
    await once(ws, 'open')
    await once(ws, 'close')
    expect(paths).toEqual(['/socket/live?room=1'])
    await vi.waitFor(() => expect(exchanges).toHaveLength(1))
    expect(exchanges[0].url).toBe(`${target.replace('http:', 'ws:')}/socket/live?room=1`)
  })
})

describe('RecordProxyServer recording', () => {
  it('emits one exchange with request/response detail and timing', async () => {
    const target = await startTarget((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ got: body }))
      })
    })
    const { base, exchanges } = await startProxy(target)

    await fetch(`${base}/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"Ada"}'
    })
    await vi.waitFor(() => expect(exchanges).toHaveLength(1))
    const e = exchanges[0]
    expect(e.protocol).toBe('rest')
    expect(e.method).toBe('POST')
    expect(e.url).toBe(`${target}/users`)
    expect(e.status).toBe(200)
    expect(e.errored).toBe(false)
    expect(e.timeMs).toBeGreaterThanOrEqual(0)
    expect(e.requestBody?.text).toBe('{"name":"Ada"}')
    expect(e.responseBody?.text).toBe(JSON.stringify({ got: '{"name":"Ada"}' }))
    expect(e.requestHeaders.some((h) => h.name === 'content-type')).toBe(true)
    expect(e.responseHeaders?.some((h) => h.name === 'content-type')).toBe(true)
  })

  it('classifies a GraphQL POST and captures the operation', async () => {
    const target = await startTarget((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end('{"data":{}}')
    })
    const { base, exchanges } = await startProxy(target)

    await fetch(`${base}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'query GetUsers { users { id } }' })
    })
    await vi.waitFor(() => expect(exchanges).toHaveLength(1))
    expect(exchanges[0].protocol).toBe('graphql')
    expect(exchanges[0].graphql).toEqual({ operationName: 'GetUsers', operationType: 'query' })
  })

  it('caps body previews at 64 KiB but keeps the true byte count', async () => {
    const big = 'a'.repeat(PROXY_BODY_CAP + 5000)
    const target = await startTarget((_req, res) => res.end(big))
    const { base, exchanges } = await startProxy(target)

    const res = await fetch(`${base}/big`)
    expect((await res.text()).length).toBe(big.length) // pass-through NOT capped
    await vi.waitFor(() => expect(exchanges).toHaveLength(1))
    const body = exchanges[0].responseBody
    expect(body?.truncated).toBe(true)
    expect(body?.bytes).toBe(big.length)
    expect(body?.text.length).toBe(PROXY_BODY_CAP)
  })

  it('decompresses a gzip response for the preview', async () => {
    const target = await startTarget((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
      res.end(gzipSync('{"zipped":true}'))
    })
    const { base, exchanges } = await startProxy(target)

    await fetch(`${base}/zipped`)
    await vi.waitFor(() => expect(exchanges).toHaveLength(1))
    expect(exchanges[0].responseBody?.text).toBe('{"zipped":true}')
  })

  it('marks a 4xx/5xx response errored (like run history)', async () => {
    const target = await startTarget((_req, res) => {
      res.statusCode = 404
      res.end('nope')
    })
    const { base, exchanges } = await startProxy(target)
    await fetch(`${base}/missing`)
    await vi.waitFor(() => expect(exchanges).toHaveLength(1))
    expect(exchanges[0].status).toBe(404)
    expect(exchanges[0].errored).toBe(true)
  })

  it('answers 502 and records an errored exchange when the upstream is down', async () => {
    // Port 1 is never listening.
    const { base, exchanges } = await startProxy('http://127.0.0.1:1')
    const res = await fetch(`${base}/x`)
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toBe('upstream request failed')
    await vi.waitFor(() => expect(exchanges).toHaveLength(1))
    expect(exchanges[0].errored).toBe(true)
    expect(exchanges[0].error).toBeDefined()
    expect(exchanges[0].status).toBeUndefined()
  })
})

describe('RecordProxyServer lifecycle', () => {
  it('rejects a target that is not an http(s) URL', async () => {
    const proxy = track(new RecordProxyServer())
    await expect(proxy.start({ target: 'not a url' })).rejects.toThrow(/Invalid target URL/)
    await expect(proxy.start({ target: 'ftp://x' })).rejects.toThrow(/http:\/\/ or https:\/\//)
  })

  it('rejects with EADDRINUSE when the port is taken', async () => {
    const squatter = createServer()
    targets.push(squatter)
    await new Promise<void>((r) => squatter.listen(0, '127.0.0.1', r))
    const port = (squatter.address() as AddressInfo).port

    const proxy = track(new RecordProxyServer())
    await expect(proxy.start({ target: 'http://127.0.0.1:1', port })).rejects.toThrow(/EADDRINUSE/)
  })

  it('stop() force-closes sockets and releases the port', async () => {
    const target = await startTarget((_req, res) => res.end('ok'))
    const proxy = new RecordProxyServer()
    const { port } = await proxy.start({ target })
    await fetch(`http://127.0.0.1:${port}/x`) // leaves a keep-alive socket behind
    await proxy.stop()
    expect(proxy.state).toBe('stopped')
    await expect(fetch(`http://127.0.0.1:${port}/x`)).rejects.toThrow()

    // The port is really free again.
    const again = track(new RecordProxyServer())
    await again.start({ target, port })
    expect(again.port).toBe(port)
  })
})

/* ------------------------- gRPC / h2c pass-through ------------------------ */

const GREETER_PROTO = join(__dirname, '..', '..', 'fixtures', 'servers', 'greeter.proto')

/* eslint-disable @typescript-eslint/no-explicit-any */
function loadGreeter(): any {
  const pkgDef = protoLoader.loadSync(GREETER_PROTO, { keepCase: true })
  return (grpc.loadPackageDefinition(pkgDef) as any).helloworld.Greeter
}

/** In-test grpc-js server (mirrors fixtures/servers/grpc.mjs). */
async function startGrpcTarget(): Promise<string> {
  const Greeter = loadGreeter()
  const server = new grpc.Server()
  server.addService(Greeter.service, {
    SayHello: (call: any, cb: any) => {
      if (call.request.name === 'boom') {
        cb({ code: grpc.status.INVALID_ARGUMENT, details: 'no boom allowed' })
        return
      }
      cb(null, { message: `Hello ${call.request.name}` })
    },
    SayHellos: (call: any) => {
      for (let i = 1; i <= 3; i++) call.write({ message: `Hello ${call.request.name} #${i}` })
      call.end()
    }
  })
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) =>
      e !== null ? reject(e) : resolve(p)
    )
  )
  cleanups.push(() => server.forceShutdown())
  return `http://127.0.0.1:${port}`
}

function greeterClient(proxyBase: string): any {
  const Greeter = loadGreeter()
  const client = new Greeter(`127.0.0.1:${new URL(proxyBase).port}`, grpc.credentials.createInsecure())
  cleanups.push(() => client.close())
  return client
}

describe('RecordProxyServer gRPC (h2c sniff)', () => {
  it('forwards a unary call end-to-end and records message counts + grpc-status 0', async () => {
    const target = await startGrpcTarget()
    const { base, exchanges } = await startProxy(target)
    const client = greeterClient(base)

    const reply = await new Promise<{ message: string }>((resolve, reject) =>
      client.SayHello({ name: 'Ada' }, (e: Error | null, r: { message: string }) =>
        e !== null ? reject(e) : resolve(r)
      )
    )
    expect(reply.message).toBe('Hello Ada')

    await vi.waitFor(() => expect(exchanges).toHaveLength(1))
    const e = exchanges[0]
    expect(e.protocol).toBe('grpc')
    expect(e.method).toBe('POST')
    expect(e.url).toBe(`${target}/helloworld.Greeter/SayHello`)
    expect(e.status).toBe(200)
    expect(e.errored).toBe(false)
    expect(e.grpc).toEqual({
      service: 'helloworld.Greeter',
      method: 'SayHello',
      grpcStatus: 0,
      requestMessages: 1,
      responseMessages: 1
    })
    // Tier-1: undecoded protobuf bodies are not recorded.
    expect(e.requestBody).toBeUndefined()
    expect(e.responseBody).toBeUndefined()
  })

  it('forwards a server-streaming call and counts every response message', async () => {
    const target = await startGrpcTarget()
    const { base, exchanges } = await startProxy(target)
    const client = greeterClient(base)

    const messages = await new Promise<string[]>((resolve, reject) => {
      const got: string[] = []
      const call = client.SayHellos({ name: 'Grace' })
      call.on('data', (m: { message: string }) => got.push(m.message))
      call.on('end', () => resolve(got))
      call.on('error', reject)
    })
    expect(messages).toEqual(['Hello Grace #1', 'Hello Grace #2', 'Hello Grace #3'])

    await vi.waitFor(() => expect(exchanges).toHaveLength(1))
    expect(exchanges[0].grpc).toMatchObject({
      method: 'SayHellos',
      grpcStatus: 0,
      requestMessages: 1,
      responseMessages: 3
    })
  })

  it('relays a non-OK grpc-status through the trailers and marks the exchange errored', async () => {
    const target = await startGrpcTarget()
    const { base, exchanges } = await startProxy(target)
    const client = greeterClient(base)

    const err = await new Promise<grpc.ServiceError>((resolve, reject) =>
      client.SayHello({ name: 'boom' }, (e: grpc.ServiceError | null) =>
        e !== null ? resolve(e) : reject(new Error('expected an error'))
      )
    )
    expect(err.code).toBe(grpc.status.INVALID_ARGUMENT)
    expect(err.details).toBe('no boom allowed')

    await vi.waitFor(() => expect(exchanges).toHaveLength(1))
    expect(exchanges[0].errored).toBe(true)
    expect(exchanges[0].grpc?.grpcStatus).toBe(grpc.status.INVALID_ARGUMENT)
  })

  it('forwards non-gRPC h2c (prior-knowledge HTTP/2) traffic and classifies it normally', async () => {
    const h2Target = createH2Server()
    h2Target.on('stream', (stream: import('node:http2').ServerHttp2Stream, headers: import('node:http2').IncomingHttpHeaders) => {
      let body = ''
      stream.on('data', (c) => (body += c))
      stream.on('end', () => {
        stream.respond({ ':status': 200, 'content-type': 'application/json' })
        stream.end(JSON.stringify({ path: headers[':path'], got: body }))
      })
    })
    await new Promise<void>((r) => h2Target.listen(0, '127.0.0.1', r))
    cleanups.push(() => new Promise<void>((r) => h2Target.close(() => r())))
    const target = `http://127.0.0.1:${(h2Target.address() as AddressInfo).port}`

    const { base, exchanges } = await startProxy(target)
    const session = h2Connect(base)
    cleanups.push(() => session.destroy())
    const reply = await new Promise<string>((resolve, reject) => {
      const req = session.request({ ':method': 'POST', ':path': '/things', 'content-type': 'application/json' })
      req.end('{"a":1}')
      let buf = ''
      req.on('data', (c) => (buf += c))
      req.on('end', () => resolve(buf))
      req.on('error', reject)
    })
    expect(JSON.parse(reply)).toEqual({ path: '/things', got: '{"a":1}' })

    await vi.waitFor(() => expect(exchanges).toHaveLength(1))
    const e = exchanges[0]
    expect(e.protocol).toBe('rest')
    expect(e.grpc).toBeUndefined()
    expect(e.requestBody?.text).toBe('{"a":1}')
    expect(e.status).toBe(200)
  })

  it('relays a multi-MB h2 response intact to a client that starts reading late', async () => {
    // Backpressure guard: the relay pipes (pausing the upstream when the
    // client stream is full) instead of buffering unboundedly. The assertion
    // is fidelity + completion with a paused reader in the middle.
    const big = Buffer.alloc(4 * 1024 * 1024, 0x61)
    const h2Target = createH2Server()
    h2Target.on('stream', (stream: import('node:http2').ServerHttp2Stream) => {
      stream.respond({ ':status': 200, 'content-type': 'application/octet-stream' })
      stream.end(big)
    })
    await new Promise<void>((r) => h2Target.listen(0, '127.0.0.1', r))
    cleanups.push(() => new Promise<void>((r) => h2Target.close(() => r())))
    const target = `http://127.0.0.1:${(h2Target.address() as AddressInfo).port}`

    const { base } = await startProxy(target)
    const session = h2Connect(base)
    cleanups.push(() => session.destroy())
    const total = await new Promise<number>((resolve, reject) => {
      const req = session.request({ ':method': 'GET', ':path': '/big' })
      req.pause() // reader stalls while the target keeps sending…
      setTimeout(() => req.resume(), 150) // …then drains everything
      let n = 0
      req.on('data', (c: Buffer) => (n += c.length))
      req.on('end', () => resolve(n))
      req.on('error', reject)
      req.end()
    })
    expect(total).toBe(big.length)
  })

  it('sniffs the protocol even when the client dribbles the first bytes', async () => {
    const target = await startTarget((_req, res) => res.end('h1-ok'))
    const { base, exchanges } = await startProxy(target)
    const port = Number(new URL(base).port)

    // HTTP/1.1, one byte at a time: "G" alone must not misroute to h1|h2.
    const h1Reply = await new Promise<string>((resolve, reject) => {
      const sock = netConnect(port, '127.0.0.1', () => {
        sock.write('G')
        setTimeout(() => sock.write('ET /drip HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n'), 30)
      })
      let buf = ''
      sock.on('data', (c) => (buf += c))
      sock.on('end', () => resolve(buf))
      sock.on('error', reject)
    })
    expect(h1Reply).toContain('h1-ok')
    await vi.waitFor(() => expect(exchanges).toHaveLength(1))

    // HTTP/2 preface split inside the 3-byte sniff window ("PR" + rest): the
    // h2 server must still take the connection and answer with SETTINGS.
    const h2First = await new Promise<Buffer>((resolve, reject) => {
      const sock = netConnect(port, '127.0.0.1', () => {
        sock.write('PR')
        setTimeout(() => {
          sock.write('I * HTTP/2.0\r\n\r\nSM\r\n\r\n')
          sock.write(Buffer.from([0, 0, 0, 4, 0, 0, 0, 0, 0])) // empty SETTINGS
        }, 30)
      })
      sock.once('data', (c: Buffer) => {
        sock.destroy()
        resolve(c)
      })
      sock.on('error', reject)
    })
    expect(h2First[3]).toBe(4) // frame type SETTINGS — the h2 branch answered
  })
})

/* ----------------------------- WebSocket relay ---------------------------- */

/** In-test ws target: echoes messages, records what it saw. */
async function startWsTarget(opts?: {
  verifyClient?: (info: unknown, cb: (ok: boolean, code?: number, message?: string) => void) => void
}): Promise<{ url: string; received: { text: string; binary: boolean }[] }> {
  const received: { text: string; binary: boolean }[] = []
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', ...(opts ?? {}) })
  wss.on('connection', (socket) => {
    socket.on('message', (data, isBinary) => {
      received.push({ text: Buffer.isBuffer(data) ? data.toString('base64') : '', binary: isBinary })
      socket.send(data, { binary: isBinary })
    })
  })
  await new Promise<void>((r) => wss.on('listening', r))
  cleanups.push(() => new Promise<void>((r) => wss.close(() => r())))
  return { url: `http://127.0.0.1:${(wss.address() as AddressInfo).port}`, received }
}

/** Await one event from a ws socket. */
function once<T>(ws: WebSocket, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    ws.once(event, (...args: unknown[]) => resolve(args as T))
    if (event !== 'error') ws.once('error', reject)
  })
}

describe('RecordProxyServer WebSocket relay', () => {
  it('relays text and binary frames both ways and records one session exchange', async () => {
    const { url: target, received } = await startWsTarget()
    const { base, exchanges } = await startProxy(target)

    const ws = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/live?room=1`, ['chat', 'other'])
    await once(ws, 'open')
    // The target's default handleProtocols picks the first offer; the proxy
    // must echo the negotiated subprotocol back to the client.
    expect(ws.protocol).toBe('chat')

    ws.send('hello')
    const [echo1, bin1] = await once<[Buffer, boolean]>(ws, 'message')
    expect(echo1.toString()).toBe('hello')
    expect(bin1).toBe(false)

    ws.send(Buffer.from([1, 2, 0, 3]))
    const [echo2, bin2] = await once<[Buffer, boolean]>(ws, 'message')
    expect([...echo2]).toEqual([1, 2, 0, 3])
    expect(bin2).toBe(true)

    // The target saw both frames with the binary flag preserved.
    expect(received).toEqual([
      { text: Buffer.from('hello').toString('base64'), binary: false },
      { text: Buffer.from([1, 2, 0, 3]).toString('base64'), binary: true }
    ])

    ws.close(4001, 'done')
    await once(ws, 'close')
    await vi.waitFor(() => expect(exchanges).toHaveLength(1))
    const e = exchanges[0]
    expect(e.protocol).toBe('ws')
    expect(e.method).toBe('WS')
    expect(e.url).toBe(`${target.replace('http:', 'ws:')}/live?room=1`)
    expect(e.status).toBe(101)
    expect(e.errored).toBe(false)
    expect(e.ws?.closeCode).toBe(4001)
    expect(e.responseHeaders).toEqual([{ name: 'sec-websocket-protocol', value: 'chat' }])
    // 2 sent + 2 echoed frames, direction + binary flag captured.
    expect(e.ws?.frames.map((f) => ({ dir: f.dir, text: f.text, preview: f.preview }))).toEqual([
      { dir: 'out', text: true, preview: 'hello' },
      { dir: 'in', text: true, preview: 'hello' },
      { dir: 'out', text: false, preview: Buffer.from([1, 2, 0, 3]).toString('base64') },
      { dir: 'in', text: false, preview: Buffer.from([1, 2, 0, 3]).toString('base64') }
    ])
  })

  it('caps captured frames at 200 and previews at 2 KiB without breaking the relay', async () => {
    const { url: target } = await startWsTarget()
    const { base, exchanges } = await startProxy(target)

    const ws = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/`)
    await once(ws, 'open')
    const big = 'x'.repeat(WS_PREVIEW_CAP + 100)
    let echoed = 0
    ws.on('message', () => echoed++)
    // 110 sends -> 220 captured frames wanted, capped at 200; all still relayed.
    for (let i = 0; i < 109; i++) ws.send(`m${i}`)
    ws.send(big)
    await vi.waitFor(() => expect(echoed).toBe(110))
    ws.close(1000)
    await once(ws, 'close')

    await vi.waitFor(() => expect(exchanges).toHaveLength(1))
    const frames = exchanges[0].ws?.frames ?? []
    expect(frames).toHaveLength(WS_FRAME_CAP)
    const bigFrame = frames.find((f) => f.truncated)
    expect(bigFrame?.preview.length).toBe(WS_PREVIEW_CAP)
  })

  it('surfaces a refused upgrade as the target status and an errored exchange', async () => {
    const { url: target } = await startWsTarget({
      verifyClient: (_info, cb) => cb(false, 404, 'Not Found')
    })
    const { base, exchanges } = await startProxy(target)

    const ws = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/nope`)
    const [err] = await once<[Error]>(ws, 'error')
    expect(err.message).toContain('404')

    await vi.waitFor(() => expect(exchanges).toHaveLength(1))
    expect(exchanges[0].protocol).toBe('ws')
    expect(exchanges[0].status).toBe(404)
    expect(exchanges[0].errored).toBe(true)
    expect(exchanges[0].ws?.frames).toEqual([])
  })

  it('records the session errored when the target dies mid-session (1006)', async () => {
    const serverSockets: WebSocket[] = []
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    wss.on('connection', (socket) => serverSockets.push(socket))
    await new Promise<void>((r) => wss.on('listening', r))
    cleanups.push(() => new Promise<void>((r) => wss.close(() => r())))
    const target = `http://127.0.0.1:${(wss.address() as AddressInfo).port}`

    const { base, exchanges } = await startProxy(target)
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/live`)
    await once(ws, 'open')
    await vi.waitFor(() => expect(serverSockets).toHaveLength(1))
    serverSockets[0].terminate() // no close frame — an abnormal closure
    await once(ws, 'close')

    await vi.waitFor(() => expect(exchanges).toHaveLength(1))
    expect(exchanges[0].errored).toBe(true)
    expect(exchanges[0].error).toBeDefined()
    expect(exchanges[0].ws?.closeCode).toBe(1006)
  })

  it('answers 502 when the ws target is unreachable', async () => {
    const { base, exchanges } = await startProxy('http://127.0.0.1:1')
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/x`)
    const [err] = await once<[Error]>(ws, 'error')
    expect(err.message).toContain('502')
    await vi.waitFor(() => expect(exchanges).toHaveLength(1))
    expect(exchanges[0].errored).toBe(true)
  })
})

/* --------------------------- TLS listener (2.5) --------------------------- */

// Real self-signed certs from the production cert module (no sockets in it, so
// importing it here is fence-legal); generated once per test file.
let certsCache: Promise<import('../main/proxy-certs').ProxyCerts> | null = null
function testCerts(): Promise<import('../main/proxy-certs').ProxyCerts> {
  if (certsCache === null) {
    certsCache = (async () => {
      const { ensureProxyCerts } = await import('../main/proxy-certs')
      const dir = mkdtempSync(join(tmpdir(), 'freepost-proxy-tls-'))
      const certs = await ensureProxyCerts(dir)
      // The dir outlives afterEach on purpose (cache); clean at process exit.
      process.once('exit', () => void rm(dir, { recursive: true, force: true }).catch(() => undefined))
      return certs
    })()
  }
  return certsCache
}

/** Start a proxy with both listeners; returns the https base + the CA PEM. */
async function startProxyTls(target: string, tlsPort = 0): Promise<{
  base: string
  tlsBase: string
  tlsPort: number
  ca: string
  exchanges: RecordedExchange[]
  proxy: RecordProxyServer
}> {
  const certs = await testCerts()
  const proxy = track(new RecordProxyServer())
  const exchanges: RecordedExchange[] = []
  proxy.on('exchange', (e) => exchanges.push(e))
  const { port, tlsPort: boundTls } = await proxy.start({
    target,
    tls: { key: certs.keyPem, cert: certs.certPem, port: tlsPort }
  })
  expect(boundTls).toBeDefined()
  expect(proxy.tlsPort).toBe(boundTls)
  return {
    base: `http://127.0.0.1:${port}`,
    tlsBase: `https://127.0.0.1:${boundTls}`,
    tlsPort: boundTls as number,
    ca: certs.caPem,
    exchanges,
    proxy
  }
}

/** node:https GET with a custom CA (fetch/undici has no easy per-call ca). */
function httpsGet(
  url: string,
  ca: string,
  init?: { method?: string; body?: string; headers?: Record<string, string> }
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { ca, method: init?.method ?? 'GET', headers: init?.headers }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(init?.body)
  })
}

describe('RecordProxyServer TLS listener', () => {
  it('serves HTTPS with the leaf a client verifies via the local CA, with full fidelity', async () => {
    const target = await startTarget((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        res.writeHead(201, { 'content-type': 'application/json', 'x-fixture': 'yes' })
        res.end(JSON.stringify({ path: req.url, got: body }))
      })
    })
    const { tlsBase, ca, exchanges } = await startProxyTls(target)

    const res = await httpsGet(`${tlsBase}/users?limit=2`, ca, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"Ada"}'
    })
    expect(res.status).toBe(201)
    expect(res.headers['x-fixture']).toBe('yes')
    expect(JSON.parse(res.body)).toEqual({ path: '/users?limit=2', got: '{"name":"Ada"}' })

    await vi.waitFor(() => expect(exchanges).toHaveLength(1))
    const e = exchanges[0]
    expect(e.via).toBe('https') // captured on the TLS listener
    expect(e.url).toBe(`${target}/users?limit=2`)
    expect(e.status).toBe(201)
    expect(e.requestBody?.text).toBe('{"name":"Ada"}')
    expect(e.responseBody?.text).toContain('"got":"{\\"name\\":\\"Ada\\"}"')
  })

  it('tags plain-listener exchanges via=http while both listeners run', async () => {
    const target = await startTarget((_req, res) => res.end('ok'))
    const { base, exchanges } = await startProxyTls(target)
    await fetch(`${base}/plain`)
    await vi.waitFor(() => expect(exchanges).toHaveLength(1))
    expect(exchanges[0].via).toBe('http')
  })

  it('relays wss:// over the TLS port (allowHTTP1 + upgrade)', async () => {
    const { url: target, received } = await startWsTarget()
    const { tlsPort, ca, exchanges } = await startProxyTls(target)

    // Guards the Node allowHTTP1+upgrade regression (nodejs/node 23468fd):
    // the h1 compat path of the secure server must still emit 'upgrade'.
    const ws = new WebSocket(`wss://127.0.0.1:${tlsPort}/live?room=1`, ['chat'], { ca })
    await once(ws, 'open')
    expect(ws.protocol).toBe('chat')
    ws.send('hello-tls')
    const [echo] = await once<[Buffer, boolean]>(ws, 'message')
    expect(echo.toString()).toBe('hello-tls')
    expect(received).toEqual([{ text: Buffer.from('hello-tls').toString('base64'), binary: false }])

    ws.close(1000)
    await once(ws, 'close')
    await vi.waitFor(() => expect(exchanges).toHaveLength(1))
    const e = exchanges[0]
    expect(e.protocol).toBe('ws')
    expect(e.via).toBe('https')
    expect(e.status).toBe(101)
    expect(e.errored).toBe(false)
    expect(e.ws?.frames.map((f) => f.preview)).toEqual(['hello-tls', 'hello-tls'])
  })

  it('serves gRPC over TLS (credentials.createSsl) against a cleartext target', async () => {
    const target = await startGrpcTarget()
    const { tlsPort, ca, exchanges } = await startProxyTls(target)

    // Client -> proxy is TLS+ALPN h2; proxy -> target stays h2c.
    const Greeter = loadGreeter()
    const client = new Greeter(`localhost:${tlsPort}`, grpc.credentials.createSsl(Buffer.from(ca)))
    cleanups.push(() => client.close())

    const reply = await new Promise<{ message: string }>((resolve, reject) =>
      client.SayHello({ name: 'Tls' }, (e: Error | null, r: { message: string }) =>
        e !== null ? reject(e) : resolve(r)
      )
    )
    expect(reply.message).toBe('Hello Tls')

    await vi.waitFor(() => expect(exchanges).toHaveLength(1))
    const e = exchanges[0]
    expect(e.protocol).toBe('grpc')
    expect(e.via).toBe('https')
    expect(e.grpc).toMatchObject({
      service: 'helloworld.Greeter',
      method: 'SayHello',
      grpcStatus: 0,
      requestMessages: 1,
      responseMessages: 1
    })
  })

  it('rejects with EADDRINUSE on the TLS port and releases the plain port too', async () => {
    const squatter = createServer()
    targets.push(squatter)
    await new Promise<void>((r) => squatter.listen(0, '127.0.0.1', r))
    const tlsPort = (squatter.address() as AddressInfo).port

    const certs = await testCerts()
    const proxy = track(new RecordProxyServer())
    const httpSquat = createServer()
    targets.push(httpSquat)
    await new Promise<void>((r) => httpSquat.listen(0, '127.0.0.1', r))
    const httpPort = (httpSquat.address() as AddressInfo).port
    await new Promise<void>((r) => httpSquat.close(() => r()))
    targets.pop()

    await expect(
      proxy.start({
        target: 'http://127.0.0.1:1',
        port: httpPort,
        tls: { key: certs.keyPem, cert: certs.certPem, port: tlsPort }
      })
    ).rejects.toThrow(/EADDRINUSE/)
    // start() is atomic: the plain port must not be left bound.
    const again = track(new RecordProxyServer())
    await again.start({ target: 'http://127.0.0.1:1', port: httpPort })
    expect(again.port).toBe(httpPort)
  })

  it('stop() closes both listeners', async () => {
    const target = await startTarget((_req, res) => res.end('ok'))
    const certs = await testCerts()
    const proxy = new RecordProxyServer()
    const { port, tlsPort } = await proxy.start({
      target,
      tls: { key: certs.keyPem, cert: certs.certPem, port: 0 }
    })
    await fetch(`http://127.0.0.1:${port}/x`)
    await httpsGet(`https://127.0.0.1:${tlsPort}/x`, certs.caPem)
    await proxy.stop()
    expect(proxy.state).toBe('stopped')
    expect(proxy.tlsPort).toBeUndefined()
    await expect(fetch(`http://127.0.0.1:${port}/x`)).rejects.toThrow()
    await expect(httpsGet(`https://127.0.0.1:${tlsPort}/x`, certs.caPem)).rejects.toThrow()
  })
})
