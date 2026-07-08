/** Small pure helpers shared across renderer components. */

/** Join a collection root (absolute) and a collection-relative path. */
export function joinPath(root: string, rel: string): string {
  const r = root.endsWith('/') || root.endsWith('\\') ? root.slice(0, -1) : root
  if (rel === '' || rel === '.') return r
  return `${r}/${rel}`
}

/** Last path segment. */
export function baseName(p: string): string {
  const norm = p.replace(/\\/g, '/')
  const i = norm.lastIndexOf('/')
  return i >= 0 ? norm.slice(i + 1) : norm
}

/** Longest first so `.workflow.json` wins over `.json`. */
const KNOWN_SUFFIXES = ['.workflow.json', '.env.json', '.curl', '.ws']

/** Display name for a request/workflow/env path: basename minus known suffix. */
export function displayName(p: string): string {
  const base = baseName(p)
  const lower = base.toLowerCase()
  for (const s of KNOWN_SUFFIXES) {
    if (lower.endsWith(s)) return base.slice(0, -s.length)
  }
  return base
}

/** Windows-incompatible filename characters (PLAN.md naming rules). */
export const INVALID_NAME = /[<>:"/\\|?*]/

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

export function fmtMs(n: number): string {
  if (n < 1000) return `${Math.round(n)} ms`
  return `${(n / 1000).toFixed(2)} s`
}

/** Pretty-print JSON text, or null when it doesn't parse. */
export function tryPrettyJson(text: string): string | null {
  const t = text.trim()
  if (t === '' || (t[0] !== '{' && t[0] !== '[' && t[0] !== '"')) return null
  try {
    return JSON.stringify(JSON.parse(t), null, 2)
  } catch {
    return null
  }
}

let idCounter = 1
/** Monotonic id for editable table rows. */
export function nextId(): number {
  return idCounter++
}

/**
 * Token-only heuristic: does pasted text look like a curl/websocat/wscat command
 * (rather than a plain URL)? The command must be the first word of some line.
 * Deliberately conservative so an ordinary URL paste is never intercepted.
 */
export function looksLikeCommand(text: string): boolean {
  return /(^|\n)\s*(curl|websocat|wscat)\s/.test(text)
}
