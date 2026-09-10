/**
 * Mock-server fallback routes synthesised from an OpenAPI/Swagger document:
 * one route per operation, served when no saved example matches. Pure — the
 * main process reads the spec file and the engine serves the result.
 */
import type { Header } from '@shared/model'
import { paramCount, type RouteSegment } from '../mock/router'
import {
  HTTP_METHODS,
  allResponses,
  exampleFromMediaType,
  exampleFromSchema,
  findOperation,
  isJsonMediaType,
  operationId,
  specPathPrefix,
  templateSegments,
  type ParsedSpec,
  type PickedResponse,
  type ResponseObject
} from './index'

/** A matchable route synthesised from one spec operation. */
export interface SpecRoute {
  method: string
  segments: RouteSegment[]
  /** Collection-relative path of the spec file. */
  specPath: string
  operationId: string
  status: number
  headers: Header[]
  bodyText: string
}

/** Documented success response to serve: 200/201/202/204 → first 2XX → default → first. */
function pickMockResponse(responses: PickedResponse[]): PickedResponse | undefined {
  if (responses.length === 0) return undefined
  for (const want of ['200', '201', '202', '204']) {
    const r = responses.find((x) => x.key === want)
    if (r !== undefined) return r
  }
  return (
    responses.find((x) => /^2(XX|\d\d)$/i.test(x.key)) ??
    responses.find((x) => x.key === 'default') ??
    responses[0]
  )
}

function statusFromKey(key: string): number {
  const n = Number(key)
  if (Number.isInteger(n) && n >= 100 && n <= 599) return n
  const wild = key.match(/^(\d)XX$/i)
  if (wild !== null) return Number(wild[1]) * 100
  return 200
}

/** Body + content type for a response: prefer JSON media types, then the first. */
function synthesiseBody(
  response: ResponseObject,
  produces: string[],
  spec: ParsedSpec
): { mediaType?: string; bodyText: string } {
  if (spec.isSwagger2) {
    const mediaType = produces.find((p) => isJsonMediaType(p)) ?? produces[0] ?? 'application/json'
    const example = response.examples?.[mediaType] ?? Object.values(response.examples ?? {})[0]
    const value = example !== undefined ? example : response.schema ? exampleFromSchema(response.schema, spec.doc) : undefined
    if (value === undefined) return { bodyText: '' }
    return { mediaType, bodyText: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }
  }
  const content = response.content ?? {}
  const keys = Object.keys(content)
  if (keys.length === 0) return { bodyText: '' }
  const mediaType = keys.find((k) => k.toLowerCase() === 'application/json') ?? keys.find((k) => isJsonMediaType(k)) ?? keys[0]
  const value = exampleFromMediaType(content[mediaType], spec.doc)
  if (value === undefined) return { mediaType, bodyText: '' }
  return { mediaType, bodyText: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }
}

function routeShape(route: SpecRoute): string {
  return route.method + ' ' + route.segments.map((s) => ('literal' in s ? s.literal : '{}')).join('/')
}

/**
 * Build fallback routes for every operation in the spec. Each operation is
 * emitted under the server's path prefix and (when there is one) bare, so both
 * `/v1/pets` and `/pets` hit. Sorted most-specific-first like example routes.
 */
export function buildSpecRoutes(spec: ParsedSpec, specPath: string): SpecRoute[] {
  const prefix = specPathPrefix(spec).map((literal) => ({ literal }))
  const routes: SpecRoute[] = []
  const seen = new Set<string>()
  for (const [path, pathItem] of Object.entries(spec.doc.paths ?? {})) {
    if (!pathItem || typeof pathItem !== 'object') continue
    for (const method of HTTP_METHODS) {
      const id = operationId(method, path)
      const found = findOperation(spec, id)
      if (found === undefined) continue
      const picked = pickMockResponse(allResponses(found, spec))
      const status = picked === undefined ? 200 : statusFromKey(picked.key)
      const headers: Header[] = []
      let bodyText = ''
      if (picked !== undefined) {
        const produces = found.op.produces ?? spec.doc.produces ?? []
        const body = synthesiseBody(picked.response, produces, spec)
        bodyText = body.bodyText
        if (body.mediaType !== undefined && bodyText !== '') headers.push({ name: 'Content-Type', value: body.mediaType })
        for (const [name, h] of Object.entries(picked.response.headers ?? {})) {
          if (!h || typeof h !== 'object') continue
          const v = h.example ?? h.default ?? h.schema?.example ?? h.schema?.default
          if (v !== undefined && name.toLowerCase() !== 'content-type') headers.push({ name, value: String(v) })
        }
      }
      const shapes: RouteSegment[][] = [
        ...(prefix.length > 0 ? [[...prefix, ...templateSegments(path)]] : []),
        templateSegments(path)
      ]
      for (const segments of shapes) {
        const route: SpecRoute = { method: method.toUpperCase(), segments, specPath, operationId: id, status, headers, bodyText }
        const shape = routeShape(route)
        if (seen.has(shape)) continue
        seen.add(shape)
        routes.push(route)
      }
    }
  }
  routes.sort((a, b) => paramCount(a) - paramCount(b))
  return routes
}
