/**
 * executeRequest + frontmatter.spec: the validation report rides on the
 * ExecutionReport, and only `strictSpec` lets it fail the run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeRequestFile } from '../core/format'
import type { RequestFile } from '../shared/model'
import { executeRequest } from './execute'

let server: Server
let baseUrl = ''
let root = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/pets/1') return void res.end(JSON.stringify({ id: 1, name: 'Rex' }))
    if (req.url === '/pets/bad') return void res.end(JSON.stringify({ id: 'one' }))
    if (req.url === '/pets/teapot') {
      res.statusCode = 418
      return void res.end('{}')
    }
    res.statusCode = 404
    res.end(JSON.stringify({ code: 404, message: 'no such pet' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
  root = mkdtempSync(join(tmpdir(), 'freepost-exec-spec-'))
  mkdirSync(join(root, 'specs'))
  writeFileSync(
    join(root, 'specs', 'pets.json'),
    JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'pets', version: '1' },
      paths: {
        '/pets/{id}': {
          get: {
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: { type: 'object', required: ['id', 'name'], properties: { id: { type: 'integer' }, name: { type: 'string' } } }
                  }
                }
              },
              '404': {
                description: 'nf',
                content: { 'application/json': { schema: { type: 'object', required: ['code', 'message'] } } }
              }
            }
          }
        }
      }
    })
  )
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(root, { recursive: true, force: true })
})

function writeReq(rel: string, path: string, spec?: RequestFile['frontmatter']['spec']): void {
  const file: RequestFile = {
    kind: 'curl',
    frontmatter: spec === undefined ? {} : { spec },
    variables: [],
    comments: [],
    http: { method: 'GET', url: `${baseUrl}${path}`, headers: [], options: {} }
  }
  writeFileSync(join(root, rel), writeRequestFile(file))
}

const ref = { path: 'specs/pets.json', operationId: 'GET /pets/{id}' }

describe('executeRequest spec validation', () => {
  it('attaches a match report without touching errored', async () => {
    writeReq('Good.curl', '/pets/1', ref)
    const r = await executeRequest({ root, path: 'Good.curl', session: new Map() })
    expect(r.errored).toBe(false)
    expect(r.specValidation).toMatchObject({ verdict: 'match', matchedResponse: { status: '200', mediaType: 'application/json' } })
  })

  it('reports mismatches but leaves errored false by default', async () => {
    writeReq('Bad.curl', '/pets/bad', ref)
    const r = await executeRequest({ root, path: 'Bad.curl', session: new Map() })
    expect(r.errored).toBe(false)
    expect(r.specValidation?.verdict).toBe('mismatch')
    expect(r.specValidation?.errors.map((e) => `${e.keyword}${e.instancePath}`).sort()).toEqual(['required', 'type/id'])
  })

  it('strictSpec turns mismatch and undocumented status into failures', async () => {
    writeReq('Bad.curl', '/pets/bad', ref)
    expect((await executeRequest({ root, path: 'Bad.curl', session: new Map(), strictSpec: true })).errored).toBe(true)
    writeReq('Teapot.curl', '/pets/teapot', ref)
    const t = await executeRequest({ root, path: 'Teapot.curl', session: new Map(), strictSpec: true })
    expect(t.specValidation?.verdict).toBe('undocumented-status')
    expect(t.errored).toBe(true)
    writeReq('Good.curl', '/pets/1', ref)
    expect((await executeRequest({ root, path: 'Good.curl', session: new Map(), strictSpec: true })).errored).toBe(false)
  })

  it('a documented 4xx still validates (errored comes from the status, not the spec)', async () => {
    writeReq('Missing.curl', '/pets/999', ref)
    const r = await executeRequest({ root, path: 'Missing.curl', session: new Map() })
    expect(r.errored).toBe(true)
    expect(r.specValidation).toMatchObject({ verdict: 'match', matchedResponse: { status: '404' } })
  })

  it('a missing spec file yields an error verdict, not a failed run', async () => {
    writeReq('Orphan.curl', '/pets/1', { path: 'specs/gone.yaml', operationId: 'GET /pets/{id}' })
    const r = await executeRequest({ root, path: 'Orphan.curl', session: new Map() })
    expect(r.errored).toBe(false)
    expect(r.specValidation).toMatchObject({ verdict: 'error', reason: expect.stringContaining('not found') })
  })

  it('does nothing without frontmatter.spec', async () => {
    writeReq('Plain.curl', '/pets/1')
    const r = await executeRequest({ root, path: 'Plain.curl', session: new Map() })
    expect(r.specValidation).toBeUndefined()
  })
})
