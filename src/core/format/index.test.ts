import { describe, expect, it } from 'vitest'
import type { ParseError, RequestFile, RequestKind } from '@shared/model'
import { parseRequestFile, requestKindForPath, writeRequestFile } from './index'

function parseOk(raw: string, kind: RequestKind = 'curl'): RequestFile {
  const r = parseRequestFile(raw, kind)
  if (!r.ok) throw new Error(`expected ok, got: ${JSON.stringify(r.errors)}`)
  return r.file
}

function parseErr(raw: string, kind: RequestKind = 'curl'): ParseError {
  const r = parseRequestFile(raw, kind)
  expect(r.ok).toBe(false)
  if (r.ok) throw new Error('expected error')
  expect(r.errors.length).toBeGreaterThan(0)
  expect(r.errors[0].line).toBeGreaterThanOrEqual(1)
  return r.errors[0]
}

/** The .curl example file from PLAN.md §3, verbatim. */
const PLAN_CURL = `#!/usr/bin/env bash
# ---
# description: Fetches a single user record by id
# label:
#   - users
#   - smoke
# seq: 20
# variables:
#   token: { secret: true }
# scripts:
#   pre-request: |
#     pm.variables.set("ts", Date.now());
#   test: |
#     pm.test("status is 200", () => pm.response.to.have.status(200));
#     pm.test("has email", () => pm.expect(pm.response.json().email).to.be.a("string"));
# ---

BASE_URL="\${BASE_URL:-https://api.example.com}"
USER_ID="\${USER_ID:-42}"
TOKEN="\${TOKEN:?}"

curl --request GET \\
  --url "https://\${BASE_URL}/api/users/\${USER_ID}" \\
  --header 'Accept: application/json' \\
  --header "Authorization: Bearer \${TOKEN}"
`

/** The .ws example file from PLAN.md §3, verbatim. */
const PLAN_WS = `#!/usr/bin/env bash
# ---
# description: Live ticker stream
# label:
#   - streaming
# variables:
#   token: { secret: true }
# messages:
#   subscribe: '{"op":"subscribe","channel":"ticker"}'
#   ping: '{"op":"ping"}'
# ---

BASE_URL="\${BASE_URL:-api.example.com}"
TOKEN="\${TOKEN:?}"

websocat "wss://\${BASE_URL}/stream" \\
  --header "Authorization: Bearer \${TOKEN}" \\
  --protocol 'v1.ticker'
`

describe('parseRequestFile: PLAN.md example files', () => {
  it('parses the PLAN.md curl example', () => {
    const f = parseOk(PLAN_CURL, 'curl')
    expect(f.kind).toBe('curl')
    expect(f.frontmatter).toEqual({
      description: 'Fetches a single user record by id',
      label: ['users', 'smoke'],
      seq: 20,
      variables: { token: { secret: true } },
      scripts: {
        'pre-request': 'pm.variables.set("ts", Date.now());\n',
        test:
          'pm.test("status is 200", () => pm.response.to.have.status(200));\n' +
          'pm.test("has email", () => pm.expect(pm.response.json().email).to.be.a("string"));\n',
      },
    })
    expect(f.variables).toEqual([
      { name: 'BASE_URL', required: false, defaultValue: 'https://api.example.com' },
      { name: 'USER_ID', required: false, defaultValue: '42' },
      { name: 'TOKEN', required: true },
    ])
    expect(f.http).toEqual({
      method: 'GET',
      url: 'https://${BASE_URL}/api/users/${USER_ID}',
      headers: [
        { name: 'Accept', value: 'application/json' },
        { name: 'Authorization', value: 'Bearer ${TOKEN}' },
      ],
      options: {},
    })
    expect(f.ws).toBeUndefined()
    expect(f.comments).toEqual([])
  })

  it('parses the PLAN.md websocat example', () => {
    const f = parseOk(PLAN_WS, 'websocat')
    expect(f.kind).toBe('websocat')
    expect(f.frontmatter).toEqual({
      description: 'Live ticker stream',
      label: ['streaming'],
      variables: { token: { secret: true } },
      messages: {
        subscribe: '{"op":"subscribe","channel":"ticker"}',
        ping: '{"op":"ping"}',
      },
    })
    expect(f.variables).toEqual([
      { name: 'BASE_URL', required: false, defaultValue: 'api.example.com' },
      { name: 'TOKEN', required: true },
    ])
    expect(f.ws).toEqual({
      url: 'wss://${BASE_URL}/stream',
      headers: [{ name: 'Authorization', value: 'Bearer ${TOKEN}' }],
      protocol: 'v1.ticker',
    })
    expect(f.http).toBeUndefined()
  })

  it('parses a minimal file with no shebang and no frontmatter', () => {
    const f = parseOk("curl --url 'https://x'\n")
    expect(f.frontmatter).toEqual({})
    expect(f.variables).toEqual([])
    expect(f.http?.url).toBe('https://x')
  })
})

describe('round-trip law: write(parse(x)) is idempotent', () => {
  const idempotent = (raw: string, kind: RequestKind) => {
    const canonical = writeRequestFile(parseOk(raw, kind))
    const again = writeRequestFile(parseOk(canonical, kind))
    expect(again).toBe(canonical)
  }

  it('holds for the PLAN.md curl example', () => idempotent(PLAN_CURL, 'curl'))
  it('holds for the PLAN.md websocat example', () => idempotent(PLAN_WS, 'websocat'))

  it('holds for a messy short-flag file (and canonicalizes it)', () => {
    const messy = [
      '#!/usr/bin/env bash',
      "Z_VAR='hello'",
      'A_VAR="${A_VAR:-x}"',
      `curl -X POST https://api.test/v1 -H 'A: b' -d '{"k":"v"}' -k -L -u 'me:pw' --max-time 5`,
      '',
    ].join('\n')
    idempotent(messy, 'curl')
    const canonical = writeRequestFile(parseOk(messy, 'curl'))
    expect(canonical).toBe(
      [
        '#!/usr/bin/env bash',
        '',
        'A_VAR="${A_VAR:-x}"',
        'Z_VAR="${Z_VAR:-hello}"',
        '',
        'curl --request POST \\',
        "  --url 'https://api.test/v1' \\",
        "  --header 'A: b' \\",
        `  --data '{"k":"v"}' \\`,
        "  --user 'me:pw' \\",
        '  --insecure \\',
        '  --location \\',
        '  --max-time 5',
        '',
      ].join('\n'),
    )
  })

  it('holds for a file with body comments (incl. a trailing one)', () => {
    const raw = [
      '#!/usr/bin/env bash',
      '',
      '# base url',
      'BASE_URL="${BASE_URL:-x}"',
      '# the call',
      "curl --url 'https://x'",
      '# trailing note',
      '',
    ].join('\n')
    idempotent(raw, 'curl')
  })
})

describe('round-trip law: parse(write(f)) deep-equals f', () => {
  const roundTrip = (f: RequestFile) => {
    const text = writeRequestFile(f)
    const back = parseOk(text, f.kind)
    expect(back).toEqual(f)
    return text
  }

  it('holds for a rich curl model (unknown keys, secret meta, disabled, comments)', () => {
    const model: RequestFile = {
      kind: 'curl',
      frontmatter: {
        description: 'Create a user',
        label: ['users', 'write'],
        seq: 5,
        variables: { TOKEN: { secret: true, description: 'API token' }, BASE_URL: null },
        disabled: {
          headers: { 'X-Debug': '1' },
          query: { verbose: 'true' },
        },
        'x-vendor-extension': { nested: ['a', 'b'], num: 3 },
        anotherUnknownKey: 'kept verbatim',
      },
      variables: [
        { name: 'BASE_URL', required: false, defaultValue: 'https://api.example.com' },
        { name: 'TOKEN', required: true },
      ],
      comments: [
        { beforeStatement: 0, text: 'where the API lives' },
        { beforeStatement: 2, text: 'create the user record' },
      ],
      http: {
        method: 'POST',
        url: 'https://${BASE_URL}/users?notify=true&source=cli',
        headers: [
          { name: 'Content-Type', value: 'application/json' },
          { name: 'Authorization', value: 'Bearer ${TOKEN}' },
        ],
        body: { kind: 'raw', value: '{"name":"O\'Brien","note":"line1\\nline2"}' },
        options: { insecure: true, followRedirects: true, timeoutSeconds: 30, user: 'admin:${TOKEN}' },
      },
    }
    const text = roundTrip(model)
    expect(text).toContain('anotherUnknownKey: kept verbatim')
    expect(text).toContain('# where the API lives')
  })

  it('holds for a derived Meta value that references other variables', () => {
    roundTrip({
      kind: 'curl',
      frontmatter: {},
      variables: [
        { name: 'env', required: false, defaultValue: 'prod' },
        { name: 'url', required: false, defaultValue: 'https://${env}.example.com/${id}' },
      ],
      comments: [],
      http: {
        method: 'GET',
        url: '${url}',
        headers: [],
        options: {},
      },
    })
  })

  it('holds for a file-body (--data @sidecar) model', () => {
    roundTrip({
      kind: 'curl',
      frontmatter: {},
      variables: [],
      comments: [],
      http: {
        method: 'PUT',
        url: 'https://e.com/upload',
        headers: [],
        body: { kind: 'file', value: './payload.json' },
        options: {},
      },
    })
  })

  it('holds for a websocat model with message presets', () => {
    roundTrip({
      kind: 'websocat',
      frontmatter: {
        description: 'Ticker',
        messages: { ping: '{"op":"ping"}', subscribe: '{"op":"subscribe","channel":"ticker"}' },
        customMeta: [1, 2, 3],
      },
      variables: [{ name: 'TOKEN', required: true }],
      comments: [{ beforeStatement: 1, text: 'connect to the stream' }],
      ws: {
        url: 'wss://${HOST}/stream',
        headers: [{ name: 'Authorization', value: 'Bearer ${TOKEN}' }],
        protocol: 'v1.ticker',
      },
    })
  })

  it('holds for a graphql model (generated --data is the parsed body)', () => {
    const query = 'query User($id: ID!) {\n  user(id: $id) {\n    id\n    email\n  }\n}\n'
    const variables = { id: '42' }
    const generated = JSON.stringify({ query, variables })
    const model: RequestFile = {
      kind: 'curl',
      frontmatter: { graphql: { query, variables } },
      variables: [],
      comments: [],
      http: {
        method: 'POST',
        url: 'https://e.com/graphql',
        headers: [{ name: 'Content-Type', value: 'application/json' }],
        body: { kind: 'raw', value: generated },
        options: {},
      },
    }
    const text = roundTrip(model)
    expect(text).toContain(`--data '${generated}'`)
  })

  it('holds for quoting edge cases in values', () => {
    roundTrip({
      kind: 'curl',
      frontmatter: {},
      variables: [{ name: 'Q', required: false, defaultValue: "it's got 'quotes'" }],
      comments: [],
      http: {
        method: 'GET',
        url: 'https://e.com/search?q=a+b&lang=en',
        headers: [{ name: 'X-Mixed', value: '${VAR} and $literal and "quoted"' }],
        options: {},
      },
    })
  })
})

describe('writeRequestFile: canonical layout', () => {
  it('emits the exact canonical form (sorted assignments, no frontmatter)', () => {
    const file: RequestFile = {
      kind: 'curl',
      frontmatter: {},
      variables: [
        { name: 'B', required: false, defaultValue: 'x' },
        { name: 'A', required: true },
      ],
      comments: [],
      http: { method: 'GET', url: 'https://e.com', headers: [], options: {} },
    }
    expect(writeRequestFile(file)).toBe(
      [
        '#!/usr/bin/env bash',
        '',
        'A="${A:?}"',
        'B="${B:-x}"',
        '',
        'curl --request GET \\',
        "  --url 'https://e.com'",
        '',
      ].join('\n'),
    )
  })

  it('emits frontmatter between shebang and the body', () => {
    const file: RequestFile = {
      kind: 'curl',
      frontmatter: { description: 'd' },
      variables: [],
      comments: [],
      http: { method: 'GET', url: 'https://e.com', headers: [], options: {} },
    }
    expect(writeRequestFile(file)).toBe(
      ['#!/usr/bin/env bash', '# ---', '# description: d', '# ---', '', 'curl --request GET \\', "  --url 'https://e.com'", ''].join(
        '\n',
      ),
    )
  })

  it('keeps a comment attached to its assignment when sorting reorders it', () => {
    const file: RequestFile = {
      kind: 'curl',
      frontmatter: {},
      variables: [
        { name: 'Z', required: false, defaultValue: '1' },
        { name: 'A', required: false, defaultValue: '2' },
      ],
      comments: [{ beforeStatement: 0, text: 'about Z' }],
      http: { method: 'GET', url: 'https://e.com', headers: [], options: {} },
    }
    const text = writeRequestFile(file)
    expect(text).toContain('A="${A:-2}"\n# about Z\nZ="${Z:-1}"')
  })

  it('emits flags in the pinned order', () => {
    const file: RequestFile = {
      kind: 'curl',
      frontmatter: {},
      variables: [],
      comments: [],
      http: {
        method: 'DELETE',
        url: 'https://e.com',
        headers: [
          { name: 'B', value: '2' },
          { name: 'A', value: '1' },
        ],
        body: { kind: 'raw', value: 'payload' },
        options: { user: 'u:p', insecure: true, followRedirects: true, timeoutSeconds: 9 },
      },
    }
    expect(writeRequestFile(file)).toBe(
      [
        '#!/usr/bin/env bash',
        '',
        'curl --request DELETE \\',
        "  --url 'https://e.com' \\",
        "  --header 'B: 2' \\",
        "  --header 'A: 1' \\",
        "  --data 'payload' \\",
        "  --user 'u:p' \\",
        '  --insecure \\',
        '  --location \\',
        '  --max-time 9',
        '',
      ].join('\n'),
    )
  })

  it('regenerates --data from frontmatter.graphql, overwriting a stale body', () => {
    const query = 'query { viewer { id } }'
    const file: RequestFile = {
      kind: 'curl',
      frontmatter: { graphql: { query } },
      variables: [],
      comments: [],
      http: {
        method: 'POST',
        url: 'https://e.com/graphql',
        headers: [],
        body: { kind: 'raw', value: 'STALE-HAND-EDIT' },
        options: {},
      },
    }
    const text = writeRequestFile(file)
    expect(text).not.toContain('STALE-HAND-EDIT')
    expect(text).toContain(`--data '${JSON.stringify({ query })}'`)
  })

  it('round-trips graphql schemaUrl + variableDefs through write and re-parse', () => {
    const file: RequestFile = {
      kind: 'curl',
      frontmatter: {
        graphql: {
          query: 'query($id: ID!) { user(id: $id) { name } }',
          variables: { id: '123' },
          variableDefs: [{ name: 'id', type: 'ID!', value: '"123"' }],
          schemaUrl: 'https://api.example.com/graphql'
        }
      },
      variables: [],
      comments: [],
      http: { method: 'POST', url: 'https://api.example.com/graphql', headers: [], options: {} }
    }
    const reparsed = parseOk(writeRequestFile(file))
    expect(reparsed.frontmatter.graphql?.schemaUrl).toBe('https://api.example.com/graphql')
    expect(reparsed.frontmatter.graphql?.variableDefs).toEqual([
      { name: 'id', type: 'ID!', value: '"123"' }
    ])
    // --data is still generated from query + variables.
    expect(writeRequestFile(reparsed)).toContain('--data')
  })

  it('generates --form flags from frontmatter.form and omits --data', () => {
    const file: RequestFile = {
      kind: 'curl',
      frontmatter: {
        form: [
          { name: 'title', type: 'text', value: 'hi' },
          { name: 'avatar', type: 'file', value: './pic.png', filename: 'me.png' },
          { name: 'payload', type: 'json', content: '{"k":1}', filename: 'data.json' }
        ]
      },
      variables: [],
      comments: [],
      http: { method: 'POST', url: 'https://e.com/upload', headers: [], options: {} }
    }
    const text = writeRequestFile(file)
    expect(text).toContain("--form 'title=hi'")
    expect(text).toContain("--form 'avatar=@./pic.png;filename=me.png'")
    expect(text).toContain('--form \'payload={"k":1};filename=data.json;type=application/json\'')
    expect(text).not.toContain('--data')
  })

  it('round-trips a multipart form through write and re-parse (idempotent)', () => {
    const file: RequestFile = {
      kind: 'curl',
      frontmatter: {
        form: [
          { name: 'title', type: 'text', value: 'hi' },
          { name: 'payload', type: 'json', content: '{"k":1}' }
        ]
      },
      variables: [],
      comments: [],
      http: { method: 'POST', url: 'https://e.com/upload', headers: [], options: {} }
    }
    const written = writeRequestFile(file)
    const reparsed = parseOk(written)
    // Frontmatter.form is canonical and survives a write→parse cycle unchanged,
    // and a second write is byte-identical (the gofmt fixed point).
    expect(reparsed.frontmatter.form).toEqual(file.frontmatter.form)
    expect(writeRequestFile(reparsed)).toBe(written)
  })

  it('single-quotes plain values and double-quotes ${VAR} values', () => {
    const file: RequestFile = {
      kind: 'curl',
      frontmatter: {},
      variables: [],
      comments: [],
      http: {
        method: 'GET',
        url: 'https://${HOST}/x',
        headers: [{ name: 'X-Plain', value: 'no refs here' }],
        options: {},
      },
    }
    const text = writeRequestFile(file)
    expect(text).toContain('--url "https://${HOST}/x"')
    expect(text).toContain("--header 'X-Plain: no refs here'")
  })

  it("escapes embedded single quotes with the '\\'' idiom", () => {
    const file: RequestFile = {
      kind: 'curl',
      frontmatter: {},
      variables: [],
      comments: [],
      http: {
        method: 'POST',
        url: 'https://e.com',
        headers: [],
        body: { kind: 'raw', value: "it's" },
        options: {},
      },
    }
    expect(writeRequestFile(file)).toContain("--data 'it'\\''s'")
  })

  it('throws when the model for the kind is missing', () => {
    expect(() =>
      writeRequestFile({ kind: 'curl', frontmatter: {}, variables: [], comments: [] }),
    ).toThrow(/requires the http model/)
    expect(() =>
      writeRequestFile({ kind: 'websocat', frontmatter: {}, variables: [], comments: [] }),
    ).toThrow(/requires the ws model/)
  })
})

describe('parseRequestFile: strict-grammar rejections (with line info)', () => {
  it('rejects a pipe', () => {
    const e = parseErr(["#!/usr/bin/env bash", '', "curl --url 'https://x' | jq ."].join('\n'))
    expect(e.line).toBe(3)
    expect(e.message).toMatch(/pipes/)
  })

  it('rejects two commands', () => {
    const e = parseErr(["curl --url 'https://a'", "curl --url 'https://b'"].join('\n'))
    expect(e.line).toBe(2)
    expect(e.message).toMatch(/exactly one command/)
  })

  it('rejects a heredoc', () => {
    const e = parseErr(["curl --url 'https://x' <<EOF", '{}', 'EOF'].join('\n'))
    expect(e.line).toBe(1)
    expect(e.message).toMatch(/heredocs/)
  })

  it('rejects an unknown flag, naming it', () => {
    const e = parseErr(['curl \\', "  --url 'https://x' \\", '  --compressed'].join('\n'))
    expect(e.line).toBe(3)
    expect(e.message).toBe('unsupported curl flag: --compressed')
  })

  it('rejects a malformed assignment', () => {
    const e = parseErr(['#!/usr/bin/env bash', 'TOKEN=abc', "curl --url 'https://x'"].join('\n'))
    expect(e.line).toBe(2)
    expect(e.message).toMatch(/malformed assignment/)
  })

  it('rejects && chains, ; chains, and redirects', () => {
    expect(parseErr("curl --url 'https://x' && echo hi").message).toMatch(/"&"/)
    expect(parseErr("curl --url 'https://x'; echo hi").message).toMatch(/";"/)
    expect(parseErr("curl --url 'https://x' > out.json").message).toMatch(/redirection/)
  })

  it('rejects control structures', () => {
    expect(parseErr(['for f in a b', 'do', 'done'].join('\n')).message).toMatch(/control structures/)
  })

  it('rejects a command that does not match the file kind', () => {
    const e = parseErr(PLAN_WS, 'curl')
    expect(e.message).toMatch(/does not match the file kind/)
    const e2 = parseErr(PLAN_CURL, 'websocat')
    expect(e2.message).toMatch(/expected a websocat invocation/)
  })

  it('rejects an unknown command name for both kinds', () => {
    expect(parseErr("wget 'https://x'", 'curl').message).toMatch(/expected a curl invocation/)
  })

  it('rejects an empty file (missing command)', () => {
    expect(parseErr('').message).toMatch(/missing command/)
    expect(parseErr('#!/usr/bin/env bash\n\n').message).toMatch(/missing command/)
  })

  it('rejects an unterminated frontmatter block', () => {
    const e = parseErr(['#!/usr/bin/env bash', '# ---', '# description: x'].join('\n'))
    expect(e.line).toBe(2)
    expect(e.message).toMatch(/unterminated frontmatter/)
  })

  it('never returns ok for invalid files (they must not be rewritten)', () => {
    const r = parseRequestFile("curl --url 'https://x' | tee log", 'curl')
    expect(r.ok).toBe(false)
  })
})

describe('requestKindForPath', () => {
  it('maps extensions to kinds', () => {
    expect(requestKindForPath('a/b/Get user.curl')).toBe('curl')
    expect(requestKindForPath('a/b/Ticker.ws')).toBe('websocat')
    expect(requestKindForPath('a/b/notes.txt')).toBeNull()
  })
})
