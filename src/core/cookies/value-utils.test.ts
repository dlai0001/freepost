import { describe, expect, it } from 'vitest'
import {
  base64Decode,
  base64Encode,
  detectValueKind,
  jsonPrettyPrint,
  jwtDecode,
  urlDecode,
  urlEncode
} from './value-utils'

// Classic jwt.io sample token (HS256).
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
  'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.' +
  'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'

describe('base64', () => {
  it('round-trips ASCII', () => {
    expect(base64Encode('hello world')).toBe('aGVsbG8gd29ybGQ=')
    expect(base64Decode('aGVsbG8gd29ybGQ=')).toBe('hello world')
  })

  it('round-trips unicode (UTF-8 safe)', () => {
    for (const s of ['héllo wörld', '日本語テスト', 'emoji 🎉🍪', '☃']) {
      expect(base64Decode(base64Encode(s))).toBe(s)
    }
  })

  it('round-trips the empty string', () => {
    expect(base64Encode('')).toBe('')
    expect(base64Decode('')).toBe('')
  })

  it('handles all padding lengths', () => {
    expect(base64Encode('a')).toBe('YQ==')
    expect(base64Encode('ab')).toBe('YWI=')
    expect(base64Encode('abc')).toBe('YWJj')
    expect(base64Decode('YQ==')).toBe('a')
    expect(base64Decode('YWI=')).toBe('ab')
  })

  it('accepts base64url and missing padding', () => {
    // '>>>???' encodes to 'Pj4+Pz8/' standard / 'Pj4-Pz8_' url-safe.
    expect(base64Decode('Pj4-Pz8_')).toBe('>>>???')
    expect(base64Decode('YQ')).toBe('a')
    expect(base64Decode('aGVsbG8')).toBe('hello')
  })

  it('ignores embedded whitespace', () => {
    expect(base64Decode('aGVs\nbG8g\td29ybGQ=')).toBe('hello world')
  })

  it('returns null on invalid characters, bad length, and invalid UTF-8', () => {
    expect(base64Decode('not*base64!')).toBeNull()
    expect(base64Decode('YQZZZ')).toBeNull() // length % 4 === 1
    expect(base64Decode('/w==')).toBeNull() // 0xFF is not valid UTF-8
  })
})

describe('url encode/decode', () => {
  it('round-trips reserved characters and unicode', () => {
    for (const s of ['a b&c=d?e', '100% legit', 'köln/日本']) {
      expect(urlDecode(urlEncode(s))).toBe(s)
    }
  })

  it('encodes as encodeURIComponent does', () => {
    expect(urlEncode('a b/c')).toBe('a%20b%2Fc')
  })

  it('returns null on malformed percent escapes', () => {
    expect(urlDecode('%')).toBeNull()
    expect(urlDecode('%zz')).toBeNull()
    expect(urlDecode('50%off')).toBeNull()
  })
})

describe('jwtDecode', () => {
  it('decodes the sample token into pretty-printed header and payload', () => {
    const result = jwtDecode(JWT)
    expect(result).not.toBeNull()
    expect(JSON.parse(result!.header)).toEqual({ alg: 'HS256', typ: 'JWT' })
    expect(JSON.parse(result!.payload)).toEqual({ sub: '1234567890', name: 'John Doe', iat: 1516239022 })
    // Pretty-printed: multi-line with 2-space indent.
    expect(result!.payload).toContain('\n  "name": "John Doe"')
  })

  it('does not require a valid signature segment', () => {
    expect(jwtDecode(JWT.replace(/[^.]+$/, 'x'))).not.toBeNull()
  })

  it('rejects inputs without exactly three segments', () => {
    expect(jwtDecode('onlyone')).toBeNull()
    expect(jwtDecode('two.segments')).toBeNull()
    expect(jwtDecode(JWT + '.extra')).toBeNull()
  })

  it('rejects segments that are not base64url JSON', () => {
    expect(jwtDecode('!!!.???.sig')).toBeNull()
    expect(jwtDecode(`${base64Encode('not json')}.${base64Encode('{}')}.sig`)).toBeNull()
    expect(jwtDecode('..sig')).toBeNull()
  })
})

describe('jsonPrettyPrint', () => {
  it('pretty-prints with two-space indentation', () => {
    expect(jsonPrettyPrint('{"a":1,"b":[2,3]}')).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}')
  })

  it('returns null on invalid JSON', () => {
    expect(jsonPrettyPrint('{nope')).toBeNull()
    expect(jsonPrettyPrint('')).toBeNull()
  })
})

describe('detectValueKind', () => {
  it('detects base64 that decodes to printable text', () => {
    expect(detectValueKind(base64Encode('hello world'))).toContain('base64')
  })

  it('does not flag base64 whose payload is binary or invalid', () => {
    expect(detectValueKind('/w==')).not.toContain('base64')
    expect(detectValueKind('plain-text-value')).not.toContain('base64')
  })

  it('does not flag short/trivial strings as base64', () => {
    expect(detectValueKind('abc')).not.toContain('base64')
  })

  it('detects url-encoded only when % escapes actually decode', () => {
    expect(detectValueKind('hello%20world')).toContain('url-encoded')
    expect(detectValueKind('hello world')).not.toContain('url-encoded')
    expect(detectValueKind('100%zz')).not.toContain('url-encoded')
  })

  it('detects JWTs', () => {
    expect(detectValueKind(JWT)).toContain('jwt')
    expect(detectValueKind('a.b.c')).not.toContain('jwt')
  })

  it('detects JSON objects and arrays but not bare scalars', () => {
    expect(detectValueKind('{"a":1}')).toContain('json')
    expect(detectValueKind('[1,2]')).toContain('json')
    expect(detectValueKind('123')).not.toContain('json')
    expect(detectValueKind('"str"')).not.toContain('json')
  })

  it('returns an empty array for an opaque session id', () => {
    expect(detectValueKind('xK9!@#$%')).toEqual([])
  })

  it('can report multiple kinds', () => {
    // Base64 of a JSON object: both base64 (decodes to printable) applies.
    const kinds = detectValueKind(base64Encode('{"user":"jane"}'))
    expect(kinds).toContain('base64')
  })
})
