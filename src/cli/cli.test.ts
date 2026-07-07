import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { run, type CliIo } from './index'

let server: Server
let base = ''
let root = ''

function io(): CliIo & { out: () => string } {
  let buf = ''
  return { cwd: root, color: false, write: (s) => (buf += s), out: () => buf }
}

function writeReq(rel: string, body: string): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, body)
}

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    } else {
      res.writeHead(404)
      res.end('nope')
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`
  root = mkdtempSync(join(tmpdir(), 'freepost-cli-'))

  writeReq(
    'Passing.curl',
    `# ---
# scripts:
#   test: |
#     pm.test("status 200", () => pm.expect(pm.response.code).to.equal(200));
# ---
curl --request GET --url 'http://${base}/ok'
`
  )
  writeReq(
    'Failing.curl',
    `# ---
# scripts:
#   test: |
#     pm.test("is 200", () => pm.expect(pm.response.code).to.equal(200));
# ---
curl --request GET --url 'http://${base}/missing'
`
  )
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  rmSync(root, { recursive: true, force: true })
})

describe('cli run', () => {
  it('exits 0 when a filtered passing request passes its tests', async () => {
    const o = io()
    const code = await run(['run', root, '--filter', 'Passing'], o)
    expect(code).toBe(0)
    expect(o.out()).toContain('✓ Passing.curl')
    expect(o.out()).toContain('1 run, 1 assertions, 0 failed')
  })

  it('exits 1 and reports the failure for a failing request', async () => {
    const o = io()
    const code = await run(['run', root, '--filter', 'Failing'], o)
    expect(code).toBe(1)
    expect(o.out()).toContain('✗ Failing.curl')
    expect(o.out()).toContain('1 failed')
  })

  it('runs the whole collection (both requests) by default', async () => {
    const o = io()
    const code = await run(['run', root], o)
    expect(code).toBe(1) // one of the two fails
    expect(o.out()).toContain('2 run, 2 assertions, 1 failed')
  })

  it('--bail stops at the first failure', async () => {
    const o = io()
    // Failing.curl sorts before Passing.curl, so bail should stop after it.
    await run(['run', root, '--bail'], o)
    expect(o.out()).toContain('Failing.curl')
    expect(o.out()).not.toContain('Passing.curl')
  })

  it('--reporter json emits a JSON array of reports', async () => {
    const o = io()
    await run(['run', root, '--filter', 'Passing', '--reporter', 'json'], o)
    const parsed = JSON.parse(o.out()) as Array<{ requestPath: string; errored: boolean }>
    expect(parsed).toHaveLength(1)
    expect(parsed[0].requestPath).toBe('Passing.curl')
    expect(parsed[0].errored).toBe(false)
  })

  it('prints help and exits 0', async () => {
    const o = io()
    const code = await run(['--help'], o)
    expect(code).toBe(0)
    expect(o.out()).toContain('Usage: freepost run')
  })

  it('errors on an unknown option', async () => {
    const o = io()
    const code = await run(['run', root, '--nope'], o)
    expect(code).toBe(2)
    expect(o.out()).toContain('Unknown option: --nope')
  })
})
