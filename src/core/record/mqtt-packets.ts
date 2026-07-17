/**
 * MQTT control packet -> RecordedMqttPacket (the record proxy's MQTT view).
 * Pure and never throws: the engine owns the mqtt-packet parser and the
 * sockets, this owns the decision of what is worth recording about a packet.
 *
 * The input is deliberately a STRUCTURAL type rather than mqtt-packet's own
 * `Packet` union: keeping the dependency on the engine side lets these tests
 * feed plain objects (including malformed ones — a relay decodes whatever is
 * on the wire, not whatever the types promise), and keeps core/ importable
 * from the renderer.
 *
 * Only the fields worth a column survive. The relay is transparent, so nothing
 * here is interpreted or acted on: the broker remains the authority on what a
 * packet means, this is a display record of what went past.
 */
import { asText, toBase64 } from './bytes'
import type { RecordedMqttPacket } from '@shared/model'

/**
 * The subset of an mqtt-packet `Packet` this reads. Every field is optional
 * and re-checked at runtime: a packet decoded off a live wire may be any of
 * the 15 control types, and a hostile or buggy peer may send nonsense.
 */
export interface MqttPacketLike {
  cmd?: unknown
  messageId?: unknown
  qos?: unknown
  retain?: unknown
  dup?: unknown
  topic?: unknown
  payload?: unknown
  clientId?: unknown
  protocolVersion?: unknown
  subscriptions?: unknown
  unsubscriptions?: unknown
  /** A real packet carries more than this reads (properties, will, granted…). */
  [key: string]: unknown
}

/** A capped payload preview: printable UTF-8, else base64. */
interface Preview {
  preview: string
  truncated?: boolean
  base64?: boolean
}

function previewBytes(bytes: Uint8Array, cap: number): Preview {
  const truncated = bytes.length > cap
  const head = truncated ? bytes.subarray(0, cap) : bytes
  // A cut payload can end mid-codepoint, which would fail the strict UTF-8
  // decode and demote readable text to base64. A UTF-8 sequence is at most 4
  // bytes, so retrying 3 shorter slices is enough to find the last whole one.
  for (let trim = 0; trim <= (truncated ? 3 : 0) && trim < head.length; trim++) {
    const text = asText(head.subarray(0, head.length - trim))
    if (text !== null) return { preview: text, ...(truncated ? { truncated: true } : {}) }
  }
  return { preview: toBase64(head), base64: true, ...(truncated ? { truncated: true } : {}) }
}

/** Payload bytes of a PUBLISH, whatever the parser handed back. */
function payloadBytes(payload: unknown): Uint8Array | null {
  if (payload instanceof Uint8Array) return payload
  // mqtt-packet hands back a string when the packet was built, not parsed.
  if (typeof payload === 'string') return new TextEncoder().encode(payload)
  return null
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/** The `topic (qos N)` list a SUBSCRIBE/UNSUBSCRIBE carries, or null. */
function subscriptionList(packet: MqttPacketLike): { topic: string; qos?: number }[] | null {
  if (Array.isArray(packet.subscriptions)) {
    const subs = packet.subscriptions
      .map((s) => {
        const topic = str((s as MqttPacketLike | null)?.topic)
        return topic !== undefined ? { topic, ...(num((s as MqttPacketLike).qos) !== undefined ? { qos: num((s as MqttPacketLike).qos) } : {}) } : null
      })
      .filter((s): s is { topic: string; qos?: number } => s !== null)
    return subs.length > 0 ? subs : null
  }
  if (Array.isArray(packet.unsubscriptions)) {
    const subs = packet.unsubscriptions.filter((t): t is string => typeof t === 'string').map((topic) => ({ topic }))
    return subs.length > 0 ? subs : null
  }
  return null
}

/**
 * One decoded packet as it will be recorded. `at` and `dir` are the relay's to
 * know; `previewCap` is passed in so the engine's cap stays the one number
 * that decides how much of a payload is kept.
 */
export function summarizeMqttPacket(
  packet: MqttPacketLike,
  dir: 'send' | 'recv',
  at: string,
  previewCap: number
): RecordedMqttPacket {
  const type = str(packet.cmd) ?? 'unknown'
  const out: RecordedMqttPacket = { dir, at, type }

  const messageId = num(packet.messageId)
  if (messageId !== undefined) out.messageId = messageId

  const subs = subscriptionList(packet)
  if (subs !== null) {
    // `topic` names the first subscription only — SUBSCRIBE is legally a batch.
    // The preview carries the whole list so the record stays honest, and it is
    // what a reader (and the per-packet save) needs to see.
    out.topic = subs[0].topic
    if (subs[0].qos !== undefined) out.qos = subs[0].qos
    out.preview = subs.map((s) => (s.qos !== undefined ? `${s.topic} (qos ${s.qos})` : s.topic)).join(', ')
    return out
  }

  const topic = str(packet.topic)
  if (topic !== undefined) out.topic = topic
  const qos = num(packet.qos)
  if (qos !== undefined) out.qos = qos
  if (bool(packet.retain) === true) out.retain = true
  if (bool(packet.dup) === true) out.dup = true

  const bytes = payloadBytes(packet.payload)
  if (bytes !== null && bytes.length > 0) {
    const p = previewBytes(bytes, previewCap)
    out.preview = p.preview
    if (p.truncated === true) out.truncated = true
    if (p.base64 === true) out.base64 = true
  }
  return out
}

/**
 * The CONNECT identity worth pinning on the session. Returns null for every
 * other packet type, so the relay can feed it every packet and take the first
 * hit rather than special-casing the type at the call site.
 */
export function mqttConnectIdentity(
  packet: MqttPacketLike
): { clientId?: string; protocolVersion?: number } | null {
  if (str(packet.cmd) !== 'connect') return null
  const clientId = str(packet.clientId)
  const protocolVersion = num(packet.protocolVersion)
  return {
    ...(clientId !== undefined && clientId !== '' ? { clientId } : {}),
    ...(protocolVersion !== undefined ? { protocolVersion } : {})
  }
}
