import { describe, expect, it } from 'vitest'
import { matchRoute } from '../mock/router'
import { parseSpec, type ParsedSpec } from './index'
import { buildSpecRoutes } from './mock'

function parse(doc: unknown): ParsedSpec {
  const r = parseSpec(JSON.stringify(doc))
  if (!r.ok) throw new Error(r.error)
  return r.spec
}

const spec = parse({
  openapi: '3.0.0',
  servers: [{ url: 'https://api.example.com/v1' }],
  components: { schemas: { Pet: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string', example: 'Rex' } } } } },
  paths: {
    '/pets': {
      get: {
        responses: {
          '200': { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Pet' } } } } }
        }
      },
      post: {
        responses: {
          '400': { description: 'bad' },
          '201': {
            description: 'created',
            headers: { Location: { schema: { type: 'string', example: '/pets/1' } } },
            content: { 'application/json': { example: { id: 7, name: 'New' } } }
          }
        }
      }
    },
    '/pets/{id}': {
      get: { responses: { '200': { description: 'ok', content: { 'text/plain': { schema: { type: 'string' } }, 'application/json': { examples: { one: { value: { id: 1 } } } } } } } },
      delete: { responses: { '204': { description: 'gone' } } },
      patch: { responses: { '2XX': { description: 'any' }, default: { description: 'err' } } }
    },
    '/health': { get: { responses: { default: { description: 'up', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean', default: true } } } } } } } } }
  }
})

describe('buildSpecRoutes', () => {
  const routes = buildSpecRoutes(spec, 'specs/pets.json')

  it('emits each operation with and without the server prefix', () => {
    const shapes = routes.map((r) => r.method + ' /' + r.segments.map((s) => ('literal' in s ? s.literal : `{${s.param}}`)).join('/'))
    expect(shapes).toContain('GET /v1/pets')
    expect(shapes).toContain('GET /pets')
    expect(shapes).toContain('DELETE /v1/pets/{id}')
    expect(shapes).toContain('DELETE /pets/{id}')
  })

  it('sorts literal routes before parameterised ones', () => {
    const firstParam = routes.findIndex((r) => r.segments.some((s) => 'param' in s))
    expect(routes.slice(0, firstParam).every((r) => r.segments.every((s) => 'literal' in s))).toBe(true)
  })

  it('synthesises bodies from schema, example and examples', () => {
    const list = matchRoute(routes, 'GET', '/v1/pets')!.route
    expect(list.status).toBe(200)
    expect(JSON.parse(list.bodyText)).toEqual([{ id: 0, name: 'Rex' }])
    expect(list.headers).toEqual([{ name: 'Content-Type', value: 'application/json' }])

    const created = matchRoute(routes, 'POST', '/pets')!.route
    expect(created.status).toBe(201)
    expect(JSON.parse(created.bodyText)).toEqual({ id: 7, name: 'New' })
    expect(created.headers).toContainEqual({ name: 'Location', value: '/pets/1' })

    const one = matchRoute(routes, 'GET', '/pets/42')!.route
    expect(one.operationId).toBe('GET /pets/{id}')
    expect(JSON.parse(one.bodyText)).toEqual({ id: 1 }) // application/json preferred over text/plain
  })

  it('serves 204 with no body, and maps 2XX / default keys', () => {
    expect(matchRoute(routes, 'DELETE', '/pets/1')!.route).toMatchObject({ status: 204, bodyText: '', headers: [] })
    expect(matchRoute(routes, 'PATCH', '/pets/1')!.route.status).toBe(200)
    const health = matchRoute(routes, 'GET', '/health')!.route
    expect(health.status).toBe(200)
    expect(JSON.parse(health.bodyText)).toEqual({ ok: true })
  })

  it('records the spec path on every route', () => {
    expect(routes.every((r) => r.specPath === 'specs/pets.json')).toBe(true)
  })

  it('handles swagger 2 produces + examples', () => {
    const sw = parse({
      swagger: '2.0',
      basePath: '/api',
      paths: {
        '/a': { get: { produces: ['application/json'], responses: { '200': { description: 'ok', examples: { 'application/json': { a: 1 } } } } } },
        '/b': { get: { responses: { '200': { description: 'ok', schema: { type: 'object', properties: { b: { type: 'string' } } } } } } }
      }
    })
    const r = buildSpecRoutes(sw, 'specs/sw.json')
    expect(JSON.parse(matchRoute(r, 'GET', '/api/a')!.route.bodyText)).toEqual({ a: 1 })
    expect(JSON.parse(matchRoute(r, 'GET', '/b')!.route.bodyText)).toEqual({ b: '' })
    expect(matchRoute(r, 'GET', '/b')!.route.headers[0].value).toBe('application/json')
  })
})
