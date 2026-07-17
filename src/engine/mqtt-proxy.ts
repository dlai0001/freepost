/**
 * MQTT recording relay. Part of src/engine — the only place allowed to open a
 * socket. Its own file rather than a branch of record-proxy.ts: MQTT shares
 * nothing with HTTP but the recorded.jsonl it writes into, so it needs its own
 * listener, its own port and its own target (a broker, not an http(s) origin).
 *
 * This is a TRANSPARENT TCP RELAY, not a broker. Every accepted client socket
 * gets its own TCP connection to the real broker and the bytes are piped both
 * ways; the real broker stays authoritative, so QoS, retained messages,
 * sessions, keep-alive and every other MQTT semantic are preserved for free and
 * correctly — an embedded broker would have to reimplement all of it, wrongly.
 * Both directions are `pipe`d so backpressure is honored: a hand-rolled
 * data->write pump silently drops it.
 *
 * Packets are decoded off a PASSIVE TEE, for display only. Decoding can
 * therefore fail without consequence, and does: a parser error stops decoding
 * that direction and the bytes keep flowing. A relay that breaks because it
 * couldn't read the traffic would defeat its own purpose. That extends to the
 * recorded OUTCOME: what the relay could decode never decides whether the
 * session errored, so a dropped decoder yields "unknown", never "errored" —
 * blaming the peer for the relay's own blind spot is the same defeat.
 *
 * Two parsers run, one per direction, because mqtt-packet's parser is a stream
 * decoder with per-stream state. MQTT 5 and 3.1.1 frame several packet types
 * differently and only the client's CONNECT says which is in play, so the
 * broker-direction parser is created lazily, once that version is known (the
 * client-direction parser adopts it from the CONNECT itself).
 *
 * TLS brokers (mqtts://) are out of scope: cleartext only.
 */
import { createConnection, createServer } from 'node:net'
import type { AddressInfo, Server as NetServer, Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { parser as mqttParser } from 'mqtt-packet'
import type { Parser } from 'mqtt-packet'
import type { RecordedExchange, RecordedMqttPacket } from '../shared/model'
import { mqttConnectIdentity, summarizeMqttPacket } from '../core/record/mqtt-packets'
import { WS_PREVIEW_CAP } from './record-proxy'

export type MqttProxyState = 'idle' | 'listening' | 'stopped'

/** The default MQTT port, used when the target names no port. */
const DEFAULT_BROKER_PORT = 1883

/**
 * Session capture caps, mirroring the WebSocket ones: a long-lived subscriber
 * is a single exchange that would otherwise grow recorded.jsonl without bound.
 * The preview cap is literally the WS one — an MQTT payload and a WS frame are
 * the same tradeoff, and two numbers would just drift apart.
 */
export const MQTT_PACKET_CAP = 200
export const MQTT_PREVIEW_CAP = WS_PREVIEW_CAP

export interface MqttProxyStartArgs {
  /** Broker to relay to: mqtt://host[:port] (or a bare host[:port]). */
  target: string
  /** 0 (default) picks an ephemeral port. */
  port?: number
  /** Defaults to 127.0.0.1 — never bind 0.0.0.0 implicitly. */
  host?: string
}

export interface MqttRecordProxyEvents {
  exchange: (entry: RecordedExchange) => void
  error: (err: Error) => void
}

/** Parse a broker target into host/port. Throws on anything not cleartext MQTT. */
function parseBrokerTarget(target: string): { host: string; port: number } {
  const text = target.trim()
  if (text === '') throw new Error('Broker address is required (e.g. mqtt://127.0.0.1:1883)')
  // A bare host[:port] is accepted for the same reason grpcurl accepts one —
  // but only after the schemed forms have had their say, so mqtts:// is
  // rejected as unsupported rather than read as a hostname.
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `mqtt://${text}`
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Invalid broker address: ${target}`)
  }
  if (parsed.protocol === 'mqtts:' || parsed.protocol === 'ssl:') {
    throw new Error('TLS brokers (mqtts://) are not supported by the recording relay yet')
  }
  if (parsed.protocol !== 'mqtt:' && parsed.protocol !== 'tcp:') {
    throw new Error('Broker address must be an mqtt:// URL')
  }
  if (parsed.hostname === '') throw new Error(`Invalid broker address: ${target}`)
  return {
    host: parsed.hostname,
    port: parsed.port === '' ? DEFAULT_BROKER_PORT : Number(parsed.port)
  }
}

export class MqttRecordProxy {
  private server?: NetServer
  private target?: { host: string; port: number }
  /** Every socket of every live session, force-closed on stop(). */
  private readonly sockets = new Set<Socket>()
  private _state: MqttProxyState = 'idle'
  private _port?: number
  private readonly listeners: { [E in keyof MqttRecordProxyEvents]: MqttRecordProxyEvents[E][] } = {
    exchange: [],
    error: []
  }

  get state(): MqttProxyState {
    return this._state
  }
  get port(): number | undefined {
    return this._port
  }

  on<E extends keyof MqttRecordProxyEvents>(event: E, cb: MqttRecordProxyEvents[E]): this {
    this.listeners[event].push(cb)
    return this
  }

  private emit<E extends keyof MqttRecordProxyEvents>(
    event: E,
    ...args: Parameters<MqttRecordProxyEvents[E]>
  ): void {
    for (const cb of this.listeners[event]) {
      ;(cb as (...a: Parameters<MqttRecordProxyEvents[E]>) => void)(...args)
    }
  }

  /**
   * One client connection: relay it to the broker and decode a copy. Recorded
   * as a single exchange when the client socket closes, the way a WebSocket
   * session is.
   */
  private handleConnection(client: Socket): void {
    const target = this.target as { host: string; port: number }
    const at = new Date().toISOString()
    const started = Date.now()
    const url = `mqtt://${target.host}:${target.port}`

    const packets: RecordedMqttPacket[] = []
    let clientId: string | undefined
    let protocolVersion: number | undefined
    /** A DISCONNECT makes the close orderly; without one it is abnormal. */
    let sawDisconnect = false
    let sessionError: string | undefined

    const record = (dir: 'send' | 'recv', packet: unknown): void => {
      const p = packet as Parameters<typeof summarizeMqttPacket>[0]
      const identity = mqttConnectIdentity(p)
      if (identity !== null) {
        clientId ??= identity.clientId
        protocolVersion ??= identity.protocolVersion
      }
      if (p.cmd === 'disconnect') sawDisconnect = true
      if (packets.length >= MQTT_PACKET_CAP) return
      packets.push(summarizeMqttPacket(p, dir, new Date().toISOString(), MQTT_PREVIEW_CAP))
    }

    let sendParser: Parser | undefined
    let recvParser: Parser | undefined
    /** Set once a direction's parser is gone, so it is never rebuilt. */
    const dead = { send: false, recv: false }
    const drop = (dir: 'send' | 'recv'): void => {
      dead[dir] = true
      if (dir === 'send') sendParser = undefined
      else recvParser = undefined
    }
    const makeParser = (dir: 'send' | 'recv', version: number): Parser => {
      const p = mqttParser({ protocolVersion: version })
      p.on('packet', (packet) => record(dir, packet))
      // Decoding is best-effort; the relay is not. Dropping the parser stops
      // this direction's capture and leaves the byte pipe untouched.
      p.on('error', () => drop(dir))
      return p
    }
    sendParser = makeParser('send', 4)
    const feed = (dir: 'send' | 'recv', chunk: Buffer): void => {
      if (dead[dir]) return
      // The broker direction can only be read once the CONNECT has named the
      // protocol version — which it always has, because the client's bytes are
      // teed before they are forwarded, so no reply can precede them.
      if (dir === 'recv' && recvParser === undefined) recvParser = makeParser('recv', protocolVersion ?? 4)
      const parser = dir === 'send' ? sendParser : recvParser
      if (parser === undefined) return
      try {
        parser.parse(chunk)
      } catch {
        drop(dir) // a parser that threw rather than emitted is still just a parser
      }
    }

    const upstream = createConnection({ host: target.host, port: target.port })
    for (const s of [client, upstream]) {
      this.sockets.add(s)
      s.on('close', () => this.sockets.delete(s))
    }

    let emitted = false
    const emitSession = (): void => {
      if (emitted) return
      emitted = true
      // Mirrors the WebSocket session rule: an abnormal close (no DISCONNECT,
      // i.e. the peer vanished) is errored even without an error event. Only
      // when the client direction decoded to the end, though: `sawDisconnect`
      // is a decode result, and a dropped decoder makes it mean "not seen",
      // not "not sent". A transport error (sessionError) is the relay's own
      // observation and stands either way.
      const missedDisconnect = !sawDisconnect && !dead.send
      const error = sessionError ?? (missedDisconnect ? 'connection closed without DISCONNECT' : undefined)
      // `dead` is only ever set by a parser failure, so it is exactly the set of
      // directions whose capture stopped early.
      const decodeStopped = (['send', 'recv'] as const).filter((d) => dead[d])
      this.emit('exchange', {
        id: randomUUID(),
        at,
        timeMs: Date.now() - started,
        protocol: 'mqtt',
        method: 'MQTT',
        url,
        // No status: MQTT has no HTTP status and inventing one would be a lie.
        requestHeaders: [],
        errored: error !== undefined,
        ...(error !== undefined ? { error } : {}),
        mqtt: {
          ...(clientId !== undefined ? { clientId } : {}),
          ...(protocolVersion !== undefined ? { protocolVersion } : {}),
          packets,
          // Only when a decoder actually died: the field's absence is how a
          // fully-decoded session (and every older recording) reads.
          ...(decodeStopped.length > 0 ? { decodeStopped } : {})
        }
      })
    }

    // Tee before pipe: the listeners run in registration order, so a packet is
    // decoded before it is forwarded — which is what lets the broker-direction
    // parser rely on having seen the CONNECT.
    client.on('data', (c: Buffer) => feed('send', c))
    upstream.on('data', (c: Buffer) => feed('recv', c))
    client.pipe(upstream)
    upstream.pipe(client)

    client.on('error', (e: Error) => {
      sessionError ??= e.message
      upstream.destroy()
      client.destroy()
    })
    upstream.on('error', (e: Error) => {
      sessionError ??= e.message
      client.destroy()
      upstream.destroy()
    })
    // The client socket is the session: it outlives the broker leg (pipe ends
    // it when the broker hangs up), so its close is the one terminal event.
    client.on('close', () => {
      upstream.destroy()
      emitSession()
    })
  }

  /** Start listening. Rejects on an invalid broker address or unbindable port. */
  async start(args: MqttProxyStartArgs): Promise<{ port: number }> {
    if (this._state === 'listening') throw new Error('MQTT record proxy is already running')
    this.target = parseBrokerTarget(args.target)
    const host = args.host ?? '127.0.0.1'

    const server = createServer((socket) => this.handleConnection(socket))
    this.server = server

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

  /** Stop listening, force-closing every live session's sockets. */
  async stop(): Promise<void> {
    const server = this.server
    if (server === undefined) {
      this._state = 'stopped'
      return
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      // Sessions are long-lived by design (a subscriber holds its socket open
      // forever), so closing the listener alone would never resolve.
      for (const s of this.sockets) s.destroy()
    })
    this.sockets.clear()
    this.server = undefined
    this._port = undefined
    this._state = 'stopped'
  }
}
