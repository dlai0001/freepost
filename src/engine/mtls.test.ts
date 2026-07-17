import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:https'
import type { Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { loadPem, sendHttp } from './http'

/**
 * Generate a self-signed cert/key PEM pair with openssl. We use one identity
 * for the server (so the client trusts it via insecure) and a second for the
 * client presenting its certificate. Kept in a temp dir cleaned up after the
 * suite. If openssl is unavailable the mTLS server tests are skipped, but the
 * pure loadPem tests still run.
 */
let dir: string
let serverCertPath: string
let serverKeyPath: string
let clientCertPath: string
let clientKeyPath: string
let clientCertPem: string
let hasOpenssl = true

function genSelfSigned(name: string, cn: string): { cert: string; key: string } {
  const certPath = join(dir, `${name}.crt`)
  const keyPath = join(dir, `${name}.key`)
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-subj',
    `/CN=${cn}`
  ])
  return { cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8') }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'freepost-mtls-'))
  try {
    const server = genSelfSigned('server', '127.0.0.1')
    const client = genSelfSigned('client', 'freepost-client')
    serverCertPath = join(dir, 'server.crt')
    serverKeyPath = join(dir, 'server.key')
    clientCertPath = join(dir, 'client.crt')
    clientKeyPath = join(dir, 'client.key')
    clientCertPem = client.cert
    // paths already written by openssl; keep server pem in vars via files
    void server
  } catch {
    hasOpenssl = false
  }
  // Four openssl keygen subprocesses. The 10s default is enough alone but not
  // when the whole suite runs in parallel, which made this hook the file's
  // flakiest line.
}, 60_000)

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  )
})

/**
 * Start an mTLS-capable https server that records the client cert (if any) it
 * received, and echoes it back. requestCert:true asks for a client cert;
 * rejectUnauthorized:false lets our self-signed client through so the handler
 * can inspect it.
 */
function serveMtls(): Promise<{ base: string; getSeenCn: () => string | undefined }> {
  let seenCn: string | undefined
  return new Promise((resolve) => {
    const server = createServer(
      {
        cert: readFileSync(serverCertPath),
        key: readFileSync(serverKeyPath),
        requestCert: true,
        rejectUnauthorized: false
      },
      (req, res) => {
        const cert = (req.socket as import('node:tls').TLSSocket).getPeerCertificate()
        const cn = cert && cert.subject ? cert.subject.CN : undefined
        seenCn = typeof cn === 'string' ? cn : undefined
        res.end('ok')
      }
    )
    servers.push(server)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ base: `https://127.0.0.1:${port}`, getSeenCn: () => seenCn })
    })
  })
}

describe('loadPem', () => {
  it('returns PEM text unchanged when the value looks like a certificate', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n'
    expect(loadPem(pem)).toBe(pem)
  })

  it('tolerates leading whitespace before the PEM armor', () => {
    const pem = '  \n-----BEGIN PRIVATE KEY-----\nxyz\n-----END PRIVATE KEY-----\n'
    expect(loadPem(pem)).toBe(pem)
  })

  it('reads the file from disk when the value is a path', () => {
    const p = join(dir, 'fixture.pem')
    const contents = '-----BEGIN CERTIFICATE-----\nfromfile\n-----END CERTIFICATE-----\n'
    writeFileSync(p, contents)
    const loaded = loadPem(p)
    expect(Buffer.isBuffer(loaded)).toBe(true)
    expect((loaded as Buffer).toString('utf8')).toBe(contents)
  })
})

describe('sendHttp mTLS', () => {
  it('presents the client certificate to the server when given PEM file paths', async () => {
    if (!hasOpenssl) return
    const { base, getSeenCn } = await serveMtls()
    const r = await sendHttp({
      method: 'GET',
      url: `${base}/`,
      headers: [],
      options: {
        insecure: true,
        clientCert: clientCertPath,
        clientKey: clientKeyPath
      }
    })
    expect(r.status).toBe(200)
    expect(r.bodyText).toBe('ok')
    expect(getSeenCn()).toBe('freepost-client')
  })

  it('accepts raw PEM text for the client certificate', async () => {
    if (!hasOpenssl) return
    const { base, getSeenCn } = await serveMtls()
    const r = await sendHttp({
      method: 'GET',
      url: `${base}/`,
      headers: [],
      options: {
        insecure: true,
        clientCert: clientCertPem,
        clientKey: readFileSync(clientKeyPath, 'utf8')
      }
    })
    expect(r.status).toBe(200)
    expect(getSeenCn()).toBe('freepost-client')
  })

  it('makes no client cert available when none is configured', async () => {
    if (!hasOpenssl) return
    const { base, getSeenCn } = await serveMtls()
    const r = await sendHttp({
      method: 'GET',
      url: `${base}/`,
      headers: [],
      options: { insecure: true }
    })
    expect(r.status).toBe(200)
    expect(getSeenCn()).toBeUndefined()
  })
})
