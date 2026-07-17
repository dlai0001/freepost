/**
 * Byte helpers shared by the capture views (protobuf.ts, mqtt-packets.ts).
 * Pure and dependency-free — no Buffer (main) and no atob (renderer) — so the
 * renderer can render captured bytes without a round-trip to main, and nothing
 * here throws: a truncated capture is the normal case, not a bug.
 *
 * These live in their own module rather than in one of the views because a
 * payload is a payload: a view that reaches into a sibling view for base64
 * would read as a mistake and invite the next one to hand-roll its own.
 */

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard base64 with padding. */
export function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a: number = bytes[i]
    const b: number | undefined = bytes[i + 1]
    const c: number | undefined = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += BASE64_ALPHABET[(n >> 18) & 63] + BASE64_ALPHABET[(n >> 12) & 63]
    out += b === undefined ? '=' : BASE64_ALPHABET[(n >> 6) & 63]
    out += c === undefined ? '=' : BASE64_ALPHABET[n & 63]
  }
  return out
}

/** Inverse of toBase64. Null for anything that isn't well-formed base64. */
export function fromBase64(text: string): Uint8Array | null {
  const clean = text.replace(/[\r\n]/g, '')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) return null
  const out = new Uint8Array((clean.length / 4) * 3)
  let len = 0
  for (let i = 0; i < clean.length; i += 4) {
    let n = 0
    let pad = 0
    for (let j = 0; j < 4; j++) {
      const ch = clean[i + j]
      if (ch === '=') {
        pad++
        n <<= 6
      } else {
        n = (n << 6) | BASE64_ALPHABET.indexOf(ch)
      }
    }
    out[len++] = (n >> 16) & 0xff
    if (pad < 2) out[len++] = (n >> 8) & 0xff
    if (pad < 1) out[len++] = n & 0xff
  }
  return out.subarray(0, len)
}

const UTF8 = new TextDecoder('utf-8', { fatal: true })

/**
 * The payload as text, or null when it isn't one. Valid UTF-8 is not enough:
 * C0 control bytes (bar tab/newline/return) mean the bytes are almost
 * certainly binary that happens to decode, and rendering them as a string
 * would hide that.
 */
export function asText(payload: Uint8Array): string | null {
  let text: string
  try {
    text = UTF8.decode(payload)
  } catch {
    return null
  }
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text) ? null : text
}
