/**
 * socket.io / engine.io packet decoder (the record proxy's WebSocket view).
 * Pure, dependency-free and never throws — the renderer decodes captured frame
 * previews, which the engine caps at 2 KiB, so a payload cut mid-JSON is the
 * normal case rather than a bug.
 *
 * A socket.io frame is engine.io framing around a socket.io packet:
 *
 *   <engine type><engine payload>
 *   4            <socket type>[namespace,][ack id][JSON payload]
 *
 * e.g. `0{"sid":"x"}` (engine OPEN), `3probe` (engine PONG, non-JSON payload),
 * `40` (socket CONNECT), `42["chat",{"msg":"hi"}]` (socket EVENT),
 * `42/admin,17["ev",1]` (EVENT on a namespace, with an ack id).
 *
 * Decoding a frame in isolation is inherently ambiguous — `42[...]` is a
 * socket.io EVENT only because the session is socket.io, and a plain-WS session
 * could send that same text meaning something else. This module never makes
 * that call: the caller decodes only when `isSocketIoUrl` says the session is
 * socket.io, and null here means "not socket.io framing" for anything that
 * can't be a packet (a leading char that isn't an engine.io type, a message
 * frame with no socket.io type).
 *
 * Truncation is reported rather than papered over: when the payload text is
 * present but doesn't parse as JSON it is returned raw in `payloadText` with
 * `payload` unset, so the caller can say the preview was cut instead of
 * rendering a half-decoded value.
 */

/** engine.io packet types (engine.io protocol v4 §Packet). */
const ENGINE_TYPES = ['open', 'close', 'ping', 'pong', 'message', 'upgrade', 'noop'] as const

/** socket.io packet types, only meaningful inside an engine.io `message`. */
const SOCKET_TYPES = [
  'CONNECT',
  'DISCONNECT',
  'EVENT',
  'ACK',
  'CONNECT_ERROR',
  'BINARY_EVENT',
  'BINARY_ACK'
] as const

export interface SocketIoPacket {
  engineType: number
  engineTypeName: string
  /** Present only for engine.io `message` (type 4) frames. */
  socketType?: number
  socketTypeName?: string
  /** BINARY_EVENT/BINARY_ACK: how many binary frames follow as attachments. */
  attachments?: number
  /** Only when explicit — the default namespace ("/") is left undefined. */
  namespace?: string
  ackId?: number
  /** EVENT/BINARY_EVENT only: the first element of the args array. */
  eventName?: string
  /**
   * The decoded JSON. For EVENT/BINARY_EVENT this is the args AFTER the event
   * name (which `eventName` carries), so the caller never renders the name
   * twice; for every other type it is the payload as sent.
   */
  payload?: unknown
  /** The payload text when it did not parse as JSON (truncated or malformed). */
  payloadText?: string
  /** The frame text as captured. */
  raw: string
}

/**
 * True when a WebSocket URL belongs to a socket.io session. Both signals are
 * the client's own: socket.io defaults to the /socket.io/ path, and the
 * engine.io handshake always carries EIO=<version>. Derived from the recorded
 * URL so no model or engine change is needed to know how to decode the frames.
 */
export function isSocketIoUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.pathname.startsWith('/socket.io/') || u.searchParams.has('EIO')
  } catch {
    // Not a parseable URL — fall back to the same two signals textually.
    return url.includes('/socket.io/') || /[?&]EIO=/.test(url)
  }
}

/** The single ASCII digit at `i` when it names a type in `table`, else -1. */
function typeAt(text: string, i: number, table: readonly string[]): number {
  const n = text.charCodeAt(i) - 0x30 // NaN past the end — fails the range test
  return n >= 0 && n < table.length ? n : -1
}

/** Reads the digits at `i`, or null when there are none. */
function readDigits(text: string, i: number): { value: number; next: number } | null {
  let end = i
  while (end < text.length && text[end] >= '0' && text[end] <= '9') end++
  if (end === i) return null
  return { value: Number(text.slice(i, end)), next: end }
}

/** Decode one captured socket.io text frame, or null when it isn't one. */
export function decodeSocketIoPacket(text: string): SocketIoPacket | null {
  const engineType = typeAt(text, 0, ENGINE_TYPES)
  if (engineType === -1) return null
  const engineTypeName = ENGINE_TYPES[engineType]
  const base = { engineType, engineTypeName, raw: text }

  // Non-message frames carry no socket.io packet. Their payload is JSON for
  // OPEN's handshake and free text otherwise (`3probe`), so it is decoded
  // best-effort and left in payloadText when it isn't JSON.
  if (engineType !== 4) return { ...base, ...decodePayload(text.slice(1)) }

  const socketType = typeAt(text, 1, SOCKET_TYPES)
  // A `message` with no socket.io type is not a socket.io packet.
  if (socketType === -1) return null
  let i = 2

  // BINARY_EVENT/BINARY_ACK prefix the packet with `<n>-`: the count of binary
  // attachments that follow as their own frames. It precedes the namespace, and
  // is not an ack id.
  let attachments: number | undefined
  if (socketType === 5 || socketType === 6) {
    const dash = text.indexOf('-', i)
    const count = readDigits(text, i)
    if (count !== null && dash === count.next) {
      attachments = count.value
      i = dash + 1
    }
  }

  let namespace: string | undefined
  if (text[i] === '/') {
    // The namespace runs to the comma; socket.io omits both when it is "/".
    const comma = text.indexOf(',', i)
    namespace = comma === -1 ? text.slice(i) : text.slice(i, comma)
    i = comma === -1 ? text.length : comma + 1
  }

  const ack = readDigits(text, i)
  if (ack !== null) i = ack.next

  const packet: SocketIoPacket = {
    ...base,
    socketType,
    socketTypeName: SOCKET_TYPES[socketType],
    ...(attachments !== undefined ? { attachments } : {}),
    ...(namespace !== undefined && namespace !== '/' ? { namespace } : {}),
    ...(ack !== null ? { ackId: ack.value } : {}),
    ...decodePayload(text.slice(i))
  }

  // EVENT/BINARY_EVENT: ["name", ...args] — hoist the name, keep the args.
  const isEvent = socketType === 2 || socketType === 5
  if (isEvent && Array.isArray(packet.payload) && typeof packet.payload[0] === 'string') {
    return { ...packet, eventName: packet.payload[0], payload: packet.payload.slice(1) }
  }
  return packet
}

/** JSON when it parses, the raw text when it doesn't, nothing when empty. */
function decodePayload(text: string): Pick<SocketIoPacket, 'payload' | 'payloadText'> {
  if (text === '') return {}
  try {
    return { payload: JSON.parse(text) as unknown }
  } catch {
    return { payloadText: text }
  }
}

/** True for the heartbeat/transport frames that are noise in the frame list. */
export function isSocketIoHeartbeat(p: SocketIoPacket): boolean {
  // ping/pong (2/3) plus the probe/noop frames of an upgrade handshake.
  return p.engineType === 2 || p.engineType === 3 || p.engineType === 5 || p.engineType === 6
}
