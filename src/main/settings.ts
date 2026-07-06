/**
 * Persisted app settings (Electron userData/settings.json).
 *
 * Currently just remembers the last-opened collection so startup can reopen it
 * without the user re-picking the folder. Reads/writes are best-effort: a
 * missing or corrupt file is treated as empty settings, never a hard failure.
 */
import { app } from 'electron'
import { promises as fs } from 'fs'
import { existsSync, statSync } from 'fs'
import { dirname, join } from 'path'

export interface AppSettings {
  /** Absolute path of the collection open when the app last loaded one. */
  lastRoot?: string
}

/** Location of the settings file (Electron userData). */
export function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export async function readSettings(file: string): Promise<AppSettings> {
  try {
    const obj: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
    return obj !== null && typeof obj === 'object' ? (obj as AppSettings) : {}
  } catch {
    return {} // absent or corrupt — start fresh
  }
}

export async function writeSettings(file: string, patch: Partial<AppSettings>): Promise<void> {
  const next = { ...(await readSettings(file)), ...patch }
  await fs.mkdir(dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(next, null, 2) + '\n')
}

/** Remember `root` as the last-opened collection (best-effort). */
export async function setLastRoot(root: string): Promise<void> {
  try {
    await writeSettings(settingsPath(), { lastRoot: root })
  } catch {
    /* persisting the last root is best-effort */
  }
}

/**
 * The last-opened collection, or null if none is remembered or the folder no
 * longer exists (moved/deleted since last run).
 */
export async function getLastRoot(): Promise<string | null> {
  const { lastRoot } = await readSettings(settingsPath())
  if (lastRoot === undefined) return null
  try {
    if (existsSync(lastRoot) && statSync(lastRoot).isDirectory()) return lastRoot
  } catch {
    /* fall through */
  }
  return null
}
