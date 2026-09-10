import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import {
  documentedStatuses,
  findOperation,
  parseSpec,
  pickMediaType,
  pickResponse,
  specPathPrefix,
  suggestOperation,
  templateSegments,
  type ParsedSpec
} from './index'
import { listOpenApiOperations } from '../importers/openapi'

const oas3 = {
  openapi: '3.0.3',
  info: { title: 't', version: '1' },
  servers: [{ url: 'https://api.example.com/v1' }],
  components: {
    responses: { NotFound: { description: 'nf', content: { 'application/json': { schema: { type: 'object' } } } } }
  },
  paths: {
    '/pets': {
      get: {
        responses: {
          '200': { description: 'ok', content: { 'application/json': { schema: { type: 'array' } } } },
          '2XX': { description: 'other', content: { 'text/plain': { schema: { type: 'string' } } } },
          default: { description: 'err', content: { 'application/problem+json': { schema: { type: 'object' } } } }
        }
      },
      post: { responses: { '201': { description: 'created' } } }
    },
    '/pets/{id}': {
      get: { responses: { '200': { description: 'ok' }, '404': { $ref: '#/components/responses/NotFound' } } },
      delete: { responses: { '204': { description: 'gone' } } }
    },
    '/pets/{id}/photos/{photoId}': { get: { responses: { '200': { description: 'ok' } } } }
  }
}

function parse(doc: unknown, asYaml = false): ParsedSpec {
  const text = asYaml ? yaml.dump(doc) : JSON.stringify(doc)
  const r = parseSpec(text)
  if (!r.ok) throw new Error(r.error)
  return r.spec
}

describe('parseSpec', () => {
  it('classifies versions', () => {
    expect(parse(oas3).version).toBe('OpenAPI 3.0.3')
    expect(parse(oas3).is31).toBe(false)
    expect(parse({ openapi: '3.1.0', paths: {} }).is31).toBe(true)
    const sw = parse({ swagger: '2.0', paths: {} }, true)
    expect(sw.isSwagger2).toBe(true)
    expect(sw.version).toBe('Swagger 2.0')
  })
  it('rejects non-spec documents', () => {
    expect(parseSpec('{"foo":1}').ok).toBe(false)
    expect(parseSpec('- a\n- b').ok).toBe(false)
  })
})

describe('findOperation', () => {
  it('locates by "METHOD path" and builds an escaped pointer', () => {
    const f = findOperation(parse(oas3), 'GET /pets/{id}')
    expect(f?.method).toBe('get')
    expect(f?.pointer).toBe('/paths/~1pets~1{id}/get')
  })
  it('returns undefined for unknown ids', () => {
    const spec = parse(oas3)
    expect(findOperation(spec, 'PUT /pets')).toBeUndefined()
    expect(findOperation(spec, 'GET /nope')).toBeUndefined()
    expect(findOperation(spec, 'garbage')).toBeUndefined()
  })
})

describe('pickResponse', () => {
  const spec = parse(oas3)
  const get = findOperation(spec, 'GET /pets')!
  it('prefers exact, then NXX wildcard, then default', () => {
    expect(pickResponse(get, 200, spec)?.key).toBe('200')
    expect(pickResponse(get, 202, spec)?.key).toBe('2XX')
    expect(pickResponse(get, 500, spec)?.key).toBe('default')
  })
  it('matches wildcards case-insensitively', () => {
    const s = parse({ openapi: '3.0.0', paths: { '/x': { get: { responses: { '4xx': { description: 'c' } } } } } })
    expect(pickResponse(findOperation(s, 'GET /x')!, 418, s)?.key).toBe('4xx')
    expect(pickResponse(findOperation(s, 'GET /x')!, 200, s)).toBeUndefined()
  })
  it('resolves $ref responses and rebases the pointer', () => {
    const r = pickResponse(findOperation(spec, 'GET /pets/{id}')!, 404, spec)
    expect(r?.key).toBe('404')
    expect(r?.pointer).toBe('/components/responses/NotFound')
    expect(r?.response.content?.['application/json']).toBeDefined()
  })
  it('lists documented statuses in order', () => {
    expect(documentedStatuses(get.op)).toEqual(['200', '2XX', 'default'])
  })
})

describe('pickMediaType', () => {
  const spec = parse(oas3)
  const get = findOperation(spec, 'GET /pets')!
  it('strips parameters and matches exactly', () => {
    const r = pickMediaType(pickResponse(get, 200, spec)!, get, 'application/json; charset=utf-8', spec)
    expect(r).toEqual({ mediaType: 'application/json', schemaPointer: '/paths/~1pets/get/responses/200/content/application~1json/schema' })
  })
  it('falls back to application/json, then first key', () => {
    expect(pickMediaType(pickResponse(get, 200, spec)!, get, 'text/html', spec)?.mediaType).toBe('application/json')
    expect(pickMediaType(pickResponse(get, 500, spec)!, get, undefined, spec)?.mediaType).toBe('application/problem+json')
  })
  it('honours wildcard entries', () => {
    const s = parse({ openapi: '3.0.0', paths: { '/x': { get: { responses: { '200': { description: 'c', content: { '*/*': { schema: { type: 'string' } } } } } } } } })
    const op = findOperation(s, 'GET /x')!
    expect(pickMediaType(pickResponse(op, 200, s)!, op, 'image/png', s)?.mediaType).toBe('*/*')
  })
  it('returns undefined when no body is documented', () => {
    expect(pickMediaType(pickResponse(findOperation(spec, 'POST /pets')!, 201, spec)!, get, undefined, spec)).toBeUndefined()
  })
  it('uses swagger 2 produces', () => {
    const s = parse({
      swagger: '2.0',
      produces: ['application/xml'],
      paths: { '/x': { get: { produces: ['application/json', 'text/csv'], responses: { '200': { description: 'c', schema: { type: 'string' } } } } }, '/y': { get: { responses: { '200': { description: 'c', schema: { type: 'string' } } } } } }
    })
    const x = findOperation(s, 'GET /x')!
    expect(pickMediaType(pickResponse(x, 200, s)!, x, 'text/csv', s)).toEqual({ mediaType: 'text/csv', schemaPointer: '/paths/~1x/get/responses/200/schema' })
    expect(pickMediaType(pickResponse(x, 200, s)!, x, undefined, s)?.mediaType).toBe('application/json')
    const y = findOperation(s, 'GET /y')!
    expect(pickMediaType(pickResponse(y, 200, s)!, y, undefined, s)?.mediaType).toBe('application/xml')
  })
})

describe('specPathPrefix / templateSegments', () => {
  it('reads basePath, absolute and relative server urls', () => {
    expect(specPathPrefix(parse(oas3))).toEqual(['v1'])
    expect(specPathPrefix(parse({ swagger: '2.0', basePath: '/api/v2', paths: {} }))).toEqual(['api', 'v2'])
    expect(specPathPrefix(parse({ openapi: '3.0.0', servers: [{ url: '/rel/base' }], paths: {} }))).toEqual(['rel', 'base'])
    expect(specPathPrefix(parse({ openapi: '3.0.0', servers: [{ url: 'https://{env}.x.com/{ver}' }], paths: {} }))).toEqual(['ver'])
    expect(specPathPrefix(parse({ openapi: '3.0.0', paths: {} }))).toEqual([])
  })
  it('splits templates into route segments', () => {
    expect(templateSegments('/pets/{id}/photos/{photoId}')).toEqual([
      { literal: 'pets' },
      { param: 'id' },
      { literal: 'photos' },
      { param: 'photoId' }
    ])
    expect(templateSegments('/files/report.{ext}')).toEqual([{ literal: 'files' }, { param: 'report.ext' }])
  })
})

describe('suggestOperation', () => {
  const ops = (() => {
    const r = listOpenApiOperations(JSON.stringify(oas3))
    if (!r.ok) throw new Error(r.error)
    return r.operations
  })()
  it('matches ${VAR} segments to {param} and prefers the literal route', () => {
    expect(suggestOperation(ops, 'GET', '${BASE_URL}/pets/${id}')).toBe('GET /pets/{id}')
    expect(suggestOperation(ops, 'get', 'https://api.example.com/pets')).toBe('GET /pets')
    expect(suggestOperation(ops, 'DELETE', '${BASE_URL}/pets/42')).toBe('DELETE /pets/{id}')
  })
  it('tolerates the server prefix', () => {
    expect(suggestOperation(ops, 'GET', 'https://api.example.com/v1/pets/1/photos/2', ['v1'])).toBe('GET /pets/{id}/photos/{photoId}')
    expect(suggestOperation(ops, 'GET', 'https://api.example.com/v1/pets/1/photos/2')).toBeUndefined()
  })
  it('rejects method or literal mismatches', () => {
    expect(suggestOperation(ops, 'PUT', '${BASE_URL}/pets')).toBeUndefined()
    expect(suggestOperation(ops, 'GET', '${BASE_URL}/dogs')).toBeUndefined()
  })
})
