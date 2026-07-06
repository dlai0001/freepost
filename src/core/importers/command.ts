/**
 * Lenient import of curl / websocat / wscat commands from pasted text or
 * arbitrary shell scripts. Unlike the strict format parser (which guards the
 * canonical on-disk format), this is one-way: it extracts the first supported
 * command it can find, tolerates unknown flags (recording them in an
 * import-note), and converts wscat syntax to the websocat model.
 */
import type { RequestFile, RequestKind, VariableDecl } from '@shared/model'
import {
  mapCurlCommand,
  mapWebsocatCommand,
  parseRequestFile,
  tokenizeCommandText
} from '../format'
import type { CommandToken } from '../format/shell'
import { extractVarRefs } from '../vars'

export type ImportCommandResult =
  | { ok: true; kind: RequestKind; file: RequestFile; suggestedName: string }
  | { ok: false; error: string }

const COMMANDS = new Set(['curl', 'websocat', 'wscat'])

/** curl flags we deliberately ignore on import (boolean form). */
const CURL_IGNORE_BOOL = new Set([
  '-s', '-S', '-sS', '-Ss', '-v', '--verbose', '-i', '--include', '-#',
  '--progress-bar', '--compressed', '-f', '--fail', '-g', '--globoff',
  '--silent', '--show-error', '-G', '--get'
])

/** curl flags we ignore together with their value argument. */
const CURL_IGNORE_VALUE = new Set([
  '-o', '--output', '-w', '--write-out', '--retry', '--connect-timeout',
  '-c', '--cookie-jar', '--limit-rate', '--cacert', '--capath'
])

export function importCommandText(text: string): ImportCommandResult {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: false, error: 'Nothing to import: empty input' }

  // A canonical (or near-canonical) request file parses strictly — best case.
  for (const kind of ['curl', 'websocat'] as const) {
    const strict = parseRequestFile(text, kind)
    if (strict.ok) {
      const file = withMissingDecls(strict.file)
      return { ok: true, kind, file, suggestedName: suggestName(file) }
    }
  }

  // Lenient path: find the first curl/websocat/wscat logical line in the script.
  const logical = extractCommandLine(text)
  if (logical === null) {
    return {
      ok: false,
      error: 'No curl, websocat, or wscat command found in the input'
    }
  }
  const tok = tokenizeCommandText(logical.text, () => logical.line)
  if (!tok.ok) {
    return { ok: false, error: `line ${tok.error.line}: ${tok.error.message}` }
  }
  const argv = tok.tokens
  if (argv.length === 0) return { ok: false, error: 'Empty command' }
  const cmd = argv[0].text

  if (cmd === 'curl') {
    const { kept, notes } = filterCurlArgv(argv)
    const mapped = mapCurlCommand(kept)
    if (!mapped.ok) {
      const msgs = mapped.errors.map((e) => e.message).join('; ')
      return { ok: false, error: `Could not import curl command: ${msgs}` }
    }
    const file: RequestFile = {
      kind: 'curl',
      frontmatter: notes.length > 0 ? { 'import-note': notes.join('; ') } : {},
      variables: declsForRefs(collectHttpRefs(mapped.http)),
      http: mapped.http,
      comments: []
    }
    return { ok: true, kind: 'curl', file, suggestedName: suggestName(file) }
  }

  if (cmd === 'websocat') {
    const mapped = mapWebsocatCommand(argv)
    if (!mapped.ok) {
      const msgs = mapped.errors.map((e) => e.message).join('; ')
      return { ok: false, error: `Could not import websocat command: ${msgs}` }
    }
    const file: RequestFile = {
      kind: 'websocat',
      frontmatter: {},
      variables: declsForRefs(collectWsRefs(mapped.ws)),
      ws: mapped.ws,
      comments: []
    }
    return { ok: true, kind: 'websocat', file, suggestedName: suggestName(file) }
  }

  // wscat -> websocat model.
  return importWscat(argv)
}

/** wscat syntax: wscat -c <url> [-H 'k: v']... [-s subprotocol] [--auth user:pass] */
function importWscat(argv: CommandToken[]): ImportCommandResult {
  let url: string | undefined
  const headers: { name: string; value: string }[] = []
  let protocol: string | undefined
  const notes: string[] = []

  let i = 1
  const next = (flag: string): string | null => {
    i++
    if (i >= argv.length) {
      notes.push(`flag ${flag} had no value`)
      return null
    }
    return argv[i].text
  }
  for (; i < argv.length; i++) {
    const t = argv[i].text
    switch (t) {
      case '-c':
      case '--connect': {
        const v = next(t)
        if (v !== null) url = v
        break
      }
      case '-H':
      case '--header': {
        const v = next(t)
        if (v !== null) {
          const idx = v.indexOf(':')
          if (idx === -1) notes.push(`ignored malformed header "${v}"`)
          else headers.push({ name: v.slice(0, idx).trim(), value: v.slice(idx + 1).trim() })
        }
        break
      }
      case '-s':
      case '--subprotocol': {
        const v = next(t)
        if (v !== null) protocol = v
        break
      }
      case '--auth': {
        const v = next(t)
        if (v !== null) {
          headers.push({
            name: 'Authorization',
            value: `Basic ${Buffer.from(v).toString('base64')}`
          })
        }
        break
      }
      case '-n':
      case '--no-check':
        notes.push('ignored -n/--no-check (configure TLS in app settings)')
        break
      default:
        if (t.startsWith('-')) notes.push(`ignored unsupported wscat flag ${t}`)
        else if (url === undefined) url = t
        else notes.push(`ignored extra argument "${t}"`)
    }
  }
  if (url === undefined) {
    return { ok: false, error: 'wscat command has no URL (expected -c <url>)' }
  }
  const file: RequestFile = {
    kind: 'websocat',
    frontmatter: notes.length > 0 ? { 'import-note': notes.join('; ') } : {},
    variables: declsForRefs(extractVarRefs(url).concat(headers.flatMap((h) => extractVarRefs(h.value)))),
    ws: { url, headers, protocol },
    comments: []
  }
  return { ok: true, kind: 'websocat', file, suggestedName: suggestName(file) }
}

/** Join backslash continuations and return the first supported command line. */
function extractCommandLine(text: string): { text: string; line: number } | null {
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
  for (let i = 0; i < lines.length; i++) {
    const first = lines[i].trim().split(/\s+/)[0] ?? ''
    if (!COMMANDS.has(first)) continue
    let joined = lines[i].trim()
    let j = i
    while (joined.endsWith('\\') && j + 1 < lines.length) {
      joined = joined.slice(0, -1) + ' ' + lines[++j].trim()
    }
    return { text: joined, line: i + 1 }
  }
  return null
}

/** Drop curl flags we don't understand rather than failing the import. */
function filterCurlArgv(argv: CommandToken[]): { kept: CommandToken[]; notes: string[] } {
  const KNOWN_VALUE = new Set([
    '-X', '--request', '--url', '-H', '--header', '-d', '--data', '--data-raw',
    '-u', '--user', '--max-time'
  ])
  const KNOWN_BOOL = new Set(['-k', '--insecure', '-L', '--location'])
  const kept: CommandToken[] = [argv[0]]
  const notes: string[] = []
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i].text
    if (KNOWN_VALUE.has(t)) {
      kept.push(argv[i])
      if (i + 1 < argv.length) kept.push(argv[++i])
      continue
    }
    if (KNOWN_BOOL.has(t) || !t.startsWith('-')) {
      kept.push(argv[i])
      continue
    }
    if (t === '-A' || t === '--user-agent') {
      const v = argv[++i]
      if (v !== undefined) {
        kept.push({ text: '--header', line: argv[i - 1].line })
        kept.push({ text: `User-Agent: ${v.text}`, line: v.line })
      }
      continue
    }
    if (t === '-e' || t === '--referer') {
      const v = argv[++i]
      if (v !== undefined) {
        kept.push({ text: '--header', line: argv[i - 1].line })
        kept.push({ text: `Referer: ${v.text}`, line: v.line })
      }
      continue
    }
    if (t === '-b' || t === '--cookie') {
      const v = argv[++i]
      if (v !== undefined && v.text.includes('=')) {
        kept.push({ text: '--header', line: argv[i - 1].line })
        kept.push({ text: `Cookie: ${v.text}`, line: v.line })
      } else {
        notes.push(`ignored ${t} (cookie file)`)
      }
      continue
    }
    if (CURL_IGNORE_VALUE.has(t)) {
      i++
      notes.push(`ignored flag ${t}`)
      continue
    }
    if (CURL_IGNORE_BOOL.has(t)) {
      notes.push(`ignored flag ${t}`)
      continue
    }
    // Unknown flag: assume boolean and drop, but say so.
    notes.push(`ignored unknown flag ${t}`)
  }
  return { kept, notes }
}

function collectHttpRefs(http: NonNullable<RequestFile['http']>): string[] {
  const refs = extractVarRefs(http.url)
  for (const h of http.headers) refs.push(...extractVarRefs(h.value))
  if (http.body !== undefined) refs.push(...extractVarRefs(http.body.value))
  if (http.options.user !== undefined) refs.push(...extractVarRefs(http.options.user))
  return refs
}

function collectWsRefs(ws: NonNullable<RequestFile['ws']>): string[] {
  const refs = extractVarRefs(ws.url)
  for (const h of ws.headers) refs.push(...extractVarRefs(h.value))
  return refs
}

function declsForRefs(refs: string[]): VariableDecl[] {
  return [...new Set(refs)].map((name) => ({ name, required: false, defaultValue: '' }))
}

/** Add declarations for ${VAR} refs the assignment block doesn't cover. */
function withMissingDecls(file: RequestFile): RequestFile {
  const refs =
    file.http !== undefined ? collectHttpRefs(file.http) : file.ws !== undefined ? collectWsRefs(file.ws) : []
  const declared = new Set(file.variables.map((v) => v.name))
  const missing = declsForRefs(refs.filter((r) => !declared.has(r)))
  if (missing.length === 0) return file
  return { ...file, variables: [...file.variables, ...missing] }
}

/** Suggest a filename-safe request name from the URL. */
export function suggestName(file: RequestFile): string {
  const url = file.http?.url ?? file.ws?.url ?? ''
  const stripped = url.replace(/\$\{[^}]*\}/g, '').replace(/^[a-z+]+:\/\//i, '')
  const segments = stripped.split('/').filter((s) => s !== '' && !s.includes('?'))
  const last = segments.length > 1 ? segments[segments.length - 1] : segments[0]
  const method = file.http?.method
  const base = (last ?? '').replace(/[<>:"/\\|?*]/g, '').trim()
  if (base === '') return 'Imported request'
  return method !== undefined && method !== 'GET' ? `${method} ${base}` : base
}
