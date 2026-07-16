/**
 * Self-signed certificates for the record proxy's HTTPS listener.
 *
 * Pure file + crypto work — no sockets — so it lives in src/main and stays
 * fence-legal. Node core can't *sign* X.509 certificates, hence @peculiar/x509
 * (WebCrypto-based) on top of node:crypto's webcrypto provider.
 *
 * The model mirrors what mkcert popularized: one long-lived local CA (10y,
 * ECDSA P-256) that the user can add to a trust store or pass to a client
 * (`curl --cacert`, NODE_EXTRA_CA_CERTS, …), and a short-lived leaf for
 * localhost/127.0.0.1/::1 that the listener actually serves. The leaf is
 * capped at ~820 days — Apple rejects locally-trusted server certs valid
 * longer than 825 — and quietly re-issued when it nears expiry or its SANs
 * drift, WITHOUT touching the CA, so trust the user already installed keeps
 * working. Everything is PEM under the caller-provided dir (production passes
 * userData/tls; tests a temp dir), chmod 600 like recorded.jsonl.
 *
 * NEVER install the CA into an OS trust store from here — the modal only
 * offers to open the OS import UI (see ipc-handlers.ts).
 */
// @peculiar/x509 wires its algorithm providers through tsyringe, which needs
// the Reflect-metadata polyfill loaded first.
import 'reflect-metadata'
import { webcrypto } from 'node:crypto'
import { randomBytes, X509Certificate } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import * as x509 from '@peculiar/x509'

x509.cryptoProvider.set(webcrypto as Crypto)

/** ECDSA P-256 for both keys: small, fast, universally accepted. */
const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const

const CA_NAME = 'CN=Freepost Local Proxy CA, O=freepost'
const LEAF_NAME = 'CN=localhost, O=freepost'
/** SANs the leaf must carry; drift (an old cert) forces a re-issue. */
const LEAF_SANS: x509.JsonGeneralNames = [
  { type: 'dns', value: 'localhost' },
  { type: 'ip', value: '127.0.0.1' },
  { type: 'ip', value: '::1' }
]

const DAY_MS = 24 * 60 * 60 * 1000
export const CA_VALID_DAYS = 3650
/** Apple caps locally-trusted server certs at 825 days; stay under it. */
export const LEAF_VALID_DAYS = 820
/** Re-issue the leaf when it has less than this long left. */
export const LEAF_ROTATE_BEFORE_DAYS = 30
/** Back-date notBefore so a slightly-behind client clock still validates. */
const BACKDATE_MS = 5 * 60 * 1000

export interface ProxyCerts {
  caPem: string
  caKeyPem: string
  certPem: string
  keyPem: string
  /** Absolute path of ca.crt — what the modal exports/copies. */
  caPath: string
}

interface FilePaths {
  caCrt: string
  caKey: string
  leafCrt: string
  leafKey: string
}

function paths(dir: string): FilePaths {
  return {
    caCrt: join(dir, 'ca.crt'),
    caKey: join(dir, 'ca.key'),
    leafCrt: join(dir, 'leaf.crt'),
    leafKey: join(dir, 'leaf.key')
  }
}

/** Random positive serial (hex). High bit cleared: DER serials are signed. */
function randomSerial(): string {
  const buf = randomBytes(12)
  buf[0] = buf[0] & 0x7f | 0x01
  return buf.toString('hex')
}

/** PKCS#8 PEM for a WebCrypto private key. */
async function exportKeyPem(key: CryptoKey): Promise<string> {
  const der = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', key))
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n').trimEnd()
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`
}

/** The inverse: import a PKCS#8 PEM as an ECDSA P-256 signing key. */
async function importKeyPem(pem: string): Promise<CryptoKey> {
  const b64 = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '')
  const der = Buffer.from(b64, 'base64')
  // Node's webcrypto CryptoKey type diverges from the DOM lib's (extra usages).
  return (await webcrypto.subtle.importKey('pkcs8', der, ALG, true, ['sign'])) as unknown as CryptoKey
}

/** Write a secret file owner-only (chmod best-effort, like recorded.jsonl). */
async function writeSecret(file: string, content: string): Promise<void> {
  await fs.writeFile(file, content)
  await fs.chmod(file, 0o600).catch(() => undefined)
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
}

/** Create the local CA and persist it. */
async function createCa(p: FilePaths): Promise<{ caPem: string; caKeyPem: string }> {
  const keys = (await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as CryptoKeyPair
  const now = Date.now()
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: randomSerial(),
    subject: CA_NAME,
    issuer: CA_NAME,
    notBefore: new Date(now - BACKDATE_MS),
    notAfter: new Date(now + CA_VALID_DAYS * DAY_MS),
    signingAlgorithm: ALG,
    publicKey: keys.publicKey,
    signingKey: keys.privateKey,
    extensions: [
      // pathLen 0: this CA signs leaves only, never intermediates.
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey)
    ]
  })
  const caPem = cert.toString('pem') + '\n'
  const caKeyPem = await exportKeyPem(keys.privateKey)
  await writeSecret(p.caCrt, caPem)
  await writeSecret(p.caKey, caKeyPem)
  return { caPem, caKeyPem }
}

/** Create a leaf signed by the CA and persist it. */
async function createLeaf(
  p: FilePaths,
  caPem: string,
  caKeyPem: string
): Promise<{ certPem: string; keyPem: string }> {
  const caCert = new x509.X509Certificate(caPem)
  const caKey = await importKeyPem(caKeyPem)
  const keys = (await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as CryptoKeyPair
  const now = Date.now()
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: randomSerial(),
    subject: LEAF_NAME,
    issuer: caCert.subject,
    notBefore: new Date(now - BACKDATE_MS),
    notAfter: new Date(now + LEAF_VALID_DAYS * DAY_MS),
    signingAlgorithm: ALG,
    publicKey: keys.publicKey,
    signingKey: caKey,
    extensions: [
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment,
        true
      ),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      new x509.SubjectAlternativeNameExtension(LEAF_SANS),
      await x509.AuthorityKeyIdentifierExtension.create(caCert)
    ]
  })
  const certPem = cert.toString('pem') + '\n'
  const keyPem = await exportKeyPem(keys.privateKey)
  await writeSecret(p.leafCrt, certPem)
  await writeSecret(p.leafKey, keyPem)
  return { certPem, keyPem }
}

/** Is this CA PEM still usable (parses, in its validity window)? */
function caUsable(caPem: string): boolean {
  try {
    const cert = new X509Certificate(caPem)
    const now = Date.now()
    return new Date(cert.validFrom).getTime() <= now && new Date(cert.validTo).getTime() > now
  } catch {
    return false
  }
}

/**
 * Is this leaf PEM still usable: signed by the current CA, not within the
 * rotation window of expiry, and carrying the SANs we promise (an old cert
 * from before a SAN was added must rotate)?
 */
function leafUsable(certPem: string, caPem: string): boolean {
  try {
    const leaf = new X509Certificate(certPem)
    const ca = new X509Certificate(caPem)
    if (!leaf.checkIssued(ca) || !leaf.verify(ca.publicKey)) return false
    const now = Date.now()
    if (new Date(leaf.validFrom).getTime() > now) return false
    if (new Date(leaf.validTo).getTime() - now < LEAF_ROTATE_BEFORE_DAYS * DAY_MS) return false
    const san = leaf.subjectAltName ?? ''
    return san.includes('localhost') && san.includes('127.0.0.1') && (san.includes('::1') || san.includes('0:0:0:0:0:0:0:1'))
  } catch {
    return false
  }
}

/**
 * Ensure a usable CA + leaf exist under `dir`, creating or rotating as needed.
 * The CA is kept stable across leaf rotations — installed trust survives.
 */
export async function ensureProxyCerts(dir: string): Promise<ProxyCerts> {
  await fs.mkdir(dir, { recursive: true })
  const p = paths(dir)

  let caPem = await readIfExists(p.caCrt)
  let caKeyPem = await readIfExists(p.caKey)
  let caFresh = false
  if (caPem === null || caKeyPem === null || !caUsable(caPem)) {
    ;({ caPem, caKeyPem } = await createCa(p))
    caFresh = true
  } else {
    // The key must actually load — a corrupt ca.key means a full re-issue.
    try {
      await importKeyPem(caKeyPem)
    } catch {
      ;({ caPem, caKeyPem } = await createCa(p))
      caFresh = true
    }
  }

  let certPem = caFresh ? null : await readIfExists(p.leafCrt)
  let keyPem = caFresh ? null : await readIfExists(p.leafKey)
  if (certPem === null || keyPem === null || !leafUsable(certPem, caPem)) {
    ;({ certPem, keyPem } = await createLeaf(p, caPem, caKeyPem))
  }

  return { caPem, caKeyPem, certPem, keyPem, caPath: p.caCrt }
}

/**
 * Wipe and recreate the whole CA + leaf. Destroys any trust the user has
 * installed for the old CA — the modal confirms before calling this.
 */
export async function regenerateProxyCa(dir: string): Promise<ProxyCerts> {
  const p = paths(dir)
  for (const f of [p.caCrt, p.caKey, p.leafCrt, p.leafKey]) {
    await fs.rm(f, { force: true }).catch(() => undefined)
  }
  return ensureProxyCerts(dir)
}
