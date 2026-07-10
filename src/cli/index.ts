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
 * Exit code is 0 when everything passed, 1 when any request errored, any test
 * assertion failed, or a workflow halted.
 */
import { existsSync, readFileSync } from 'fs'
import { isAbsolute, resolve } from 'path'
import type { ExecutionReport, TestResult, WorkflowStepResult } from '../shared/model'
import { requestKindForPath } from '../core/format'
import { parseWorkflow, runWorkflow, validateReferences } from '../core/workflow'
import { executeRequest } from '../main/execute'
import { listFiles } from '../main/collection'
import { buildRoutesForCollection } from '../main/mock'
import { MockServer } from '../engine'

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
}

interface MockOptions {
  command: 'mock'
  collection: string
  port: number
}

type Options = RunOptions | MockOptions

const HELP = `freepost — offline API client, headless runner

Usage:
  freepost run <collection> [options]
  freepost mock <collection> [--port <n>]

run options:
  --env <file>           environment JSON file
  --workflow <path>      run this workflow (collection-relative); repeatable
  --filter <substr>      only run requests whose path contains <substr>; repeatable
  --bail                 stop at the first failing request/step
  --reporter <cli|json>  output format (default: cli)

mock options:
  --port <n>             port to listen on (default: an ephemeral port)

  -h, --help             show this help
`

function parseArgs(argv: string[]): { options?: Options; error?: string; help?: boolean } {
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) return { help: true }
  const command = argv[0]
  if (command !== 'run' && command !== 'mock') {
    return { error: `Unknown command: ${command}. Try 'freepost run <collection>' or 'freepost mock <collection>'.` }
  }
  const rest = argv.slice(1)

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

  const opts: RunOptions = {
    command: 'run',
    collection: '',
    workflows: [],
    filters: [],
    bail: false,
    reporter: 'cli'
  }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    const next = (): string | undefined => rest[++i]
    switch (a) {
      case '--env': opts.env = next(); break
      case '--workflow': { const v = next(); if (v !== undefined) opts.workflows.push(v); break }
      case '--filter': { const v = next(); if (v !== undefined) opts.filters.push(v); break }
      case '--bail': opts.bail = true; break
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
    // Request mode: every runnable HTTP request, path-sorted, shared session.
    const files = (await listFiles(root)).sort()
    let skippedWs = 0
    for (const rel of files) {
      const kind = requestKindForPath(rel)
      if (kind === null) continue
      if (kind !== 'curl') { skippedWs++; continue } // websocket requests aren't one-shot runnable
      if (opts.filters.length > 0 && !opts.filters.some((f) => rel.toLowerCase().includes(f.toLowerCase()))) {
        continue
      }
      const report = await executeRequest({ root, path: rel, envPath, session })
      if (opts.reporter === 'json') jsonOut.push(report)
      else reportRequest(io, rel, report, totals)
      if (report.errored && opts.bail) break
    }
    if (skippedWs > 0 && opts.reporter === 'cli') {
      io.write(c.dim(`\n(${skippedWs} websocket request(s) skipped — not one-shot runnable)\n`))
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

// Entrypoint guard: only runs when executed directly, not when imported by tests.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2), {
    cwd: process.cwd(),
    write: (s) => process.stdout.write(s),
    color: process.stdout.isTTY === true,
    onSigint: (cb) => process.once('SIGINT', cb)
  })
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`freepost: ${e instanceof Error ? e.message : String(e)}\n`)
      process.exit(1)
    })
}
