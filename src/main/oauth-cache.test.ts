import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AcquiredToken, OAuth2Config } from '../shared/model'
import {
  isExpired,
  readCachedToken,
  tokenCacheKey,
  writeCachedToken
} from './oauth-cache'

let root = ''
const identity = (s: string): string => s

const config: OAuth2Config = {
  grant: 'authorization_code',
  tokenUrl: 'https://provider.example/token',
  authUrl: 'https://provider.example/authorize',
  clientId: 'my-client',
  scope: 'read'
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'freepost-oauthcache-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('oauth-cache', () => {
  it('round-trips a token through write/read', async () => {
    const token: AcquiredToken = {
      accessToken: 'abc',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 3600_000,
      refreshToken: 'r1',
      scope: 'read'
    }
    await writeCachedToken(root, config, identity, token)
    const back = await readCachedToken(root, config, identity)
    expect(back).toEqual(token)
  })

  it('stores under .freepost/oauth-tokens/ (gitignored area)', async () => {
    await writeCachedToken(root, config, identity, { accessToken: 'x', tokenType: 'Bearer' })
    const key = tokenCacheKey(config, identity)
    expect(existsSync(join(root, '.freepost', 'oauth-tokens', `${key}.json`))).toBe(true)
    // The .freepost/.gitignore guardrail is regenerated on write.
    expect(readFileSync(join(root, '.freepost', '.gitignore'), 'utf8')).toContain('*')
  })

  it('returns undefined when nothing is cached', async () => {
    expect(await readCachedToken(root, config, identity)).toBeUndefined()
  })

  it('keys are stable for the same resolved identity and differ across scope', () => {
    const k1 = tokenCacheKey(config, identity)
    const k2 = tokenCacheKey(config, identity)
    expect(k1).toBe(k2)
    const k3 = tokenCacheKey({ ...config, scope: 'write' }, identity)
    expect(k3).not.toBe(k1)
  })

  it('applies the resolver to identity fields', () => {
    const resolve = (s: string): string => s.replace('${CID}', 'resolved-client')
    const withVar: OAuth2Config = { ...config, clientId: '${CID}' }
    expect(tokenCacheKey(withVar, resolve)).toBe(tokenCacheKey({ ...config, clientId: 'resolved-client' }, identity))
  })

  it('isExpired: true within the skew window, false with plenty of time', () => {
    expect(isExpired({ accessToken: 'a', tokenType: 'Bearer', expiresAt: Date.now() + 5_000 })).toBe(true)
    expect(isExpired({ accessToken: 'a', tokenType: 'Bearer', expiresAt: Date.now() + 3600_000 })).toBe(false)
  })

  it('isExpired: false when no expiry is known', () => {
    expect(isExpired({ accessToken: 'a', tokenType: 'Bearer' })).toBe(false)
  })
})
