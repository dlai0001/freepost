/**
 * The proxy's local CA + leaf (proxy-certs.ts): a temp-dir round-trip checked
 * with node:crypto's X509Certificate (an independent parser — the module under
 * test uses @peculiar/x509), plus the reuse/rotation rules: the CA must stay
 * stable across calls (installed trust survives) while the leaf rotates when
 * it nears expiry or its SANs drift.
 */
import 'reflect-metadata' // must precede @peculiar/x509 (tsyringe)
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { webcrypto, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as x509 from '@peculiar/x509'
import { ensureProxyCerts, LEAF_VALID_DAYS, regenerateProxyCa } from './proxy-certs'

const DAY_MS = 24 * 60 * 60 * 1000
const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'freepost-tls-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Sign a leaf with the on-disk CA, controlling notAfter/SANs (test-only). */
async function plantLeaf(opts: { validDays: number; sans?: x509.JsonGeneralNames }): Promise<void> {
  const caPem = readFileSync(join(dir, 'ca.crt'), 'utf8')
  const caKeyPem = readFileSync(join(dir, 'ca.key'), 'utf8')
  const caCert = new x509.X509Certificate(caPem)
  const der = Buffer.from(caKeyPem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, ''), 'base64')
  const caKey = (await webcrypto.subtle.importKey('pkcs8', der, ALG, true, ['sign'])) as unknown as CryptoKey
  const keys = (await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as CryptoKeyPair
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: '0abc12',
    subject: 'CN=localhost, O=freepost',
    issuer: caCert.subject,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + opts.validDays * DAY_MS),
    signingAlgorithm: ALG,
    publicKey: keys.publicKey,
    signingKey: caKey,
    extensions: [
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      new x509.SubjectAlternativeNameExtension(
        opts.sans ?? [
          { type: 'dns', value: 'localhost' },
          { type: 'ip', value: '127.0.0.1' },
          { type: 'ip', value: '::1' }
        ]
      )
    ]
  })
  const keyDer = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey))
  const b64 = keyDer.toString('base64').replace(/(.{64})/g, '$1\n').trimEnd()
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(dir, 'leaf.crt'), cert.toString('pem') + '\n')
  writeFileSync(join(dir, 'leaf.key'), `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`)
}

describe('ensureProxyCerts', () => {
  it('creates a CA that signs a localhost leaf (verified with node:crypto)', async () => {
    const certs = await ensureProxyCerts(dir)
    const ca = new X509Certificate(certs.caPem)
    const leaf = new X509Certificate(certs.certPem)

    expect(ca.ca).toBe(true)
    expect(ca.subject).toContain('CN=Freepost Local Proxy CA')
    expect(ca.subject).toContain('O=freepost')
    expect(ca.checkIssued(ca)).toBe(true) // self-signed
    expect(leaf.checkIssued(ca)).toBe(true)
    expect(leaf.verify(ca.publicKey)).toBe(true)
    expect(leaf.subject).toContain('CN=localhost')
    expect(certs.caPath).toBe(join(dir, 'ca.crt'))
    expect(readFileSync(certs.caPath, 'utf8')).toBe(certs.caPem)
  })

  it('gives the leaf the localhost SANs, serverAuth EKU and the right key usages', async () => {
    const certs = await ensureProxyCerts(dir)
    const leaf = new X509Certificate(certs.certPem)
    const san = leaf.subjectAltName ?? ''
    expect(san).toContain('DNS:localhost')
    expect(san).toContain('127.0.0.1')
    expect(/::1|0:0:0:0:0:0:0:1/.test(san)).toBe(true)

    // EKU/KeyUsage via the richer @peculiar parser.
    const parsed = new x509.X509Certificate(certs.certPem)
    const eku = parsed.getExtension(x509.ExtendedKeyUsageExtension)
    expect(eku?.usages).toContain(x509.ExtendedKeyUsage.serverAuth)
    const ku = parsed.getExtension(x509.KeyUsagesExtension)
    expect((ku!.usages & x509.KeyUsageFlags.digitalSignature) !== 0).toBe(true)
    expect((ku!.usages & x509.KeyUsageFlags.keyEncipherment) !== 0).toBe(true)
    const aki = parsed.getExtension(x509.AuthorityKeyIdentifierExtension)
    const caSki = new x509.X509Certificate(certs.caPem).getExtension(x509.SubjectKeyIdentifierExtension)
    expect(aki?.keyId).toBe(caSki?.keyId)
  })

  it('uses ECDSA P-256 keys and back-dates notBefore for clock skew', async () => {
    const certs = await ensureProxyCerts(dir)
    for (const pem of [certs.caPem, certs.certPem]) {
      const cert = new X509Certificate(pem)
      expect(cert.publicKey.asymmetricKeyType).toBe('ec')
      expect(cert.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1')
      expect(new Date(cert.validFrom).getTime()).toBeLessThan(Date.now() - 60_000)
    }
    // Apple rejects locally-trusted server certs over 825 days.
    const leaf = new X509Certificate(certs.certPem)
    const lifeDays = (new Date(leaf.validTo).getTime() - new Date(leaf.validFrom).getTime()) / DAY_MS
    expect(lifeDays).toBeLessThanOrEqual(825)
    expect(LEAF_VALID_DAYS).toBeLessThanOrEqual(825)
  })

  it('writes all four PEM files owner-only (chmod 600)', async () => {
    await ensureProxyCerts(dir)
    if (process.platform === 'win32') return
    for (const f of ['ca.crt', 'ca.key', 'leaf.crt', 'leaf.key']) {
      expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600)
    }
  })

  it('reuses the CA and leaf across calls', async () => {
    const first = await ensureProxyCerts(dir)
    const second = await ensureProxyCerts(dir)
    expect(second.caPem).toBe(first.caPem)
    expect(second.caKeyPem).toBe(first.caKeyPem)
    expect(second.certPem).toBe(first.certPem)
    expect(second.keyPem).toBe(first.keyPem)
  })

  it('rotates a nearly-expired leaf but keeps the CA stable', async () => {
    const first = await ensureProxyCerts(dir)
    await plantLeaf({ validDays: 10 }) // inside the 30-day rotation window
    const planted = readFileSync(join(dir, 'leaf.crt'), 'utf8')
    const next = await ensureProxyCerts(dir)
    expect(next.caPem).toBe(first.caPem)
    expect(next.certPem).not.toBe(planted)
    const leaf = new X509Certificate(next.certPem)
    expect(new Date(leaf.validTo).getTime() - Date.now()).toBeGreaterThan(100 * DAY_MS)
  })

  it('rotates a leaf whose SANs drifted (missing ::1)', async () => {
    const first = await ensureProxyCerts(dir)
    await plantLeaf({
      validDays: 400,
      sans: [
        { type: 'dns', value: 'localhost' },
        { type: 'ip', value: '127.0.0.1' }
      ]
    })
    const planted = readFileSync(join(dir, 'leaf.crt'), 'utf8')
    const next = await ensureProxyCerts(dir)
    expect(next.caPem).toBe(first.caPem)
    expect(next.certPem).not.toBe(planted)
    expect(/::1|0:0:0:0:0:0:0:1/.test(new X509Certificate(next.certPem).subjectAltName ?? '')).toBe(true)
  })
})

describe('regenerateProxyCa', () => {
  it('wipes and recreates the CA (and a leaf signed by the new one)', async () => {
    const first = await ensureProxyCerts(dir)
    const next = await regenerateProxyCa(dir)
    expect(next.caPem).not.toBe(first.caPem)
    expect(next.certPem).not.toBe(first.certPem)
    const ca = new X509Certificate(next.caPem)
    const leaf = new X509Certificate(next.certPem)
    expect(leaf.verify(ca.publicKey)).toBe(true)
    // The old CA no longer verifies the new leaf.
    expect(leaf.verify(new X509Certificate(first.caPem).publicKey)).toBe(false)
  })
})
