import { describe, expect, it } from 'vitest'
import { importCommandText } from './command'
import { writeRequestFile } from '../format'

describe('importCommandText — curl', () => {
  it('imports a simple one-line curl paste', () => {
    const r = importCommandText(`curl -X POST https://api.example.com/users -H 'Content-Type: application/json' -d '{"a":1}'`)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.kind).toBe('curl')
    expect(r.file.http?.method).toBe('POST')
    expect(r.file.http?.url).toBe('https://api.example.com/users')
    expect(r.file.http?.headers).toEqual([{ name: 'Content-Type', value: 'application/json' }])
    expect(r.file.http?.body).toEqual({ kind: 'raw', value: '{"a":1}' })
    expect(r.suggestedName).toBe('POST users')
  })

  it('imports a multi-line continuation command from a script with other lines', () => {
    const script = [
      '#!/bin/bash',
      'set -euo pipefail',
      'echo "calling api"',
      'curl --request GET \\',
      "  --url 'https://api.example.com/v1/items' \\",
      "  --header 'Accept: application/json'",
      'echo done'
    ].join('\n')
    const r = importCommandText(script)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.file.http?.url).toBe('https://api.example.com/v1/items')
    expect(r.file.http?.headers).toEqual([{ name: 'Accept', value: 'application/json' }])
  })

  it('drops unsupported flags with an import-note instead of failing', () => {
    const r = importCommandText(
      `curl -s --compressed -o /tmp/out.json -X GET https://x.dev/api -H 'Accept: text/plain'`
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.file.http?.url).toBe('https://x.dev/api')
    const note = String(r.file.frontmatter['import-note'])
    expect(note).toContain('-s')
    expect(note).toContain('--compressed')
    expect(note).toContain('-o')
  })

  it('maps -A, -e and -b k=v to headers', () => {
    const r = importCommandText(`curl https://x.dev/ -A myagent -e https://ref.er -b 'sid=abc'`)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.file.http?.headers).toEqual([
      { name: 'User-Agent', value: 'myagent' },
      { name: 'Referer', value: 'https://ref.er' },
      { name: 'Cookie', value: 'sid=abc' }
    ])
  })

  it('declares variables for ${VAR} references in the pasted command', () => {
    const r = importCommandText('curl "https://${HOST}/api" -H "Authorization: Bearer ${TOKEN}"')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.file.variables.map((v) => v.name).sort()).toEqual(['HOST', 'TOKEN'])
  })

  it('accepts a full canonical .curl file (strict path)', () => {
    const canonical = [
      '#!/usr/bin/env bash',
      '# ---',
      '# description: hi',
      '# ---',
      '',
      'BASE_URL="${BASE_URL:-x.dev}"',
      '',
      'curl --request GET \\',
      '  --url "https://${BASE_URL}/ip"'
    ].join('\n')
    const r = importCommandText(canonical)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.file.frontmatter.description).toBe('hi')
    expect(r.file.variables).toEqual([
      { name: 'BASE_URL', defaultValue: 'x.dev', required: false }
    ])
  })

  it('produces a writable file (round-trips through the canonical writer)', () => {
    const r = importCommandText(`curl -X PUT https://a.b/c/d -d 'x'`)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const text = writeRequestFile(r.file)
    expect(text).toContain('curl --request PUT')
    expect(text).toContain("--url 'https://a.b/c/d'")
  })

  it('rejects input with no supported command', () => {
    const r = importCommandText('echo hello\nls -la')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('No curl, websocat, or wscat command')
  })
})

describe('importCommandText — websocat & wscat', () => {
  it('imports a websocat command', () => {
    const r = importCommandText(`websocat wss://stream.example.com/feed --header 'Auth: x' --protocol v1`)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.kind).toBe('websocat')
    expect(r.file.ws?.url).toBe('wss://stream.example.com/feed')
    expect(r.file.ws?.protocol).toBe('v1')
  })

  it('imports a wscat command with -c, headers, and subprotocol', () => {
    const r = importCommandText(`wscat -c wss://echo.example.org -H 'X-Key: k1' -s graphql-ws`)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.kind).toBe('websocat')
    expect(r.file.ws?.url).toBe('wss://echo.example.org')
    expect(r.file.ws?.headers).toEqual([{ name: 'X-Key', value: 'k1' }])
    expect(r.file.ws?.protocol).toBe('graphql-ws')
  })

  it('maps wscat --auth to a Basic Authorization header', () => {
    const r = importCommandText('wscat -c ws://h/ --auth user:pass')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.file.ws?.headers).toEqual([
      { name: 'Authorization', value: `Basic ${Buffer.from('user:pass').toString('base64')}` }
    ])
  })

  it('notes ignored wscat flags and fails without a URL', () => {
    const ok = importCommandText('wscat -c ws://h/ --no-color -n')
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      const note = String(ok.file.frontmatter['import-note'])
      expect(note).toContain('--no-color')
      expect(note).toContain('-n')
    }
    const bad = importCommandText('wscat -H "a: b"')
    expect(bad.ok).toBe(false)
  })
})
