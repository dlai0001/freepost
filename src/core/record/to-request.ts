/**
 * Recorded exchange -> saveable request file ("Save to collection"). Pure.
 * REST/SSE become a plain .curl model; GraphQL becomes a .curl with
 * `frontmatter.graphql` as the source of truth (the writer regenerates --data
 * from it, and the editor opens it in the GraphQL body mode). gRPC becomes a
 * .grpc skeleton (target + method + metadata), carrying `data` only when the
 * caller passes a tier-2 decode: the schemaless tier-3 view is field NUMBERS,
 * which is not valid request JSON, so without protos `data` stays empty rather
 * than plausibly wrong. WebSocket sessions become a .ws
 * connection whose client-sent text frames land in `frontmatter.messages`
 * presets. Connection-level headers are dropped: hop-by-hop, plus host and
 * content-length, which the engine recomputes on every send.
 *
 * Whatever a request file cannot carry (a truncated or binary body, the other
 * topics of a batch SUBSCRIBE) is named in a comment in the saved file and
 * reported by omittedNote — a save never loses data quietly.
 */
import type { GraphqlBody, Header, RecordedExchange, RecordedMqttPacket, RequestFile } from '@shared/model'
import { suggestName } from '../importers/command'
import { HOP_BY_HOP_HEADERS } from './classify'

/**
 * Comment prefixes marking what a save could not carry. Nothing is ever
 * dropped silently, so these are also what omittedNote reports to the UI.
 */
const BODY_OMITTED = 'body omitted'
const TOPICS_OMITTED = 'topics omitted'
const OMISSION_PREFIXES = [`${BODY_OMITTED}:`, `${TOPICS_OMITTED}:`]

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

/**
 * A proto path as a .grpc file should carry it: collection-relative when the
 * proto lives under the collection root (the convention every other .grpc
 * carries, and what the engine resolves against the request's own directory),
 * else the absolute path it came from — a proto outside the collection has no
 * portable form, and an honest absolute path beats a broken relative one.
 *
 * Pure string work on purpose: this module is importable from the renderer, so
 * node:path is not available. Separators are normalised to '/', which is what
 * the format uses; the comparison is case-sensitive, so a Windows path whose
 * case differs from the root's stays absolute rather than being mangled.
 */
function collectionRelative(root: string | undefined, path: string): string {
  if (root === undefined || root === '') return path
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const file = path.replace(/\\/g, '/')
  return file.startsWith(`${base}/`) ? file.slice(base.length + 1) : path
}

/**
 * gRPC exchange -> .grpc file. `decoded` is the viewer's tier-2 result for the
 * request message plus the protos that produced it — saving those alongside
 * makes the file runnable, not just a skeleton.
 */
function grpcRequestFile(entry: RecordedExchange, decoded?: RecordedGrpcSave): RequestFile {
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
  const data = decoded?.data?.trim()
  return {
    kind: 'grpc',
    frontmatter: {},
    variables: [],
    grpc: {
      target: host,
      fullMethod: g !== undefined ? `${g.service}/${g.method}` : pathMethod,
      ...(plaintext ? { plaintext: true } : {}),
      metadata: entry.requestHeaders.filter((h) => !STRIP_ON_GRPC_SAVE.has(h.name.toLowerCase())),
      ...(data !== undefined && data !== '' ? { data } : {}),
      protoFiles: (decoded?.protoFiles ?? []).map((p) => collectionRelative(decoded?.root, p)),
      importPaths: (decoded?.importPaths ?? []).map((p) => collectionRelative(decoded?.root, p))
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

/** The packet types an MQTT session can be saved from (MqttMode's two). */
function isSaveableMqttPacket(p: RecordedMqttPacket): boolean {
  return p.type === 'publish' || p.type === 'subscribe'
}

/**
 * The topics a batch SUBSCRIBE asked for beyond the one being saved, exactly as
 * the capture rendered them — undefined for a single-topic one.
 *
 * MqttRequestModel.topic is ONE topic (mosquitto_sub takes one -t), so a batch
 * SUBSCRIBE cannot be saved whole; it must not be saved short in silence
 * either. The list is read back off the packet's own preview — the record's
 * only carrier for it — rather than re-split from it: a topic may contain a
 * comma, so only the saved entry's known rendering can be stripped safely.
 */
function droppedMqttTopics(packet: RecordedMqttPacket): string | undefined {
  if (packet.type !== 'subscribe' || packet.preview === undefined) return undefined
  const saved = packet.qos !== undefined ? `${packet.topic} (qos ${packet.qos})` : (packet.topic ?? '')
  return packet.preview.startsWith(`${saved}, `) ? packet.preview.slice(saved.length + 2) : undefined
}

/**
 * One packet of an MQTT session -> .mqtt file. Unlike every other protocol
 * here, the exchange is a whole connection rather than one request: `index`
 * names the packet the user picked. Without one the first saveable packet
 * wins, which is what the log's row-level Save button means.
 *
 * PUBLISH becomes a publish request and SUBSCRIBE a subscribe one — the only
 * two modes .mqtt has, so nothing else is saveable and saying so beats writing
 * a file that can't run.
 */
function mqttRequestFile(entry: RecordedExchange, index?: number): RequestFile {
  const packets = entry.mqtt?.packets ?? []
  const packet = index !== undefined ? packets[index] : packets.find(isSaveableMqttPacket)
  if (packet === undefined || !isSaveableMqttPacket(packet)) {
    throw new Error('Only a publish or subscribe packet can be saved as a request.')
  }

  let host = entry.url
  let port: number | undefined
  try {
    const u = new URL(entry.url)
    host = u.hostname
    if (u.port !== '') port = Number(u.port)
  } catch {
    /* keep the raw url as the host */
  }

  // A payload the capture cut, or one that isn't text, is not the message that
  // was sent — saved as a comment, never as a body (the REST rule above).
  const truncated = packet.truncated === true
  const binary = packet.base64 === true
  const message = packet.type === 'publish' && !truncated && !binary ? packet.preview : undefined
  const omitted = packet.type === 'publish' && packet.preview !== undefined && message === undefined
  const omitReason = truncated
    ? `${BODY_OMITTED}: capture truncated at the packet preview cap`
    : `${BODY_OMITTED}: binary capture`
  // A SUBSCRIBE is legally a batch and this file holds one topic: the rest are
  // named in a note, never dropped in silence.
  const dropped = droppedMqttTopics(packet)
  const note = omitted
    ? omitReason
    : dropped !== undefined
      ? `${TOPICS_OMITTED}: this SUBSCRIBE also asked for ${dropped} — a request carries one topic`
      : undefined

  return {
    kind: 'mqtt',
    frontmatter: {},
    variables: [],
    mqtt: {
      mode: packet.type === 'publish' ? 'publish' : 'subscribe',
      host,
      ...(port !== undefined ? { port } : {}),
      topic: packet.topic ?? '',
      ...(packet.qos !== undefined ? { qos: packet.qos } : {}),
      ...(packet.retain === true ? { retain: true } : {}),
      // The session's clientId is deliberately NOT carried over: MQTT client
      // ids are exclusive, so reusing the recorded client's would kick it off
      // the broker the moment this request runs.
      ...(message !== undefined ? { message } : {})
    },
    comments: note !== undefined ? [{ beforeStatement: 0, text: note }] : []
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

/**
 * The gRPC decode to bake into a saved .grpc file: `data` is the request
 * message as tier-2 JSON, and the protos are the ones it was decoded with.
 * Omit it and the file saves as a skeleton (the pre-decode behaviour).
 */
export interface RecordedGrpcSave {
  data?: string
  /** Absolute, as the file picker returns them. */
  protoFiles?: string[]
  importPaths?: string[]
  /**
   * The collection root the file is being saved into. Given, protos under it
   * are written collection-relative — the paths a .grpc is meant to hold,
   * since collections are committed to git and a machine-absolute path is one
   * checkout away from being wrong.
   */
  root?: string
}

/**
 * Convert a recorded exchange into a request file model (kind per protocol).
 * `mqttPacket` indexes into an MQTT session's packets — the one protocol whose
 * exchange holds many saveable requests rather than being one; it is ignored
 * for every other protocol. Throws only for an MQTT packet that has no
 * runnable form (see mqttRequestFile).
 */
export function recordedToRequestFile(
  entry: RecordedExchange,
  grpc?: RecordedGrpcSave,
  mqttPacket?: number
): RequestFile {
  if (entry.protocol === 'grpc') return grpcRequestFile(entry, grpc)
  if (entry.protocol === 'ws') return wsRequestFile(entry)
  if (entry.protocol === 'mqtt') return mqttRequestFile(entry, mqttPacket)
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
    ? `${BODY_OMITTED}: capture truncated at 64 KiB (${entry.requestBody?.bytes ?? 0} bytes on the wire)`
    : `${BODY_OMITTED}: binary capture`

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

/**
 * What recordedToRequestFile could not carry into the saved file, or null when
 * nothing was left behind. Every omission is written as a comment in the file
 * itself; this is the same text, for the UI to say so at save time.
 */
export function omittedNote(file: RequestFile): string | null {
  const note = file.comments.find((c) => OMISSION_PREFIXES.some((p) => c.text.startsWith(p)))
  return note !== undefined ? note.text : null
}

/**
 * Filename suggestion: the GraphQL operation name, gRPC method or MQTT topic
 * beats the URL's last segment (which suggestName only knows for http/ws
 * models — an .mqtt file has no URL at all).
 */
export function recordedName(entry: RecordedExchange, file: RequestFile): string {
  const opName = entry.graphql?.operationName?.trim()
  if (opName !== undefined && opName !== '') return opName
  const grpcMethod = (entry.grpc?.method ?? file.grpc?.fullMethod.split('/').pop())?.trim()
  if (grpcMethod !== undefined && grpcMethod !== '') return grpcMethod
  // The whole topic, not its last segment: MQTT topics are a hierarchy the
  // leaf alone doesn't identify ('freepost/tick' and 'other/tick' collide).
  // Slashes would be stripped by the filename sanitizer, so they become '-'.
  const topic = file.mqtt?.topic.trim().replace(/\/+/g, '-')
  if (topic !== undefined && topic !== '') return topic
  return suggestName(file)
}
