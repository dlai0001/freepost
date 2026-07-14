/**
 * Start every protocol fixture at once, for manual verification:
 *
 *   npm run fixtures
 *
 * Ports: http 3010 · mcp-http 3011 · ws 3013 · graphql 3014 · grpc 50051 · mqtt 1883
 * The stdio MCP server is NOT started here — it is a subprocess the app spawns
 * for you when you run fixtures/collection/MCP stdio - sum.mcp.
 *
 * Ctrl-C stops everything.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

const SERVERS = [
  ['http', 'http.mjs'],
  ['mcp-http', 'mcp-http.mjs'],
  ['ws', 'ws.mjs'],
  ['graphql', 'graphql.mjs'],
  ['grpc', 'grpc.mjs'],
  ['mqtt', 'mqtt.mjs']
]

const children = SERVERS.map(([name, file]) => {
  const child = spawn(process.execPath, [join(here, 'servers', file)], { stdio: 'inherit' })
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) console.error(`[fixtures] ${name} exited with code ${code}`)
  })
  return child
})

const shutdown = () => {
  console.log('\n[fixtures] shutting down…')
  for (const c of children) c.kill('SIGTERM')
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

console.log('[fixtures] starting all protocol fixtures — Ctrl-C to stop')
