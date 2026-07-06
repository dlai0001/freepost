import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { CookieJar } from './cookies'
import { sendHttp } from './http'

type Handler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  )
})

/** Start a local server; resolves with its base URL. Closed automatically. */
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

/** Server that echoes method/url/headers/body as JSON. */
function echoServer(): Promise<string> {
  return serve((req, res, body) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(
      JSON.stringify({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: body.toString('utf8')
      })
    )
  })
}

describe('sendHttp', () => {
  it('sends GET with query string and headers; echoes back; fills response model', async () => {
    const base = await echoServer()
    const r = await sendHttp({
      method: 'GET',
      url: `${base}/things?limit=5&q=a%20b`,
      headers: [{ name: 'X-Custom', value: 'yes' }]
    })
    expect(r.status).toBe(200)
    expect(r.statusText).toBe('OK')
    const echoed = JSON.parse(r.bodyText)
    expect(echoed.method).toBe('GET')
    expect(echoed.url).toBe('/things?limit=5&q=a%20b')
    expect(echoed.headers['x-custom']).toBe('yes')
    // defaults applied
    expect(echoed.headers['user-agent']).toBe('freepost')
    expect(echoed.headers['accept-encoding']).toBe('gzip, deflate, br')
    expect(echoed.headers.host).toMatch(/^127\.0\.0\.1:\d+$/)
    // response metadata
    expect(r.timeMs).toBeGreaterThan(0)
    expect(r.sizeBytes).toBe(Buffer.byteLength(r.bodyText))
    expect(
      r.headers.find((h) => h.name.toLowerCase() === 'content-type')?.value
    ).toBe('application/json')
  })

  it('does not override caller-provided User-Agent and Accept-Encoding', async () => {
    const base = await echoServer()
    const r = await sendHttp({
      method: 'GET',
      url: `${base}/`,
      headers: [
        { name: 'User-Agent', value: 'custom-agent' },
        { name: 'Accept-Encoding', value: 'identity' }
      ]
    })
    const echoed = JSON.parse(r.bodyText)
    expect(echoed.headers['user-agent']).toBe('custom-agent')
    expect(echoed.headers['accept-encoding']).toBe('identity')
  })

  it('roundtrips a POST body with Content-Length and no automatic Content-Type', async () => {
    const base = await echoServer()
    const bodyText = '{"a":1,"snowman":"☃"}'
    const r = await sendHttp({
      method: 'POST',
      url: `${base}/echo`,
      headers: [],
      bodyText
    })
    const echoed = JSON.parse(r.bodyText)
    expect(echoed.method).toBe('POST')
    expect(echoed.body).toBe(bodyText)
    expect(echoed.headers['content-length']).toBe(String(Buffer.byteLength(bodyText)))
    expect(echoed.headers['content-type']).toBeUndefined()
  })

  it('passes 4xx and 5xx through without throwing', async () => {
    const base = await serve((req, res) => {
      if (req.url === '/missing') {
        res.statusCode = 404
        res.end('not here')
      } else {
        res.statusCode = 500
        res.end('boom')
      }
    })
    const notFound = await sendHttp({ method: 'GET', url: `${base}/missing`, headers: [] })
    expect(notFound.status).toBe(404)
    expect(notFound.statusText).toBe('Not Found')
    expect(notFound.bodyText).toBe('not here')
    const error = await sendHttp({ method: 'GET', url: `${base}/kaboom`, headers: [] })
    expect(error.status).toBe(500)
    expect(error.bodyText).toBe('boom')
  })

  it('follows a redirect chain to the final response', async () => {
    const base = await serve((req, res) => {
      if (req.url === '/a') {
        res.statusCode = 301
        res.setHeader('Location', '/b')
        res.end()
      } else if (req.url === '/b') {
        res.statusCode = 302
        res.setHeader('Location', '/c')
        res.end()
      } else {
        res.end('made it')
      }
    })
    const r = await sendHttp({ method: 'GET', url: `${base}/a`, headers: [] })
    expect(r.status).toBe(200)
    expect(r.bodyText).toBe('made it')
  })

  it('converts 303 POST to GET without body (curl -L semantics)', async () => {
    let seen: { method?: string; body?: string; contentLength?: string } = {}
    const base = await serve((req, res, body) => {
      if (req.url === '/start') {
        res.statusCode = 303
        res.setHeader('Location', '/done')
        res.end()
      } else {
        seen = {
          method: req.method,
          body: body.toString('utf8'),
          contentLength: req.headers['content-length']
        }
        res.end('finished')
      }
    })
    const r = await sendHttp({
      method: 'POST',
      url: `${base}/start`,
      headers: [{ name: 'Content-Type', value: 'application/json' }],
      bodyText: '{"x":1}'
    })
    expect(r.status).toBe(200)
    expect(r.bodyText).toBe('finished')
    expect(seen.method).toBe('GET')
    expect(seen.body).toBe('')
    expect(seen.contentLength).toBeUndefined()
  })

  it('converts 302 POST to GET without body, but 307 preserves method and body', async () => {
    const seen: Array<{ url?: string; method?: string; body: string }> = []
    const base = await serve((req, res, body) => {
      if (req.url === '/r302') {
        res.statusCode = 302
        res.setHeader('Location', '/target')
        res.end()
      } else if (req.url === '/r307') {
        res.statusCode = 307
        res.setHeader('Location', '/target')
        res.end()
      } else {
        seen.push({ url: req.url, method: req.method, body: body.toString('utf8') })
        res.end('ok')
      }
    })
    await sendHttp({ method: 'POST', url: `${base}/r302`, headers: [], bodyText: 'payload' })
    await sendHttp({ method: 'POST', url: `${base}/r307`, headers: [], bodyText: 'payload' })
    expect(seen[0]).toEqual({ url: '/target', method: 'GET', body: '' })
    expect(seen[1]).toEqual({ url: '/target', method: 'POST', body: 'payload' })
  })

  it('returns the redirect response itself when followRedirects is false', async () => {
    const base = await serve((req, res) => {
      if (req.url === '/a') {
        res.statusCode = 302
        res.setHeader('Location', '/b')
        res.end('go elsewhere')
      } else {
        res.end('should not reach')
      }
    })
    const r = await sendHttp({
      method: 'GET',
      url: `${base}/a`,
      headers: [],
      options: { followRedirects: false }
    })
    expect(r.status).toBe(302)
    expect(r.headers.find((h) => h.name.toLowerCase() === 'location')?.value).toBe('/b')
    expect(r.bodyText).toBe('go elsewhere')
  })

  it('rejects after 10 redirect hops', async () => {
    const base = await serve((_req, res) => {
      res.statusCode = 302
      res.setHeader('Location', '/loop')
      res.end()
    })
    await expect(
      sendHttp({ method: 'GET', url: `${base}/loop`, headers: [] })
    ).rejects.toThrow(/Too many redirects/)
  })

  it('decompresses gzip responses; sizeBytes is the wire size', async () => {
    const compressed = gzipSync('hello gzip world, hello gzip world, hello gzip world')
    const base = await serve((_req, res) => {
      res.setHeader('Content-Encoding', 'gzip')
      res.end(compressed)
    })
    const r = await sendHttp({ method: 'GET', url: `${base}/`, headers: [] })
    expect(r.bodyText).toBe('hello gzip world, hello gzip world, hello gzip world')
    expect(r.sizeBytes).toBe(compressed.length)
  })

  it('decompresses brotli responses', async () => {
    const base = await serve((_req, res) => {
      res.setHeader('Content-Encoding', 'br')
      res.end(brotliCompressSync('brotli body'))
    })
    const r = await sendHttp({ method: 'GET', url: `${base}/`, headers: [] })
    expect(r.bodyText).toBe('brotli body')
  })

  it('times out with a clear error when the server never responds', async () => {
    const base = await serve(() => {
      /* never respond */
    })
    await expect(
      sendHttp({ method: 'GET', url: `${base}/`, headers: [], options: { timeoutSeconds: 1 } })
    ).rejects.toThrow('Request timed out after 1s')
  })

  it('rejects with a transport error for an unreachable server', async () => {
    // Grab a port that is definitely closed by opening and closing a server.
    const base = await serve((_req, res) => res.end())
    const server = servers.pop()!
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await expect(sendHttp({ method: 'GET', url: `${base}/`, headers: [] })).rejects.toThrow(
      /ECONNREFUSED/
    )
  })

  it('adds Basic auth from options.user unless Authorization is already set', async () => {
    const base = await echoServer()
    const withUser = await sendHttp({
      method: 'GET',
      url: `${base}/`,
      headers: [],
      options: { user: 'alice:s3cret' }
    })
    expect(JSON.parse(withUser.bodyText).headers.authorization).toBe(
      'Basic ' + Buffer.from('alice:s3cret').toString('base64')
    )

    const withExplicit = await sendHttp({
      method: 'GET',
      url: `${base}/`,
      headers: [{ name: 'Authorization', value: 'Bearer tok' }],
      options: { user: 'alice:s3cret' }
    })
    expect(JSON.parse(withExplicit.bodyText).headers.authorization).toBe('Bearer tok')
  })

  it('stores Set-Cookie in the jar and attaches it on the next request', async () => {
    const base = await serve((req, res) => {
      if (req.url === '/login') {
        res.setHeader('Set-Cookie', ['sid=abc123; Path=/', 'theme=dark; Path=/'])
        res.end('logged in')
      } else if (req.url === '/logout') {
        res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0')
        res.end('logged out')
      } else {
        res.end(req.headers.cookie ?? '(none)')
      }
    })
    const jar = new CookieJar()
    await sendHttp({ method: 'GET', url: `${base}/login`, headers: [] }, jar)
    const me = await sendHttp({ method: 'GET', url: `${base}/me`, headers: [] }, jar)
    expect(me.bodyText).toBe('sid=abc123; theme=dark')

    // Max-Age=0 deletes the cookie.
    await sendHttp({ method: 'GET', url: `${base}/logout`, headers: [] }, jar)
    const after = await sendHttp({ method: 'GET', url: `${base}/me`, headers: [] }, jar)
    expect(after.bodyText).toBe('theme=dark')
  })

  it('attaches a cookie set by a redirect response on the redirect hop', async () => {
    let cookieAtTarget: string | undefined
    const base = await serve((req, res) => {
      if (req.url === '/entry') {
        res.statusCode = 302
        res.setHeader('Set-Cookie', 'hop=1; Path=/')
        res.setHeader('Location', '/landing')
        res.end()
      } else {
        cookieAtTarget = req.headers.cookie
        res.end('landed')
      }
    })
    const jar = new CookieJar()
    const r = await sendHttp({ method: 'GET', url: `${base}/entry`, headers: [] }, jar)
    expect(r.status).toBe(200)
    expect(r.bodyText).toBe('landed')
    expect(cookieAtTarget).toBe('hop=1')
  })
})
