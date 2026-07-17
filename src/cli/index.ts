/**
 * freepost CLI — headless collection runner (the Newman analog, PLAN.md §5
 * "post-1.0"). Reuses the exact Electron-free core the app uses
 * (executeRequest / runWorkflow / the pm.* sandbox), so `freepost run
 * ./collection` in CI behaves identically to the desktop app.
 *
 * Usage:
 *   freepost run <collection> [options]
 *     --env <file>            environment JSON (session > env > request params)
 *     --workflow <path>       run this workflow instead of loose requests (repeatable)
 *     --filter <substr>       only requests whose path contains <substr> (repeatable)
 *     --bail                  stop at the first failing request/step
 *     --reporter <cli|json>   output format (default: cli)
 *     -h, --help              show this help
 *
 *   freepost mock <collection> [--port <n>]
 *     Serve the collection's saved response examples over HTTP until Ctrl-C.
 *
 *   freepost proxy <collection> --target <url> [--port <n>] [--https]
 *     Record traffic forwarded to <url> into the collection until Ctrl-C.
 *     --mqtt-target <url> adds an MQTT relay on its own port (brokers aren't
 *     HTTP, so the MQTT listener needs its own target as well as its own port).
 *
 *   freepost mcp <snapshot|check|serve> <collection>
 *     snapshot: record each MCP server's schema surface next to its .mcp file.
 *     check:    diff live vs recorded; exit 1 on a BREAKING change (F5 drift).
 *     serve:    expose the collection to an AI app over MCP (stdio).
 *
 * Exit code is 0 when everything passed, 1 when any request errored, any test
 * assertion failed, a workflow halted, or MCP schema drift is breaking.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { isAbsolute, join, resolve } from 'path'
import { pathToFileURL } from 'url'
import type {
  ExecutionReport,
  RecordedExchange,
  RequestFile,
  TestResult,
  WorkflowStepResult
} from '../shared/model'
import { parseRequestFile, requestKindForPath } from '../core/format'
import { parseWorkflow, runWorkflow, validateReferences } from '../core/workflow'
import { executeRequest, readEnvFile } from '../main/execute'
import { ensureFreepostDir, listFiles } from '../main/collection'
import { buildRoutesForCollection } from '../main/mock'
import { ensureProxyCerts } from '../main/proxy-certs'
import {
  appendRecorded,
  DEFAULT_PROXY_HTTPS_PORT,
  DEFAULT_PROXY_MQTT_PORT,
  DEFAULT_PROXY_PORT,
  recordedFilePath
} from '../main/recorded-store'
import { MockServer, McpSessionClient, mcpConnectArgs, MqttRecordProxy, RecordProxyServer } from '../engine'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createFreepostMcpServer } from '../main/mcp-server'
import { resolveVariables, substitute } from '../core/vars'
import {
  buildSnapshot,
  diffSnapshots,
  parseSnapshot,
  serializeSnapshot,
  snapshotPathFor,
  type McpDriftReport
} from '../core/mcp'

export interface CliIo {
  cwd: string
  write: (s: string) => void
  color: boolean
  /** Register a Ctrl-C handler for long-running commands (mock). Optional in tests. */
  onSigint?: (cb: () => void) => void
}

interface RunOptions {
  command: 'run'
  collection: string
  env?: string
  workflows: string[]
  filters: string[]
  bail: boolean
  reporter: 'cli' | 'json'
  /** Skip .mcp files whose server is a subprocess (--no-mcp-spawn). */
  noMcpSpawn: boolean
}

interface MockOptions {
  command: 'mock'
  collection: string
  port: number
}

interface ProxyOptions {
  command: 'proxy'
  collection: string
  target: string
  port: number
  /** Also start the TLS listener (self-signed local CA; see proxy-certs.ts). */
  https: boolean
  httpsPort: number
  /** Broker to relay MQTT to; empty = no MQTT listener. */
  mqttTarget: string
  mqttPort: number
}

interface McpOptions {
  command: 'mcp'
  action: 'snapshot' | 'check' | 'serve'
  collection: string
  env?: string
  /** serve: refuse every mutating tool. */
  readonly: boolean
  /** serve: refuse run_request (no network calls on the AI's behalf). */
  noRun: boolean
  /** serve: refuse run_request on stdio .mcp files (no subprocess spawns). */
  noMcpSpawn: boolean
}

type Options = RunOptions | MockOptions | ProxyOptions | McpOptions

const HELP = `freepost — offline API client, headless runner

Usage:
  freepost run <collection> [options]
  freepost mock <collection> [--port <n>]
  freepost proxy <collection> --target <url> [--port <n>] [--https]
  freepost mcp <snapshot|check|serve> <collection> [--env <file>]

run options:
  --env <file>           environment JSON file
  --workflow <path>      run this workflow (collection-relative); repeatable
  --filter <substr>      only run requests whose path contains <substr>; repeatable
  --bail                 stop at the first failing request/step
  --reporter <cli|json>  output format (default: cli)
  --no-mcp-spawn         skip .mcp requests that would spawn a stdio server

mock options:
  --port <n>             port to listen on (default: an ephemeral port)

proxy options:
  --target <url>         server to forward to (required; http:// or https://)
  --port <n>             port to listen on (default: ${DEFAULT_PROXY_PORT})
  --https                also listen with TLS, using a local self-signed CA
  --https-port <n>       TLS port (default: ${DEFAULT_PROXY_HTTPS_PORT})
  --mqtt-target <url>    also relay MQTT to this broker (mqtt://host[:port])
  --mqtt-port <n>        MQTT listen port (default: ${DEFAULT_PROXY_MQTT_PORT})

mcp options:
  snapshot               record each MCP server's schema next to its .mcp file
  check                  fail (exit 1) when a recorded schema drifts breakingly
  serve                  expose the collection to an AI app over MCP (stdio)
  --env <file>           environment JSON file

serve options:
  --readonly             refuse every tool that writes to the collection
  --no-run               refuse to execute requests (no network on the AI's behalf)
  --no-mcp-spawn         refuse to run .mcp requests that spawn a stdio server

  -h, --help             show this help
`

function parseArgs(argv: string[]): { options?: Options; error?: string; help?: boolean } {
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) return { help: true }
  const command = argv[0]
  if (command !== 'run' && command !== 'mock' && command !== 'proxy' && command !== 'mcp') {
    return { error: `Unknown command: ${command}. Try 'freepost run <collection>' or 'freepost mock <collection>'.` }
  }
  const rest = argv.slice(1)

  if (command === 'mcp') {
    const action = rest[0]
    if (action !== 'snapshot' && action !== 'check' && action !== 'serve') {
      return { error: `freepost mcp needs an action: 'snapshot', 'check' or 'serve'.` }
    }
    const opts: McpOptions = {
      command: 'mcp',
      action,
      collection: '',
      readonly: false,
      noRun: false,
      noMcpSpawn: false
    }
    for (let i = 1; i < rest.length; i++) {
      const a = rest[i]
      if (a === '--env') {
        opts.env = rest[++i]
        continue
      }
      if (a === '--readonly') {
        opts.readonly = true
        continue
      }
      if (a === '--no-run') {
        opts.noRun = true
        continue
      }
      if (a === '--no-mcp-spawn') {
        opts.noMcpSpawn = true
        continue
      }
      if (a.startsWith('-')) return { error: `Unknown option: ${a}` }
      if (opts.collection === '') opts.collection = a
      else return { error: `Unexpected argument: ${a}` }
    }
    if (opts.collection === '') return { error: 'Missing <collection> path.' }
    if (action !== 'serve' && (opts.readonly || opts.noRun || opts.noMcpSpawn)) {
      return { error: `--readonly/--no-run/--no-mcp-spawn only apply to 'freepost mcp serve'.` }
    }
    return { options: opts }
  }

  if (command === 'mock') {
    const opts: MockOptions = { command: 'mock', collection: '', port: 0 }
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]
      const next = (): string | undefined => rest[++i]
      if (a === '--port') {
        const v = next()
        const n = v !== undefined ? Number(v) : NaN
        if (!Number.isInteger(n) || n < 0 || n > 65535) return { error: `--port must be 0-65535` }
        opts.port = n
      } else if (a.startsWith('-')) {
        return { error: `Unknown option: ${a}` }
      } else if (opts.collection === '') {
        opts.collection = a
      } else {
        return { error: `Unexpected argument: ${a}` }
      }
    }
    if (opts.collection === '') return { error: 'Missing <collection> path.' }
    return { options: opts }
  }

  if (command === 'proxy') {
    const opts: ProxyOptions = {
      command: 'proxy',
      collection: '',
      target: '',
      port: DEFAULT_PROXY_PORT,
      https: false,
      httpsPort: DEFAULT_PROXY_HTTPS_PORT,
      mqttTarget: '',
      mqttPort: DEFAULT_PROXY_MQTT_PORT
    }
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]
      const next = (): string | undefined => rest[++i]
      if (a === '--target') {
        opts.target = next() ?? ''
      } else if (a === '--mqtt-target') {
        opts.mqttTarget = next() ?? ''
      } else if (a === '--port' || a === '--https-port' || a === '--mqtt-port') {
        const v = next()
        const n = v !== undefined ? Number(v) : NaN
        if (!Number.isInteger(n) || n < 0 || n > 65535) return { error: `${a} must be 0-65535` }
        if (a === '--port') opts.port = n
        else if (a === '--https-port') opts.httpsPort = n
        else opts.mqttPort = n
      } else if (a === '--https') {
        opts.https = true
      } else if (a.startsWith('-')) {
        return { error: `Unknown option: ${a}` }
      } else if (opts.collection === '') {
        opts.collection = a
      } else {
        return { error: `Unexpected argument: ${a}` }
      }
    }
    if (opts.collection === '') return { error: 'Missing <collection> path.' }
    if (opts.target === '') return { error: 'Missing --target <url> — the server to forward to.' }
    return { options: opts }
  }

  const opts: RunOptions = {
    command: 'run',
    collection: '',
    workflows: [],
    filters: [],
    bail: false,
    reporter: 'cli',
    noMcpSpawn: false
  }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    const next = (): string | undefined => rest[++i]
    switch (a) {
      case '--env': opts.env = next(); break
      case '--workflow': { const v = next(); if (v !== undefined) opts.workflows.push(v); break }
      case '--filter': { const v = next(); if (v !== undefined) opts.filters.push(v); break }
      case '--bail': opts.bail = true; break
      case '--no-mcp-spawn': opts.noMcpSpawn = true; break
      case '--reporter': {
        const v = next()
        if (v !== 'cli' && v !== 'json') return { error: `--reporter must be 'cli' or 'json'` }
        opts.reporter = v
        break
      }
      default:
        if (a.startsWith('-')) return { error: `Unknown option: ${a}` }
        if (opts.collection === '') opts.collection = a
        else return { error: `Unexpected argument: ${a}` }
    }
  }
  if (opts.collection === '') return { error: 'Missing <collection> path.' }
  return { options: opts }
}

/** Minimal ANSI helpers, no-op when color is disabled. */
function paint(io: CliIo): { green: (s: string) => string; red: (s: string) => string; dim: (s: string) => string } {
  const wrap = (code: string) => (s: string): string => (io.color ? `\x1b[${code}m${s}\x1b[0m` : s)
  return { green: wrap('32'), red: wrap('31'), dim: wrap('2') }
}

function requestExists(root: string): (rel: string) => 'request' | 'missing' | 'not-a-request' {
  return (rel) => {
    if (!existsSync(resolve(root, rel))) return 'missing'
    return requestKindForPath(rel) !== null ? 'request' : 'not-a-request'
  }
}

interface Totals {
  requests: number
  assertions: number
  failures: number
}

function reportRequest(io: CliIo, rel: string, r: ExecutionReport, totals: Totals): void {
  const c = paint(io)
  totals.requests++
  const tests: TestResult[] = [...(r.preScript?.tests ?? []), ...(r.testScript?.tests ?? [])]
  totals.assertions += tests.length
  const failedTests = tests.filter((t) => !t.passed).length
  const bad = r.errored || r.transportError !== undefined || (r.unresolved?.length ?? 0) > 0
  if (bad || failedTests > 0) totals.failures++

  const status = r.response?.status
  const mark = bad || failedTests > 0 ? c.red('✗') : c.green('✓')
  const meta = status !== undefined ? c.dim(` ${status} ${Math.round(r.response?.timeMs ?? 0)}ms`) : ''
  io.write(`${mark} ${rel}${meta}\n`)
  if (r.unresolved?.length) io.write(c.red(`    unresolved variables: ${r.unresolved.join(', ')}\n`))
  if (r.transportError !== undefined) io.write(c.red(`    transport error: ${r.transportError}\n`))
  if (r.preScript?.error !== undefined) io.write(c.red(`    pre-request script error: ${r.preScript.error}\n`))
  if (r.testScript?.error !== undefined) io.write(c.red(`    test script error: ${r.testScript.error}\n`))
  for (const t of tests) {
    if (t.passed) io.write(c.dim(`    ✓ ${t.name}\n`))
    else io.write(c.red(`    ✗ ${t.name}${t.error !== undefined ? ` — ${t.error}` : ''}\n`))
  }
}

function reportStep(io: CliIo, s: WorkflowStepResult, totals: Totals): void {
  const c = paint(io)
  totals.requests++
  totals.assertions += s.tests.length
  const failedTests = s.tests.filter((t) => !t.passed).length
  const isFailure = s.status === 'failed'
  if (isFailure || failedTests > 0) totals.failures++
  const mark =
    s.status === 'passed' || s.status === 'expected-error'
      ? c.green('✓')
      : s.status === 'skipped'
        ? c.dim('–')
        : s.status === 'unexpected-success'
          ? c.dim('!') // ran anyway, but flagged (PLAN.md: warn & continue)
          : c.red('✗')
  io.write(`${mark} ${s.request} ${c.dim(`[${s.status}]`)}\n`)
  if (s.errorMessage !== undefined) io.write(c.red(`    ${s.errorMessage}\n`))
  for (const t of s.tests) {
    if (!t.passed) io.write(c.red(`    ✗ ${t.name}${t.error !== undefined ? ` — ${t.error}` : ''}\n`))
  }
}

/**
 * Connect to the server a `.mcp` file names and read its full schema surface.
 * Variables are resolved exactly as they are for a run, so a snapshot taken
 * with `--env prod.env.json` targets the prod server.
 */
async function introspectRequest(
  root: string,
  rel: string,
  file: RequestFile,
  envPath: string | undefined
): Promise<ReturnType<typeof buildSnapshot>> {
  const m = file.mcp
  if (m === undefined) throw new Error('not an MCP request')
  const env = readEnvFile(root, envPath)
  const { values, unresolved } = resolveVariables(file.variables, {}, env)
  if (unresolved.length > 0) throw new Error(`unresolved required variables: ${unresolved.join(', ')}`)
  const sub = (s: string): string => substitute(s, values)

  const conn = mcpConnectArgs(m)
  const client = new McpSessionClient()
  const info = await new Promise<Awaited<ReturnType<McpSessionClient['introspect']>>>((res, rej) => {
    client.on('open', res).on('error', rej)
    void client.connect({
      ...conn,
      command: m.command !== undefined ? sub(m.command) : undefined,
      args: m.args.map(sub),
      env: conn.env !== undefined ? Object.fromEntries(m.env.map((e) => [e.name, sub(e.value)])) : undefined,
      cwd: resolve(root, rel, '..'),
      url: m.url !== undefined ? sub(m.url) : undefined,
      headers: m.headers.map((h) => ({ name: h.name, value: sub(h.value) }))
    })
  })
  await client.close()
  return buildSnapshot(info)
}

/**
 * `freepost mcp snapshot|check` — the F5 regression story.
 *
 * snapshot: introspect every .mcp server and write `<request>.mcp.snapshot.json`
 *   beside the request, so the schema is reviewable in `git diff`.
 * check:    introspect again and diff against what was recorded. Breaking drift
 *   (a removed tool, a removed/retyped/newly-required param) exits 1; additive
 *   drift is reported but passes.
 */
async function runMcpSchema(opts: McpOptions, root: string, io: CliIo): Promise<number> {
  const c = paint(io)
  const envPath = opts.env === undefined ? undefined : isAbsolute(opts.env) ? opts.env : resolve(io.cwd, opts.env)
  const files = (await listFiles(root)).sort().filter((f) => requestKindForPath(f) === 'mcp')

  if (files.length === 0) {
    io.write('No .mcp requests in this collection.\n')
    return 0
  }

  let breaking = 0
  let drifted = 0
  let failed = 0

  for (const rel of files) {
    const parsed = parseRequestFile(readFileSync(resolve(root, rel), 'utf8'), 'mcp')
    if (!parsed.ok) {
      io.write(c.red(`✗ ${rel} — parse error\n`))
      failed++
      continue
    }

    let live: ReturnType<typeof buildSnapshot>
    try {
      live = await introspectRequest(root, rel, parsed.file, envPath)
    } catch (e) {
      io.write(c.red(`✗ ${rel} — ${e instanceof Error ? e.message : String(e)}\n`))
      failed++
      continue
    }

    const snapAbs = resolve(root, snapshotPathFor(rel))
    if (opts.action === 'snapshot') {
      writeFileSync(snapAbs, serializeSnapshot(live))
      io.write(
        `${c.green('✓')} ${rel} ${c.dim(`— ${live.tools.length} tool(s), ${live.resources.length} resource(s), ${live.prompts.length} prompt(s) -> ${snapshotPathFor(rel)}`)}\n`
      )
      continue
    }

    // check
    if (!existsSync(snapAbs)) {
      io.write(c.red(`✗ ${rel} — no snapshot; run 'freepost mcp snapshot' first\n`))
      failed++
      continue
    }
    const stored = parseSnapshot(readFileSync(snapAbs, 'utf8'))
    if (stored === null) {
      io.write(c.red(`✗ ${rel} — snapshot is unreadable: ${snapshotPathFor(rel)}\n`))
      failed++
      continue
    }
    const report: McpDriftReport = diffSnapshots(stored, live)
    if (report.clean) {
      io.write(`${c.green('✓')} ${rel} ${c.dim('— no drift')}\n`)
      continue
    }
    drifted++
    if (report.breaking) breaking++
    io.write(`${report.breaking ? c.red('✗') : c.dim('!')} ${rel}\n`)
    for (const e of report.entries) {
      const line = `    ${e.breaking ? 'BREAKING' : 'additive'}: ${e.message}\n`
      io.write(e.breaking ? c.red(line) : c.dim(line))
    }
  }

  if (opts.action === 'check') {
    io.write(
      `\n${files.length} server(s), ${drifted} drifted, ${breaking} with breaking changes${failed > 0 ? `, ${failed} failed` : ''}\n`
    )
  }
  return breaking > 0 || failed > 0 ? 1 : 0
}

/**
 * `freepost mcp serve` — expose the collection to an AI app over stdio MCP.
 *
 * Runs until the client disconnects (Claude Desktop launches this as a
 * subprocess and closes stdin on exit), or Ctrl-C.
 *
 * stdout belongs to the JSON-RPC transport here — a stray line of human output
 * on it is a protocol violation that the client reports as a corrupt server, so
 * everything we print goes to stderr. Callers pass an `io` whose `write` is
 * already routed there.
 *
 * Invoking this command IS the authorisation to spawn the collection's stdio MCP
 * servers, exactly as `freepost run` is; --no-mcp-spawn opts out.
 */
async function runMcpServe(opts: McpOptions, root: string, io: CliIo): Promise<number> {
  const c = paint(io)
  const envPath =
    opts.env === undefined ? undefined : isAbsolute(opts.env) ? opts.env : resolve(io.cwd, opts.env)

  const server = createFreepostMcpServer({
    getRoot: () => root,
    envPath,
    readonly: opts.readonly,
    allowRun: !opts.noRun,
    allowMcpSpawn: () => !opts.noMcpSpawn,
    session: new Map<string, string>()
  })

  const flags = [
    opts.readonly ? 'read-only' : 'read/write',
    opts.noRun ? 'no run' : 'run enabled',
    opts.noMcpSpawn ? 'no mcp spawn' : 'mcp spawn allowed'
  ]
  io.write(c.green(`freepost MCP server on stdio`) + c.dim(` · ${root} · ${flags.join(' · ')}\n`))

  const transport = new StdioServerTransport()
  await server.connect(transport)

  return await new Promise<number>((resolvePromise) => {
    // Idempotent on purpose: server.close() closes the transport, which fires
    // onclose — so without the guard, the client disconnecting sends this
    // straight into recursion.
    let stopping = false
    const stop = (): void => {
      if (stopping) return
      stopping = true
      void server.close().then(() => resolvePromise(0))
    }
    // Claude Desktop stops the server by closing the pipe, not by signalling.
    transport.onclose = stop
    if (io.onSigint !== undefined) io.onSigint(stop)
  })
}

/**
 * Run the CLI. Returns a process exit code (0 = all passed). `io` is injectable
 * so tests can capture output and set the working directory.
 */
/**
 * `freepost mock`: build routes from saved examples, serve them, and stay up
 * until Ctrl-C (or the injected onSigint fires). Resolves with an exit code.
 */
async function runMockServer(opts: MockOptions, root: string, io: CliIo): Promise<number> {
  const c = paint(io)
  const routes = await buildRoutesForCollection(root)
  if (routes.length === 0) {
    io.write(c.red('No routes: no requests with saved examples found in this collection.\n'))
    return 2
  }
  const server = new MockServer()
  server.on('request', (e) => {
    const mark = e.matched ? c.green('✓') : c.red('✗')
    io.write(`${mark} ${e.method} ${e.path} ${c.dim(`→ ${e.status}${e.exampleName !== undefined ? ' ' + e.exampleName : ''}`)}\n`)
  })
  const { port } = await server.start({ routes, port: opts.port })
  io.write(c.green(`Mock server listening on http://127.0.0.1:${port}`) + c.dim(` · ${routes.length} route(s) · Ctrl-C to stop\n`))

  return await new Promise<number>((resolvePromise) => {
    const stop = (): void => {
      void server.stop().then(() => {
        io.write(c.dim('\nMock server stopped.\n'))
        resolvePromise(0)
      })
    }
    if (io.onSigint !== undefined) io.onSigint(stop)
  })
}

/**
 * The topics an MQTT session touched — the label that identifies it, the way
 * operationName does for GraphQL. An MQTT exchange is a whole connection, so
 * its packets' topics say more than the broker URL every row already carries.
 */
function mqttSummary(entry: RecordedExchange): string | undefined {
  if (entry.mqtt === undefined) return undefined
  const topics = [...new Set(entry.mqtt.packets.map((p) => p.topic).filter((t) => t !== undefined))]
  const label = topics.length > 3 ? `${topics.slice(0, 3).join(', ')}, +${topics.length - 3} more` : topics.join(', ')
  const id = entry.mqtt.clientId
  return [id, label, `${entry.mqtt.packets.length} packets`].filter((s) => s !== undefined && s !== '').join(' · ')
}

/**
 * `freepost proxy`: the CLI half of Tools ▸ Proxy Server (Record). Same engine
 * listener and same recorded.jsonl store as the app, so traffic recorded here
 * shows up in the collection's History ▸ Recorded tab.
 *
 * Unlike the app there is no "current collection" to bind to — the positional
 * argument IS the binding, so the auto-stop-on-root-change rule has nothing to
 * guard against. Nothing is persisted to settings either: the app remembers a
 * prefill for its modal, whereas a CLI invocation states its target every time.
 */
async function runProxyServer(opts: ProxyOptions, root: string, io: CliIo): Promise<number> {
  const c = paint(io)
  const server = new RecordProxyServer()
  const onExchange = (entry: RecordedExchange): void => {
    appendRecorded(root, entry)
    const mark = entry.errored ? c.red('✗') : c.green('✓')
    // Label the exchange by what it actually was: the GraphQL operation, the
    // gRPC method, the MQTT topics, or the status — `POST /graphql → 200` on
    // every row tells the user nothing.
    const what =
      entry.graphql?.operationName ??
      (entry.grpc !== undefined ? `${entry.grpc.service}/${entry.grpc.method}` : undefined) ??
      mqttSummary(entry)
    const outcome = entry.errored ? (entry.error ?? 'error') : String(entry.status ?? '')
    const meta = [
      entry.protocol,
      what,
      outcome,
      entry.timeMs !== undefined ? `${Math.round(entry.timeMs)}ms` : undefined
    ].filter((s) => s !== undefined && s !== '')
    io.write(`${mark} ${entry.method} ${entry.url} ${c.dim(`→ ${meta.join(' ')}`)}\n`)
  }
  server.on('exchange', onExchange)
  // A listener-level error (a socket fault after start) must not take the
  // process down — report it and keep recording.
  server.on('error', (e) => io.write(c.red(`proxy error: ${e.message}\n`)))

  // Certs are lazy: generated (or rotated) only when --https is passed. They
  // live in the collection's git-ignored .freepost/ rather than the app's
  // userData, so a CLI run has no Electron-shaped dependency on a path only
  // the desktop app knows.
  let tls: { key: string; cert: string; port: number } | undefined
  let caPath: string | undefined
  if (opts.https) {
    const certs = await ensureProxyCerts(join(ensureFreepostDir(root), 'tls'))
    tls = { key: certs.keyPem, cert: certs.certPem, port: opts.httpsPort }
    caPath = certs.caPath
  }

  let bound: number
  let tlsPort: number | undefined
  try {
    ;({ port: bound, tlsPort } = await server.start({ target: opts.target, port: opts.port, tls }))
  } catch (e) {
    // A bad target or a taken port is the user's mistake, not a crash.
    io.write(c.red(`${e instanceof Error ? e.message : String(e)}\n`))
    return 2
  }

  // --mqtt-target opts into a second, independent listener: a TCP relay to a
  // broker. It is its own flag rather than riding on --target because a broker
  // address is not an http(s) origin — one target could never mean both.
  let mqttServer: MqttRecordProxy | undefined
  let mqttBound: number | undefined
  if (opts.mqttTarget !== '') {
    mqttServer = new MqttRecordProxy()
    mqttServer.on('exchange', onExchange)
    mqttServer.on('error', (e) => io.write(c.red(`mqtt proxy error: ${e.message}\n`)))
    try {
      ;({ port: mqttBound } = await mqttServer.start({ target: opts.mqttTarget, port: opts.mqttPort }))
    } catch (e) {
      // Same rule as the HTTP listener — and don't leave that one running.
      await server.stop()
      io.write(c.red(`${e instanceof Error ? e.message : String(e)}\n`))
      return 2
    }
  }

  io.write(
    c.green(`Recording proxy listening on http://127.0.0.1:${bound}`) +
      c.dim(` → ${opts.target} · Ctrl-C to stop\n`)
  )
  if (tlsPort !== undefined) {
    io.write(c.green(`TLS listener on https://127.0.0.1:${tlsPort}`) + c.dim(` · CA: ${caPath}\n`))
    io.write(c.dim(`  curl --cacert '${caPath}' https://127.0.0.1:${tlsPort}/…\n`))
  }
  if (mqttBound !== undefined) {
    io.write(
      c.green(`MQTT relay listening on mqtt://127.0.0.1:${mqttBound}`) +
        c.dim(` → ${opts.mqttTarget}\n`)
    )
  }
  io.write(c.dim(`Recording to ${recordedFilePath(root)}\n`))

  return await new Promise<number>((resolvePromise) => {
    const stop = (): void => {
      void Promise.all([server.stop(), mqttServer?.stop()]).then(() => {
        io.write(c.dim('\nRecording proxy stopped.\n'))
        resolvePromise(0)
      })
    }
    if (io.onSigint !== undefined) io.onSigint(stop)
  })
}

export async function run(argv: string[], io: CliIo): Promise<number> {
  const parsed = parseArgs(argv)
  if (parsed.help === true) {
    io.write(HELP)
    return 0
  }
  if (parsed.error !== undefined) {
    io.write(parsed.error + '\n')
    return 2
  }
  const opts = parsed.options!
  const root = isAbsolute(opts.collection) ? opts.collection : resolve(io.cwd, opts.collection)
  if (!existsSync(root)) {
    io.write(`Collection not found: ${root}\n`)
    return 2
  }
  if (opts.command === 'mock') return runMockServer(opts, root, io)
  if (opts.command === 'proxy') return runProxyServer(opts, root, io)
  if (opts.command === 'mcp') {
    return opts.action === 'serve' ? runMcpServe(opts, root, io) : runMcpSchema(opts, root, io)
  }
  // From here `opts` is narrowed to RunOptions.
  const envPath = opts.env === undefined ? undefined : isAbsolute(opts.env) ? opts.env : resolve(io.cwd, opts.env)
  const session = new Map<string, string>()
  const totals: Totals = { requests: 0, assertions: 0, failures: 0 }
  const c = paint(io)
  const jsonOut: unknown[] = []

  if (opts.workflows.length > 0) {
    // Workflow mode.
    for (const wfRel of opts.workflows) {
      const abs = isAbsolute(wfRel) ? wfRel : resolve(root, wfRel)
      if (!existsSync(abs)) {
        io.write(c.red(`Workflow not found: ${wfRel}\n`))
        totals.failures++
        if (opts.bail) break
        continue
      }
      const parsedWf = parseWorkflow(readFileSync(abs, 'utf8'))
      if (!parsedWf.ok) {
        io.write(c.red(`Cannot parse workflow ${wfRel}: ${parsedWf.error}\n`))
        totals.failures++
        if (opts.bail) break
        continue
      }
      const issues = validateReferences(parsedWf.wf, requestExists(root))
      if (issues.length > 0) {
        io.write(c.red(`Workflow ${wfRel} has broken references: ${issues.map((i) => i.request).join(', ')}\n`))
        totals.failures++
        if (opts.bail) break
        continue
      }
      if (opts.reporter === 'cli') io.write(c.dim(`\n▶ workflow ${wfRel}\n`))
      const report = await runWorkflow({
        workflowPath: wfRel,
        wf: parsedWf.wf,
        execute: (rel) => executeRequest({ root, path: rel, envPath, session })
      })
      if (opts.reporter === 'json') jsonOut.push(report)
      else for (const s of report.steps) reportStep(io, s, totals)
      if (report.halted && opts.bail) break
    }
  } else {
    // Request mode: every one-shot-runnable request, path-sorted, shared
    // session. Runnable: HTTP (.curl), gRPC unary (.grpc), MQTT publish
    // (.mqtt), MCP (.mcp — all six methods are one-shot).
    // Not one-shot (skipped, like websocket): MQTT subscribe. gRPC
    // server-streaming can't be told apart without loading the proto, so it
    // runs and surfaces a clear "use the streaming client" error.
    //
    // Invoking `freepost run` on a collection IS the authorisation to spawn its
    // stdio MCP servers (unlike the GUI, which confirms each server before the
    // first spawn). --no-mcp-spawn opts out for locked-down CI.
    const files = (await listFiles(root)).sort()
    const skipped: { websocket: number; mqttSubscribe: number; mcpSpawn: number } = {
      websocket: 0,
      mqttSubscribe: 0,
      mcpSpawn: 0
    }
    for (const rel of files) {
      const kind = requestKindForPath(rel)
      if (kind === null) continue
      if (kind === 'websocat') {
        skipped.websocket++
        continue
      }
      if (kind === 'mqtt') {
        // Subscribe files are long-lived, not one-shot.
        const parsed = parseRequestFile(readFileSync(resolve(root, rel), 'utf8'), 'mqtt')
        if (parsed.ok && parsed.file.mqtt?.mode === 'subscribe') {
          skipped.mqttSubscribe++
          continue
        }
      }
      if (kind === 'mcp' && opts.noMcpSpawn) {
        const parsed = parseRequestFile(readFileSync(resolve(root, rel), 'utf8'), 'mcp')
        if (parsed.ok && parsed.file.mcp?.transport === 'stdio') {
          skipped.mcpSpawn++
          continue
        }
      }
      if (opts.filters.length > 0 && !opts.filters.some((f) => rel.toLowerCase().includes(f.toLowerCase()))) {
        continue
      }
      const report = await executeRequest({ root, path: rel, envPath, session })
      if (opts.reporter === 'json') jsonOut.push(report)
      else reportRequest(io, rel, report, totals)
      if (report.errored && opts.bail) break
    }
    if (opts.reporter === 'cli') {
      const notes: string[] = []
      if (skipped.websocket > 0) notes.push(`${skipped.websocket} websocket`)
      if (skipped.mqttSubscribe > 0) notes.push(`${skipped.mqttSubscribe} MQTT subscribe`)
      if (notes.length > 0) {
        io.write(c.dim(`\n(${notes.join(', ')} request(s) skipped — not one-shot runnable)\n`))
      }
      if (skipped.mcpSpawn > 0) {
        io.write(c.dim(`\n(${skipped.mcpSpawn} stdio MCP request(s) skipped — --no-mcp-spawn)\n`))
      }
    }
  }

  if (opts.reporter === 'json') {
    io.write(JSON.stringify(jsonOut, null, 2) + '\n')
  } else {
    const line = `\n${totals.requests} run, ${totals.assertions} assertions, ${totals.failures} failed\n`
    io.write(totals.failures > 0 ? c.red(line) : c.green(line))
  }
  return totals.failures > 0 ? 1 : 0
}

/**
 * Exit with `code`, but only once stdout has actually drained.
 *
 * On Windows, stdout to a PIPE is asynchronous, so a bare process.exit() throws
 * away whatever is still buffered — the CLI would exit with the right code and
 * print nothing at all when piped (into CI capture, `| tee`, another program).
 * On POSIX pipes the write is synchronous and this is a no-op. Passing a chunk
 * of '' still queues the callback behind every earlier write, so it fires once
 * they have all flushed.
 */
function exitAfterFlush(code: number): void {
  process.stdout.write('', () => process.exit(code))
}

// Entrypoint guard: only runs when executed directly, not when imported by tests.
//
// This MUST go through pathToFileURL. Comparing against `file://${argv[1]}` is
// wrong on Windows, where argv[1] is `C:\path\index.mjs` while import.meta.url
// is `file:///C:/path/index.mjs` — the guard never matched, so the built CLI
// silently did nothing and exited 0. `freepost run` was a no-op on Windows.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2)
  // `mcp serve` hands stdout to the JSON-RPC transport, so every byte of human
  // output has to go to stderr instead — one stray line on stdout and the client
  // sees a corrupt server. This is the only place that knows about the real
  // process streams, so it's the only place that can make that swap.
  const isStdioServer = argv[0] === 'mcp' && argv[1] === 'serve'
  const sink = isStdioServer ? process.stderr : process.stdout
  run(argv, {
    cwd: process.cwd(),
    write: (s) => sink.write(s),
    color: sink.isTTY === true,
    onSigint: (cb) => process.once('SIGINT', cb)
  })
    .then((code) => exitAfterFlush(code))
    .catch((e) => {
      process.stderr.write(`freepost: ${e instanceof Error ? e.message : String(e)}\n`)
      exitAfterFlush(1)
    })
}
