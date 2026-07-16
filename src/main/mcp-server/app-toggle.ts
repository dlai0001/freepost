/**
 * The app's MCP server toggle (Tools ▸ MCP Server).
 *
 * Off by default and per-session: exposing a collection to an AI is not
 * something to leave running by accident, and an always-on server means every
 * AI conversation carries Freepost's tools whether or not the user wants them.
 * The user flips it on when they want it, and the toggle IS the authorisation —
 * which is why there is no token on the localhost listener.
 *
 * The server is bound to whichever collection is open when it starts. If the
 * user opens a different one, we stop rather than silently re-point the AI at a
 * collection it wasn't given.
 */
import { clipboard, dialog } from 'electron'
import { startMcpHttpServer, type McpHttpServerHandle } from '../../engine'
import { getCurrentRoot, onRootChange } from '../current-root'
import { isSpawnApproved } from '../mcp-consent'
import { readSettings, settingsPath } from '../settings'
import { createFreepostMcpServer } from './index'
import type { RequestFile } from '../../shared/model'

export const DEFAULT_MCP_PORT = 7599

interface RunningState {
  handle: McpHttpServerHandle
  root: string
}

let running: RunningState | null = null
/** Notified whenever the server starts or stops, so the menu can redraw. */
let onChange: () => void = () => {}

export function isMcpServerRunning(): boolean {
  return running !== null
}

export function mcpServerUrl(): string | null {
  return running?.handle.url ?? null
}

export function mcpServerRoot(): string | null {
  return running?.root ?? null
}

export function setMcpServerChangeListener(fn: () => void): void {
  onChange = fn
}

/**
 * The pm.* session tier for this server's lifetime. Lives here, not on the
 * McpServer: stateless HTTP builds a fresh server per request (see
 * engine/mcp-http.ts), so anything that must survive between tool calls has to
 * be closed over.
 */
let session = new Map<string, string>()

/**
 * Whether a stdio .mcp request may be spawned on the AI's behalf.
 *
 * The app defers to the consent store rather than blanket-allowing like the CLI
 * does: in the CLI, a human typed the command. Here the caller is a model, so
 * the only stdio servers it may start are ones the user already approved for
 * this collection by hand.
 */
function appSpawnGate(root: string): (file: RequestFile) => boolean {
  return (file) => {
    const m = file.mcp
    if (m === undefined) return false
    return isSpawnApproved(root, m)
  }
}

export async function startAppMcpServer(): Promise<void> {
  if (running !== null) return
  const root = getCurrentRoot()
  if (root === null) {
    await dialog.showMessageBox({
      type: 'info',
      message: 'Open a collection first',
      detail: 'The MCP server exposes the collection you have open, so there has to be one.'
    })
    return
  }

  const { mcpServerPort } = await readSettings(settingsPath())
  const port = mcpServerPort ?? DEFAULT_MCP_PORT
  session = new Map<string, string>()
  const spawnGate = appSpawnGate(root)

  try {
    const handle = await startMcpHttpServer({
      port,
      makeServer: () =>
        createFreepostMcpServer({
          getRoot: () => root,
          readonly: false,
          allowRun: true,
          // Evaluated per request against the consent store, so approving a
          // server in the app takes effect without restarting this one.
          allowMcpSpawn: spawnGate,
          session
        })
    })
    running = { handle, root }
    onChange()
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await dialog.showMessageBox({
      type: 'error',
      message: 'Could not start the MCP server',
      detail: message.includes('EADDRINUSE')
        ? `Port ${port} is already in use. Set "mcpServerPort" in settings.json to a free port and try again.`
        : message
    })
    onChange()
  }
}

export async function stopAppMcpServer(): Promise<void> {
  if (running === null) return
  const { handle } = running
  running = null
  await handle.close()
  onChange()
}

export async function toggleAppMcpServer(): Promise<void> {
  if (running !== null) await stopAppMcpServer()
  else await startAppMcpServer()
}

/** Put the config snippet for an AI app on the clipboard. */
export function copyMcpConfigSnippet(): void {
  const url = mcpServerUrl()
  if (url === null) return
  clipboard.writeText(
    JSON.stringify({ mcpServers: { freepost: { type: 'http', url } } }, null, 2) + '\n'
  )
}

/**
 * Stop if the user switches collections — a server started for one collection
 * must never quietly start serving another.
 */
onRootChange((root) => {
  if (running !== null && root !== running.root) void stopAppMcpServer()
})
