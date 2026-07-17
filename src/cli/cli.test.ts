import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createNetServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import Aedes from 'aedes'
import mqtt from 'mqtt'
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
    expect(o.out()).toContain('freepost proxy <collection> --target <url>')
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

describe('cli proxy', () => {
  function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
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

  /** Drive `freepost proxy` to a listening port, then hand back a stopper. */
  async function startProxy(
    dir: string,
    args: string[]
  ): Promise<{ port: number; out: () => string; stop: () => Promise<number> }> {
    let buf = ''
    let sigint: () => void = () => undefined
    const done = run(['proxy', dir, ...args], {
      cwd: dir,
      color: false,
      write: (s) => (buf += s),
      onSigint: (cb) => {
        sigint = cb
      }
    })
    await waitFor(() => /listening on http:\/\/127\.0\.0\.1:(\d+)/.test(buf))
    return {
      port: Number(buf.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)![1]),
      out: () => buf,
      stop: () => {
        sigint()
        return done
      }
    }
  }

  it('forwards to the target and records the exchange into the collection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'freepost-cli-proxy-'))
    // Port 0: the suite must never fight the app's default 7699 for a port.
    const proxy = await startProxy(dir, ['--target', `http://${base}`, '--port', '0'])

    const res = await fetch(`http://127.0.0.1:${proxy.port}/ok`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    const file = join(dir, '.freepost', 'history', 'recorded.jsonl')
    await waitFor(() => existsSync(file))
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    const entry = JSON.parse(lines[0]) as { url: string; status: number; protocol: string }
    expect(entry.url).toBe(`http://${base}/ok`)
    expect(entry.status).toBe(200)
    expect(entry.protocol).toBe('rest')

    // The live log names the exchange, like `freepost mock` does.
    expect(proxy.out()).toContain(`✓ GET http://${base}/ok`)
    expect(proxy.out()).toContain('→ rest 200')

    expect(await proxy.stop()).toBe(0)
    expect(proxy.out()).toContain('Recording proxy stopped')
    // Stopping frees the port.
    await expect(fetch(`http://127.0.0.1:${proxy.port}/ok`)).rejects.toThrow()
    rmSync(dir, { recursive: true, force: true })
  })

  it('errors out (exit 2) without a --target', async () => {
    let buf = ''
    const code = await run(['proxy', root], { cwd: root, color: false, write: (s) => (buf += s) })
    expect(code).toBe(2)
    expect(buf).toContain('Missing --target')
  })

  it('exits 2 on a target that is not an http(s) URL, rather than throwing', async () => {
    let buf = ''
    const code = await run(['proxy', root, '--target', 'ftp://nope', '--port', '0'], {
      cwd: root,
      color: false,
      write: (s) => (buf += s)
    })
    expect(code).toBe(2)
    expect(buf).toContain('http:// or https://')
  })

  it('rejects an out-of-range --port', async () => {
    let buf = ''
    const code = await run(['proxy', root, '--target', `http://${base}`, '--port', '99999'], {
      cwd: root,
      color: false,
      write: (s) => (buf += s)
    })
    expect(code).toBe(2)
    expect(buf).toContain('--port must be 0-65535')
  })

  it('serves TLS with a generated CA and prints the curl hint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'freepost-cli-proxy-tls-'))
    const proxy = await startProxy(dir, [
      '--target',
      `http://${base}`,
      '--port',
      '0',
      '--https',
      '--https-port',
      '0'
    ])
    const httpsPort = Number(proxy.out().match(/https:\/\/127\.0\.0\.1:(\d+)/)![1])
    const caPath = join(dir, '.freepost', 'tls', 'ca.crt')
    expect(existsSync(caPath)).toBe(true)
    expect(proxy.out()).toContain(`curl --cacert '${caPath}'`)

    const ca = readFileSync(caPath, 'utf8')
    const body = await new Promise<string>((resolve, reject) => {
      const req = httpsRequest(`https://127.0.0.1:${httpsPort}/ok`, { ca }, (res) => {
        let out = ''
        res.on('data', (c) => (out += c))
        res.on('end', () => resolve(out))
      })
      req.on('error', reject)
      req.end()
    })
    expect(JSON.parse(body)).toEqual({ ok: true })

    await proxy.stop()
    rmSync(dir, { recursive: true, force: true })
  }, 30000)

  it('relays MQTT on its own port and records the session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'freepost-cli-proxy-mqtt-'))
    const aedes = new Aedes()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const brokerServer = createNetServer(aedes.handle as any)
    await new Promise<void>((r) => brokerServer.listen(0, '127.0.0.1', r))
    const brokerPort = (brokerServer.address() as AddressInfo).port

    const proxy = await startProxy(dir, [
      '--target',
      `http://${base}`,
      '--port',
      '0',
      '--mqtt-target',
      `mqtt://127.0.0.1:${brokerPort}`,
      '--mqtt-port',
      '0'
    ])
    const mqttPort = Number(proxy.out().match(/MQTT relay listening on mqtt:\/\/127\.0\.0\.1:(\d+)/)![1])

    const client = mqtt.connect(`mqtt://127.0.0.1:${mqttPort}`, {
      reconnectPeriod: 0,
      clientId: 'cli-client'
    })
    await new Promise<void>((resolve, reject) => {
      client.on('error', reject)
      client.on('connect', () => resolve())
    })
    await new Promise<void>((resolve, reject) => {
      client.publish('freepost/cli', 'hi', { qos: 1 }, (e) => (e ? reject(e) : resolve()))
    })
    await new Promise<void>((resolve) => client.end(false, {}, () => resolve()))

    // Both listeners log through the same reporter, into the same file.
    await waitFor(() => proxy.out().includes('MQTT mqtt://127.0.0.1:'))
    expect(proxy.out()).toContain('cli-client · freepost/cli')
    expect(await proxy.stop()).toBe(0)

    const recorded = readFileSync(join(dir, '.freepost', 'history', 'recorded.jsonl'), 'utf8')
    expect(recorded).toContain('"protocol":"mqtt"')
    expect(recorded).toContain('freepost/cli')

    await new Promise<void>((r) => brokerServer.close(() => r()))
    await new Promise<void>((r) => aedes.close(() => r()))
    rmSync(dir, { recursive: true, force: true })
  }, 30000)

  it('rejects a bad --mqtt-port without starting anything', async () => {
    let buf = ''
    const code = await run(['proxy', root, '--target', `http://${base}`, '--mqtt-port', '99999'], {
      cwd: root,
      color: false,
      write: (s) => (buf += s)
    })
    expect(code).toBe(2)
    expect(buf).toContain('--mqtt-port must be 0-65535')
  })

  it('exits 2 on a TLS broker rather than relaying it cleartext', async () => {
    let buf = ''
    const code = await run(
      ['proxy', root, '--target', `http://${base}`, '--port', '0', '--mqtt-target', 'mqtts://x:8883'],
      { cwd: root, color: false, write: (s) => (buf += s) }
    )
    expect(code).toBe(2)
    expect(buf).toContain('mqtts')
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
