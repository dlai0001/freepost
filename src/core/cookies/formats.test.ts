import { describe, expect, it } from 'vitest'
import {
  detectFormat,
  parseCookieHeader,
  parseJson,
  parseNetscape,
  parseSetCookie,
  toCookieHeader,
  toJson,
  toNetscape,
  toSetCookie,
  toSetCookieLines
} from './formats'
import type { CookieRecord } from './types'

const FUTURE_MS = Date.UTC(2030, 0, 15, 12, 0, 0)

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

describe('JSON format', () => {
  it('round-trips our own format with stable field order', () => {
    const cookies = [
      cookie({ expires: FUTURE_MS, secure: true, httpOnly: true, sameSite: 'Lax' }),
      cookie({ name: 'theme', value: 'dark' })
    ]
    const text = toJson(cookies)
    expect(parseJson(text)).toEqual(cookies)
    // Stable order: name before value before domain, etc.
    const first = JSON.parse(text)[0]
    expect(Object.keys(first)).toEqual([
      'name',
      'value',
      'domain',
      'path',
      'expires',
      'secure',
      'httpOnly',
      'sameSite'
    ])
  })

  it('omits sameSite from JSON output when undefined', () => {
    const text = toJson([cookie()])
    expect(Object.keys(JSON.parse(text)[0])).not.toContain('sameSite')
  })

  it('ends output with a trailing newline', () => {
    expect(toJson([cookie()]).endsWith('\n')).toBe(true)
  })

  it('accepts browser-extension exports with expirationDate in float seconds', () => {
    const text = JSON.stringify([
      {
        domain: '.github.com',
        expirationDate: 1893456000.5,
        hostOnly: false,
        httpOnly: true,
        name: 'logged_in',
        path: '/',
        sameSite: 'no_restriction',
        secure: true,
        session: false,
        storeId: '0',
        value: 'yes'
      }
    ])
    const [c] = parseJson(text)
    expect(c.expires).toBe(Math.round(1893456000.5 * 1000))
    expect(c.sameSite).toBe('None')
    expect(c.httpOnly).toBe(true)
    expect(c.secure).toBe(true)
    expect(c.domain).toBe('.github.com')
  })

  it('maps session:true to expires null even when expirationDate is present', () => {
    const [c] = parseJson(
      JSON.stringify([{ name: 's', value: 'v', domain: 'x.dev', session: true, expirationDate: 1893456000 }])
    )
    expect(c.expires).toBeNull()
  })

  it('normalizes sameSite casings (lax, STRICT, None, unspecified)', () => {
    const entries = [
      { name: 'a', value: '1', domain: 'x.dev', sameSite: 'lax' },
      { name: 'b', value: '2', domain: 'x.dev', sameSite: 'STRICT' },
      { name: 'c', value: '3', domain: 'x.dev', sameSite: 'None' },
      { name: 'd', value: '4', domain: 'x.dev', sameSite: 'unspecified' }
    ]
    const parsed = parseJson(JSON.stringify(entries))
    expect(parsed.map((c) => c.sameSite)).toEqual(['Lax', 'Strict', 'None', undefined])
  })

  it('accepts a single (non-array) cookie object', () => {
    const parsed = parseJson(JSON.stringify({ name: 'a', value: '1', domain: 'x.dev' }))
    expect(parsed).toHaveLength(1)
    expect(parsed[0].path).toBe('/')
  })

  it('skips non-cookie entries but keeps valid ones', () => {
    const parsed = parseJson(JSON.stringify([{ name: 'a', value: '1', domain: 'x.dev' }, 42, null, {}]))
    expect(parsed).toHaveLength(1)
  })

  it('throws on invalid JSON and on JSON without cookie objects', () => {
    expect(() => parseJson('not json')).toThrow('Not valid JSON')
    expect(() => parseJson('[{"foo": 1}]')).toThrow(/cookie objects/)
  })
})

describe('Netscape cookies.txt', () => {
  it('writes the header and 7 tab-separated fields', () => {
    const text = toNetscape([cookie({ expires: FUTURE_MS })])
    const lines = text.trimEnd().split('\n')
    expect(lines[0]).toBe('# Netscape HTTP Cookie File')
    const fields = lines[1].split('\t')
    expect(fields).toEqual([
      'example.com',
      'FALSE',
      '/',
      'FALSE',
      String(Math.floor(FUTURE_MS / 1000)),
      'sid',
      'abc123'
    ])
  })

  it('writes TRUE for includeSubdomains when domain starts with a dot', () => {
    const line = toNetscape([cookie({ domain: '.example.com' })]).trimEnd().split('\n')[1]
    expect(line.split('\t')[1]).toBe('TRUE')
  })

  it('writes 0 for session cookies and parses 0 back to expires null', () => {
    const text = toNetscape([cookie({ expires: null })])
    expect(text).toContain('\t0\t')
    const [c] = parseNetscape(text)
    expect(c.expires).toBeNull()
  })

  it('writes HttpOnly cookies with the #HttpOnly_ prefix and parses them back', () => {
    const text = toNetscape([cookie({ httpOnly: true, secure: true, expires: FUTURE_MS })])
    const line = text.trimEnd().split('\n')[1]
    expect(line.startsWith('#HttpOnly_example.com\t')).toBe(true)
    const [c] = parseNetscape(text)
    expect(c.httpOnly).toBe(true)
    expect(c.domain).toBe('example.com')
    expect(c.secure).toBe(true)
    expect(c.expires).toBe(Math.floor(FUTURE_MS / 1000) * 1000)
  })

  it('round-trips a mixed set (epoch seconds resolution)', () => {
    const cookies = [
      cookie({ expires: FUTURE_MS, secure: true }),
      cookie({ name: 'ho', httpOnly: true, domain: '.x.dev' }),
      cookie({ name: 'sess' })
    ]
    const parsed = parseNetscape(toNetscape(cookies))
    expect(parsed).toEqual(cookies.map((c) => ({ ...c, expires: c.expires === null ? null : Math.floor(c.expires / 1000) * 1000 })))
  })

  it('skips comments, blank lines and malformed lines', () => {
    const text = [
      '# Netscape HTTP Cookie File',
      '# This is a comment',
      '',
      'not a cookie line',
      'example.com\tFALSE\t/\tFALSE\t0\tgood\tvalue',
      'too\tfew\tfields'
    ].join('\n')
    const parsed = parseNetscape(text)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].name).toBe('good')
  })

  it('drops sameSite on export (format cannot carry it)', () => {
    const text = toNetscape([cookie({ sameSite: 'Strict' })])
    const [c] = parseNetscape(text)
    expect(c.sameSite).toBeUndefined()
  })

  it('parses CRLF line endings', () => {
    const parsed = parseNetscape('example.com\tFALSE\t/\tTRUE\t0\ta\t1\r\nx.dev\tFALSE\t/\tFALSE\t0\tb\t2\r\n')
    expect(parsed).toHaveLength(2)
    expect(parsed[0].secure).toBe(true)
  })
})

describe('Cookie header string', () => {
  it('serializes name=value pairs joined with "; "', () => {
    expect(toCookieHeader([cookie(), cookie({ name: 'theme', value: 'dark' })])).toBe('sid=abc123; theme=dark')
  })

  it('parses pairs with defaults, session, not secure/httpOnly', () => {
    const parsed = parseCookieHeader('sid=abc123; theme=dark', { domain: 'x.dev', path: '/app' })
    expect(parsed).toEqual([
      cookie({ domain: 'x.dev', path: '/app' }),
      cookie({ name: 'theme', value: 'dark', domain: 'x.dev', path: '/app' })
    ])
  })

  it('tolerates a leading Cookie: prefix and skips pairs without equals', () => {
    const parsed = parseCookieHeader('Cookie: a=1; junk; b=2', { domain: 'x.dev', path: '/' })
    expect(parsed.map((c) => c.name)).toEqual(['a', 'b'])
  })

  it('keeps equals signs inside the value', () => {
    const [c] = parseCookieHeader('tok=a=b=c', { domain: 'x.dev', path: '/' })
    expect(c.value).toBe('a=b=c')
  })
})

describe('Set-Cookie', () => {
  it('serializes a full line with all attributes', () => {
    const line = toSetCookie(
      cookie({ expires: FUTURE_MS, secure: true, httpOnly: true, sameSite: 'None' })
    )
    expect(line).toBe(
      'sid=abc123; Domain=example.com; Path=/; Expires=Tue, 15 Jan 2030 12:00:00 GMT; Secure; HttpOnly; SameSite=None'
    )
  })

  it('omits absent attributes for a bare session cookie', () => {
    expect(toSetCookie(cookie({ domain: '', path: '' }))).toBe('sid=abc123')
  })

  it('emits one line per cookie via toSetCookieLines', () => {
    const text = toSetCookieLines([cookie(), cookie({ name: 'b', value: '2' })])
    expect(text.split('\n')).toHaveLength(2)
  })

  it('round-trips through parseSetCookie', () => {
    const original = cookie({ expires: FUTURE_MS, secure: true, httpOnly: true, sameSite: 'Strict' })
    const parsed = parseSetCookie(toSetCookie(original), 'fallback.dev')
    expect(parsed).toEqual(original)
  })

  it('parses with attribute names case-insensitively', () => {
    const c = parseSetCookie('a=1; DOMAIN=.x.dev; PATH=/p; SECURE; HTTPONLY; samesite=lax', 'd.dev')
    expect(c).toEqual(
      cookie({ name: 'a', value: '1', domain: 'x.dev', path: '/p', secure: true, httpOnly: true, sameSite: 'Lax' })
    )
  })

  it('gives Max-Age precedence over Expires regardless of order', () => {
    const before = Date.now()
    const c1 = parseSetCookie('a=1; Expires=Tue, 15 Jan 2030 12:00:00 GMT; Max-Age=60', 'x.dev')
    const c2 = parseSetCookie('a=1; Max-Age=60; Expires=Tue, 15 Jan 2030 12:00:00 GMT', 'x.dev')
    for (const c of [c1, c2]) {
      expect(c?.expires).toBeGreaterThanOrEqual(before + 60_000)
      expect(c?.expires).toBeLessThan(before + 61_000 + 5_000)
    }
  })

  it('treats Max-Age <= 0 as already expired', () => {
    const c = parseSetCookie('a=1; Max-Age=0', 'x.dev')
    expect(c?.expires).not.toBeNull()
    expect(c!.expires!).toBeLessThan(Date.now())
    const neg = parseSetCookie('a=1; Max-Age=-1', 'x.dev')
    expect(neg!.expires!).toBeLessThan(Date.now())
  })

  it('uses the default domain when no Domain attribute is present', () => {
    expect(parseSetCookie('a=1', 'fallback.dev')?.domain).toBe('fallback.dev')
  })

  it('ignores unknown attributes and tolerates a Set-Cookie: prefix', () => {
    const c = parseSetCookie('Set-Cookie: a=1; Priority=High; Partitioned; Path=/x', 'x.dev')
    expect(c).toEqual(cookie({ name: 'a', value: '1', domain: 'x.dev', path: '/x' }))
  })

  it('returns null for lines without a name=value pair', () => {
    expect(parseSetCookie('', 'x.dev')).toBeNull()
    expect(parseSetCookie('=value', 'x.dev')).toBeNull()
    expect(parseSetCookie('noequals', 'x.dev')).toBeNull()
  })

  it('ignores an unparseable Expires date and invalid SameSite value', () => {
    const c = parseSetCookie('a=1; Expires=garbage; SameSite=Bogus', 'x.dev')
    expect(c?.expires).toBeNull()
    expect(c?.sameSite).toBeUndefined()
  })
})

describe('detectFormat', () => {
  it('detects JSON arrays and objects', () => {
    expect(detectFormat(toJson([cookie()]))).toBe('json')
    expect(detectFormat('{"name":"a","value":"1"}')).toBe('json')
  })

  it('detects Netscape by header and by 7-field lines without a header', () => {
    expect(detectFormat(toNetscape([cookie()]))).toBe('netscape')
    expect(detectFormat('example.com\tFALSE\t/\tFALSE\t0\ta\t1')).toBe('netscape')
    expect(detectFormat('#HttpOnly_example.com\tFALSE\t/\tFALSE\t0\ta\t1')).toBe('netscape')
  })

  it('detects Set-Cookie lines by prefix or attribute keywords', () => {
    expect(detectFormat('Set-Cookie: a=1; Path=/')).toBe('set-cookie')
    expect(detectFormat('a=1; Path=/; Secure; HttpOnly')).toBe('set-cookie')
    expect(detectFormat('sid=x; Max-Age=60')).toBe('set-cookie')
  })

  it('falls back to header for plain pair lists', () => {
    expect(detectFormat('a=1; b=2; c=3')).toBe('header')
    expect(detectFormat('sid=abc123')).toBe('header')
  })

  it('does not classify broken JSON as json', () => {
    expect(detectFormat('{not json')).toBe('header')
  })
})
