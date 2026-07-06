/**
 * Map a tokenized websocat invocation onto WsRequestModel. Pinned flag
 * subset: positional URL, -H/--header, --protocol. Anything else is a
 * ParseError (same strictness as curl).
 */
import type { Header, ParseError, WsRequestModel } from '@shared/model'
import type { CommandToken } from './shell'

export type WebsocatResult = { ok: true; ws: WsRequestModel } | { ok: false; errors: ParseError[] }

const fail = (line: number, message: string): { ok: false; errors: ParseError[] } => ({
  ok: false,
  errors: [{ line, message }],
})

export function mapWebsocatCommand(argv: CommandToken[]): WebsocatResult {
  let url: string | undefined
  let protocol: string | undefined
  const headers: Header[] = []

  let i = 1
  const takeValue = (): CommandToken | null => (i + 1 < argv.length ? argv[++i] : null)

  while (i < argv.length) {
    const tok = argv[i]
    switch (tok.text) {
      case '-H':
      case '--header': {
        const v = takeValue()
        if (!v) return fail(tok.line, `missing value for ${tok.text}`)
        const colon = v.text.indexOf(':')
        if (colon <= 0) return fail(v.line, `malformed header ${JSON.stringify(v.text)}: expected "Name: value"`)
        headers.push({ name: v.text.slice(0, colon).trim(), value: v.text.slice(colon + 1).trim() })
        break
      }
      case '--protocol': {
        const v = takeValue()
        if (!v) return fail(tok.line, 'missing value for --protocol')
        if (protocol !== undefined) return fail(tok.line, 'duplicate --protocol flag')
        protocol = v.text
        break
      }
      default: {
        if (tok.text.startsWith('-') && tok.text.length > 1) {
          return fail(tok.line, `unsupported websocat flag: ${tok.text}`)
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
    return fail(argv[0].line, 'missing URL: websocat requires a positional URL argument')
  }

  const ws: WsRequestModel = { url, headers }
  if (protocol !== undefined) ws.protocol = protocol
  return { ok: true, ws }
}
