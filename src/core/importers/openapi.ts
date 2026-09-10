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
 * generated VariableDecl. Spec parsing/deref/example helpers live in core/spec.
 */

import type {
  Frontmatter,
  Header,
  HttpRequestModel,
  OpenApiOperationSummary,
  RequestFile,
  VariableDecl
} from '@shared/model'
import { sanitizePathSegment, sanitizeVarName } from './postman'
import {
  HTTP_METHODS,
  derefSchema,
  exampleFromMediaType,
  exampleFromSchema,
  operationId,
  parseSpecDoc,
  resolveBaseUrl,
  specVersionLabel,
  type OperationObject,
  type ParameterObject,
  type SchemaObject,
  type SecurityScheme,
  type SpecDoc
} from '../spec'

export type ImportResult =
  | { ok: true; files: { relPath: string; file: RequestFile; operationId: string }[]; note?: string }
  | { ok: false; error: string }

export type ListOpenApiResult =
  | { ok: true; operations: OpenApiOperationSummary[]; version: string }
  | { ok: false; error: string }

const VAR_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

function collectVarRefs(text: string, into: Set<string>): void {
  for (const m of text.matchAll(VAR_REF)) into.add(m[1])
}

/* -------------------------------- helpers -------------------------------- */

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

/** Suffix a candidate relPath with " (2)", " (3)", ... until `isTaken` returns false. */
export function dedupeRelPath(relPath: string, isTaken: (candidate: string) => boolean): string {
  if (!isTaken(relPath)) return relPath
  const ext = relPath.endsWith('.curl') ? '.curl' : ''
  const stem = ext ? relPath.slice(0, -ext.length) : relPath
  let n = 2
  while (isTaken(`${stem} (${n})${ext}`)) n++
  return `${stem} (${n})${ext}`
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

/**
 * Enumerate every operation (path x method) in a spec without converting it —
 * cheap (no schema deref / example synthesis), for previewing a spec before
 * committing to a full import. A structurally valid spec with zero operations
 * returns `ok: true, operations: []` (an empty list is a legitimate display
 * state here, unlike `importOpenApi`'s stricter "nothing to import" error).
 */
export function listOpenApiOperations(text: string): ListOpenApiResult {
  const parsed = parseSpecDoc(text)
  if (!parsed.ok) return parsed
  const { doc, isSwagger2 } = parsed

  const operations: OpenApiOperationSummary[] = []
  for (const [path, pathItem] of Object.entries(doc.paths ?? {})) {
    if (!pathItem || typeof pathItem !== 'object') continue
    for (const method of HTTP_METHODS) {
      const op = (pathItem as Record<string, unknown>)[method] as OperationObject | undefined
      if (!op || typeof op !== 'object') continue
      operations.push({
        id: operationId(method, path),
        method: method.toUpperCase(),
        path,
        summary: op.summary ?? op.description,
        folder: sanitizePathSegment(op.tags?.[0] ?? firstPathSegment(path))
      })
    }
  }

  return { ok: true, operations, version: specVersionLabel(doc, isSwagger2) }
}

/**
 * Import an OpenAPI 3.x or Swagger 2.0 document (JSON or YAML) into in-memory
 * RequestFile models with collection-relative paths. When `opts.selectedIds`
 * is given, only operations whose `${METHOD} ${path}` id is in the set are
 * converted/written; omitted entirely, every operation is imported (existing
 * behavior). Selecting an empty set still yields `ok: true, files: []` as
 * long as the spec itself defines at least one operation. With `opts.specPath`
 * (the collection-relative path the caller stored the spec under) every file
 * gets `frontmatter.spec` pointing at its operation, so responses validate
 * against the spec and the mock server can synthesise from it.
 */
export function importOpenApi(
  text: string,
  opts?: { selectedIds?: Set<string>; specPath?: string }
): ImportResult {
  const parsed = parseSpecDoc(text)
  if (!parsed.ok) return parsed
  const { doc, isSwagger2 } = parsed
  const selectedIds = opts?.selectedIds
  const specPath = opts?.specPath

  doc.__baseUrlDefault = resolveBaseUrl(doc, isSwagger2)

  const securitySchemes: Record<string, SecurityScheme> = isSwagger2
    ? doc.securityDefinitions ?? {}
    : doc.components?.securitySchemes ?? {}
  const globalSecurity = doc.security ?? []

  const files: { relPath: string; file: RequestFile; operationId: string }[] = []
  const usedPaths = new Set<string>()
  let operationCount = 0

  try {
    for (const [path, pathItem] of Object.entries(doc.paths ?? {})) {
      if (!pathItem || typeof pathItem !== 'object') continue
      const inheritedParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : []
      for (const method of HTTP_METHODS) {
        const op = (pathItem as Record<string, unknown>)[method]
        if (!op || typeof op !== 'object') continue
        operationCount++
        const id = operationId(method, path)
        if (selectedIds !== undefined && !selectedIds.has(id)) continue
        const converted = convertOperation(
          method,
          path,
          op as OperationObject,
          inheritedParams,
          { root: doc, isSwagger2, globalSecurity, securitySchemes }
        )
        // De-duplicate collision-prone relPaths (missing operationId, etc.).
        const relPath = dedupeRelPath(converted.relPath, (p) => usedPaths.has(p))
        usedPaths.add(relPath)
        if (specPath !== undefined) converted.file.frontmatter.spec = { path: specPath, operationId: id }
        files.push({ relPath, file: converted.file, operationId: id })
      }
    }
  } catch (e) {
    return { ok: false, error: `failed to convert spec: ${e instanceof Error ? e.message : String(e)}` }
  }

  if (operationCount === 0) {
    return { ok: false, error: 'spec defines no operations under "paths"' }
  }

  const version = specVersionLabel(doc, isSwagger2)
  return {
    ok: true,
    files,
    note: `Imported ${files.length} operation${files.length === 1 ? '' : 's'} from a ${version} document; base URL saved as BASE_URL (default "${doc.__baseUrlDefault}").`
  }
}
