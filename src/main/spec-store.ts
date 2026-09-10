/**
 * OpenAPI/Swagger documents stored inside a collection (`specs/<name>`), and
 * the fs-side glue around the pure core/spec helpers: import a spec into the
 * collection, read + cache it, and validate a response against it. Shared by
 * the IPC handlers, the CLI runner, the MCP tools and the mock server.
 */
import { promises as fs, existsSync, statSync } from 'fs'
import { basename, extname, join, relative, resolve } from 'path'
import type { HttpResponseModel, OpenApiOperationSummary, SpecRef, SpecValidationReport } from '../shared/model'
import { listOpenApiOperations } from '../core/importers/openapi'
import { sanitizePathSegment } from '../core/importers/postman'
import { parseSpec, type ParsedSpec } from '../core/spec'
import { validateResponse } from '../core/spec/validate'

/** Collection-relative directory specs are stored under (hidden from the request tree). */
export const SPEC_DIR = 'specs'

/** Absolute path of a collection-relative spec, refusing paths that escape the root. */
export function specAbsPath(root: string, rel: string): string {
  const abs = resolve(root, rel)
  const back = relative(resolve(root), abs)
  if (back.startsWith('..') || resolve(root, back) !== abs) throw new Error(`spec path escapes the collection: ${rel}`)
  return abs
}

const cache = new Map<string, { mtimeMs: number; spec: ParsedSpec; text: string }>()

/** Read + parse a stored spec, cached by mtime so repeated runs don't re-parse. */
export async function readSpec(
  root: string,
  rel: string
): Promise<{ ok: true; spec: ParsedSpec; text: string } | { ok: false; error: string }> {
  let abs: string
  try {
    abs = specAbsPath(root, rel)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  let mtimeMs: number
  try {
    mtimeMs = (await fs.stat(abs)).mtimeMs
  } catch {
    return { ok: false, error: `spec file not found: ${rel}` }
  }
  const hit = cache.get(abs)
  if (hit !== undefined && hit.mtimeMs === mtimeMs) return { ok: true, spec: hit.spec, text: hit.text }
  let text: string
  try {
    text = await fs.readFile(abs, 'utf8')
  } catch (e) {
    return { ok: false, error: `cannot read spec ${rel}: ${e instanceof Error ? e.message : String(e)}` }
  }
  const parsed = parseSpec(text)
  if (!parsed.ok) return { ok: false, error: `${rel}: ${parsed.error}` }
  cache.set(abs, { mtimeMs, spec: parsed.spec, text })
  return { ok: true, spec: parsed.spec, text }
}

/** Collection-relative paths of every stored spec, sorted. */
export async function listSpecs(root: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(join(root, SPEC_DIR))
  } catch {
    return []
  }
  return entries
    .filter((n) => /\.(json|ya?ml)$/i.test(n))
    .sort()
    .map((n) => `${SPEC_DIR}/${n}`)
}

export interface ImportedSpec {
  /** Collection-relative path the spec was written to. */
  path: string
  version: string
  operations: OpenApiOperationSummary[]
}

/**
 * Validate and store spec text under `specs/`, naming it after `preferredName`
 * (sanitised; extension normalised to .json/.yaml by content). An existing
 * file with the same name is never overwritten — the new one gets " (2)".
 */
export async function importSpecText(root: string, text: string, preferredName: string): Promise<ImportedSpec> {
  const listed = listOpenApiOperations(text)
  if (!listed.ok) throw new Error(listed.error)
  const isJson = (() => {
    try {
      JSON.parse(text)
      return true
    } catch {
      return false
    }
  })()
  const stem = sanitizePathSegment(basename(preferredName, extname(preferredName))) || 'openapi'
  const ext = isJson ? '.json' : '.yaml'
  await fs.mkdir(join(root, SPEC_DIR), { recursive: true })
  // dedupeRelPath only knows the .curl extension, so suffix the stem here.
  let rel = `${SPEC_DIR}/${stem}${ext}`
  for (let n = 2; existsSync(join(root, rel)); n++) rel = `${SPEC_DIR}/${stem} (${n})${ext}`
  await fs.writeFile(join(root, rel), text, 'utf8')
  return { path: rel, version: listed.version, operations: listed.operations }
}

/** `importSpecText` for a file on disk (anywhere), named after its basename. */
export async function importSpecFile(root: string, absPath: string): Promise<ImportedSpec> {
  const text = await fs.readFile(absPath, 'utf8')
  return importSpecText(root, text, basename(absPath))
}

/** Is `rel` already a stored spec inside this collection (so import can stamp without copying)? */
export function isStoredSpec(root: string, rel: string): boolean {
  try {
    const abs = specAbsPath(root, rel)
    return existsSync(abs) && statSync(abs).isFile()
  } catch {
    return false
  }
}

/**
 * Validate a response against the request's `frontmatter.spec`. Never throws:
 * a missing/unparseable spec or malformed ref becomes `verdict: 'error'`.
 */
export async function validateResponseAgainstSpec(
  root: string,
  ref: unknown,
  response: HttpResponseModel
): Promise<SpecValidationReport> {
  const r = ref as Partial<SpecRef> | null | undefined
  if (!r || typeof r !== 'object' || typeof r.path !== 'string' || typeof r.operationId !== 'string') {
    return {
      verdict: 'error',
      spec: { path: String(r?.path ?? ''), operationId: String(r?.operationId ?? '') },
      errors: [],
      reason: 'malformed frontmatter.spec: expected { path, operationId }'
    }
  }
  const specRef: SpecRef = { path: r.path, operationId: r.operationId }
  const read = await readSpec(root, specRef.path)
  if (!read.ok) return { verdict: 'error', spec: specRef, errors: [], reason: read.error }
  return validateResponse({ spec: read.spec, specRef, operationId: specRef.operationId, response })
}
