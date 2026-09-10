import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scanCollection } from './collection'
import {
  deleteSpec,
  importSpecFile,
  importSpecText,
  isStoredSpec,
  listSpecUsage,
  listSpecs,
  readSpec,
  validateResponseAgainstSpec
} from './spec-store'

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

  it('overwrites a spec of the same name in place so attached requests see the edit', async () => {
    const first = await importSpecText(root, specJson, 'api')
    expect(first).toMatchObject({ path: 'specs/api.json', replaced: false })

    // Re-import an edited version of the same document: same path, new bytes.
    const edited = specJson.replace('"integer"', '"string"')
    const second = await importSpecText(root, edited, 'api')
    expect(second).toMatchObject({ path: 'specs/api.json', replaced: true })
    expect(readFileSync(join(root, 'specs/api.json'), 'utf8')).toBe(edited)
    expect(await listSpecs(root)).toEqual(['specs/api.json'])
  })

  it('a re-import is visible to the next readSpec, even within one mtime tick', async () => {
    const { path } = await importSpecText(root, specJson, 'api')
    const before = await readSpec(root, path)
    if (!before.ok) throw new Error(before.error)
    expect(before.spec.doc.paths?.['/pets/{id}']).toBeDefined()

    // Same name and same JSON extension, so it lands on the identical path.
    const rewritten = JSON.stringify({ openapi: '3.0.0', info: { title: 'p', version: '1' }, paths: { '/x': { get: { responses: { '200': { description: 'ok' } } } } } })
    await importSpecText(root, rewritten, 'api')
    const after = await readSpec(root, path)
    if (!after.ok) throw new Error(after.error)
    expect(Object.keys(after.spec.doc.paths ?? {})).toEqual(['/x'])
  })

  it('keeps differently-named specs side by side', async () => {
    await importSpecText(root, specJson, 'api')
    await importSpecText(root, specYaml, 'other')
    expect(await listSpecs(root)).toEqual(['specs/api.json', 'specs/other.yaml'])
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

describe('listSpecUsage / deleteSpec', () => {
  function writeReq(rel: string, specPath?: string): void {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    const fm = specPath === undefined ? '' : `# ---\n# spec:\n#   path: ${specPath}\n#   operationId: GET /pets/{id}\n# ---\n`
    writeFileSync(abs, `${fm}curl --request GET --url 'http://x/'\n`)
  }

  it('lists only the requests pointing at that spec', async () => {
    await importSpecText(root, specJson, 'pets')
    await importSpecText(root, specJson, 'other')
    writeReq('A.curl', 'specs/pets.json')
    writeReq('nested/B.curl', 'specs/pets.json')
    writeReq('C.curl', 'specs/other.json')
    writeReq('D.curl') // no spec at all
    expect(await listSpecUsage(root, 'specs/pets.json')).toEqual(['A.curl', 'nested/B.curl'])
    expect(await listSpecUsage(root, 'specs/other.json')).toEqual(['C.curl'])
    expect(await listSpecUsage(root, 'specs/ghost.json')).toEqual([])
  })

  it('deletes a stored spec and drops it from the cache', async () => {
    const { path } = await importSpecText(root, specJson, 'pets')
    expect((await readSpec(root, path)).ok).toBe(true)
    await deleteSpec(root, path)
    expect(existsSync(join(root, path))).toBe(false)
    expect(await listSpecs(root)).toEqual([])
    // The cached parse must not outlive the file.
    expect(await readSpec(root, path)).toMatchObject({ ok: false, error: expect.stringContaining('not found') })
  })

  it('deleting is idempotent and refuses paths outside specs/', async () => {
    await expect(deleteSpec(root, 'specs/never-existed.json')).resolves.toBeUndefined()
    writeFileSync(join(root, 'keepme.curl'), 'curl http://x/\n')
    await expect(deleteSpec(root, 'keepme.curl')).rejects.toThrow(/not a stored spec/)
    await expect(deleteSpec(root, '../escape.json')).rejects.toThrow(/not a stored spec/)
    expect(existsSync(join(root, 'keepme.curl'))).toBe(true)
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
