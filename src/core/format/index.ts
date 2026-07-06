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

export { writeRequestFile, quoteShellValue } from './writer'
export { extractFrontmatter, serializeFrontmatter } from './frontmatter'
export { parseBody, tokenizeCommandText } from './shell'
export { mapCurlCommand } from './curl'
export { mapWebsocatCommand } from './websocat'

const stripCr = (s: string): string => (s.endsWith('\r') ? s.slice(0, -1) : s)

/** Derive the request kind from a file path/name, or null if not a request file. */
export function requestKindForPath(path: string): RequestKind | null {
  if (path.endsWith('.curl')) return 'curl'
  if (path.endsWith('.ws')) return 'websocat'
  return null
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

  const expected = kind === 'curl' ? 'curl' : 'websocat'
  const head = argv[0]
  if (head.text !== expected) {
    return {
      ok: false,
      errors: [
        {
          line: head.line,
          message: `command "${head.text}" does not match the file kind: expected a ${expected} invocation`,
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

  const mapped = mapWebsocatCommand(argv)
  if (!mapped.ok) return mapped
  const file: RequestFile = { kind, frontmatter: fm.frontmatter, variables, comments, ws: mapped.ws }
  return { ok: true, file }
}
