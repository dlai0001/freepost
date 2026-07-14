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
import { existsSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

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
} catch (e) {
  failed = true
  console.error('[smoke] ERROR:', e.message)
} finally {
  for (const s of servers) s.kill('SIGTERM')
  rmSync(DIR, { recursive: true, force: true })
}

process.exit(failed ? 1 : 0)
