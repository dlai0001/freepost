/**
 * Map a tokenized MCP Inspector CLI invocation onto McpRequestModel. Pinned
 * flag subset of `npx @modelcontextprotocol/inspector --cli ...`:
 * --cli, --transport, --header, -e, --method, --tool-name, --tool-arg, --uri,
 * --prompt-name, --prompt-args. Anything else is a ParseError (same strictness
 * as curl/grpcurl/mosquitto).
 *
 * Two shapes, both real invocations:
 *   stdio — the positionals after --cli are the server command + its argv:
 *     npx @modelcontextprotocol/inspector --cli node server.mjs --method tools/list
 *   http  — the single positional after --cli is the endpoint URL:
 *     npx @modelcontextprotocol/inspector --cli http://host/mcp --method tools/list
 *
 * The server command's own flags (e.g. `-y`) are indistinguishable from
 * Inspector flags by shape alone, so positionals are consumed greedily after
 * --cli and stop at the first *known* Inspector flag. The writer always emits
 * the server command before any Inspector flag, keeping the split unambiguous
 * on re-parse.
 */
import type { Header, McpArg, McpMethod, McpRequestModel, McpTransport, ParseError } from '@shared/model'
import type { CommandToken } from './shell'

export type McpResult = { ok: true; mcp: McpRequestModel } | { ok: false; errors: ParseError[] }

const fail = (line: number, message: string): { ok: false; errors: ParseError[] } => ({
  ok: false,
  errors: [{ line, message }]
})

/** The Inspector package, as written after `npx` (an @version suffix is fine). */
const INSPECTOR_PKG = '@modelcontextprotocol/inspector'

const METHODS: readonly McpMethod[] = [
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/read',
  'prompts/list',
  'prompts/get'
]

/**
 * Flags that terminate the positional run after --cli. A dashed token that is
 * NOT in this set is treated as an argument to the stdio server command.
 */
const INSPECTOR_FLAGS = new Set([
  '--transport',
  '--header',
  '--method',
  '--tool-name',
  '--tool-arg',
  '--uri',
  '--prompt-name',
  '--prompt-args',
  '-e'
])

/** Split a `key=value` token; the value may itself contain '='. */
function splitPair(tok: CommandToken, what: string): McpArg | ParseError {
  const eq = tok.text.indexOf('=')
  if (eq <= 0) {
    return { line: tok.line, message: `malformed ${what} ${JSON.stringify(tok.text)}: expected "key=value"` }
  }
  return { name: tok.text.slice(0, eq), value: tok.text.slice(eq + 1) }
}

const isArg = (x: McpArg | ParseError): x is McpArg => 'name' in x

export function mapInspectorCommand(argv: CommandToken[]): McpResult {
  const head = argv[0]
  if (head.text !== 'npx') {
    return fail(head.line, `expected an npx ${INSPECTOR_PKG} invocation, got ${JSON.stringify(head.text)}`)
  }

  let i = 1
  // `npx -y @modelcontextprotocol/inspector` is as valid as the bare form.
  while (i < argv.length && (argv[i].text === '-y' || argv[i].text === '--yes')) i++

  const pkg = argv[i]
  if (pkg === undefined || !pkg.text.startsWith(INSPECTOR_PKG)) {
    return fail(
      pkg?.line ?? head.line,
      `expected an npx ${INSPECTOR_PKG} invocation, got ${JSON.stringify(pkg?.text ?? '')}`
    )
  }
  i++

  const cli = argv[i]
  if (cli === undefined || cli.text !== '--cli') {
    return fail(
      cli?.line ?? pkg.line,
      'a .mcp file must use the Inspector CLI mode: expected --cli after the package name'
    )
  }
  i++

  // Positional run: the stdio server command + argv, or the http endpoint URL.
  const positionals: CommandToken[] = []
  while (i < argv.length && !INSPECTOR_FLAGS.has(argv[i].text)) {
    positionals.push(argv[i])
    i++
  }

  const headers: Header[] = []
  const env: McpArg[] = []
  const toolArgs: McpArg[] = []
  const promptArgs: McpArg[] = []
  let transport: McpTransport | undefined
  let method: McpMethod | undefined
  let toolName: string | undefined
  let uri: string | undefined
  let promptName: string | undefined

  const takeValue = (): CommandToken | null => (i + 1 < argv.length ? argv[++i] : null)

  while (i < argv.length) {
    const tok = argv[i]
    switch (tok.text) {
      case '--transport': {
        const v = takeValue()
        if (!v) return fail(tok.line, 'missing value for --transport')
        if (v.text !== 'stdio' && v.text !== 'http') {
          return fail(
            v.line,
            `unsupported --transport ${JSON.stringify(v.text)}: expected stdio or http (sse is deprecated in the MCP spec)`
          )
        }
        transport = v.text
        break
      }
      case '--header': {
        const v = takeValue()
        if (!v) return fail(tok.line, 'missing value for --header')
        const colon = v.text.indexOf(':')
        if (colon <= 0) {
          return fail(v.line, `malformed header ${JSON.stringify(v.text)}: expected "name: value"`)
        }
        headers.push({ name: v.text.slice(0, colon).trim(), value: v.text.slice(colon + 1).trim() })
        break
      }
      case '-e': {
        const v = takeValue()
        if (!v) return fail(tok.line, 'missing value for -e')
        const pair = splitPair(v, '-e entry')
        if (!isArg(pair)) return { ok: false, errors: [pair] }
        env.push(pair)
        break
      }
      case '--method': {
        const v = takeValue()
        if (!v) return fail(tok.line, 'missing value for --method')
        if (!METHODS.includes(v.text as McpMethod)) {
          return fail(v.line, `unsupported --method ${JSON.stringify(v.text)}: expected one of ${METHODS.join(', ')}`)
        }
        method = v.text as McpMethod
        break
      }
      case '--tool-name': {
        const v = takeValue()
        if (!v) return fail(tok.line, 'missing value for --tool-name')
        toolName = v.text
        break
      }
      case '--tool-arg': {
        const v = takeValue()
        if (!v) return fail(tok.line, 'missing value for --tool-arg')
        const pair = splitPair(v, '--tool-arg')
        if (!isArg(pair)) return { ok: false, errors: [pair] }
        toolArgs.push(pair)
        break
      }
      case '--uri': {
        const v = takeValue()
        if (!v) return fail(tok.line, 'missing value for --uri')
        uri = v.text
        break
      }
      case '--prompt-name': {
        const v = takeValue()
        if (!v) return fail(tok.line, 'missing value for --prompt-name')
        promptName = v.text
        break
      }
      case '--prompt-args': {
        const v = takeValue()
        if (!v) return fail(tok.line, 'missing value for --prompt-args')
        const pair = splitPair(v, '--prompt-args')
        if (!isArg(pair)) return { ok: false, errors: [pair] }
        promptArgs.push(pair)
        break
      }
      default:
        return fail(tok.line, `unsupported inspector flag: ${tok.text}`)
    }
    i++
  }

  if (positionals.length === 0) {
    return fail(
      cli.line,
      'missing MCP server target after --cli: a server command (stdio) or an http(s) endpoint URL'
    )
  }
  if (method === undefined) {
    return fail(cli.line, `missing --method: expected one of ${METHODS.join(', ')}`)
  }

  // Transport: explicit --transport wins; otherwise a lone http(s) URL means
  // Streamable HTTP and anything else is a command to spawn.
  const looksHttp = positionals.length === 1 && /^https?:\/\//.test(positionals[0].text)
  const resolved: McpTransport = transport ?? (looksHttp ? 'http' : 'stdio')

  if (resolved === 'http' && positionals.length > 1) {
    return fail(positionals[1].line, 'the http transport takes a single endpoint URL, not a server command')
  }
  if (resolved === 'stdio' && headers.length > 0) {
    return fail(cli.line, '--header is only valid with the http transport')
  }
  if (resolved === 'http' && env.length > 0) {
    return fail(cli.line, '-e is only valid with the stdio transport (it sets the subprocess environment)')
  }

  // Per-method argument rules — a .mcp file names exactly one operation.
  if (method === 'tools/call' && toolName === undefined) {
    return fail(cli.line, '--method tools/call requires --tool-name')
  }
  if (method !== 'tools/call' && (toolName !== undefined || toolArgs.length > 0)) {
    return fail(cli.line, '--tool-name/--tool-arg are only valid with --method tools/call')
  }
  if (method === 'resources/read' && uri === undefined) {
    return fail(cli.line, '--method resources/read requires --uri')
  }
  if (method !== 'resources/read' && uri !== undefined) {
    return fail(cli.line, '--uri is only valid with --method resources/read')
  }
  if (method === 'prompts/get' && promptName === undefined) {
    return fail(cli.line, '--method prompts/get requires --prompt-name')
  }
  if (method !== 'prompts/get' && (promptName !== undefined || promptArgs.length > 0)) {
    return fail(cli.line, '--prompt-name/--prompt-args are only valid with --method prompts/get')
  }

  const mcp: McpRequestModel = {
    transport: resolved,
    args: [],
    env,
    headers,
    method,
    toolArgs,
    promptArgs
  }
  if (resolved === 'http') {
    mcp.url = positionals[0].text
  } else {
    mcp.command = positionals[0].text
    mcp.args = positionals.slice(1).map((t) => t.text)
  }
  if (toolName !== undefined) mcp.toolName = toolName
  if (uri !== undefined) mcp.uri = uri
  if (promptName !== undefined) mcp.promptName = promptName

  return { ok: true, mcp }
}
