import { describe, expect, it } from 'vitest'
import type { CookieRecord } from '../../core/cookies'
import {
  exportCookies,
  exportFilename,
  formatExpires,
  isExpired,
  parseExpiresInput,
  parseImportText
} from './cookieUi'

function mk(over: Partial<CookieRecord> = {}): CookieRecord {
  return {
    name: 'sid',
    value: 'abc',
    domain: 'api.example.com',
    path: '/',
    expires: null,
    secure: false,
    httpOnly: false,
    ...over
  }
}

describe('formatExpires', () => {
  it('renders session cookies as empty text', () => {
    expect(formatExpires(null)).toBe('')
  })

  it('renders an epoch-ms expiry as an ISO timestamp', () => {
    expect(formatExpires(Date.UTC(2030, 0, 2, 3, 4, 5))).toBe('2030-01-02T03:04:05.000Z')
  })
})

describe('parseExpiresInput', () => {
  it('treats empty and "session" as a session cookie', () => {
    expect(parseExpiresInput('')).toEqual({ ok: true, value: null })
    expect(parseExpiresInput('  ')).toEqual({ ok: true, value: null })
    expect(parseExpiresInput('Session')).toEqual({ ok: true, value: null })
  })

  it('parses ISO timestamps', () => {
    expect(parseExpiresInput('2030-01-02T03:04:05.000Z')).toEqual({
      ok: true,
      value: Date.UTC(2030, 0, 2, 3, 4, 5)
    })
  })

  it('rejects text that is not a date', () => {
    expect(parseExpiresInput('not a date')).toEqual({ ok: false })
  })

  it('round-trips through formatExpires', () => {
    const ms = Date.UTC(2031, 5, 6)
    expect(parseExpiresInput(formatExpires(ms))).toEqual({ ok: true, value: ms })
  })
})

describe('isExpired', () => {
  it('is false for session cookies and future expiries', () => {
    expect(isExpired(mk())).toBe(false)
    expect(isExpired(mk({ expires: Date.now() + 60_000 }))).toBe(false)
  })

  it('is true for past expiries', () => {
    expect(isExpired(mk({ expires: Date.now() - 60_000 }))).toBe(true)
  })
})

describe('exportCookies / exportFilename', () => {
  const jar = [mk(), mk({ name: 'theme', value: 'dark' })]

  it('serializes each format', () => {
    expect(JSON.parse(exportCookies(jar, 'json'))).toHaveLength(2)
    expect(exportCookies(jar, 'netscape')).toContain('# Netscape HTTP Cookie File')
    expect(exportCookies(jar, 'header')).toBe('sid=abc; theme=dark')
    expect(exportCookies(jar, 'set-cookie').split('\n')).toHaveLength(2)
  })

  it('picks a filename per format', () => {
    expect(exportFilename('json')).toBe('cookies.json')
    expect(exportFilename('netscape')).toBe('cookies.txt')
    expect(exportFilename('header')).toBe('cookies-header.txt')
    expect(exportFilename('set-cookie')).toBe('cookies-set-cookie.txt')
  })
})

describe('parseImportText', () => {
  it('parses JSON and reports parse failures as errors', () => {
    const ok = parseImportText(exportCookies([mk()], 'json'), 'json', '')
    expect(ok.errors).toEqual([])
    expect(ok.cookies).toHaveLength(1)
    const bad = parseImportText('{nope', 'json', '')
    expect(bad.cookies).toEqual([])
    expect(bad.errors).toHaveLength(1)
  })

  it('parses Netscape text and flags text with no cookie lines', () => {
    const ok = parseImportText(exportCookies([mk()], 'netscape'), 'netscape', '')
    expect(ok.cookies).toHaveLength(1)
    expect(parseImportText('garbage in\ngarbage out', 'netscape', '').errors).toHaveLength(1)
  })

  it('requires a domain for the header format', () => {
    expect(parseImportText('a=1; b=2', 'header', '').errors).toHaveLength(1)
    const ok = parseImportText('a=1; b=2', 'header', 'example.com')
    expect(ok.errors).toEqual([])
    expect(ok.cookies.map((c) => c.domain)).toEqual(['example.com', 'example.com'])
  })

  it('parses Set-Cookie lines with per-line errors', () => {
    const text = ['sid=abc; Domain=example.com; Secure', ';;;', 'plain=1'].join('\n')
    const res = parseImportText(text, 'set-cookie', '')
    expect(res.cookies).toHaveLength(1)
    expect(res.cookies[0].secure).toBe(true)
    expect(res.errors).toHaveLength(2) // invalid line + missing domain
    const withDefault = parseImportText(text, 'set-cookie', 'fallback.dev')
    expect(withDefault.cookies).toHaveLength(2)
    expect(withDefault.errors).toHaveLength(1)
  })
})
