/**
 * Cookie import/export formats. Pure — no network, no DOM, safe in both the
 * main process and the renderer.
 *
 * Supported formats:
 *  - JSON (our canonical shape plus common browser-extension export shapes)
 *  - Netscape cookies.txt (curl/wget compatible, incl. the #HttpOnly_ prefix)
 *  - Cookie request-header string ("a=1; b=2")
 *  - Set-Cookie response lines (one cookie per line, full attributes)
 */
import type { CookieRecord } from './types'

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/** Serialize cookies as pretty JSON with a stable field order. */
export function toJson(cookies: CookieRecord[]): string {
  const ordered = cookies.map((c) => {
    const o: Record<string, unknown> = {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      secure: c.secure,
      httpOnly: c.httpOnly
    }
    if (c.sameSite !== undefined) o.sameSite = c.sameSite
    return o
  })
  return JSON.stringify(ordered, null, 2) + '\n'
}

const SAME_SITE_MAP: Record<string, CookieRecord['sameSite']> = {
  strict: 'Strict',
  lax: 'Lax',
  none: 'None',
  no_restriction: 'None'
}

function normalizeSameSite(v: unknown): CookieRecord['sameSite'] {
  if (typeof v !== 'string') return undefined
  return SAME_SITE_MAP[v.toLowerCase()]
}

/** Normalize one loosely-shaped JSON entry into a CookieRecord, or null. */
function normalizeJsonEntry(raw: unknown): CookieRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (typeof o.name !== 'string') return null

  let expires: number | null = null
  if (o.session !== true) {
    if (typeof o.expires === 'number' && Number.isFinite(o.expires)) {
      // Our own format: epoch milliseconds.
      expires = Math.round(o.expires)
    } else if (typeof o.expirationDate === 'number' && Number.isFinite(o.expirationDate)) {
      // Browser-extension exports: epoch SECONDS (often a float).
      expires = Math.round(o.expirationDate * 1000)
    } else if (typeof o.expires === 'string') {
      const t = Date.parse(o.expires)
      if (!Number.isNaN(t)) expires = t
    }
  }

  return {
    name: o.name,
    value: typeof o.value === 'string' ? o.value : String(o.value ?? ''),
    domain: typeof o.domain === 'string' ? o.domain : '',
    path: typeof o.path === 'string' && o.path !== '' ? o.path : '/',
    expires,
    secure: o.secure === true,
    httpOnly: o.httpOnly === true,
    sameSite: normalizeSameSite(o.sameSite)
  }
}

/**
 * Parse JSON cookies. Accepts our own export shape and common browser
 * extension shapes (expirationDate in seconds, session flags, sameSite in
 * assorted casings). Entries that are not cookie-shaped are skipped.
 * Throws on text that is not JSON or not an array/single object.
 */
export function parseJson(text: string): CookieRecord[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Not valid JSON')
  }
  const list = Array.isArray(parsed) ? parsed : [parsed]
  const out: CookieRecord[] = []
  for (const entry of list) {
    const c = normalizeJsonEntry(entry)
    if (c !== null) out.push(c)
  }
  if (out.length === 0 && list.length > 0) {
    throw new Error('JSON does not contain any cookie objects')
  }
  return out
}

// ---------------------------------------------------------------------------
// Netscape cookies.txt
// ---------------------------------------------------------------------------

const HTTPONLY_PREFIX = '#HttpOnly_'

/**
 * Serialize to Netscape cookies.txt. 7 TAB-separated fields per line:
 * domain, includeSubdomains, path, secure, expiry (epoch seconds, 0=session),
 * name, value. HttpOnly cookies are written with the #HttpOnly_ domain prefix.
 * SameSite cannot be represented and is dropped.
 */
export function toNetscape(cookies: CookieRecord[]): string {
  const lines = ['# Netscape HTTP Cookie File']
  for (const c of cookies) {
    const domainField = (c.httpOnly ? HTTPONLY_PREFIX : '') + c.domain
    const includeSubdomains = c.domain.startsWith('.') ? 'TRUE' : 'FALSE'
    const expiry = c.expires === null ? '0' : String(Math.floor(c.expires / 1000))
    lines.push(
      [domainField, includeSubdomains, c.path, c.secure ? 'TRUE' : 'FALSE', expiry, c.name, c.value].join('\t')
    )
  }
  return lines.join('\n') + '\n'
}

/**
 * Parse Netscape cookies.txt. Lines starting with #HttpOnly_ are cookies with
 * httpOnly=true (the prefix is stripped from the domain); other #-lines and
 * blank lines are skipped. Malformed lines are skipped silently.
 */
export function parseNetscape(text: string): CookieRecord[] {
  const out: CookieRecord[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (line.trim() === '') continue
    let httpOnly = false
    let body = line
    if (line.startsWith(HTTPONLY_PREFIX)) {
      httpOnly = true
      body = line.slice(HTTPONLY_PREFIX.length)
    } else if (line.startsWith('#')) {
      continue
    }
    const fields = body.split('\t')
    if (fields.length !== 7) continue
    const [domain, , path, secure, expiry, name, value] = fields
    const expirySeconds = Number(expiry)
    if (!Number.isFinite(expirySeconds)) continue
    out.push({
      name,
      value,
      domain,
      path,
      expires: expirySeconds === 0 ? null : expirySeconds * 1000,
      secure: secure.toUpperCase() === 'TRUE',
      httpOnly
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Cookie header string
// ---------------------------------------------------------------------------

/** Serialize as a Cookie request-header value: "a=1; b=2". */
export function toCookieHeader(cookies: CookieRecord[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
}

/**
 * Parse a Cookie header value ("a=1; b=2") into records. Pairs without an
 * equals sign are skipped. Cookies get the supplied defaults, no expiry
 * (session), and secure/httpOnly false — a Cookie header carries no attributes.
 */
export function parseCookieHeader(
  text: string,
  defaults: { domain: string; path: string }
): CookieRecord[] {
  const out: CookieRecord[] = []
  const value = text.replace(/^\s*cookie\s*:/i, '')
  for (const part of value.split(';')) {
    const trimmed = part.trim()
    if (trimmed === '') continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    out.push({
      name: trimmed.slice(0, eq).trim(),
      value: trimmed.slice(eq + 1).trim(),
      domain: defaults.domain,
      path: defaults.path,
      expires: null,
      secure: false,
      httpOnly: false
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Set-Cookie
// ---------------------------------------------------------------------------

/** Serialize one cookie as a full Set-Cookie line with all attributes. */
export function toSetCookie(cookie: CookieRecord): string {
  const parts = [`${cookie.name}=${cookie.value}`]
  if (cookie.domain !== '') parts.push(`Domain=${cookie.domain}`)
  if (cookie.path !== '') parts.push(`Path=${cookie.path}`)
  if (cookie.expires !== null) parts.push(`Expires=${new Date(cookie.expires).toUTCString()}`)
  if (cookie.secure) parts.push('Secure')
  if (cookie.httpOnly) parts.push('HttpOnly')
  if (cookie.sameSite !== undefined) parts.push(`SameSite=${cookie.sameSite}`)
  return parts.join('; ')
}

/** Serialize cookies as one Set-Cookie line per cookie. */
export function toSetCookieLines(cookies: CookieRecord[]): string {
  return cookies.map(toSetCookie).join('\n')
}

/**
 * Parse a single raw Set-Cookie line. Returns null when there is no
 * name=value pair. Attribute names are case-insensitive; Max-Age takes
 * precedence over Expires (Max-Age <= 0 yields an already-past expires — the
 * caller decides what to do with expired cookies); unknown attributes are
 * ignored. A leading "Set-Cookie:" prefix is tolerated.
 */
export function parseSetCookie(line: string, defaultDomain: string): CookieRecord | null {
  const body = line.replace(/^\s*set-cookie\s*:/i, '').trim()
  if (body === '') return null
  const segments = body.split(';')
  const first = segments[0].trim()
  const eq = first.indexOf('=')
  if (eq <= 0) return null

  const cookie: CookieRecord = {
    name: first.slice(0, eq).trim(),
    value: first.slice(eq + 1).trim(),
    domain: defaultDomain,
    path: '/',
    expires: null,
    secure: false,
    httpOnly: false
  }

  let sawMaxAge = false
  for (const segment of segments.slice(1)) {
    const trimmed = segment.trim()
    if (trimmed === '') continue
    const attrEq = trimmed.indexOf('=')
    const attrName = (attrEq === -1 ? trimmed : trimmed.slice(0, attrEq)).trim().toLowerCase()
    const attrValue = attrEq === -1 ? '' : trimmed.slice(attrEq + 1).trim()
    switch (attrName) {
      case 'domain':
        if (attrValue !== '') cookie.domain = attrValue.replace(/^\./, '')
        break
      case 'path':
        if (attrValue !== '') cookie.path = attrValue
        break
      case 'expires': {
        if (sawMaxAge) break
        const t = Date.parse(attrValue)
        if (!Number.isNaN(t)) cookie.expires = t
        break
      }
      case 'max-age': {
        const seconds = Number(attrValue)
        if (Number.isFinite(seconds)) {
          sawMaxAge = true
          // <= 0 means expire now; represent it as a moment in the past.
          cookie.expires = seconds <= 0 ? Date.now() - 1000 : Date.now() + seconds * 1000
        }
        break
      }
      case 'secure':
        cookie.secure = true
        break
      case 'httponly':
        cookie.httpOnly = true
        break
      case 'samesite': {
        const ss = normalizeSameSite(attrValue)
        if (ss !== undefined) cookie.sameSite = ss
        break
      }
      default:
        break // unknown attribute — ignored per RFC 6265
    }
  }
  return cookie
}

// ---------------------------------------------------------------------------
// Format sniffing
// ---------------------------------------------------------------------------

const SET_COOKIE_ATTR = /(?:^|;)\s*(domain|path|expires|max-age|samesite)\s*=|(?:^|;)\s*(secure|httponly)\s*(?:;|$)/i

function looksLikeNetscapeLine(line: string): boolean {
  return line.split('\t').length === 7
}

/**
 * Best-effort format sniffing for import UX. Never throws; falls back to
 * 'header' for anything cookie-pair-shaped and 'set-cookie' when attribute
 * keywords are present.
 */
export function detectFormat(text: string): 'json' | 'netscape' | 'header' | 'set-cookie' {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed)
      return 'json'
    } catch {
      // fall through
    }
  }
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim() !== '')
  if (/^#\s*Netscape HTTP Cookie File/i.test(trimmed)) return 'netscape'
  const dataLines = lines.filter((l) => !l.startsWith('#') || l.startsWith(HTTPONLY_PREFIX))
  if (dataLines.length > 0 && dataLines.every(looksLikeNetscapeLine)) return 'netscape'
  if (/^\s*set-cookie\s*:/i.test(trimmed)) return 'set-cookie'
  if (lines.length >= 1 && SET_COOKIE_ATTR.test(lines[0])) return 'set-cookie'
  return 'header'
}
