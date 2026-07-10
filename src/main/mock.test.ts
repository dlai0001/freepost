import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeRequestFile } from '../core/format'
import type { RequestFile, SavedExample } from '../shared/model'
import { buildRoutesForCollection } from './mock'

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
