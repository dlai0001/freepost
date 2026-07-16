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
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { RecordProxyServer } from '../engine'
import type { RecordedExchange } from '../shared/model'
import { IPC } from '../shared/ipc'
import { ensureFreepostDir } from './collection'
import { getCurrentRoot, onRootChange } from './current-root'
import { ensureProxyCerts } from './proxy-certs'
import { readSettings, settingsPath, writeSettings } from './settings'

export const DEFAULT_PROXY_PORT = 7699
export const DEFAULT_PROXY_HTTPS_PORT = 7700

/** Where the proxy's local CA + leaf live (see proxy-certs.ts). */
export function proxyTlsDir(): string {
  return join(app.getPath('userData'), 'tls')
}

const RECORDED_CAP = 500

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
}> {
  if (running !== null) {
    const settings = await readSettings(settingsPath())
    return {
      running: true,
      url: running.url,
      target: running.target,
      port: running.port,
      https: running.httpsUrl !== undefined,
      httpsPort: running.httpsPort ?? settings.proxyHttpsPort ?? DEFAULT_PROXY_HTTPS_PORT,
      ...(running.httpsUrl !== undefined ? { httpsUrl: running.httpsUrl } : {}),
      ...(running.caPath !== undefined ? { caPath: running.caPath } : {})
    }
  }
  const { proxyTarget: savedTarget, proxyPort, proxyHttpsEnabled, proxyHttpsPort } =
    await readSettings(settingsPath())
  return {
    running: false,
    target: savedTarget ?? '',
    port: proxyPort ?? DEFAULT_PROXY_PORT,
    https: proxyHttpsEnabled ?? false,
    httpsPort: proxyHttpsPort ?? DEFAULT_PROXY_HTTPS_PORT
  }
}

/**
 * Line counts per recorded.jsonl path, so a busy proxy doesn't re-read the
 * whole file on every append. Initialized by counting once on the first
 * append; a stale count (e.g. after History ▸ Clear) only trims early, and
 * the trim resets it from what's really on disk.
 */
const recordedCounts = new Map<string, number>()

/**
 * Append one exchange to <root>/.freepost/history/recorded.jsonl (the shape of
 * appendHistory in execute.ts: append, chmod 600, cap). Exported for tests.
 */
export function appendRecorded(root: string, entry: RecordedExchange): void {
  try {
    const dir = ensureFreepostDir(root)
    const file = join(dir, 'history', 'recorded.jsonl')
    let count =
      recordedCounts.get(file) ??
      (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0)
    appendFileSync(file, JSON.stringify(entry) + '\n')
    count++
    // Recorded traffic carries full headers (incl. auth) — owner-only.
    try {
      chmodSync(file, 0o600)
    } catch {
      /* best-effort; no-op on Windows */
    }
    // Only read + trim once the counter says the cap is exceeded.
    if (count > RECORDED_CAP * 2) {
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-RECORDED_CAP)
      writeFileSync(file, lines.join('\n') + '\n')
      count = lines.length
    }
    recordedCounts.set(file, count)
  } catch {
    // Recording persistence is best-effort; never break the proxied request.
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
}): Promise<{ url: string; target: string; port: number; httpsUrl?: string; caPath?: string }> {
  if (running !== null) {
    return {
      url: running.url,
      target: running.target,
      port: running.port,
      ...(running.httpsUrl !== undefined ? { httpsUrl: running.httpsUrl } : {}),
      ...(running.caPath !== undefined ? { caPath: running.caPath } : {})
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

  const server = new RecordProxyServer()
  server.on('exchange', (entry) => {
    appendRecorded(root, entry)
    broadcast(IPC.proxyLog, { entry })
  })

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
  running = {
    server,
    root,
    target: args.target,
    url,
    port: bound,
    ...(httpsUrl !== undefined ? { httpsUrl } : {}),
    ...(tlsPort !== undefined ? { httpsPort: tlsPort } : {}),
    ...(caPath !== undefined ? { caPath } : {})
  }
  // Persist last-used target/ports/HTTPS toggle so the modal prefills next
  // time — never a "running" flag (per-session, like the MCP server).
  await writeSettings(settingsPath(), {
    proxyTarget: args.target,
    proxyPort: bound,
    proxyHttpsEnabled: https,
    ...(tlsPort !== undefined ? { proxyHttpsPort: tlsPort } : {})
  }).catch(() => undefined)
  onChange()
  return {
    url,
    target: args.target,
    port: bound,
    ...(httpsUrl !== undefined ? { httpsUrl } : {}),
    ...(caPath !== undefined ? { caPath } : {})
  }
}

export async function stopAppProxy(): Promise<void> {
  if (running === null) return
  const { server } = running
  running = null
  await server.stop()
  onChange()
}

/**
 * Stop if the user switches collections — a proxy started for one collection
 * must never quietly record into another.
 */
onRootChange((root) => {
  if (running !== null && root !== running.root) void stopAppProxy()
})
