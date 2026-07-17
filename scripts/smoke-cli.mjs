#!/usr/bin/env node
/**
 * Smoke-test the BUILT CLI (out/cli/index.mjs) against real servers.
 *
 * This exists because the unit suite imports the TypeScript source, so it can't
 * see bundling faults. A browser-vs-node resolution slip once left `.grpc` and
 * `.mqtt` silently broken in the shipped CLI — the bundle built fine and only
 * died at runtime — and nothing caught it. Anything that only breaks *after*
 * bundling has to be caught here.
 *
 * Run: npm run build:cli && npm run smoke:cli
 */
import { spawn, spawnSync } from 'node:child_process'
import { request as httpsRequest } from 'node:https'
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import mqtt from 'mqtt'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLI = join(ROOT, 'out/cli/index.mjs')
const DIR = join(ROOT, '.tmp-smoke-cli')

if (!existsSync(CLI)) {
  console.error(`[smoke] ${CLI} not found — run "npm run build:cli" first.`)
  process.exit(1)
}

/** Collection with one request per bundling-sensitive protocol. */
function writeCollection() {
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(DIR, { recursive: true })
  copyFileSync(join(ROOT, 'fixtures/servers/greeter.proto'), join(DIR, 'greeter.proto'))

  writeFileSync(
    join(DIR, 'Health.curl'),
    `#!/usr/bin/env bash
# ---
# scripts:
#   test: |-
#     pm.test("http ok", () => pm.expect(pm.response.json().ok).to.equal(true));
# ---

curl --request GET \\
  --url 'http://localhost:3010/health'
`
  )

  // gRPC: protobufjs reaches fs through a dynamic require, which yields null
  // when bundled into ESM. This request dies on `null.readFileSync` if so.
  writeFileSync(
    join(DIR, 'Hello.grpc'),
    `#!/usr/bin/env bash
# ---
# scripts:
#   test: |-
#     pm.test("grpc greets", () => pm.expect(pm.response.json().message).to.equal("Hello dave"));
# ---

grpcurl \\
  -plaintext \\
  -proto 'greeter.proto' \\
  -d '{"name":"dave"}' \\
  'localhost:50051' \\
  'helloworld.Greeter/SayHello'
`
  )

  // MQTT: mqtt.js has a browser build that stubs `net` via @jspm/core. This
  // request fails with "net module is not supported" if that build is bundled.
  writeFileSync(
    join(DIR, 'Publish.mqtt'),
    `#!/usr/bin/env bash
# ---
# scripts:
#   test: |-
#     pm.test("mqtt published", () => pm.expect(pm.response.json().published).to.equal(true));
# ---

mosquitto_pub \\
  -h 'localhost' \\
  -p 1883 \\
  -t 'freepost/smoke' \\
  -m 'hello'
`
  )
}

/** Start a fixture server and resolve once it prints its ready line. */
function startServer(file, readyMarker) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'fixtures/servers', file)], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const timer = setTimeout(() => reject(new Error(`${file} did not start within 20s`)), 20_000)
    child.stdout.on('data', (b) => {
      if (b.toString().includes(readyMarker)) {
        clearTimeout(timer)
        resolve(child)
      }
    })
    child.stderr.on('data', (b) => process.stderr.write(`[${file}] ${b}`))
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`${file} exited early with code ${code}`))
    })
  })
}

/**
 * Drive the built CLI's `mcp serve` as a real MCP client would: launch it as a
 * subprocess, speak JSON-RPC over its stdio, and use the tools.
 *
 * This is the check that the MCP server survives bundling — and that nothing
 * printed a stray byte to stdout, which is invisible in the source tests
 * (they never touch a pipe) but corrupts the protocol for a real client.
 */
async function smokeMcpServe() {
  const client = new Client({ name: 'smoke', version: '1.0.0' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp', 'serve', DIR],
    stderr: 'pipe'
  })
  await client.connect(transport)
  try {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    const required = ['list_collection', 'write_request', 'run_request', 'get_format_spec']
    const missing = required.filter((r) => !names.includes(r))
    if (missing.length > 0) throw new Error(`tools missing from the built CLI: ${missing.join(', ')}`)

    const listed = await client.callTool({ name: 'list_collection', arguments: {} })
    if (!listed.content[0].text.includes('Health.curl')) {
      throw new Error('list_collection did not see the collection')
    }

    const read = await client.callTool({ name: 'read_request', arguments: { path: 'Health.curl' } })
    if (!read.content[0].text.includes('parses OK')) {
      throw new Error('read_request could not parse a file the CLI itself just ran')
    }

    // js-yaml + the format writer are the bundling-sensitive part of a write.
    const written = await client.callTool({
      name: 'write_request',
      arguments: {
        path: 'Smoke/Written by MCP.curl',
        content:
          '#!/usr/bin/env bash\n# ---\n# description: written over MCP\n# ---\n\n' +
          "curl --request GET --url 'http://localhost:3010/health'\n"
      }
    })
    if (written.isError) throw new Error(`write_request failed: ${written.content[0].text}`)

    // The real payoff: the AI can run what it wrote and see the tests.
    const ran = await client.callTool({ name: 'run_request', arguments: { path: 'Health.curl' } })
    if (ran.isError || !ran.content[0].text.includes('✓ http ok')) {
      throw new Error(`run_request did not report a passing test:\n${ran.content[0].text}`)
    }
    console.log(`[smoke] mcp serve: ${names.length} tools, list/read/write/run all OK`)
  } finally {
    await client.close()
  }
}

/**
 * Drive the built CLI's `proxy` against the HTTP fixture: forward a request
 * through it and read back what it recorded.
 *
 * Bundling-sensitive on three counts. The cert path pulls in @peculiar/x509 +
 * reflect-metadata, whose decorator metadata is exactly the kind of thing that
 * survives `vite build` and then dies at runtime; the store writes
 * recorded.jsonl, which must work without Electron ever being resolved; and the
 * MQTT relay pulls in mqtt-packet, which — like mqtt.js above — ships a browser
 * build that stubs `net`, the exact slip that once broke `.mqtt` in the bundle.
 */
async function smokeProxy() {
  const dir = join(ROOT, '.tmp-smoke-proxy')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const child = spawn(process.execPath, [
    CLI,
    'proxy',
    dir,
    '--target',
    'http://localhost:3010',
    // Ports 0: never fight the app's defaults (7699/7700) on a dev machine.
    '--port',
    '0',
    '--https',
    '--https-port',
    '0',
    // Relays to the MQTT broker fixture already running for the run step.
    '--mqtt-target',
    'mqtt://localhost:1883',
    '--mqtt-port',
    '0'
  ])
  try {
    let out = ''
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`proxy did not listen within 20s:\n${out}`)), 20_000)
      child.stdout.on('data', (b) => {
        out += b.toString()
        const http = out.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)
        const https = out.match(/https:\/\/127\.0\.0\.1:(\d+)/)
        const mq = out.match(/MQTT relay listening on mqtt:\/\/127\.0\.0\.1:(\d+)/)
        if (http && https && mq) {
          clearTimeout(timer)
          resolve({ port: Number(http[1]), httpsPort: Number(https[1]), mqttPort: Number(mq[1]) })
        }
      })
      child.stderr.on('data', (b) => process.stderr.write(`[proxy] ${b}`))
    })
    const { port, httpsPort, mqttPort } = await ready

    const res = await fetch(`http://127.0.0.1:${port}/health`)
    const body = await res.json()
    if (body.ok !== true) throw new Error(`proxy did not forward to the fixture: ${JSON.stringify(body)}`)

    // The TLS leg, with the CA the CLI just generated. Node's https client
    // offers only http/1.1 in ALPN, which is the listener's REST path; the h2
    // path is gRPC's and is covered by the engine suite.
    const caPath = join(dir, '.freepost', 'tls', 'ca.crt')
    if (!existsSync(caPath)) throw new Error('--https did not generate a CA — suspect @peculiar/x509 bundling')
    const tlsBody = await new Promise((resolve, reject) => {
      const req = httpsRequest(
        `https://127.0.0.1:${httpsPort}/health`,
        { ca: readFileSync(caPath, 'utf8') },
        (r) => {
          let buf = ''
          r.on('data', (c) => (buf += c))
          r.on('end', () => resolve(buf))
        }
      )
      req.on('error', reject)
      req.end()
    })
    if (JSON.parse(tlsBody).ok !== true) throw new Error(`TLS listener did not forward: ${tlsBody}`)

    // The MQTT leg: a real client through the relay to the broker fixture. The
    // publish is acked at QoS 1 by the BROKER, so this only passes if the relay
    // really relayed rather than swallowing the bytes.
    const client = mqtt.connect(`mqtt://127.0.0.1:${mqttPort}`, {
      reconnectPeriod: 0,
      clientId: 'smoke-client'
    })
    await new Promise((resolve, reject) => {
      client.on('error', reject)
      client.on('connect', resolve)
    })
    await new Promise((resolve, reject) => {
      client.publish('freepost/smoke', 'relayed', { qos: 1 }, (e) => (e ? reject(e) : resolve()))
    })
    await new Promise((resolve) => client.end(false, {}, resolve))

    // The payoff: every leg landed in the collection's recorded.jsonl.
    const file = join(dir, '.freepost', 'history', 'recorded.jsonl')
    for (let i = 0; !existsSync(file) && i < 100; i++) await new Promise((r) => setTimeout(r, 50))
    let entries = []
    for (let i = 0; i < 100; i++) {
      entries = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      if (entries.some((e) => e.protocol === 'mqtt')) break
      await new Promise((r) => setTimeout(r, 50))
    }
    const vias = entries.filter((e) => e.status === 200 && !e.errored)
    if (!vias.some((e) => e.via === 'http') || !vias.some((e) => e.via === 'https')) {
      throw new Error(`recorded.jsonl is missing an http and/or https exchange:\n${JSON.stringify(entries)}`)
    }
    const session = entries.find((e) => e.protocol === 'mqtt')
    if (session === undefined) {
      throw new Error(`recorded.jsonl is missing the MQTT session:\n${JSON.stringify(entries)}`)
    }
    // Decoding is what mqtt-packet is bundled for: an empty packet list would
    // mean the relay worked and the parser silently didn't survive bundling.
    const published = session.mqtt.packets.find((p) => p.topic === 'freepost/smoke')
    if (session.mqtt.clientId !== 'smoke-client' || published?.preview !== 'relayed') {
      throw new Error(`the MQTT session recorded no decoded packets:\n${JSON.stringify(session)}`)
    }
    console.log(
      `[smoke] proxy: forwarded + recorded ${entries.length} exchange(s) over http, https and mqtt`
    )
  } finally {
    child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
}

const servers = []
let failed = false

try {
  writeCollection()
  console.log('[smoke] starting fixture servers…')
  servers.push(await startServer('http.mjs', 'REST fixture on'))
  servers.push(await startServer('grpc.mjs', 'gRPC fixture on'))
  servers.push(await startServer('mqtt.mjs', 'MQTT broker fixture on'))

  // The entrypoint guard once compared import.meta.url against `file://${argv[1]}`,
  // which never matches on Windows (`C:\x` vs `file:///C:/x`) — the CLI ran, did
  // nothing, and exited 0. Piped stdout catches that AND the Windows async-pipe
  // truncation, since both show up as an empty capture here.
  console.log('[smoke] checking the CLI produces output when piped…')
  const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' })
  if (!(help.stdout ?? '').includes('freepost')) {
    throw new Error(
      'the built CLI printed nothing when piped — the entrypoint guard did not fire, ' +
        'or stdout was discarded before it flushed'
    )
  }

  console.log('[smoke] running the built CLI against them…\n')
  const run = spawnSync(process.execPath, [CLI, 'run', DIR], { encoding: 'utf8' })
  const out = (run.stdout ?? '') + (run.stderr ?? '')
  process.stdout.write(out)

  const expected = ['http ok', 'grpc greets', 'mqtt published']
  const missing = expected.filter((e) => !out.includes(`✓ ${e}`))

  if (run.status !== 0 || missing.length > 0) {
    failed = true
    console.error(
      `\n[smoke] FAILED — exit ${run.status}${missing.length > 0 ? `; assertions not passing: ${missing.join(', ')}` : ''}`
    )
    console.error(
      '[smoke] The built CLI behaves differently from the source. Suspect vite.cli.config.ts:\n' +
        '        browser-vs-node resolution, or a dep that needs to stay external.'
    )
  } else {
    console.log('\n[smoke] OK — the built CLI runs HTTP, gRPC and MQTT requests.')
  }

  console.log('\n[smoke] driving the built CLI as an MCP server over stdio…')
  await smokeMcpServe()
  console.log('[smoke] OK — the built CLI serves MCP.')

  console.log('\n[smoke] recording through the built CLI proxy…')
  await smokeProxy()
  console.log('[smoke] OK — the built CLI proxies and records.')
} catch (e) {
  failed = true
  console.error('[smoke] ERROR:', e.message)
} finally {
  for (const s of servers) s.kill('SIGTERM')
  rmSync(DIR, { recursive: true, force: true })
}

process.exit(failed ? 1 : 0)
