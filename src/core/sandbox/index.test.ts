import { describe, expect, it, vi } from 'vitest'
import type { HttpResponseModel } from '@shared/model'
import { runScript, type RunScriptArgs, type SandboxHttpRequest } from './index'

const request = {
  method: 'GET',
  url: 'https://api.example.com/users/42',
  headers: [
    { name: 'Accept', value: 'application/json' },
    { name: 'Authorization', value: 'Bearer abc' }
  ]
}

function response(over: Partial<HttpResponseModel> = {}): HttpResponseModel {
  return {
    status: 200,
    statusText: 'OK',
    headers: [{ name: 'Content-Type', value: 'application/json' }],
    bodyText: '{"email":"jo@example.com","count":1}',
    timeMs: 12,
    sizeBytes: 36,
    ...over
  }
}

function run(source: string, over: Partial<RunScriptArgs> = {}) {
  return runScript({
    source,
    phase: 'test',
    request,
    response: response(),
    session: {},
    env: {},
    ...over
  })
}

describe('pm.test', () => {
  it('records passing and failing tests, incl. chai assertions on pm.response.json()', async () => {
    const outcome = await run(`
      pm.test("has email", () => pm.expect(pm.response.json().email).to.be.a("string"));
      pm.test("count is 2", () => pm.expect(pm.response.json().count).to.equal(2));
      pm.test("after a failure tests keep running", () => pm.expect(1).to.equal(1));
    `)
    expect(outcome.error).toBeUndefined()
    expect(outcome.tests).toHaveLength(3)
    expect(outcome.tests[0]).toEqual({ name: 'has email', passed: true })
    expect(outcome.tests[1].passed).toBe(false)
    expect(outcome.tests[1].error).toContain('expected 1 to equal 2')
    expect(outcome.tests[2].passed).toBe(true)
  })

  it('awaits async test functions returning promises', async () => {
    const outcome = await run(`
      pm.test("async pass", () =>
        Promise.resolve().then(() => pm.expect(pm.response.code).to.equal(200)));
      pm.test("async fail", async () => { throw new Error("nope"); });
    `)
    expect(outcome.tests).toHaveLength(2)
    expect(outcome.tests[0].passed).toBe(true)
    expect(outcome.tests[1].passed).toBe(false)
    expect(outcome.tests[1].error).toBe('nope')
  })
})

describe('pm.response', () => {
  it('to.have.status passes on match and throws a chai-style error on mismatch', async () => {
    const outcome = await run(`
      pm.test("status 200", () => pm.response.to.have.status(200));
      pm.test("status 404", () => pm.response.to.have.status(404));
    `)
    expect(outcome.tests[0].passed).toBe(true)
    expect(outcome.tests[1].passed).toBe(false)
    expect(outcome.tests[1].error).toContain('expected response to have status code 404 but got 200')
  })

  it('exposes code/status/responseTime/text/headers and to.have.header/jsonBody', async () => {
    const outcome = await run(`
      pm.test("shape", () => {
        pm.expect(pm.response.code).to.equal(200);
        pm.expect(pm.response.status).to.equal("OK");
        pm.expect(pm.response.responseTime).to.equal(12);
        pm.expect(pm.response.text()).to.contain("jo@example.com");
        pm.expect(pm.response.headers.get("content-type")).to.equal("application/json");
      });
      pm.test("has content-type header", () => pm.response.to.have.header("Content-Type"));
      pm.test("missing header fails", () => pm.response.to.have.header("X-Nope"));
      pm.test("json body", () => pm.response.to.have.jsonBody());
    `)
    expect(outcome.tests.map((t) => t.passed)).toEqual([true, true, false, true])
    expect(outcome.tests[2].error).toContain("expected response to have header with key 'X-Nope'")
  })

  it('json() throws a helpful error when the body is not JSON', async () => {
    const outcome = await run(
      `pm.test("bad json", () => pm.response.json());`,
      { response: response({ bodyText: 'not json' }) }
    )
    expect(outcome.tests[0].passed).toBe(false)
    expect(outcome.tests[0].error).toContain('not valid JSON')
  })

  it('is unavailable in pre-request scripts with a helpful error', async () => {
    const outcome = await run(`const c = pm.response.code;`, {
      phase: 'pre-request',
      response: undefined
    })
    expect(outcome.error).toContain('pm.response is only available in test scripts')
    expect(outcome.error).toContain('pre-request')
  })
})

describe('variables', () => {
  it('get() reads session first, then env, then undefined', async () => {
    const outcome = await run(
      `
      pm.test("precedence", () => {
        pm.expect(pm.variables.get("a")).to.equal("from-session");
        pm.expect(pm.variables.get("b")).to.equal("from-env");
        pm.expect(pm.variables.get("missing")).to.equal(undefined);
        pm.expect(pm.environment.get("a")).to.equal("from-session");
        pm.expect(pm.globals.get("b")).to.equal("from-env");
        pm.expect(pm.collectionVariables.get("a")).to.equal("from-session");
      });
      `,
      { session: { a: 'from-session' }, env: { a: 'from-env', b: 'from-env' } }
    )
    expect(outcome.error).toBeUndefined()
    expect(outcome.tests[0].passed).toBe(true)
  })

  it('set() on every scope collects session writes, last-write-wins, stringified', async () => {
    const session = { existing: 'x' }
    const outcome = await run(
      `
      pm.variables.set("n", 42);
      pm.environment.set("e", "env-write");
      pm.globals.set("g", { deep: true });
      pm.collectionVariables.set("c", "cv");
      pm.variables.set("k", "first");
      pm.globals.set("k", "second");
      pm.test("read-after-write", () => pm.expect(pm.variables.get("n")).to.equal("42"));
      `,
      { session }
    )
    expect(outcome.sessionWrites).toEqual({
      n: '42',
      e: 'env-write',
      g: '{"deep":true}',
      c: 'cv',
      k: 'second'
    })
    expect(outcome.tests[0].passed).toBe(true)
    // input session snapshot is never mutated
    expect(session).toEqual({ existing: 'x' })
  })
})

describe('pm.request and pm.info', () => {
  it('exposes method, url, and header get/add/toObject', async () => {
    const outcome = await run(`
      pm.test("request surface", () => {
        pm.expect(pm.request.method).to.equal("GET");
        pm.expect(pm.request.url).to.equal("https://api.example.com/users/42");
        pm.expect(pm.request.headers.get("accept")).to.equal("application/json");
        pm.request.headers.add({ key: "X-Trace", value: "t-1" });
        pm.expect(pm.request.headers.toObject()["X-Trace"]).to.equal("t-1");
        pm.expect(pm.info.iteration).to.equal(0);
        pm.expect(pm.info.requestName).to.equal("Get user");
      });
    `, { requestName: 'Get user' })
    expect(outcome.tests[0]).toEqual({ name: 'request surface', passed: true })
  })
})

describe('console capture', () => {
  it('captures log/info/warn/error, inspecting non-strings', async () => {
    const outcome = await run(`
      console.log("hello", { a: 1 });
      console.info("info line");
      console.warn("warn line", [1, 2]);
      console.error("error line");
    `)
    expect(outcome.consoleLines).toEqual([
      'hello { a: 1 }',
      'info line',
      'warn line [ 1, 2 ]',
      'error line'
    ])
  })
})

describe('error handling', () => {
  it('returns uncaught top-level errors and keeps tests recorded so far', async () => {
    const outcome = await run(`
      pm.test("before the crash", () => pm.expect(true).to.be.true);
      throw new Error("boom");
    `)
    expect(outcome.error).toBe('boom')
    expect(outcome.tests).toEqual([{ name: 'before the crash', passed: true }])
  })

  it('times out busy scripts with a tight timeout', async () => {
    const outcome = await run(
      `const start = Date.now(); while (Date.now() - start < 60000) {}`,
      { timeoutMs: 200 }
    )
    expect(outcome.error).toBe('Script timed out')
  })
})

describe('pm.sendRequest', () => {
  const sent: SandboxHttpRequest[] = []
  function fakeSendRequest(res: HttpResponseModel) {
    return vi.fn(async (req: SandboxHttpRequest) => {
      sent.push(req)
      return res
    })
  }

  it('throws a clear error when no handler is injected', async () => {
    const outcome = await run(`pm.sendRequest("https://example.com/");`)
    expect(outcome.error).toContain('pm.sendRequest is not available')
  })

  it('supports callback style; the response has the pm.response shape', async () => {
    sent.length = 0
    const sendRequest = fakeSendRequest(
      response({ status: 201, statusText: 'Created', bodyText: '{"id":"abc"}' })
    )
    const outcome = await run(
      `
      pm.sendRequest("https://auth.example.com/token", (err, res) => {
        pm.test("no error", () => pm.expect(err).to.equal(null));
        pm.test("created", () => res.to.have.status(201));
        pm.variables.set("id", res.json().id);
      });
      `,
      { sendRequest }
    )
    expect(outcome.error).toBeUndefined()
    expect(outcome.tests.map((t) => t.passed)).toEqual([true, true])
    expect(outcome.sessionWrites.id).toBe('abc')
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(sent[0]).toEqual({
      url: 'https://auth.example.com/token',
      method: 'GET',
      headers: undefined,
      body: undefined
    })
  })

  it('supports await style inside async tests and normalizes request objects', async () => {
    sent.length = 0
    const sendRequest = fakeSendRequest(response({ bodyText: '{"ok":true}' }))
    const outcome = await run(
      `
      pm.test("await style", async () => {
        const res = await pm.sendRequest({
          url: "https://api.example.com/echo",
          method: "POST",
          headers: { "X-One": "1" },
          body: "payload"
        });
        pm.expect(res.code).to.equal(200);
        pm.expect(res.json().ok).to.equal(true);
      });
      `,
      { sendRequest }
    )
    expect(outcome.error).toBeUndefined()
    expect(outcome.tests[0].passed).toBe(true)
    expect(sent[0]).toEqual({
      url: 'https://api.example.com/echo',
      method: 'POST',
      headers: { 'X-One': '1' },
      body: 'payload'
    })
  })

  it('passes delegate failures to the callback as err', async () => {
    const sendRequest = vi.fn(async () => {
      throw new Error('connection refused')
    })
    const outcome = await run(
      `
      pm.sendRequest("https://down.example.com/", (err, res) => {
        pm.test("errored", () => {
          pm.expect(res).to.equal(undefined);
          pm.expect(err.message).to.equal("connection refused");
        });
      });
      `,
      { sendRequest }
    )
    expect(outcome.error).toBeUndefined()
    expect(outcome.tests[0].passed).toBe(true)
  })

  it('works in pre-request scripts (no pm.response needed)', async () => {
    const sendRequest = fakeSendRequest(response({ bodyText: '{"token":"t-123"}' }))
    const outcome = await run(
      `
      pm.sendRequest("https://auth.example.com/token", (err, res) => {
        pm.variables.set("token", res.json().token);
      });
      `,
      { phase: 'pre-request', response: undefined, sendRequest }
    )
    expect(outcome.error).toBeUndefined()
    expect(outcome.sessionWrites.token).toBe('t-123')
  })
})
