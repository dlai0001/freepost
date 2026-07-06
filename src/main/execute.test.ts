import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeRequestFile } from '../core/format'
import type { RequestFile } from '../shared/model'
import { executeRequest } from './execute'
import { runWorkflow } from '../core/workflow'

let server: Server
let baseUrl = ''
let root = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/login') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ token: 'tok-123' }))
      return
    }
    if (req.url === '/me') {
      const auth = req.headers['authorization']
      if (auth !== 'Bearer tok-123') {
        res.statusCode = 401
        res.end('{"error":"unauthorized"}')
        return
      }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ name: 'dave' }))
      return
    }
    res.statusCode = 404
    res.end('not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no address')
  baseUrl = `127.0.0.1:${addr.port}`
  root = mkdtempSync(join(tmpdir(), 'freepost-exec-'))
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(root, { recursive: true, force: true })
})

function writeRequest(rel: string, file: RequestFile): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, writeRequestFile(file))
}

describe('executeRequest end-to-end', () => {
  it('runs a request with test script capturing a session variable', async () => {
    writeRequest('Login.curl', {
      kind: 'curl',
      frontmatter: {
        scripts: {
          test: [
            'pm.test("status 200", () => pm.response.to.have.status(200));',
            'pm.variables.set("TOKEN", pm.response.json().token);'
          ].join('\n')
        }
      },
      variables: [{ name: 'BASE_URL', defaultValue: baseUrl, required: false }],
      http: { method: 'GET', url: 'http://${BASE_URL}/login', headers: [], options: {} },
      comments: []
    })
    const session = new Map<string, string>()
    const report = await executeRequest({ root, path: 'Login.curl', session })
    expect(report.errored).toBe(false)
    expect(report.response?.status).toBe(200)
    expect(report.testScript?.tests).toEqual([
      { name: 'status 200', passed: true }
    ])
    expect(session.get('TOKEN')).toBe('tok-123')
    expect(report.resolvedUrl).toBe(`http://${baseUrl}/login`)
  })

  it('uses session variables in a following request (three-tier resolution)', async () => {
    writeRequest('Me.curl', {
      kind: 'curl',
      frontmatter: {
        variables: { TOKEN: { secret: true } },
        scripts: { test: 'pm.test("has name", () => pm.expect(pm.response.json().name).to.equal("dave"));' }
      },
      variables: [
        { name: 'BASE_URL', defaultValue: baseUrl, required: false },
        { name: 'TOKEN', required: true }
      ],
      http: {
        method: 'GET',
        url: 'http://${BASE_URL}/me',
        headers: [{ name: 'Authorization', value: 'Bearer ${TOKEN}' }],
        options: {}
      },
      comments: []
    })
    const session = new Map<string, string>([['TOKEN', 'tok-123']])
    const report = await executeRequest({ root, path: 'Me.curl', session })
    expect(report.errored).toBe(false)
    expect(report.testScript?.tests[0]).toEqual({ name: 'has name', passed: true })
  })

  it('blocks send and reports unresolved required variables', async () => {
    const report = await executeRequest({ root, path: 'Me.curl', session: new Map() })
    expect(report.errored).toBe(true)
    expect(report.unresolved).toEqual(['TOKEN'])
    expect(report.response).toBeUndefined()
  })

  it('marks 4xx as errored and appends history under .freepost', async () => {
    writeRequest('Unauthorized.curl', {
      kind: 'curl',
      frontmatter: {},
      variables: [{ name: 'BASE_URL', defaultValue: baseUrl, required: false }],
      http: { method: 'GET', url: 'http://${BASE_URL}/me', headers: [], options: {} },
      comments: []
    })
    const report = await executeRequest({ root, path: 'Unauthorized.curl', session: new Map() })
    expect(report.errored).toBe(true)
    expect(report.response?.status).toBe(401)
    const hist = join(root, '.freepost', 'history', 'requests.jsonl')
    expect(existsSync(hist)).toBe(true)
    expect(readFileSync(join(root, '.freepost', '.gitignore'), 'utf8')).toBe('*\n')
  })

  it('drives a workflow: expected-error continues, session flows between steps', async () => {
    const session = new Map<string, string>()
    const report = await runWorkflow({
      workflowPath: 'smoke.workflow.json',
      wf: {
        description: 'login flow',
        steps: [
          { request: 'Unauthorized.curl', expectError: true }, // 401 expected
          { request: 'Login.curl' }, // captures token into session
          { request: 'Me.curl' } // uses ${TOKEN} from session
        ]
      },
      execute: (rel) => executeRequest({ root, path: rel, session })
    })
    expect(report.halted).toBe(false)
    expect(report.steps.map((s) => s.status)).toEqual(['expected-error', 'passed', 'passed'])
  })
})
