import { describe, expect, it } from 'vitest'
import { looksLikeCommand } from './util'

describe('looksLikeCommand', () => {
  it('matches a pasted curl command', () => {
    expect(looksLikeCommand('curl https://api.example.com')).toBe(true)
    expect(looksLikeCommand(`curl -X POST https://x.dev -d '{"a":1}'`)).toBe(true)
  })

  it('matches websocat and wscat', () => {
    expect(looksLikeCommand('websocat wss://example.com/socket')).toBe(true)
    expect(looksLikeCommand('wscat -c wss://example.com')).toBe(true)
  })

  it('matches a command that is not on the first line (pasted script)', () => {
    expect(looksLikeCommand('#!/bin/bash\ncurl https://x.dev/api')).toBe(true)
  })

  it('tolerates leading whitespace before the command', () => {
    expect(looksLikeCommand('   curl https://x.dev')).toBe(true)
  })

  it('does NOT match a plain URL (the common case — must paste normally)', () => {
    expect(looksLikeCommand('https://api.example.com/path')).toBe(false)
    expect(looksLikeCommand('https://curl.example.com/api')).toBe(false)
  })

  it('does NOT match a bare word or empty text', () => {
    expect(looksLikeCommand('curl')).toBe(false) // no following token
    expect(looksLikeCommand('')).toBe(false)
    expect(looksLikeCommand('curlie https://x.dev')).toBe(false) // not the curl token
  })
})
