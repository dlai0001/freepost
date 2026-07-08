/**
 * Environment file (`*.env.json` / `*.local.env.json`) parsing, serialization,
 * and name helpers.
 *
 * Environments are flat `Record<string,string>` documents stored in the
 * collection root or an `environments/` subfolder. Secrets live in git-ignored
 * `*.local.env.json` siblings. This module is pure and testable; the main
 * process wires it to the filesystem.
 */

export type ParseEnvResult =
  | { ok: true; env: Record<string, string> }
  | { ok: false; error: string }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Parse an env document. Must be a plain JSON object (not an array/null/scalar).
 * Each value is coerced to a string via `String(v)`.
 */
export function parseEnvFile(json: string): ParseEnvResult {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message}` }
  }
  if (!isPlainObject(raw)) {
    return { ok: false, error: 'environment must be a JSON object' }
  }
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    env[key] = String(value)
  }
  return { ok: true, env }
}

/**
 * Serialize an env to stable, 2-space-indented JSON with a trailing newline.
 * Keys are sorted alphabetically so git diffs stay stable.
 */
export function serializeEnvFile(env: Record<string, string>): string {
  const ordered: Record<string, string> = {}
  for (const key of Object.keys(env).sort()) {
    ordered[key] = env[key]
  }
  return JSON.stringify(ordered, null, 2) + '\n'
}

/** True when the path names a git-ignored secret env (`*.local.env.json`). */
export function isLocalEnv(path: string): boolean {
  return path.endsWith('.local.env.json')
}

/**
 * The bare, human-facing name of an env file: its basename with the
 * `.local.env.json` or `.env.json` suffix and any directory stripped.
 */
export function envDisplayName(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? ''
  if (base.endsWith('.local.env.json')) return base.slice(0, -'.local.env.json'.length)
  if (base.endsWith('.env.json')) return base.slice(0, -'.env.json'.length)
  return base
}

/**
 * Normalize a user-supplied environment name into a bare base name safe for a
 * filename: trims, strips a trailing `.local.env.json` / `.env.json` if typed,
 * removes filename-invalid characters and path separators, and strips trailing
 * dots. May return '' when nothing valid remains — callers reject empty.
 */
export function sanitizeEnvName(name: string): string {
  let base = name.trim()
  if (base.endsWith('.local.env.json')) base = base.slice(0, -'.local.env.json'.length)
  else if (base.endsWith('.env.json')) base = base.slice(0, -'.env.json'.length)
  base = base.replace(/[<>:"/\\|?*]/g, '')
  base = base.replace(/\.+$/, '')
  return base.trim()
}
