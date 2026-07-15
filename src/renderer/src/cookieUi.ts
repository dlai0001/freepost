/**
 * Pure helpers behind the Cookie Manager UI: expires-cell parsing/formatting
 * and import/export glue over the core cookie formats. Kept out of the
 * component so they stay unit-testable without a DOM.
 */
import type { CookieRecord } from '../../core/cookies'
import {
  parseCookieHeader,
  parseJson,
  parseNetscape,
  parseSetCookie,
  toCookieHeader,
  toJson,
  toNetscape,
  toSetCookieLines
} from '../../core/cookies'

export type CookieFormat = 'json' | 'netscape' | 'header' | 'set-cookie'

/** Render the Expires cell: empty for session, ISO timestamp otherwise. */
export function formatExpires(expires: number | null): string {
  return expires === null ? '' : new Date(expires).toISOString()
}

export function isExpired(c: CookieRecord): boolean {
  return c.expires !== null && c.expires < Date.now()
}

/**
 * Parse the Expires cell. Empty text (or the word "session") means a session
 * cookie; anything else must be a Date.parse-able timestamp.
 */
export function parseExpiresInput(
  text: string
): { ok: true; value: number | null } | { ok: false } {
  const t = text.trim()
  if (t === '' || t.toLowerCase() === 'session') return { ok: true, value: null }
  const parsed = Date.parse(t)
  if (Number.isNaN(parsed)) return { ok: false }
  return { ok: true, value: parsed }
}

/** Serialize the jar in the chosen export format. */
export function exportCookies(cookies: CookieRecord[], format: CookieFormat): string {
  switch (format) {
    case 'json':
      return toJson(cookies)
    case 'netscape':
      return toNetscape(cookies)
    case 'header':
      return toCookieHeader(cookies)
    case 'set-cookie':
      return toSetCookieLines(cookies)
  }
}

export function exportFilename(format: CookieFormat): string {
  switch (format) {
    case 'json':
      return 'cookies.json'
    case 'netscape':
      return 'cookies.txt'
    case 'header':
      return 'cookies-header.txt'
    case 'set-cookie':
      return 'cookies-set-cookie.txt'
  }
}

export interface ImportResult {
  cookies: CookieRecord[]
  errors: string[]
}

/**
 * Parse pasted import text in the given format. Never throws — parse failures
 * come back as human-readable errors. `defaultDomain` is required for the
 * header format and backfills Set-Cookie lines without a Domain attribute.
 */
export function parseImportText(
  text: string,
  format: CookieFormat,
  defaultDomain: string
): ImportResult {
  const domain = defaultDomain.trim()
  switch (format) {
    case 'json':
      try {
        return { cookies: parseJson(text), errors: [] }
      } catch (e) {
        return { cookies: [], errors: [e instanceof Error ? e.message : String(e)] }
      }
    case 'netscape': {
      const cookies = parseNetscape(text)
      if (cookies.length === 0 && text.trim() !== '') {
        return { cookies: [], errors: ['No valid Netscape cookie lines found'] }
      }
      return { cookies, errors: [] }
    }
    case 'header': {
      if (domain === '') {
        return { cookies: [], errors: ['A domain is required to import a Cookie header'] }
      }
      const cookies = parseCookieHeader(text, { domain, path: '/' })
      if (cookies.length === 0 && text.trim() !== '') {
        return { cookies: [], errors: ['No name=value pairs found'] }
      }
      return { cookies, errors: [] }
    }
    case 'set-cookie': {
      const cookies: CookieRecord[] = []
      const errors: string[] = []
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === '') continue
        const cookie = parseSetCookie(lines[i], domain)
        if (cookie === null) {
          errors.push(`Line ${i + 1}: not a valid Set-Cookie line`)
        } else if (cookie.domain === '') {
          errors.push(`Line ${i + 1}: no Domain attribute — set a default domain`)
        } else {
          cookies.push(cookie)
        }
      }
      return { cookies, errors }
    }
  }
}
