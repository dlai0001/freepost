import { execFileSync } from 'node:child_process'
import { createServer as createHttp, type Server as HttpServer } from 'node:http'
import { createServer as createHttps, type Server as HttpsServer } from 'node:https'
import { connect as netConnect, type AddressInfo, type Socket } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sendHttp } from './http'
import { parseProxy, proxyAuthHeader, shouldBypassProxy } from './proxy'

describe('proxy helpers', () => {
  it('parseProxy accepts full URLs and bare host:port', () => {
    expect(parseProxy('http://proxy:8080')?.host).toBe('proxy:8080')
    expect(parseProxy('proxy.corp:3128')?.protocol).toBe('http:')
    expect(parseProxy('proxy.corp:3128')?.hostname).toBe('proxy.corp')
    expect(parseProxy(undefined)).toBeUndefined()
    expect(parseProxy('   ')).toBeUndefined()
  })

  it('proxyAuthHeader builds Basic creds only when present', () => {
    expect(proxyAuthHeader(new URL('http://proxy:8080'))).toBeUndefined()
    expect(proxyAuthHeader(new URL('http://user:pass@proxy:8080'))).toBe(
      'Basic ' + Buffer.from('user:pass').toString('base64')
    )
  })

  it('shouldBypassProxy matches NO_PROXY suffixes and wildcard', () => {
    expect(shouldBypassProxy('api.corp', 'corp')).toBe(true)
    expect(shouldBypassProxy('api.corp', '.corp')).toBe(true)
    expect(shouldBypassProxy('api.corp', '*.corp')).toBe(true)
    expect(shouldBypassProxy('api.corp', 'other.com')).toBe(false)
    expect(shouldBypassProxy('anything', '*')).toBe(true)
    expect(shouldBypassProxy('api.corp', undefined)).toBe(false)
  })
})

function port(s: HttpServer | HttpsServer): number {
  return (s.address() as AddressInfo).port
}

// --- HTTP forward proxy (absolute-form request-target) ---
describe('proxy — HTTP absolute-form', () => {
  let proxy: HttpServer
  let seen: { url: string; auth?: string } = { url: '' }

  beforeAll(async () => {
    proxy = createHttp((req, res) => {
      seen = { url: req.url ?? '', auth: req.headers['proxy-authorization'] }
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('via-proxy')
    })
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r))
  })
  afterAll(() => proxy.close())

  it('routes an http request through the proxy in absolute-form with auth', async () => {
    const res = await sendHttp({
      method: 'GET',
      url: 'http://example.test/widgets?q=1',
      headers: [],
      options: { proxy: `http://u:p@127.0.0.1:${port(proxy)}` }
    })
    expect(res.status).toBe(200)
    expect(res.bodyText).toBe('via-proxy')
    // The proxy must receive the FULL target URL as the request-target.
    expect(seen.url).toBe('http://example.test/widgets?q=1')
    expect(seen.auth).toBe('Basic ' + Buffer.from('u:p').toString('base64'))
  })
})

// --- HTTPS via CONNECT tunnel (needs openssl for a TLS origin) ---
describe('proxy — HTTPS CONNECT tunnel', () => {
  let dir = ''
  let origin: HttpsServer | undefined
  let proxy: HttpServer | undefined
  let connectHost = ''
  let caCert = ''
  let hasOpenssl = true

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'freepost-proxy-'))
    const crt = join(dir, 's.crt')
    const key = join(dir, 's.key')
    try {
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', key, '-out', crt, '-days', '1',
        '-subj', '/CN=127.0.0.1',
        '-addext', 'subjectAltName=IP:127.0.0.1'
      ])
    } catch {
      hasOpenssl = false
      return
    }
    caCert = readFileSync(crt, 'utf8')
    origin = createHttps({ cert: caCert, key: readFileSync(key, 'utf8') }, (_req, res) => {
      res.writeHead(200)
      res.end('secure-hello')
    })
    await new Promise<void>((r) => origin!.listen(0, '127.0.0.1', r))

    // Minimal CONNECT proxy: pipe the client socket to the requested target.
    proxy = createHttp()
    proxy.on('connect', (req, clientSocket: Socket, head: Buffer) => {
      connectHost = req.url ?? ''
      const [h, p] = (req.url ?? '').split(':')
      const upstream = netConnect(Number(p), h, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length > 0) upstream.write(head)
        upstream.pipe(clientSocket)
        clientSocket.pipe(upstream)
      })
      upstream.on('error', () => clientSocket.destroy())
    })
    await new Promise<void>((r) => proxy!.listen(0, '127.0.0.1', r))
  }, 30000)

  afterAll(() => {
    origin?.close()
    proxy?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('tunnels an https request via CONNECT (insecure)', { timeout: 20000 }, async () => {
    if (!hasOpenssl) return
    const res = await sendHttp({
      method: 'GET',
      url: `https://127.0.0.1:${port(origin!)}/`,
      headers: [],
      options: { proxy: `http://127.0.0.1:${port(proxy!)}`, insecure: true }
    })
    expect(res.status).toBe(200)
    expect(res.bodyText).toBe('secure-hello')
    expect(connectHost).toBe(`127.0.0.1:${port(origin!)}`)
  })

  it('verifies the target cert via a custom caCert through the tunnel', { timeout: 20000 }, async () => {
    if (!hasOpenssl) return
    const res = await sendHttp({
      method: 'GET',
      url: `https://127.0.0.1:${port(origin!)}/`,
      headers: [],
      options: { proxy: `http://127.0.0.1:${port(proxy!)}`, caCert }
    })
    expect(res.status).toBe(200)
    expect(res.bodyText).toBe('secure-hello')
  })
})
