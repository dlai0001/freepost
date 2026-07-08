/**
 * Map a tokenized curl invocation onto HttpRequestModel. Only the pinned
 * supported-flag subset is accepted (PLAN.md §3); any other flag is a
 * ParseError so that unknown constructs are never silently dropped.
 */
import type { FormField, Header, HttpRequestModel, ParseError } from '@shared/model'
import type { CommandToken } from './shell'

export type CurlResult = { ok: true; http: HttpRequestModel } | { ok: false; errors: ParseError[] }

const fail = (line: number, message: string): { ok: false; errors: ParseError[] } => ({
  ok: false,
  errors: [{ line, message }],
})

/**
 * Parse a curl `-F` argument (`name=value` with optional `;type=`/`;filename=`
 * modifiers; value may be `@path` for a file upload). frontmatter.form is the
 * canonical multipart source when present — this exists so files carrying
 * generated/imported --form flags parse without error.
 */
function parseFormArg(text: string): FormField | null {
  const eq = text.indexOf('=')
  if (eq <= 0) return null
  const name = text.slice(0, eq)
  let rest = text.slice(eq + 1)
  let filename: string | undefined
  let contentType: string | undefined
  const modRe = /;(type|filename)=([^;]*)$/
  for (let m = modRe.exec(rest); m !== null; m = modRe.exec(rest)) {
    if (m[1] === 'filename') filename = m[2]
    else contentType = m[2]
    rest = rest.slice(0, m.index)
  }
  if (rest.startsWith('@') || rest.startsWith('<')) {
    const field: FormField = { name, type: 'file', value: rest.slice(1) }
    if (filename !== undefined) field.filename = filename
    return field
  }
  // A literal value tagged application/json round-trips as a json part.
  if (contentType === 'application/json') {
    const field: FormField = { name, type: 'json', content: rest }
    if (filename !== undefined) field.filename = filename
    return field
  }
  return { name, type: 'text', value: rest }
}

export function mapCurlCommand(argv: CommandToken[]): CurlResult {
  let method: string | undefined
  let url: string | undefined
  const headers: Header[] = []
  let body: HttpRequestModel['body']
  const form: FormField[] = []
  let user: string | undefined
  let insecure = false
  let followRedirects = false
  let timeoutSeconds: number | undefined

  let i = 1
  const takeValue = (): CommandToken | null => (i + 1 < argv.length ? argv[++i] : null)

  while (i < argv.length) {
    const tok = argv[i]
    switch (tok.text) {
      case '-X':
      case '--request': {
        const v = takeValue()
        if (!v) return fail(tok.line, `missing value for ${tok.text}`)
        if (method !== undefined) return fail(tok.line, 'duplicate --request flag')
        method = v.text
        break
      }
      case '--url': {
        const v = takeValue()
        if (!v) return fail(tok.line, 'missing value for --url')
        if (url !== undefined) return fail(tok.line, 'duplicate URL: --url given more than once (or both --url and a positional URL)')
        url = v.text
        break
      }
      case '-H':
      case '--header': {
        const v = takeValue()
        if (!v) return fail(tok.line, `missing value for ${tok.text}`)
        const colon = v.text.indexOf(':')
        if (colon <= 0) return fail(v.line, `malformed header ${JSON.stringify(v.text)}: expected "Name: value"`)
        headers.push({ name: v.text.slice(0, colon).trim(), value: v.text.slice(colon + 1).trim() })
        break
      }
      case '-d':
      case '--data':
      case '--data-raw': {
        const v = takeValue()
        if (!v) return fail(tok.line, `missing value for ${tok.text}`)
        if (body !== undefined) return fail(tok.line, 'duplicate data flag: only one --data per request')
        body = v.text.startsWith('@')
          ? { kind: 'file', value: v.text.slice(1) }
          : { kind: 'raw', value: v.text }
        break
      }
      case '-F':
      case '--form': {
        const v = takeValue()
        if (!v) return fail(tok.line, `missing value for ${tok.text}`)
        const field = parseFormArg(v.text)
        if (field === null) {
          return fail(v.line, `malformed form field ${JSON.stringify(v.text)}: expected "name=value"`)
        }
        form.push(field)
        break
      }
      case '-u':
      case '--user': {
        const v = takeValue()
        if (!v) return fail(tok.line, `missing value for ${tok.text}`)
        if (user !== undefined) return fail(tok.line, 'duplicate --user flag')
        user = v.text
        break
      }
      case '-k':
      case '--insecure':
        insecure = true
        break
      case '-L':
      case '--location':
        followRedirects = true
        break
      case '--max-time': {
        const v = takeValue()
        if (!v) return fail(tok.line, 'missing value for --max-time')
        const seconds = Number(v.text)
        if (v.text.trim() === '' || !Number.isFinite(seconds)) {
          return fail(v.line, `--max-time expects a number of seconds, got ${JSON.stringify(v.text)}`)
        }
        timeoutSeconds = seconds
        break
      }
      default: {
        if (tok.text.startsWith('-') && tok.text.length > 1) {
          return fail(tok.line, `unsupported curl flag: ${tok.text}`)
        }
        if (url !== undefined) {
          return fail(tok.line, `unexpected extra argument ${JSON.stringify(tok.text)}: the URL is already set`)
        }
        url = tok.text
      }
    }
    i++
  }

  if (url === undefined) {
    return fail(argv[0].line, 'missing URL: pass --url <url> or a single positional URL argument')
  }
  if (body !== undefined && form.length > 0) {
    return fail(argv[0].line, 'cannot combine --data with --form: choose one body type')
  }

  const http: HttpRequestModel = {
    method: method ?? (body !== undefined || form.length > 0 ? 'POST' : 'GET'),
    url,
    headers,
    options: {},
  }
  if (body !== undefined) http.body = body
  if (form.length > 0) http.form = form
  if (user !== undefined) http.options.user = user
  if (insecure) http.options.insecure = true
  if (followRedirects) http.options.followRedirects = true
  if (timeoutSeconds !== undefined) http.options.timeoutSeconds = timeoutSeconds
  return { ok: true, http }
}
