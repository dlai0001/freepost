#!/usr/bin/env node
/**
 * Zero-network guarantee enforcement.
 *
 * The ONLY module allowed to open a socket is src/engine. This script scans
 * every other source file for network-capable APIs and fails the build if any
 * are found. See PLAN.md "Network policy".
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import { fileURLToPath } from 'url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src')
// The engine is the only module allowed to open a socket. As of the mock server
// that includes an *inbound* listener (src/engine/mock-server.ts), not just
// outbound clients — the rule is "no sockets outside src/engine", and a
// user-started mock listener is still confined here.
const ALLOWED_PREFIX = join('src', 'engine')

// Usage patterns — real network calls. Tested against a copy of the line with
// string/template-literal CONTENTS blanked, so network-API names that appear as
// generated code *data* (e.g. codegen emitting `new WebSocket(...)` inside a
// string) don't trip the fence, while an actual call in executable code does.
const USAGE = [
  /\bfetch\s*\(/, // global fetch
  /\bnew\s+WebSocket\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bnavigator\.sendBeacon\b/,
  /\bnew\s+EventSource\s*\(/
]

// Network module specifiers. A line that is structurally an import/require
// (after blanking, it still starts with `import` or contains a `require(` call)
// AND whose ORIGINAL text imports one of these is a violation. Emitted-as-string
// imports blank away and are ignored.
const NET_MODULE = /['"](?:node:)?(?:https?|net|dgram|tls|ws|undici)['"]/

/** Blank the contents of '...', "...", and `...` literals (keep the quotes). */
function blankStrings(line) {
  return line
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

const violations = []

function scan(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const rel = relative(ROOT, full)
    if (statSync(full).isDirectory()) {
      scan(full)
      continue
    }
    if (!/\.(ts|tsx|js|mjs|cjs)$/.test(entry)) continue
    if (rel.startsWith(ALLOWED_PREFIX)) continue
    if (entry.endsWith('.test.ts')) continue // tests may mock/stub
    const text = readFileSync(full, 'utf8')
    const lines = text.split('\n')
    lines.forEach((line, i) => {
      const trimmed = line.trimStart()
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return
      const stripped = blankStrings(line)
      for (const re of USAGE) {
        if (re.test(stripped)) violations.push(`${rel}:${i + 1}  ${line.trim()}  [${re}]`)
      }
      // Real import/require of a network module (not string data).
      const isImport = /^\s*import\b/.test(stripped) || /\brequire\s*\(/.test(stripped)
      if (isImport && NET_MODULE.test(line)) {
        violations.push(`${rel}:${i + 1}  ${line.trim()}  [network import]`)
      }
    })
  }
}

scan(SRC)

if (violations.length > 0) {
  console.error('NETWORK FENCE VIOLATION — network APIs outside src/engine:\n')
  for (const v of violations) console.error('  ' + v)
  console.error(
    '\nThe zero-network guarantee allows sockets only in src/engine. Move the code or remove the call.'
  )
  process.exit(1)
}
console.log('network fence: OK (no network APIs outside src/engine)')
