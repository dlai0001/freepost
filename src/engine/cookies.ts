/**
 * In-memory cookie jar (deliberately simple, per PLAN.md M2 scope):
 * - stores cookies by exact host + path
 * - matching: exact host match (case-insensitive) + RFC 6265 path-prefix match
 * - honors Expires / Max-Age (Max-Age wins); expired = deleted
 * - Secure cookies are withheld from plain-http requests only
 * - Domain attribute is ignored (exact-host model)
 * - SameSite is parsed and stored as display metadata only (no send semantics)
 */
import type { CookieRecord } from '../shared/model'

export type { CookieRecord }

/** RFC 6265 §5.1.4 default-path from the request URI. */
function defaultPath(pathname: string): string {
  if (!pathname.startsWith('/')) return '/'
  const lastSlash = pathname.lastIndexOf('/')
  if (lastSlash <= 0) return '/'
  return pathname.slice(0, lastSlash)
}

/** RFC 6265 §5.1.4 path-match. */
function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true
  if (!requestPath.startsWith(cookiePath)) return false
  if (cookiePath.endsWith('/')) return true
  return requestPath[cookiePath.length] === '/'
}

function parseSameSite(val: string): CookieRecord['sameSite'] {
  const v = val.toLowerCase()
  if (v === 'strict') return 'Strict'
  if (v === 'lax') return 'Lax'
  if (v === 'none') return 'None'
  return undefined
}

export class CookieJar {
  private cookies: CookieRecord[] = []

  /** Store every Set-Cookie header from a response to `url`. */
  storeFromResponse(url: URL | string, setCookieHeaders: string[]): void {
    const u = typeof url === 'string' ? new URL(url) : url
    for (const line of setCookieHeaders) this.storeOne(u, line)
  }

  private storeOne(url: URL, line: string): void {
    const [nameValue, ...attrs] = line.split(';')
    const eq = nameValue.indexOf('=')
    if (eq <= 0) return // no name
    const name = nameValue.slice(0, eq).trim()
    const value = nameValue.slice(eq + 1).trim()
    if (!name) return

    let path = defaultPath(url.pathname || '/')
    let expires: number | null = null
    let sawMaxAge = false
    let secure = false
    let httpOnly = false
    let sameSite: CookieRecord['sameSite']
    for (const attr of attrs) {
      const attrEq = attr.indexOf('=')
      const key = (attrEq >= 0 ? attr.slice(0, attrEq) : attr).trim().toLowerCase()
      const val = attrEq >= 0 ? attr.slice(attrEq + 1).trim() : ''
      if (key === 'path' && val.startsWith('/')) {
        path = val
      } else if (key === 'max-age') {
        const n = Number(val)
        if (!Number.isNaN(n)) {
          expires = Date.now() + n * 1000
          sawMaxAge = true
        }
      } else if (key === 'expires' && !sawMaxAge) {
        const t = Date.parse(val)
        if (!Number.isNaN(t)) expires = t
      } else if (key === 'secure') {
        secure = true
      } else if (key === 'httponly') {
        httpOnly = true
      } else if (key === 'samesite') {
        sameSite = parseSameSite(val)
      }
      // Domain attribute intentionally ignored: exact-host model.
    }

    const domain = url.hostname.toLowerCase()
    // Replace any existing cookie with the same identity.
    this.cookies = this.cookies.filter(
      (c) => !(c.name === name && c.domain === domain && c.path === path)
    )
    // An already-expired cookie is a deletion instruction.
    if (expires !== null && expires <= Date.now()) return
    this.cookies.push({ name, value, domain, path, expires, secure, httpOnly, sameSite })
  }

  /** Cookie header value for a request to `url`, or undefined when none match. */
  cookieHeader(url: URL | string): string | undefined {
    const u = typeof url === 'string' ? new URL(url) : url
    const host = u.hostname.toLowerCase()
    const requestPath = u.pathname || '/'
    const isHttps = u.protocol === 'https:'
    this.purgeExpired()
    const matches = this.cookies.filter(
      (c) =>
        c.domain === host &&
        pathMatches(requestPath, c.path) &&
        (isHttps || !c.secure) // withhold Secure cookies over plain http
    )
    if (matches.length === 0) return undefined
    // Longer (more specific) paths first, per RFC 6265 §5.4.
    matches.sort((a, b) => b.path.length - a.path.length)
    return matches.map((c) => `${c.name}=${c.value}`).join('; ')
  }

  /** Snapshot of all live cookies (for UI display). */
  list(): CookieRecord[] {
    this.purgeExpired()
    return this.cookies.map((c) => ({ ...c }))
  }

  /** Upsert a cookie by domain+path+name (manual add/edit from the UI). */
  setCookie(record: CookieRecord): void {
    const domain = record.domain.toLowerCase()
    this.cookies = this.cookies.filter(
      (c) => !(c.name === record.name && c.domain === domain && c.path === record.path)
    )
    this.cookies.push({ ...record, domain })
  }

  /** Remove one cookie by identity. */
  deleteCookie(domain: string, path: string, name: string): void {
    const d = domain.toLowerCase()
    this.cookies = this.cookies.filter(
      (c) => !(c.name === name && c.domain === d && c.path === path)
    )
  }

  /** Empty the jar, optionally scoped to one domain and/or session cookies only. */
  clear(scope?: { domain?: string; sessionOnly?: boolean }): void {
    if (scope === undefined || (scope.domain === undefined && scope.sessionOnly !== true)) {
      this.cookies = []
      return
    }
    const domain = scope.domain?.toLowerCase()
    this.cookies = this.cookies.filter((c) => {
      if (domain !== undefined && c.domain !== domain) return true
      if (scope.sessionOnly === true && c.expires !== null) return true
      return false
    })
  }

  /** Serializable snapshot, session cookies included. */
  toJSON(): CookieRecord[] {
    this.purgeExpired()
    return this.cookies.map((c) => ({ ...c }))
  }

  /**
   * Rebuild a jar from persisted records. Expired persistent cookies are
   * dropped; session cookies are kept — they live for the app-restart
   * lifetime by design (matching other API-client tools).
   */
  static fromJSON(records: CookieRecord[]): CookieJar {
    const jar = new CookieJar()
    const now = Date.now()
    for (const r of records) {
      if (r.expires !== null && r.expires <= now) continue
      jar.setCookie(r)
    }
    return jar
  }

  private purgeExpired(): void {
    const now = Date.now()
    this.cookies = this.cookies.filter((c) => c.expires === null || c.expires > now)
  }
}
