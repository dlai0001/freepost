import { promises as fs } from 'fs'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, join } from 'path'
import type { ExecutionReport, Header, HttpResponseModel } from '../shared/model'
import { parseRequestFile, requestKindForPath } from '../core/format'
import { resolveVariables, substitute, substituteModel } from '../core/vars'
import { runScript } from '../core/sandbox'
import { sendHttp, CookieJar } from '../engine'
import { ensureFreepostDir } from './collection'

/** One in-memory cookie jar per collection root. */
const jars = new Map<string, CookieJar>()
export function jarFor(root: string): CookieJar {
  let jar = jars.get(root)
  if (jar === undefined) {
    jar = new CookieJar()
    jars.set(root, jar)
  }
  return jar
}

export function readEnvFile(root: string, envPath?: string): Record<string, string> {
  if (envPath === undefined || envPath === '') return {}
  const abs = isAbsolute(envPath) ? envPath : join(root, envPath)
  if (!existsSync(abs)) return {}
  const parsed = JSON.parse(readFileSync(abs, 'utf8')) as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parsed)) out[k] = String(v)
  return out
}

const HISTORY_CAP = 500

function appendHistory(root: string, entry: unknown): void {
  try {
    const dir = ensureFreepostDir(root)
    const file = join(dir, 'history', 'requests.jsonl')
    appendFileSync(file, JSON.stringify(entry) + '\n')
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    if (lines.length > HISTORY_CAP * 2) {
      writeFileSync(file, lines.slice(-HISTORY_CAP).join('\n') + '\n')
    }
  } catch {
    // History is best-effort; never fail a request over it.
  }
}

export interface ExecuteArgs {
  root: string
  path: string // collection-relative
  envPath?: string
  session: Map<string, string>
}

/** Full request execution: parse -> pre-script -> resolve -> send -> test-script. */
export async function executeRequest(args: ExecuteArgs): Promise<ExecutionReport> {
  const { root, path, session } = args
  const abs = join(root, path)
  const kind = requestKindForPath(path)
  const report: ExecutionReport = {
    requestPath: path,
    resolvedUrl: '',
    errored: false
  }

  if (kind !== 'curl') {
    return { ...report, errored: true, transportError: 'Not an HTTP request file (.curl)' }
  }

  let raw: string
  try {
    raw = await fs.readFile(abs, 'utf8')
  } catch (e) {
    return { ...report, errored: true, transportError: `Cannot read file: ${String(e)}` }
  }
  const parsed = parseRequestFile(raw, kind)
  if (!parsed.ok) {
    const msgs = parsed.errors.map((e) => `line ${e.line}: ${e.message}`).join('; ')
    return { ...report, errored: true, transportError: `Parse error: ${msgs}` }
  }
  const file = parsed.file
  const http = file.http
  if (http === undefined) {
    return { ...report, errored: true, transportError: 'File has no HTTP command' }
  }

  const env = readEnvFile(root, args.envPath)
  const sessionObj = Object.fromEntries(session)
  const requestName = path.split('/').pop() ?? path

  // Pre-request script (its session writes affect this request's resolution).
  const preSource = file.frontmatter.scripts?.['pre-request']
  if (preSource !== undefined && preSource.trim() !== '') {
    const pre = await runScript({
      source: preSource,
      phase: 'pre-request',
      request: { method: http.method, url: http.url, headers: http.headers },
      session: sessionObj,
      env,
      requestName,
      sendRequest: (r) => sandboxSend(r, args)
    })
    report.preScript = pre
    for (const [k, v] of Object.entries(pre.sessionWrites)) {
      session.set(k, v)
      sessionObj[k] = v
    }
    if (pre.error !== undefined) {
      report.errored = true
    }
  }

  // Resolve variables: session > env > request defaults.
  const { values, unresolved } = resolveVariables(file.variables, sessionObj, env)
  if (unresolved.length > 0) {
    return { ...report, unresolved, errored: true }
  }
  const resolved = substituteModel(http, values)
  report.resolvedUrl = resolved.url

  // Body: inline raw, or @file relative to the request's directory.
  let bodyText: string | undefined
  if (resolved.body !== undefined) {
    if (resolved.body.kind === 'raw') {
      bodyText = resolved.body.value
    } else {
      const bodyPath = substitute(resolved.body.value, values)
      const bodyAbs = isAbsolute(bodyPath) ? bodyPath : join(dirname(abs), bodyPath)
      try {
        bodyText = await fs.readFile(bodyAbs, 'utf8')
      } catch (e) {
        return { ...report, errored: true, transportError: `Cannot read body file: ${String(e)}` }
      }
    }
  }
  const headers: Header[] = [...resolved.headers]
  // GraphQL convenience: generated --data is JSON; default the content type.
  if (
    file.frontmatter.graphql !== undefined &&
    !headers.some((h) => h.name.toLowerCase() === 'content-type')
  ) {
    headers.push({ name: 'Content-Type', value: 'application/json' })
  }

  // Send.
  let response: HttpResponseModel | undefined
  try {
    response = await sendHttp(
      {
        method: resolved.method,
        url: resolved.url,
        headers,
        bodyText,
        options: {
          insecure: resolved.options.insecure,
          followRedirects: resolved.options.followRedirects,
          timeoutSeconds: resolved.options.timeoutSeconds,
          user: resolved.options.user
        }
      },
      jarFor(root)
    )
    report.response = response
  } catch (e) {
    report.transportError = e instanceof Error ? e.message : String(e)
    report.errored = true
  }

  // Test script.
  const testSource = file.frontmatter.scripts?.test
  if (response !== undefined && testSource !== undefined && testSource.trim() !== '') {
    const test = await runScript({
      source: testSource,
      phase: 'test',
      request: { method: resolved.method, url: resolved.url, headers },
      response,
      session: sessionObj,
      env,
      requestName,
      sendRequest: (r) => sandboxSend(r, args)
    })
    report.testScript = test
    for (const [k, v] of Object.entries(test.sessionWrites)) session.set(k, v)
    if (test.error !== undefined || test.tests.some((t) => !t.passed)) report.errored = true
  }

  if (response !== undefined && response.status >= 400) report.errored = true

  appendHistory(root, {
    at: new Date().toISOString(),
    path,
    method: resolved.method,
    url: resolved.url,
    status: response?.status,
    timeMs: response?.timeMs,
    errored: report.errored
  })
  return report
}

/** pm.sendRequest delegate — goes through the engine like everything else. */
async function sandboxSend(
  r: { url: string; method?: string; headers?: Record<string, string>; body?: string },
  args: ExecuteArgs
): Promise<HttpResponseModel> {
  const headers: Header[] = Object.entries(r.headers ?? {}).map(([name, value]) => ({
    name,
    value
  }))
  return sendHttp(
    { method: r.method ?? 'GET', url: r.url, headers, bodyText: r.body },
    jarFor(args.root)
  )
}
