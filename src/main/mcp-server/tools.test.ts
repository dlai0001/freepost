/**
 * The MCP tool surface, driven through a real SDK client over an in-memory
 * transport — so these tests exercise the same schema validation, isError
 * plumbing and serialization a real AI client would hit, not just the handlers.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AddressInfo } from 'node:net'
import { buildSchema, graphql } from 'graphql'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createFreepostMcpServer } from './index'
import type { ServerContext } from './context'

/* ------------------------------- harness -------------------------------- */

let root: string
let client: Client
let close: () => Promise<void>

/** Text of a tool result (every tool in this surface returns one text block). */
function textOf(r: unknown): string {
  const content = (r as { content?: { type: string; text: string }[] }).content
  return content?.[0]?.text ?? ''
}

async function connect(overrides: Partial<ServerContext> = {}): Promise<void> {
  const server = createFreepostMcpServer({
    getRoot: () => root,
    readonly: false,
    allowRun: true,
    allowMcpSpawn: () => true,
    session: new Map<string, string>(),
    ...overrides
  })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'test', version: '1.0.0' })
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
  close = async () => {
    await client.close()
    await server.close()
  }
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const r = await client.callTool({ name, arguments: args })
  return { text: textOf(r), isError: r.isError === true }
}

const CURL_FILE = `#!/usr/bin/env bash
# ---
# description: Get a thing
# ---

BASE_URL="\${BASE_URL:-http://example.com}"

curl --request GET \\
  --url "\${BASE_URL}/thing"
`

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'freepost-mcp-'))
})

afterEach(async () => {
  await close?.()
  await rm(root, { recursive: true, force: true })
})

/* ------------------------------ read tools ------------------------------- */

describe('list_collection / read_request', () => {
  it('lists requests, folders and non-secret environments', async () => {
    mkdirSync(join(root, 'Users'))
    writeFileSync(join(root, 'Users', 'Get thing.curl'), CURL_FILE)
    mkdirSync(join(root, 'environments'))
    writeFileSync(join(root, 'environments', 'local.env.json'), '{"BASE_URL":"http://localhost"}')
    writeFileSync(join(root, 'environments', 'secrets.local.env.json'), '{"TOKEN":"hunter2"}')
    await connect()

    const { text } = await call('list_collection')
    expect(text).toContain('Users/')
    expect(text).toContain('Users/Get thing.curl')
    expect(text).toContain('[curl]')
    expect(text).toContain('environments/local.env.json')
    // The git-ignored secret env is never advertised.
    expect(text).not.toContain('secrets.local.env.json')
  })

  it('reads a request and reports that it parses', async () => {
    writeFileSync(join(root, 'Get thing.curl'), CURL_FILE)
    await connect()
    const { text, isError } = await call('read_request', { path: 'Get thing.curl' })
    expect(isError).toBe(false)
    expect(text).toContain('parses OK')
    expect(text).toContain('curl --request GET')
  })

  it('surfaces parse errors with line numbers instead of failing', async () => {
    writeFileSync(join(root, 'Broken.curl'), '#!/usr/bin/env bash\n\nwget http://example.com\n')
    await connect()
    const { text } = await call('read_request', { path: 'Broken.curl' })
    expect(text).toContain('PARSE ERRORS')
    expect(text).toMatch(/line \d+:/)
  })

  it('reports a missing file as a tool error', async () => {
    await connect()
    const { text, isError } = await call('read_request', { path: 'Nope.curl' })
    expect(isError).toBe(true)
    expect(text).toContain('No such file')
  })
})

/* ------------------------------ write_request ---------------------------- */

describe('write_request', () => {
  it('creates a file, canonicalizes it, and creates parent folders', async () => {
    await connect()
    const { text, isError } = await call('write_request', {
      path: 'Deep/Nested/New thing.curl',
      // Deliberately non-canonical: one line, no frontmatter block.
      content: `#!/usr/bin/env bash\n\ncurl --request POST --url 'http://example.com/x' --header 'Accept: application/json'\n`
    })
    expect(isError).toBe(false)
    expect(text).toContain('Created Deep/Nested/New thing.curl')

    const onDisk = readFileSync(join(root, 'Deep/Nested/New thing.curl'), 'utf8')
    // Canonical form: one flag per line with continuations.
    expect(onDisk).toContain('curl --request POST \\\n')
    expect(onDisk).toContain("  --url 'http://example.com/x'")
    // What the caller gets back is what landed on disk.
    expect(text).toContain(onDisk)
  })

  it('says "Updated" when overwriting', async () => {
    writeFileSync(join(root, 'Get thing.curl'), CURL_FILE)
    await connect()
    const { text } = await call('write_request', { path: 'Get thing.curl', content: CURL_FILE })
    expect(text).toContain('Updated Get thing.curl')
  })

  it('writes nothing on a parse error and explains why', async () => {
    await connect()
    const { text, isError } = await call('write_request', {
      path: 'Bad.curl',
      content: 'this is not a request file'
    })
    expect(isError).toBe(true)
    expect(text).toContain('Parse error — nothing was written')
    expect(text).toContain('get_format_spec')
    expect(existsSync(join(root, 'Bad.curl'))).toBe(false)
  })

  it('rejects an unknown extension', async () => {
    await connect()
    const { text, isError } = await call('write_request', { path: 'thing.txt', content: CURL_FILE })
    expect(isError).toBe(true)
    expect(text).toContain('Not a request file')
  })

  it('round-trips a GraphQL request (graphql frontmatter + matching body)', async () => {
    await connect()
    const spec = await call('get_format_spec', { kind: 'graphql' })
    const starter = spec.text.match(/```bash\n([\s\S]*?)```/)![1]

    const w = await call('write_request', { path: 'GraphQL/Users.curl', content: starter })
    expect(w.isError).toBe(false)
    const onDisk = readFileSync(join(root, 'GraphQL/Users.curl'), 'utf8')
    // The graphql block survives, and the --data body still matches it.
    expect(onDisk).toContain('# graphql:')
    expect(onDisk).toContain('query Users')
    expect(onDisk).toContain('--data')
    // Writing the canonical text again is a no-op — the format is stable.
    const again = await call('write_request', { path: 'GraphQL/Users.curl', content: onDisk })
    expect(again.isError).toBe(false)
    expect(readFileSync(join(root, 'GraphQL/Users.curl'), 'utf8')).toBe(onDisk)
  })

  it('never persists a literal default for a secret variable', async () => {
    await connect()
    const { isError } = await call('write_request', {
      path: 'Secret.curl',
      content: `#!/usr/bin/env bash
# ---
# variables:
#   TOKEN:
#     secret: true
# ---

TOKEN="\${TOKEN:-super-secret-value}"

curl --request GET \\
  --url 'http://example.com/x' \\
  --header "Authorization: Bearer \${TOKEN}"
`
    })
    expect(isError).toBe(false)
    const onDisk = readFileSync(join(root, 'Secret.curl'), 'utf8')
    expect(onDisk).not.toContain('super-secret-value')
    // Stripped to a required variable with no default.
    expect(onDisk).toContain('TOKEN="${TOKEN:?}"')
  })
})

/* ------------------------------- path guard ------------------------------ */

describe('path guard', () => {
  // Every tool that accepts a path must reject these — a guard that covers only
  // some of the surface is not a guard.
  const escapes = [
    ['parent traversal', '../outside.curl'],
    ['deep traversal', 'a/b/../../../outside.curl'],
    ['absolute path', '/etc/passwd'],
    ['freepost internals', '.freepost/history/requests.jsonl'],
    ['git internals', '.git/config'],
    ['secret env', 'environments/secrets.local.env.json']
  ] as const

  for (const [label, path] of escapes) {
    it(`read_request rejects ${label}`, async () => {
      await connect()
      const { text, isError } = await call('read_request', { path })
      expect(isError).toBe(true)
      expect(text).toMatch(/escapes the collection|not allowed|Refusing to touch/)
    })

    it(`write_request rejects ${label}`, async () => {
      await connect()
      const { isError } = await call('write_request', { path, content: CURL_FILE })
      expect(isError).toBe(true)
    })

    it(`delete_path rejects ${label}`, async () => {
      await connect()
      const { isError } = await call('delete_path', { path })
      expect(isError).toBe(true)
    })
  }

  it('move_path guards both ends', async () => {
    writeFileSync(join(root, 'Get thing.curl'), CURL_FILE)
    await connect()
    const out = await call('move_path', { from: 'Get thing.curl', to: '../escaped.curl' })
    expect(out.isError).toBe(true)
    const inbound = await call('move_path', { from: '../../etc/hosts', to: 'Copied.curl' })
    expect(inbound.isError).toBe(true)
    // The source is untouched by the failed attempts.
    expect(existsSync(join(root, 'Get thing.curl'))).toBe(true)
  })

  it('refuses to operate on the collection root', async () => {
    await connect()
    for (const path of ['.', '']) {
      const { isError } = await call('delete_path', { path })
      expect(isError).toBe(true)
    }
  })
})

/* ------------------------------ move / delete ---------------------------- */

describe('move_path / delete_path', () => {
  it('renames a request', async () => {
    writeFileSync(join(root, 'Old name.curl'), CURL_FILE)
    await connect()
    const { isError } = await call('move_path', { from: 'Old name.curl', to: 'Sub/New name.curl' })
    expect(isError).toBe(false)
    expect(existsSync(join(root, 'Old name.curl'))).toBe(false)
    expect(existsSync(join(root, 'Sub/New name.curl'))).toBe(true)
  })

  it('will not clobber an existing destination', async () => {
    writeFileSync(join(root, 'A.curl'), CURL_FILE)
    writeFileSync(join(root, 'B.curl'), CURL_FILE)
    await connect()
    const { text, isError } = await call('move_path', { from: 'A.curl', to: 'B.curl' })
    expect(isError).toBe(true)
    expect(text).toContain('already exists')
    expect(existsSync(join(root, 'A.curl'))).toBe(true)
  })

  it('deletes a file and a folder', async () => {
    mkdirSync(join(root, 'Folder'))
    writeFileSync(join(root, 'Folder', 'A.curl'), CURL_FILE)
    writeFileSync(join(root, 'B.curl'), CURL_FILE)
    await connect()

    expect((await call('delete_path', { path: 'B.curl' })).isError).toBe(false)
    expect(existsSync(join(root, 'B.curl'))).toBe(false)

    expect((await call('delete_path', { path: 'Folder' })).isError).toBe(false)
    expect(existsSync(join(root, 'Folder'))).toBe(false)
  })
})

/* -------------------------------- readonly ------------------------------- */

describe('--readonly', () => {
  it('refuses every mutating tool but still reads', async () => {
    writeFileSync(join(root, 'Get thing.curl'), CURL_FILE)
    await connect({ readonly: true })

    for (const [name, args] of [
      ['write_request', { path: 'New.curl', content: CURL_FILE }],
      ['move_path', { from: 'Get thing.curl', to: 'Other.curl' }],
      ['delete_path', { path: 'Get thing.curl' }],
      ['import_openapi', { spec: '{}' }],
      ['write_environment', { name: 'environments/x.env.json', vars: {} }]
    ] as const) {
      const { text, isError } = await call(name, args as Record<string, unknown>)
      expect(isError, `${name} should be refused`).toBe(true)
      expect(text).toContain('read-only')
    }

    expect((await call('read_request', { path: 'Get thing.curl' })).isError).toBe(false)
    // Nothing was actually mutated.
    expect(existsSync(join(root, 'Get thing.curl'))).toBe(true)
    expect(existsSync(join(root, 'New.curl'))).toBe(false)
  })

  it('still lists the mutating tools, so the client sees a stable surface', async () => {
    await connect({ readonly: true })
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toContain('write_request')
    expect(names).toHaveLength(11)
  })
})

/* ------------------------------ environments ----------------------------- */

describe('environments', () => {
  it('lists and reads non-secret environments', async () => {
    mkdirSync(join(root, 'environments'))
    writeFileSync(join(root, 'environments', 'local.env.json'), '{"BASE_URL":"http://localhost:3010"}')
    await connect()

    expect((await call('read_environment')).text).toContain('environments/local.env.json')
    const read = await call('read_environment', { name: 'environments/local.env.json' })
    expect(read.text).toContain('http://localhost:3010')
  })

  it('refuses to read or write a *.local.env.json', async () => {
    mkdirSync(join(root, 'environments'))
    writeFileSync(join(root, 'environments', 'secrets.local.env.json'), '{"TOKEN":"hunter2"}')
    await connect()

    const read = await call('read_environment', { name: 'environments/secrets.local.env.json' })
    expect(read.isError).toBe(true)
    expect(read.text).not.toContain('hunter2')

    const write = await call('write_environment', {
      name: 'environments/secrets.local.env.json',
      vars: { X: '1' }
    })
    expect(write.isError).toBe(true)
    // The original secret file is untouched.
    expect(readFileSync(join(root, 'environments/secrets.local.env.json'), 'utf8')).toContain('hunter2')
  })

  it('writes an environment', async () => {
    await connect()
    const { isError } = await call('write_environment', {
      name: 'environments/local.env.json',
      vars: { BASE_URL: 'http://localhost:3010', TIMEOUT: '30' }
    })
    expect(isError).toBe(false)
    const parsed = JSON.parse(readFileSync(join(root, 'environments/local.env.json'), 'utf8'))
    expect(parsed).toEqual({ BASE_URL: 'http://localhost:3010', TIMEOUT: '30' })
  })

  it('rejects a name that is not an env file', async () => {
    await connect()
    const { isError } = await call('write_environment', { name: 'environments/local.json', vars: {} })
    expect(isError).toBe(true)
  })
})

/* ----------------------------- import_openapi ---------------------------- */

const SPEC = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Pets', version: '1.0.0' },
  servers: [{ url: 'https://api.example.com' }],
  paths: {
    '/pets': {
      get: { tags: ['pets'], summary: 'List pets', responses: { '200': { description: 'ok' } } },
      post: { tags: ['pets'], summary: 'Create pet', responses: { '201': { description: 'made' } } }
    }
  }
})

describe('import_openapi', () => {
  it('imports from a spec string', async () => {
    await connect()
    const { text, isError } = await call('import_openapi', { spec: SPEC })
    expect(isError).toBe(false)
    expect(text).toContain('Imported 2 request(s)')
    expect(text).toContain('pets/')
    // The generated files are real, parseable request files.
    const listed = await call('list_collection')
    expect(listed.text).toContain('[curl]')
  })

  it('imports from a file in the collection, into a target folder', async () => {
    writeFileSync(join(root, 'openapi.json'), SPEC)
    await connect()
    const { text, isError } = await call('import_openapi', {
      specPath: 'openapi.json',
      targetDir: 'Imported'
    })
    expect(isError).toBe(false)
    expect(text).toContain('Imported/pets/')
    expect(existsSync(join(root, 'Imported', 'pets'))).toBe(true)
  })

  it('requires exactly one source', async () => {
    await connect()
    expect((await call('import_openapi', {})).isError).toBe(true)
    expect((await call('import_openapi', { spec: SPEC, specPath: 'x.json' })).isError).toBe(true)
  })

  it('rejects a spec it cannot parse', async () => {
    await connect()
    const { text, isError } = await call('import_openapi', { spec: 'not a spec' })
    expect(isError).toBe(true)
    expect(text).toMatch(/Could not import|no operations/)
  })

  it('will not escape the collection via targetDir', async () => {
    await connect()
    const { isError } = await call('import_openapi', { spec: SPEC, targetDir: '../escaped' })
    expect(isError).toBe(true)
  })
})

/* ------------------------------- run_request ----------------------------- */

describe('run_request', () => {
  let server: Server
  let port: number

  beforeEach(async () => {
    server = createServer((req, res) => {
      if (req.url === '/boom') {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end('{"error":"kaboom"}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'abc', ok: true }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as AddressInfo).port
  })

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  const withTests = (path: string, assertion: string): string =>
    `#!/usr/bin/env bash
# ---
# scripts:
#   test: |-
#     ${assertion}
# ---

curl --request GET \\
  --url 'http://127.0.0.1:${port}${path}'
`

  it('runs a request and reports passing tests', async () => {
    writeFileSync(
      join(root, 'Get.curl'),
      withTests('/thing', 'pm.test("ok", () => pm.expect(pm.response.json().ok).to.equal(true));')
    )
    await connect()
    const { text, isError } = await call('run_request', { path: 'Get.curl' })
    expect(isError).toBe(false)
    expect(text).toContain('status: 200')
    expect(text).toContain('✓ ok')
    expect(text).toContain('{"id":"abc","ok":true}')
  })

  it('reports a failing test as a tool error, with the assertion message', async () => {
    writeFileSync(
      join(root, 'Get.curl'),
      withTests('/thing', 'pm.test("is false", () => pm.expect(pm.response.json().ok).to.equal(false));')
    )
    await connect()
    const { text, isError } = await call('run_request', { path: 'Get.curl' })
    expect(isError).toBe(true)
    expect(text).toContain('✗ is false')
    expect(text).toContain('FAILED')
  })

  it('truncates a large body rather than dumping it into the context', async () => {
    await new Promise<void>((r) => server.close(() => r()))
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('x'.repeat(50_000))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as AddressInfo).port

    writeFileSync(join(root, 'Big.curl'), withTests('/big', 'pm.test("ran", () => {});'))
    await connect()
    const { text } = await call('run_request', { path: 'Big.curl' })
    expect(text).toContain('[truncated, 50000 chars total]')
    expect(text.length).toBeLessThan(6000)
  })

  it('passes session variables from one request to the next', async () => {
    writeFileSync(
      join(root, 'A.curl'),
      withTests('/thing', 'pm.test("save", () => pm.environment.set("SAVED_ID", pm.response.json().id));')
    )
    writeFileSync(
      join(root, 'B.curl'),
      `#!/usr/bin/env bash
# ---
# scripts:
#   test: |-
#     pm.test("sees it", () => pm.expect(pm.variables.get("SAVED_ID")).to.equal("abc"));
# ---

curl --request GET \\
  --url 'http://127.0.0.1:${port}/thing'
`
    )
    await connect()
    expect((await call('run_request', { path: 'A.curl' })).isError).toBe(false)
    const b = await call('run_request', { path: 'B.curl' })
    expect(b.text).toContain('✓ sees it')
  })

  it('is refused entirely when the server is started with --no-run', async () => {
    writeFileSync(join(root, 'Get.curl'), withTests('/thing', 'pm.test("ok", () => {});'))
    await connect({ allowRun: false })
    const { text, isError } = await call('run_request', { path: 'Get.curl' })
    expect(isError).toBe(true)
    expect(text).toContain('--no-run')
  })

  it('refuses long-lived kinds', async () => {
    writeFileSync(join(root, 'Sock.ws'), `#!/usr/bin/env bash\n\nwebsocat 'ws://127.0.0.1:1/x'\n`)
    await connect()
    const { text, isError } = await call('run_request', { path: 'Sock.ws' })
    expect(isError).toBe(true)
    expect(text).toContain('long-lived')
  })

  it('refuses a GraphQL subscription, which cannot be run one-shot', async () => {
    writeFileSync(
      join(root, 'Sub.curl'),
      `#!/usr/bin/env bash
# ---
# graphql:
#   query: |-
#     subscription Ticks {
#       ticks {
#         value
#       }
#     }
#   variableDefs: []
# ---

curl --request POST \\
  --url 'http://127.0.0.1:${port}/graphql' \\
  --header 'Content-Type: application/json' \\
  --data '{"query":"subscription Ticks {\\n  ticks {\\n    value\\n  }\\n}"}'
`
    )
    await connect()
    const { text, isError } = await call('run_request', { path: 'Sub.curl' })
    expect(isError).toBe(true)
    expect(text).toContain('subscription')
  })
})

/* -------------------------- run_request: mcp spawn ----------------------- */

describe('run_request spawn gate', () => {
  const STDIO_MCP = `#!/usr/bin/env bash

npx @modelcontextprotocol/inspector \\
  --cli \\
  'node' \\
  './server.mjs' \\
  --transport stdio \\
  --method 'tools/list'
`

  it('refuses a stdio .mcp file when spawning is not approved', async () => {
    writeFileSync(join(root, 'Local.mcp'), STDIO_MCP)
    await connect({ allowMcpSpawn: () => false })
    const { text, isError } = await call('run_request', { path: 'Local.mcp' })
    expect(isError).toBe(true)
    expect(text).toContain('spawns a local MCP server')
    expect(text).toContain('Approve the server in the Freepost app first')
  })

  it('does not gate an http .mcp file, which spawns nothing', async () => {
    // Points at a dead port: we only care that it got past the gate and tried.
    writeFileSync(
      join(root, 'Remote.mcp'),
      `#!/usr/bin/env bash

npx @modelcontextprotocol/inspector \\
  --cli \\
  'http://127.0.0.1:9/mcp' \\
  --transport http \\
  --method 'tools/list'
`
    )
    await connect({ allowMcpSpawn: () => false })
    const { text } = await call('run_request', { path: 'Remote.mcp' })
    expect(text).not.toContain('spawns a local MCP server')
  })
})

/* ------------------------- describe_graphql_schema ----------------------- */

const SDL = `
  type User { id: ID!, name: String!, email: String }
  type Query { users: [User!]!, user(id: ID!): User }
  type Mutation { createUser(name: String!, email: String): User! }
`

describe('describe_graphql_schema', () => {
  it('summarizes an SDL document', async () => {
    await connect()
    const { text, isError } = await call('describe_graphql_schema', { sdl: SDL })
    expect(isError).toBe(false)
    expect(text).toContain('## Queries')
    expect(text).toContain('users(): [User!]!')
    expect(text).toContain('user(id: ID!): User')
    expect(text).toContain('## Mutations')
    expect(text).toContain('createUser(name: String!, email: String): User!')
    expect(text).toContain('User')
  })

  it('summarizes an SDL file from the collection', async () => {
    writeFileSync(join(root, 'schema.graphql'), SDL)
    await connect()
    const { text, isError } = await call('describe_graphql_schema', { sdlPath: 'schema.graphql' })
    expect(isError).toBe(false)
    expect(text).toContain('createUser')
  })

  it('rejects an SDL path outside the collection', async () => {
    await connect()
    const { isError } = await call('describe_graphql_schema', { sdlPath: '../../etc/passwd' })
    expect(isError).toBe(true)
  })

  it('introspects a live endpoint', async () => {
    const schema = buildSchema(SDL)
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        void graphql({ schema, source: JSON.parse(body).query as string }).then((r) => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(r))
        })
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    try {
      await connect()
      const { text, isError } = await call('describe_graphql_schema', {
        endpoint: `http://127.0.0.1:${port}/graphql`
      })
      expect(isError).toBe(false)
      expect(text).toContain('createUser')
      expect(text).toContain(`Endpoint: http://127.0.0.1:${port}/graphql`)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('explains itself when the endpoint is not GraphQL', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>hello</html>')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    try {
      await connect()
      const { text, isError } = await call('describe_graphql_schema', {
        endpoint: `http://127.0.0.1:${port}/`
      })
      expect(isError).toBe(true)
      expect(text).toContain('Introspection failed')
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('requires exactly one source', async () => {
    await connect()
    expect((await call('describe_graphql_schema', {})).isError).toBe(true)
    expect((await call('describe_graphql_schema', { sdl: SDL, endpoint: 'http://x' })).isError).toBe(true)
  })

  it('does not hit the network when the server is started with --no-run', async () => {
    await connect({ allowRun: false })
    const live = await call('describe_graphql_schema', { endpoint: 'http://127.0.0.1:1/graphql' })
    expect(live.isError).toBe(true)
    expect(live.text).toContain('--no-run')
    // Offline sources still work — they aren't network calls.
    expect((await call('describe_graphql_schema', { sdl: SDL })).isError).toBe(false)
  })
})

/* ----------------------------- get_format_spec --------------------------- */

describe('get_format_spec', () => {
  it('returns an overview plus a curl starter by default', async () => {
    await connect()
    const { text } = await call('get_format_spec')
    expect(text).toContain('Freepost request-file format')
    expect(text).toContain('#!/usr/bin/env bash')
    expect(text).toContain('scripts.test')
  })

  it('returns a usable starter for every kind', async () => {
    await connect()
    for (const kind of ['curl', 'graphql', 'websocat', 'grpc', 'mqtt', 'mcp']) {
      const { text, isError } = await call('get_format_spec', { kind })
      expect(isError, kind).toBe(false)
      expect(text, kind).toContain('Canonical starter')
      // The starter is a real file the model can copy verbatim.
      const starter = text.match(/```bash\n([\s\S]*?)```/)![1]
      expect(starter, kind).toContain('#!/usr/bin/env bash')
    }
  })

  it('rejects an unknown kind at the schema layer', async () => {
    await connect()
    const { text, isError } = await call('get_format_spec', { kind: 'ftp' })
    expect(isError).toBe(true)
    // The SDK validates against the declared enum before the handler runs, and
    // tells the model exactly which values are allowed.
    expect(text).toContain('Invalid arguments for tool get_format_spec')
    expect(text).toContain('curl')
  })
})

/* -------------------------------- metadata ------------------------------- */

describe('tool surface', () => {
  it('is small, and every tool is described', async () => {
    await connect()
    const { tools } = await client.listTools()
    expect(tools).toHaveLength(11)
    for (const t of tools) {
      expect(t.description, t.name).toBeTruthy()
      expect(t.inputSchema, t.name).toBeTruthy()
    }
  })

  it('marks read-only and destructive tools for clients that gate on it', async () => {
    await connect()
    const byName = new Map((await client.listTools()).tools.map((t) => [t.name, t]))
    expect(byName.get('read_request')?.annotations?.readOnlyHint).toBe(true)
    expect(byName.get('list_collection')?.annotations?.readOnlyHint).toBe(true)
    expect(byName.get('delete_path')?.annotations?.destructiveHint).toBe(true)
    expect(byName.get('run_request')?.annotations?.openWorldHint).toBe(true)
  })
})
