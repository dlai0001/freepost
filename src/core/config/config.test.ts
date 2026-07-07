import { describe, expect, it } from 'vitest'
import type { CollectionConfig, Header, OAuth2Config } from '@shared/model'
import {
  mergeRequestHeaders,
  parseConfig,
  resolveConfig,
  serializeConfig,
  type ConfigChainEntry
} from './index'

const h = (name: string, value: string): Header => ({ name, value })

describe('parseConfig', () => {
  it('parses a full valid config', () => {
    const json = JSON.stringify({
      defaultHeaders: [{ name: 'Accept', value: 'application/json' }],
      auth: {
        grant: 'client_credentials',
        tokenUrl: 'https://auth.example.com/token',
        clientId: 'abc',
        clientSecret: 'shh'
      },
      scripts: { 'pre-request': 'pm.a()', test: 'pm.b()' },
      clientCert: './cert.pem',
      clientKey: './key.pem',
      clientKeyPassphrase: 'pw',
      proxy: 'http://proxy.corp:8080',
      caCert: './corp-ca.pem'
    })
    const res = parseConfig(json)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.config.defaultHeaders).toEqual([{ name: 'Accept', value: 'application/json' }])
    expect(res.config.auth?.grant).toBe('client_credentials')
    expect(res.config.scripts).toEqual({ 'pre-request': 'pm.a()', test: 'pm.b()' })
    expect(res.config.clientCert).toBe('./cert.pem')
    expect(res.config.proxy).toBe('http://proxy.corp:8080')
    expect(res.config.caCert).toBe('./corp-ca.pem')
  })

  it('accepts an empty object', () => {
    const res = parseConfig('{}')
    expect(res).toEqual({ ok: true, config: {} })
  })

  it('ignores unknown extra keys (forward-compat)', () => {
    const res = parseConfig(JSON.stringify({ futureField: 42, defaultHeaders: [] }))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect((res.config as Record<string, unknown>).futureField).toBeUndefined()
    expect(res.config.defaultHeaders).toEqual([])
  })

  it('rejects invalid JSON', () => {
    const res = parseConfig('{not json')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toContain('invalid JSON')
  })

  it('rejects a non-object top level', () => {
    const res = parseConfig('[]')
    expect(res).toMatchObject({ ok: false })
    if (parseConfig('[]').ok) return
    expect((parseConfig('[]') as { ok: false; error: string }).error).toContain('object')
  })

  it('rejects defaultHeaders that is not an array', () => {
    const res = parseConfig(JSON.stringify({ defaultHeaders: {} }))
    expect(res).toMatchObject({ ok: false })
    if (res.ok) return
    expect(res.error).toContain('defaultHeaders')
  })

  it('rejects a header with a non-string value', () => {
    const res = parseConfig(JSON.stringify({ defaultHeaders: [{ name: 'X', value: 1 }] }))
    expect(res).toMatchObject({ ok: false })
    if (res.ok) return
    expect(res.error).toBe('defaultHeaders[0].value must be a string')
  })

  it('rejects scripts with a non-string member', () => {
    const res = parseConfig(JSON.stringify({ scripts: { 'pre-request': 5 } }))
    expect(res).toMatchObject({ ok: false })
    if (res.ok) return
    expect(res.error).toContain("scripts['pre-request']")
  })

  it('rejects a non-string clientKeyPassphrase', () => {
    const res = parseConfig(JSON.stringify({ clientKeyPassphrase: true }))
    expect(res).toMatchObject({ ok: false })
    if (res.ok) return
    expect(res.error).toBe('clientKeyPassphrase must be a string')
  })

  it('rejects auth missing required grant', () => {
    const res = parseConfig(
      JSON.stringify({ auth: { tokenUrl: 'u', clientId: 'c' } })
    )
    expect(res).toMatchObject({ ok: false })
    if (res.ok) return
    expect(res.error).toBe('auth.grant must be a string')
  })

  it('rejects auth with an unknown grant', () => {
    const res = parseConfig(
      JSON.stringify({ auth: { grant: 'magic', tokenUrl: 'u', clientId: 'c' } })
    )
    expect(res).toMatchObject({ ok: false })
    if (res.ok) return
    expect(res.error).toContain('auth.grant must be one of')
  })

  it('rejects auth missing tokenUrl', () => {
    const res = parseConfig(
      JSON.stringify({ auth: { grant: 'password', clientId: 'c' } })
    )
    expect(res).toMatchObject({ ok: false })
    if (res.ok) return
    expect(res.error).toBe('auth.tokenUrl must be a string')
  })

  it('rejects auth missing clientId', () => {
    const res = parseConfig(
      JSON.stringify({ auth: { grant: 'password', tokenUrl: 'u' } })
    )
    expect(res).toMatchObject({ ok: false })
    if (res.ok) return
    expect(res.error).toBe('auth.clientId must be a string')
  })

  it('rejects auth with a non-string optional field', () => {
    const res = parseConfig(
      JSON.stringify({ auth: { grant: 'password', tokenUrl: 'u', clientId: 'c', scope: 9 } })
    )
    expect(res).toMatchObject({ ok: false })
    if (res.ok) return
    expect(res.error).toBe('auth.scope must be a string')
  })
})

describe('serializeConfig', () => {
  it('emits stable 2-space JSON with a trailing newline', () => {
    const config: CollectionConfig = {
      defaultHeaders: [h('Accept', 'application/json')],
      scripts: { 'pre-request': 'pm.a()' }
    }
    const out = serializeConfig(config)
    expect(out.endsWith('\n')).toBe(true)
    expect(out).toBe(
      '{\n' +
        '  "defaultHeaders": [\n' +
        '    {\n' +
        '      "name": "Accept",\n' +
        '      "value": "application/json"\n' +
        '    }\n' +
        '  ],\n' +
        '  "scripts": {\n' +
        '    "pre-request": "pm.a()"\n' +
        '  }\n' +
        '}\n'
    )
  })

  it('round-trips through parseConfig', () => {
    const config: CollectionConfig = {
      defaultHeaders: [h('Accept', 'application/json'), h('X-Env', 'prod')],
      auth: {
        grant: 'password',
        tokenUrl: 'https://a/token',
        clientId: 'id',
        username: 'u',
        password: 'p'
      } as OAuth2Config,
      scripts: { 'pre-request': 'a', test: 'b' },
      clientCert: './c.pem',
      clientKey: './k.pem',
      clientKeyPassphrase: 'x'
    }
    const round = parseConfig(serializeConfig(config))
    expect(round.ok).toBe(true)
    if (!round.ok) return
    expect(round.config).toEqual(config)
    // Serializing again is byte-identical (stable).
    expect(serializeConfig(round.config)).toBe(serializeConfig(config))
  })

  it('serializes in canonical key order regardless of input order', () => {
    const a: CollectionConfig = { clientCert: 'c', defaultHeaders: [] }
    const b: CollectionConfig = { defaultHeaders: [], clientCert: 'c' }
    expect(serializeConfig(a)).toBe(serializeConfig(b))
  })
})

describe('resolveConfig — 3-level chain', () => {
  // OUTERMOST-FIRST: collection root -> folder -> subfolder (toward the request).
  const chain: ConfigChainEntry[] = [
    {
      origin: 'collection.json',
      config: {
        defaultHeaders: [h('Accept', 'application/json'), h('X-Scope', 'collection')],
        scripts: { 'pre-request': 'collPre', test: 'collTest' },
        auth: {
          grant: 'client_credentials',
          tokenUrl: 'https://coll/token',
          clientId: 'coll'
        },
        clientCert: './coll-cert.pem',
        clientKey: './coll-key.pem',
        clientKeyPassphrase: 'coll-pw'
      }
    },
    {
      origin: 'api/folder.json',
      config: {
        // Overrides X-Scope (case-insensitive name match), adds X-Api.
        defaultHeaders: [h('x-scope', 'folder'), h('X-Api', 'v2')],
        scripts: { 'pre-request': 'folderPre' }, // no test script
        clientCert: './folder-cert.pem' // overrides cert only
      }
    },
    {
      origin: 'api/users/folder.json',
      config: {
        scripts: { test: 'subTest' },
        auth: {
          grant: 'password',
          tokenUrl: 'https://sub/token',
          clientId: 'sub'
        }
      }
    }
  ]

  const resolved = resolveConfig(chain)

  it('overrides headers by specificity, keeping first-seen order', () => {
    expect(resolved.defaultHeaders).toEqual([
      h('Accept', 'application/json'),
      h('x-scope', 'folder'), // most-specific value, but at the original position
      h('X-Api', 'v2')
    ])
  })

  it('orders pre-scripts outermost-first with origins', () => {
    expect(resolved.preScripts).toEqual([
      { source: 'collPre', origin: 'collection.json' },
      { source: 'folderPre', origin: 'api/folder.json' }
    ])
  })

  it('orders test-scripts outermost-first with origins, skipping empty', () => {
    expect(resolved.testScripts).toEqual([
      { source: 'collTest', origin: 'collection.json' },
      { source: 'subTest', origin: 'api/users/folder.json' }
    ])
  })

  it('picks the most-specific auth', () => {
    expect(resolved.auth?.clientId).toBe('sub')
    expect(resolved.auth?.grant).toBe('password')
  })

  it('resolves cert/key/passphrase most-specific independently', () => {
    // cert overridden at folder level; key + passphrase only defined at collection.
    expect(resolved.clientCert).toBe('./folder-cert.pem')
    expect(resolved.clientKey).toBe('./coll-key.pem')
    expect(resolved.clientKeyPassphrase).toBe('coll-pw')
  })

  it('returns empty structures for an empty chain', () => {
    expect(resolveConfig([])).toEqual({
      defaultHeaders: [],
      preScripts: [],
      testScripts: []
    })
  })
})

describe('mergeRequestHeaders', () => {
  it('request headers win by name (case-insensitive), defaults first', () => {
    const config = [h('Accept', 'application/json'), h('X-Trace', 'on')]
    const request = [h('accept', 'text/plain'), h('X-Req', '1')]
    expect(mergeRequestHeaders(config, request)).toEqual([
      h('X-Trace', 'on'), // surviving default
      h('accept', 'text/plain'), // request override wins
      h('X-Req', '1')
    ])
  })

  it('preserves order within each group', () => {
    const config = [h('A', '1'), h('B', '2'), h('C', '3')]
    const request = [h('b', 'override')]
    expect(mergeRequestHeaders(config, request)).toEqual([
      h('A', '1'),
      h('C', '3'),
      h('b', 'override')
    ])
  })

  it('handles empty inputs', () => {
    expect(mergeRequestHeaders([], [h('X', '1')])).toEqual([h('X', '1')])
    expect(mergeRequestHeaders([h('X', '1')], [])).toEqual([h('X', '1')])
  })
})
