/**
 * Canonical pretty-printer (the gofmt model, PLAN.md rewrite contract):
 * shebang, frontmatter block (omitted when empty), blank line, assignment
 * block sorted by variable name, blank line, then the single command with
 * long-form flags, one per line, two-space indent, ` \` continuations.
 * Body comments are re-emitted before the statement they precede.
 *
 * When `frontmatter.graphql` is present, the --data value is GENERATED from
 * it (graphql is the source of truth; hand edits to --data are overwritten).
 */
import type {
  BodyComment,
  Frontmatter,
  HttpRequestModel,
  RequestFile,
  VariableDecl,
  WsRequestModel,
} from '@shared/model'
import { serializeFrontmatter } from './frontmatter'

/**
 * Canonical quoting: single quotes for values without ${VAR} references
 * (with the '\'' idiom for embedded single quotes), double quotes for values
 * containing ${VAR} (escaping ", \, ` and any $ not starting a reference).
 */
export function quoteShellValue(value: string): string {
  if (!value.includes('${')) {
    return `'${value.split("'").join("'\\''")}'`
  }
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    if (c === '\\') out += '\\\\'
    else if (c === '"') out += '\\"'
    else if (c === '`') out += '\\`'
    else if (c === '$' && value[i + 1] !== '{') out += '\\$'
    else out += c
  }
  return `"${out}"`
}

const assignmentLine = (d: VariableDecl): string =>
  d.required ? `${d.name}="\${${d.name}:?}"` : `${d.name}="\${${d.name}:-${d.defaultValue ?? ''}}"`

const commentLine = (c: BodyComment): string => (c.text === '' ? '#' : `# ${c.text}`)

/** Lay out `first` plus indented flags with ` \` continuations. */
function commandBlock(first: string, flags: string[]): string[] {
  const all = [first, ...flags.map((f) => `  ${f}`)]
  return all.map((line, idx) => (idx < all.length - 1 ? `${line} \\` : line))
}

function curlLines(http: HttpRequestModel, frontmatter: Frontmatter): string[] {
  let body = http.body
  const gql = frontmatter.graphql
  if (gql && typeof gql === 'object' && typeof gql.query === 'string') {
    const payload: Record<string, unknown> = { query: gql.query }
    if (gql.variables !== undefined) payload.variables = gql.variables
    body = { kind: 'raw', value: JSON.stringify(payload) }
  }

  const flags: string[] = [`--url ${quoteShellValue(http.url)}`]
  for (const h of http.headers) {
    flags.push(`--header ${quoteShellValue(`${h.name}: ${h.value}`)}`)
  }
  if (body !== undefined) {
    flags.push(`--data ${quoteShellValue(body.kind === 'file' ? `@${body.value}` : body.value)}`)
  }
  const o = http.options
  if (o.user !== undefined) flags.push(`--user ${quoteShellValue(o.user)}`)
  if (o.insecure) flags.push('--insecure')
  if (o.followRedirects) flags.push('--location')
  if (o.timeoutSeconds !== undefined) flags.push(`--max-time ${o.timeoutSeconds}`)
  return commandBlock(`curl --request ${http.method}`, flags)
}

function websocatLines(ws: WsRequestModel): string[] {
  const flags: string[] = []
  for (const h of ws.headers) {
    flags.push(`--header ${quoteShellValue(`${h.name}: ${h.value}`)}`)
  }
  if (ws.protocol !== undefined) flags.push(`--protocol ${quoteShellValue(ws.protocol)}`)
  return commandBlock(`websocat ${quoteShellValue(ws.url)}`, flags)
}

export function writeRequestFile(file: RequestFile): string {
  const out: string[] = ['#!/usr/bin/env bash']

  const fmBlock = serializeFrontmatter(file.frontmatter)
  if (fmBlock !== '') out.push(fmBlock)
  out.push('')

  // Comments are attached by original statement index (file order at parse
  // time); when assignments are re-sorted, each comment travels with its
  // statement.
  const commentsFor = (statementIndex: number): string[] =>
    file.comments.filter((c) => c.beforeStatement === statementIndex).map(commentLine)

  const sorted = file.variables
    .map((decl, originalIndex) => ({ decl, originalIndex }))
    .sort((a, b) =>
      a.decl.name === b.decl.name
        ? a.originalIndex - b.originalIndex
        : a.decl.name < b.decl.name
          ? -1
          : 1,
    )
  for (const { decl, originalIndex } of sorted) {
    out.push(...commentsFor(originalIndex))
    out.push(assignmentLine(decl))
  }
  if (sorted.length > 0) out.push('')

  out.push(...commentsFor(file.variables.length))
  if (file.kind === 'curl') {
    if (!file.http) throw new Error('writeRequestFile: kind "curl" requires the http model')
    out.push(...curlLines(file.http, file.frontmatter))
  } else {
    if (!file.ws) throw new Error('writeRequestFile: kind "websocat" requires the ws model')
    out.push(...websocatLines(file.ws))
  }

  // Trailing comments (after the command).
  out.push(...file.comments.filter((c) => c.beforeStatement > file.variables.length).map(commentLine))

  return out.join('\n') + '\n'
}
