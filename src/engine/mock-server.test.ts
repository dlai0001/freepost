import { afterEach, describe, expect, it } from 'vitest'
import type { MockRequestLogEntry, RequestFile, SavedExample } from '../shared/model'
import { buildRoutes } from '../core/mock/router'
import { parseSpec } from '../core/spec'
import { buildSpecRoutes } from '../core/spec/mock'
import { MockServer } from './mock-server'

const servers: MockServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()))
})

function track(s: MockServer): MockServer {
  servers.push(s)
  return s
}

function req(method: string, url: string): RequestFile {
  return { kind: 'curl', frontmatter: {}, variables: [], comments: [], http: { method, url, headers: [], options: {} } }
}
function ex(name: string, status: number, body: string, extra: Partial<SavedExample> = {}): SavedExample {
  return {
    name,
    savedAt: '2026-01-01T00:00:00Z',
    request: { method: 'GET', url: 'http://x/', headers: [] },
    response: {
      status,
      statusText: '',
      headers: [{ name: 'Content-Type', value: 'application/json' }],
      bodyText: body,
      timeMs: 1,
      sizeBytes: body.length
    },
    ...extra
  }
}

describe('MockServer', () => {
  it('serves a matched example with its status and body', async () => {
    const routes = buildRoutes([
      { relPath: 'Users.curl', file: req('GET', 'http://${BASE}/users'), examples: [ex('ok', 200, '{"ok":true}')] }
    ])
    const server = track(new MockServer())
    const { port } = await server.start({ routes })
    const res = await fetch(`http://127.0.0.1:${port}/users`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(await res.json()).toEqual({ ok: true })
  })

  it('binds a wildcard path segment and serves the example', async () => {
    const routes = buildRoutes([
      { relPath: 'One.curl', file: req('GET', 'http://${BASE}/users/${id}'), examples: [ex('one', 200, 'hi')] }
    ])
    const server = track(new MockServer())
    const { port } = await server.start({ routes })
    const res = await fetch(`http://127.0.0.1:${port}/users/99`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hi')
  })

  it('falls back to a spec route when no example matches, and examples win when both match', async () => {
    const parsed = parseSpec(
      JSON.stringify({
        openapi: '3.0.0',
        paths: {
          '/users': { get: { responses: { '200': { description: 'ok', content: { 'application/json': { example: { from: 'spec' } } } } } } },
          '/pets/{id}': {
            get: {
              responses: {
                '200': {
                  description: 'ok',
                  headers: { 'X-Kind': { schema: { type: 'string', example: 'pet' } } },
                  content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'integer' } } } } }
                }
              }
            }
          }
        }
      })
    )
    if (!parsed.ok) throw new Error(parsed.error)
    const specRoutes = buildSpecRoutes(parsed.spec, 'specs/x.json')
    const routes = buildRoutes([
      { relPath: 'Users.curl', file: req('GET', 'http://${BASE}/users'), examples: [ex('ok', 200, '{"from":"example"}')] }
    ])
    const log: MockRequestLogEntry[] = []
    const server = track(new MockServer())
    server.on('request', (e) => log.push(e))
    const { port } = await server.start({ routes, specRoutes })

    const fromExample = await fetch(`http://127.0.0.1:${port}/users`)
    expect(await fromExample.json()).toEqual({ from: 'example' })
    expect(log[0]).toMatchObject({ matched: true, source: 'example', exampleName: 'ok' })

    const fromSpec = await fetch(`http://127.0.0.1:${port}/pets/5`)
    expect(fromSpec.status).toBe(200)
    expect(fromSpec.headers.get('content-type')).toBe('application/json')
    expect(fromSpec.headers.get('x-kind')).toBe('pet')
    expect(await fromSpec.json()).toEqual({ id: 0 })
    expect(log[1]).toMatchObject({ matched: true, source: 'spec', operationId: 'GET /pets/{id}', sourcePath: 'specs/x.json' })

    const miss = await fetch(`http://127.0.0.1:${port}/nope`)
    expect(miss.status).toBe(404)
    const body = (await miss.json()) as { availableRoutes: string[] }
    expect(body.availableRoutes).toContain('GET /pets/:id (spec)')
    expect(log[2]).toMatchObject({ matched: false })
  })

  it('returns 404 with available routes for an unmatched path', async () => {
    const routes = buildRoutes([
      { relPath: 'Users.curl', file: req('GET', 'http://${BASE}/users'), examples: [ex('ok', 200, '{}')] }
    ])
    const server = track(new MockServer())
    const { port } = await server.start({ routes })
    const res = await fetch(`http://127.0.0.1:${port}/nope`)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('no matching mock route')
    expect(body.availableRoutes).toContain('GET /users')
  })

  it('selects an example via the ?__example override', async () => {
    const routes = buildRoutes([
      {
        relPath: 'R.curl',
        file: req('GET', 'http://${BASE}/r'),
        examples: [ex('ok', 200, 'good'), ex('bad', 500, 'boom')]
      }
    ])
    const server = track(new MockServer())
    const { port } = await server.start({ routes })
    const res = await fetch(`http://127.0.0.1:${port}/r?__example=bad`)
    expect(res.status).toBe(500)
    expect(await res.text()).toBe('boom')
  })

  it('emits a request log entry per request', async () => {
    const routes = buildRoutes([
      { relPath: 'R.curl', file: req('GET', 'http://${BASE}/r'), examples: [ex('ok', 200, 'x')] }
    ])
    const server = track(new MockServer())
    const seen: string[] = []
    server.on('request', (e) => seen.push(`${e.method} ${e.path} ${e.status} ${e.matched}`))
    const { port } = await server.start({ routes })
    await fetch(`http://127.0.0.1:${port}/r`)
    await fetch(`http://127.0.0.1:${port}/missing`)
    expect(seen).toContain('GET /r 200 true')
    expect(seen).toContain('GET /missing 404 false')
  })

  it('stop() releases the port (subsequent requests fail)', async () => {
    const routes = buildRoutes([
      { relPath: 'R.curl', file: req('GET', 'http://${BASE}/r'), examples: [ex('ok', 200, 'x')] }
    ])
    const server = new MockServer()
    const { port } = await server.start({ routes })
    await server.stop()
    expect(server.state).toBe('stopped')
    await expect(fetch(`http://127.0.0.1:${port}/r`)).rejects.toThrow()
  })
})
