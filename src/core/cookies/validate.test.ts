import { describe, expect, it } from 'vitest'
import { validateCookie } from './validate'
import type { CookieRecord } from './types'

function cookie(overrides: Partial<CookieRecord> = {}): CookieRecord {
  return {
    name: 'sid',
    value: 'abc123',
    domain: 'example.com',
    path: '/',
    expires: null,
    secure: false,
    httpOnly: false,
    ...overrides
  }
}

describe('validateCookie', () => {
  it('returns no issues for a plain valid cookie', () => {
    expect(validateCookie(cookie())).toEqual([])
  })

  describe('name', () => {
    it('errors on an empty name', () => {
      const issues = validateCookie(cookie({ name: '' }))
      expect(issues).toContainEqual(expect.objectContaining({ field: 'name', severity: 'error' }))
    })

    it('errors on separators, whitespace and control chars in the name', () => {
      for (const name of ['a b', 'a;b', 'a=b', 'a,b', 'a(b)', 'a\tb', 'a\x01b', 'a"b']) {
        const issues = validateCookie(cookie({ name }))
        expect(issues, name).toContainEqual(expect.objectContaining({ field: 'name', severity: 'error' }))
      }
    })

    it('accepts all RFC 6265 token characters', () => {
      expect(validateCookie(cookie({ name: "!#$%&'*+-.^_`|~aZ09" }))).toEqual([])
    })
  })

  describe('value', () => {
    it('warns (not errors) on DQUOTE, comma, semicolon, backslash and whitespace', () => {
      for (const value of ['a"b', 'a,b', 'a;b', 'a\\b', 'a b']) {
        const issues = validateCookie(cookie({ value }))
        expect(issues, value).toContainEqual(expect.objectContaining({ field: 'value', severity: 'warning' }))
        expect(issues.filter((i) => i.severity === 'error')).toEqual([])
      }
    })

    it('accepts an empty value and the full cookie-octet range', () => {
      expect(validateCookie(cookie({ value: '' }))).toEqual([])
      expect(validateCookie(cookie({ value: "!#$%&'()*+-./09:<=>?@AZ[]^_`az{|}~" }))).toEqual([])
    })
  })

  describe('size limits', () => {
    it('accepts name+value at exactly 4096 bytes, errors at 4097', () => {
      const at = cookie({ name: 'n'.repeat(96), value: 'v'.repeat(4000) })
      expect(validateCookie(at)).toEqual([])
      const over = cookie({ name: 'n'.repeat(96), value: 'v'.repeat(4001) })
      expect(validateCookie(over)).toContainEqual(
        expect.objectContaining({ field: 'general', severity: 'error' })
      )
    })

    it('counts multibyte characters by their UTF-8 byte length', () => {
      // 1366 snowmen at 3 bytes each = 4098 bytes with a 3-byte name.
      const issues = validateCookie(cookie({ name: 'abc', value: '☃'.repeat(1365) }))
      expect(issues).toContainEqual(expect.objectContaining({ field: 'general', severity: 'error' }))
    })

    it('warns when domain or path exceeds 1024 bytes (boundary exact)', () => {
      expect(validateCookie(cookie({ domain: 'd'.repeat(1024) }))).toEqual([])
      expect(validateCookie(cookie({ domain: 'd'.repeat(1025) }))).toContainEqual(
        expect.objectContaining({ field: 'domain', severity: 'warning' })
      )
      expect(validateCookie(cookie({ path: '/' + 'p'.repeat(1024) }))).toContainEqual(
        expect.objectContaining({ field: 'path', severity: 'warning' })
      )
    })
  })

  describe('prefixes', () => {
    it('__Host- requires secure and path "/"', () => {
      const bad = validateCookie(cookie({ name: '__Host-sid', secure: false, path: '/app' }))
      expect(bad).toContainEqual(expect.objectContaining({ field: 'secure', severity: 'error' }))
      expect(bad).toContainEqual(expect.objectContaining({ field: 'path', severity: 'error' }))
      expect(validateCookie(cookie({ name: '__Host-sid', secure: true, path: '/' }))).toEqual([])
    })

    it('__Secure- requires secure', () => {
      expect(validateCookie(cookie({ name: '__Secure-sid' }))).toContainEqual(
        expect.objectContaining({ field: 'secure', severity: 'error' })
      )
      expect(validateCookie(cookie({ name: '__Secure-sid', secure: true }))).toEqual([])
    })
  })

  it('errors when SameSite=None is not Secure', () => {
    expect(validateCookie(cookie({ sameSite: 'None' }))).toContainEqual(
      expect.objectContaining({ field: 'sameSite', severity: 'error' })
    )
    expect(validateCookie(cookie({ sameSite: 'None', secure: true }))).toEqual([])
  })

  it('warns on an expired cookie, accepts future and session expiry', () => {
    expect(validateCookie(cookie({ expires: Date.now() - 1000 }))).toContainEqual(
      expect.objectContaining({ field: 'expires', severity: 'warning', message: 'Cookie is expired' })
    )
    expect(validateCookie(cookie({ expires: Date.now() + 86_400_000 }))).toEqual([])
    expect(validateCookie(cookie({ expires: null }))).toEqual([])
  })

  it('errors on an empty domain', () => {
    expect(validateCookie(cookie({ domain: '' }))).toContainEqual(
      expect.objectContaining({ field: 'domain', severity: 'error' })
    )
  })

  it('warns when the path does not start with "/"', () => {
    expect(validateCookie(cookie({ path: 'app' }))).toContainEqual(
      expect.objectContaining({ field: 'path', severity: 'warning' })
    )
  })

  it('reports multiple independent issues at once', () => {
    const issues = validateCookie(
      cookie({ name: '__Secure-a b', value: 'x y', domain: '', path: 'nope', sameSite: 'None' })
    )
    const fields = issues.map((i) => i.field).sort()
    expect(fields).toEqual(['domain', 'name', 'path', 'sameSite', 'secure', 'value'])
  })
})
