/**
 * OpenAPI 3.x / Swagger 2.0 document model + lookup helpers shared by the
 * importer (core/importers/openapi), the response validator (./validate) and
 * the mock-server fallback (./mock).
 *
 * Pure module: parses a spec document (JSON or YAML) into a structurally typed
 * slice and answers questions about it — which operation does an id name,
 * which documented response fits a status, what path prefix does the server
 * URL carry. No fs, no network, no ajv (that lives in ./validate so the
 * renderer can import this file for operation suggestion).
 */

import type { OpenApiOperationSummary } from '@shared/model'
import * as yaml from 'js-yaml'
import { pathToSegments, type RouteSegment } from '../mock/router'

/* ------------------------------ spec shapes ------------------------------ */
/* Structural types for the slice of the specs we read. */

export interface SchemaObject {
  type?: string | string[]
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
  nullable?: boolean
}

export interface MediaTypeObject {
  schema?: SchemaObject
  example?: unknown
  examples?: Record<string, { value?: unknown }>
}

export interface ParameterObject {
  name?: string
  in?: string
  required?: boolean
  schema?: SchemaObject
  type?: string // Swagger 2 inline type
  description?: string
}

export interface RequestBodyObject {
  content?: Record<string, MediaTypeObject>
  required?: boolean
}

/** Response header definition: OAS3 carries `schema`, Swagger 2 inlines `type`. */
export interface HeaderObject {
  $ref?: string
  description?: string
  required?: boolean
  schema?: SchemaObject
  type?: string
  format?: string
  example?: unknown
  default?: unknown
}

export interface ResponseObject {
  $ref?: string
  description?: string
  /** Swagger 2 inline body schema. */
  schema?: SchemaObject
  /** Swagger 2 `{ [mediaType]: example }`. */
  examples?: Record<string, unknown>
  /** OAS3 media types. */
  content?: Record<string, MediaTypeObject>
  headers?: Record<string, HeaderObject>
}

export interface OperationObject {
  operationId?: string
  tags?: string[]
  summary?: string
  description?: string
  parameters?: ParameterObject[]
  requestBody?: RequestBodyObject
  responses?: Record<string, ResponseObject>
  consumes?: string[] // Swagger 2
  produces?: string[] // Swagger 2
  security?: Array<Record<string, string[]>>
}

export type PathItem = Record<string, unknown> & { parameters?: ParameterObject[] }

export interface SecurityScheme {
  type?: string
  scheme?: string // http: bearer/basic
  in?: string // apiKey: header/query
  name?: string // apiKey header/query name
  flows?: unknown
}

export interface SpecDoc {
  openapi?: string
  swagger?: string
  servers?: Array<{ url?: string }>
  host?: string
  basePath?: string
  schemes?: string[]
  produces?: string[] // Swagger 2 global default
  paths?: Record<string, PathItem>
  security?: Array<Record<string, string[]>>
  components?: { securitySchemes?: Record<string, SecurityScheme> }
  securityDefinitions?: Record<string, SecurityScheme>
  /** Resolved BASE_URL default, stashed on the doc during import. */
  __baseUrlDefault?: string
}

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']

/**
 * Collection-relative directory stored specs live in (hidden from the request
 * tree). Declared here rather than in main/spec-store so the collection
 * scanner can skip it without importing the store — which would close an
 * import cycle now that the store walks the collection.
 */
export const SPEC_DIR = 'specs'

/** A parsed, version-classified spec document. */
export interface ParsedSpec {
  doc: SpecDoc
  isSwagger2: boolean
  /** OpenAPI 3.1+ (schemas are JSON Schema 2020-12, `type` may be an array). */
  is31: boolean
  /** Human label: 'Swagger 2.0' | 'OpenAPI 3.0.3'. */
  version: string
}

/* -------------------------------- parsing -------------------------------- */

/** Parse JSON, falling back to YAML. Returns undefined on total failure. */
export function parseDocument(text: string): unknown {
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

/** Parse + validate the document shape shared by every spec consumer. */
export function parseSpecDoc(
  text: string
): { ok: true; doc: SpecDoc; isSwagger2: boolean } | { ok: false; error: string } {
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
  return { ok: true, doc, isSwagger2 }
}

/** `parseSpecDoc` plus version classification. */
export function parseSpec(text: string): { ok: true; spec: ParsedSpec } | { ok: false; error: string } {
  const parsed = parseSpecDoc(text)
  if (!parsed.ok) return parsed
  const { doc, isSwagger2 } = parsed
  return {
    ok: true,
    spec: {
      doc,
      isSwagger2,
      is31: !isSwagger2 && typeof doc.openapi === 'string' && /^3\.[1-9]/.test(doc.openapi),
      version: specVersionLabel(doc, isSwagger2)
    }
  }
}

export function specVersionLabel(doc: SpecDoc, isSwagger2: boolean): string {
  return isSwagger2 ? 'Swagger 2.0' : `OpenAPI ${doc.openapi}`
}

/* ------------------------------ $ref + examples --------------------------- */

/** Unescape one JSON-pointer token (`~1` → `/`, `~0` → `~`). */
export function unescapePointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~')
}

/** Escape one JSON-pointer token (`~` → `~0`, `/` → `~1`). */
export function escapePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1')
}

/** Resolve a local `#/...` $ref against the root document. */
export function resolveRef(ref: string, root: SpecDoc): unknown {
  if (!ref.startsWith('#/')) return undefined
  const parts = ref.slice(2).split('/')
  let cur: unknown = root
  for (const p of parts) {
    if (cur && typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[decodeURIComponent(unescapePointerToken(p))]
    } else {
      return undefined
    }
  }
  return cur
}

/** Follow a $ref (once, guarded) and flatten a shallow allOf merge. */
export function derefSchema(
  schema: SchemaObject | undefined,
  root: SpecDoc,
  seen = new Set<string>()
): SchemaObject | undefined {
  if (!schema) return undefined
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return {}
    seen.add(schema.$ref)
    return derefSchema(resolveRef(schema.$ref, root) as SchemaObject | undefined, root, seen)
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
export function exampleFromSchema(schema: SchemaObject | undefined, root: SpecDoc, depth = 0): unknown {
  const s = derefSchema(schema, root)
  if (!s) return null
  if (s.example !== undefined) return s.example
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0]
  if (s.default !== undefined) return s.default
  if (depth > 6) return null

  // 3.1 `type: ['string', 'null']` — take the first non-null type.
  const rawType = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type
  const type = rawType ?? (s.properties ? 'object' : undefined)
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
export function exampleFromMediaType(mt: MediaTypeObject | undefined, root: SpecDoc): unknown {
  if (!mt) return undefined
  if (mt.example !== undefined) return mt.example
  if (mt.examples) {
    const first = Object.values(mt.examples)[0]
    if (first && typeof first === 'object' && 'value' in first) return first.value
  }
  return exampleFromSchema(mt.schema, root)
}

/* ------------------------------- operations ------------------------------- */

/** Stable per-operation key: `${METHOD} ${path}` (path exactly as written in the spec). */
export function operationId(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`
}

export interface FoundOperation {
  method: string
  path: string
  op: OperationObject
  /** JSON pointer to the operation object, e.g. `/paths/~1pets~1{id}/get`. */
  pointer: string
}

/** Locate an operation by its `${METHOD} ${path}` id. */
export function findOperation(spec: ParsedSpec, id: string): FoundOperation | undefined {
  const space = id.indexOf(' ')
  if (space < 0) return undefined
  const method = id.slice(0, space).toLowerCase()
  const path = id.slice(space + 1)
  if (!HTTP_METHODS.includes(method)) return undefined
  const pathItem = spec.doc.paths?.[path]
  if (!pathItem || typeof pathItem !== 'object') return undefined
  const op = pathItem[method]
  if (!op || typeof op !== 'object') return undefined
  return {
    method,
    path,
    op: op as OperationObject,
    pointer: `/paths/${escapePointerToken(path)}/${method}`
  }
}

/** Resolve the BASE_URL default from OpenAPI 3 servers or Swagger 2 host. */
export function resolveBaseUrl(doc: SpecDoc, isSwagger2: boolean): string {
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
 * Path prefix the server mounts the API under, as literal segments: Swagger 2
 * `basePath`, or the pathname of OAS3 `servers[0].url` (absolute or relative).
 * Server-URL `{var}` segments are kept as their bare name, matching
 * `resolveBaseUrl`.
 */
export function specPathPrefix(spec: ParsedSpec): string[] {
  let pathname: string
  if (spec.isSwagger2) {
    pathname = spec.doc.basePath ?? ''
  } else {
    const raw = resolveBaseUrl(spec.doc, false)
    if (raw === '') return []
    try {
      pathname = new URL(raw).pathname
    } catch {
      pathname = raw.split('?')[0]
    }
  }
  return pathname.split('/').filter((s) => s !== '')
}

/** `/pets/{id}` → `[{literal:'pets'},{param:'id'}]`, param names kept as written. */
export function templateSegments(path: string): RouteSegment[] {
  return path
    .split('/')
    .filter((s) => s !== '')
    .map((seg) => {
      const m = seg.match(/^\{([^{}]+)\}$/)
      if (m !== null) return { param: m[1] }
      // A segment with an embedded template (`file.{ext}`) is treated as a wildcard.
      if (/\{[^{}]+\}/.test(seg)) return { param: seg.replace(/[{}]/g, '') }
      return { literal: seg }
    })
}

/**
 * Pick the operation a request most likely targets: same method, same segment
 * count (with or without the server prefix), scored per segment — literal
 * equality 2, request `${VAR}` vs spec `{param}` 1, literal vs param 0.5, and
 * a literal mismatch rejects the candidate. Ties go to the operation with the
 * fewest params.
 */
export function suggestOperation(
  operations: OpenApiOperationSummary[],
  method: string,
  requestUrl: string,
  prefix: string[] = []
): string | undefined {
  const want = method.toUpperCase()
  // A leading `${BASE_URL}` is the host, not a path segment: swap in a dummy
  // origin so `pathToSegments` parses the rest as a path.
  const reqSegs = pathToSegments(requestUrl.replace(/^\s*\$\{[^}]+\}/, 'http://x'))
  let best: { id: string; score: number; params: number } | undefined
  for (const op of operations) {
    if (op.method.toUpperCase() !== want) continue
    const opSegs = templateSegments(op.path)
    const candidates: RouteSegment[][] = [opSegs]
    if (prefix.length > 0) candidates.push([...prefix.map((literal) => ({ literal })), ...opSegs])
    for (const segs of candidates) {
      if (segs.length !== reqSegs.length) continue
      let score = 0
      let ok = true
      for (let i = 0; i < segs.length; i++) {
        const a = reqSegs[i]
        const b = segs[i]
        if ('literal' in a && 'literal' in b) {
          if (a.literal !== b.literal) {
            ok = false
            break
          }
          score += 2
        } else if ('param' in a && 'param' in b) {
          score += 1
        } else {
          score += 0.5
        }
      }
      if (!ok) continue
      const params = segs.filter((s) => 'param' in s).length
      if (best === undefined || score > best.score || (score === best.score && params < best.params)) {
        best = { id: op.id, score, params }
      }
    }
  }
  return best?.id
}

/* -------------------------------- responses ------------------------------- */

export interface PickedResponse {
  /** Response key as written: '200', '2XX', 'default'. */
  key: string
  response: ResponseObject
  /** JSON pointer to the (deref'd) response object. */
  pointer: string
}

function derefResponse(
  entry: ResponseObject,
  key: string,
  opPointer: string,
  spec: ParsedSpec
): { response: ResponseObject; pointer: string } | undefined {
  if (entry.$ref !== undefined) {
    const target = resolveRef(entry.$ref, spec.doc)
    if (!target || typeof target !== 'object') return undefined
    return { response: target as ResponseObject, pointer: entry.$ref.slice(1) }
  }
  return { response: entry, pointer: `${opPointer}/responses/${escapePointerToken(key)}` }
}

/** Documented response for a status: exact → `NXX` wildcard → `default`. */
export function pickResponse(found: FoundOperation, status: number, spec: ParsedSpec): PickedResponse | undefined {
  const responses = found.op.responses
  if (!responses || typeof responses !== 'object') return undefined
  const keys = Object.keys(responses)
  const exact = keys.find((k) => k === String(status))
  const wildcard = keys.find((k) => k.toUpperCase() === `${Math.floor(status / 100)}XX`)
  const key = exact ?? wildcard ?? keys.find((k) => k === 'default')
  if (key === undefined) return undefined
  const entry = responses[key]
  if (!entry || typeof entry !== 'object') return undefined
  const d = derefResponse(entry, key, found.pointer, spec)
  return d === undefined ? undefined : { key, ...d }
}

/** Every documented response, deref'd, in spec order. */
export function allResponses(found: FoundOperation, spec: ParsedSpec): PickedResponse[] {
  const responses = found.op.responses
  if (!responses || typeof responses !== 'object') return []
  const out: PickedResponse[] = []
  for (const [key, entry] of Object.entries(responses)) {
    if (!entry || typeof entry !== 'object') continue
    const d = derefResponse(entry, key, found.pointer, spec)
    if (d !== undefined) out.push({ key, ...d })
  }
  return out
}

/** Response keys the operation documents, in spec order. */
export function documentedStatuses(op: OperationObject): string[] {
  return op.responses && typeof op.responses === 'object' ? Object.keys(op.responses) : []
}

export interface PickedMediaType {
  /** Media type the schema is documented under (undefined for Swagger 2 with no `produces`). */
  mediaType?: string
  /** JSON pointer to the schema object. */
  schemaPointer: string
}

/** Strip parameters: `application/json; charset=utf-8` → `application/json`. */
export function baseMediaType(contentType: string | undefined): string | undefined {
  if (contentType === undefined) return undefined
  const base = contentType.split(';')[0].trim().toLowerCase()
  return base === '' ? undefined : base
}

/** Does this media type carry JSON (`application/json`, `*+json`, `text/json`)? */
export function isJsonMediaType(mediaType: string | undefined): boolean {
  if (mediaType === undefined) return false
  const base = baseMediaType(mediaType) ?? ''
  return base === 'application/json' || base === 'text/json' || base.endsWith('+json')
}

/**
 * Schema for the response body: Swagger 2 uses the inline `schema` (media type
 * from `produces`, operation then root, defaulting to application/json); OAS3
 * picks from `content` by exact type → wildcard entry → application/json →
 * first key. Undefined when the response documents no body schema.
 */
export function pickMediaType(
  picked: PickedResponse,
  found: FoundOperation,
  contentType: string | undefined,
  spec: ParsedSpec
): PickedMediaType | undefined {
  const { response, pointer } = picked
  if (spec.isSwagger2) {
    if (!response.schema) return undefined
    const produces = found.op.produces ?? spec.doc.produces ?? []
    const want = baseMediaType(contentType)
    const mediaType =
      (want !== undefined && produces.some((p) => baseMediaType(p) === want) ? want : undefined) ??
      produces.find((p) => isJsonMediaType(p)) ??
      produces[0] ??
      'application/json'
    return { mediaType, schemaPointer: `${pointer}/schema` }
  }
  const content = response.content
  if (!content || typeof content !== 'object') return undefined
  const keys = Object.keys(content)
  if (keys.length === 0) return undefined
  const want = baseMediaType(contentType)
  let key: string | undefined
  if (want !== undefined) {
    key = keys.find((k) => baseMediaType(k) === want)
    if (key === undefined) {
      const [type] = want.split('/')
      key = keys.find((k) => {
        const b = baseMediaType(k)
        return b === '*/*' || b === `${type}/*`
      })
    }
  }
  key ??= keys.find((k) => baseMediaType(k) === 'application/json') ?? keys[0]
  const mt = content[key]
  if (!mt || typeof mt !== 'object' || !mt.schema) return undefined
  return { mediaType: key, schemaPointer: `${pointer}/content/${escapePointerToken(key)}/schema` }
}
