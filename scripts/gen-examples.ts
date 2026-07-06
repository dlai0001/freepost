/**
 * Regenerates the examples/ demo collection through the canonical writer,
 * guaranteeing the shipped examples are always in canonical format.
 * Run: npx vite-node scripts/gen-examples.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeRequestFile } from '../src/core/format'
import { serializeWorkflow } from '../src/core/workflow'
import type { RequestFile } from '../src/shared/model'

const root = join(__dirname, '..', 'examples', 'demo-collection')

function emit(rel: string, text: string): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, text)
  console.log('wrote', rel)
}

const getIp: RequestFile = {
  kind: 'curl',
  frontmatter: {
    description: 'Returns your public IP address as JSON',
    label: ['demo', 'smoke'],
    scripts: {
      test: [
        'pm.test("status is 200", () => pm.response.to.have.status(200));',
        'pm.test("has origin", () => pm.expect(pm.response.json().origin).to.be.a("string"));'
      ].join('\n')
    }
  },
  variables: [{ name: 'BASE_URL', defaultValue: 'httpbin.org', required: false }],
  http: {
    method: 'GET',
    url: 'https://${BASE_URL}/ip',
    headers: [{ name: 'Accept', value: 'application/json' }],
    options: {}
  },
  comments: []
}

const postEcho: RequestFile = {
  kind: 'curl',
  frontmatter: {
    description: 'POSTs a JSON body and asserts it is echoed back',
    label: ['demo'],
    scripts: {
      'pre-request': 'pm.variables.set("RUN_ID", String(Date.now()));',
      test: [
        'pm.test("status is 200", () => pm.response.to.have.status(200));',
        'pm.test("echoes the body", () => {',
        '  const echoed = JSON.parse(pm.response.json().data);',
        '  pm.expect(echoed.hello).to.equal("freepost");',
        '});'
      ].join('\n')
    }
  },
  variables: [
    { name: 'BASE_URL', defaultValue: 'httpbin.org', required: false },
    { name: 'RUN_ID', defaultValue: 'local', required: false }
  ],
  http: {
    method: 'POST',
    url: 'https://${BASE_URL}/post',
    headers: [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'X-Run-Id', value: '${RUN_ID}' }
    ],
    body: { kind: 'raw', value: '{"hello": "freepost"}' },
    options: {}
  },
  comments: []
}

const authDemo: RequestFile = {
  kind: 'curl',
  frontmatter: {
    description: 'Basic-auth demo; TOKEN is a secret with no committed default',
    label: ['demo', 'auth'],
    variables: { TOKEN: { secret: true, description: 'Set via environment or session' } },
    scripts: {
      test: 'pm.test("authorized", () => pm.response.to.have.status(200));'
    }
  },
  variables: [
    { name: 'BASE_URL', defaultValue: 'httpbin.org', required: false },
    { name: 'TOKEN', required: true }
  ],
  http: {
    method: 'GET',
    url: 'https://${BASE_URL}/bearer',
    headers: [{ name: 'Authorization', value: 'Bearer ${TOKEN}' }],
    options: {}
  },
  comments: []
}

const wsEcho: RequestFile = {
  kind: 'websocat',
  frontmatter: {
    description: 'Echo WebSocket demo (run a local echo server to try it)',
    label: ['demo', 'ws'],
    messages: {
      hello: '{"op":"hello","from":"freepost"}',
      ping: '{"op":"ping"}'
    }
  },
  variables: [{ name: 'WS_URL', defaultValue: 'ws://localhost:9090', required: false }],
  ws: { url: '${WS_URL}', headers: [] },
  comments: []
}

emit('Get IP.curl', writeRequestFile(getIp))
emit('Post Echo.curl', writeRequestFile(postEcho))
emit('auth/Bearer Check.curl', writeRequestFile(authDemo))
emit('Echo Socket.ws', writeRequestFile(wsEcho))
emit(
  'Smoke.workflow.json',
  serializeWorkflow({
    description: 'Demo workflow: IP check then POST echo; auth step expects 401 without TOKEN',
    steps: [
      { request: 'Get IP.curl' },
      { request: 'Post Echo.curl' },
      { request: 'auth/Bearer Check.curl', expectError: true }
    ]
  })
)
emit(
  'environments/local.env.json',
  JSON.stringify({ BASE_URL: 'httpbin.org', WS_URL: 'ws://localhost:9090' }, null, 2) + '\n'
)

// M5: a collection-level config with a default header and a collection pre-request
// script, demonstrating folder/collection inheritance.
emit(
  'collection.json',
  JSON.stringify(
    {
      defaultHeaders: [{ name: 'X-Freepost-Demo', value: 'true' }],
      scripts: { 'pre-request': 'pm.variables.set("RUN_AT", new Date().toISOString());' }
    },
    null,
    2
  ) + '\n'
)

// M5: a CSV data file for data-driven workflow runs.
emit('data/users.csv', 'USER_ID,EXPECTED_NAME\n1,Leanne\n2,Ervin\n3,Clementine\n')

console.log('done')
