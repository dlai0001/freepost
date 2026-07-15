/**
 * Cookie-value context-menu utilities: encode/decode helpers that never throw
 * on user input (they return null on failure). Pure and environment-agnostic —
 * base64 is implemented by hand so the module works identically in the main
 * process and the renderer without Buffer or atob/btoa.
 */

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const encoder = new TextEncoder()
const strictDecoder = new TextDecoder('utf-8', { fatal: true })

/** Base64-encode a UTF-8 string (standard alphabet, padded). */
export function base64Encode(s: string): string {
  const bytes = encoder.encode(s)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += B64_ALPHABET[b0 >> 2]
    out += B64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)]
    out += i + 1 < bytes.length ? B64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : '='
    out += i + 2 < bytes.length ? B64_ALPHABET[b2 & 0x3f] : '='
  }
  return out
}

const B64_VALUES: Record<string, number> = {}
for (let i = 0; i < B64_ALPHABET.length; i++) B64_VALUES[B64_ALPHABET[i]] = i

/** Decode base64/base64url bytes; null if the input is not valid base64. */
function base64ToBytes(s: string): Uint8Array | null {
  // Normalize: strip whitespace, map base64url chars, drop padding.
  const normalized = s.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  if (normalized.length % 4 === 1) return null
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const ch of normalized) {
    const v = B64_VALUES[ch]
    if (v === undefined) return null
    buffer = (buffer << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  return new Uint8Array(bytes)
}

/**
 * Decode base64 (standard or base64url, padding optional) to a UTF-8 string.
 * Returns null on invalid base64 or invalid UTF-8.
 */
export function base64Decode(s: string): string | null {
  const bytes = base64ToBytes(s)
  if (bytes === null) return null
  try {
    return strictDecoder.decode(bytes)
  } catch {
    return null
  }
}

/** Percent-encode for safe use in a cookie value or URL component. */
export function urlEncode(s: string): string {
  return encodeURIComponent(s)
}

/** Percent-decode; null on malformed escapes. */
export function urlDecode(s: string): string | null {
  try {
    return decodeURIComponent(s)
  } catch {
    return null
  }
}

/**
 * Decode a JWT (three dot-separated base64url segments) without verifying the
 * signature. Returns pretty-printed header and payload JSON, or null when the
 * input is not a structurally valid JWT.
 */
export function jwtDecode(s: string): { header: string; payload: string } | null {
  const segments = s.trim().split('.')
  if (segments.length !== 3) return null
  const decoded: string[] = []
  for (const segment of segments.slice(0, 2)) {
    if (segment === '') return null
    const text = base64Decode(segment)
    if (text === null) return null
    const pretty = jsonPrettyPrint(text)
    if (pretty === null) return null
    decoded.push(pretty)
  }
  return { header: decoded[0], payload: decoded[1] }
}

/** Pretty-print JSON with two-space indentation; null if not valid JSON. */
export function jsonPrettyPrint(s: string): string | null {
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return null
  }
}

/** Printable text: no control characters other than tab/newline/CR. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/

export type ValueKind = 'base64' | 'url-encoded' | 'jwt' | 'json'

/**
 * Detect which decoders would succeed on a value AND produce meaningfully
 * different output — used to decide which context-menu items to enable.
 */
export function detectValueKind(s: string): ValueKind[] {
  const kinds: ValueKind[] = []

  const b64 = base64Decode(s)
  if (
    s.length >= 4 &&
    /^[A-Za-z0-9+/\-_]+=*$/.test(s.trim()) &&
    b64 !== null &&
    b64 !== '' &&
    b64 !== s &&
    !CONTROL_CHARS_RE.test(b64)
  ) {
    kinds.push('base64')
  }

  if (/%[0-9A-Fa-f]{2}/.test(s)) {
    const decoded = urlDecode(s)
    if (decoded !== null && decoded !== s) kinds.push('url-encoded')
  }

  if (jwtDecode(s) !== null) kinds.push('jwt')

  const trimmed = s.trim()
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && jsonPrettyPrint(s) !== null) {
    kinds.push('json')
  }

  return kinds
}
