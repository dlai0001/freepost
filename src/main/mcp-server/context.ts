/**
 * Server context and the path guard.
 *
 * Every tool that takes a path funnels through `resolveInRoot`. An MCP client is
 * driven by a model that may be reading untrusted content (a spec someone sent,
 * a web page), so "the AI asked for it" is not authorisation to touch a file:
 * the collection root is the entire world these tools can see, and a handful of
 * paths inside it are off-limits even so.
 */
import { isAbsolute, resolve, sep } from 'path'
import type { RequestFile } from '../../shared/model'

export interface ServerContext {
  /**
   * The collection being served. A getter, not a value: the app toggle resolves
   * this per call so a server can't outlive the collection it was started for.
   */
  getRoot: () => string
  /** Environment file for run_request, if the user picked one. */
  envPath?: string
  /** Refuse every mutating tool (`--readonly`). */
  readonly: boolean
  /** Allow run_request and live schema introspection (`--no-run` clears it). */
  allowRun: boolean
  /**
   * May run_request spawn the stdio MCP server this file names?
   *
   * A predicate rather than a flag because the two callers answer it
   * differently: the CLI answers per-invocation (typing `mcp serve` is the
   * authorisation, same doctrine as `freepost run`; --no-mcp-spawn opts out),
   * while the app answers per-server from its consent store — the only stdio
   * servers a model may start are ones the user approved by hand.
   */
  allowMcpSpawn: (file: RequestFile) => boolean
  /** pm.* session tier, shared across run_request calls like a CLI run. */
  session: Map<string, string>
}

/** Thrown by the guards; tools turn these into isError results, not crashes. */
export class ToolError extends Error {}

/**
 * Paths inside the collection that tools may never touch.
 * - `.freepost/`: secrets, token cache, request history (incl. auth headers).
 * - `.git/`: not the AI's business, and rewriting it could destroy work.
 * - `*.local.env.json`: the git-ignored file where secrets live by convention.
 */
function deniedReason(rel: string): string | null {
  const segments = rel.split('/')
  if (segments.includes('.freepost')) return '.freepost/ holds secrets, tokens and history'
  if (segments.includes('.git')) return '.git/ is off-limits'
  if (/\.local\.env\.json$/i.test(rel)) return '*.local.env.json holds secrets'
  return null
}

/** Normalize to a collection-relative, forward-slashed path. */
function normalizeRel(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

/**
 * Resolve a collection-relative path to an absolute one, or throw.
 *
 * Rejects absolute paths and anything that escapes the root — including via
 * `..`, and including symlink-free trickery like `foo/../../bar`, because the
 * check is on the RESOLVED path, not the spelling.
 */
export function resolveInRoot(root: string, rel: string): string {
  const cleaned = normalizeRel(rel)
  if (cleaned === '' || cleaned === '.') {
    throw new ToolError('Path is required and cannot be the collection root itself.')
  }
  if (isAbsolute(rel) || /^[a-zA-Z]:[\\/]/.test(rel)) {
    throw new ToolError(
      `Absolute paths are not allowed: ${rel}. Use a path relative to the collection root.`
    )
  }
  const abs = resolve(root, cleaned)
  const rootResolved = resolve(root)
  if (abs !== rootResolved && !abs.startsWith(rootResolved + sep)) {
    throw new ToolError(`Path escapes the collection: ${rel}`)
  }
  if (abs === rootResolved) {
    throw new ToolError('Refusing to operate on the collection root itself.')
  }
  const denied = deniedReason(cleaned)
  if (denied !== null) throw new ToolError(`Refusing to touch ${rel}: ${denied}.`)
  return abs
}

/** Guard for read paths that are allowed to be the root (e.g. listing). */
export function assertWritable(ctx: ServerContext, what: string): void {
  if (ctx.readonly) {
    throw new ToolError(`This server is read-only; ${what} is not available. Restart without --readonly to allow it.`)
  }
}

export function assertRunAllowed(ctx: ServerContext): void {
  if (!ctx.allowRun) {
    throw new ToolError('Executing requests is disabled on this server (--no-run).')
  }
}
