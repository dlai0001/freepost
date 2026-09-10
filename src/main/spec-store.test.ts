import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scanCollection } from './collection'
import { importSpecFile, importSpecText, isStoredSpec, listSpecs, readSpec, validateResponseAgainstSpec } from './spec-store'

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'freepost-spec-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const specJson = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'pets', version: '1' },
  paths: {
    '/pets/{id}': {
      get: {
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } } }
          }
        }
      }
    }
  }
})
const specYaml = `openapi: 3.0.0\ninfo: {title: y, version: '1'}\npaths:\n  /x:\n    get:\n      responses:\n        '200': {description: ok}\n`

describe('importSpecText / importSpecFile', () => {
  it('stores under specs/ with a content-derived extension and lists operations', async () => {
    const r = await importSpecText(root, specJson, 'Pet Store.yaml')
    expect(r.path).toBe('specs/Pet Store.json')
    expect(r.version).toBe('OpenAPI 3.0.0')
    expect(r.operations.map((o) => o.id)).toEqual(['GET /pets/{id}'])
    expect(readFileSync(join(root, r.path), 'utf8')).toBe(specJson)

    const y = await importSpecText(root, specYaml, 'thing.json')
    expect(y.path).toBe('specs/thing.yaml')
  })

  it('never overwrites: same name gets a numbered suffix', async () => {
    await importSpecText(root, specJson, 'api')
    const second = await importSpecText(root, specYaml, 'api')
    expect(second.path).toBe('specs/api.yaml')
    const third = await importSpecText(root, specJson, 'api')
    expect(third.path).toBe('specs/api (2).json')
    expect((await listSpecs(root)).sort()).toEqual(['specs/api (2).json', 'specs/api.json', 'specs/api.yaml'])
  })

  it('rejects documents that are not specs', async () => {
    await expect(importSpecText(root, '{"hello":1}', 'x')).rejects.toThrow(/openapi/i)
  })

  it('imports from a file elsewhere on disk, named after its basename', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'freepost-spec-src-'))
    writeFileSync(join(elsewhere, 'petstore.json'), specJson)
    const r = await importSpecFile(root, join(elsewhere, 'petstore.json'))
    expect(r.path).toBe('specs/petstore.json')
    expect(isStoredSpec(root, 'specs/petstore.json')).toBe(true)
    expect(isStoredSpec(root, 'specs/nope.json')).toBe(false)
    expect(isStoredSpec(root, '../etc/passwd')).toBe(false)
    rmSync(elsewhere, { recursive: true, force: true })
  })
})

describe('readSpec', () => {
  it('parses, caches by mtime, and re-reads after a change', async () => {
    const { path } = await importSpecText(root, specJson, 'pets')
    const a = await readSpec(root, path)
    if (!a.ok) throw new Error(a.error)
    const b = await readSpec(root, path)
    if (!b.ok) throw new Error(b.error)
    expect(b.spec).toBe(a.spec) // same object => cache hit

    writeFileSync(join(root, path), specYaml)
    const later = new Date(Date.now() + 5000)
    utimesSync(join(root, path), later, later)
    const c = await readSpec(root, path)
    if (!c.ok) throw new Error(c.error)
    expect(c.spec).not.toBe(a.spec)
    expect(Object.keys(c.spec.doc.paths ?? {})).toEqual(['/x'])
  })

  it('reports missing files and path escapes without throwing', async () => {
    expect(await readSpec(root, 'specs/missing.json')).toMatchObject({ ok: false, error: expect.stringContaining('not found') })
    expect(await readSpec(root, '../outside.json')).toMatchObject({ ok: false, error: expect.stringContaining('escapes') })
    writeFileSync(join(root, 'bad.json'), '{"nope":true}')
    expect(await readSpec(root, 'bad.json')).toMatchObject({ ok: false, error: expect.stringContaining('bad.json') })
  })
})

describe('validateResponseAgainstSpec', () => {
  const resp = (status: number, body: string) => ({
    status,
    statusText: '',
    headers: [{ name: 'content-type', value: 'application/json' }],
    bodyText: body,
    timeMs: 1,
    sizeBytes: body.length
  })

  it('validates through the stored spec', async () => {
    const { path } = await importSpecText(root, specJson, 'pets')
    const ref = { path, operationId: 'GET /pets/{id}' }
    expect((await validateResponseAgainstSpec(root, ref, resp(200, '{"id":1}'))).verdict).toBe('match')
    const bad = await validateResponseAgainstSpec(root, ref, resp(200, '{"id":"x"}'))
    expect(bad.verdict).toBe('mismatch')
    expect(bad.errors[0].instancePath).toBe('/id')
  })

  it('turns a missing spec or malformed ref into an error verdict', async () => {
    const missing = await validateResponseAgainstSpec(root, { path: 'specs/gone.json', operationId: 'GET /x' }, resp(200, '{}'))
    expect(missing).toMatchObject({ verdict: 'error', reason: expect.stringContaining('not found') })
    const malformed = await validateResponseAgainstSpec(root, { path: 'specs/x.json' }, resp(200, '{}'))
    expect(malformed).toMatchObject({ verdict: 'error', reason: expect.stringContaining('malformed') })
    const notObj = await validateResponseAgainstSpec(root, 'specs/x.json', resp(200, '{}'))
    expect(notObj.verdict).toBe('error')
  })
})

describe('scanCollection', () => {
  it('hides the top-level specs/ folder but not a nested one', async () => {
    await importSpecText(root, specJson, 'pets')
    mkdirSync(join(root, 'api', 'specs'), { recursive: true })
    writeFileSync(join(root, 'api', 'Get.curl'), 'curl http://x/\n')
    const tree = await scanCollection(root)
    expect(tree.children?.map((c) => c.name)).toEqual(['api'])
    const api = tree.children?.[0]
    expect(api?.children?.map((c) => c.name)).toEqual(['specs', 'Get'])
  })
})
