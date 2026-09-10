/**
 * `freepost run` with spec-linked requests: the report lines, `--strict-spec`
 * exit codes, and `freepost mock` starting on a spec-only collection.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run, type CliIo } from './index'

let server: Server
let base = ''
let root = ''

function io(): CliIo & { out: () => string } {
  let buf = ''
  return { cwd: root, color: false, write: (s) => (buf += s), out: () => buf }
}

const spec = {
  openapi: '3.0.0',
  info: { title: 'pets', version: '1' },
  servers: [{ url: 'https://api.example.com/v1' }],
  paths: {
    '/pets/{id}': {
      get: {
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: { type: 'object', required: ['id', 'name'], properties: { id: { type: 'integer' }, name: { type: 'string', example: 'Rex' } } }
              }
            }
          }
        }
      }
    }
  }
}

function writeReq(rel: string, path: string): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(
    abs,
    `# ---
# spec:
#   path: specs/pets.json
#   operationId: GET /pets/{id}
# ---
curl --request GET --url 'http://${base}${path}'
`
  )
}

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(req.url === '/pets/1' ? JSON.stringify({ id: 1, name: 'Rex' }) : JSON.stringify({ id: 'x' }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`
  root = mkdtempSync(join(tmpdir(), 'freepost-cli-spec-'))
  mkdirSync(join(root, 'specs'))
  writeFileSync(join(root, 'specs', 'pets.json'), JSON.stringify(spec))
  writeReq('Good.curl', '/pets/1')
  writeReq('Bad.curl', '/pets/2')
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  rmSync(root, { recursive: true, force: true })
})

describe('cli run with attached specs', () => {
  it('prints spec lines and exits 0 on a mismatch by default', async () => {
    const o = io()
    const code = await run(['run', root], o)
    expect(code).toBe(0)
    expect(o.out()).toContain('✓ spec 200 application/json')
    expect(o.out()).toContain('✗ spec 200 application/json — 2 mismatches')
    expect(o.out()).toContain('/id: must be integer')
    expect(o.out()).toContain('missing required property "name"')
  })

  it('--strict-spec fails the mismatching request only', async () => {
    const o = io()
    expect(await run(['run', root, '--strict-spec', '--filter', 'Bad'], o)).toBe(1)
    expect(await run(['run', root, '--strict-spec', '--filter', 'Good'], io())).toBe(0)
  })

  it('the json reporter carries specValidation', async () => {
    const o = io()
    await run(['run', root, '--reporter', 'json', '--filter', 'Bad'], o)
    const reports = JSON.parse(o.out()) as { specValidation?: { verdict: string } }[]
    expect(reports[0].specValidation?.verdict).toBe('mismatch')
  })
})

describe('cli mock with attached specs', () => {
  function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
    const start = Date.now()
    return new Promise((resolve, reject) => {
      const tick = (): void => {
        if (pred()) resolve()
        else if (Date.now() - start > ms) reject(new Error('timeout'))
        else setTimeout(tick, 10)
      }
      tick()
    })
  }

  it('starts with spec routes only and synthesises responses', async () => {
    let buf = ''
    let sigint: () => void = () => undefined
    const o: CliIo = {
      cwd: root,
      color: false,
      write: (s) => (buf += s),
      onSigint: (cb) => {
        sigint = cb
      }
    }
    const done = run(['mock', root], o)
    await waitFor(() => /listening on http:\/\/127\.0\.0\.1:(\d+)/.test(buf))
    expect(buf).toContain('0 example route(s)')
    expect(buf).toContain('spec route(s)')
    const port = Number(buf.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)![1])
    const res = await fetch(`http://127.0.0.1:${port}/v1/pets/7`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 0, name: 'Rex' })
    const bare = await fetch(`http://127.0.0.1:${port}/pets/7`)
    expect(bare.status).toBe(200)
    expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404)
    sigint()
    expect(await done).toBe(0)
    expect(buf).toContain('(spec)')
  })
})
