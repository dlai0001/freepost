/**
 * Recorded exchange -> saveable request file ("Save to collection"). Pure.
 * REST/SSE become a plain .curl model; GraphQL becomes a .curl with
 * `frontmatter.graphql` as the source of truth (the writer regenerates --data
 * from it, and the editor opens it in the GraphQL body mode). gRPC becomes a
 * .grpc skeleton (target + method + metadata; the user attaches protos — a
 * tier-1 capture never decodes the messages). WebSocket sessions become a .ws
 * connection whose client-sent text frames land in `frontmatter.messages`
 * presets. Connection-level headers are dropped: hop-by-hop, plus host and
 * content-length, which the engine recomputes on every send.
 */
import type { GraphqlBody, Header, RecordedExchange, RequestFile } from '@shared/model'
import { suggestName } from '../importers/command'
import { HOP_BY_HOP_HEADERS } from './classify'

/** Headers dropped from a saved request on top of the hop-by-hop set. */
const STRIP_ON_SAVE = new Set([...HOP_BY_HOP_HEADERS, 'host', 'content-length'])

/**
 * gRPC transport headers that don't belong in saved metadata: the channel
 * (or grpcurl itself) regenerates all of these on every call.
 */
const STRIP_ON_GRPC_SAVE = new Set([
  ...STRIP_ON_SAVE,
  'content-type',
  'user-agent',
  'accept-encoding',
  'grpc-timeout',
  'grpc-encoding',
  'grpc-accept-encoding'
])

function savedHeaders(headers: Header[]): Header[] {
  return headers.filter((h) => !STRIP_ON_SAVE.has(h.name.toLowerCase()))
}

/** gRPC exchange -> .grpc skeleton. Data stays empty: tier-1 never decodes. */
function grpcRequestFile(entry: RecordedExchange): RequestFile {
  const g = entry.grpc
  let host = entry.url
  let plaintext = true
  let pathMethod = ''
  try {
    const u = new URL(entry.url)
    host = u.host
    plaintext = u.protocol !== 'https:'
    pathMethod = u.pathname.slice(1)
  } catch {
    /* keep the raw url as the target */
  }
  return {
    kind: 'grpc',
    frontmatter: {},
    variables: [],
    grpc: {
      target: host,
      fullMethod: g !== undefined ? `${g.service}/${g.method}` : pathMethod,
      ...(plaintext ? { plaintext: true } : {}),
      metadata: entry.requestHeaders.filter((h) => !STRIP_ON_GRPC_SAVE.has(h.name.toLowerCase())),
      protoFiles: [],
      importPaths: []
    },
    comments: []
  }
}

/**
 * WebSocket session -> .ws connection. Client-sent text frames are saved as
 * `frontmatter.messages` presets (the format's message store — faithful
 * session replay is deliberately not promised); truncated previews and binary
 * frames are dropped rather than saved corrupted.
 */
function wsRequestFile(entry: RecordedExchange): RequestFile {
  const negotiated = entry.responseHeaders?.find(
    (h) => h.name.toLowerCase() === 'sec-websocket-protocol'
  )?.value
  const messages: Record<string, string> = {}
  let n = 0
  for (const f of entry.ws?.frames ?? []) {
    if (f.dir !== 'out' || !f.text || f.truncated) continue
    messages[`message-${++n}`] = f.preview
  }
  return {
    kind: 'websocat',
    frontmatter: n > 0 ? { messages } : {},
    variables: [],
    ws: {
      url: entry.url,
      headers: savedHeaders(entry.requestHeaders).filter(
        (h) => !h.name.toLowerCase().startsWith('sec-websocket-')
      ),
      ...(negotiated !== undefined && negotiated !== '' ? { protocol: negotiated } : {})
    },
    comments: []
  }
}

/** The GraphQL payload of a recorded request, or null if it doesn't parse. */
function parseGraphqlPayload(entry: RecordedExchange): GraphqlBody | null {
  const text = entry.requestBody?.text
  if (text === undefined || entry.requestBody?.truncated === true) return null
  try {
    const obj: unknown = JSON.parse(text)
    if (obj === null || typeof obj !== 'object') return null
    const query = (obj as { query?: unknown }).query
    if (typeof query !== 'string') return null
    const variables = (obj as { variables?: unknown }).variables
    return {
      query,
      ...(variables !== null && typeof variables === 'object'
        ? { variables: variables as Record<string, unknown> }
        : {})
    }
  } catch {
    return null
  }
}

/** Convert a recorded exchange into a request file model (kind per protocol). */
export function recordedToRequestFile(entry: RecordedExchange): RequestFile {
  if (entry.protocol === 'grpc') return grpcRequestFile(entry)
  if (entry.protocol === 'ws') return wsRequestFile(entry)
  const headers = savedHeaders(entry.requestHeaders)
  const gql = entry.protocol === 'graphql' ? parseGraphqlPayload(entry) : null

  // Body: GraphQL is carried in frontmatter (the writer generates --data from
  // it); binary and truncated bodies can't be saved faithfully, so they are
  // omitted with a body comment instead of writing a silently-corrupt body.
  const bodyText = entry.requestBody?.text
  const truncated = entry.requestBody?.truncated === true
  const binary = entry.requestBody?.base64 !== undefined
  const body =
    gql === null && bodyText !== undefined && bodyText !== '' && !binary && !truncated
      ? ({ kind: 'raw', value: bodyText } as const)
      : undefined
  const omitted = gql === null && body === undefined && (truncated || binary)
  const omitReason = truncated
    ? `body omitted: capture truncated at 64 KiB (${entry.requestBody?.bytes ?? 0} bytes on the wire)`
    : 'body omitted: binary capture'

  return {
    kind: 'curl',
    frontmatter: gql !== null ? { graphql: gql } : {},
    variables: [],
    http: {
      method: entry.method,
      url: entry.url,
      headers,
      ...(body !== undefined ? { body } : {}),
      options: {}
    },
    comments: omitted ? [{ beforeStatement: 0, text: omitReason }] : []
  }
}

/** Why recordedToRequestFile omitted the body, or null if it didn't. */
export function omittedBodyNote(file: RequestFile): string | null {
  const note = file.comments.find((c) => c.text.startsWith('body omitted:'))
  return note !== undefined ? note.text : null
}

/**
 * Filename suggestion: the GraphQL operation name or gRPC method beats the
 * URL's last segment (which suggestName only knows for http/ws models).
 */
export function recordedName(entry: RecordedExchange, file: RequestFile): string {
  const opName = entry.graphql?.operationName?.trim()
  if (opName !== undefined && opName !== '') return opName
  const grpcMethod = (entry.grpc?.method ?? file.grpc?.fullMethod.split('/').pop())?.trim()
  if (grpcMethod !== undefined && grpcMethod !== '') return grpcMethod
  return suggestName(file)
}
