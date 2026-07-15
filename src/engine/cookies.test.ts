import { describe, expect, it } from 'vitest'
import { CookieJar } from './cookies'

describe('CookieJar', () => {
  it('matches on exact host only', () => {
    const jar = new CookieJar()
    jar.storeFromResponse('http://api.example.com/', ['sid=1; Path=/'])
    expect(jar.cookieHeader('http://api.example.com/users')).toBe('sid=1')
    expect(jar.cookieHeader('http://example.com/users')).toBeUndefined()
    expect(jar.cookieHeader('http://other.example.com/users')).toBeUndefined()
  })

  it('matches by path prefix with proper segment boundaries', () => {
    const jar = new CookieJar()
    jar.storeFromResponse('http://h.test/', ['a=1; Path=/api'])
    expect(jar.cookieHeader('http://h.test/api')).toBe('a=1')
    expect(jar.cookieHeader('http://h.test/api/users')).toBe('a=1')
    expect(jar.cookieHeader('http://h.test/apiary')).toBeUndefined()
    expect(jar.cookieHeader('http://h.test/')).toBeUndefined()
  })

  it('uses the default path from the request URL when Path is absent', () => {
    const jar = new CookieJar()
    jar.storeFromResponse('http://h.test/deep/nested/page', ['d=1'])
    expect(jar.cookieHeader('http://h.test/deep/nested/other')).toBe('d=1')
    expect(jar.cookieHeader('http://h.test/deep')).toBeUndefined()
  })

  it('deletes via Max-Age=0 and honors Max-Age over Expires', () => {
    const jar = new CookieJar()
    jar.storeFromResponse('http://h.test/', ['sid=live; Path=/'])
    expect(jar.cookieHeader('http://h.test/')).toBe('sid=live')
    jar.storeFromResponse('http://h.test/', ['sid=; Path=/; Max-Age=0'])
    expect(jar.cookieHeader('http://h.test/')).toBeUndefined()

    // Max-Age wins over a far-future Expires.
    jar.storeFromResponse('http://h.test/', [
      'x=1; Path=/; Expires=Wed, 01 Jan 2100 00:00:00 GMT; Max-Age=0'
    ])
    expect(jar.cookieHeader('http://h.test/')).toBeUndefined()
  })

  it('honors an already-past Expires as deletion', () => {
    const jar = new CookieJar()
    jar.storeFromResponse('http://h.test/', ['old=1; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'])
    expect(jar.cookieHeader('http://h.test/')).toBeUndefined()
  })

  it('withholds Secure cookies from plain-http requests only', () => {
    const jar = new CookieJar()
    jar.storeFromResponse('http://h.test/', ['s=1; Path=/; Secure', 'p=2; Path=/'])
    expect(jar.cookieHeader('http://h.test/')).toBe('p=2')
    expect(jar.cookieHeader('https://h.test/')).toBe('s=1; p=2')
  })

  it('replaces a cookie with the same name+domain+path', () => {
    const jar = new CookieJar()
    jar.storeFromResponse('http://h.test/', ['sid=old; Path=/'])
    jar.storeFromResponse('http://h.test/', ['sid=new; Path=/'])
    expect(jar.cookieHeader('http://h.test/')).toBe('sid=new')
    expect(jar.list()).toHaveLength(1)
  })

  it('clear() empties the jar', () => {
    const jar = new CookieJar()
    jar.storeFromResponse('http://h.test/', ['a=1; Path=/'])
    jar.clear()
    expect(jar.cookieHeader('http://h.test/')).toBeUndefined()
    expect(jar.list()).toHaveLength(0)
  })

  it('parses SameSite (case-insensitive) and HttpOnly as stored metadata', () => {
    const jar = new CookieJar()
    jar.storeFromResponse('http://h.test/', [
      'a=1; Path=/; SameSite=Strict',
      'b=2; Path=/; samesite=lax; HttpOnly',
      'c=3; Path=/; SameSite=NONE',
      'd=4; Path=/; SameSite=bogus'
    ])
    const byName = Object.fromEntries(jar.list().map((c) => [c.name, c]))
    expect(byName.a.sameSite).toBe('Strict')
    expect(byName.b.sameSite).toBe('Lax')
    expect(byName.b.httpOnly).toBe(true)
    expect(byName.c.sameSite).toBe('None')
    expect(byName.d.sameSite).toBeUndefined()
    expect(byName.a.httpOnly).toBe(false)
    // Metadata only: all four still sent regardless of SameSite/HttpOnly.
    expect(jar.cookieHeader('http://h.test/')).toBe('a=1; b=2; c=3; d=4')
  })

  it('setCookie upserts by domain+path+name and lowercases the domain', () => {
    const jar = new CookieJar()
    jar.setCookie(cookie({ name: 'sid', value: 'old', domain: 'H.Test' }))
    jar.setCookie(cookie({ name: 'sid', value: 'new', domain: 'h.test' }))
    jar.setCookie(cookie({ name: 'sid', value: 'scoped', path: '/api' }))
    expect(jar.list()).toHaveLength(2)
    expect(jar.cookieHeader('http://h.test/')).toBe('sid=new')
    expect(jar.cookieHeader('http://h.test/api')).toBe('sid=scoped; sid=new')
  })

  it('deleteCookie removes exactly one identity', () => {
    const jar = new CookieJar()
    jar.setCookie(cookie({ name: 'a' }))
    jar.setCookie(cookie({ name: 'b' }))
    jar.deleteCookie('H.TEST', '/', 'a')
    expect(jar.list().map((c) => c.name)).toEqual(['b'])
    jar.deleteCookie('h.test', '/other', 'b') // wrong path — no-op
    expect(jar.list()).toHaveLength(1)
  })

  it('clear() scopes: by domain, session-only, and both', () => {
    const future = Date.now() + 60_000
    const make = (): CookieJar => {
      const jar = new CookieJar()
      jar.setCookie(cookie({ name: 'sess-a', domain: 'a.test' }))
      jar.setCookie(cookie({ name: 'persist-a', domain: 'a.test', expires: future }))
      jar.setCookie(cookie({ name: 'sess-b', domain: 'b.test' }))
      return jar
    }

    const byDomain = make()
    byDomain.clear({ domain: 'A.Test' })
    expect(byDomain.list().map((c) => c.name)).toEqual(['sess-b'])

    const sessionOnly = make()
    sessionOnly.clear({ sessionOnly: true })
    expect(sessionOnly.list().map((c) => c.name)).toEqual(['persist-a'])

    const both = make()
    both.clear({ domain: 'a.test', sessionOnly: true })
    expect(both.list().map((c) => c.name).sort()).toEqual(['persist-a', 'sess-b'])
  })

  it('toJSON/fromJSON round-trips, dropping expired persistent cookies but keeping session ones', () => {
    const jar = new CookieJar()
    jar.setCookie(cookie({ name: 'sess' }))
    jar.setCookie(cookie({ name: 'live', expires: Date.now() + 60_000, sameSite: 'Lax' }))
    const records = jar.toJSON()
    records.push(cookie({ name: 'dead', expires: Date.now() - 1000 }))

    const restored = CookieJar.fromJSON(records)
    expect(restored.list().map((c) => c.name).sort()).toEqual(['live', 'sess'])
    expect(restored.toJSON().sort((a, b) => a.name.localeCompare(b.name))).toEqual(
      jar.toJSON().sort((a, b) => a.name.localeCompare(b.name))
    )
  })
})

function cookie(overrides: Partial<import('./cookies').CookieRecord>): import('./cookies').CookieRecord {
  return {
    name: 'c',
    value: 'v',
    domain: 'h.test',
    path: '/',
    expires: null,
    secure: false,
    httpOnly: false,
    ...overrides
  }
}
