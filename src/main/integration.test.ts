import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeRequestFile } from '../core/format'
import { serializeConfig } from '../core/config'
import type { CollectionConfig, RequestFile } from '../shared/model'
import { executeRequest } from './execute'
import { resolveConfigChain } from './config-resolve'

let server: Server
let baseUrl = ''
let root = ''
let lastHeaders: Record<string, string | string[] | undefined> = {}

beforeAll(async () => {
  server = createServer((req, res) => {
    lastHeaders = req.headers
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true, path: req.url }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no address')
  baseUrl = `127.0.0.1:${addr.port}`
  root = mkdtempSync(join(tmpdir(), 'freepost-int-'))
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(root, { recursive: true, force: true })
})

function writeReq(rel: string, file: RequestFile): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, writeRequestFile(file))
}
function writeConfig(rel: string, cfg: CollectionConfig): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, serializeConfig(cfg))
}

const simpleGet = (): RequestFile => ({
  kind: 'curl',
  frontmatter: {},
  variables: [{ name: 'BASE_URL', defaultValue: baseUrl, required: false }],
  http: { method: 'GET', url: 'http://${BASE_URL}/x', headers: [], options: {} },
  comments: []
})

describe('collection/folder config integration', () => {
  it('merges collection + folder default headers into the request', async () => {
    writeConfig('collection.json', {
      defaultHeaders: [
        { name: 'X-From-Collection', value: 'c' },
        { name: 'X-Override', value: 'collection' }
      ]
    })
    writeConfig('svc/folder.json', {
      defaultHeaders: [{ name: 'X-Override', value: 'folder' }]
    })
    writeReq('svc/Ping.curl', simpleGet())
    const report = await executeRequest({ root, path: 'svc/Ping.curl', session: new Map() })
    expect(report.errored).toBe(false)
    expect(lastHeaders['x-from-collection']).toBe('c')
    // Folder header overrides the collection one of the same name.
    expect(lastHeaders['x-override']).toBe('folder')
  })

  it("request's own header wins over inherited default headers", async () => {
    writeConfig('collection.json', {
      defaultHeaders: [{ name: 'X-Override', value: 'collection' }]
    })
    const req = simpleGet()
    req.http!.headers = [{ name: 'X-Override', value: 'request' }]
    writeReq('Owned.curl', req)
    const report = await executeRequest({ root, path: 'Owned.curl', session: new Map() })
    expect(report.errored).toBe(false)
    expect(lastHeaders['x-override']).toBe('request')
  })

  it('runs collection pre-request scripts before the request (session flows in)', async () => {
    writeConfig('collection.json', {
      scripts: { 'pre-request': 'pm.variables.set("INJECTED", "yes");' }
    })
    const req = simpleGet()
    req.variables.push({ name: 'INJECTED', required: false, defaultValue: '' })
    req.http!.headers = [{ name: 'X-Injected', value: '${INJECTED}' }]
    writeReq('WithScript.curl', req)
    const report = await executeRequest({ root, path: 'WithScript.curl', session: new Map() })
    expect(report.errored).toBe(false)
    expect(lastHeaders['x-injected']).toBe('yes')
  })

  it('runs collection + folder test scripts and aggregates their results', async () => {
    writeConfig('collection.json', {
      scripts: { test: 'pm.test("collection test", () => pm.response.to.have.status(200));' }
    })
    writeReq('Tested.curl', {
      ...simpleGet(),
      frontmatter: { scripts: { test: 'pm.test("request test", () => pm.expect(true).to.be.true);' } }
    })
    const report = await executeRequest({ root, path: 'Tested.curl', session: new Map() })
    expect(report.errored).toBe(false)
    const names = report.testScript?.tests.map((t) => t.name) ?? []
    expect(names).toContain('request test')
    expect(names).toContain('collection test')
  })
})

describe('resolveConfigChain', () => {
  it('surfaces invalid config as a warning without throwing', async () => {
    mkdirSync(join(root, 'bad'), { recursive: true })
    writeFileSync(join(root, 'bad', 'folder.json'), '{"defaultHeaders": "nope"}')
    const { warnings } = await resolveConfigChain(root, 'bad/req.curl')
    expect(warnings.length).toBeGreaterThanOrEqual(1)
  })
})
