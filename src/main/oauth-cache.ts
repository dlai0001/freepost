/**
 * On-disk OAuth2 token cache, kept inside the collection's `.freepost/`
 * subfolder (PLAN.md "Auth & secrets: fully collection-contained"). Tokens are
 * content-addressed by the resolved provider/client identity, so every request
 * or folder that inherits the same collection-level auth config shares one
 * cached token. No network here — this is the fs half; acquisition lives in
 * src/engine/oauth.ts.
 */
import { promises as fs } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import type { AcquiredToken, OAuth2Config } from '../shared/model'
import { ensureFreepostDir } from './collection'
import { secureFile } from './security'

/** Guard interval: treat a token as expired this long before its real expiry. */
const EXPIRY_SKEW_MS = 30_000

/** Subfolder under `.freepost/` holding one JSON file per cache key. */
const CACHE_SUBDIR = 'oauth-tokens'

/** On-disk cache record (the token plus a little debugging provenance). */
interface CacheRecord extends AcquiredToken {
  tokenUrl: string
  clientId: string
  cachedAt: string
}

/**
 * Stable cache key for a resolved auth config: a hex digest of the fields that
 * identify "which token this is" — grant, token/auth endpoints, client id, and
 * scope. Values are resolved (${VAR}-substituted) first so two requests that
 * point at the same provider via the same variables share a token.
 */
export function tokenCacheKey(config: OAuth2Config, resolve: (s: string) => string): string {
  const identity = JSON.stringify({
    grant: config.grant,
    tokenUrl: resolve(config.tokenUrl),
    authUrl: config.authUrl !== undefined ? resolve(config.authUrl) : '',
    clientId: resolve(config.clientId),
    scope: config.scope !== undefined ? resolve(config.scope) : ''
  })
  return createHash('sha256').update(identity).digest('hex').slice(0, 24)
}

function cacheFilePath(root: string, key: string): string {
  return join(root, '.freepost', CACHE_SUBDIR, `${key}.json`)
}

/** True when the token is absent an expiry, or within the skew of expiring. */
export function isExpired(token: AcquiredToken, skewMs = EXPIRY_SKEW_MS): boolean {
  if (token.expiresAt === undefined) return false
  return Date.now() >= token.expiresAt - skewMs
}

/** Read the cached token for this config, or undefined if none is stored. */
export async function readCachedToken(
  root: string,
  config: OAuth2Config,
  resolve: (s: string) => string
): Promise<AcquiredToken | undefined> {
  const file = cacheFilePath(root, tokenCacheKey(config, resolve))
  try {
    const rec = JSON.parse(await fs.readFile(file, 'utf8')) as CacheRecord
    if (typeof rec.accessToken !== 'string' || rec.accessToken === '') return undefined
    const token: AcquiredToken = { accessToken: rec.accessToken, tokenType: rec.tokenType }
    if (typeof rec.expiresAt === 'number') token.expiresAt = rec.expiresAt
    if (typeof rec.refreshToken === 'string') token.refreshToken = rec.refreshToken
    if (typeof rec.scope === 'string') token.scope = rec.scope
    return token
  } catch {
    return undefined // absent or corrupt — treat as no cached token
  }
}

/** Persist a token for this config (0600, under the gitignored `.freepost/`). */
export async function writeCachedToken(
  root: string,
  config: OAuth2Config,
  resolve: (s: string) => string,
  token: AcquiredToken
): Promise<void> {
  const dir = join(ensureFreepostDir(root), CACHE_SUBDIR)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, `${tokenCacheKey(config, resolve)}.json`)
  const rec: CacheRecord = {
    ...token,
    tokenUrl: resolve(config.tokenUrl),
    clientId: resolve(config.clientId),
    cachedAt: new Date().toISOString()
  }
  await fs.writeFile(file, JSON.stringify(rec, null, 2) + '\n')
  await secureFile(file)
}
