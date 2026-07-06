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

const ROOT = new URL('..', import.meta.url).pathname
const SRC = join(ROOT, 'src')
const ALLOWED_PREFIX = join('src', 'engine')

const FORBIDDEN = [
  /\bfetch\s*\(/, // global fetch
  /from\s+['"](?:node:)?https?['"]/, // http/https imports
  /require\(\s*['"](?:node:)?https?['"]\s*\)/,
  /from\s+['"](?:node:)?net['"]/,
  /require\(\s*['"](?:node:)?net['"]\s*\)/,
  /from\s+['"](?:node:)?dgram['"]/,
  /from\s+['"](?:node:)?tls['"]/,
  /from\s+['"]ws['"]/, // ws package
  /require\(\s*['"]ws['"]\s*\)/,
  /from\s+['"]undici['"]/,
  /new\s+WebSocket\s*\(/,
  /XMLHttpRequest/,
  /navigator\.sendBeacon/,
  /new\s+EventSource\s*\(/
]

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
      if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return
      for (const re of FORBIDDEN) {
        if (re.test(line)) violations.push(`${rel}:${i + 1}  ${line.trim()}  [${re}]`)
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
