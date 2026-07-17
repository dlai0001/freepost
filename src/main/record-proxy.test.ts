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
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { createServer as createNetServer, type Server as NetServer } from 'node:net'
import { request as httpsRequest } from 'node:https'
import type { AddressInfo } from 'node:net'
import Aedes from 'aedes'
import mqtt from 'mqtt'
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
  appProxyStatus,
  DEFAULT_PROXY_HTTPS_PORT,
  DEFAULT_PROXY_MQTT_PORT,
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
    expect(status).toEqual({
      running: false,
      target: targetUrl,
      port,
      https: false,
      httpsPort: 7700,
      mqtt: false,
      mqttTarget: '',
      mqttPort: 7883
    })
  })

  it('defaults the ports to 7699/7700/7883 when nothing is saved', async () => {
    expect(DEFAULT_PROXY_PORT).toBe(7699)
    expect(DEFAULT_PROXY_HTTPS_PORT).toBe(7700)
    expect(DEFAULT_PROXY_MQTT_PORT).toBe(7883)
    const status = await appProxyStatus()
    expect(status).toEqual({
      running: false,
      target: '',
      port: 7699,
      https: false,
      httpsPort: 7700,
      mqtt: false,
      mqttTarget: '',
      mqttPort: 7883
    })
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

/**
 * The MQTT relay is a second listener with its own target and port, started
 * and stopped by the same toggle. It records into the same recorded.jsonl —
 * that shared sink is the only thing the two listeners have in common.
 */
describe('the MQTT relay half of the lifecycle', () => {
  let broker: Aedes
  let brokerServer: NetServer
  let brokerUrl: string

  beforeEach(async () => {
    broker = new Aedes()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    brokerServer = createNetServer(broker.handle as any)
    await new Promise<void>((r) => brokerServer.listen(0, '127.0.0.1', r))
    brokerUrl = `mqtt://127.0.0.1:${(brokerServer.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>((r) => brokerServer.close(() => r()))
    await new Promise<void>((r) => broker.close(() => r()))
  })

  it('relays MQTT on its own port and records the session', async () => {
    const started = await startAppProxy({
      target: targetUrl,
      port: 0,
      mqtt: true,
      mqttTarget: brokerUrl,
      mqttPort: 0
    })
    expect(started.mqttUrl).toMatch(/^mqtt:\/\/127\.0\.0\.1:\d+$/)

    const client = mqtt.connect(started.mqttUrl as string, { reconnectPeriod: 0, clientId: 'lifecycle' })
    await new Promise<void>((resolve, reject) => {
      client.on('error', reject)
      client.on('connect', () => resolve())
    })
    await new Promise<void>((resolve, reject) => {
      client.publish('freepost/main', 'hi', { qos: 1 }, (e) => (e ? reject(e) : resolve()))
    })
    await new Promise<void>((resolve) => client.end(false, {}, () => resolve()))

    await vi.waitFor(() => expect(existsSync(recordedFile(root))).toBe(true))
    const lines = readFileSync(recordedFile(root), 'utf8').split('\n').filter(Boolean)
    const recorded = JSON.parse(lines[0]) as RecordedExchange
    expect(recorded.protocol).toBe('mqtt')
    expect(recorded.method).toBe('MQTT')
    expect(recorded.url).toBe(brokerUrl)
    expect(recorded.mqtt?.clientId).toBe('lifecycle')
    expect(recorded.mqtt?.packets.some((p) => p.topic === 'freepost/main')).toBe(true)
    // The live modal gets MQTT exchanges through the same proxy:log channel.
    expect(sentToWindows.some((m) => m.channel === 'proxy:log')).toBe(true)
  })

  it('reports the MQTT listener in the status, and prefills it next time', async () => {
    const started = await startAppProxy({
      target: targetUrl,
      port: 0,
      mqtt: true,
      mqttTarget: brokerUrl,
      mqttPort: 0
    })
    const mqttPort = Number(new URL(started.mqttUrl as string).port)
    expect(await appProxyStatus()).toMatchObject({
      running: true,
      mqtt: true,
      mqttTarget: brokerUrl,
      mqttPort,
      mqttUrl: started.mqttUrl
    })

    await stopAppProxy()
    const settings = await readSettings(join(userData, 'settings.json'))
    expect(settings.proxyMqttEnabled).toBe(true)
    expect(settings.proxyMqttTarget).toBe(brokerUrl)
    expect(await appProxyStatus()).toMatchObject({
      running: false,
      mqtt: true,
      mqttTarget: brokerUrl,
      mqttPort
    })
  })

  it('leaves the MQTT port closed when the relay is off', async () => {
    const started = await startAppProxy({ target: targetUrl, port: 0 })
    expect(started.mqttUrl).toBeUndefined()
    expect(await appProxyStatus()).toMatchObject({ running: true, mqtt: false })
  })

  it('frees the MQTT port on stop', async () => {
    const started = await startAppProxy({
      target: targetUrl,
      port: 0,
      mqtt: true,
      mqttTarget: brokerUrl,
      mqttPort: 0
    })
    const mqttPort = Number(new URL(started.mqttUrl as string).port)
    await stopAppProxy()
    const client = mqtt.connect(`mqtt://127.0.0.1:${mqttPort}`, { reconnectPeriod: 0 })
    await new Promise<void>((resolve, reject) => {
      client.on('error', () => resolve())
      client.on('connect', () => reject(new Error('the MQTT listener is still up')))
    })
    client.end(true)
  })

  it('refuses to start the relay with no broker rather than half-starting', async () => {
    await expect(startAppProxy({ target: targetUrl, port: 0, mqtt: true, mqttTarget: '' })).rejects.toThrow(
      /broker/
    )
    expect(isProxyRunning()).toBe(false)
  })

  it('keeps the start atomic when the broker address is bad', async () => {
    // The HTTP listener starts first; a bad broker must take it down with it,
    // or the user gets a "running" proxy that isn't what they asked for.
    await expect(
      startAppProxy({ target: targetUrl, port: 0, mqtt: true, mqttTarget: 'mqtts://127.0.0.1:8883' })
    ).rejects.toThrow(/mqtts/)
    expect(isProxyRunning()).toBe(false)
    expect(proxyUrl()).toBeNull()
  })
})
