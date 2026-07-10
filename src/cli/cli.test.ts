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
    expect(o.out()).toContain('freepost run <collection>')
    expect(o.out()).toContain('freepost mock <collection>')
  })

  it('errors on an unknown option', async () => {
    const o = io()
    const code = await run(['run', root, '--nope'], o)
    expect(code).toBe(2)
    expect(o.out()).toContain('Unknown option: --nope')
  })
})

describe('cli mock', () => {
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

  it('serves saved examples over HTTP and stops on SIGINT', async () => {
    writeReq('Mock.curl', `curl --request GET --url 'http://${base}/anything'\n`)
    writeFileSync(
      join(root, 'Mock.examples.json'),
      JSON.stringify([
        {
          name: 'ok',
          savedAt: '2026-01-01T00:00:00Z',
          request: { method: 'GET', url: 'http://x/', headers: [] },
          response: {
            status: 200,
            statusText: 'OK',
            headers: [{ name: 'Content-Type', value: 'application/json' }],
            bodyText: '{"mock":true}',
            timeMs: 1,
            sizeBytes: 13
          }
        }
      ])
    )
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
    const port = Number(buf.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)![1])
    const res = await fetch(`http://127.0.0.1:${port}/anything`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ mock: true })
    sigint()
    const code = await done
    expect(code).toBe(0)
    expect(buf).toContain('Mock server stopped')
  })

  it('exits 2 when the collection has no examples', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'freepost-mock-empty-'))
    let buf = ''
    const code = await run(['mock', empty], { cwd: empty, color: false, write: (s) => (buf += s) })
    expect(code).toBe(2)
    expect(buf).toContain('No routes')
    rmSync(empty, { recursive: true, force: true })
  })
})

describe('cli run: multi-protocol skipping', () => {
  it('skips MQTT subscribe and websocket files with a per-kind note', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'freepost-cli-skip-'))
    writeFileSync(join(dir, 'Live.ws'), "websocat 'wss://example.com/s'\n")
    writeFileSync(join(dir, 'Watch.mqtt'), "mosquitto_sub -h 'localhost' -t 'sensors/#'\n")
    let buf = ''
    const code = await run(['run', dir], { cwd: dir, color: false, write: (s) => (buf += s) })
    expect(code).toBe(0) // nothing runnable, nothing failed
    expect(buf).toContain('1 websocket')
    expect(buf).toContain('1 MQTT subscribe')
    rmSync(dir, { recursive: true, force: true })
  })
})
