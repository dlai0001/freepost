/**
 * Blank-request templates and the secret-default guardrail.
 *
 * These live outside ipc-handlers so every programmatic write path — the
 * renderer's IPC handlers and the MCP server (src/main/mcp-server) — shares one
 * definition of "what a new request looks like" and one enforcement point for
 * PLAN.md's "never persist a literal default for a secret variable" invariant.
 */
import type { RequestFile, RequestKind } from '../shared/model'

export const STARTERS: Record<RequestKind, RequestFile> = {
  curl: {
    kind: 'curl',
    frontmatter: { description: '' },
    variables: [{ name: 'BASE_URL', defaultValue: 'https://api.example.com', required: false }],
    http: {
      method: 'GET',
      url: '${BASE_URL}/',
      headers: [{ name: 'Accept', value: 'application/json' }],
      options: {}
    },
    comments: []
  },
  websocat: {
    kind: 'websocat',
    frontmatter: { messages: { ping: '{"op":"ping"}' } },
    variables: [{ name: 'WS_URL', defaultValue: 'ws://localhost:8080', required: false }],
    ws: { url: '${WS_URL}', headers: [] },
    comments: []
  },
  grpc: {
    kind: 'grpc',
    frontmatter: { description: '' },
    variables: [{ name: 'GRPC_TARGET', defaultValue: 'localhost:50051', required: false }],
    grpc: {
      target: '${GRPC_TARGET}',
      fullMethod: 'package.Service/Method',
      plaintext: true,
      data: '{}',
      metadata: [],
      protoFiles: [],
      importPaths: []
    },
    comments: []
  },
  mqtt: {
    kind: 'mqtt',
    frontmatter: { description: '' },
    variables: [{ name: 'MQTT_HOST', defaultValue: 'localhost', required: false }],
    mqtt: {
      mode: 'publish',
      host: '${MQTT_HOST}',
      port: 1883,
      topic: 'freepost/demo',
      message: 'hello'
    },
    comments: []
  },
  mcp: {
    kind: 'mcp',
    frontmatter: { description: '' },
    variables: [{ name: 'MCP_URL', defaultValue: 'http://localhost:3001/mcp', required: false }],
    // The http transport is the safe default for a new file: it opens a socket
    // the user chose, rather than naming a subprocess to spawn.
    mcp: {
      transport: 'http',
      url: '${MCP_URL}',
      args: [],
      env: [],
      headers: [],
      method: 'tools/list',
      toolArgs: [],
      promptArgs: []
    },
    comments: []
  }
}

/** PLAN.md: never persist a literal default for secret-marked variables. */
export function stripSecretDefaults(file: RequestFile): RequestFile {
  const secrets = new Set(
    Object.entries(file.frontmatter.variables ?? {})
      .filter(([, meta]) => meta !== null && meta !== undefined && meta.secret === true)
      .map(([name]) => name)
  )
  if (secrets.size === 0) return file
  return {
    ...file,
    variables: file.variables.map((v) =>
      secrets.has(v.name) ? { name: v.name, required: true } : v
    )
  }
}
