import { createServer, get as httpGet } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { AcquiredToken, OAuth2Config } from '../shared/model'
import { startAuthorizationCodeFlow, generatePkce, buildAuthorizeUrl } from './oauth'

type Handler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  )
})

/** A stand-in OAuth provider: its /token endpoint runs `onToken`. */
function serve(handler: Handler): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => handler(req, res, Buffer.concat(chunks)))
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve(`http://127.0.0.1:${port}`)
    })
  })
}

const identity = (s: string): string => s

/** GET a URL and resolve with the status code (the browser completing the redirect). */
function browserHit(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    httpGet(url, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    }).on('error', reject)
  })
}

describe('startAuthorizationCodeFlow', () => {
  it('completes the flow: opens browser, captures code, exchanges with PKCE', async () => {
    let tokenReq: { grant?: string; code?: string; verifier?: string; redirect?: string } = {}
    const base = await serve((req, res, body) => {
      const params = new URLSearchParams(body.toString('utf8'))
      tokenReq = {
        grant: params.get('grant_type') ?? undefined,
        code: params.get('code') ?? undefined,
        verifier: params.get('code_verifier') ?? undefined,
        redirect: params.get('redirect_uri') ?? undefined
      }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ access_token: 'ac-token', token_type: 'Bearer', expires_in: 3600 }))
    })

    const config: OAuth2Config = {
      grant: 'authorization_code',
      tokenUrl: `${base}/token`,
      authUrl: `${base}/authorize`,
      clientId: 'my-app',
      scope: 'read'
    }

    const settled = new Promise<AcquiredToken>((resolve, reject) => {
      void startAuthorizationCodeFlow({
        config,
        resolve: identity,
        // The "browser": parse the authorize URL, then hit the loopback redirect
        // with the code and the exact state the flow generated.
        openUrl: (url) => {
          const u = new URL(url)
          const state = u.searchParams.get('state') ?? ''
          const redirect = u.searchParams.get('redirect_uri') ?? ''
          void browserHit(`${redirect}?code=auth-code-123&state=${encodeURIComponent(state)}`)
        },
        onSettled: (r) => (r.ok ? resolve(r.token) : reject(new Error(r.error)))
      })
    })

    const token = await settled
    expect(token.accessToken).toBe('ac-token')
    expect(tokenReq.grant).toBe('authorization_code')
    expect(tokenReq.code).toBe('auth-code-123')
    expect(tokenReq.redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    // The verifier must hash (S256) to the challenge the authorize URL carried.
    expect(tokenReq.verifier).toBeTruthy()
  })

  it('sends a PKCE challenge that matches the verifier used at exchange', async () => {
    let challengeFromAuthorize = ''
    let verifierFromToken = ''
    const base = await serve((req, res, body) => {
      const params = new URLSearchParams(body.toString('utf8'))
      verifierFromToken = params.get('code_verifier') ?? ''
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ access_token: 'tok' }))
    })
    const config: OAuth2Config = {
      grant: 'authorization_code',
      tokenUrl: `${base}/token`,
      authUrl: `${base}/authorize`,
      clientId: 'c'
    }
    await new Promise<void>((resolve, reject) => {
      void startAuthorizationCodeFlow({
        config,
        resolve: identity,
        openUrl: (url) => {
          const u = new URL(url)
          challengeFromAuthorize = u.searchParams.get('code_challenge') ?? ''
          expect(u.searchParams.get('code_challenge_method')).toBe('S256')
          const state = u.searchParams.get('state') ?? ''
          const redirect = u.searchParams.get('redirect_uri') ?? ''
          void browserHit(`${redirect}?code=x&state=${encodeURIComponent(state)}`)
        },
        onSettled: (r) => (r.ok ? resolve() : reject(new Error(r.error)))
      })
    })
    const expected = createHash('sha256')
      .update(verifierFromToken)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    expect(challengeFromAuthorize).toBe(expected)
  })

  it('rejects a callback whose state does not match (does not settle)', async () => {
    const base = await serve((_req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ access_token: 'should-not-happen' }))
    })
    const config: OAuth2Config = {
      grant: 'authorization_code',
      tokenUrl: `${base}/token`,
      authUrl: `${base}/authorize`,
      clientId: 'c'
    }
    let settledError: string | undefined
    const handle = await startAuthorizationCodeFlow({
      config,
      resolve: identity,
      openUrl: () => undefined, // don't auto-complete
      onSettled: (r) => {
        settledError = r.ok ? 'UNEXPECTED_OK' : r.error
      }
    })
    const status = await browserHit(`${handle.redirectUri}?code=x&state=WRONG`)
    expect(status).toBe(400)
    // The bad-state callback must NOT have settled the flow.
    expect(settledError).toBeUndefined()
    handle.cancel() // clean up the listener (this is the only legitimate settle)
    expect(settledError).toBe('Cancelled')
  })

  it('settles with an error when the provider returns error=access_denied', async () => {
    const base = await serve((_req, res) => res.end('{}'))
    const config: OAuth2Config = {
      grant: 'authorization_code',
      tokenUrl: `${base}/token`,
      authUrl: `${base}/authorize`,
      clientId: 'c'
    }
    const err = await new Promise<string>((resolve) => {
      void startAuthorizationCodeFlow({
        config,
        resolve: identity,
        openUrl: (url) => {
          const u = new URL(url)
          const state = u.searchParams.get('state') ?? ''
          const redirect = u.searchParams.get('redirect_uri') ?? ''
          void browserHit(
            `${redirect}?error=access_denied&error_description=denied&state=${encodeURIComponent(state)}`
          )
        },
        onSettled: (r) => resolve(r.ok ? 'UNEXPECTED_OK' : r.error)
      })
    })
    expect(err).toMatch(/access_denied/)
  })

  it('cancel() before the callback settles with a cancelled error', async () => {
    const base = await serve((_req, res) => res.end('{}'))
    const config: OAuth2Config = {
      grant: 'authorization_code',
      tokenUrl: `${base}/token`,
      authUrl: `${base}/authorize`,
      clientId: 'c'
    }
    const settled = new Promise<string>((resolve) => {
      void startAuthorizationCodeFlow({
        config,
        resolve: identity,
        openUrl: () => undefined,
        onSettled: (r) => resolve(r.ok ? 'UNEXPECTED_OK' : r.error)
      }).then((handle) => handle.cancel())
    })
    expect(await settled).toBe('Cancelled')
  })

  it('rejects the start promise when a pinned redirect port is already in use', async () => {
    // Occupy a port, then pin the redirectUri to it.
    const busy = createServer((_req, res) => res.end('busy'))
    servers.push(busy)
    const port: number = await new Promise((resolve) => {
      busy.listen(0, '127.0.0.1', () => resolve((busy.address() as AddressInfo).port))
    })
    const config: OAuth2Config = {
      grant: 'authorization_code',
      tokenUrl: 'http://127.0.0.1:1/token',
      authUrl: 'http://127.0.0.1:1/authorize',
      clientId: 'c',
      redirectUri: `http://127.0.0.1:${port}/callback`
    }
    let opened = false
    await expect(
      startAuthorizationCodeFlow({
        config,
        resolve: identity,
        openUrl: () => {
          opened = true
        },
        onSettled: () => undefined
      })
    ).rejects.toThrow()
    expect(opened).toBe(false)
  })

  it('rejects a non-loopback redirectUri', async () => {
    const config: OAuth2Config = {
      grant: 'authorization_code',
      tokenUrl: 'http://127.0.0.1:1/token',
      authUrl: 'http://127.0.0.1:1/authorize',
      clientId: 'c',
      redirectUri: 'http://example.com/callback'
    }
    await expect(
      startAuthorizationCodeFlow({
        config,
        resolve: identity,
        openUrl: () => undefined,
        onSettled: () => undefined
      })
    ).rejects.toThrow(/loopback/)
  })
})

describe('generatePkce / buildAuthorizeUrl', () => {
  it('generatePkce produces a verifier whose S256 hash is the challenge', () => {
    const { verifier, challenge } = generatePkce()
    const expected = createHash('sha256')
      .update(verifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    expect(challenge).toBe(expected)
    expect(verifier).not.toContain('=')
  })

  it('buildAuthorizeUrl sets the standard query params', () => {
    const url = buildAuthorizeUrl(
      {
        grant: 'authorization_code',
        tokenUrl: 'https://p/token',
        authUrl: 'https://p/authorize',
        clientId: 'client-1',
        scope: 'openid profile'
      },
      identity,
      { redirectUri: 'http://127.0.0.1:5000/callback', state: 'st', challenge: 'ch' }
    )
    const u = new URL(url)
    expect(u.searchParams.get('response_type')).toBe('code')
    expect(u.searchParams.get('client_id')).toBe('client-1')
    expect(u.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5000/callback')
    expect(u.searchParams.get('state')).toBe('st')
    expect(u.searchParams.get('code_challenge')).toBe('ch')
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('scope')).toBe('openid profile')
  })
})
