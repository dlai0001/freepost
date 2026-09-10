import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeRequestFile } from '../core/format'
import type { RequestFile, SavedExample } from '../shared/model'
import { buildMockTables, buildRoutesForCollection } from './mock'

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'freepost-mock-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeReq(rel: string, method: string, url: string): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  const file: RequestFile = {
    kind: 'curl',
    frontmatter: {},
    variables: [],
    comments: [],
    http: { method, url, headers: [], options: {} }
  }
  writeFileSync(abs, writeRequestFile(file))
}

function writeExamples(rel: string, examples: SavedExample[]): void {
  writeFileSync(join(root, rel), JSON.stringify(examples, null, 2))
}

const ex = (name: string, status: number): SavedExample => ({
  name,
  savedAt: '2026-01-01T00:00:00Z',
  request: { method: 'GET', url: 'http://x/', headers: [] },
  response: { status, statusText: '', headers: [], bodyText: '{}', timeMs: 1, sizeBytes: 2 }
})

describe('buildRoutesForCollection', () => {
  it('builds routes only for .curl files that have examples', async () => {
    writeReq('Users.curl', 'GET', 'http://${BASE}/users')
    writeExamples('Users.examples.json', [ex('ok', 200)])
    writeReq('NoExamples.curl', 'GET', 'http://${BASE}/none') // no sidecar
    const routes = await buildRoutesForCollection(root)
    expect(routes.map((r) => r.sourcePath)).toEqual(['Users.curl'])
    expect(routes[0].method).toBe('GET')
    expect(routes[0].examples).toHaveLength(1)
  })

  it('handles nested folders and multiple methods', async () => {
    writeReq('api/List.curl', 'GET', 'http://${BASE}/api/items')
    writeExamples('api/List.examples.json', [ex('list', 200)])
    writeReq('api/Create.curl', 'POST', 'http://${BASE}/api/items')
    writeExamples('api/Create.examples.json', [ex('created', 201)])
    const routes = await buildRoutesForCollection(root)
    const shapes = routes.map((r) => `${r.method} ${r.sourcePath}`).sort()
    expect(shapes).toEqual(['GET api/List.curl', 'POST api/Create.curl'])
  })
})

describe('buildMockTables', () => {
  const spec = JSON.stringify({
    openapi: '3.0.0',
    paths: {
      '/pets': { get: { responses: { '200': { description: 'ok', content: { 'application/json': { example: [] } } } } } },
      '/pets/{id}': { get: { responses: { '200': { description: 'ok' } } } }
    }
  })

  function writeSpecReq(rel: string, url: string, specPath: string): void {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    const file: RequestFile = {
      kind: 'curl',
      frontmatter: { spec: { path: specPath, operationId: 'GET /pets' } },
      variables: [],
      comments: [],
      http: { method: 'GET', url, headers: [], options: {} }
    }
    writeFileSync(abs, writeRequestFile(file))
  }

  it('collects distinct attached specs into fallback routes, ignoring missing ones', async () => {
    mkdirSync(join(root, 'specs'))
    writeFileSync(join(root, 'specs', 'pets.json'), spec)
    writeSpecReq('A.curl', 'http://${BASE}/pets', 'specs/pets.json')
    writeSpecReq('B.curl', 'http://${BASE}/pets/1', 'specs/pets.json') // same spec, counted once
    writeSpecReq('C.curl', 'http://${BASE}/x', 'specs/gone.json') // missing spec: no routes, no throw
    writeReq('Users.curl', 'GET', 'http://${BASE}/users')
    writeExamples('Users.examples.json', [ex('ok', 200)])

    const { routes, specRoutes } = await buildMockTables(root)
    expect(routes.map((r) => r.sourcePath)).toEqual(['Users.curl'])
    expect(specRoutes.map((r) => r.operationId).sort()).toEqual(['GET /pets', 'GET /pets/{id}'])
    expect(specRoutes.every((r) => r.specPath === 'specs/pets.json')).toBe(true)
  })

  it('yields no spec routes when nothing is attached', async () => {
    writeReq('Plain.curl', 'GET', 'http://${BASE}/plain')
    expect((await buildMockTables(root)).specRoutes).toEqual([])
  })
})
