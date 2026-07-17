/**
 * Schemaless protobuf wire-format decoder (tier 3 of the record proxy's gRPC
 * view). Pure and dependency-free — no protobufjs, no Buffer, no TextEncoder
 * beyond the WHATWG globals — so the renderer can decode a captured message
 * without a round-trip to main. Tier 2 (named fields via .proto files) lives in
 * the engine, which owns the @grpc/proto-loader plumbing.
 *
 * The wire format carries field NUMBERS and wire types, never names or the
 * declared type, so decoding without a schema is inherently ambiguous:
 *   - a varint may be an int32, int64, uint, bool or enum, and the sint types
 *     are zigzagged — values are reported as unsigned decimal text, i.e. the
 *     raw wire meaning;
 *   - fixed32/fixed64 may be a float/double — reported as unsigned ints;
 *   - a length-delimited field may be a nested message, a string, bytes, or a
 *     packed repeated field. Resolution order matches mitmproxy's: nested
 *     message if the payload parses cleanly and completely, else a string if
 *     it is valid printable UTF-8, else raw bytes.
 * Repeated fields simply appear as several entries with the same field number.
 *
 * Nothing here throws: malformed input yields the fields decoded so far plus an
 * `error` marker, because a truncated capture is the normal case, not a bug.
 */
import { asText, fromBase64, toBase64 } from './bytes'

/** One decoded field. `kind` is the *interpretation*, not the wire type. */
export type ProtobufField =
  | { field: number; kind: 'varint'; value: string }
  | { field: number; kind: 'fixed64'; value: string }
  | { field: number; kind: 'fixed32'; value: string }
  | { field: number; kind: 'message'; fields: ProtobufField[] }
  | { field: number; kind: 'string'; text: string }
  | { field: number; kind: 'bytes'; bytes: number; base64: string }

/** A decoded message. `error` set means `fields` is what parsed before it. */
export interface ProtobufMessage {
  fields: ProtobufField[]
  error?: string
}

/** A varint is at most 10 bytes (64 bits at 7 bits per byte). */
const MAX_VARINT_BYTES = 10

/**
 * Nested-message recursion limit. Hostile or coincidental bytes can nest
 * arbitrarily deep; past this the payload is reported as a string/bytes leaf.
 */
const MAX_DEPTH = 16

/** Thrown inside the parser only — decodeProtobuf turns it into `error`. */
class WireError extends Error {}

class Reader {
  offset = 0
  constructor(private readonly buf: Uint8Array) {}

  get done(): boolean {
    return this.offset >= this.buf.length
  }

  private byte(): number {
    const b: number | undefined = this.buf[this.offset]
    if (b === undefined) throw new WireError('input ended mid-field')
    this.offset++
    return b
  }

  varint(): bigint {
    let value = 0n
    for (let i = 0; i < MAX_VARINT_BYTES; i++) {
      const b = this.byte()
      value |= BigInt(b & 0x7f) << BigInt(7 * i)
      if ((b & 0x80) === 0) return value
    }
    throw new WireError('varint is longer than 10 bytes')
  }

  /** Little-endian fixed-width integer (n = 4 or 8). */
  fixed(n: number): bigint {
    let value = 0n
    for (let i = 0; i < n; i++) value |= BigInt(this.byte()) << BigInt(8 * i)
    return value
  }

  take(len: number): Uint8Array {
    if (!Number.isSafeInteger(len) || len < 0 || this.offset + len > this.buf.length) {
      throw new WireError('length-delimited field runs past the end of the input')
    }
    const out = this.buf.subarray(this.offset, this.offset + len)
    this.offset += len
    return out
  }
}

/** The payload's fields when it parses cleanly and completely, else null. */
function asMessage(payload: Uint8Array, depth: number): ProtobufField[] | null {
  if (depth >= MAX_DEPTH || payload.length === 0) return null
  const r = new Reader(payload)
  const fields: ProtobufField[] = []
  try {
    while (!r.done) fields.push(readField(r, depth + 1))
  } catch {
    return null // not a message (or not this one) — the caller falls back
  }
  return fields.length > 0 ? fields : null
}

function readField(r: Reader, depth: number): ProtobufField {
  const tag = r.varint()
  const field = Number(tag >> 3n)
  const wire = Number(tag & 7n)
  if (field === 0) throw new WireError('field number 0 is not valid')
  switch (wire) {
    case 0:
      return { field, kind: 'varint', value: r.varint().toString() }
    case 1:
      return { field, kind: 'fixed64', value: r.fixed(8).toString() }
    case 2: {
      const payload = r.take(Number(r.varint()))
      const nested = asMessage(payload, depth)
      if (nested !== null) return { field, kind: 'message', fields: nested }
      const text = asText(payload)
      if (text !== null) return { field, kind: 'string', text }
      return { field, kind: 'bytes', bytes: payload.length, base64: toBase64(payload) }
    }
    case 5:
      return { field, kind: 'fixed32', value: r.fixed(4).toString() }
    default:
      // 3/4 are the removed group encoding; 6/7 have never been assigned.
      throw new WireError(`unsupported wire type ${wire} on field ${field}`)
  }
}

/** Decode protobuf wire bytes without a schema. Never throws. */
export function decodeProtobuf(bytes: Uint8Array): ProtobufMessage {
  const r = new Reader(bytes)
  const fields: ProtobufField[] = []
  try {
    while (!r.done) fields.push(readField(r, 0))
    return { fields }
  } catch (e) {
    return { fields, error: e instanceof Error ? e.message : String(e) }
  }
}

/** decodeProtobuf for a captured (base64) payload. Never throws. */
export function decodeProtobufBase64(base64: string): ProtobufMessage {
  const bytes = fromBase64(base64)
  if (bytes === null) return { fields: [], error: 'payload is not valid base64' }
  return decodeProtobuf(bytes)
}

/**
 * Render a decoded message as an indented field-number tree (protoscope-like),
 * which is what the History ▸ Recorded detail shows when no protos are
 * attached. Field numbers, never names — there is no schema at this tier.
 */
export function formatProtobuf(msg: ProtobufMessage, indent = ''): string {
  const lines: string[] = []
  for (const f of msg.fields) {
    if (f.kind === 'message') {
      lines.push(`${indent}${f.field} {`)
      const inner = formatProtobuf({ fields: f.fields }, `${indent}  `)
      if (inner !== '') lines.push(inner)
      lines.push(`${indent}}`)
    } else if (f.kind === 'string') {
      lines.push(`${indent}${f.field}: ${JSON.stringify(f.text)}`)
    } else if (f.kind === 'bytes') {
      lines.push(`${indent}${f.field}: (${f.bytes} bytes, base64) ${f.base64}`)
    } else {
      lines.push(`${indent}${f.field}: ${f.value}`)
    }
  }
  if (msg.error !== undefined) lines.push(`${indent}(decode stopped: ${msg.error})`)
  return lines.join('\n')
}
