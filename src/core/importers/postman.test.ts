import { describe, expect, it } from 'vitest'
import {
  convertTemplates,
  importPostmanCollection,
  sanitizePathSegment,
  sanitizeVarName
} from './postman'

/* -------------------------------- fixture -------------------------------- */

const fixture = {
  info: {
    name: 'Acme API',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
  },
  variable: [
    { key: 'baseUrl', value: 'https://api.acme.test' },
    { key: 'api-key', value: 'k-123' }
  ],
  item: [
    {
      name: 'auth',
      item: [
        {
          name: 'Login',
          event: [
            {
              listen: 'prerequest',
              script: { exec: ['pm.variables.set("ts", Date.now());', 'console.log("pre {{baseUrl}}");'] }
            },
            {
              listen: 'test',
              script: { exec: ['pm.test("ok", () => pm.response.to.have.status(200));'] }
            }
          ],
          request: {
            method: 'POST',
            description: 'Logs a user in',
            url: '{{baseUrl}}/login',
            header: [
              { key: 'Content-Type', value: 'application/json' },
              { key: 'X-Debug', value: 'true', disabled: true },
              { key: 'X-Api-Key', value: '{{api-key}}' }
            ],
            body: {
              mode: 'raw',
              raw: '{"user": "{{user.name}}", "password": "{{password}}"}'
            }
          }
        },
        {
          name: 'Who am I',
          request: {
            method: 'GET',
            auth: {
              type: 'bearer',
              bearer: [{ key: 'token', value: '{{token}}', type: 'string' }]
            },
            url: {
              raw: '{{baseUrl}}/me?verbose=1&debug=true&fields=email',
              query: [
                { key: 'verbose', value: '1' },
                { key: 'debug', value: 'true', disabled: true },
                { key: 'fields', value: 'email' }
              ]
            }
          }
        }
      ]
    },
    {
      name: 'gql',
      item: [
        {
          name: 'Get user',
          request: {
            method: 'POST',
            url: '{{baseUrl}}/graphql',
            body: {
              mode: 'graphql',
              graphql: {
                query: 'query User($id: ID!) { user(id: $id) { email } }',
                variables: '{"id": "42"}'
              }
            }
          }
        }
      ]
    },
    {
      name: 'Legacy: search / find',
      item: [
        {
          name: 'Form login',
          request: {
            method: 'POST',
            url: 'https://legacy.acme.test/login',
            auth: {
              type: 'basic',
              basic: [
                { key: 'username', value: '{{user.name}}' },
                { key: 'password', value: '{{password}}' }
              ]
            },
            body: {
              mode: 'urlencoded',
              urlencoded: [
                { key: 'grant_type', value: 'password' },
                { key: 'scope', value: 'all', disabled: true },
                { key: 'client', value: '{{api-key}}' }
              ]
            }
          }
        },
        {
          name: 'Upload avatar',
          request: {
            method: 'POST',
            url: 'https://legacy.acme.test/upload',
            auth: { type: 'apikey' },
            body: {
              mode: 'formdata',
              formdata: [
                { key: 'file', type: 'file' },
                { key: 'note', value: 'hi' }
              ]
            }
          }
        }
      ]
    }
  ]
}

function importFixture() {
  const r = importPostmanCollection(JSON.stringify(fixture))
  if (!r.ok) throw new Error(r.error)
  return r
}

function fileAt(relPath: string) {
  const entry = importFixture().files.find((f) => f.relPath === relPath)
  if (!entry) {
    throw new Error(`no file at ${relPath}; got: ${importFixture().files.map((f) => f.relPath).join(', ')}`)
  }
  return entry.file
}

/* --------------------------------- tests --------------------------------- */

describe('importPostmanCollection: shape and errors', () => {
  it('rejects invalid JSON', () => {
    const r = importPostmanCollection('{oops')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/invalid JSON/)
  })

  it('rejects a document without info', () => {
    const r = importPostmanCollection('{"item": []}')
    expect(r).toEqual({ ok: false, error: 'not a Postman collection: missing "info"' })
  })

  it('rejects a document without an item array', () => {
    const r = importPostmanCollection('{"info": {"name": "x"}}')
    expect(r).toEqual({ ok: false, error: 'not a Postman collection: "item" must be an array' })
  })

  it('maps folder nesting to relPath directories and names to .curl files', () => {
    const r = importFixture()
    expect(r.files.map((f) => f.relPath)).toEqual([
      'auth/Login.curl',
      'auth/Who am I.curl',
      'gql/Get user.curl',
      'Legacy search find/Form login.curl',
      'Legacy search find/Upload avatar.curl'
    ])
    for (const f of r.files) {
      expect(f.file.kind).toBe('curl')
      expect(f.file.comments).toEqual([])
    }
  })

  it('returns an envNote mentioning the collection variable count', () => {
    const r = importFixture()
    expect(r.envNote).toContain('2 variables')
    expect(r.envNote).toMatch(/environment/i)
  })

  it('omits envNote when the collection has no variables', () => {
    const r = importPostmanCollection(JSON.stringify({ info: { name: 'x' }, item: [] }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.envNote).toBeUndefined()
  })
})

describe('request mapping', () => {
  it('maps method, url, headers; disabled headers go to frontmatter.disabled.headers', () => {
    const f = fileAt('auth/Login.curl')
    expect(f.http?.method).toBe('POST')
    expect(f.http?.url).toBe('${baseUrl}/login')
    expect(f.http?.headers).toEqual([
      { name: 'Content-Type', value: 'application/json' },
      { name: 'X-Api-Key', value: '${api_key}' }
    ])
    expect(f.frontmatter.disabled?.headers).toEqual({ 'X-Debug': 'true' })
    expect(f.frontmatter.description).toBe('Logs a user in')
  })

  it('moves disabled query params to frontmatter and keeps enabled ones in the url', () => {
    const f = fileAt('auth/Who am I.curl')
    expect(f.http?.url).toBe('${baseUrl}/me?verbose=1&fields=email')
    expect(f.frontmatter.disabled?.query).toEqual({ debug: 'true' })
  })

  it('maps raw bodies with {{var}} converted (invalid chars sanitized to underscores)', () => {
    const f = fileAt('auth/Login.curl')
    expect(f.http?.body).toEqual({
      kind: 'raw',
      value: '{"user": "${user_name}", "password": "${password}"}'
    })
  })

  it('maps graphql bodies to frontmatter.graphql, parsing the variables JSON string', () => {
    const f = fileAt('gql/Get user.curl')
    expect(f.frontmatter.graphql).toEqual({
      query: 'query User($id: ID!) { user(id: $id) { email } }',
      variables: { id: '42' }
    })
    expect(f.http?.body).toBeUndefined()
  })

  it('converts bearer auth to an Authorization header', () => {
    const f = fileAt('auth/Who am I.curl')
    expect(f.http?.headers).toContainEqual({ name: 'Authorization', value: 'Bearer ${token}' })
  })

  it('converts basic auth to options.user "user:pass"', () => {
    const f = fileAt('Legacy search find/Form login.curl')
    expect(f.http?.options.user).toBe('${user_name}:${password}')
  })

  it('converts urlencoded bodies to raw form bodies plus a Content-Type header, dropping disabled pairs', () => {
    const f = fileAt('Legacy search find/Form login.curl')
    expect(f.http?.body).toEqual({ kind: 'raw', value: 'grant_type=password&client=${api_key}' })
    expect(f.http?.headers).toContainEqual({
      name: 'Content-Type',
      value: 'application/x-www-form-urlencoded'
    })
  })

  it('drops formdata bodies and unsupported auth with an import-note', () => {
    const f = fileAt('Legacy search find/Upload avatar.curl')
    expect(f.http?.body).toBeUndefined()
    const note = f.frontmatter['import-note']
    expect(typeof note).toBe('string')
    expect(note).toMatch(/formdata body \(2 fields\)/)
    expect(note).toMatch(/auth of type "apikey"/)
  })

  it('maps prerequest/test events to frontmatter.scripts, joining exec lines as-is', () => {
    const f = fileAt('auth/Login.curl')
    expect(f.frontmatter.scripts).toEqual({
      // Script source is untouched: pm.* API and even {{...}} literals stay.
      'pre-request': 'pm.variables.set("ts", Date.now());\nconsole.log("pre {{baseUrl}}");',
      test: 'pm.test("ok", () => pm.response.to.have.status(200));'
    })
  })
})

describe('variable declarations', () => {
  it('declares every referenced ${var}, defaulting from collection variables when present', () => {
    const f = fileAt('auth/Login.curl')
    expect(f.variables).toEqual([
      { name: 'baseUrl', required: false, defaultValue: 'https://api.acme.test' },
      { name: 'api_key', required: false, defaultValue: 'k-123' }, // sanitized key matches
      { name: 'user_name', required: false, defaultValue: '' },
      { name: 'password', required: false, defaultValue: '' }
    ])
  })

  it('declares vars referenced via auth and urlencoded bodies', () => {
    const f = fileAt('Legacy search find/Form login.curl')
    expect(f.variables.map((v) => v.name).sort()).toEqual(['api_key', 'password', 'user_name'])
  })

  it('declares vars referenced only in bearer tokens', () => {
    const f = fileAt('auth/Who am I.curl')
    expect(f.variables.map((v) => v.name)).toContain('token')
  })
})

describe('sanitizers', () => {
  it('sanitizePathSegment strips forbidden chars, collapses whitespace, trims trailing dots', () => {
    expect(sanitizePathSegment('Legacy: search / find')).toBe('Legacy search find')
    expect(sanitizePathSegment('a<b>c:d"e/f\\g|h?i*j')).toBe('abcdefghij')
    expect(sanitizePathSegment('  spaced   out  ')).toBe('spaced out')
    expect(sanitizePathSegment('dots... ')).toBe('dots')
    expect(sanitizePathSegment('???')).toBe('untitled')
  })

  it('sanitizeVarName maps invalid chars to underscores consistently and keeps case', () => {
    expect(sanitizeVarName('api-key')).toBe('api_key')
    expect(sanitizeVarName('user.name')).toBe('user_name')
    expect(sanitizeVarName('BaseUrl')).toBe('BaseUrl')
    expect(sanitizeVarName('2fa-code')).toBe('_2fa_code')
  })

  it('convertTemplates rewrites {{name}} to ${name} everywhere in a string', () => {
    expect(convertTemplates('{{a}}/x/{{b-c}}?q={{d.e}}')).toBe('${a}/x/${b_c}?q=${d_e}')
    expect(convertTemplates('no templates')).toBe('no templates')
  })
})
