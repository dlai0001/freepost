import { describe, expect, it } from 'vitest'
import type { RequestFile, SavedExample } from '../../shared/model'
import { buildRoutes, matchRoute, pathToSegments, pickExample } from './router'

function req(method: string, url: string): RequestFile {
  return { kind: 'curl', frontmatter: {}, variables: [], comments: [], http: { method, url, headers: [], options: {} } }
}

function ex(name: string, status: number, extra: Partial<SavedExample> = {}): SavedExample {
  return {
    name,
    savedAt: '2026-01-01T00:00:00Z',
    request: { method: 'GET', url: 'http://x/', headers: [] },
    response: { status, statusText: '', headers: [], bodyText: `body-${name}`, timeMs: 1, sizeBytes: 1 },
    ...extra
  }
}

describe('pathToSegments', () => {
  it('extracts literal segments from a full URL', () => {
    expect(pathToSegments('https://api.example.com/api/users')).toEqual([
      { literal: 'api' },
      { literal: 'users' }
    ])
  })
  it('treats ${VAR} path segments as wildcards named after the variable', () => {
    expect(pathToSegments('http://${BASE_URL}/users/${id}')).toEqual([
      { literal: 'users' },
      { param: 'id' }
    ])
  })
  it('ignores the query string', () => {
    expect(pathToSegments('http://h/search?q=1')).toEqual([{ literal: 'search' }])
  })
  it('drops :- defaults from param names', () => {
    expect(pathToSegments('http://h/x/${id:-1}')).toEqual([{ literal: 'x' }, { param: 'id' }])
  })
})

describe('buildRoutes', () => {
  it('skips files without http or without examples', () => {
    const routes = buildRoutes([
      { relPath: 'A.curl', file: req('GET', 'http://h/a'), examples: [] },
      { relPath: 'B.ws', file: { kind: 'websocat', frontmatter: {}, variables: [], comments: [] }, examples: [ex('x', 200)] },
      { relPath: 'C.curl', file: req('GET', 'http://h/c'), examples: [ex('x', 200)] }
    ])
    expect(routes.map((r) => r.sourcePath)).toEqual(['C.curl'])
  })
  it('orders literal routes before wildcard routes of the same length', () => {
    const routes = buildRoutes([
      { relPath: 'W.curl', file: req('GET', 'http://h/users/${id}'), examples: [ex('w', 200)] },
      { relPath: 'L.curl', file: req('GET', 'http://h/users/me'), examples: [ex('l', 200)] }
    ])
    expect(routes[0].sourcePath).toBe('L.curl')
  })
})

describe('matchRoute', () => {
  const routes = buildRoutes([
    { relPath: 'List.curl', file: req('GET', 'http://h/users'), examples: [ex('l', 200)] },
    { relPath: 'Me.curl', file: req('GET', 'http://h/users/me'), examples: [ex('m', 200)] },
    { relPath: 'One.curl', file: req('GET', 'http://h/users/${id}'), examples: [ex('o', 200)] },
    { relPath: 'Create.curl', file: req('POST', 'http://h/users'), examples: [ex('c', 201)] }
  ])

  it('matches an exact literal path and method', () => {
    const m = matchRoute(routes, 'GET', '/users')
    expect(m?.route.sourcePath).toBe('List.curl')
  })
  it('distinguishes by method', () => {
    expect(matchRoute(routes, 'POST', '/users')?.route.sourcePath).toBe('Create.curl')
  })
  it('prefers a literal segment over a wildcard at the same shape', () => {
    expect(matchRoute(routes, 'GET', '/users/me')?.route.sourcePath).toBe('Me.curl')
  })
  it('binds a wildcard param', () => {
    const m = matchRoute(routes, 'GET', '/users/42')
    expect(m?.route.sourcePath).toBe('One.curl')
    expect(m?.params).toEqual({ id: '42' })
  })
  it('returns null on no match (wrong length)', () => {
    expect(matchRoute(routes, 'GET', '/users/42/posts')).toBeNull()
  })
  it('is case-insensitive on method', () => {
    expect(matchRoute(routes, 'get', '/users')?.route.sourcePath).toBe('List.curl')
  })
})

describe('pickExample', () => {
  const route = buildRoutes([
    {
      relPath: 'R.curl',
      file: req('GET', 'http://h/r'),
      examples: [ex('ok', 200), ex('missing', 404, { active: true })]
    }
  ])[0]

  it('serves the active example by default', () => {
    expect(pickExample(route)?.name).toBe('missing')
  })
  it('honors the ?__example query override', () => {
    expect(pickExample(route, { query: new URLSearchParams('__example=ok') })?.name).toBe('ok')
  })
  it('honors the X-Freepost-Mock-Example header override', () => {
    expect(pickExample(route, { headers: { 'x-freepost-mock-example': 'ok' } })?.name).toBe('ok')
  })
  it('falls back to first-in-file-order when none is active', () => {
    const r = buildRoutes([
      { relPath: 'R.curl', file: req('GET', 'http://h/r'), examples: [ex('first', 200), ex('second', 201)] }
    ])[0]
    expect(pickExample(r)?.name).toBe('first')
  })
  it('ignores an override that names no existing example', () => {
    expect(pickExample(route, { query: new URLSearchParams('__example=nope') })?.name).toBe('missing')
  })
})
