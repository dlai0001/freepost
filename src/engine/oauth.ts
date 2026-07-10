/**
 * OAuth2 token acquisition. Runs in the Electron MAIN process (Node context).
 *
 * Part of src/engine — the ONLY place in the codebase allowed to touch the
 * network (PLAN.md "Network policy"). Outbound HTTP is done via sendHttp from
 * ./http; the one exception is the loopback redirect listener used by the
 * authorization_code flow (RFC 8252), which opens a local-only http server to
 * catch the provider's redirect. That listener lives here, inside the engine
 * fence, so the "only src/engine opens sockets" invariant stays literally true.
 */

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import type { AcquiredToken, OAuth2Config } from '../shared/model'
import { sendHttp } from './http'

/** How many characters of a failed token response body to include in errors. */
const BODY_SNIPPET_LEN = 500

/** Default time to wait for the interactive redirect before giving up. */
const DEFAULT_AUTHORIZE_TIMEOUT_MS = 300_000

/** Basic auth header value for a client id / secret pair. */
function basicAuth(clientId: string, clientSecret: string): string {
  return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
}

/** base64url-encode a buffer (no padding), per RFC 7636. */
function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Common form-encoded token-request headers. */
function tokenRequestHeaders(): { name: string; value: string }[] {
  return [
    { name: 'Content-Type', value: 'application/x-www-form-urlencoded' },
    { name: 'Accept', value: 'application/json' }
  ]
}

/**
 * Parse a token endpoint HTTP response into an AcquiredToken. Shared by every
 * grant (client_credentials, password, authorization_code, refresh_token).
 * Throws on non-2xx, non-JSON, or missing access_token.
 */
function parseTokenResponse(res: {
  status: number
  statusText: string
  bodyText: string
}): AcquiredToken {
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
 *    authorization code; not supported here (throws). Use
 *    startAuthorizationCodeFlow instead.
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
        'authorization_code grant requires an interactive flow; use startAuthorizationCodeFlow'
      )
    }
    default: {
      // Exhaustiveness guard; OAuth2Grant is a closed union.
      throw new Error(`Unsupported OAuth2 grant: ${String((config as OAuth2Config).grant)}`)
    }
  }

  const headers = tokenRequestHeaders()
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

  return parseTokenResponse(res)
}

/**
 * Exchange a refresh_token for a fresh access token (RFC 6749 §6). The provider
 * may or may not return a new refresh_token; when it doesn't, callers should
 * keep the previous one.
 */
export async function refreshToken(
  config: OAuth2Config,
  refreshTokenValue: string,
  resolve: (s: string) => string
): Promise<AcquiredToken> {
  const tokenUrl = resolve(config.tokenUrl)
  const clientId = resolve(config.clientId)
  const clientSecret =
    config.clientSecret !== undefined ? resolve(config.clientSecret) : undefined
  const scope = config.scope !== undefined ? resolve(config.scope) : undefined

  const params = new URLSearchParams()
  params.set('grant_type', 'refresh_token')
  params.set('refresh_token', refreshTokenValue)
  if (scope) params.set('scope', scope)

  const headers = tokenRequestHeaders()
  if (clientSecret !== undefined) {
    headers.push({ name: 'Authorization', value: basicAuth(clientId, clientSecret) })
  } else {
    params.set('client_id', clientId)
  }

  const res = await sendHttp({
    method: 'POST',
    url: tokenUrl,
    headers,
    bodyText: params.toString()
  })
  return parseTokenResponse(res)
}

/** PKCE code verifier + S256 challenge (RFC 7636). Always used for auth-code. */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/** Build the provider authorize URL (response_type=code + PKCE + state). */
export function buildAuthorizeUrl(
  config: OAuth2Config,
  resolve: (s: string) => string,
  opts: { redirectUri: string; state: string; challenge: string }
): string {
  const u = new URL(resolve(config.authUrl ?? ''))
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', resolve(config.clientId))
  u.searchParams.set('redirect_uri', opts.redirectUri)
  u.searchParams.set('state', opts.state)
  u.searchParams.set('code_challenge', opts.challenge)
  u.searchParams.set('code_challenge_method', 'S256')
  const scope = config.scope !== undefined ? resolve(config.scope) : undefined
  if (scope) u.searchParams.set('scope', scope)
  return u.toString()
}

/** Exchange an authorization code for a token (PKCE verifier included). */
async function exchangeAuthCode(
  config: OAuth2Config,
  resolve: (s: string) => string,
  opts: { code: string; redirectUri: string; verifier: string }
): Promise<AcquiredToken> {
  const tokenUrl = resolve(config.tokenUrl)
  const clientId = resolve(config.clientId)
  const clientSecret =
    config.clientSecret !== undefined ? resolve(config.clientSecret) : undefined

  const params = new URLSearchParams()
  params.set('grant_type', 'authorization_code')
  params.set('code', opts.code)
  params.set('redirect_uri', opts.redirectUri)
  params.set('code_verifier', opts.verifier)

  const headers = tokenRequestHeaders()
  if (clientSecret !== undefined) {
    headers.push({ name: 'Authorization', value: basicAuth(clientId, clientSecret) })
  } else {
    params.set('client_id', clientId)
  }

  const res = await sendHttp({
    method: 'POST',
    url: tokenUrl,
    headers,
    bodyText: params.toString()
  })
  return parseTokenResponse(res)
}

/** Terminal outcome of an interactive authorization_code flow. */
export type AuthorizeResult =
  | { ok: true; token: AcquiredToken }
  | { ok: false; error: string }

export interface AuthorizeFlowArgs {
  /** Must have grant === 'authorization_code'. */
  config: OAuth2Config
  /** ${VAR} substitution applied to config values. */
  resolve: (s: string) => string
  /** Opens the system browser (caller injects shell.openExternal). */
  openUrl: (url: string) => void
  /** Milliseconds to wait for the redirect before failing. Default 5 min. */
  timeoutMs?: number
  /** Called exactly once with the terminal outcome. */
  onSettled: (result: AuthorizeResult) => void
}

/** Small HTML page shown in the user's browser after the redirect. */
function resultPage(title: string, detail: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
    `<style>body{font-family:system-ui,sans-serif;background:#0d1117;color:#c9d1d9;` +
    `display:flex;align-items:center;justify-content:center;height:100vh;margin:0}` +
    `.card{text-align:center;max-width:32rem;padding:2rem}` +
    `h1{color:#39c5cf;font-size:1.4rem}</style></head>` +
    `<body><div class="card"><h1>${title}</h1><p>${detail}</p></div></body></html>`
  )
}

/**
 * Run the interactive authorization_code flow (RFC 8252 native-app pattern):
 * start a loopback http listener, open the system browser to the provider's
 * authorize URL, capture the redirect, validate `state`, exchange the code
 * (with PKCE) for a token, and report the outcome via `onSettled` exactly once.
 *
 * The returned promise resolves once the loopback listener is up and the
 * browser has been opened; it REJECTS if the listener cannot start (e.g. a
 * pinned redirectUri port is already in use, or the redirectUri is not a
 * loopback address) — in that case the browser is never opened and `onSettled`
 * is not called. All post-start outcomes (success, provider error, timeout,
 * cancel) go through `onSettled`.
 */
export async function startAuthorizationCodeFlow(
  args: AuthorizeFlowArgs
): Promise<{ redirectUri: string; cancel: () => void }> {
  const { config, resolve, openUrl, onSettled } = args
  if (config.grant !== 'authorization_code') {
    throw new Error('startAuthorizationCodeFlow requires the authorization_code grant')
  }
  if (config.authUrl === undefined || resolve(config.authUrl).trim() === '') {
    throw new Error('authorization_code flow requires an authUrl')
  }

  // Loopback bind target: derived from a pinned redirectUri, else ephemeral.
  let host = '127.0.0.1'
  let port = 0
  let path = '/callback'
  if (config.redirectUri !== undefined && config.redirectUri.trim() !== '') {
    const raw = resolve(config.redirectUri)
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      throw new Error(`Invalid redirectUri: ${raw}`)
    }
    if (parsed.protocol !== 'http:') {
      throw new Error(`redirectUri must be an http:// loopback address, got ${parsed.protocol}`)
    }
    const hn = parsed.hostname
    if (hn !== '127.0.0.1' && hn !== 'localhost' && hn !== '::1') {
      throw new Error(`redirectUri must be a loopback address (127.0.0.1/localhost), got ${hn}`)
    }
    host = hn === 'localhost' ? '127.0.0.1' : hn
    port = parsed.port !== '' ? Number(parsed.port) : 0
    path = parsed.pathname === '' ? '/' : parsed.pathname
  }

  const pkce = generatePkce()
  const state = base64url(randomBytes(16))

  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let redirectUri = ''
  const server = createServer()

  const finish = (result: AuthorizeResult): void => {
    if (settled) return
    settled = true
    if (timer !== undefined) clearTimeout(timer)
    server.close()
    onSettled(result)
  }

  server.on('request', (req, res) => {
    const reqUrl = new URL(req.url ?? '/', `http://${host}`)
    if (reqUrl.pathname !== path) {
      res.statusCode = 404
      res.end('Not found')
      return
    }
    const params = reqUrl.searchParams
    // Reject responses that don't match the pending request; do NOT settle —
    // a stale/duplicate browser tab shouldn't abort a live flow.
    if (params.get('state') !== state) {
      res.statusCode = 400
      res.setHeader('Content-Type', 'text/html')
      res.end(
        resultPage('Invalid request', 'This sign-in response did not match a pending request.')
      )
      return
    }
    const errParam = params.get('error')
    if (errParam !== null) {
      const desc = params.get('error_description')
      const message = desc !== null ? `${errParam}: ${desc}` : errParam
      res.setHeader('Content-Type', 'text/html')
      res.end(resultPage('Sign-in failed', message))
      finish({ ok: false, error: message })
      return
    }
    const code = params.get('code')
    if (code === null || code === '') {
      res.statusCode = 400
      res.setHeader('Content-Type', 'text/html')
      res.end(resultPage('Sign-in failed', 'No authorization code was returned.'))
      finish({ ok: false, error: 'No authorization code returned' })
      return
    }
    // Respond to the browser immediately; exchange the code out of band.
    res.setHeader('Content-Type', 'text/html')
    res.end(resultPage('Signed in', 'You can close this tab and return to Freepost.'))
    exchangeAuthCode(config, resolve, { code, redirectUri, verifier: pkce.verifier })
      .then((token) => finish({ ok: true, token }))
      .catch((e) => finish({ ok: false, error: e instanceof Error ? e.message : String(e) }))
  })

  // Start listening; a failure here (EADDRINUSE on a pinned port) rejects
  // before the browser is ever opened.
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (e: Error): void => rejectListen(e)
    server.once('error', onError)
    server.listen(port, host, () => {
      server.removeListener('error', onError)
      const actualPort = (server.address() as AddressInfo).port
      redirectUri = `http://${host}:${actualPort}${path}`
      resolveListen()
    })
  })

  // Now that we're listening, route later socket errors into the flow outcome.
  server.on('error', (e) => finish({ ok: false, error: e instanceof Error ? e.message : String(e) }))

  timer = setTimeout(
    () => finish({ ok: false, error: 'Timed out waiting for sign-in' }),
    args.timeoutMs ?? DEFAULT_AUTHORIZE_TIMEOUT_MS
  )
  if (typeof timer.unref === 'function') timer.unref()

  openUrl(buildAuthorizeUrl(config, resolve, { redirectUri, state, challenge: pkce.challenge }))

  return {
    redirectUri,
    cancel: () => finish({ ok: false, error: 'Cancelled' })
  }
}
