/**
 * OpenAPI 3.x / Swagger 2.0 importer.
 *
 * Pure module: takes an OpenAPI/Swagger document (JSON or YAML) and returns
 * in-memory RequestFile models plus collection-relative paths. The caller
 * writes files via the format writer. No fs, no network.
 *
 * One RequestFile (kind 'curl') per operation (path × method). Requests are
 * grouped into folders by first tag, else by first path segment. Server /
 * host info collapses into a single `BASE_URL` variable; path templates
 * (`{id}`) and header/query parameters become `${VAR}` references, each with a
 * generated VariableDecl.
 */

import type {
  Frontmatter,
  Header,
  HttpRequestModel,
  RequestFile,
  VariableDecl
} from '@shared/model'
import { sanitizePathSegment, sanitizeVarName } from './postman'
import * as yaml from 'js-yaml'

export type ImportResult =
  | { ok: true; files: { relPath: string; file: RequestFile }[]; note?: string }
  | { ok: false; error: string }

/* ------------------------------ spec shapes ------------------------------ */
/* Module-local structural types for the slice of the specs we read. */

interface SchemaObject {
  type?: string
  format?: string
  properties?: Record<string, SchemaObject>
  items?: SchemaObject
  required?: string[]
  example?: unknown
  examples?: unknown
  default?: unknown
  enum?: unknown[]
  $ref?: string
  allOf?: SchemaObject[]
}

interface MediaTypeObject {
  schema?: SchemaObject
  example?: unknown
  examples?: Record<string, { value?: unknown }>
}

interface ParameterObject {
  name?: string
  in?: string
  required?: boolean
  schema?: SchemaObject
  type?: string // Swagger 2 inline type
  description?: string
}

interface RequestBodyObject {
  content?: Record<string, MediaTypeObject>
  required?: boolean
}

interface OperationObject {
  operationId?: string
  tags?: string[]
  summary?: string
  description?: string
  parameters?: ParameterObject[]
  requestBody?: RequestBodyObject
  consumes?: string[] // Swagger 2
  security?: Array<Record<string, string[]>>
}

type PathItem = Record<string, unknown> & { parameters?: ParameterObject[] }

interface SecurityScheme {
  type?: string
  scheme?: string // http: bearer/basic
  in?: string // apiKey: header/query
  name?: string // apiKey header/query name
  flows?: unknown
}

interface SpecDoc {
  openapi?: string
  swagger?: string
  servers?: Array<{ url?: string }>
  host?: string
  basePath?: string
  schemes?: string[]
  paths?: Record<string, PathItem>
  security?: Array<Record<string, string[]>>
  components?: { securitySchemes?: Record<string, SecurityScheme> }
  securityDefinitions?: Record<string, SecurityScheme>
  /** Resolved BASE_URL default, stashed on the doc during import. */
  __baseUrlDefault?: string
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']

const VAR_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

function collectVarRefs(text: string, into: Set<string>): void {
  for (const m of text.matchAll(VAR_REF)) into.add(m[1])
}

/* -------------------------------- helpers -------------------------------- */

/** Parse JSON, falling back to YAML. Returns undefined on total failure. */
function parseDocument(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    /* fall through to YAML */
  }
  try {
    return yaml.load(text)
  } catch {
    return undefined
  }
}

/** Resolve a local `#/...` $ref against the root document. */
function resolveRef(ref: string, root: SpecDoc): SchemaObject | undefined {
  if (!ref.startsWith('#/')) return undefined
  const parts = ref.slice(2).split('/')
  let cur: unknown = root
  for (const p of parts) {
    if (cur && typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[decodeURIComponent(p.replace(/~1/g, '/').replace(/~0/g, '~'))]
    } else {
      return undefined
    }
  }
  return cur as SchemaObject | undefined
}

/** Follow a $ref (once, guarded) and flatten a shallow allOf merge. */
function derefSchema(schema: SchemaObject | undefined, root: SpecDoc, seen = new Set<string>()): SchemaObject | undefined {
  if (!schema) return undefined
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return {}
    seen.add(schema.$ref)
    return derefSchema(resolveRef(schema.$ref, root), root, seen)
  }
  if (Array.isArray(schema.allOf)) {
    const merged: SchemaObject = { type: 'object', properties: {} }
    for (const part of schema.allOf) {
      const d = derefSchema(part, root, seen)
      if (d?.properties) merged.properties = { ...merged.properties, ...d.properties }
    }
    return merged
  }
  return schema
}

/**
 * Build a minimal example value for a schema: honor an explicit example,
 * else synthesize from type/properties (string => "", number => 0,
 * boolean => false, object => nested, array => [items]).
 */
function exampleFromSchema(schema: SchemaObject | undefined, root: SpecDoc, depth = 0): unknown {
  const s = derefSchema(schema, root)
  if (!s) return null
  if (s.example !== undefined) return s.example
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0]
  if (s.default !== undefined) return s.default
  if (depth > 6) return null

  const type = s.type ?? (s.properties ? 'object' : undefined)
  switch (type) {
    case 'string':
      return ''
    case 'integer':
    case 'number':
      return 0
    case 'boolean':
      return false
    case 'array':
      return [exampleFromSchema(s.items, root, depth + 1)]
    case 'object':
    default: {
      const out: Record<string, unknown> = {}
      for (const [key, propSchema] of Object.entries(s.properties ?? {})) {
        out[key] = exampleFromSchema(propSchema, root, depth + 1)
      }
      return out
    }
  }
}

/** Pull an example out of a media type object (example / examples / schema). */
function exampleFromMediaType(mt: MediaTypeObject | undefined, root: SpecDoc): unknown {
  if (!mt) return undefined
  if (mt.example !== undefined) return mt.example
  if (mt.examples) {
    const first = Object.values(mt.examples)[0]
    if (first && typeof first === 'object' && 'value' in first) return first.value
  }
  return exampleFromSchema(mt.schema, root)
}

/** Convert `{param}` path templates to `${param}`, registering each var. */
function templatizePath(path: string, refs: Set<string>): string {
  return path.replace(/\{([^{}]+)\}/g, (_m, name: string) => {
    const v = sanitizeVarName(name)
    refs.add(v)
    return `\${${v}}`
  })
}

/** Case-insensitive header presence check. */
function hasHeader(headers: Header[], name: string): boolean {
  return headers.some((h) => h.name.toLowerCase() === name.toLowerCase())
}

/* ------------------------------- conversion ------------------------------ */

function convertOperation(
  method: string,
  path: string,
  op: OperationObject,
  inheritedParams: ParameterObject[],
  ctx: {
    root: SpecDoc
    isSwagger2: boolean
    globalSecurity: Array<Record<string, string[]>>
    securitySchemes: Record<string, SecurityScheme>
  }
): { relPath: string; file: RequestFile } {
  const { root, isSwagger2, globalSecurity, securitySchemes } = ctx
  const frontmatter: Frontmatter = {}
  const importNotes: string[] = []
  const refs = new Set<string>()
  refs.add('BASE_URL')

  const desc = op.summary ?? op.description
  if (desc) frontmatter.description = desc

  // URL: ${BASE_URL} + templated path. Required query params appended.
  let url = '${BASE_URL}' + templatizePath(path, refs)

  const headers: Header[] = []
  const disabledQuery: Record<string, string> = {}
  const requiredQuery: string[] = []

  // Merge path-item-level params with operation-level (operation wins by name+in).
  const allParams: ParameterObject[] = []
  const seenParam = new Set<string>()
  for (const p of [...(op.parameters ?? []), ...inheritedParams]) {
    const key = `${p.in}:${p.name}`
    if (seenParam.has(key)) continue
    seenParam.add(key)
    allParams.push(p)
  }

  let bodyParamSchema: SchemaObject | undefined // Swagger 2 `in: body`
  const formDataFields: string[] = []

  for (const p of allParams) {
    if (!p.name) continue
    switch (p.in) {
      case 'path':
        // Handled by templatizePath; ensure the var is registered.
        refs.add(sanitizeVarName(p.name))
        break
      case 'header': {
        const varName = sanitizeVarName(p.name.toUpperCase())
        headers.push({ name: p.name, value: `\${${varName}}` })
        refs.add(varName)
        break
      }
      case 'query': {
        const varName = sanitizeVarName(p.name.toUpperCase())
        if (p.required === true) {
          requiredQuery.push(`${p.name}=\${${varName}}`)
          refs.add(varName)
        } else {
          disabledQuery[p.name] = `\${${varName}}`
        }
        break
      }
      case 'body': // Swagger 2
        bodyParamSchema = p.schema
        break
      case 'formData': // Swagger 2
        formDataFields.push(p.name)
        break
      default:
        break
    }
  }

  if (requiredQuery.length > 0) {
    url += (url.includes('?') ? '&' : '?') + requiredQuery.join('&')
  }

  const http: HttpRequestModel = {
    method: method.toUpperCase(),
    url,
    headers,
    options: {}
  }

  // Request body.
  if (isSwagger2) {
    if (bodyParamSchema) {
      const example = exampleFromSchema(bodyParamSchema, root)
      http.body = { kind: 'raw', value: JSON.stringify(example, null, 2) }
      if (!hasHeader(headers, 'content-type')) {
        headers.push({ name: 'Content-Type', value: 'application/json' })
      }
    } else if (formDataFields.length > 0) {
      const value = formDataFields.map((f) => `${f}=\${${sanitizeVarName(f.toUpperCase())}}`).join('&')
      for (const f of formDataFields) refs.add(sanitizeVarName(f.toUpperCase()))
      http.body = { kind: 'raw', value }
      if (!hasHeader(headers, 'content-type')) {
        headers.push({ name: 'Content-Type', value: 'application/x-www-form-urlencoded' })
      }
    }
  } else {
    const content = op.requestBody?.content
    if (content) {
      const json = content['application/json']
      const form = content['application/x-www-form-urlencoded']
      if (json) {
        const example = exampleFromMediaType(json, root)
        http.body = { kind: 'raw', value: JSON.stringify(example ?? {}, null, 2) }
        if (!hasHeader(headers, 'content-type')) {
          headers.push({ name: 'Content-Type', value: 'application/json' })
        }
      } else if (form) {
        const props = derefSchema(form.schema, root)?.properties ?? {}
        const value = Object.keys(props)
          .map((k) => `${k}=\${${sanitizeVarName(k.toUpperCase())}}`)
          .join('&')
        for (const k of Object.keys(props)) refs.add(sanitizeVarName(k.toUpperCase()))
        http.body = { kind: 'raw', value }
        if (!hasHeader(headers, 'content-type')) {
          headers.push({ name: 'Content-Type', value: 'application/x-www-form-urlencoded' })
        }
      } else {
        const first = Object.keys(content)[0]
        if (first) importNotes.push(`request body content type "${first}" not converted; only application/json and form-urlencoded are supported`)
      }
    }
  }

  // Security: operation-level overrides global.
  const security = op.security ?? globalSecurity
  applySecurity(security, securitySchemes, headers, refs, importNotes)

  // Collect var refs from url + header values (path/query vars already added).
  collectVarRefs(url, refs)
  for (const h of headers) {
    collectVarRefs(h.name, refs)
    collectVarRefs(h.value, refs)
  }

  // Disabled (optional query) rows.
  if (Object.keys(disabledQuery).length > 0) {
    frontmatter.disabled = { query: disabledQuery }
    for (const v of Object.values(disabledQuery)) collectVarRefs(v, refs)
  }

  if (importNotes.length > 0) frontmatter['import-note'] = importNotes.join('; ')

  // Variable declarations. BASE_URL gets the resolved server default.
  const baseDefault = ctx.root.__baseUrlDefault ?? ''
  const variables: VariableDecl[] = [...refs].map((name) => ({
    name,
    required: false,
    defaultValue: name === 'BASE_URL' ? baseDefault : ''
  }))

  // relPath: folder from first tag else first path segment; filename from
  // operationId else "METHOD path".
  const folder = op.tags?.[0] ?? firstPathSegment(path)
  const baseName = op.operationId ?? `${method.toUpperCase()} ${path}`
  const segments = [sanitizePathSegment(folder), `${sanitizePathSegment(baseName)}.curl`]

  return {
    relPath: segments.join('/'),
    file: { kind: 'curl', frontmatter, variables, http, comments: [] }
  }
}

function firstPathSegment(path: string): string {
  const seg = path.split('/').filter((s) => s.length > 0)[0]
  if (!seg) return 'root'
  // Strip a leading template so `/{id}` groups under a stable name.
  return seg.replace(/^\{.*\}$/, 'root')
}

function applySecurity(
  security: Array<Record<string, string[]>> | undefined,
  schemes: Record<string, SecurityScheme>,
  headers: Header[],
  refs: Set<string>,
  notes: string[]
): void {
  if (!security || security.length === 0) return
  // A requirement is a list of alternatives; take the first requirement object.
  const requirement = security[0]
  for (const schemeName of Object.keys(requirement)) {
    const scheme = schemes[schemeName]
    if (!scheme) {
      notes.push(`security scheme "${schemeName}" is not defined; skipped`)
      continue
    }
    const type = scheme.type?.toLowerCase()
    if (type === 'http' && scheme.scheme?.toLowerCase() === 'bearer') {
      if (!hasHeader(headers, 'authorization')) {
        headers.push({ name: 'Authorization', value: 'Bearer ${TOKEN}' })
        refs.add('TOKEN')
      }
    } else if (type === 'oauth2') {
      // Swagger 2 marks oauth2 with type oauth2; treat like a bearer token.
      if (!hasHeader(headers, 'authorization')) {
        headers.push({ name: 'Authorization', value: 'Bearer ${TOKEN}' })
        refs.add('TOKEN')
      }
    } else if (type === 'apikey' && scheme.in === 'header' && scheme.name) {
      if (!hasHeader(headers, scheme.name)) {
        headers.push({ name: scheme.name, value: '${APIKEY}' })
        refs.add('APIKEY')
      }
    } else if (type === 'apikey' && scheme.in === 'query') {
      notes.push(`apiKey-in-query security scheme "${schemeName}" not converted`)
    } else if (type === 'http' && scheme.scheme?.toLowerCase() === 'basic') {
      notes.push(`http basic security scheme "${schemeName}" not converted; set --user manually`)
    } else {
      notes.push(`security scheme "${schemeName}" (type ${scheme.type}) not supported`)
    }
  }
}

/* --------------------------------- entry --------------------------------- */

/** Resolve the BASE_URL default from OpenAPI 3 servers or Swagger 2 host. */
function resolveBaseUrl(doc: SpecDoc, isSwagger2: boolean): string {
  if (isSwagger2) {
    const scheme = doc.schemes && doc.schemes.length > 0 ? doc.schemes[0] : 'https'
    const host = doc.host && doc.host.length > 0 ? doc.host : 'localhost'
    const basePath = doc.basePath ?? ''
    return `${scheme}://${host}${basePath}`
  }
  const raw = doc.servers?.[0]?.url ?? ''
  if (!raw) return ''
  // Server URLs may contain {var} template segments; keep the literal text
  // as the BASE_URL default (a runnable default beats a dangling template).
  return raw.replace(/\{([^{}]+)\}/g, (_m, _name: string) => `${_name}`)
}

/**
 * Import an OpenAPI 3.x or Swagger 2.0 document (JSON or YAML) into in-memory
 * RequestFile models with collection-relative paths.
 */
export function importOpenApi(text: string): ImportResult {
  const data = parseDocument(text)
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, error: 'document root must be a JSON/YAML object' }
  }
  const doc = data as SpecDoc

  const isOpenApi3 = typeof doc.openapi === 'string' && doc.openapi.startsWith('3')
  const isSwagger2 = typeof doc.swagger === 'string' && doc.swagger.startsWith('2')
  if (!isOpenApi3 && !isSwagger2) {
    return { ok: false, error: 'not an OpenAPI 3.x or Swagger 2.0 document: missing "openapi"/"swagger" version' }
  }
  if (!doc.paths || typeof doc.paths !== 'object' || Array.isArray(doc.paths)) {
    return { ok: false, error: 'not a valid spec: missing "paths" object' }
  }

  doc.__baseUrlDefault = resolveBaseUrl(doc, isSwagger2)

  const securitySchemes: Record<string, SecurityScheme> = isSwagger2
    ? doc.securityDefinitions ?? {}
    : doc.components?.securitySchemes ?? {}
  const globalSecurity = doc.security ?? []

  const files: { relPath: string; file: RequestFile }[] = []
  const usedPaths = new Set<string>()
  let operationCount = 0

  try {
    for (const [path, pathItem] of Object.entries(doc.paths)) {
      if (!pathItem || typeof pathItem !== 'object') continue
      const inheritedParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : []
      for (const method of HTTP_METHODS) {
        const op = (pathItem as Record<string, unknown>)[method]
        if (!op || typeof op !== 'object') continue
        operationCount++
        const converted = convertOperation(
          method,
          path,
          op as OperationObject,
          inheritedParams,
          { root: doc, isSwagger2, globalSecurity, securitySchemes }
        )
        // De-duplicate collision-prone relPaths (missing operationId, etc.).
        let relPath = converted.relPath
        if (usedPaths.has(relPath)) {
          const ext = relPath.endsWith('.curl') ? '.curl' : ''
          const stem = ext ? relPath.slice(0, -ext.length) : relPath
          let n = 2
          while (usedPaths.has(`${stem} (${n})${ext}`)) n++
          relPath = `${stem} (${n})${ext}`
        }
        usedPaths.add(relPath)
        files.push({ relPath, file: converted.file })
      }
    }
  } catch (e) {
    return { ok: false, error: `failed to convert spec: ${e instanceof Error ? e.message : String(e)}` }
  }

  if (operationCount === 0) {
    return { ok: false, error: 'spec defines no operations under "paths"' }
  }

  const version = isSwagger2 ? 'Swagger 2.0' : `OpenAPI ${doc.openapi}`
  return {
    ok: true,
    files,
    note: `Imported ${files.length} operation${files.length === 1 ? '' : 's'} from a ${version} document; base URL saved as BASE_URL (default "${doc.__baseUrlDefault}").`
  }
}
