import { describe, expect, it } from 'vitest'
import { mapWebsocatCommand } from './websocat'
import type { CommandToken } from './shell'

const argv = (...words: string[]): CommandToken[] => words.map((text, i) => ({ text, line: i + 1 }))

function ok(...words: string[]) {
  const r = mapWebsocatCommand(argv(...words))
  expect(r.ok).toBe(true)
  if (!r.ok) throw new Error(`expected ok, got: ${JSON.stringify(r.errors)}`)
  return r.ws
}

function err(...words: string[]) {
  const r = mapWebsocatCommand(argv(...words))
  expect(r.ok).toBe(false)
  if (r.ok) throw new Error('expected error')
  return r.errors[0]
}

describe('mapWebsocatCommand', () => {
  it('maps URL, headers, and protocol', () => {
    const ws = ok(
      'websocat',
      'wss://${BASE_URL}/stream',
      '--header', 'Authorization: Bearer ${TOKEN}',
      '--protocol', 'v1.ticker',
    )
    expect(ws).toEqual({
      url: 'wss://${BASE_URL}/stream',
      headers: [{ name: 'Authorization', value: 'Bearer ${TOKEN}' }],
      protocol: 'v1.ticker',
    })
  })

  it('maps a bare URL with no flags', () => {
    expect(ok('websocat', 'wss://x/stream')).toEqual({ url: 'wss://x/stream', headers: [] })
  })

  it('accepts -H as an alias for --header', () => {
    expect(ok('websocat', 'wss://x', '-H', 'A: 1').headers).toEqual([{ name: 'A', value: '1' }])
  })

  it('rejects unsupported flags by name with line info', () => {
    const e = err('websocat', 'wss://x', '--binary')
    expect(e.message).toBe('unsupported websocat flag: --binary')
    expect(e.line).toBe(3)
  })

  it('rejects a missing URL', () => {
    expect(err('websocat', '--protocol', 'v1').message).toMatch(/missing URL/)
  })

  it('rejects two positional URLs', () => {
    expect(err('websocat', 'wss://a', 'wss://b').message).toMatch(/already set/)
  })

  it('rejects malformed headers and missing values', () => {
    expect(err('websocat', 'wss://x', '--header', 'NoColon').message).toMatch(/malformed header/)
    expect(err('websocat', 'wss://x', '--header').message).toMatch(/missing value/)
    expect(err('websocat', 'wss://x', '--protocol', 'a', '--protocol', 'b').message).toMatch(/duplicate --protocol/)
  })
})
