/**
 * OAuth2 token acquisition. Runs in the Electron MAIN process (Node context).
 *
 * Part of src/engine — the ONLY place in the codebase allowed to touch the
 * network (PLAN.md "Network policy"). All HTTP is done via sendHttp from
 * ./http; this module never opens a socket of its own.
 */

import type { AcquiredToken, OAuth2Config } from '../shared/model'
import { sendHttp } from './http'

/** How many characters of a failed token response body to include in errors. */
const BODY_SNIPPET_LEN = 500

/** Basic auth header value for a client id / secret pair. */
function basicAuth(clientId: string, clientSecret: string): string {
  return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
}

/**
 * Acquire an OAuth2 access token for the given config.
 *
 * `resolve` is a variable-substitution function injected by the caller; it is
 * applied to every config value that may contain ${VAR} references before the
 * value is used (tokenUrl, clientId, clientSecret, scope, username, password).
 *
 * Supported grants:
 *  - 'client_credentials': POST with Basic client auth (the standard).
 *  - 'password': POST username/password, plus Basic client auth when a secret
 *    is configured.
 *  - 'authorization_code': requires an interactive redirect to obtain the
 *    authorization code; not supported here (throws). The function shape is
 *    kept so the token-exchange half can be added when the app supplies a code.
 *
 * Non-2xx token responses and responses missing access_token reject.
 */
export async function acquireToken(
  config: OAuth2Config,
  resolve: (s: string) => string
): Promise<AcquiredToken> {
  const tokenUrl = resolve(config.tokenUrl)
  const clientId = resolve(config.clientId)
  const clientSecret =
    config.clientSecret !== undefined ? resolve(config.clientSecret) : undefined
  const scope = config.scope !== undefined ? resolve(config.scope) : undefined

  const params = new URLSearchParams()

  switch (config.grant) {
    case 'client_credentials': {
      params.set('grant_type', 'client_credentials')
      if (scope) params.set('scope', scope)
      break
    }
    case 'password': {
      params.set('grant_type', 'password')
      params.set('username', config.username !== undefined ? resolve(config.username) : '')
      params.set('password', config.password !== undefined ? resolve(config.password) : '')
      if (scope) params.set('scope', scope)
      break
    }
    case 'authorization_code': {
      throw new Error(
        'authorization_code grant requires an interactive flow; not yet supported'
      )
    }
    default: {
      // Exhaustiveness guard; OAuth2Grant is a closed union.
      throw new Error(`Unsupported OAuth2 grant: ${String((config as OAuth2Config).grant)}`)
    }
  }

  const headers = [
    { name: 'Content-Type', value: 'application/x-www-form-urlencoded' },
    { name: 'Accept', value: 'application/json' }
  ]
  // Standard client auth: HTTP Basic with clientId:clientSecret. For the
  // password grant the secret is optional (public clients).
  if (clientSecret !== undefined) {
    headers.push({ name: 'Authorization', value: basicAuth(clientId, clientSecret) })
  } else if (config.grant === 'password') {
    // Public client: identify via body per RFC 6749 §4.3.2.
    params.set('client_id', clientId)
  }

  const res = await sendHttp({
    method: 'POST',
    url: tokenUrl,
    headers,
    bodyText: params.toString()
  })

  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `Token endpoint returned ${res.status} ${res.statusText}: ` +
        res.bodyText.slice(0, BODY_SNIPPET_LEN)
    )
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(res.bodyText) as Record<string, unknown>
  } catch {
    throw new Error(
      `Token endpoint returned non-JSON body: ${res.bodyText.slice(0, BODY_SNIPPET_LEN)}`
    )
  }

  const accessToken = parsed.access_token
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('Token endpoint response missing access_token')
  }

  const token: AcquiredToken = {
    accessToken,
    tokenType: typeof parsed.token_type === 'string' ? parsed.token_type : 'Bearer'
  }
  if (typeof parsed.expires_in === 'number') {
    // Engine runtime code — Date.now() is the correct clock here.
    token.expiresAt = Date.now() + parsed.expires_in * 1000
  }
  if (typeof parsed.refresh_token === 'string') token.refreshToken = parsed.refresh_token
  if (typeof parsed.scope === 'string') token.scope = parsed.scope

  return token
}
