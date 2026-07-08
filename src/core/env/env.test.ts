import { describe, expect, it } from 'vitest'
import {
  envDisplayName,
  isLocalEnv,
  parseEnvFile,
  sanitizeEnvName,
  serializeEnvFile
} from './index'

describe('parseEnvFile', () => {
  it('parses a plain object of strings', () => {
    const res = parseEnvFile('{"BASE_URL":"https://api.example.com","TOKEN":"abc"}')
    expect(res).toEqual({ ok: true, env: { BASE_URL: 'https://api.example.com', TOKEN: 'abc' } })
  })

  it('accepts an empty object', () => {
    expect(parseEnvFile('{}')).toEqual({ ok: true, env: {} })
  })

  it('coerces number and boolean values to strings', () => {
    const res = parseEnvFile('{"PORT":8080,"DEBUG":true,"RATIO":1.5,"NIL":null}')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.env).toEqual({ PORT: '8080', DEBUG: 'true', RATIO: '1.5', NIL: 'null' })
  })

  it('rejects an array', () => {
    const res = parseEnvFile('[1,2,3]')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toContain('must be a JSON object')
  })

  it('rejects null', () => {
    const res = parseEnvFile('null')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toContain('must be a JSON object')
  })

  it('rejects a non-object scalar', () => {
    const res = parseEnvFile('"just a string"')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toContain('must be a JSON object')
  })

  it('rejects invalid JSON', () => {
    const res = parseEnvFile('{not json')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toContain('invalid JSON')
  })
})

describe('serializeEnvFile', () => {
  it('sorts keys alphabetically, 2-space indent, trailing newline', () => {
    const out = serializeEnvFile({ ZED: '1', apple: '2', Beta: '3' })
    expect(out).toBe('{\n  "Beta": "3",\n  "ZED": "1",\n  "apple": "2"\n}\n')
  })

  it('serializes an empty env', () => {
    expect(serializeEnvFile({})).toBe('{}\n')
  })

  it('round-trips through parse (with sorted keys)', () => {
    const original = { b: '2', a: '1', c: '3' }
    const serialized = serializeEnvFile(original)
    const parsed = parseEnvFile(serialized)
    expect(parsed).toEqual({ ok: true, env: original })
    // Idempotent: serializing the parsed result yields the same text.
    if (parsed.ok) expect(serializeEnvFile(parsed.env)).toBe(serialized)
  })
})

describe('isLocalEnv', () => {
  it('is true for *.local.env.json', () => {
    expect(isLocalEnv('prod.local.env.json')).toBe(true)
    expect(isLocalEnv('environments/prod.local.env.json')).toBe(true)
  })

  it('is false for a plain *.env.json', () => {
    expect(isLocalEnv('prod.env.json')).toBe(false)
    expect(isLocalEnv('environments/prod.env.json')).toBe(false)
  })
})

describe('envDisplayName', () => {
  it('strips the .env.json suffix', () => {
    expect(envDisplayName('prod.env.json')).toBe('prod')
  })

  it('strips the .local.env.json suffix', () => {
    expect(envDisplayName('prod.local.env.json')).toBe('prod')
  })

  it('strips nested directories', () => {
    expect(envDisplayName('environments/staging.env.json')).toBe('staging')
    expect(envDisplayName('environments/staging.local.env.json')).toBe('staging')
  })

  it('handles backslash separators', () => {
    expect(envDisplayName('environments\\staging.env.json')).toBe('staging')
  })
})

describe('sanitizeEnvName', () => {
  it('trims surrounding whitespace', () => {
    expect(sanitizeEnvName('  prod  ')).toBe('prod')
  })

  it('strips a typed .env.json suffix', () => {
    expect(sanitizeEnvName('prod.env.json')).toBe('prod')
  })

  it('strips a typed .local.env.json suffix', () => {
    expect(sanitizeEnvName('prod.local.env.json')).toBe('prod')
  })

  it('removes filename-invalid characters and path separators', () => {
    expect(sanitizeEnvName('a/b:c*d?e"f<g>h|i\\j')).toBe('abcdefghij')
  })

  it('strips trailing dots', () => {
    expect(sanitizeEnvName('prod...')).toBe('prod')
  })

  it('returns empty when nothing valid remains', () => {
    expect(sanitizeEnvName('   ')).toBe('')
    expect(sanitizeEnvName('/\\?*')).toBe('')
    expect(sanitizeEnvName('.env.json')).toBe('')
  })
})
