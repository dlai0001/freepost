/**
 * Map a tokenized grpcurl invocation onto GrpcRequestModel. Pinned flag subset
 * (grpcurl uses single-dash long flags): -plaintext, -insecure, -d, -H,
 * -import-path, -proto, -max-time, plus two positionals: the target address and
 * the fully-qualified method. Anything else is a ParseError (same strictness as
 * curl/websocat).
 */
import type { GrpcRequestModel, Header, ParseError } from '@shared/model'
import type { CommandToken } from './shell'

export type GrpcResult = { ok: true; grpc: GrpcRequestModel } | { ok: false; errors: ParseError[] }

const fail = (line: number, message: string): { ok: false; errors: ParseError[] } => ({
  ok: false,
  errors: [{ line, message }]
})

export function mapGrpcurlCommand(argv: CommandToken[]): GrpcResult {
  const metadata: Header[] = []
  const protoFiles: string[] = []
  const importPaths: string[] = []
  let plaintext = false
  let insecure = false
  let data: string | undefined
  let maxTimeSeconds: number | undefined
  const positionals: string[] = []

  let i = 1
  const takeValue = (): CommandToken | null => (i + 1 < argv.length ? argv[++i] : null)

  while (i < argv.length) {
    const tok = argv[i]
    switch (tok.text) {
      case '-plaintext':
        plaintext = true
        break
      case '-insecure':
        insecure = true
        break
      case '-d': {
        const v = takeValue()
        if (!v) return fail(tok.line, 'missing value for -d')
        data = v.text
        break
      }
      case '-H': {
        const v = takeValue()
        if (!v) return fail(tok.line, 'missing value for -H')
        const colon = v.text.indexOf(':')
        if (colon <= 0) {
          return fail(v.line, `malformed metadata ${JSON.stringify(v.text)}: expected "name: value"`)
        }
        metadata.push({ name: v.text.slice(0, colon).trim(), value: v.text.slice(colon + 1).trim() })
        break
      }
      case '-proto': {
        const v = takeValue()
        if (!v) return fail(tok.line, 'missing value for -proto')
        protoFiles.push(v.text)
        break
      }
      case '-import-path': {
        const v = takeValue()
        if (!v) return fail(tok.line, 'missing value for -import-path')
        importPaths.push(v.text)
        break
      }
      case '-max-time': {
        const v = takeValue()
        if (!v) return fail(tok.line, 'missing value for -max-time')
        const n = Number(v.text)
        if (!Number.isFinite(n) || n <= 0) return fail(v.line, `invalid -max-time: ${v.text}`)
        maxTimeSeconds = n
        break
      }
      default: {
        if (tok.text.startsWith('-') && tok.text.length > 1) {
          return fail(tok.line, `unsupported grpcurl flag: ${tok.text}`)
        }
        positionals.push(tok.text)
      }
    }
    i++
  }

  if (positionals.length < 2) {
    return fail(argv[0].line, 'grpcurl requires a target address and a method, e.g. host:50051 pkg.Service/Method')
  }
  if (positionals.length > 2) {
    return fail(argv[0].line, `unexpected extra argument ${JSON.stringify(positionals[2])}`)
  }

  const grpc: GrpcRequestModel = {
    target: positionals[0],
    fullMethod: positionals[1],
    metadata,
    protoFiles,
    importPaths
  }
  if (plaintext) grpc.plaintext = true
  if (insecure) grpc.insecure = true
  if (data !== undefined) grpc.data = data
  if (maxTimeSeconds !== undefined) grpc.maxTimeSeconds = maxTimeSeconds
  return { ok: true, grpc }
}
