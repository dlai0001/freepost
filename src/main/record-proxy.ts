/**
 * The app's record proxy lifecycle (Tools ▸ Proxy Server (Record)).
 *
 * Off by default and per-session, like the MCP server toggle: a listener that
 * records every request (headers included, verbatim) is not something to leave
 * running by accident. The menu item only OPENS the modal; starting is an
 * explicit click there, and errors (EADDRINUSE, bad target) are thrown back
 * through IPC so the modal shows them.
 *
 * The proxy is bound to whichever collection is open when it starts — recorded
 * exchanges land in that collection's .freepost/history/recorded.jsonl. If the
 * user opens a different one, we stop rather than silently record into a
 * collection the traffic wasn't meant for.
 */
import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { MqttRecordProxy, RecordProxyServer } from '../engine'
import { IPC } from '../shared/ipc'
import { getCurrentRoot, onRootChange } from './current-root'
import { ensureProxyCerts } from './proxy-certs'
import {
  appendRecorded,
  DEFAULT_PROXY_HTTPS_PORT,
  DEFAULT_PROXY_MQTT_PORT,
  DEFAULT_PROXY_PORT
} from './recorded-store'
import { readSettings, settingsPath, writeSettings } from './settings'

// The store and the defaults are shared with the `freepost proxy` CLI, which
// must not import Electron — re-exported so this stays the module the app side
// reads them from.
export { DEFAULT_PROXY_HTTPS_PORT, DEFAULT_PROXY_MQTT_PORT, DEFAULT_PROXY_PORT }

/** Where the proxy's local CA + leaf live (see proxy-certs.ts). */
export function proxyTlsDir(): string {
  return join(app.getPath('userData'), 'tls')
}

interface RunningState {
  server: RecordProxyServer
  root: string
  target: string
  url: string
  port: number
  /** Set only when the HTTPS listener was enabled for this run. */
  httpsUrl?: string
  httpsPort?: number
  caPath?: string
  /** Set only when the MQTT relay was enabled for this run (its own listener). */
  mqttServer?: MqttRecordProxy
  mqttTarget?: string
  mqttUrl?: string
  mqttPort?: number
}

let running: RunningState | null = null
/** Notified whenever the proxy starts or stops, so the menu can redraw. */
let onChange: () => void = () => {}

export function isProxyRunning(): boolean {
  return running !== null
}

export function proxyUrl(): string | null {
  return running?.url ?? null
}

export function proxyTarget(): string | null {
  return running?.target ?? null
}

export function setProxyChangeListener(fn: () => void): void {
  onChange = fn
}

/**
 * State for the modal: when running, the live URLs/target; when stopped, the
 * last-used target/ports/HTTPS toggle from settings as the prefill.
 */
export async function appProxyStatus(): Promise<{
  running: boolean
  url?: string
  target: string
  port: number
  https: boolean
  httpsPort: number
  httpsUrl?: string
  caPath?: string
  mqtt: boolean
  mqttTarget: string
  mqttPort: number
  mqttUrl?: string
}> {
  const settings = await readSettings(settingsPath())
  if (running !== null) {
    return {
      running: true,
      url: running.url,
      target: running.target,
      port: running.port,
      https: running.httpsUrl !== undefined,
      httpsPort: running.httpsPort ?? settings.proxyHttpsPort ?? DEFAULT_PROXY_HTTPS_PORT,
      ...(running.httpsUrl !== undefined ? { httpsUrl: running.httpsUrl } : {}),
      ...(running.caPath !== undefined ? { caPath: running.caPath } : {}),
      mqtt: running.mqttUrl !== undefined,
      mqttTarget: running.mqttTarget ?? settings.proxyMqttTarget ?? '',
      mqttPort: running.mqttPort ?? settings.proxyMqttPort ?? DEFAULT_PROXY_MQTT_PORT,
      ...(running.mqttUrl !== undefined ? { mqttUrl: running.mqttUrl } : {})
    }
  }
  return {
    running: false,
    target: settings.proxyTarget ?? '',
    port: settings.proxyPort ?? DEFAULT_PROXY_PORT,
    https: settings.proxyHttpsEnabled ?? false,
    httpsPort: settings.proxyHttpsPort ?? DEFAULT_PROXY_HTTPS_PORT,
    mqtt: settings.proxyMqttEnabled ?? false,
    mqttTarget: settings.proxyMqttTarget ?? '',
    mqttPort: settings.proxyMqttPort ?? DEFAULT_PROXY_MQTT_PORT
  }
}

function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, ...args)
}

export async function startAppProxy(args: {
  target: string
  port?: number
  /** Also start the TLS listener (self-signed local CA; see proxy-certs.ts). */
  https?: boolean
  httpsPort?: number
  /** Also start the MQTT relay — its own listener, to its own broker target. */
  mqtt?: boolean
  mqttTarget?: string
  mqttPort?: number
}): Promise<{
  url: string
  target: string
  port: number
  httpsUrl?: string
  caPath?: string
  mqttUrl?: string
}> {
  if (running !== null) {
    return {
      url: running.url,
      target: running.target,
      port: running.port,
      ...(running.httpsUrl !== undefined ? { httpsUrl: running.httpsUrl } : {}),
      ...(running.caPath !== undefined ? { caPath: running.caPath } : {}),
      ...(running.mqttUrl !== undefined ? { mqttUrl: running.mqttUrl } : {})
    }
  }
  const root = getCurrentRoot()
  if (root === null) {
    throw new Error('Open a collection first — recorded traffic is stored in it.')
  }

  const settings = await readSettings(settingsPath())
  const port = args.port ?? settings.proxyPort ?? DEFAULT_PROXY_PORT
  const https = args.https ?? false
  const httpsPort = args.httpsPort ?? settings.proxyHttpsPort ?? DEFAULT_PROXY_HTTPS_PORT
  const mqtt = args.mqtt ?? false
  const mqttTarget = args.mqttTarget ?? settings.proxyMqttTarget ?? ''
  const mqttPort = args.mqttPort ?? settings.proxyMqttPort ?? DEFAULT_PROXY_MQTT_PORT
  if (mqtt && mqttTarget.trim() === '') {
    throw new Error('Enter the MQTT broker to relay to (e.g. mqtt://127.0.0.1:1883).')
  }

  // Both listeners record into the same collection, through the same sink.
  const record = (entry: Parameters<typeof appendRecorded>[1]): void => {
    appendRecorded(root, entry)
    broadcast(IPC.proxyLog, { entry })
  }
  const server = new RecordProxyServer()
  server.on('exchange', record)

  // Certs are lazy: generated (or rotated) only when HTTPS is actually enabled.
  let tls: { key: string; cert: string; port: number } | undefined
  let caPath: string | undefined
  if (https) {
    const certs = await ensureProxyCerts(proxyTlsDir())
    tls = { key: certs.keyPem, cert: certs.certPem, port: httpsPort }
    caPath = certs.caPath
  }

  const { port: bound, tlsPort } = await server.start({ target: args.target, port, tls })
  const url = `http://127.0.0.1:${bound}`
  const httpsUrl = tlsPort !== undefined ? `https://127.0.0.1:${tlsPort}` : undefined

  // The MQTT relay is a separate listener on a separate port to a separate
  // target — started here so one toggle runs (and one stop stops) everything.
  let mqttServer: MqttRecordProxy | undefined
  let mqttBound: number | undefined
  if (mqtt) {
    mqttServer = new MqttRecordProxy()
    mqttServer.on('exchange', record)
    try {
      ;({ port: mqttBound } = await mqttServer.start({ target: mqttTarget, port: mqttPort }))
    } catch (e) {
      // Keep the start atomic: a bad broker or a taken MQTT port must not
      // leave the HTTP listener up and half-started.
      await server.stop()
      throw e
    }
  }
  const mqttUrl = mqttBound !== undefined ? `mqtt://127.0.0.1:${mqttBound}` : undefined

  running = {
    server,
    root,
    target: args.target,
    url,
    port: bound,
    ...(httpsUrl !== undefined ? { httpsUrl } : {}),
    ...(tlsPort !== undefined ? { httpsPort: tlsPort } : {}),
    ...(caPath !== undefined ? { caPath } : {}),
    ...(mqttServer !== undefined ? { mqttServer, mqttTarget } : {}),
    ...(mqttUrl !== undefined ? { mqttUrl } : {}),
    ...(mqttBound !== undefined ? { mqttPort: mqttBound } : {})
  }
  // Persist last-used targets/ports/toggles so the modal prefills next time —
  // never a "running" flag (per-session, like the MCP server).
  await writeSettings(settingsPath(), {
    proxyTarget: args.target,
    proxyPort: bound,
    proxyHttpsEnabled: https,
    ...(tlsPort !== undefined ? { proxyHttpsPort: tlsPort } : {}),
    proxyMqttEnabled: mqtt,
    ...(mqttTarget.trim() !== '' ? { proxyMqttTarget: mqttTarget } : {}),
    ...(mqttBound !== undefined ? { proxyMqttPort: mqttBound } : {})
  }).catch(() => undefined)
  onChange()
  return {
    url,
    target: args.target,
    port: bound,
    ...(httpsUrl !== undefined ? { httpsUrl } : {}),
    ...(caPath !== undefined ? { caPath } : {}),
    ...(mqttUrl !== undefined ? { mqttUrl } : {})
  }
}

export async function stopAppProxy(): Promise<void> {
  if (running === null) return
  const { server, mqttServer } = running
  running = null
  await server.stop()
  await mqttServer?.stop()
  onChange()
}

/**
 * Stop if the user switches collections — a proxy started for one collection
 * must never quietly record into another.
 */
onRootChange((root) => {
  if (running !== null && root !== running.root) void stopAppProxy()
})
