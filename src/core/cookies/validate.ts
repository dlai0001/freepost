/**
 * RFC 6265bis cookie validation. Pure — returns structured issues rather than
 * throwing, so the UI can render per-field errors and warnings.
 */
import type { CookieRecord } from './types'

export interface CookieIssue {
  field: keyof CookieRecord | 'general'
  severity: 'error' | 'warning'
  message: string
}

/** RFC 6265 token: printable US-ASCII except separators. */
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/**
 * RFC 6265 cookie-octet: printable US-ASCII excluding whitespace, DQUOTE,
 * comma, semicolon and backslash.
 */
const COOKIE_VALUE_RE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/

const MAX_PAIR_BYTES = 4096
const MAX_ATTRIBUTE_BYTES = 1024

const encoder = new TextEncoder()

function byteLength(s: string): number {
  return encoder.encode(s).length
}

/**
 * Validate one cookie against RFC 6265bis rules. Errors mark cookies a user
 * agent would reject outright; warnings mark values that are out of spec but
 * commonly tolerated in practice.
 */
export function validateCookie(c: CookieRecord): CookieIssue[] {
  const issues: CookieIssue[] = []

  // --- name -----------------------------------------------------------------
  if (c.name === '') {
    issues.push({ field: 'name', severity: 'error', message: 'Cookie name must not be empty' })
  } else if (!TOKEN_RE.test(c.name)) {
    issues.push({
      field: 'name',
      severity: 'error',
      message: 'Cookie name must be an RFC 6265 token (no whitespace, control characters or separators)'
    })
  }

  // --- value ----------------------------------------------------------------
  if (!COOKIE_VALUE_RE.test(c.value)) {
    issues.push({
      field: 'value',
      severity: 'warning',
      message:
        'Cookie value contains characters outside the RFC 6265 cookie-octet set (whitespace, DQUOTE, comma, semicolon or backslash); many servers tolerate this'
    })
  }

  // --- size limits ------------------------------------------------------------
  if (byteLength(c.name) + byteLength(c.value) > MAX_PAIR_BYTES) {
    issues.push({
      field: 'general',
      severity: 'error',
      message: `Name plus value exceeds ${MAX_PAIR_BYTES} bytes; user agents reject the whole cookie`
    })
  }
  for (const [field, value] of [
    ['domain', c.domain],
    ['path', c.path]
  ] as const) {
    if (byteLength(value) > MAX_ATTRIBUTE_BYTES) {
      issues.push({
        field,
        severity: 'warning',
        message: `${field} attribute exceeds ${MAX_ATTRIBUTE_BYTES} bytes; user agents may ignore it`
      })
    }
  }

  // --- prefixes ---------------------------------------------------------------
  if (c.name.startsWith('__Host-')) {
    if (!c.secure) {
      issues.push({ field: 'secure', severity: 'error', message: '__Host- cookies must be Secure' })
    }
    if (c.path !== '/') {
      issues.push({ field: 'path', severity: 'error', message: '__Host- cookies must have path "/"' })
    }
  } else if (c.name.startsWith('__Secure-')) {
    if (!c.secure) {
      issues.push({ field: 'secure', severity: 'error', message: '__Secure- cookies must be Secure' })
    }
  }

  // --- SameSite ---------------------------------------------------------------
  if (c.sameSite === 'None' && !c.secure) {
    issues.push({
      field: 'sameSite',
      severity: 'error',
      message: 'SameSite=None requires the Secure attribute'
    })
  }

  // --- expiry -----------------------------------------------------------------
  if (c.expires !== null && c.expires < Date.now()) {
    issues.push({ field: 'expires', severity: 'warning', message: 'Cookie is expired' })
  }

  // --- domain / path ----------------------------------------------------------
  if (c.domain === '') {
    issues.push({ field: 'domain', severity: 'error', message: 'Domain must not be empty' })
  }
  if (!c.path.startsWith('/')) {
    issues.push({
      field: 'path',
      severity: 'warning',
      message: 'Path should start with "/"; user agents fall back to the default path'
    })
  }

  return issues
}
