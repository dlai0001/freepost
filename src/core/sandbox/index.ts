/**
 * Postman-compatible script sandbox (pm.* API) on top of node:vm.
 *
 * Runs pre-request and test scripts against a frozen contract
 * (ScriptOutcome / TestResult / HttpResponseModel — see src/shared/model.ts)
 * and PLAN.md's variable-resolution model: every pm.*.set() call is collected
 * as a *session write* (the three-tier session > environment > request-params
 * scheme); the input session snapshot is never mutated.
 *
 * NETWORK FENCE: this module contains no network APIs. pm.sendRequest is
 * delegated to an injected callback supplied by the caller (src/engine).
 */
import * as vm from 'node:vm'
import { inspect } from 'node:util'
import * as chai from 'chai'
import type { HttpResponseModel, ScriptOutcome, TestResult } from '@shared/model'

/* --------------------------------- types --------------------------------- */

/** Shape handed to the injected sendRequest delegate (module-local). */
export interface SandboxHttpRequest {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
}

export interface RunScriptArgs {
  source: string
  phase: 'pre-request' | 'test'
  request: { method: string; url: string; headers: { name: string; value: string }[] }
  /** Required when phase === 'test'. */
  response?: HttpResponseModel
  /** Snapshot; never mutated — writes are collected into sessionWrites. */
  session: Record<string, string>
  env: Record<string, string>
  /** Delegate for pm.sendRequest. Absent => pm.sendRequest throws. */
  sendRequest?: (req: SandboxHttpRequest) => Promise<HttpResponseModel>
  /** Whole-script budget in milliseconds. Default 10s. */
  timeoutMs?: number
  /** Surfaced as pm.info.requestName (not part of the shared contract). */
  requestName?: string
}

class ScriptTimeoutError extends Error {
  constructor() {
    super('Script timed out')
    this.name = 'ScriptTimeoutError'
  }
}

const DEFAULT_TIMEOUT_MS = 10_000

/* -------------------------------- helpers -------------------------------- */

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') {
    return (e as { message: string }).message
  }
  return typeof e === 'string' ? e : inspect(e)
}

function stringifyValue(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return String(v)
  if (typeof v === 'object') {
    try {
      const json = JSON.stringify(v)
      if (json !== undefined) return json
    } catch {
      /* circular etc. — fall through */
    }
  }
  return String(v)
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    (typeof v === 'object' || typeof v === 'function') &&
    v !== null &&
    typeof (v as { then?: unknown }).then === 'function'
  )
}

/** pm.response wrapper — also handed to pm.sendRequest callbacks. */
function makePmResponse(res: HttpResponseModel) {
  const headers = {
    get(name: string): string | undefined {
      const wanted = String(name).toLowerCase()
      return res.headers.find((h) => h.name.toLowerCase() === wanted)?.value
    }
  }
  return {
    code: res.status,
    status: res.statusText,
    responseTime: res.timeMs,
    headers,
    text: () => res.bodyText,
    json: (): unknown => {
      try {
        return JSON.parse(res.bodyText)
      } catch (e) {
        throw new Error(`pm.response.json(): response body is not valid JSON (${errorMessage(e)})`)
      }
    },
    to: {
      have: {
        status(expected: number | string): void {
          if (typeof expected === 'string') {
            if (res.statusText !== expected) {
              throw new chai.AssertionError(
                `expected response to have status reason '${expected}' but got '${res.statusText}'`
              )
            }
          } else if (res.status !== expected) {
            throw new chai.AssertionError(
              `expected response to have status code ${expected} but got ${res.status}`
            )
          }
        },
        header(name: string): void {
          if (headers.get(name) === undefined) {
            throw new chai.AssertionError(`expected response to have header with key '${String(name)}'`)
          }
        },
        jsonBody(): void {
          try {
            JSON.parse(res.bodyText)
          } catch {
            throw new chai.AssertionError('expected response body to be valid JSON')
          }
        }
      }
    }
  }
}

function normalizeSendRequestArg(reqOrUrl: unknown): SandboxHttpRequest {
  if (typeof reqOrUrl === 'string') return { url: reqOrUrl, method: 'GET' }
  if (reqOrUrl && typeof reqOrUrl === 'object') {
    const r = reqOrUrl as Record<string, unknown>
    if (typeof r.url !== 'string' || r.url === '') {
      throw new Error("pm.sendRequest: request object must have a string 'url' property")
    }
    const headers: Record<string, string> = {}
    const rawHeader = r.header ?? r.headers
    if (Array.isArray(rawHeader)) {
      // Postman style: [{ key, value }]
      for (const h of rawHeader) {
        if (h && typeof h === 'object') {
          const hh = h as { key?: unknown; name?: unknown; value?: unknown }
          const key = hh.key ?? hh.name
          if (key !== undefined) headers[String(key)] = String(hh.value ?? '')
        }
      }
    } else if (rawHeader && typeof rawHeader === 'object') {
      for (const [k, v] of Object.entries(rawHeader)) headers[k] = String(v)
    }
    let body: string | undefined
    if (typeof r.body === 'string') body = r.body
    else if (r.body && typeof r.body === 'object') {
      // Postman style: { mode: 'raw', raw: '...' }
      const b = r.body as { raw?: unknown }
      body = typeof b.raw === 'string' ? b.raw : stringifyValue(r.body)
    }
    return {
      url: r.url,
      method: typeof r.method === 'string' ? r.method : 'GET',
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body
    }
  }
  throw new Error('pm.sendRequest: expected a URL string or a request object')
}

function microtaskGrace(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

async function withDeadline<T>(p: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new ScriptTimeoutError()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ScriptTimeoutError()), remaining)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Await every tracked promise, giving the script a microtask grace period each
 * round so work scheduled from settled promises (chained pm.test / sendRequest
 * calls) is picked up too. Throws ScriptTimeoutError past the deadline.
 */
async function settlePending(pending: Set<Promise<unknown>>, deadline: number): Promise<void> {
  // Round cap is a safety net; the deadline is the real bound.
  for (let round = 0; round < 10_000; round++) {
    if (Date.now() > deadline && pending.size > 0) throw new ScriptTimeoutError()
    await microtaskGrace()
    if (pending.size === 0) return
    const batch = [...pending]
    await withDeadline(Promise.allSettled(batch), deadline)
    for (const p of batch) pending.delete(p)
  }
}

/* -------------------------------- runScript ------------------------------- */

export async function runScript(args: RunScriptArgs): Promise<ScriptOutcome> {
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs

  const tests: TestResult[] = []
  const consoleLines: string[] = []
  const sessionWrites: Record<string, string> = {}
  const pending = new Set<Promise<unknown>>()
  let scriptError: string | undefined
  const recordError = (e: unknown) => {
    if (scriptError === undefined) scriptError = errorMessage(e)
  }

  /* variables: session (with this run's writes overlaid) > env */
  const getVar = (name: unknown): string | undefined => {
    const key = String(name)
    if (key in sessionWrites) return sessionWrites[key]
    if (key in args.session) return args.session[key]
    if (key in args.env) return args.env[key]
    return undefined
  }
  const setVar = (name: unknown, value: unknown): void => {
    sessionWrites[String(name)] = stringifyValue(value)
  }
  // Postman-compat shim (PLAN.md): every scope writes to the session.
  const variableScope = { get: getVar, set: setVar }

  /* pm.request */
  const requestHeaders = args.request.headers.map((h) => ({ name: h.name, value: h.value }))
  const pmRequest = {
    method: args.request.method,
    url: args.request.url,
    headers: {
      get(name: string): string | undefined {
        const wanted = String(name).toLowerCase()
        return requestHeaders.find((h) => h.name.toLowerCase() === wanted)?.value
      },
      add(header: { key: string; value: string }): void {
        requestHeaders.push({ name: String(header.key), value: String(header.value) })
      },
      toObject(): Record<string, string> {
        const out: Record<string, string> = {}
        for (const h of requestHeaders) out[h.name] = h.value
        return out
      }
    }
  }

  /* pm.test */
  const pmTest = (name: unknown, fn?: () => unknown): void => {
    const result: TestResult = { name: String(name), passed: true }
    tests.push(result)
    if (typeof fn !== 'function') return
    try {
      const ret = fn()
      if (isThenable(ret)) {
        pending.add(
          Promise.resolve(ret).then(
            () => undefined,
            (e) => {
              result.passed = false
              result.error = errorMessage(e)
            }
          )
        )
      }
    } catch (e) {
      result.passed = false
      result.error = errorMessage(e)
    }
  }

  /* pm.sendRequest */
  const pmSendRequest = (reqOrUrl: unknown, callback?: (err: unknown, res?: unknown) => void) => {
    const delegate = args.sendRequest
    if (!delegate) {
      throw new Error(
        'pm.sendRequest is not available here: no sendRequest handler was provided to the sandbox'
      )
    }
    const req = normalizeSendRequestArg(reqOrUrl)
    const promise = delegate(req).then(
      (res) => {
        const wrapped = makePmResponse(res)
        if (typeof callback === 'function') callback(null, wrapped)
        return wrapped
      },
      (err) => {
        if (typeof callback === 'function') {
          callback(err)
          return undefined
        }
        throw err
      }
    )
    if (typeof callback === 'function') {
      // Any rejection here means the user callback itself threw.
      pending.add(promise.catch(recordError))
    } else {
      // Promise style: the script owns the rejection (await / .catch).
      pending.add(promise.catch(() => undefined))
    }
    return promise
  }

  /* console */
  const format = (parts: unknown[]): string =>
    parts.map((p) => (typeof p === 'string' ? p : inspect(p))).join(' ')
  const sandboxConsole = {
    log: (...parts: unknown[]) => void consoleLines.push(format(parts)),
    info: (...parts: unknown[]) => void consoleLines.push(format(parts)),
    warn: (...parts: unknown[]) => void consoleLines.push(format(parts)),
    error: (...parts: unknown[]) => void consoleLines.push(format(parts)),
    debug: (...parts: unknown[]) => void consoleLines.push(format(parts))
  }

  /* pm */
  const pm: Record<string, unknown> = {
    request: pmRequest,
    variables: variableScope,
    environment: variableScope,
    globals: variableScope,
    collectionVariables: variableScope,
    test: pmTest,
    expect: chai.expect,
    info: { requestName: args.requestName ?? '', iteration: 0 },
    sendRequest: pmSendRequest
  }
  if (args.phase === 'test') {
    if (!args.response) {
      throw new TypeError("runScript: 'response' is required when phase is 'test'")
    }
    pm.response = makePmResponse(args.response)
  } else {
    Object.defineProperty(pm, 'response', {
      get() {
        throw new Error(
          "pm.response is only available in test scripts — this is a pre-request script, so no response exists yet"
        )
      },
      enumerable: false
    })
  }

  /* run */
  const context = vm.createContext({ pm, console: sandboxConsole })
  let timedOut = false
  try {
    vm.runInContext(args.source, context, { timeout: timeoutMs, filename: 'freepost-script.js' })
  } catch (e) {
    if ((e as { code?: string } | null)?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      timedOut = true
      scriptError = 'Script timed out'
    } else {
      recordError(e)
    }
  }

  if (!timedOut) {
    try {
      await settlePending(pending, deadline)
    } catch (e) {
      if (e instanceof ScriptTimeoutError) scriptError = 'Script timed out'
      else recordError(e)
    }
  }

  const outcome: ScriptOutcome = { tests, consoleLines, sessionWrites }
  if (scriptError !== undefined) outcome.error = scriptError
  return outcome
}
