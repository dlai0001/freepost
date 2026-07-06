import { describe, expect, it } from 'vitest'
import { parseCsv, parseDataFile } from './index'

describe('parseCsv', () => {
  it('parses a simple LF file', () => {
    const res = parseCsv('name,age\nalice,30\nbob,25')
    expect(res).toEqual({
      ok: true,
      rows: [
        { name: 'alice', age: '30' },
        { name: 'bob', age: '25' }
      ]
    })
  })

  it('handles CRLF line endings', () => {
    const res = parseCsv('name,age\r\nalice,30\r\nbob,25\r\n')
    expect(res).toEqual({
      ok: true,
      rows: [
        { name: 'alice', age: '30' },
        { name: 'bob', age: '25' }
      ]
    })
  })

  it('ignores a trailing newline (no spurious empty row)', () => {
    const res = parseCsv('a,b\n1,2\n')
    expect(res).toEqual({ ok: true, rows: [{ a: '1', b: '2' }] })
  })

  it('parses quoted fields containing commas', () => {
    const res = parseCsv('name,note\n"Doe, John","hi, there"')
    expect(res).toEqual({
      ok: true,
      rows: [{ name: 'Doe, John', note: 'hi, there' }]
    })
  })

  it('parses quoted fields containing newlines', () => {
    const res = parseCsv('name,bio\nalice,"line one\nline two"')
    expect(res).toEqual({
      ok: true,
      rows: [{ name: 'alice', bio: 'line one\nline two' }]
    })
  })

  it('parses escaped quotes ("" -> ")', () => {
    const res = parseCsv('name,quote\nalice,"she said ""hi"""')
    expect(res).toEqual({
      ok: true,
      rows: [{ name: 'alice', quote: 'she said "hi"' }]
    })
  })

  it('preserves surrounding whitespace in unquoted fields', () => {
    const res = parseCsv('a,b\n hello , world ')
    expect(res).toEqual({ ok: true, rows: [{ a: ' hello ', b: ' world ' }] })
  })

  it('returns [] for empty input', () => {
    expect(parseCsv('')).toEqual({ ok: true, rows: [] })
  })

  it('returns [] for a header-only file', () => {
    expect(parseCsv('name,age')).toEqual({ ok: true, rows: [] })
    expect(parseCsv('name,age\n')).toEqual({ ok: true, rows: [] })
  })

  it('fills missing trailing cells with empty strings', () => {
    const res = parseCsv('a,b,c\n1,2')
    expect(res).toEqual({ ok: true, rows: [{ a: '1', b: '2', c: '' }] })
  })

  it('captures a trailing empty cell', () => {
    const res = parseCsv('a,b\n1,')
    expect(res).toEqual({ ok: true, rows: [{ a: '1', b: '' }] })
  })

  it('errors on a ragged row with too many cells, with a line number', () => {
    const res = parseCsv('a,b\n1,2,3')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toContain('line 2')
    expect(res.error).toContain('expected 2')
    expect(res.error).toContain('found 3')
  })

  it('reports the correct line number when a quoted field spans lines', () => {
    // Record 2 spans physical lines 2-3; record 3 (the ragged one) begins on line 4.
    const res = parseCsv('a,b\nx,"multi\nline"\n1,2,3')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toContain('line 4')
  })
})

describe('parseDataFile', () => {
  it('dispatches .json to the JSON parser (happy path)', () => {
    const res = parseDataFile('[{"name":"alice"},{"name":"bob"}]', 'data.json')
    expect(res).toEqual({
      ok: true,
      rows: [{ name: 'alice' }, { name: 'bob' }]
    })
  })

  it('is case-insensitive on the .json extension', () => {
    const res = parseDataFile('[{"x":"1"}]', 'DATA.JSON')
    expect(res).toEqual({ ok: true, rows: [{ x: '1' }] })
  })

  it('coerces numbers, booleans, and null to strings', () => {
    const res = parseDataFile(
      '[{"n":42,"b":true,"f":false,"z":null,"s":"str"}]',
      'd.json'
    )
    expect(res).toEqual({
      ok: true,
      rows: [{ n: '42', b: 'true', f: 'false', z: '', s: 'str' }]
    })
  })

  it('errors when JSON is not an array', () => {
    const res = parseDataFile('{"name":"alice"}', 'd.json')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toContain('must be an array')
  })

  it('errors when a JSON row is not a flat object', () => {
    const res = parseDataFile('[["a","b"]]', 'd.json')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toContain('row 0')
  })

  it('errors when a JSON cell is a nested object/array', () => {
    const res = parseDataFile('[{"nested":{"a":1}}]', 'd.json')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toContain('nested')
  })

  it('errors on invalid JSON', () => {
    const res = parseDataFile('[not json', 'd.json')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toContain('invalid JSON')
  })

  it('dispatches non-.json filenames to the CSV parser', () => {
    const res = parseDataFile('a,b\n1,2', 'data.csv')
    expect(res).toEqual({ ok: true, rows: [{ a: '1', b: '2' }] })
  })
})
