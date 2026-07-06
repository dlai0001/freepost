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
})
