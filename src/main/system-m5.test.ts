/**
 * System-level tests for the M5 feature set: exercise the real execution logic
 * the GUI triggers (OAuth2, data-driven workflows, introspection, codegen,
 * config-driven demo collection) against local servers. This is the automated
 * stand-in for the manual GUI smoke steps that don't require pixels.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseConfig } from '../core/config'
import { parseDataFile } from '../core/data'
import { parseRequestFile, requestKindForPath } from '../core/format'
import { generateCode, CODEGEN_TARGETS } from '../core/codegen'
import { INTROSPECTION_QUERY, parseIntrospection } from '../core/graphql/introspection'
import { runWorkflow } from '../core/workflow'
import { acquireToken, sendHttp } from '../engine'
import { executeRequest } from './execute'

const DEMO = join(__dirname, '..', '..', 'examples', 'demo-collection')

describe('demo collection is valid M5 material', () => {
  it('collection.json parses and carries a default header + collection script', () => {
    const parsed = parseConfig(readFileSync(join(DEMO, 'collection.json'), 'utf8'))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.config.defaultHeaders?.[0]).toEqual({ name: 'X-Freepost-Demo', value: 'true' })
    expect(parsed.config.scripts?.['pre-request']).toContain('pm.variables.set')
  })

  it('data/users.csv parses into rows', () => {
    const parsed = parseDataFile(readFileSync(join(DEMO, 'data', 'users.csv'), 'utf8'), 'users.csv')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.rows).toHaveLength(3)
    expect(parsed.rows[0]).toEqual({ USER_ID: '1', EXPECTED_NAME: 'Leanne' })
  })

  it('generates code for a demo request across all 8 targets', () => {
    const raw = readFileSync(join(DEMO, 'Get IP.curl'), 'utf8')
    const parsed = parseRequestFile(raw, requestKindForPath('Get IP.curl')!)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    for (const t of CODEGEN_TARGETS) {
      const code = generateCode(parsed.file, t.id)
      expect(code.length, t.id).toBeGreaterThan(0)
      // ${BASE_URL} survives verbatim (no accidental resolution in codegen).
      expect(code, t.id).toContain('${BASE_URL}')
    }
  })
})

describe('OAuth2 token acquisition (client_credentials)', () => {
  let server: Server
  let tokenUrl = ''
  let seenAuth = ''
  let seenBody = ''

  beforeAll(async () => {
    server = createServer((req, res) => {
      seenAuth = String(req.headers['authorization'] ?? '')
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        seenBody = body
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ access_token: 'AT-999', token_type: 'Bearer', expires_in: 3600 }))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const a = server.address()
    if (a === null || typeof a === 'string') throw new Error('no addr')
    tokenUrl = `http://127.0.0.1:${a.port}/token`
  })
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('sends Basic client auth + grant_type and parses the token with expiry', async () => {
    const token = await acquireToken(
      {
        grant: 'client_credentials',
        tokenUrl: '${TOKEN_URL}',
        clientId: 'id',
        clientSecret: 'secret',
        scope: 'read'
      },
      (s) => s.replace('${TOKEN_URL}', tokenUrl)
    )
    expect(token.accessToken).toBe('AT-999')
    expect(token.tokenType).toBe('Bearer')
    expect(token.expiresAt).toBeGreaterThan(0)
    expect(seenAuth.startsWith('Basic ')).toBe(true)
    expect(Buffer.from(seenAuth.slice(6), 'base64').toString()).toBe('id:secret')
    expect(seenBody).toContain('grant_type=client_credentials')
    expect(seenBody).toContain('scope=read')
  })
})

describe('GraphQL introspection round-trip through the engine', () => {
  let server: Server
  let url = ''

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const q = JSON.parse(body).query as string
        expect(q).toBe(INTROSPECTION_QUERY)
        res.setHeader('Content-Type', 'application/json')
        res.end(
          JSON.stringify({
            data: {
              __schema: {
                queryType: { name: 'Query' },
                mutationType: null,
                subscriptionType: null,
                types: [
                  {
                    name: 'Query',
                    kind: 'OBJECT',
                    fields: [{ name: 'me', args: [], type: { kind: 'OBJECT', name: 'User' } }]
                  },
                  { name: 'User', kind: 'OBJECT', fields: [] }
                ]
              }
            }
          })
        )
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const a = server.address()
    if (a === null || typeof a === 'string') throw new Error('no addr')
    url = `http://127.0.0.1:${a.port}/graphql`
  })
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('POSTs the introspection query and summarizes the schema', async () => {
    const res = await sendHttp({
      method: 'POST',
      url,
      headers: [{ name: 'Content-Type', value: 'application/json' }],
      bodyText: JSON.stringify({ query: INTROSPECTION_QUERY })
    })
    const schema = parseIntrospection(res.bodyText)
    expect(schema).not.toBeNull()
    expect(schema?.queryType).toBe('Query')
    expect(schema?.queries.map((f) => f.name)).toEqual(['me'])
    expect(schema?.types).toContain('User')
  })
})

describe('data-driven workflow run', () => {
  let server: Server
  let base = ''
  const seenIds: string[] = []

  beforeAll(async () => {
    server = createServer((req, res) => {
      const u = new URL(req.url ?? '', 'http://x')
      seenIds.push(u.searchParams.get('id') ?? '')
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const a = server.address()
    if (a === null || typeof a === 'string') throw new Error('no addr')
    base = `127.0.0.1:${a.port}`
  })
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('runs one iteration per data row with row values in the session', async () => {
    // Build a tiny collection on disk.
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const root = mkdtempSync(join(tmpdir(), 'freepost-dd-'))
    try {
      const { writeRequestFile } = await import('../core/format')
      mkdirSync(root, { recursive: true })
      writeFileSync(
        join(root, 'Fetch.curl'),
        writeRequestFile({
          kind: 'curl',
          frontmatter: {},
          variables: [
            { name: 'BASE_URL', defaultValue: base, required: false },
            { name: 'USER_ID', defaultValue: '0', required: false }
          ],
          http: { method: 'GET', url: 'http://${BASE_URL}/u?id=${USER_ID}', headers: [], options: {} },
          comments: []
        })
      )
      const rows = [{ USER_ID: '11' }, { USER_ID: '22' }, { USER_ID: '33' }]
      const session = new Map<string, string>()
      const iterations = []
      for (const row of rows) {
        for (const [k, v] of Object.entries(row)) session.set(k, v)
        iterations.push(
          await runWorkflow({
            workflowPath: 'wf',
            wf: { steps: [{ request: 'Fetch.curl' }] },
            execute: (rel) => executeRequest({ root, path: rel, session })
          })
        )
      }
      expect(iterations.every((it) => !it.halted)).toBe(true)
      expect(seenIds).toEqual(['11', '22', '33'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
