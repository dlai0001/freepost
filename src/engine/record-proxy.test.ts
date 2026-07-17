import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as h2Connect, constants as h2Constants, createServer as createH2Server } from 'node:http2'
import type {
  ClientHttp2Session,
  IncomingHttpHeaders as H2IncomingHeaders,
  OutgoingHttpHeaders as H2OutgoingHeaders,
  ServerHttp2Stream
} from 'node:http2'
import { connect as netConnect } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import WebSocket, { WebSocketServer } from 'ws'
import type { RecordedExchange, RecordedGrpcMessage } from '../shared/model'
import { decodeProtobuf, formatProtobuf } from '../core/record/protobuf'
import { decodeGrpcMessages } from './grpc'
import {
  GRPC_MESSAGE_CAP,
  PROXY_BODY_CAP,
  RecordProxyServer,
  WS_FRAME_CAP,
  WS_PREVIEW_CAP
} from './record-proxy'

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

/** A captured message's retained payload bytes (fails loudly if it has none). */
function payload(m: RecordedGrpcMessage | undefined): Uint8Array {
  if (m?.base64 === undefined) throw new Error('message payload was not captured')
  return Buffer.from(m.base64, 'base64')
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
    expect(e.grpc).toMatchObject({
      service: 'helloworld.Greeter',
      method: 'SayHello',
      grpcStatus: 0,
      requestMessages: 1,
      responseMessages: 1
    })
    // The framed messages are captured, not the raw h2 DATA as a body preview.
    expect(e.requestBody).toBeUndefined()
    expect(e.responseBody).toBeUndefined()
    expect(e.grpc?.messages).toHaveLength(2)
    expect(e.grpc?.messages?.map((m) => m.dir)).toEqual(['send', 'recv'])
    expect(e.grpc?.messages?.every((m) => !m.truncated)).toBe(true)
    // The captured bytes are the real wire payloads, both tiers over.
    expect(decodeProtobuf(payload(e.grpc?.messages?.[0]))).toEqual({
      fields: [{ field: 1, kind: 'string', text: 'Ada' }]
    })
    expect(decodeProtobuf(payload(e.grpc?.messages?.[1]))).toEqual({
      fields: [{ field: 1, kind: 'string', text: 'Hello Ada' }]
    })
    expect(decodeGrpcMessages({
      fullMethod: 'helloworld.Greeter/SayHello',
      protoFiles: [GREETER_PROTO],
      messages: e.grpc?.messages ?? []
    })).toEqual([
      { json: JSON.stringify({ name: 'Ada' }, null, 2) },
      { json: JSON.stringify({ message: 'Hello Ada' }, null, 2) }
    ])
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
    // Every streamed message is captured separately, in order, request first.
    const captured = exchanges[0].grpc?.messages ?? []
    expect(captured.map((m) => m.dir)).toEqual(['send', 'recv', 'recv', 'recv'])
    expect(captured.map((m) => formatProtobuf(decodeProtobuf(payload(m))))).toEqual([
      '1: "Grace"',
      '1: "Hello Grace #1"',
      '1: "Hello Grace #2"',
      '1: "Hello Grace #3"'
    ])
  })

  it('decodes captured messages to named fields with the .proto attached (tier 2)', async () => {
    const target = await startGrpcTarget()
    const { base, exchanges } = await startProxy(target)
    const client = greeterClient(base)

    await new Promise<string[]>((resolve, reject) => {
      const got: string[] = []
      const call = client.SayHellos({ name: 'Ada' })
      call.on('data', (m: { message: string }) => got.push(m.message))
      call.on('end', () => resolve(got))
      call.on('error', reject)
    })
    await vi.waitFor(() => expect(exchanges).toHaveLength(1))

    const decoded = decodeGrpcMessages({
      fullMethod: 'helloworld.Greeter/SayHellos',
      protoFiles: [GREETER_PROTO],
      messages: exchanges[0].grpc?.messages ?? []
    })
    // 'send' decodes as HelloRequest, 'recv' as HelloReply — the direction
    // picks the message type, which is why it is recorded per message.
    expect(decoded.map((d) => d.json !== undefined ? JSON.parse(d.json) : d.error)).toEqual([
      { name: 'Ada' },
      { message: 'Hello Ada #1' },
      { message: 'Hello Ada #2' },
      { message: 'Hello Ada #3' }
    ])
  })

  it('refuses to decode a message whose payload the cap dropped', () => {
    // A protobuf buffer has no framing of its own, so a truncated capture would
    // deserialize to plausible nonsense — it must be reported, not decoded.
    expect(
      decodeGrpcMessages({
        fullMethod: 'helloworld.Greeter/SayHello',
        protoFiles: [GREETER_PROTO],
        messages: [
          { dir: 'send', bytes: 900_000, truncated: true, base64: 'CgNBZGE=' },
          { dir: 'recv', bytes: 12, truncated: false, base64: 'CgNBZGE=', compressed: true }
        ]
      })
    ).toEqual([
      { error: 'payload not fully captured (900000 bytes on the wire)' },
      { error: 'message is compressed (grpc-encoding) — not decoded' }
    ])
  })

  it('throws when the attached protos do not describe the method', () => {
    expect(() =>
      decodeGrpcMessages({
        fullMethod: 'helloworld.Greeter/Nope',
        protoFiles: [GREETER_PROTO],
        messages: []
      })
    ).toThrow(/method not found/)
  })

  it('caps retained messages per direction but keeps counting them', async () => {
    const Greeter = loadGreeter()
    const server = new grpc.Server()
    server.addService(Greeter.service, {
      SayHello: (_call: any, cb: any) => cb(null, { message: 'hi' }),
      SayHellos: (call: any) => {
        for (let i = 0; i < GRPC_MESSAGE_CAP + 5; i++) call.write({ message: `m${i}` })
        call.end()
      }
    })
    const port = await new Promise<number>((resolve, reject) =>
      server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) =>
        e !== null ? reject(e) : resolve(p)
      )
    )
    cleanups.push(() => server.forceShutdown())
    const { base, exchanges } = await startProxy(`http://127.0.0.1:${port}`)
    const client = greeterClient(base)

    await new Promise<void>((resolve, reject) => {
      const call = client.SayHellos({ name: 'x' })
      call.on('data', () => undefined)
      call.on('end', () => resolve())
      call.on('error', reject)
    })

    await vi.waitFor(() => expect(exchanges).toHaveLength(1))
    expect(exchanges[0].grpc?.responseMessages).toBe(GRPC_MESSAGE_CAP + 5)
    // 1 request message + the response direction's own cap.
    expect(exchanges[0].grpc?.messages).toHaveLength(GRPC_MESSAGE_CAP + 1)
  })

  it('caps retained gRPC bytes per direction and flags the truncated message', async () => {
    const Greeter = loadGreeter()
    const server = new grpc.Server()
    const huge = 'y'.repeat(PROXY_BODY_CAP + 1000)
    server.addService(Greeter.service, {
      SayHello: (_call: any, cb: any) => cb(null, { message: huge }),
      SayHellos: (call: any) => call.end()
    })
    const port = await new Promise<number>((resolve, reject) =>
      server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) =>
        e !== null ? reject(e) : resolve(p)
      )
    )
    cleanups.push(() => server.forceShutdown())
    const { base, exchanges } = await startProxy(`http://127.0.0.1:${port}`)
    const client = greeterClient(base)

    await new Promise<void>((resolve, reject) =>
      client.SayHello({ name: 'Ada' }, (e: Error | null) => (e !== null ? reject(e) : resolve()))
    )
    await vi.waitFor(() => expect(exchanges).toHaveLength(1))

    const recv = exchanges[0].grpc?.messages?.find((m) => m.dir === 'recv')
    expect(recv?.truncated).toBe(true)
    // `bytes` stays the true wire size even though only the cap was retained.
    expect(recv?.bytes).toBeGreaterThan(PROXY_BODY_CAP)
    expect(payload(recv).length).toBe(PROXY_BODY_CAP)
    // The request direction has its own budget and is untouched by the flood.
    const sent = exchanges[0].grpc?.messages?.find((m) => m.dir === 'send')
    expect(sent?.truncated).toBe(false)
    expect(decodeProtobuf(payload(sent))).toEqual({
      fields: [{ field: 1, kind: 'string', text: 'Ada' }]
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

  it('downgrades non-gRPC h2c to HTTP/1.1 for an h1-only target', async () => {
    // The target speaks HTTP/1.1 only (i.e. almost every dev backend), while
    // the client uses prior-knowledge h2. HTTP semantics don't depend on the
    // wire version, so the proxy must downgrade instead of failing the call.
    const target = await startTarget((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        res.writeHead(201, { 'content-type': 'application/json', 'x-fixture': 'yes' })
        res.end(JSON.stringify({ path: req.url, method: req.method, version: req.httpVersion, got: body }))
      })
    })
    const { base, exchanges } = await startProxy(target)

    const session = h2Connect(base)
    cleanups.push(() => session.destroy())
    const { status, headers, body } = await new Promise<{
      status: number
      headers: import('node:http2').IncomingHttpHeaders
      body: string
    }>((resolve, reject) => {
      const req = session.request({ ':method': 'POST', ':path': '/things', 'content-type': 'application/json' })
      req.end('{"a":1}')
      let buf = ''
      let head: import('node:http2').IncomingHttpHeaders = {}
      req.on('response', (h) => (head = h))
      req.on('data', (c) => (buf += c))
      req.on('end', () => resolve({ status: Number(head[':status']), headers: head, body: buf }))
      req.on('error', reject)
    })
    expect(status).toBe(201)
    expect(headers['x-fixture']).toBe('yes')
    expect(JSON.parse(body)).toEqual({ path: '/things', method: 'POST', version: '1.1', got: '{"a":1}' })

    await vi.waitFor(() => expect(exchanges).toHaveLength(1))
    const e = exchanges[0]
    expect(e.protocol).toBe('rest')
    expect(e.via).toBe('http')
    expect(e.grpc).toBeUndefined()
    expect(e.status).toBe(201)
    expect(e.requestBody?.text).toBe('{"a":1}')
    expect(e.responseBody?.text).toContain('"got":"{\\"a\\":1}"')
  })

  it('forwards non-gRPC h2c (prior-knowledge HTTP/2) traffic and classifies it normally', async () => {
    // Mirror of the downgrade test above: this target does speak h2, so the
    // hop stays end-to-end HTTP/2 rather than being downgraded.
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

  it('serves an ALPN-negotiated h2 client over TLS against an h1-only target', async () => {
    // The reported bug: `curl --cacert <ca> https://127.0.0.1:PORT/...` offers
    // h2 in ALPN by default, so the proxy took its h2 branch and forwarded h2
    // upstream — which an h1-only target answers with a protocol error. Only
    // gRPC needs an end-to-end h2 hop; plain requests must be downgraded.
    // node:http2's connect() offers ALPN h2 exactly like curl does (node:https,
    // which the other TLS tests use, only ever offers http/1.1).
    const target = await startTarget((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json', 'x-fixture': 'yes' })
        res.end(JSON.stringify({ path: req.url, method: req.method, version: req.httpVersion, got: body }))
      })
    })
    const { tlsBase, ca, exchanges } = await startProxyTls(target)

    const session = h2Connect(tlsBase, { ca })
    cleanups.push(() => session.destroy())
    expect(await new Promise((r) => session.once('connect', () => r(session.alpnProtocol)))).toBe('h2')

    const { status, headers, body } = await new Promise<{
      status: number
      headers: import('node:http2').IncomingHttpHeaders
      body: string
    }>((resolve, reject) => {
      const req = session.request({ ':method': 'POST', ':path': '/api?limit=2', 'content-type': 'application/json' })
      req.end('{"name":"Ada"}')
      let buf = ''
      let head: import('node:http2').IncomingHttpHeaders = {}
      req.on('response', (h) => (head = h))
      req.on('data', (c) => (buf += c))
      req.on('end', () => resolve({ status: Number(head[':status']), headers: head, body: buf }))
      req.on('error', reject)
    })
    expect(status).toBe(200)
    expect(headers['x-fixture']).toBe('yes')
    // The target saw a real HTTP/1.1 request, not "Protocol error".
    expect(JSON.parse(body)).toEqual({
      path: '/api?limit=2',
      method: 'POST',
      version: '1.1',
      got: '{"name":"Ada"}'
    })

    await vi.waitFor(() => expect(exchanges).toHaveLength(1))
    const e = exchanges[0]
    expect(e.protocol).toBe('rest')
    expect(e.via).toBe('https')
    expect(e.errored).toBe(false)
    expect(e.url).toBe(`${target}/api?limit=2`)
    expect(e.status).toBe(200)
    expect(e.requestBody?.text).toBe('{"name":"Ada"}')
    expect(e.grpc).toBeUndefined()
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

/* ------------------------ HTTP/2 target test helpers ---------------------- */

/** In-test h2c target; `paths` records the :path of every stream it served. */
async function startH2Target(
  handler?: (stream: ServerHttp2Stream, headers: H2IncomingHeaders) => void,
  port = 0
): Promise<{ origin: string; paths: string[] }> {
  const paths: string[] = []
  const server = createH2Server()
  server.on('stream', (stream: ServerHttp2Stream, headers: H2IncomingHeaders) => {
    paths.push(String(headers[':path'] ?? ''))
    if (handler !== undefined) {
      handler(stream, headers)
      return
    }
    stream.respond({ ':status': 200, 'content-type': 'text/plain' })
    stream.end('h2-ok')
  })
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r))
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())))
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, paths }
}

/** One request/response on an existing h2 session. */
function h2Req(
  session: ClientHttp2Session,
  headers: H2OutgoingHeaders,
  body?: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = session.request(headers)
    let head: H2IncomingHeaders = {}
    let buf = ''
    req.on('response', (h) => (head = h))
    req.on('data', (c) => (buf += c))
    req.on('end', () => resolve({ status: Number(head[':status'] ?? 0), body: buf }))
    req.on('error', reject)
    req.end(body)
  })
}

/* ----------------- forward-target integrity (client paths) ---------------- */

/** HTTP/1.1 with a literal request target — fetch() normalizes some of these. */
function h1Raw(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('RecordProxyServer forward-target integrity', () => {
  // A client path is untrusted input. `new URL(path, target.origin)` resolves
  // "//host/x" (and "/\host/x") as protocol-relative, i.e. against a host the
  // *client* named — the proxy would then request, and record, that host.

  it('never forwards an h1 request off the configured target', async () => {
    const seen: string[] = []
    const target = await startTarget((req, res) => {
      seen.push(req.url ?? '')
      res.end('target')
    })
    const elsewhere: string[] = []
    const evil = await startTarget((req, res) => {
      elsewhere.push(req.url ?? '')
      res.end('evil')
    })
    const evilAuthority = new URL(evil).host
    const { base, exchanges } = await startProxy(target)
    const port = Number(new URL(base).port)

    for (const path of [`//${evilAuthority}/x`, `/\\${evilAuthority}/x`, '//', '/normal']) {
      expect(await h1Raw(port, path)).toBe(200)
    }

    expect(elsewhere).toEqual([])
    expect(seen).toEqual([`/${evilAuthority}/x`, `/${evilAuthority}/x`, '/', '/normal'])
    await vi.waitFor(() => expect(exchanges).toHaveLength(4))
    for (const e of exchanges) expect(new URL(e.url).origin).toBe(target)
  })

  it('never forwards an h2 request off the configured target', async () => {
    const { origin: target, paths } = await startH2Target()
    const { origin: evil, paths: evilPaths } = await startH2Target()
    const evilAuthority = new URL(evil).host
    const { base, exchanges } = await startProxy(target)
    const session = h2Connect(base)
    cleanups.push(() => session.destroy())

    for (const path of [`//${evilAuthority}/x`, '//', '/normal']) {
      expect((await h2Req(session, { ':method': 'GET', ':path': path })).body).toBe('h2-ok')
    }

    expect(evilPaths).toEqual([])
    expect(paths).toEqual([`/${evilAuthority}/x`, '/', '/normal'])
    await vi.waitFor(() => expect(exchanges).toHaveLength(3))
    for (const e of exchanges) expect(new URL(e.url).origin).toBe(target)
  })

  it('never dials a WebSocket target the client named', async () => {
    const { url: target } = await startWsTarget()
    const { url: evil, received: evilFrames } = await startWsTarget()
    const evilAuthority = new URL(evil).host
    const { base, exchanges } = await startProxy(target)

    const ws = new WebSocket(`ws://127.0.0.1:${new URL(base).port}//${evilAuthority}/x`)
    await once(ws, 'open')
    ws.send('ping')
    const [echo] = await once<[Buffer]>(ws, 'message')
    expect(echo.toString()).toBe('ping') // the configured target echoed, not `evil`
    ws.close()
    await once(ws, 'close')

    expect(evilFrames).toEqual([])
    await vi.waitFor(() => expect(exchanges).toHaveLength(1))
    expect(new URL(exchanges[0].url).origin).toBe(target.replace('http:', 'ws:'))
  })
})

/* --------------------------- HTTP/2 target probe -------------------------- */

describe('RecordProxyServer h2 probe', () => {
  it('serves plain h2 after a gRPC call has already opened the shared session', async () => {
    // The gRPC branch connects the upstream session without probing. A probe
    // that waits for that session's (already fired) 'remoteSettings' never
    // settles, and every later non-gRPC h2 request hangs behind it.
    const { origin: target } = await startH2Target((stream) => {
      stream.respond({ ':status': 200 })
      stream.end('h2-ok')
    })
    const { base } = await startProxy(target)
    const session = h2Connect(base)
    cleanups.push(() => session.destroy())

    await h2Req(session, { ':method': 'POST', ':path': '/pkg.S/M', 'content-type': 'application/grpc' })
    expect((await h2Req(session, { ':method': 'GET', ':path': '/plain' })).body).toBe('h2-ok')
  })

  it('does not cache a connect failure as an h1-only target', async () => {
    // A target that isn't up yet (or is restarting) says nothing about h2.
    const spare = createH2Server()
    await new Promise<void>((r) => spare.listen(0, '127.0.0.1', r))
    const port = (spare.address() as AddressInfo).port
    await new Promise<void>((r) => spare.close(() => r()))

    const { base } = await startProxy(`http://127.0.0.1:${port}`)
    const session = h2Connect(base)
    cleanups.push(() => session.destroy())
    expect((await h2Req(session, { ':method': 'GET', ':path': '/x' })).status).toBe(502)

    await startH2Target(undefined, port)
    // The target speaks h2 only, so a downgraded HTTP/1.1 hop cannot answer.
    expect((await h2Req(session, { ':method': 'GET', ':path': '/x' })).body).toBe('h2-ok')
  })

  it('re-probes after a restart against a different target', async () => {
    const h1Target = await startTarget((_req, res) => res.end('h1-ok'))
    const proxy = track(new RecordProxyServer())
    const first = await proxy.start({ target: h1Target })
    const s1 = h2Connect(`http://127.0.0.1:${first.port}`)
    cleanups.push(() => s1.destroy())
    expect((await h2Req(s1, { ':method': 'GET', ':path': '/x' })).body).toBe('h1-ok')
    s1.destroy()
    await proxy.stop()

    const { origin: h2Target } = await startH2Target()
    const second = await proxy.start({ target: h2Target })
    const s2 = h2Connect(`http://127.0.0.1:${second.port}`)
    cleanups.push(() => s2.destroy())
    expect((await h2Req(s2, { ':method': 'GET', ':path': '/x' })).body).toBe('h2-ok')
  })

  it('survives a client reset while the probe is still outstanding', async () => {
    // 192.0.2.0/24 (TEST-NET-1) blackholes the connect, so the probe is still
    // pending when the client resets: the stream needs its 'error' handler
    // before the first await, not after it.
    const uncaught: Error[] = []
    const onUncaught = (e: Error): void => void uncaught.push(e)
    process.on('uncaughtException', onUncaught)
    cleanups.push(() => void process.off('uncaughtException', onUncaught))

    const { base } = await startProxy('http://192.0.2.1:81')
    const session = h2Connect(base)
    cleanups.push(() => session.destroy())
    const req = session.request({ ':method': 'GET', ':path': '/x' })
    req.on('error', () => undefined)
    req.end()
    await new Promise((r) => setTimeout(r, 50))
    req.close(h2Constants.NGHTTP2_INTERNAL_ERROR)
    await new Promise((r) => setTimeout(r, 150))

    expect(uncaught).toEqual([])
  })
})

/* ------------------------ empty gRPC message capture ---------------------- */

describe('RecordProxyServer gRPC empty messages', () => {
  it('records an empty message as captured, not as dropped', async () => {
    // A message with only default fields serializes to zero bytes (this is what
    // google.protobuf.Empty and every no-arg RPC looks like on the wire).
    const Greeter = loadGreeter()
    const server = new grpc.Server()
    server.addService(Greeter.service, {
      SayHello: (_call: any, cb: any) => cb(null, {}),
      SayHellos: (call: any) => call.end()
    })
    const port = await new Promise<number>((resolve, reject) =>
      server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) =>
        e !== null ? reject(e) : resolve(p)
      )
    )
    cleanups.push(() => server.forceShutdown())
    const { base, exchanges } = await startProxy(`http://127.0.0.1:${port}`)
    const client = greeterClient(base)

    await new Promise<void>((resolve, reject) =>
      client.SayHello({}, (e: Error | null) => (e !== null ? reject(e) : resolve()))
    )
    await vi.waitFor(() => expect(exchanges).toHaveLength(1))

    const messages = exchanges[0].grpc?.messages ?? []
    expect(messages).toHaveLength(2)
    // A zero-length payload IS the payload: `bytes: 0` must not read the same
    // as "the cap dropped this one".
    expect(messages.map((m) => ({ dir: m.dir, bytes: m.bytes, truncated: m.truncated, base64: m.base64 }))).toEqual([
      { dir: 'send', bytes: 0, truncated: false, base64: '' },
      { dir: 'recv', bytes: 0, truncated: false, base64: '' }
    ])
    expect(
      decodeGrpcMessages({ fullMethod: 'helloworld.Greeter/SayHello', protoFiles: [GREETER_PROTO], messages })
    ).toEqual([
      { json: JSON.stringify({ name: '' }, null, 2) },
      { json: JSON.stringify({ message: '' }, null, 2) }
    ])
  })

  it('decodes an empty payload recorded before base64 was always set', () => {
    // Backward compatibility: old recorded.jsonl lines left base64 off entirely
    // when the message was empty. `bytes` is the wire truth either way.
    expect(
      decodeGrpcMessages({
        fullMethod: 'helloworld.Greeter/SayHello',
        protoFiles: [GREETER_PROTO],
        messages: [{ dir: 'send', bytes: 0, truncated: false }]
      })
    ).toEqual([{ json: JSON.stringify({ name: '' }, null, 2) }])
  })
})

/* ---------------------------- SSE cap-hit emit ---------------------------- */

describe('RecordProxyServer SSE mid-stream recording', () => {
  it('records a still-open SSE stream at the cap, matching classify on case', async () => {
    // Media types are case-insensitive (RFC 9110 §8.3.1) and classifyExchange
    // lowercases before matching, so the cap-hit emit must too — otherwise the
    // exchange is classified 'sse' but never written until the client leaves.
    let end: () => void = () => {}
    const target = await startTarget((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/Event-Stream' })
      const chunk = `data: ${'x'.repeat(1000)}\n\n`
      for (let i = 0; i < PROXY_BODY_CAP / 1000 + 8; i++) res.write(chunk)
      end = () => res.end()
    })
    const { base, exchanges } = await startProxy(target)

    const res = await fetch(`${base}/events`)
    const reader = res.body!.getReader()
    const pump = (async () => {
      for (;;) {
        const { done } = await reader.read()
        if (done) break
      }
    })()

    // Emitted from the cap hit while the upstream is still open — not from the
    // 'end' below, which would arrive without `stream`.
    await vi.waitFor(() => expect(exchanges).toHaveLength(1))
    expect(exchanges[0].protocol).toBe('sse')
    expect(exchanges[0].stream).toBe(true)
    end()
    await pump
  })
})
