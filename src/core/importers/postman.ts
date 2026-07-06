/**
 * Postman Collection v2.1 importer (PLAN.md "Storage format" / import notes).
 *
 * Pure module: takes collection JSON, returns in-memory RequestFile models
 * plus collection-relative paths. The caller writes files via the format
 * writer. No fs, no network.
 *
 * Variable syntax: every `{{name}}` in urls/headers/bodies/auth values becomes
 * `${name}` (original case kept; characters outside [A-Za-z0-9_] sanitized to
 * underscores). Script source (pm.* API) is left untouched.
 */

import type {
  Frontmatter,
  Header,
  HttpRequestModel,
  RequestFile,
  VariableDecl
} from '@shared/model'

export type ImportResult =
  | { ok: true; files: { relPath: string; file: RequestFile }[]; envNote?: string }
  | { ok: false; error: string }

/* ------------------------------ postman shapes --------------------------- */
/* Module-local structural types for the slice of v2.1 we read. */

interface PmKeyValue {
  key?: string
  value?: string
  disabled?: boolean
  type?: string
}

interface PmUrl {
  raw?: string
  query?: PmKeyValue[]
}

interface PmBody {
  mode?: string
  raw?: string
  graphql?: { query?: string; variables?: unknown }
  urlencoded?: PmKeyValue[]
  formdata?: PmKeyValue[]
  file?: { src?: string }
}

interface PmAuth {
  type?: string
  bearer?: PmKeyValue[] | Record<string, string>
  basic?: PmKeyValue[] | Record<string, string>
}

interface PmEvent {
  listen?: string
  script?: { exec?: string[] | string }
}

interface PmRequest {
  method?: string
  url?: string | PmUrl
  header?: PmKeyValue[]
  body?: PmBody
  auth?: PmAuth
  description?: string | { content?: string }
}

interface PmItem {
  name?: string
  item?: PmItem[]
  request?: PmRequest | string
  event?: PmEvent[]
}

/* -------------------------------- sanitizers ----------------------------- */

/**
 * Make a name safe as a cross-platform path segment: strip `<>:"/\|?*`,
 * collapse whitespace, trim, and strip trailing dots/spaces (Windows rule).
 */
export function sanitizePathSegment(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  return cleaned.length > 0 ? cleaned : 'untitled'
}

/**
 * Map a Postman variable name to a shell-safe name: characters outside
 * [A-Za-z0-9_] become '_'; a leading digit gets a '_' prefix. Case is kept.
 */
export function sanitizeVarName(name: string): string {
  const cleaned = name.trim().replace(/[^A-Za-z0-9_]/g, '_')
  const safe = /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned
  return safe.length > 0 ? safe : '_'
}

/** Convert every `{{name}}` template token to `${name}` (sanitized). */
export function convertTemplates(text: string): string {
  return text.replace(/\{\{([^{}]+)\}\}/g, (_m, name: string) => `\${${sanitizeVarName(name)}}`)
}

const VAR_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

function collectVarRefs(text: string, into: Set<string>): void {
  for (const m of text.matchAll(VAR_REF)) into.add(m[1])
}

/* --------------------------------- helpers ------------------------------- */

function keyValueMap(entries: PmKeyValue[] | Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!entries) return out
  if (Array.isArray(entries)) {
    for (const e of entries) if (e.key !== undefined) out[e.key] = e.value ?? ''
  } else {
    for (const [k, v] of Object.entries(entries)) out[k] = String(v)
  }
  return out
}

function descriptionText(d: string | { content?: string } | undefined): string | undefined {
  if (typeof d === 'string') return d
  if (d && typeof d.content === 'string') return d.content
  return undefined
}

function scriptSource(ev: PmEvent): string | undefined {
  const exec = ev.script?.exec
  if (Array.isArray(exec)) return exec.join('\n')
  if (typeof exec === 'string') return exec
  return undefined
}

/**
 * Resolve the url string, moving disabled query params to frontmatter and
 * keeping enabled ones in the url. Returns the raw (pre-template-conversion)
 * url and the disabled query map (values template-converted by the caller).
 */
function resolveUrl(url: string | PmUrl | undefined): {
  raw: string
  disabledQuery: Record<string, string>
} {
  if (typeof url === 'string') return { raw: url, disabledQuery: {} }
  if (!url) return { raw: '', disabledQuery: {} }
  const raw = url.raw ?? ''
  const query = url.query ?? []
  const disabledQuery: Record<string, string> = {}
  for (const q of query) {
    if (q.disabled === true && q.key !== undefined) disabledQuery[q.key] = q.value ?? ''
  }
  if (Object.keys(disabledQuery).length === 0) return { raw, disabledQuery }
  // Rebuild the query string from enabled params only.
  const base = raw.split('?')[0]
  const enabled = query.filter((q) => q.disabled !== true && q.key !== undefined)
  const qs = enabled.map((q) => (q.value !== undefined && q.value !== '' ? `${q.key}=${q.value}` : `${q.key}`)).join('&')
  return { raw: qs.length > 0 ? `${base}?${qs}` : base, disabledQuery }
}

/* ------------------------------- conversion ------------------------------ */

function convertRequestItem(
  item: PmItem,
  folders: string[],
  collectionVars: Map<string, string>
): { relPath: string; file: RequestFile } {
  const pm = (typeof item.request === 'string' ? { url: item.request } : item.request) ?? {}
  const frontmatter: Frontmatter = {}
  const importNotes: string[] = []
  const refs = new Set<string>()

  const desc = descriptionText(pm.description)
  if (desc) frontmatter.description = desc

  // URL + disabled query params.
  const { raw: rawUrl, disabledQuery } = resolveUrl(pm.url)
  const url = convertTemplates(rawUrl)
  collectVarRefs(url, refs)

  // Headers.
  const headers: Header[] = []
  const disabledHeaders: Record<string, string> = {}
  for (const h of pm.header ?? []) {
    if (h.key === undefined) continue
    const name = convertTemplates(h.key)
    const value = convertTemplates(h.value ?? '')
    if (h.disabled === true) {
      disabledHeaders[name] = value
    } else {
      headers.push({ name, value })
      collectVarRefs(name, refs)
      collectVarRefs(value, refs)
    }
  }

  const http: HttpRequestModel = {
    method: (pm.method ?? 'GET').toUpperCase(),
    url,
    headers,
    options: {}
  }

  // Body.
  const body = pm.body
  switch (body?.mode) {
    case undefined:
      break
    case 'raw': {
      const value = convertTemplates(body.raw ?? '')
      http.body = { kind: 'raw', value }
      collectVarRefs(value, refs)
      break
    }
    case 'graphql': {
      const query = convertTemplates(body.graphql?.query ?? '')
      collectVarRefs(query, refs)
      const gql: NonNullable<Frontmatter['graphql']> = { query }
      const rawVars = body.graphql?.variables
      if (typeof rawVars === 'string') {
        if (rawVars.trim().length > 0) {
          try {
            gql.variables = JSON.parse(rawVars) as Record<string, unknown>
          } catch {
            importNotes.push('graphql variables were not valid JSON and were dropped')
          }
        }
      } else if (rawVars && typeof rawVars === 'object' && !Array.isArray(rawVars)) {
        gql.variables = rawVars as Record<string, unknown>
      }
      frontmatter.graphql = gql
      break
    }
    case 'urlencoded': {
      const pairs = (body.urlencoded ?? []).filter((p) => p.disabled !== true && p.key !== undefined)
      const value = convertTemplates(pairs.map((p) => `${p.key}=${p.value ?? ''}`).join('&'))
      http.body = { kind: 'raw', value }
      collectVarRefs(value, refs)
      if (!headers.some((h) => h.name.toLowerCase() === 'content-type')) {
        headers.push({ name: 'Content-Type', value: 'application/x-www-form-urlencoded' })
      }
      break
    }
    case 'formdata': {
      const n = (body.formdata ?? []).length
      importNotes.push(`dropped formdata body (${n} field${n === 1 ? '' : 's'}): multipart bodies are not supported by the importer`)
      break
    }
    case 'file': {
      importNotes.push(`dropped file body${body.file?.src ? ` (${body.file.src})` : ''}: binary file bodies are not supported by the importer`)
      break
    }
    default:
      importNotes.push(`dropped body with unsupported mode "${body?.mode}"`)
  }

  // Auth.
  const auth = pm.auth
  switch (auth?.type) {
    case undefined:
    case 'noauth':
      break
    case 'bearer': {
      const token = convertTemplates(keyValueMap(auth.bearer).token ?? '')
      headers.push({ name: 'Authorization', value: `Bearer ${token}` })
      collectVarRefs(token, refs)
      break
    }
    case 'basic': {
      const creds = keyValueMap(auth.basic)
      const user = convertTemplates(`${creds.username ?? ''}:${creds.password ?? ''}`)
      http.options.user = user
      collectVarRefs(user, refs)
      break
    }
    default:
      importNotes.push(`dropped auth of type "${auth?.type}": only bearer and basic are converted`)
  }

  // Disabled rows (values already template-converted for headers; convert query here).
  const disabledQueryConverted: Record<string, string> = {}
  for (const [k, v] of Object.entries(disabledQuery)) {
    disabledQueryConverted[convertTemplates(k)] = convertTemplates(v)
  }
  if (Object.keys(disabledHeaders).length > 0 || Object.keys(disabledQueryConverted).length > 0) {
    frontmatter.disabled = {}
    if (Object.keys(disabledHeaders).length > 0) frontmatter.disabled.headers = disabledHeaders
    if (Object.keys(disabledQueryConverted).length > 0) frontmatter.disabled.query = disabledQueryConverted
  }

  // Events -> lifecycle scripts (script source left as-is; pm.* API is supported).
  for (const ev of item.event ?? []) {
    const source = scriptSource(ev)
    if (source === undefined) continue
    if (ev.listen === 'prerequest') {
      frontmatter.scripts = { ...frontmatter.scripts, 'pre-request': source }
    } else if (ev.listen === 'test') {
      frontmatter.scripts = { ...frontmatter.scripts, test: source }
    }
  }

  if (importNotes.length > 0) frontmatter['import-note'] = importNotes.join('; ')

  // Variable declarations for every ${var} referenced in the converted request.
  const variables: VariableDecl[] = [...refs].map((name) => ({
    name,
    required: false,
    defaultValue: collectionVars.get(name) ?? ''
  }))

  const segments = [...folders, `${sanitizePathSegment(item.name ?? 'untitled')}.curl`]
  return {
    relPath: segments.join('/'),
    file: { kind: 'curl', frontmatter, variables, http, comments: [] }
  }
}

function walkItems(
  items: PmItem[],
  folders: string[],
  collectionVars: Map<string, string>,
  out: { relPath: string; file: RequestFile }[]
): void {
  for (const item of items) {
    if (Array.isArray(item.item)) {
      walkItems(item.item, [...folders, sanitizePathSegment(item.name ?? 'untitled')], collectionVars, out)
    } else if (item.request !== undefined) {
      out.push(convertRequestItem(item, folders, collectionVars))
    }
    // Items with neither sub-items nor a request are ignored.
  }
}

/* --------------------------------- entry --------------------------------- */

/**
 * Import a Postman Collection v2.1 JSON document into in-memory RequestFile
 * models with collection-relative paths (folder nesting = directories).
 */
export function importPostmanCollection(collectionJson: string): ImportResult {
  let data: unknown
  try {
    data = JSON.parse(collectionJson)
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, error: 'collection root must be a JSON object' }
  }
  const root = data as { info?: { name?: string; schema?: string }; item?: unknown; variable?: unknown }
  if (!root.info || typeof root.info !== 'object') {
    return { ok: false, error: 'not a Postman collection: missing "info"' }
  }
  if (!Array.isArray(root.item)) {
    return { ok: false, error: 'not a Postman collection: "item" must be an array' }
  }

  // Collection-level variables: defaults for generated VariableDecls + env suggestion.
  const collectionVars = new Map<string, string>()
  const rawVars = Array.isArray(root.variable) ? (root.variable as PmKeyValue[]) : []
  for (const v of rawVars) {
    if (typeof v?.key === 'string') collectionVars.set(sanitizeVarName(v.key), v.value ?? '')
  }

  const files: { relPath: string; file: RequestFile }[] = []
  try {
    walkItems(root.item as PmItem[], [], collectionVars, files)
  } catch (e) {
    return { ok: false, error: `failed to convert collection: ${e instanceof Error ? e.message : String(e)}` }
  }

  if (collectionVars.size > 0) {
    return {
      ok: true,
      files,
      envNote: `Collection defines ${collectionVars.size} variable${collectionVars.size === 1 ? '' : 's'}; consider saving them as an environment file (*.env.json).`
    }
  }
  return { ok: true, files }
}
