/**
 * The Tools ▸ Proxy Server (Record) lifecycle.
 *
 * menu.ts only opens the modal; this exercises what the modal's Start/Stop
 * buttons call: the real listener forwarding to a real in-test target, the
 * settings prefill/persistence, recorded.jsonl persistence, and the lifecycle
 * rules (root required, stop on collection switch, free the port on stop).
 *
 * Electron is mocked — the narrow shims this module actually touches (the
 * userData path for settings.json, the window list proxyLog broadcasts to).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { AddressInfo } from 'node:net'
import type { RecordedExchange } from '../shared/model'

/** Where the mocked Electron keeps userData (settings.json). */
let userData: string
const sentToWindows: { channel: string; args: unknown[] }[] = []

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: {
    getAllWindows: () => [
      { webContents: { send: (channel: string, ...args: unknown[]) => sentToWindows.push({ channel, args }) } }
    ]
  }
}))

const {
  appendRecorded,
  appProxyStatus,
  DEFAULT_PROXY_HTTPS_PORT,
  DEFAULT_PROXY_PORT,
  isProxyRunning,
  proxyTarget,
  proxyUrl,
  startAppProxy,
  stopAppProxy
} = await import('./record-proxy')
const { setCurrentRoot } = await import('./current-root')
const { readSettings } = await import('./settings')

let root: string
let target: Server
let targetUrl: string

function recordedFile(r: string): string {
  return join(r, '.freepost', 'history', 'recorded.jsonl')
}

function entry(over: Partial<RecordedExchange> = {}): RecordedExchange {
  return {
    id: 'e1',
    at: '2026-01-01T00:00:00Z',
    protocol: 'rest',
    method: 'GET',
    url: 'http://t/x',
    requestHeaders: [],
    status: 200,
    errored: false,
    ...over
  }
}

beforeEach(async () => {
  userData = mkdtempSync(join(tmpdir(), 'freepost-userdata-'))
  root = mkdtempSync(join(tmpdir(), 'freepost-collection-'))
  sentToWindows.length = 0
  setCurrentRoot(root)
  target = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end('{"ok":true}')
  })
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r))
  targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}`
})

afterEach(async () => {
  await stopAppProxy()
  setCurrentRoot(null)
  await new Promise<void>((r) => target.close(() => r()))
  await rm(root, { recursive: true, force: true })
  await rm(userData, { recursive: true, force: true })
})

describe('the proxy lifecycle', () => {
  it('requires an open collection — recorded traffic has to land somewhere', async () => {
    setCurrentRoot(null)
    await expect(startAppProxy({ target: targetUrl })).rejects.toThrow(/Open a collection first/)
    expect(isProxyRunning()).toBe(false)
  })

  it('starts, proxies, records to recorded.jsonl and broadcasts the exchange', async () => {
    const { url, port } = await startAppProxy({ target: targetUrl, port: 0 })
    expect(isProxyRunning()).toBe(true)
    expect(proxyUrl()).toBe(url)
    expect(proxyTarget()).toBe(targetUrl)

    const res = await fetch(`http://127.0.0.1:${port}/health`)
    expect(await res.json()).toEqual({ ok: true })

    await vi.waitFor(() => expect(existsSync(recordedFile(root))).toBe(true))
    const lines = readFileSync(recordedFile(root), 'utf8').split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    const recorded = JSON.parse(lines[0]) as RecordedExchange
    expect(recorded.url).toBe(`${targetUrl}/health`)
    expect(recorded.status).toBe(200)
    // The live modal got the same exchange over proxy:log.
    expect(sentToWindows.some((m) => m.channel === 'proxy:log')).toBe(true)
  })

  it('persists the last-used target and port for the next prefill', async () => {
    const { port } = await startAppProxy({ target: targetUrl, port: 0 })
    const settings = await readSettings(join(userData, 'settings.json'))
    expect(settings.proxyTarget).toBe(targetUrl)
    expect(settings.proxyPort).toBe(port)

    await stopAppProxy()
    const status = await appProxyStatus()
    expect(status).toEqual({ running: false, target: targetUrl, port, https: false, httpsPort: 7700 })
  })

  it('defaults the ports to 7699/7700 when nothing is saved', async () => {
    expect(DEFAULT_PROXY_PORT).toBe(7699)
    expect(DEFAULT_PROXY_HTTPS_PORT).toBe(7700)
    const status = await appProxyStatus()
    expect(status).toEqual({ running: false, target: '', port: 7699, https: false, httpsPort: 7700 })
  })

  it('starts the HTTPS listener on demand and round-trips its settings', async () => {
    const started = await startAppProxy({ target: targetUrl, port: 0, https: true, httpsPort: 0 })
    expect(started.httpsUrl).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/)
    expect(started.caPath).toBe(join(userData, 'tls', 'ca.crt'))
    expect(existsSync(started.caPath as string)).toBe(true)
    const httpsPort = Number(new URL(started.httpsUrl as string).port)

    // Running status carries both URLs and the CA path for the modal.
    const live = await appProxyStatus()
    expect(live).toMatchObject({
      running: true,
      httpsUrl: started.httpsUrl,
      https: true,
      httpsPort,
      caPath: started.caPath
    })

    // The TLS listener actually serves, with the generated leaf.
    const ca = readFileSync(started.caPath as string, 'utf8')
    const body = await new Promise<string>((resolve, reject) => {
      const req = httpsRequest(`${started.httpsUrl}/health`, { ca }, (res) => {
        let buf = ''
        res.on('data', (c) => (buf += c))
        res.on('end', () => resolve(buf))
      })
      req.on('error', reject)
      req.end()
    })
    expect(JSON.parse(body)).toEqual({ ok: true })

    // Settings round-trip: toggle + port persist for the next prefill…
    const settings = await readSettings(join(userData, 'settings.json'))
    expect(settings.proxyHttpsEnabled).toBe(true)
    expect(settings.proxyHttpsPort).toBe(httpsPort)

    // …and the stopped status prefills from them.
    await stopAppProxy()
    const status = await appProxyStatus()
    expect(status).toMatchObject({ running: false, https: true, httpsPort })
  })

  it('remembers HTTPS being turned back off', async () => {
    await startAppProxy({ target: targetUrl, port: 0, https: true, httpsPort: 0 })
    await stopAppProxy()
    await startAppProxy({ target: targetUrl, port: 0 })
    await stopAppProxy()
    const settings = await readSettings(join(userData, 'settings.json'))
    expect(settings.proxyHttpsEnabled).toBe(false)
    const status = await appProxyStatus()
    expect(status.https).toBe(false)
  })

  it('stops when the user switches collections, rather than recording into the new one', async () => {
    await startAppProxy({ target: targetUrl, port: 0 })
    expect(isProxyRunning()).toBe(true)

    const other = mkdtempSync(join(tmpdir(), 'freepost-other-'))
    setCurrentRoot(other)
    await vi.waitFor(() => expect(isProxyRunning()).toBe(false))
    await rm(other, { recursive: true, force: true })
  })

  it('frees the port on stop', async () => {
    const { port } = await startAppProxy({ target: targetUrl, port: 0 })
    await stopAppProxy()
    expect(isProxyRunning()).toBe(false)
    expect(proxyUrl()).toBeNull()
    await expect(fetch(`http://127.0.0.1:${port}/x`)).rejects.toThrow()
  })

  it('starting twice reports the same listener, not a second one', async () => {
    const first = await startAppProxy({ target: targetUrl, port: 0 })
    const second = await startAppProxy({ target: 'http://ignored.example', port: 0 })
    expect(second).toEqual(first)
  })

  it('throws EADDRINUSE back to the caller (the modal shows it)', async () => {
    const squatter = createServer()
    await new Promise<void>((r) => squatter.listen(0, '127.0.0.1', r))
    const port = (squatter.address() as AddressInfo).port
    try {
      await expect(startAppProxy({ target: targetUrl, port })).rejects.toThrow(/EADDRINUSE/)
      expect(isProxyRunning()).toBe(false)
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()))
    }
  })
})

describe('appendRecorded', () => {
  it('appends jsonl lines owner-only (chmod 600)', () => {
    appendRecorded(root, entry({ id: 'a' }))
    appendRecorded(root, entry({ id: 'b' }))
    const file = recordedFile(root)
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    expect(lines.map((l) => (JSON.parse(l) as RecordedExchange).id)).toEqual(['a', 'b'])
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600)
    }
  })

  // 1001 appends — the in-memory line counter keeps this append-only until
  // the cap trips, but keep a generous timeout for a loaded suite.
  it('caps the file at 500 entries', { timeout: 30000 }, () => {
    for (let i = 0; i < 1001; i++) appendRecorded(root, entry({ id: `e${i}` }))
    const lines = readFileSync(recordedFile(root), 'utf8').split('\n').filter(Boolean)
    expect(lines.length).toBeLessThanOrEqual(1000)
    expect(lines.length).toBeGreaterThanOrEqual(500)
    // The newest entry always survives the trim.
    expect(lines[lines.length - 1]).toContain('"e1000"')
  })

  it('initializes its line counter from a pre-existing file (still trims at the cap)', () => {
    // 1000 lines written behind appendRecorded's back — the first append must
    // count them (not restart at 0) so the very next append trims.
    const file = recordedFile(root)
    mkdirSync(join(root, '.freepost', 'history'), { recursive: true })
    writeFileSync(
      file,
      Array.from({ length: 1000 }, (_, i) => JSON.stringify(entry({ id: `pre${i}` }))).join('\n') + '\n'
    )
    appendRecorded(root, entry({ id: 'fresh' }))
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    expect(lines.length).toBe(500)
    expect(lines[lines.length - 1]).toContain('"fresh"')
  })
})
