/**
 * In-memory cookie jar (deliberately simple, per PLAN.md M2 scope):
 * - stores cookies by exact host + path
 * - matching: exact host match (case-insensitive) + RFC 6265 path-prefix match
 * - honors Expires / Max-Age (Max-Age wins); expired = deleted
 * - Secure cookies are withheld from plain-http requests only
 * - Domain attribute is ignored (exact-host model)
 */

export interface StoredCookie {
  name: string
  value: string
  /** Exact host the cookie was set by (lowercase). */
  domain: string
  path: string
  /** Epoch ms; undefined = session cookie. */
  expires?: number
  secure: boolean
}

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

export class CookieJar {
  private cookies: StoredCookie[] = []

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
    let expires: number | undefined
    let sawMaxAge = false
    let secure = false
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
      }
      // Domain attribute intentionally ignored: exact-host model.
    }

    const domain = url.hostname.toLowerCase()
    // Replace any existing cookie with the same identity.
    this.cookies = this.cookies.filter(
      (c) => !(c.name === name && c.domain === domain && c.path === path)
    )
    // An already-expired cookie is a deletion instruction.
    if (expires !== undefined && expires <= Date.now()) return
    this.cookies.push({ name, value, domain, path, expires, secure })
  }

  /** Cookie header value for a request to `url`, or undefined when none match. */
  cookieHeader(url: URL | string): string | undefined {
    const u = typeof url === 'string' ? new URL(url) : url
    const host = u.hostname.toLowerCase()
    const requestPath = u.pathname || '/'
    const isHttps = u.protocol === 'https:'
    const now = Date.now()
    this.cookies = this.cookies.filter((c) => c.expires === undefined || c.expires > now)
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
  list(): StoredCookie[] {
    const now = Date.now()
    this.cookies = this.cookies.filter((c) => c.expires === undefined || c.expires > now)
    return this.cookies.map((c) => ({ ...c }))
  }

  clear(): void {
    this.cookies = []
  }
}
