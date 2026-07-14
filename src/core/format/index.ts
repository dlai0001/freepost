/**
 * Public API of the file-format library.
 *
 *   parseRequestFile(raw, kind)  — raw file text -> ParseResult
 *   writeRequestFile(file)       — RequestFile -> canonical file text
 *   requestKindForPath(path)     — .curl -> 'curl', .ws -> 'websocat'
 */
import type { ParseResult, RequestFile, RequestKind } from '@shared/model'
import { extractFrontmatter } from './frontmatter'
import { parseBody } from './shell'
import { mapCurlCommand } from './curl'
import { mapWebsocatCommand } from './websocat'
import { mapGrpcurlCommand } from './grpc'
import { mapMosquittoCommand } from './mqtt'
import { mapInspectorCommand } from './mcp'

export { writeRequestFile, quoteShellValue } from './writer'
export { extractFrontmatter, serializeFrontmatter } from './frontmatter'
export { parseBody, tokenizeCommandText } from './shell'
export { mapCurlCommand } from './curl'
export { mapWebsocatCommand } from './websocat'
export { mapGrpcurlCommand } from './grpc'
export { mapMosquittoCommand } from './mqtt'
export { mapInspectorCommand } from './mcp'

const stripCr = (s: string): string => (s.endsWith('\r') ? s.slice(0, -1) : s)

/** Derive the request kind from a file path/name, or null if not a request file. */
export function requestKindForPath(path: string): RequestKind | null {
  if (path.endsWith('.curl')) return 'curl'
  if (path.endsWith('.ws')) return 'websocat'
  if (path.endsWith('.grpc')) return 'grpc'
  if (path.endsWith('.mqtt')) return 'mqtt'
  if (path.endsWith('.mcp')) return 'mcp'
  return null
}

/**
 * Head command(s) allowed for each kind. MQTT accepts two (pub/sub); the
 * mapper picks the mode from whichever is present. MCP's head is `npx` — the
 * runner, not the protocol — so the mapper checks the package name after it.
 */
function allowedCommands(kind: RequestKind): string[] {
  switch (kind) {
    case 'curl':
      return ['curl']
    case 'websocat':
      return ['websocat']
    case 'grpc':
      return ['grpcurl']
    case 'mqtt':
      return ['mosquitto_pub', 'mosquitto_sub']
    case 'mcp':
      return ['npx']
  }
}

export function parseRequestFile(raw: string, kind: RequestKind): ParseResult {
  const lines = raw.split('\n')

  let i = 0
  if (lines[0]?.startsWith('#!')) i = 1
  while (i < lines.length && stripCr(lines[i]).trim() === '') i++

  const fm = extractFrontmatter(lines, i)
  if (!fm.ok) return fm

  const body = parseBody(lines, fm.nextIndex)
  if (!body.ok) return body
  const { argv, variables, comments } = body.body

  const allowed = allowedCommands(kind)
  const head = argv[0]
  if (!allowed.includes(head.text)) {
    return {
      ok: false,
      errors: [
        {
          line: head.line,
          message: `command "${head.text}" does not match the file kind: expected a ${allowed.join(' or ')} invocation`,
        },
      ],
    }
  }

  if (kind === 'curl') {
    const mapped = mapCurlCommand(argv)
    if (!mapped.ok) return mapped
    const file: RequestFile = { kind, frontmatter: fm.frontmatter, variables, comments, http: mapped.http }
    return { ok: true, file }
  }

  if (kind === 'grpc') {
    const mapped = mapGrpcurlCommand(argv)
    if (!mapped.ok) return mapped
    const file: RequestFile = { kind, frontmatter: fm.frontmatter, variables, comments, grpc: mapped.grpc }
    return { ok: true, file }
  }

  if (kind === 'mqtt') {
    const mapped = mapMosquittoCommand(argv)
    if (!mapped.ok) return mapped
    const file: RequestFile = { kind, frontmatter: fm.frontmatter, variables, comments, mqtt: mapped.mqtt }
    return { ok: true, file }
  }

  if (kind === 'mcp') {
    const mapped = mapInspectorCommand(argv)
    if (!mapped.ok) return mapped
    const file: RequestFile = { kind, frontmatter: fm.frontmatter, variables, comments, mcp: mapped.mcp }
    return { ok: true, file }
  }

  const mapped = mapWebsocatCommand(argv)
  if (!mapped.ok) return mapped
  const file: RequestFile = { kind, frontmatter: fm.frontmatter, variables, comments, ws: mapped.ws }
  return { ok: true, file }
}
