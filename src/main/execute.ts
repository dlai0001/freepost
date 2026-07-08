import { promises as fs } from 'fs'
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { basename, dirname, isAbsolute, join } from 'path'
import type { ExecutionReport, FormField, Header, HttpResponseModel } from '../shared/model'
import { parseRequestFile, requestKindForPath } from '../core/format'
import { buildMultipartBody, multipartContentType, type MultipartPart } from '../core/format/multipart'
import { resolveVariables, substitute, substituteModel } from '../core/vars'
import { runScript } from '../core/sandbox'
import { mergeRequestHeaders } from '../core/config'
import { sendHttp, CookieJar, shouldBypassProxy } from '../engine'
import { ensureFreepostDir } from './collection'
import { resolveConfigChain } from './config-resolve'

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
    // History records full request/response data (incl. auth headers) — owner-only.
    try {
      chmodSync(file, 0o600)
    } catch {
      /* best-effort; no-op on Windows */
    }
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

  // Inherited collection/folder config (default headers, folder scripts, mTLS).
  const { config: cfg } = await resolveConfigChain(root, path)

  // Pre-request scripts: collection/folder (outermost first), then the request's
  // own. All session writes feed variable resolution for the send.
  const preScripts = [
    ...cfg.preScripts,
    ...(file.frontmatter.scripts?.['pre-request']
      ? [{ source: file.frontmatter.scripts['pre-request'], origin: requestName }]
      : [])
  ]
  const preOutcomes: import('../shared/model').ScriptOutcome[] = []
  for (const s of preScripts) {
    if (s.source.trim() === '') continue
    const pre = await runScript({
      source: s.source,
      phase: 'pre-request',
      request: { method: http.method, url: http.url, headers: http.headers },
      session: sessionObj,
      env,
      requestName,
      sendRequest: (r) => sandboxSend(r, args)
    })
    preOutcomes.push(pre)
    for (const [k, v] of Object.entries(pre.sessionWrites)) {
      session.set(k, v)
      sessionObj[k] = v
    }
    if (pre.error !== undefined) report.errored = true
  }
  if (preOutcomes.length > 0) report.preScript = mergeOutcomes(preOutcomes)

  // Resolve variables: session > env > request defaults.
  const { values, unresolved } = resolveVariables(file.variables, sessionObj, env)
  if (unresolved.length > 0) {
    return { ...report, unresolved, errored: true }
  }
  const resolved = substituteModel(http, values)
  report.resolvedUrl = resolved.url

  // Body: multipart form (frontmatter.form is canonical), else inline raw or
  // @file relative to the request's directory.
  let bodyText: string | undefined
  let bodyBuffer: Buffer | undefined
  let multipartType: string | undefined
  const formFields: FormField[] | undefined = file.frontmatter.form ?? resolved.form
  if (formFields !== undefined && formFields.length > 0) {
    const parts: MultipartPart[] = []
    for (const f of formFields) {
      if (f.type === 'file') {
        const p = substitute(f.value ?? '', values)
        const fileAbs = isAbsolute(p) ? p : join(dirname(abs), p)
        try {
          parts.push({
            name: f.name,
            filename: f.filename ?? basename(p),
            content: await fs.readFile(fileAbs)
          })
        } catch (e) {
          return { ...report, errored: true, transportError: `Cannot read form file: ${String(e)}` }
        }
      } else if (f.type === 'json') {
        parts.push({
          name: f.name,
          filename: f.filename,
          contentType: 'application/json',
          content: substitute(f.content ?? '', values)
        })
      } else {
        parts.push({ name: f.name, content: substitute(f.value ?? '', values) })
      }
    }
    const boundary = `----freepostFormBoundary${randomUUID().replace(/-/g, '')}`
    bodyBuffer = buildMultipartBody(parts, boundary)
    multipartType = multipartContentType(boundary)
  } else if (resolved.body !== undefined) {
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
  // Merge inherited default headers under the request's own (request wins),
  // with ${VAR} substitution applied to config header values.
  const configHeaders = cfg.defaultHeaders.map((h) => ({
    name: h.name,
    value: substitute(h.value, values)
  }))
  let headers: Header[] = mergeRequestHeaders(configHeaders, resolved.headers)
  // GraphQL convenience: generated --data is JSON; default the content type.
  if (
    file.frontmatter.graphql !== undefined &&
    !headers.some((h) => h.name.toLowerCase() === 'content-type')
  ) {
    headers.push({ name: 'Content-Type', value: 'application/json' })
  }
  // Multipart owns Content-Type: the boundary must match the assembled body,
  // so any manually-set content type is replaced.
  if (multipartType !== undefined) {
    headers = headers.filter((h) => h.name.toLowerCase() !== 'content-type')
    headers.push({ name: 'Content-Type', value: multipartType })
  }

  // mTLS client cert/key from collection/folder config (paths are collection-relative).
  const clientCert =
    cfg.clientCert !== undefined ? resolveCertPath(root, substitute(cfg.clientCert, values)) : undefined
  const clientKey =
    cfg.clientKey !== undefined ? resolveCertPath(root, substitute(cfg.clientKey, values)) : undefined
  // Custom CA (corporate MITM) — PEM or collection-relative path, like the client cert.
  const caCert =
    cfg.caCert !== undefined ? resolveCertPath(root, substitute(cfg.caCert, values)) : undefined
  // Proxy: collection/folder config wins, else *_PROXY env vars; NO_PROXY bypasses.
  const proxy = resolveProxy(
    cfg.proxy !== undefined ? substitute(cfg.proxy, values) : undefined,
    resolved.url
  )

  report.resolvedRequest = {
    method: resolved.method,
    url: resolved.url,
    headers,
    body: bodyBuffer !== undefined ? bodyBuffer.toString('utf8') : bodyText
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
        bodyBuffer,
        options: {
          insecure: resolved.options.insecure,
          followRedirects: resolved.options.followRedirects,
          timeoutSeconds: resolved.options.timeoutSeconds,
          user: resolved.options.user,
          clientCert,
          clientKey,
          clientKeyPassphrase:
            cfg.clientKeyPassphrase !== undefined
              ? substitute(cfg.clientKeyPassphrase, values)
              : undefined,
          caCert,
          proxy
        }
      },
      jarFor(root)
    )
    report.response = response
  } catch (e) {
    report.transportError = e instanceof Error ? e.message : String(e)
    report.errored = true
  }

  // Test scripts: the request's own first, then collection/folder (outermost first).
  const testScripts = [
    ...(file.frontmatter.scripts?.test
      ? [{ source: file.frontmatter.scripts.test, origin: requestName }]
      : []),
    ...cfg.testScripts
  ]
  if (response !== undefined) {
    const testOutcomes: import('../shared/model').ScriptOutcome[] = []
    for (const s of testScripts) {
      if (s.source.trim() === '') continue
      const test = await runScript({
        source: s.source,
        phase: 'test',
        request: { method: resolved.method, url: resolved.url, headers },
        response,
        session: sessionObj,
        env,
        requestName,
        sendRequest: (r) => sandboxSend(r, args)
      })
      testOutcomes.push(test)
      for (const [k, v] of Object.entries(test.sessionWrites)) session.set(k, v)
      if (test.error !== undefined || test.tests.some((t) => !t.passed)) report.errored = true
    }
    if (testOutcomes.length > 0) report.testScript = mergeOutcomes(testOutcomes)
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

/** Combine several script outcomes (folder + request level) into one. */
function mergeOutcomes(
  outcomes: import('../shared/model').ScriptOutcome[]
): import('../shared/model').ScriptOutcome {
  const merged = { tests: [], consoleLines: [], sessionWrites: {} } as import('../shared/model').ScriptOutcome
  for (const o of outcomes) {
    merged.tests.push(...o.tests)
    merged.consoleLines.push(...o.consoleLines)
    Object.assign(merged.sessionWrites, o.sessionWrites)
    if (o.error !== undefined) merged.error = merged.error ? `${merged.error}; ${o.error}` : o.error
  }
  return merged
}

/** Resolve a collection-relative (or absolute) cert path to an absolute path. */
function resolveCertPath(root: string, p: string): string {
  // Raw PEM content passes through untouched; only paths are resolved.
  if (p.startsWith('-----BEGIN')) return p
  return isAbsolute(p) ? p : join(root, p)
}

/**
 * Pick the proxy for a target URL: explicit collection config wins, else the
 * scheme-appropriate *_PROXY environment variable (the corporate default).
 * Returns undefined when the target host matches NO_PROXY, or no proxy is set.
 */
function resolveProxy(configProxy: string | undefined, targetUrl: string): string | undefined {
  let host = ''
  let isHttps = false
  try {
    const u = new URL(targetUrl)
    host = u.hostname
    isHttps = u.protocol === 'https:'
  } catch {
    /* unparseable URL — send will fail later; treat as no host */
  }
  const env = process.env
  if (host !== '' && shouldBypassProxy(host, env.NO_PROXY ?? env.no_proxy)) return undefined
  if (configProxy !== undefined && configProxy.trim() !== '') return configProxy
  const scheme = isHttps
    ? (env.HTTPS_PROXY ?? env.https_proxy)
    : (env.HTTP_PROXY ?? env.http_proxy)
  return scheme ?? env.ALL_PROXY ?? env.all_proxy
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
