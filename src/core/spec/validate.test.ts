import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import type { HttpResponseModel, SpecRef } from '@shared/model'
import { parseSpec, type ParsedSpec } from './index'
import { prepareSchemaDoc, validateResponse } from './validate'

const ref: SpecRef = { path: 'specs/pets.yaml', operationId: 'GET /pets/{id}' }

function parse(doc: unknown, asYaml = false): ParsedSpec {
  const r = parseSpec(asYaml ? yaml.dump(doc) : JSON.stringify(doc))
  if (!r.ok) throw new Error(r.error)
  return r.spec
}

function resp(status: number, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }): HttpResponseModel {
  const bodyText = typeof body === 'string' ? body : body === undefined ? '' : JSON.stringify(body)
  return {
    status,
    statusText: '',
    headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
    bodyText,
    timeMs: 1,
    sizeBytes: bodyText.length
  }
}

function run(spec: ParsedSpec, response: HttpResponseModel, operationId = ref.operationId) {
  return validateResponse({ spec, specRef: { ...ref, operationId }, operationId, response })
}

const pet = {
  type: 'object',
  required: ['id', 'name'],
  additionalProperties: false,
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    tag: { type: 'string', nullable: true },
    status: { type: 'string', enum: ['available', 'sold'] },
    born: { type: 'string', format: 'date-time' },
    owner: { $ref: '#/components/schemas/Owner' }
  },
  discriminator: { propertyName: 'kind' },
  xml: { name: 'pet' },
  example: { id: 1, name: 'x' }
}

const oas30 = {
  openapi: '3.0.3',
  info: { title: 't', version: '1' },
  components: {
    schemas: {
      Pet: pet,
      Owner: { allOf: [{ type: 'object', properties: { email: { type: 'string', format: 'email' } } }, { required: ['email'] }] },
      Error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'integer' }, message: { type: 'string' } } }
    }
  },
  paths: {
    '/pets/{id}': {
      get: {
        responses: {
          '200': {
            description: 'ok',
            headers: { 'X-Request-Id': { required: true, schema: { type: 'string' } }, 'X-Count': { schema: { type: 'integer' } } },
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } }
          },
          '404': { description: 'nf', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '204': { description: 'empty' },
          '302': { description: 'html', content: { 'text/html': { schema: { type: 'string' } } } }
        }
      }
    },
    '/pets': { get: { responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Pet' } } } } } } } },
    '/broken': { get: { responses: { '200': { description: 'x', content: { 'application/json': { schema: { $ref: 'other.yaml#/Thing' } } } } } } }
  }
}

const good = { id: 1, name: 'Rex', tag: null, status: 'sold', born: '2020-01-01T00:00:00Z', owner: { email: 'a@b.co' } }
const okHeaders = { 'content-type': 'application/json', 'x-request-id': 'abc', 'x-count': '3' }

describe('validateResponse (OpenAPI 3.0)', () => {
  const spec = parse(oas30, true)

  it('matches a conforming body and headers', () => {
    const r = run(spec, resp(200, good, okHeaders))
    expect(r.verdict).toBe('match')
    expect(r.matchedResponse).toEqual({ status: '200', mediaType: 'application/json' })
    expect(r.errors).toEqual([])
    expect(r.specVersion).toBe('OpenAPI 3.0.3')
  })

  it('reports typed errors with JSON pointers', () => {
    const r = run(spec, resp(200, { id: 'one', tag: 5, status: 'lost', born: 'yesterday', extra: 1, owner: {} }, okHeaders))
    expect(r.verdict).toBe('mismatch')
    const byPath = Object.fromEntries(r.errors.map((e) => [`${e.keyword}${e.instancePath}`, e]))
    expect(byPath['type/id'].message).toBe('must be integer')
    expect(byPath['required'].params?.missingProperty).toBe('name')
    expect(byPath['required'].message).toBe('missing required property "name"')
    expect(byPath['additionalProperties'].params?.additionalProperty).toBe('extra')
    expect(byPath['enum/status'].message).toContain('"available"')
    expect(byPath['format/born'].keyword).toBe('format')
    expect(byPath['type/tag']).toBeDefined() // nullable widened to [string, null]; 5 is neither
    expect(byPath['required/owner'].params?.missingProperty).toBe('email') // allOf enforced, unlike the importer's shallow merge
    expect(r.errors.every((e) => e.target === 'body')).toBe(true)
  })

  it('checks declared headers: required-missing and type coercion', () => {
    const r = run(spec, resp(200, good, { 'content-type': 'application/json', 'x-count': 'lots' }))
    expect(r.verdict).toBe('mismatch')
    expect(r.errors).toEqual([
      expect.objectContaining({ target: 'header', instancePath: 'x-request-id', keyword: 'required' }),
      expect.objectContaining({ target: 'header', instancePath: 'x-count', keyword: 'type' })
    ])
  })

  it('finds the closest documented response when the matched one fails', () => {
    const r = run(spec, resp(200, { code: 404, message: 'nope' }, okHeaders))
    expect(r.verdict).toBe('mismatch')
    expect(r.closestMatch?.response).toEqual({ status: '404', mediaType: 'application/json' })
    expect(r.closestMatch?.errors).toEqual([])
  })

  it('omits closestMatch when nothing is closer', () => {
    const r = run(spec, resp(200, { id: 'x', name: 'y' }, okHeaders))
    expect(r.verdict).toBe('mismatch')
    expect(r.closestMatch).toBeUndefined()
  })

  it('flags undocumented statuses and still offers the closest body', () => {
    const r = run(spec, resp(418, { code: 1, message: 'm' }))
    expect(r.verdict).toBe('undocumented-status')
    expect(r.documentedStatuses).toEqual(['200', '204', '302', '404']) // JS integer-key order
    expect(r.closestMatch?.response.status).toBe('404')
    expect(r.matchedResponse).toBeUndefined()
  })

  it('treats an empty body as matching a response without content', () => {
    expect(run(spec, resp(204, undefined, {})).verdict).toBe('match')
  })

  it('flags an empty body where a schema is documented', () => {
    const r = run(spec, resp(200, undefined, okHeaders))
    expect(r.verdict).toBe('mismatch')
    expect(r.errors[0]).toMatchObject({ target: 'body', instancePath: '', keyword: 'body' })
  })

  it('skips non-JSON media types and non-JSON bodies', () => {
    expect(run(spec, resp(302, '<html/>', { 'content-type': 'text/html' }))).toMatchObject({ verdict: 'skipped', reason: expect.stringContaining('text/html') })
    expect(run(spec, resp(200, '{not json', okHeaders))).toMatchObject({ verdict: 'skipped', reason: expect.stringContaining('not valid JSON') })
  })

  it('errors (does not throw) on unknown operations and unresolvable $refs', () => {
    expect(run(spec, resp(200, good), 'GET /nope')).toMatchObject({ verdict: 'error', reason: expect.stringContaining('not found') })
    expect(run(spec, resp(200, {}), 'GET /broken')).toMatchObject({ verdict: 'error', reason: expect.stringContaining('schema compile failed') })
  })

  it('validates array items with indexed pointers', () => {
    const r = run(spec, resp(200, [good, { id: 2 }]), 'GET /pets')
    expect(r.verdict).toBe('mismatch')
    expect(r.errors.map((e) => e.instancePath)).toEqual(['/1'])
  })

  it('prepareSchemaDoc drops annotation keywords and widens nullable', () => {
    const p = prepareSchemaDoc(spec) as { components: { schemas: { Pet: Record<string, unknown> } } }
    const s = p.components.schemas.Pet
    expect(s.discriminator).toBeUndefined()
    expect(s.xml).toBeUndefined()
    expect(s.example).toBeUndefined()
    expect((s.properties as Record<string, Record<string, unknown>>).tag).toEqual({ type: ['string', 'null'] })
  })
})

describe('validateResponse (Swagger 2.0)', () => {
  const spec = parse({
    swagger: '2.0',
    info: { title: 't', version: '1' },
    produces: ['application/json'],
    definitions: {
      Item: { type: 'object', required: ['n'], properties: { n: { type: 'number', minimum: 0, exclusiveMinimum: true }, f: { type: 'file' } } }
    },
    paths: {
      '/items/{id}': {
        get: {
          responses: {
            '200': { description: 'ok', schema: { $ref: '#/definitions/Item' }, headers: { 'X-Rate': { type: 'integer', required: true } } }
          }
        }
      }
    }
  })
  const id = 'GET /items/{id}'

  it('matches and reports the produces media type', () => {
    const r = run(spec, resp(200, { n: 1 }, { 'content-type': 'application/json', 'x-rate': '10' }), id)
    expect(r).toMatchObject({ verdict: 'match', matchedResponse: { status: '200', mediaType: 'application/json' }, specVersion: 'Swagger 2.0' })
  })

  it('converts draft-04 boolean exclusiveMinimum', () => {
    const r = run(spec, resp(200, { n: 0 }, { 'content-type': 'application/json', 'x-rate': '10' }), id)
    expect(r.verdict).toBe('mismatch')
    expect(r.errors[0]).toMatchObject({ instancePath: '/n', keyword: 'exclusiveMinimum' })
  })

  it('validates inline swagger 2 header types', () => {
    const r = run(spec, resp(200, { n: 1 }, { 'content-type': 'application/json', 'x-rate': 'fast' }), id)
    expect(r.errors).toEqual([expect.objectContaining({ target: 'header', instancePath: 'x-rate', keyword: 'type' })])
  })
})

describe('validateResponse (OpenAPI 3.1)', () => {
  const spec = parse({
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
    paths: {
      '/x': {
        get: {
          responses: {
            '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/$defs/X' } } } }
          }
        }
      }
    },
    $defs: { X: { type: 'object', properties: { v: { type: ['string', 'null'] }, n: { type: 'integer', exclusiveMinimum: 0 } } } }
  })
  it('accepts type arrays, 2020-12 keywords and $defs', () => {
    expect(run(spec, resp(200, { v: null, n: 1 }), 'GET /x').verdict).toBe('match')
    const r = run(spec, resp(200, { v: 3, n: 0 }), 'GET /x')
    expect(r.errors.map((e) => `${e.keyword}${e.instancePath}`).sort()).toEqual(['exclusiveMinimum/n', 'type/v'])
  })
})

describe('OpenAPI 3.0 nullable on composed schemas', () => {
  // `nullable: true` carries no `type` of its own when the types come from a
  // composition keyword, a $ref, or an enum — widening `type` is not enough.
  const spec = parse({
    openapi: '3.0.3',
    info: { title: 't', version: '1' },
    components: {
      schemas: {
        Cat: { type: 'object', required: ['meow'], properties: { meow: { type: 'boolean' } } },
        Dog: { type: 'object', required: ['woof'], properties: { woof: { type: 'boolean' } } }
      }
    },
    paths: {
      '/x': {
        get: {
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      any: { nullable: true, anyOf: [{ $ref: '#/components/schemas/Cat' }, { $ref: '#/components/schemas/Dog' }] },
                      one: { nullable: true, oneOf: [{ type: 'string' }, { type: 'integer' }] },
                      all: { nullable: true, allOf: [{ $ref: '#/components/schemas/Cat' }] },
                      ref: { nullable: true, $ref: '#/components/schemas/Cat' },
                      choice: { nullable: true, type: 'string', enum: ['a', 'b'] },
                      plain: { nullable: true, type: 'integer' }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  })
  const run3 = (body: unknown) => run(spec, resp(200, body), 'GET /x')

  it('accepts null for anyOf / oneOf / allOf / $ref / enum / plain', () => {
    const r = run3({ any: null, one: null, all: null, ref: null, choice: null, plain: null })
    expect(r.errors).toEqual([])
    expect(r.verdict).toBe('match')
  })

  it('still accepts legitimate non-null values', () => {
    const r = run3({ any: { meow: true }, one: 'x', all: { meow: false }, ref: { meow: true }, choice: 'b', plain: 7 })
    expect(r.errors).toEqual([])
  })

  it('still rejects values that match neither null nor the schema', () => {
    const paths = run3({ any: { oink: true }, one: true, choice: 'z', plain: 'nope' }).errors.map((e) => e.instancePath)
    for (const p of ['/any', '/one', '/choice', '/plain']) expect(paths).toContain(p)
  })

  it('keeps the plain-type error message specific (no anyOf wrapping)', () => {
    const err = run3({ plain: 'nope' }).errors.find((e) => e.instancePath === '/plain')
    expect(err?.keyword).toBe('type')
    expect(err?.message).toBe('must be integer,null')
  })
})
