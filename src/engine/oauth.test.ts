import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { OAuth2Config } from '../shared/model'
import { acquireToken } from './oauth'

type Handler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  )
})

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

/** Identity resolver — no substitution. */
const identity = (s: string): string => s

describe('acquireToken', () => {
  it('client_credentials: sends Basic auth + grant_type and parses the token', async () => {
    let seen: {
      method?: string
      contentType?: string
      auth?: string
      body?: string
    } = {}
    const base = await serve((req, res, body) => {
      seen = {
        method: req.method,
        contentType: req.headers['content-type'],
        auth: req.headers['authorization'],
        body: body.toString('utf8')
      }
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          access_token: 'tok-abc',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'refresh-xyz',
          scope: 'read write'
        })
      )
    })

    const config: OAuth2Config = {
      grant: 'client_credentials',
      tokenUrl: `${base}/token`,
      clientId: 'my-client',
      clientSecret: 's3cret',
      scope: 'read write'
    }
    const before = Date.now()
    const token = await acquireToken(config, identity)
    const after = Date.now()

    expect(seen.method).toBe('POST')
    expect(seen.contentType).toBe('application/x-www-form-urlencoded')
    expect(seen.auth).toBe('Basic ' + Buffer.from('my-client:s3cret').toString('base64'))
    const params = new URLSearchParams(seen.body)
    expect(params.get('grant_type')).toBe('client_credentials')
    expect(params.get('scope')).toBe('read write')

    expect(token.accessToken).toBe('tok-abc')
    expect(token.tokenType).toBe('Bearer')
    expect(token.refreshToken).toBe('refresh-xyz')
    expect(token.scope).toBe('read write')
    expect(token.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000)
    expect(token.expiresAt).toBeLessThanOrEqual(after + 3600 * 1000)
  })

  it('defaults token_type to Bearer and omits expiresAt when expires_in absent', async () => {
    const base = await serve((_req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ access_token: 'only-token' }))
    })
    const token = await acquireToken(
      { grant: 'client_credentials', tokenUrl: `${base}/token`, clientId: 'c' },
      identity
    )
    expect(token.accessToken).toBe('only-token')
    expect(token.tokenType).toBe('Bearer')
    expect(token.expiresAt).toBeUndefined()
    expect(token.refreshToken).toBeUndefined()
  })

  it('password grant: sends username/password and Basic client auth', async () => {
    let seen: { auth?: string; body?: string } = {}
    const base = await serve((req, res, body) => {
      seen = { auth: req.headers['authorization'], body: body.toString('utf8') }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ access_token: 'pw-token', token_type: 'Bearer' }))
    })
    const config: OAuth2Config = {
      grant: 'password',
      tokenUrl: `${base}/token`,
      clientId: 'app',
      clientSecret: 'shh',
      username: 'alice',
      password: 'hunter2',
      scope: 'profile'
    }
    const token = await acquireToken(config, identity)
    const params = new URLSearchParams(seen.body)
    expect(params.get('grant_type')).toBe('password')
    expect(params.get('username')).toBe('alice')
    expect(params.get('password')).toBe('hunter2')
    expect(params.get('scope')).toBe('profile')
    expect(seen.auth).toBe('Basic ' + Buffer.from('app:shh').toString('base64'))
    expect(token.accessToken).toBe('pw-token')
  })

  it('password grant without secret: sends client_id in body, no Basic auth', async () => {
    let seen: { auth?: string; body?: string } = {}
    const base = await serve((req, res, body) => {
      seen = { auth: req.headers['authorization'], body: body.toString('utf8') }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ access_token: 'pub-token' }))
    })
    const config: OAuth2Config = {
      grant: 'password',
      tokenUrl: `${base}/token`,
      clientId: 'public-app',
      username: 'bob',
      password: 'pw'
    }
    await acquireToken(config, identity)
    expect(seen.auth).toBeUndefined()
    const params = new URLSearchParams(seen.body)
    expect(params.get('client_id')).toBe('public-app')
  })

  it('applies the resolve substitution to config values', async () => {
    let seen: { auth?: string; url?: string; body?: string } = {}
    const base = await serve((req, res, body) => {
      seen = { auth: req.headers['authorization'], url: req.url, body: body.toString('utf8') }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ access_token: 'resolved-token' }))
    })
    const vars: Record<string, string> = {
      '${BASE}': base,
      '${CID}': 'resolved-client',
      '${SECRET}': 'resolved-secret',
      '${SCOPE}': 'resolved-scope'
    }
    const resolve = (s: string): string =>
      s.replace(/\$\{[^}]+\}/g, (m) => vars[m] ?? m)

    const config: OAuth2Config = {
      grant: 'client_credentials',
      tokenUrl: '${BASE}/token',
      clientId: '${CID}',
      clientSecret: '${SECRET}',
      scope: '${SCOPE}'
    }
    const token = await acquireToken(config, resolve)
    expect(token.accessToken).toBe('resolved-token')
    expect(seen.url).toBe('/token')
    expect(seen.auth).toBe(
      'Basic ' + Buffer.from('resolved-client:resolved-secret').toString('base64')
    )
    expect(new URLSearchParams(seen.body).get('scope')).toBe('resolved-scope')
  })

  it('throws when the response is missing access_token', async () => {
    const base = await serve((_req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ token_type: 'Bearer', expires_in: 60 }))
    })
    await expect(
      acquireToken(
        { grant: 'client_credentials', tokenUrl: `${base}/token`, clientId: 'c' },
        identity
      )
    ).rejects.toThrow(/missing access_token/)
  })

  it('throws with status and body snippet on a non-2xx token response', async () => {
    const base = await serve((_req, res) => {
      res.statusCode = 401
      res.end('{"error":"invalid_client"}')
    })
    await expect(
      acquireToken(
        {
          grant: 'client_credentials',
          tokenUrl: `${base}/token`,
          clientId: 'c',
          clientSecret: 'bad'
        },
        identity
      )
    ).rejects.toThrow(/401.*invalid_client/s)
  })

  it('throws the not-supported error for authorization_code', async () => {
    await expect(
      acquireToken(
        {
          grant: 'authorization_code',
          tokenUrl: 'https://example.com/token',
          authUrl: 'https://example.com/authorize',
          clientId: 'c',
          redirectUri: 'http://localhost/cb'
        },
        identity
      )
    ).rejects.toThrow('authorization_code grant requires an interactive flow; use startAuthorizationCodeFlow')
  })
})
