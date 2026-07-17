/**
 * Record proxy: a reverse proxy that forwards every request to one configured
 * target and records the traffic. Part of src/engine — the only place allowed
 * to open a socket. Like the mock server this opens a *listening* socket, but
 * only one the user explicitly starts, bound to loopback by default.
 *
 * Forwarding is a raw pass-through pipe (NOT the executor client, which
 * buffers, follows redirects and writes history — all wrong for a transparent
 * proxy): SSE and chunked responses stream correctly by construction. Bodies
 * are teed into capped buffers for the recording only. Classification and
 * save-to-collection conversion are pure and live in src/core/record/.
 *
 * The outer listener is a net.Server that sniffs the first bytes of each
 * connection for the HTTP/2 preface ("PRI "): cleartext dual-protocol needs
 * this because allowHTTP1 exists only on TLS servers (ALPN). grpc-js sends the
 * 24-byte preface immediately, so a 3-byte sniff is deterministic. That branch
 * dispatches to an internal http2.Server (h2c prior knowledge, i.e. gRPC —
 * forward, then count and retain the wire-framed messages; decoding them is
 * the viewer's job, not the proxy's);
 * WebSocket upgrades on the HTTP/1.1 branch are relayed with `ws` and captured
 * as one exchange per session. Phase 2.5 adds an optional TLS listener via
 * `start({ tls })`.
 *
 * The client's HTTP version is NOT the target's: HTTP semantics are
 * version-independent, so every h2 client leg except gRPC is forwarded through
 * the same HTTP/1.1 upstream forwarder (`forward`) as the h1 legs, downgrading
 * like mitmproxy does. Only gRPC needs end-to-end h2 — grpc-status rides in
 * trailers, which HTTP/1.1 can't carry through Node's client. Without the
 * downgrade any h2-capable client (curl and browsers offer h2 in ALPN by
 * default) breaks against an HTTP/1.1-only target, i.e. against most backends.
 */
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import {
  connect as h2Connect,
  constants as h2Constants,
  createServer as createH2Server
} from 'node:http2'
import type {
  ClientHttp2Session,
  ClientHttp2Stream,
  Http2Server,
  IncomingHttpHeaders as H2IncomingHeaders,
  OutgoingHttpHeaders as H2OutgoingHeaders,
  ServerHttp2Stream
} from 'node:http2'
import { createServer as createNetServer } from 'node:net'
import type { AddressInfo, Server as NetServer, Socket } from 'node:net'
import { createServer as createTlsServer } from 'node:tls'
import type { Server as TlsServer, TLSSocket } from 'node:tls'
import { duplexPair } from 'node:stream'
import type { Readable, Writable } from 'node:stream'
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import WebSocket, { WebSocketServer } from 'ws'
import type { Header, RecordedBody, RecordedExchange, RecordedGrpcMessage } from '../shared/model'
import { classifyExchange, HOP_BY_HOP_HEADERS, isGrpcContentType } from '../core/record/classify'

export type ProxyState = 'idle' | 'listening' | 'stopped'

/** Body previews are capped so a large download can't bloat recorded.jsonl. */
export const PROXY_BODY_CAP = 64 * 1024

export interface ProxyStartArgs {
  /** Forwarding target origin (http: or https:). */
  target: string
  /** 0 (default) picks an ephemeral port. */
  port?: number
  /** Defaults to 127.0.0.1 — never bind 0.0.0.0 implicitly. */
  host?: string
  /**
   * An additional TLS listener on its own port. No byte-sniffing here: the
   * TLS handshake negotiates HTTP/1.1 vs h2 via ALPN, and each decrypted
   * socket is dispatched to the matching protocol server — REST/GraphQL/SSE
   * and WebSocket upgrades on an http/1.1 server, gRPC on an h2 one.
   * Port 0 picks an ephemeral port, like the plain listener.
   */
  tls?: { key: string; cert: string; port: number }
}

/** Which listener a connection arrived on (recorded on each exchange). */
type ListenerScheme = 'http' | 'https'

export interface RecordProxyServerEvents {
  exchange: (entry: RecordedExchange) => void
  error: (err: Error) => void
}

/** WebSocket capture caps: a chatty session can't bloat recorded.jsonl. */
export const WS_FRAME_CAP = 200
export const WS_PREVIEW_CAP = 2 * 1024

type WsFrame = NonNullable<RecordedExchange['ws']>['frames'][number]

/**
 * Retained gRPC messages per direction, mirroring WS_FRAME_CAP: a long-lived
 * stream must not grow recorded.jsonl without bound. Messages past the cap are
 * still counted, just not kept.
 */
export const GRPC_MESSAGE_CAP = 200

/**
 * How long the HTTP/2 support probe waits for the target's SETTINGS. A target
 * that answers neither way is treated as unproven, not as HTTP/1.1-only.
 */
const H2_PROBE_TIMEOUT_MS = 2000

/**
 * Walks the 5-byte length-prefixed gRPC message framing (1 compressed flag +
 * 4-byte big-endian length) on a teed DATA direction, counting every message
 * and retaining the payloads for the decode view (tier 2/3).
 *
 * Retention is capped twice: at most GRPC_MESSAGE_CAP messages, and at most
 * PROXY_BODY_CAP retained bytes across the direction (which also bounds any
 * single message). `messages` counts regardless — the count is the wire truth
 * and the decode view is best-effort on top of it.
 */
class GrpcFrameCapture {
  messages = 0
  readonly captured: RecordedGrpcMessage[] = []
  private readonly header = Buffer.alloc(5)
  private headerFill = 0
  private payloadLeft = 0
  private budget = PROXY_BODY_CAP
  /** The message currently being filled, or null when it isn't being kept. */
  private current: { entry: RecordedGrpcMessage; chunks: Buffer[] } | null = null

  constructor(private readonly dir: RecordedGrpcMessage['dir']) {}

  push(chunk: Buffer): void {
    let off = 0
    while (off < chunk.length) {
      if (this.payloadLeft > 0) {
        const take = Math.min(this.payloadLeft, chunk.length - off)
        this.retain(chunk.subarray(off, off + take))
        this.payloadLeft -= take
        off += take
        if (this.payloadLeft === 0) this.finish()
        continue
      }
      const take = Math.min(5 - this.headerFill, chunk.length - off)
      chunk.copy(this.header, this.headerFill, off, off + take)
      this.headerFill += take
      off += take
      if (this.headerFill === 5) {
        this.headerFill = 0
        this.begin(this.header[0] === 1, this.header.readUInt32BE(1))
      }
    }
  }

  private begin(compressed: boolean, length: number): void {
    this.messages++
    this.payloadLeft = length
    if (this.captured.length >= GRPC_MESSAGE_CAP) {
      this.current = null
      return
    }
    const entry: RecordedGrpcMessage = {
      dir: this.dir,
      bytes: length,
      truncated: false,
      ...(compressed ? { compressed: true } : {})
    }
    this.captured.push(entry)
    this.current = { entry, chunks: [] }
    if (length === 0) this.finish() // no payload chunks are coming
  }

  private retain(slice: Buffer): void {
    if (this.current === null) return
    const keep = Math.min(slice.length, this.budget)
    if (keep > 0) {
      this.current.chunks.push(Buffer.from(slice.subarray(0, keep)))
      this.budget -= keep
    }
    if (keep < slice.length) this.current.entry.truncated = true
  }

  private finish(): void {
    if (this.current === null) return
    // Always set, '' included: a zero-length message is a real message (every
    // no-arg RPC and google.protobuf.Empty look exactly like this on the wire).
    // Leaving base64 off would make it indistinguishable from a payload the cap
    // dropped, and consumers would report the capture as incomplete.
    this.current.entry.base64 = Buffer.concat(this.current.chunks).toString('base64')
    this.current = null
  }
}

/** Close codes `ws` will accept on send (RFC 6455 §7.4 minus reserved ones). */
function sendableCloseCode(code: number): boolean {
  return (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999)
}

/** Tee sink: counts every byte, keeps at most PROXY_BODY_CAP of them. */
class BodyTee {
  private readonly chunks: Buffer[] = []
  private kept = 0
  bytes = 0

  push(chunk: Buffer): void {
    this.bytes += chunk.length
    const room = PROXY_BODY_CAP - this.kept
    if (room <= 0) return
    const take = chunk.length <= room ? chunk : chunk.subarray(0, room)
    this.chunks.push(take)
    this.kept += take.length
  }

  get truncated(): boolean {
    return this.bytes > this.kept
  }

  buffer(): Buffer {
    return Buffer.concat(this.chunks)
  }
}

/** Decompress a preview buffer per Content-Encoding; null = leave it raw. */
function decodePreview(buf: Buffer, encoding: string): Buffer | null {
  try {
    if (encoding === 'gzip' || encoding === 'x-gzip') return gunzipSync(buf)
    if (encoding === 'br') return brotliDecompressSync(buf)
    if (encoding === 'deflate') {
      try {
        return inflateSync(buf)
      } catch {
        return inflateRawSync(buf) // some servers send raw deflate
      }
    }
  } catch {
    /* truncated or corrupt stream — fall back to the raw bytes */
  }
  return null
}

/** Build the capped RecordedBody preview (decoded, text-or-base64). */
function toRecordedBody(tee: BodyTee, contentEncoding: string | undefined): RecordedBody | undefined {
  if (tee.bytes === 0) return undefined
  let buf = tee.buffer()
  let truncated = tee.truncated
  if (contentEncoding !== undefined && contentEncoding !== '' && contentEncoding !== 'identity') {
    const decoded = decodePreview(buf, contentEncoding.toLowerCase())
    if (decoded !== null) {
      buf = decoded
      // Decompression can balloon past the cap; re-cap the preview.
      if (buf.length > PROXY_BODY_CAP) {
        buf = buf.subarray(0, PROXY_BODY_CAP)
        truncated = true
      }
    }
  }
  // A NUL byte marks the body as binary — previewed as base64, not mojibake.
  if (buf.includes(0)) {
    return { text: '', bytes: tee.bytes, truncated, base64: buf.toString('base64') }
  }
  return { text: buf.toString('utf8'), bytes: tee.bytes, truncated }
}

/**
 * Normalize a client-supplied request target to a path that can only ever
 * address the configured target.
 *
 * The client's path is untrusted input and MUST NOT be run through URL
 * resolution (`new URL(path, origin)`): to the WHATWG parser a leading `//` —
 * or `/\`, which it treats identically — introduces an authority, so a client
 * asking for `//evil.com/x` would resolve to a host the *client* named. The
 * proxy would then dial that host, send it `Host: evil.com`, relay the answer
 * back as the target's, and record the exchange under evil.com's URL. `//`
 * alone doesn't even parse (ERR_INVALID_URL), which threw out of the emit.
 *
 * Collapsing the run to a single `/` keeps the request an origin-form path
 * (RFC 9112 §3.2.1), which is all a client may legally send anyway.
 */
function safeClientPath(reqPath: string): string {
  const path = reqPath.startsWith('/') ? reqPath : `/${reqPath}`
  return path.replace(/^[/\\]+/, '/')
}

/**
 * Join the target's base path with an incoming request path. A target like
 * http://host/api means every forwarded path gets the /api prefix — on h1, h2
 * (where the joined value is what goes into :path) and WebSocket alike.
 */
function joinTargetPath(target: URL, reqPath: string): string {
  const base = target.pathname.replace(/\/+$/, '')
  if (base === '') return reqPath
  return base + (reqPath.startsWith('/') ? reqPath : `/${reqPath}`)
}

/**
 * The absolute URL one client leg is forwarded to (and recorded under). Built
 * by literal append onto the target's origin — see safeClientPath for why the
 * client's path is never resolved against it. `scheme` overrides the target's
 * (ws:/wss: for an upgrade); the origin is always the configured target's.
 */
function forwardUrl(target: URL, reqPath: string, scheme?: string): URL {
  const origin = scheme === undefined ? target.origin : `${scheme}//${target.host}`
  return new URL(origin + joinTargetPath(target, safeClientPath(reqPath)))
}

/**
 * The client leg of one exchange, normalized to HTTP/1.1 shape so that one
 * upstream forwarder serves both listeners' h1 requests and downgraded h2
 * streams. Pseudo-headers are already translated by the h2 adapter; hop-by-hop
 * stripping and the host rewrite belong to the forwarder, not here.
 */
interface ClientLeg {
  method: string
  /** Request target as the client sent it, before the target base path join. */
  path: string
  /** Request headers with h2 pseudo-headers removed. */
  headers: IncomingHttpHeaders
  /** Request body source, piped to the upstream request. */
  body: Readable
  /** True once the head went out — an error can no longer become a 502. */
  headSent: () => boolean
  /** Send the response head. Hop-by-hop headers are stripped by the caller. */
  head: (status: number, headers: OutgoingHttpHeaders) => void
  /** Response body sink; piped into, so backpressure reaches the upstream. */
  sink: Writable
  destroy: () => void
  /** Client hung up, or the response finished. */
  onClose: (cb: () => void) => void
}

/**
 * Adapt an HTTP/2 client stream to a ClientLeg so it can be forwarded over
 * HTTP/1.1. :method/:path become the request line and :authority/:scheme are
 * dropped — the forwarder rewrites Host to the target's anyway. The response
 * head goes back the other way: hop-by-hop headers are stripped by the
 * forwarder, which also covers everything HTTP/2 forbids (connection,
 * transfer-encoding, keep-alive, upgrade).
 */
function toH2ClientLeg(stream: ServerHttp2Stream, headers: H2IncomingHeaders): ClientLeg {
  const h1Headers: IncomingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || name.startsWith(':')) continue
    h1Headers[name] = value
  }
  // Cleanup is the forwarder's 'close' handler; this only stops an unhandled
  // 'error' from throwing (h1's IncomingMessage is covered by the http
  // server's own clientError handling, an h2 stream has no such backstop).
  stream.on('error', () => undefined)
  return {
    method: String(headers[':method'] ?? 'GET'),
    path: String(headers[':path'] ?? '/'),
    headers: h1Headers,
    body: stream,
    headSent: () => stream.headersSent,
    head: (status, outHeaders) => {
      if (stream.destroyed || stream.headersSent) return
      stream.respond({ ...(outHeaders as H2OutgoingHeaders), ':status': status })
    },
    sink: stream,
    destroy: () => stream.destroy(),
    onClose: (cb) => stream.on('close', cb)
  }
}

/** Node's header map -> Header[], expanding arrays (set-cookie) into rows. */
function toHeaderList(headers: IncomingHttpHeaders): Header[] {
  const out: Header[] = []
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const v of value) out.push({ name, value: v })
    else out.push({ name, value })
  }
  return out
}

export class RecordProxyServer {
  private outer?: NetServer
  /** Optional TLS listener (Phase 2.5); undefined unless start() got `tls`. */
  private tlsServer?: TlsServer
  private target?: URL
  private readonly sockets = new Set<Socket>()
  private readonly upstreams = new Set<ClientRequest>()
  /** One upstream h2 session for the proxy lifetime; recreated after close/error. */
  private h2Upstream?: ClientHttp2Session
  /** Target-leg WebSocket connections, terminated on stop(). */
  private readonly wsTargets = new Set<WebSocket>()
  private _state: ProxyState = 'idle'
  private _port?: number
  private _tlsPort?: number
  private readonly listeners: { [E in keyof RecordProxyServerEvents]: RecordProxyServerEvents[E][] } = {
    exchange: [],
    error: []
  }

  get state(): ProxyState {
    return this._state
  }
  get port(): number | undefined {
    return this._port
  }
  get tlsPort(): number | undefined {
    return this._tlsPort
  }

  on<E extends keyof RecordProxyServerEvents>(event: E, cb: RecordProxyServerEvents[E]): this {
    this.listeners[event].push(cb)
    return this
  }

  private emit<E extends keyof RecordProxyServerEvents>(
    event: E,
    ...args: Parameters<RecordProxyServerEvents[E]>
  ): void {
    for (const cb of this.listeners[event]) {
      ;(cb as (...a: Parameters<RecordProxyServerEvents[E]>) => void)(...args)
    }
  }

  /** HTTP/1.1 client leg (both listeners) -> the shared upstream forwarder. */
  private handle(req: IncomingMessage, res: ServerResponse, via: ListenerScheme): void {
    this.forward(
      {
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers: req.headers,
        body: req,
        headSent: () => res.headersSent,
        head: (status, headers) => res.writeHead(status, headers),
        sink: res,
        destroy: () => res.destroy(),
        onClose: (cb) => res.on('close', cb)
      },
      via
    )
  }

  /**
   * Forward one client leg to the target over HTTP/1.1 and record it: raw
   * pass-through pipe, bodies teed into capped previews. Shared by the h1
   * listeners and by the downgraded (non-gRPC) h2 legs — the leg abstracts how
   * the request is read and the response written, nothing else differs.
   */
  private forward(leg: ClientLeg, via: ListenerScheme): void {
    const target = this.target as URL
    const at = new Date().toISOString()
    const started = Date.now()
    const targetUrl = forwardUrl(target, leg.path)
    const method = leg.method

    // Forwarded headers: strip hop-by-hop, rewrite host to the target's. This
    // also drops what HTTP/1.1 must not receive from an h2 leg (`te: trailers`)
    // and what h2 could never have sent anyway (connection, transfer-encoding).
    const fwdHeaders: OutgoingHttpHeaders = {}
    for (const [name, value] of Object.entries(leg.headers)) {
      if (value === undefined || HOP_BY_HOP_HEADERS.has(name)) continue
      fwdHeaders[name] = value
    }
    fwdHeaders['host'] = targetUrl.host

    const reqTee = new BodyTee()
    leg.body.on('data', (c: Buffer) => reqTee.push(c))

    const requestFn = targetUrl.protocol === 'https:' ? httpsRequest : httpRequest
    const upstream = requestFn(targetUrl, { method, headers: fwdHeaders })
    this.upstreams.add(upstream)
    upstream.on('close', () => this.upstreams.delete(upstream))
    leg.body.pipe(upstream)

    // One exchange per request, whichever terminal event fires first.
    let emitted = false
    const emitExchange = (
      up: IncomingMessage | undefined,
      resTee: BodyTee | undefined,
      extra: { stream?: boolean; errored: boolean; error?: string }
    ): void => {
      if (emitted) return
      emitted = true
      const requestBody = toRecordedBody(reqTee, leg.headers['content-encoding'])
      const responseBody = up !== undefined && resTee !== undefined ? toRecordedBody(resTee, up.headers['content-encoding']) : undefined
      const cls = classifyExchange(
        { contentType: leg.headers['content-type'], bodyText: requestBody?.text },
        up !== undefined ? { contentType: up.headers['content-type'] } : undefined
      )
      this.emit('exchange', {
        id: randomUUID(),
        at,
        timeMs: Date.now() - started,
        protocol: cls.protocol,
        method,
        url: targetUrl.toString(),
        via,
        requestHeaders: toHeaderList(leg.headers),
        ...(requestBody !== undefined ? { requestBody } : {}),
        ...(up !== undefined ? { status: up.statusCode, responseHeaders: toHeaderList(up.headers) } : {}),
        ...(responseBody !== undefined ? { responseBody } : {}),
        ...(extra.stream === true ? { stream: true } : {}),
        errored: extra.errored,
        ...(extra.error !== undefined ? { error: extra.error } : {}),
        ...(cls.graphql !== undefined ? { graphql: cls.graphql } : {})
      })
    }

    upstream.on('error', (e: Error) => {
      if (!leg.headSent()) {
        leg.head(502, { 'content-type': 'application/json' })
        leg.sink.end(JSON.stringify({ error: 'upstream request failed', detail: e.message }, null, 2))
      } else {
        leg.destroy()
      }
      emitExchange(undefined, undefined, { errored: true, error: e.message })
    })

    upstream.on('response', (up: IncomingMessage) => {
      const resTee = new BodyTee()
      const outHeaders: OutgoingHttpHeaders = {}
      for (const [name, value] of Object.entries(up.headers)) {
        if (value === undefined || HOP_BY_HOP_HEADERS.has(name)) continue
        outHeaders[name] = value
      }
      leg.head(up.statusCode ?? 502, outHeaders)
      // Lowercased to match classifyExchange: media types are case-insensitive
      // (RFC 9110 §8.3.1), and an exchange classified 'sse' here but not there
      // would only ever be recorded once the client disconnects.
      const sse = (up.headers['content-type'] ?? '').toLowerCase().startsWith('text/event-stream')
      up.on('data', (c: Buffer) => {
        resTee.push(c)
        // A long-lived stream may never end: record it once the preview cap is
        // hit rather than never, and keep piping bytes to the client.
        if (sse && resTee.truncated) emitExchange(up, resTee, { stream: true, errored: false })
      })
      up.pipe(leg.sink)
      up.on('end', () => {
        const errored = up.statusCode !== undefined && up.statusCode >= 400
        emitExchange(up, resTee, { errored })
      })
      up.on('error', () => emitExchange(up, resTee, { errored: true, error: 'upstream stream failed' }))
      // Client hung up mid-stream (typical for SSE): keep the partial capture.
      leg.onClose(() => {
        upstream.destroy()
        emitExchange(up, resTee, { stream: true, errored: false })
      })
    })
  }

  /**
   * The one upstream HTTP/2 session, (re)connecting on demand. http2.connect
   * speaks h2c to an http: target and TLS(ALPN h2) to an https: one.
   */
  private h2Session(): ClientHttp2Session {
    const cur = this.h2Upstream
    if (cur !== undefined && !cur.closed && !cur.destroyed) return cur
    const target = this.target as URL
    const session = h2Connect(target.origin)
    // SETTINGS from the peer proves h2 wherever it is observed: gRPC opens this
    // session without probing, so latching the answer here is what keeps a
    // later probe from having to ask a session that already answered.
    session.once('remoteSettings', () => {
      this.h2Support = true
    })
    const forget = (): void => {
      if (this.h2Upstream === session) this.h2Upstream = undefined
    }
    // Errors surface per-stream (the pending request errors too); the session
    // just gets dropped so the next stream reconnects.
    session.on('error', forget)
    session.on('close', forget)
    this.h2Upstream = session
    return session
  }

  /**
   * The target's answer to "do you speak HTTP/2", once it is *known*. Undefined
   * means unproven — never "no". A connect failure (target not up yet, DNS
   * blip, restart) says nothing about the target's protocols, so caching it
   * would silently downgrade a real h2 target for the rest of the run.
   */
  private h2Support?: boolean
  /** The in-flight probe, deduplicating concurrent askers. Cleared on settle. */
  private h2Probe?: Promise<boolean>

  /**
   * Whether the target speaks HTTP/2. Only the downgrade decision needs this —
   * gRPC requires h2 unconditionally and fails loudly if the target can't do it.
   */
  private targetSpeaksH2(): Promise<boolean> {
    if (this.h2Support !== undefined) return Promise.resolve(this.h2Support)
    this.h2Probe ??= this.probeH2().finally(() => {
      this.h2Probe = undefined
    })
    return this.h2Probe
  }

  /**
   * Probe the target with a dedicated, short-lived session — never the shared
   * upstream one, whose 'remoteSettings' is one-shot and may already have fired
   * (gRPC opens it without probing), leaving a listener that never runs.
   *
   * Cleartext has no ALPN, so the only honest signal is the h2 handshake
   * itself: a real h2 peer answers the connection preface with SETTINGS, an
   * HTTP/1.1 server answers 400 and the session errors out. Only those two
   * outcomes are definitive enough to cache: the session reaches 'connect' as
   * soon as TCP is up, whatever it goes on to speak, so a *connected* session
   * failing on h2 framing is a real "no" while everything else — refused,
   * unreachable, timed out — stays unproven and is re-asked next time.
   */
  private probeH2(): Promise<boolean> {
    const target = this.target as URL
    return new Promise<boolean>((resolve) => {
      let settled = false
      let connected = false
      let session: ClientHttp2Session | undefined
      const finish = (answer: boolean, definitive: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (definitive) this.h2Support = answer
        session?.destroy()
        resolve(answer)
      }
      // Without this a blackholed target holds every non-gRPC h2 request for
      // the OS connect timeout (~2 min); the h1 path fails fast instead.
      const timer = setTimeout(() => finish(false, false), H2_PROBE_TIMEOUT_MS)
      if (typeof timer.unref === 'function') timer.unref()
      try {
        session = h2Connect(target.origin)
      } catch {
        finish(false, false)
        return
      }
      session.once('connect', () => {
        connected = true
      })
      session.once('remoteSettings', () => finish(true, true))
      // A connected peer that fails h2 framing is speaking something else;
      // a reset or a bare close mid-conversation only means "ask again".
      session.once('error', (e: NodeJS.ErrnoException) =>
        finish(false, connected && e.code?.startsWith('ERR_HTTP2') === true)
      )
      session.once('close', () => finish(false, false))
    })
  }

  /**
   * One HTTP/2 stream from either listener (ALPN h2 on the TLS one, h2c prior
   * knowledge on the cleartext one).
   *
   * Only gRPC is pinned to an h2 upstream: grpc-status arrives in trailers, so
   * an HTTP/1.1 hop would silently break every call. Everything else — curl,
   * browsers, any prior-knowledge h2 client — is downgraded to the shared
   * HTTP/1.1 forwarder unless the target itself speaks h2, because HTTP
   * semantics don't depend on the wire version and most targets are h1-only.
   */
  private handleH2Stream(stream: ServerHttp2Stream, headers: H2IncomingHeaders, via: ListenerScheme): void {
    if (!isGrpcContentType(headers['content-type'] as string | undefined)) {
      // Synchronously, before the probe's await: an h2 stream has no backstop
      // for 'error' (see toH2ClientLeg), so a client RST_STREAM inside the
      // probe window would otherwise throw out of the process.
      stream.on('error', () => undefined)
      // The probe is awaited before any listener is attached, so the client's
      // DATA stays in the stream's buffer (h2 flow control bounds it) rather
      // than being dropped.
      void this.targetSpeaksH2().then((h2) => {
        if (stream.destroyed) return
        if (h2) this.forwardH2(stream, headers, via)
        else this.forward(toH2ClientLeg(stream, headers), via)
      })
      return
    }
    this.forwardH2(stream, headers, via)
  }

  /**
   * Forward an h2 stream to an h2 upstream, relaying trailers: the gRPC path
   * (grpc-status/grpc-message live there), and any non-gRPC h2 client when the
   * target speaks h2 too, which keeps the exchange end-to-end HTTP/2.
   */
  private forwardH2(stream: ServerHttp2Stream, headers: H2IncomingHeaders, via: ListenerScheme): void {
    const target = this.target as URL
    const at = new Date().toISOString()
    const started = Date.now()
    const path = String(headers[':path'] ?? '/')
    /** The forwarded :path — the target's base path prefix included. */
    const fwdPath = joinTargetPath(target, safeClientPath(path))
    /** Always the configured target's — never a host the client's path named. */
    const targetUrl = forwardUrl(target, path)
    const method = String(headers[':method'] ?? 'POST')
    const isGrpc = isGrpcContentType(headers['content-type'] as string | undefined)

    // Forwarded headers: drop pseudo-headers (rebuilt for the target below),
    // host (h2 uses :authority) and hop-by-hop — except `te: trailers`, which
    // RFC 9113 permits and gRPC servers require.
    const fwd: H2OutgoingHeaders = {}
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined || name.startsWith(':') || name === 'host') continue
      if (HOP_BY_HOP_HEADERS.has(name) && !(name === 'te' && String(value).toLowerCase() === 'trailers')) continue
      fwd[name] = value
    }
    fwd[':method'] = method
    fwd[':path'] = fwdPath
    fwd[':scheme'] = target.protocol.replace(':', '')
    fwd[':authority'] = target.host

    const reqTee = new BodyTee()
    const resTee = new BodyTee()
    const reqFrames = new GrpcFrameCapture('send')
    const resFrames = new GrpcFrameCapture('recv')
    let resHeaders: H2IncomingHeaders | undefined
    let trailers: H2IncomingHeaders | undefined

    let emitted = false
    const emitExchange = (extra: { errored: boolean; error?: string }): void => {
      if (emitted) return
      emitted = true
      const status = resHeaders?.[':status'] !== undefined ? Number(resHeaders[':status']) : undefined
      const grpcStatusRaw = trailers?.['grpc-status'] ?? resHeaders?.['grpc-status']
      const grpcStatus = grpcStatusRaw !== undefined ? Number(grpcStatusRaw) : undefined
      // gRPC bodies are framed protobuf, not a body preview — they are
      // recorded per-message under `grpc` instead. Other h2c traffic (plain
      // JSON over prior-knowledge HTTP/2) records normally.
      const requestBody = isGrpc ? undefined : toRecordedBody(reqTee, headers['content-encoding'] as string | undefined)
      const responseBody = isGrpc ? undefined : toRecordedBody(resTee, resHeaders?.['content-encoding'] as string | undefined)
      const cls = classifyExchange(
        { contentType: headers['content-type'] as string | undefined, bodyText: requestBody?.text },
        resHeaders !== undefined ? { contentType: resHeaders['content-type'] as string | undefined } : undefined
      )
      // "/pkg.Service/Method" -> service + method (best-effort for odd paths).
      const slash = path.lastIndexOf('/')
      const service = path.slice(1, Math.max(slash, 1))
      const grpcMethod = slash >= 0 ? path.slice(slash + 1) : path
      const messages = [...reqFrames.captured, ...resFrames.captured]
      this.emit('exchange', {
        id: randomUUID(),
        at,
        timeMs: Date.now() - started,
        protocol: cls.protocol,
        method,
        url: targetUrl.toString(),
        via,
        requestHeaders: toHeaderList(headers as IncomingHttpHeaders).filter((h) => !h.name.startsWith(':')),
        ...(requestBody !== undefined ? { requestBody } : {}),
        ...(status !== undefined
          ? { status, responseHeaders: toHeaderList((resHeaders ?? {}) as IncomingHttpHeaders).filter((h) => !h.name.startsWith(':')) }
          : {}),
        ...(responseBody !== undefined ? { responseBody } : {}),
        errored: extra.errored,
        ...(extra.error !== undefined ? { error: extra.error } : {}),
        ...(cls.graphql !== undefined ? { graphql: cls.graphql } : {}),
        ...(cls.protocol === 'grpc'
          ? {
              grpc: {
                service,
                method: grpcMethod,
                ...(grpcStatus !== undefined ? { grpcStatus } : {}),
                requestMessages: reqFrames.messages,
                responseMessages: resFrames.messages,
                ...(messages.length > 0 ? { messages } : {})
              }
            }
          : {})
      })
    }

    const refuse = (detail: string): void => {
      if (!stream.destroyed && !stream.headersSent) {
        stream.respond({ ':status': 502, 'content-type': 'application/json' })
        stream.end(JSON.stringify({ error: 'upstream request failed', detail }, null, 2))
      } else if (!stream.destroyed) {
        stream.destroy()
      }
      emitExchange({ errored: true, error: detail })
    }

    let upstream: ClientHttp2Stream
    try {
      upstream = this.h2Session().request(fwd)
    } catch (e) {
      refuse(e instanceof Error ? e.message : String(e))
      return
    }

    stream.on('data', (c: Buffer) => {
      reqTee.push(c)
      if (isGrpc) reqFrames.push(c)
    })
    stream.pipe(upstream)
    stream.on('error', () => upstream.destroy())

    upstream.on('error', (e: Error) => refuse(e.message))
    upstream.on('trailers', (t: H2IncomingHeaders) => {
      trailers = t
    })
    upstream.on('response', (up: H2IncomingHeaders, flags: number) => {
      resHeaders = up
      const out: H2OutgoingHeaders = { ':status': up[':status'] }
      for (const [name, value] of Object.entries(up)) {
        if (value === undefined || name.startsWith(':') || HOP_BY_HOP_HEADERS.has(name)) continue
        out[name] = value
      }
      // A headers-only response (gRPC "trailers-only": status in the HEADERS
      // frame with END_STREAM) must be answered the same way.
      if ((flags & h2Constants.NGHTTP2_FLAG_END_STREAM) !== 0) {
        stream.respond(out, { endStream: true })
        emitExchange({ errored: gotError(up, undefined) })
        return
      }
      stream.respond(out, { waitForTrailers: true })
      stream.on('wantTrailers', () => {
        const t: H2OutgoingHeaders = {}
        for (const [name, value] of Object.entries(trailers ?? {})) {
          if (value !== undefined && !name.startsWith(':')) t[name] = value
        }
        stream.sendTrailers(t)
      })
      // Tee via 'data' (pipe keeps the stream flowing for both), relay via
      // pipe so backpressure propagates — a slow client pauses the upstream
      // instead of buffering the whole response in memory. end:false because
      // stream.end() must wait for 'end' (it fires 'wantTrailers').
      upstream.on('data', (c: Buffer) => {
        resTee.push(c)
        if (isGrpc) resFrames.push(c)
      })
      upstream.pipe(stream, { end: false })
      upstream.on('end', () => {
        stream.end() // fires 'wantTrailers' because of waitForTrailers
        emitExchange({ errored: gotError(up, trailers) })
      })
    })
    // Client went away mid-call: cancel upstream, keep the partial capture.
    stream.on('close', () => {
      upstream.destroy()
      emitExchange({ errored: true, error: 'client closed the stream' })
    })

    /** gRPC errors live in grpc-status (non-zero), HTTP errors in :status. */
    function gotError(up: H2IncomingHeaders, t: H2IncomingHeaders | undefined): boolean {
      const grpcStatus = t?.['grpc-status'] ?? up['grpc-status']
      if (grpcStatus !== undefined) return Number(grpcStatus) !== 0
      const status = Number(up[':status'] ?? 0)
      return status >= 400
    }
  }

  /**
   * WebSocket relay: terminate the client leg with `ws`, dial the target leg
   * ourselves, pump frames both ways. The 101 to the client is only sent once
   * the target accepts, so client frames can't race the target connection and
   * a refused upgrade surfaces as the target's real HTTP error. One exchange
   * is emitted per session, on close.
   */
  private handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer, via: ListenerScheme): void {
    const target = this.target as URL
    const at = new Date().toISOString()
    const started = Date.now()
    const wsScheme = target.protocol === 'https:' ? 'wss:' : 'ws:'
    const targetUrl = forwardUrl(target, req.url ?? '/', wsScheme)

    // Forward auth/cookie/etc; drop hop-by-hop and sec-websocket-* (`ws`
    // performs its own handshake, including subprotocol negotiation below).
    const fwdHeaders: Record<string, string | string[]> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP_HEADERS.has(name) || name === 'host' || name.startsWith('sec-websocket-')) continue
      fwdHeaders[name] = value
    }
    const requested = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')

    const frames: WsFrame[] = []
    const capture = (dir: 'in' | 'out', data: WebSocket.RawData, isBinary: boolean): void => {
      if (frames.length >= WS_FRAME_CAP) return
      // Size from the fragment lengths; copy at most WS_PREVIEW_CAP bytes —
      // never Buffer.concat a whole multi-megabyte message just to preview it.
      const parts = Array.isArray(data) ? data : [Buffer.isBuffer(data) ? data : Buffer.from(data)]
      const bytes = parts.reduce((n, p) => n + p.length, 0)
      const head: Buffer[] = []
      let kept = 0
      for (const p of parts) {
        if (kept >= WS_PREVIEW_CAP) break
        const take = p.subarray(0, WS_PREVIEW_CAP - kept)
        head.push(take)
        kept += take.length
      }
      const head2k = head.length === 1 ? head[0] : Buffer.concat(head)
      frames.push({
        dir,
        at: new Date().toISOString(),
        text: !isBinary,
        preview: isBinary ? head2k.toString('base64') : head2k.toString('utf8'),
        truncated: bytes > WS_PREVIEW_CAP
      })
    }

    let emitted = false
    const emitSession = (extra: {
      status?: number
      closeCode?: number
      negotiated?: string
      errored: boolean
      error?: string
    }): void => {
      if (emitted) return
      emitted = true
      this.emit('exchange', {
        id: randomUUID(),
        at,
        timeMs: Date.now() - started,
        protocol: 'ws',
        method: 'WS',
        url: targetUrl.toString(),
        via,
        requestHeaders: toHeaderList(req.headers),
        ...(extra.status !== undefined ? { status: extra.status } : {}),
        ...(extra.negotiated !== undefined && extra.negotiated !== ''
          ? { responseHeaders: [{ name: 'sec-websocket-protocol', value: extra.negotiated }] }
          : {}),
        errored: extra.errored,
        ...(extra.error !== undefined ? { error: extra.error } : {}),
        ws: {
          ...(extra.closeCode !== undefined ? { closeCode: extra.closeCode } : {}),
          frames
        }
      })
    }

    const targetWs = new WebSocket(targetUrl, requested, { headers: fwdHeaders })
    this.wsTargets.add(targetWs)
    targetWs.on('close', () => this.wsTargets.delete(targetWs))

    // The target answered with a non-101: relay its real refusal to the
    // client (a failed upgrade should look exactly like talking to the target).
    targetWs.on('unexpected-response', (_creq, res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks)
        const lines = [`HTTP/1.1 ${res.statusCode ?? 502} ${res.statusMessage ?? ''}`.trimEnd()]
        const type = res.headers['content-type']
        if (type !== undefined) lines.push(`content-type: ${type}`)
        lines.push(`content-length: ${body.length}`, 'connection: close', '', '')
        socket.end(Buffer.concat([Buffer.from(lines.join('\r\n')), body]))
        emitSession({ status: res.statusCode, errored: true, error: `target refused the upgrade (${res.statusCode})` })
      })
      res.on('error', () => socket.destroy())
    })
    // Handshake-phase failures only: once the session is established, errors
    // surface through the 'close' relay below (the socket is no longer HTTP).
    let established = false
    targetWs.on('error', (e: Error) => {
      if (emitted || established) return
      socket.end('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
      emitSession({ errored: true, error: e.message })
    })

    targetWs.on('open', () => {
      if (socket.destroyed) {
        targetWs.terminate()
        return
      }
      established = true
      const negotiated = targetWs.protocol
      // Per-upgrade server: echoes back exactly the subprotocol the target picked.
      const wss = new WebSocketServer({
        noServer: true,
        handleProtocols: () => (negotiated !== '' ? negotiated : false)
      })
      wss.handleUpgrade(req, socket, head, (clientWs) => {
        // Post-open failures: either leg's 'error' marks the session, and an
        // abnormal closure (1006 — no close frame, e.g. the target died)
        // records as errored even without an 'error' event.
        let sessionError: string | undefined
        const finish = (code: number): void => {
          const error = sessionError ?? (code === 1006 ? 'abnormal closure (1006)' : undefined)
          emitSession({
            status: 101,
            closeCode: code,
            negotiated,
            errored: error !== undefined,
            ...(error !== undefined ? { error } : {})
          })
        }
        const closeOther = (other: WebSocket, code: number, reason: Buffer): void => {
          if (other.readyState === WebSocket.OPEN || other.readyState === WebSocket.CONNECTING) {
            if (sendableCloseCode(code)) other.close(code, reason.subarray(0, 123)) // close reasons cap at 123 bytes
            else other.close() // 1005/1006 etc. can't be sent; plain close
          }
        }
        clientWs.on('message', (data, isBinary) => {
          capture('out', data, isBinary)
          targetWs.send(data, { binary: isBinary })
        })
        targetWs.on('message', (data, isBinary) => {
          capture('in', data, isBinary)
          clientWs.send(data, { binary: isBinary })
        })
        clientWs.on('close', (code, reason) => {
          closeOther(targetWs, code, reason)
          finish(code)
        })
        targetWs.on('close', (code, reason) => {
          closeOther(clientWs, code, reason)
          finish(code)
        })
        clientWs.on('error', (e: Error) => {
          sessionError = e.message
          clientWs.terminate()
        })
        targetWs.on('error', (e: Error) => {
          sessionError = e.message
          targetWs.terminate()
        })
      })
    })
  }

  /** Start listening. Rejects on an invalid target or unbindable port. */
  async start(args: ProxyStartArgs): Promise<{ port: number; tlsPort?: number }> {
    if (this._state === 'listening') throw new Error('Record proxy is already running')
    let target: URL
    try {
      target = new URL(args.target)
    } catch {
      throw new Error(`Invalid target URL: ${args.target}`)
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new Error('Target must be an http:// or https:// URL')
    }
    this.target = target
    // A previous run's answer belongs to a previous target.
    this.h2Support = undefined
    this.h2Probe = undefined
    const host = args.host ?? '127.0.0.1'

    const httpServer = createHttpServer((req, res) => this.handle(req, res, 'http'))
    httpServer.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket as Socket, head, 'http'))

    // Internal HTTP/2 server for the h2c branch: it never listens; connections
    // are injected from the sniff below. The TLS listener wires the same
    // 'stream' handler onto http2.createSecureServer({ allowHTTP1: true }).
    const h2Server: Http2Server = createH2Server()
    h2Server.on('stream', (stream: ServerHttp2Stream, headers: H2IncomingHeaders) =>
      this.handleH2Stream(stream, headers, 'http')
    )

    const outer = createNetServer((socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
      socket.on('error', () => socket.destroy())
      // Accumulate until 3 bytes have arrived — a dribbling client may send
      // the first request byte-by-byte, and "PR" alone decides nothing.
      const sniffed: Buffer[] = []
      let sniffedBytes = 0
      const sniff = (chunk: Buffer): void => {
        sniffed.push(chunk)
        sniffedBytes += chunk.length
        if (sniffedBytes < 3) return
        socket.removeListener('data', sniff)
        const first = sniffed.length === 1 ? sniffed[0] : Buffer.concat(sniffed)
        socket.pause()
        socket.unshift(first)
        if (first.subarray(0, 3).toString('latin1') === 'PRI') {
          // HTTP/2 preface (h2c prior knowledge, i.e. gRPC). The socket can't
          // be handed to the h2 server directly: http2 reads a net.Socket via
          // its native handle, so the unshifted preface in the JS readable
          // buffer would be lost (nodejs/node#27428). Bridge through a
          // duplexPair — http2 reads a generic duplex through JS streams.
          const [near, far] = duplexPair()
          socket.pipe(near)
          near.pipe(socket)
          socket.on('close', () => far.destroy())
          near.on('error', () => socket.destroy())
          far.on('error', () => socket.destroy())
          h2Server.emit('connection', far)
        } else {
          httpServer.emit('connection', socket)
        }
        socket.resume()
      }
      socket.on('data', sniff)
    })
    this.outer = outer

    const port = await new Promise<number>((resolve, reject) => {
      const onError = (e: Error): void => reject(e)
      outer.once('error', onError)
      outer.listen(args.port ?? 0, host, () => {
        outer.removeListener('error', onError)
        resolve((outer.address() as AddressInfo).port)
      })
    })

    outer.on('error', (e) => this.emit('error', e))
    this._port = port

    // Optional TLS listener: a raw tls.Server negotiates h2 vs http/1.1 via
    // ALPN and hands each decrypted socket to the matching protocol server
    // (neither listens; connections are injected like the h2c branch above,
    // but without the duplexPair bridge — a TLSSocket has no unshifted bytes).
    // No allowHTTP1 compat layer: its double 'request'+'stream' wiring
    // installed a competing 'wantTrailers' responder that sent empty trailers
    // ahead of ours, destroying grpc-status.
    let tlsPort: number | undefined
    if (args.tls !== undefined) {
      const httpsServer = createHttpServer((req, res) => this.handle(req, res, 'https'))
      httpsServer.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket as Socket, head, 'https'))
      const h2TlsServer: Http2Server = createH2Server()
      h2TlsServer.on('stream', (stream: ServerHttp2Stream, headers: H2IncomingHeaders) =>
        this.handleH2Stream(stream, headers, 'https')
      )
      const secure: TlsServer = createTlsServer(
        { key: args.tls.key, cert: args.tls.cert, ALPNProtocols: ['h2', 'http/1.1'] },
        (sock: TLSSocket) => {
          // No ALPN from the client (plain node:https, ws) falls back to h1.
          if (sock.alpnProtocol === 'h2') h2TlsServer.emit('connection', sock)
          else httpsServer.emit('connection', sock)
        }
      )
      this.tlsServer = secure
      // Raw TCP sockets (pre-handshake) — destroyed on stop() like the plain ones.
      secure.on('connection', (socket: Socket) => {
        this.sockets.add(socket)
        socket.on('close', () => this.sockets.delete(socket))
        socket.on('error', () => socket.destroy())
      })

      try {
        tlsPort = await new Promise<number>((resolve, reject) => {
          const onError = (e: Error): void => reject(e)
          secure.once('error', onError)
          secure.listen(args.tls?.port ?? 0, host, () => {
            secure.removeListener('error', onError)
            resolve((secure.address() as AddressInfo).port)
          })
        })
      } catch (e) {
        // Keep start() atomic: the plain listener must not stay up half-started.
        this.tlsServer = undefined
        await new Promise<void>((resolve) => outer.close(() => resolve()))
        this.outer = undefined
        this._port = undefined
        throw e
      }
      secure.on('error', (e: Error) => this.emit('error', e))
      this._tlsPort = tlsPort
    }

    this._state = 'listening'
    return { port, ...(tlsPort !== undefined ? { tlsPort } : {}) }
  }

  /** Stop listening, force-closing lingering sockets and in-flight upstreams. */
  async stop(): Promise<void> {
    const outer = this.outer
    const tlsServer = this.tlsServer
    if (outer === undefined && tlsServer === undefined) {
      this._state = 'stopped'
      return
    }
    for (const u of this.upstreams) u.destroy()
    this.upstreams.clear()
    for (const w of this.wsTargets) w.terminate()
    this.wsTargets.clear()
    this.h2Upstream?.destroy()
    this.h2Upstream = undefined
    this.h2Support = undefined
    this.h2Probe = undefined
    await new Promise<void>((resolve) => {
      let pending = (outer !== undefined ? 1 : 0) + (tlsServer !== undefined ? 1 : 0)
      const finish = (): void => {
        pending--
        if (pending <= 0) resolve()
      }
      outer?.close(() => finish())
      tlsServer?.close(() => finish())
      const t = setTimeout(() => {
        for (const s of this.sockets) s.destroy()
      }, 500)
      if (typeof t.unref === 'function') t.unref()
    })
    this.sockets.clear()
    this.outer = undefined
    this.tlsServer = undefined
    this._port = undefined
    this._tlsPort = undefined
    this._state = 'stopped'
  }
}
