import { describe, expect, it } from 'vitest'
import yaml from 'js-yaml'
import { importOpenApi } from './openapi'
import type { RequestFile } from '@shared/model'

/* -------------------------- OpenAPI 3.0 fixture -------------------------- */

const openapi3 = {
  openapi: '3.0.3',
  info: { title: 'Acme API', version: '1.0.0' },
  servers: [{ url: 'https://api.acme.test/v1' }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer' }
    }
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/users/{id}': {
      get: {
        operationId: 'getUser',
        tags: ['users'],
        summary: 'Fetch a user by id',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'expand', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'verbose', in: 'query', required: false, schema: { type: 'boolean' } },
          { name: 'X-Trace', in: 'header', schema: { type: 'string' } }
        ]
      }
    },
    '/orders': {
      post: {
        operationId: 'createOrder',
        tags: ['orders'],
        description: 'Create an order',
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { sku: { type: 'string' }, qty: { type: 'integer' } } },
              example: { sku: 'ABC', qty: 2 }
            }
          }
        }
      }
    }
  }
}

function byName(files: { relPath: string; file: RequestFile }[], needle: string) {
  const hit = files.find((f) => f.relPath.includes(needle))
  if (!hit) throw new Error(`no file matching ${needle}; got ${files.map((f) => f.relPath).join(', ')}`)
  return hit
}

describe('importOpenApi — OpenAPI 3.0', () => {
  const res = importOpenApi(JSON.stringify(openapi3))
  if (!res.ok) throw new Error(res.error)

  it('creates one file per operation', () => {
    expect(res.files).toHaveLength(2)
  })

  it('groups into folders by first tag', () => {
    expect(byName(res.files, 'getUser').relPath).toBe('users/getUser.curl')
    expect(byName(res.files, 'createOrder').relPath).toBe('orders/createOrder.curl')
  })

  it('templatizes path params {id} => ${id} against BASE_URL', () => {
    const u = byName(res.files, 'getUser').file.http!
    expect(u.url).toContain('${BASE_URL}/users/${id}')
  })

  it('puts required query in the url and optional query in disabled.query', () => {
    const f = byName(res.files, 'getUser').file
    expect(f.http!.url).toContain('expand=${EXPAND}')
    expect(f.http!.url).not.toContain('verbose=')
    expect(f.frontmatter.disabled?.query).toEqual({ verbose: '${VERBOSE}' })
  })

  it('maps header params to ${VAR} headers', () => {
    const h = byName(res.files, 'getUser').file.http!.headers
    expect(h).toContainEqual({ name: 'X-Trace', value: '${X_TRACE}' })
  })

  it('generates a JSON body from the example plus a content-type header', () => {
    const f = byName(res.files, 'createOrder').file
    expect(f.http!.body?.kind).toBe('raw')
    expect(JSON.parse(f.http!.body!.value)).toEqual({ sku: 'ABC', qty: 2 })
    expect(f.http!.headers).toContainEqual({ name: 'Content-Type', value: 'application/json' })
  })

  it('adds bearer Authorization header and a TOKEN variable', () => {
    const f = byName(res.files, 'getUser').file
    expect(f.http!.headers).toContainEqual({ name: 'Authorization', value: 'Bearer ${TOKEN}' })
    expect(f.variables.find((v) => v.name === 'TOKEN')).toBeDefined()
  })

  it('declares BASE_URL with the server default', () => {
    const base = byName(res.files, 'getUser').file.variables.find((v) => v.name === 'BASE_URL')
    expect(base).toEqual({ name: 'BASE_URL', required: false, defaultValue: 'https://api.acme.test/v1' })
  })

  it('declares every referenced variable', () => {
    const names = byName(res.files, 'getUser').file.variables.map((v) => v.name).sort()
    expect(names).toEqual(['BASE_URL', 'EXPAND', 'TOKEN', 'VERBOSE', 'X_TRACE', 'id'].sort())
  })
})

/* -------------------------- Swagger 2.0 fixture -------------------------- */

const swagger2 = {
  swagger: '2.0',
  info: { title: 'Legacy API', version: '1.0' },
  host: 'legacy.acme.test',
  basePath: '/api',
  schemes: ['https'],
  paths: {
    '/widgets': {
      post: {
        operationId: 'createWidget',
        tags: ['widgets'],
        parameters: [
          {
            name: 'body',
            in: 'body',
            required: true,
            schema: { type: 'object', properties: { name: { type: 'string' }, count: { type: 'integer' } } }
          }
        ]
      }
    }
  }
}

describe('importOpenApi — Swagger 2.0', () => {
  const res = importOpenApi(JSON.stringify(swagger2))
  if (!res.ok) throw new Error(res.error)

  it('composes the base url from scheme/host/basePath', () => {
    const base = res.files[0].file.variables.find((v) => v.name === 'BASE_URL')
    expect(base?.defaultValue).toBe('https://legacy.acme.test/api')
  })

  it('builds the url from BASE_URL + path', () => {
    expect(res.files[0].file.http!.url).toBe('${BASE_URL}/widgets')
  })

  it('generates a JSON body from a body parameter schema', () => {
    const f = res.files[0].file
    expect(JSON.parse(f.http!.body!.value)).toEqual({ name: '', count: 0 })
    expect(f.http!.headers).toContainEqual({ name: 'Content-Type', value: 'application/json' })
  })
})

/* ------------------------------ YAML smoke ------------------------------- */

describe('importOpenApi — YAML input', () => {
  it('parses YAML and yields the same file count as JSON', () => {
    const asYaml = yaml.dump(openapi3)
    const res = importOpenApi(asYaml)
    if (!res.ok) throw new Error(res.error)
    expect(res.files).toHaveLength(2)
    expect(res.files.map((f) => f.relPath).sort()).toEqual(
      ['orders/createOrder.curl', 'users/getUser.curl'].sort()
    )
  })
})

/* ------------------------------ validation ------------------------------- */

describe('importOpenApi — validation', () => {
  it('rejects a non-object root', () => {
    expect(importOpenApi('42')).toEqual({ ok: false, error: expect.any(String) })
  })

  it('rejects unparseable input', () => {
    const res = importOpenApi('{ this is: not valid ::: json or yaml [')
    expect(res.ok).toBe(false)
  })

  it('rejects a document without a version marker', () => {
    const res = importOpenApi(JSON.stringify({ paths: {} }))
    expect(res.ok).toBe(false)
  })

  it('rejects a document without paths', () => {
    const res = importOpenApi(JSON.stringify({ openapi: '3.0.0' }))
    expect(res.ok).toBe(false)
  })
})
