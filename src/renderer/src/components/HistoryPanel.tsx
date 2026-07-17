import type { JSX } from 'react'
import { useEffect, useMemo, useState } from 'react'
import type {
  GrpcDecodedMessage,
  Header,
  HistoryEntry,
  RecordedBody,
  RecordedExchange,
  RecordedGrpcMessage,
  RecordedMqttPacket
} from '../../../shared/model'
import { decodeProtobufBase64, formatProtobuf } from '../../../core/record/protobuf'
import { accumulateDeltas, parseSse } from '../../../core/record/sse'
import { decodeSocketIoPacket, isSocketIoHeartbeat, isSocketIoUrl } from '../../../core/record/socketio'
import { errMsg, fp } from '../api'
import { fmtMs } from '../util'

/** Pretty-print JSON text, or hand back the text when it isn't JSON. */
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2) as string
  } catch {
    return text
  }
}

interface Props {
  root: string
  /** Opens a request tab for a history entry's path (if it still exists). */
  onOpen: (path: string) => void
  onCancel: () => void
}

type HistoryTab = 'requests' | 'recorded'

function HeaderTable(props: { headers: Header[] }): JSX.Element {
  return (
    <table className="kv-table">
      <tbody>
        {props.headers.map((h, i) => (
          <tr key={i}>
            <td className="mono">{h.name}</td>
            <td className="mono">{h.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function BodyPreview(props: { body: RecordedBody }): JSX.Element {
  const { body } = props
  return (
    <>
      <pre className="mono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 200, overflowY: 'auto' }}>
        {body.base64 !== undefined ? `(binary, ${body.bytes} bytes)` : body.text}
      </pre>
      {body.truncated && (
        <div className="dim-note">Preview truncated — {body.bytes} bytes on the wire.</div>
      )}
    </>
  )
}

/** The .proto files attached to one recorded gRPC exchange, and their decode. */
interface GrpcDecodeState {
  protoFiles: string[]
  /** Tier-2 results, aligned by index with `entry.grpc.messages`. */
  messages: GrpcDecodedMessage[]
}

/**
 * What to show for one captured message: the tier-2 JSON when protos are
 * attached and that message decoded, else the schemaless tier-3 field-number
 * tree. A tier-2 failure is shown above the tree rather than replacing it — the
 * wire bytes are still the truth about what was sent.
 */
function grpcMessageText(m: RecordedGrpcMessage, decoded: GrpcDecodedMessage | undefined): string {
  if (decoded?.json !== undefined) return decoded.json
  if (m.compressed === true) return '(compressed message — not decoded)'
  if (m.base64 === undefined) {
    // Recordings made before base64 was always set left it off for an empty
    // message; `bytes` is the wire truth either way.
    if (m.bytes === 0 && !m.truncated) return '(empty message)'
    return `(payload not captured — ${m.bytes} bytes on the wire)`
  }
  const tree = formatProtobuf(decodeProtobufBase64(m.base64))
  return (
    (decoded?.error !== undefined ? `(.proto decode failed: ${decoded.error})\n` : '') +
    (tree === '' ? '(empty message)' : tree) +
    (m.truncated ? '\n(capture truncated — the tail is missing)' : '')
  )
}

/** Captured gRPC messages, rendered at whichever decode tier is available. */
function GrpcMessages(props: {
  entry: RecordedExchange
  decode: GrpcDecodeState | undefined
  onAttachProto: () => void
}): JSX.Element | null {
  const g = props.entry.grpc
  // Absent on exchanges recorded before message capture existed.
  if (g?.messages === undefined) return null
  const total = g.requestMessages + g.responseMessages
  return (
    <>
      <div className="dim-note">
        Messages ({g.messages.length === total ? total : `${g.messages.length} of ${total} captured`})
        {' — '}
        {props.decode === undefined
          ? 'field numbers only; attach the .proto to see names'
          : `decoded with ${props.decode.protoFiles.map((p) => p.split(/[\\/]/).pop()).join(', ')}`}{' '}
        <button className="btn btn-small" onClick={props.onAttachProto}>
          Attach .proto file…
        </button>
      </div>
      <table className="kv-table">
        <tbody>
          {g.messages.map((m, i) => (
            <tr key={i}>
              <td className="mono">{m.dir === 'send' ? '→' : '←'}</td>
              <td className="mono">{m.bytes} B</td>
              <td>
                <pre
                  className="mono"
                  style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 200, overflowY: 'auto', margin: 0 }}
                >
                  {grpcMessageText(m, props.decode?.messages[i])}
                </pre>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

const PRE_STYLE = {
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  maxHeight: 200,
  overflowY: 'auto',
  margin: 0
} as const

/**
 * Rows rendered for one captured SSE body. Matches the engine's WS_FRAME_CAP /
 * MQTT_PACKET_CAP, which those views print as '(capped)'. The SSE capture caps
 * bytes, not events, so 64 KiB of minimal events parses to thousands of rows —
 * and the count is the proxied server's to choose, not ours.
 */
const SSE_EVENT_CAP = 200

/**
 * Event-level view of a captured SSE body. The body is the only record of the
 * stream — the proxy tees it while it streams and caps it at 64 KiB — so a
 * partial capture is normal and is called out rather than hidden.
 */
function SseEvents(props: { entry: RecordedExchange }): JSX.Element | null {
  const [raw, setRaw] = useState(false)
  const [joined, setJoined] = useState(false)
  const body = props.entry.responseBody
  // A binary body can't be an event stream; parse only real text.
  const text = body !== undefined && body.base64 === undefined ? body.text : ''
  const stream = useMemo(() => parseSse(text), [text])
  // Gates the toggle: null means this isn't a token stream.
  const accumulated = useMemo(() => accumulateDeltas(stream.events), [stream])
  if (body === undefined || body.base64 !== undefined) return null

  const partial = props.entry.stream === true || body.truncated
  const shown = stream.events.slice(0, SSE_EVENT_CAP)
  return (
    <>
      <div className="dim-note">
        Events ({stream.events.length}
        {shown.length < stream.events.length ? `, showing first ${SSE_EVENT_CAP}` : ''})
        {partial ? ' — capture is partial' : ''}{' '}
        <button className="btn btn-small" onClick={() => setRaw(!raw)}>
          {raw ? 'Show events' : 'Show raw body'}
        </button>{' '}
        {accumulated !== null && (
          <button className="btn btn-small" onClick={() => setJoined(!joined)}>
            {joined ? 'Show events' : 'Concatenate deltas'}
          </button>
        )}
      </div>
      {partial && (
        <div className="dim-note">
          The response was still streaming when it was captured
          {body.truncated ? ` and the body hit the ${body.bytes}-byte preview cap` : ''} — later
          events are missing.
        </div>
      )}
      {joined && accumulated !== null ? (
        <pre className="mono" style={PRE_STYLE}>
          {accumulated === '' ? '(deltas carried no text)' : accumulated}
        </pre>
      ) : raw ? (
        <BodyPreview body={body} />
      ) : (
        <table className="kv-table">
          <tbody>
            {shown.map((ev, i) => (
              <tr key={i}>
                <td className="mono">{i + 1}</td>
                <td className="mono">
                  {/* Absent `event:` means the default type per the spec. */}
                  {ev.event ?? 'message'}
                  {ev.id !== undefined ? ` · id ${ev.id}` : ''}
                  {ev.retry !== undefined ? ` · retry ${ev.retry}ms` : ''}
                </td>
                <td>
                  <pre className="mono" style={PRE_STYLE}>
                    {prettyJson(ev.data)}
                  </pre>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!raw && !joined && stream.events.length === 0 && (
        <div className="dim-note">No complete events in the capture.</div>
      )}
      {!raw && !joined && stream.trailing !== undefined && (
        <>
          <div className="dim-note">
            Trailing partial event — sent but never terminated in the capture.
          </div>
          <pre className="mono" style={PRE_STYLE}>
            {stream.trailing}
          </pre>
        </>
      )}
    </>
  )
}

/** What one captured frame shows in the payload column. */
function socketIoPayloadText(
  frame: { truncated: boolean },
  packet: ReturnType<typeof decodeSocketIoPacket>
): string {
  if (packet === null) return ''
  if (packet.payload !== undefined) return prettyJson(JSON.stringify(packet.payload))
  if (packet.payloadText === undefined) return ''
  // Frame previews are capped at 2 KiB, so unparseable JSON is usually a cut,
  // not a malformed packet. Say which rather than render half a value.
  return frame.truncated
    ? `(payload cut off by the frame preview cap)\n${packet.payloadText}`
    : packet.payloadText
}

/**
 * socket.io frame list: the event name is the primary column, the way
 * operationName is for GraphQL — it's what identifies the message, and the
 * engine.io framing around it is noise. Heartbeats are hidden by default for
 * the same reason: a real session is mostly ping/pong.
 */
function SocketIoFrames(props: { ws: NonNullable<RecordedExchange['ws']> }): JSX.Element {
  const [showNoise, setShowNoise] = useState(false)
  const rows = useMemo(
    () =>
      props.ws.frames.map((f) => ({
        frame: f,
        // Binary frames are socket.io attachments, not text packets.
        packet: f.text ? decodeSocketIoPacket(f.preview) : null
      })),
    [props.ws.frames]
  )
  const noise = rows.filter((r) => r.packet !== null && isSocketIoHeartbeat(r.packet)).length
  const shown = showNoise ? rows : rows.filter((r) => r.packet === null || !isSocketIoHeartbeat(r.packet))

  return (
    <>
      <div className="dim-note">
        socket.io · {props.ws.frames.length} frame{props.ws.frames.length === 1 ? '' : 's'}
        {props.ws.frames.length >= 200 ? ' (capped)' : ''}
        {props.ws.closeCode !== undefined ? ` — closed with code ${props.ws.closeCode}` : ''}
        {noise > 0 && (
          <>
            {' '}
            <button className="btn btn-small" onClick={() => setShowNoise(!showNoise)}>
              {showNoise ? `Hide ${noise} heartbeat frames` : `Show ${noise} heartbeat frames`}
            </button>
          </>
        )}
      </div>
      <table className="kv-table">
        <tbody>
          {shown.map(({ frame, packet }, i) => {
            const dim = packet !== null && isSocketIoHeartbeat(packet)
            return (
              <tr key={i} className={dim ? 'dim-note' : undefined}>
                <td className="mono">{frame.dir === 'out' ? '→' : '←'}</td>
                <td className="mono">
                  {/* Event name first; anything without one shows its type. */}
                  {packet === null
                    ? frame.text
                      ? '(not socket.io)'
                      : '(binary attachment)'
                    : (packet.eventName ?? packet.socketTypeName ?? packet.engineTypeName)}
                  {packet?.namespace !== undefined ? ` · ${packet.namespace}` : ''}
                  {packet?.ackId !== undefined ? ` · ack ${packet.ackId}` : ''}
                  {packet?.attachments !== undefined ? ` · +${packet.attachments} binary` : ''}
                </td>
                <td>
                  <pre className="mono" style={PRE_STYLE}>
                    {packet === null
                      ? `${frame.text ? '' : '(base64) '}${frame.preview}${frame.truncated ? ' …' : ''}`
                      : socketIoPayloadText(frame, packet)}
                  </pre>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </>
  )
}

/** The MQTT packet types that have a runnable .mqtt form (MqttMode's two). */
function isSaveableMqttPacket(p: RecordedMqttPacket): boolean {
  return p.type === 'publish' || p.type === 'subscribe'
}

/** True for the keep-alive/transport packets that are noise in the list. */
function isMqttNoise(p: RecordedMqttPacket): boolean {
  return p.type === 'pingreq' || p.type === 'pingresp'
}

/** How a direction reads in the note, spelled out rather than as the list's arrow. */
function mqttDirLabel(dir: 'send' | 'recv'): string {
  return dir === 'send' ? 'client→broker' : 'broker→client'
}

/**
 * Captured MQTT packets. The topic is the primary column, the way the event
 * name is for socket.io and operationName is for GraphQL — it identifies the
 * packet, the broker URL on the row above does not.
 *
 * Save is PER PACKET, not per exchange: an MQTT exchange is a whole connection
 * carrying many publishes and subscribes, so there is no single request to
 * infer from it — the user picks one. Only the two types .mqtt can express get
 * a button; the rest are session mechanics with nothing to run.
 */
function MqttPackets(props: {
  entry: RecordedExchange
  onSave: (index: number) => void
}): JSX.Element | null {
  const [showNoise, setShowNoise] = useState(false)
  const m = props.entry.mqtt
  if (m === undefined) return null
  // Indices are into the recorded list, so they survive the noise filter — the
  // index is what identifies the packet to save.
  const rows = m.packets.map((packet, index) => ({ packet, index }))
  const noise = rows.filter((r) => isMqttNoise(r.packet)).length
  const shown = showNoise ? rows : rows.filter((r) => !isMqttNoise(r.packet))

  return (
    <>
      <div className="dim-note">
        MQTT{m.clientId !== undefined ? ` · ${m.clientId}` : ''}
        {m.protocolVersion !== undefined ? ` · v${m.protocolVersion === 5 ? '5' : '3.1.1'}` : ''} ·{' '}
        {m.packets.length} packet{m.packets.length === 1 ? '' : 's'}
        {m.packets.length >= 200 ? ' (capped)' : ''}
        {noise > 0 && (
          <>
            {' '}
            <button className="btn btn-small" onClick={() => setShowNoise(!showNoise)}>
              {showNoise ? `Hide ${noise} keep-alive packets` : `Show ${noise} keep-alive packets`}
            </button>
          </>
        )}
      </div>
      {/*
        The packet list just stops when a decoder dies, which reads as a session
        that went quiet. Say which it was — the bytes kept flowing regardless.
      */}
      {m.decodeStopped !== undefined && m.decodeStopped.length > 0 && (
        <div className="dim-note">
          Decoding stopped for {m.decodeStopped.map(mqttDirLabel).join(' and ')} after a packet it
          couldn&apos;t parse — traffic continued to relay, but later packets are not shown.
        </div>
      )}
      <table className="kv-table">
        <tbody>
          {shown.map(({ packet, index }) => (
            <tr key={index} className={isMqttNoise(packet) ? 'dim-note' : undefined}>
              <td className="mono">{packet.dir === 'send' ? '→' : '←'}</td>
              <td className="mono">
                {/* Topic first; a packet without one shows its type alone. */}
                {packet.topic ?? packet.type}
                {packet.topic !== undefined ? ` · ${packet.type}` : ''}
                {packet.qos !== undefined ? ` · qos ${packet.qos}` : ''}
                {packet.retain === true ? ' · retained' : ''}
                {packet.dup === true ? ' · dup' : ''}
              </td>
              <td>
                <pre className="mono" style={PRE_STYLE}>
                  {packet.preview === undefined
                    ? ''
                    : `${packet.base64 === true ? '(base64) ' : ''}${packet.preview}${packet.truncated === true ? ' …' : ''}`}
                </pre>
              </td>
              <td>
                {isSaveableMqttPacket(packet) && (
                  <button
                    className="btn btn-small"
                    title={`Save this ${packet.type} as a .mqtt request`}
                    onClick={() => props.onSave(index)}
                  >
                    Save
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

/** Captured WebSocket frames: decoded for socket.io, raw for plain WS. */
function WsFrames(props: { entry: RecordedExchange }): JSX.Element | null {
  const ws = props.entry.ws
  if (ws === undefined) return null
  // Detected from the recorded URL — socket.io's default path and the
  // engine.io handshake param are both the client's own signals, so no model
  // or engine change is needed to know how to read the frames.
  if (isSocketIoUrl(props.entry.url)) return <SocketIoFrames ws={ws} />
  return (
    <>
      <div className="dim-note">
        Frames ({ws.frames.length}
        {ws.frames.length >= 200 ? ', capped' : ''})
        {ws.closeCode !== undefined ? ` — closed with code ${ws.closeCode}` : ''}
      </div>
      <table className="kv-table">
        <tbody>
          {ws.frames.map((f, i) => (
            <tr key={i}>
              <td className="mono">{f.dir === 'out' ? '→' : '←'}</td>
              <td className="mono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {f.text ? f.preview : `(binary, base64) ${f.preview}`}
                {f.truncated ? ' …' : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

/** Expandable request/response detail for one recorded exchange. */
function RecordedDetail(props: {
  entry: RecordedExchange
  decode: GrpcDecodeState | undefined
  onAttachProto: () => void
  onSaveMqttPacket: (index: number) => void
}): JSX.Element {
  const e = props.entry
  // An MQTT session has no request/response halves to show — it is a stream of
  // packets, and the packet list IS the detail view.
  if (e.mqtt !== undefined) {
    return (
      <div style={{ padding: '4px 8px 8px 24px' }}>
        {e.error !== undefined && <div className="banner banner-danger">{e.error}</div>}
        <MqttPackets entry={e} onSave={props.onSaveMqttPacket} />
      </div>
    )
  }
  return (
    <div style={{ padding: '4px 8px 8px 24px' }}>
      {e.error !== undefined && <div className="banner banner-danger">{e.error}</div>}
      {e.grpc !== undefined && (
        <>
          <div className="dim-note mono">
            gRPC {e.grpc.service}/{e.grpc.method} · {e.grpc.requestMessages} message
            {e.grpc.requestMessages === 1 ? '' : 's'} sent / {e.grpc.responseMessages} received
            {e.grpc.grpcStatus !== undefined ? ` · grpc-status ${e.grpc.grpcStatus}` : ''}
          </div>
          <GrpcMessages entry={e} decode={props.decode} onAttachProto={props.onAttachProto} />
        </>
      )}
      <div className="dim-note">Request</div>
      <HeaderTable headers={e.requestHeaders} />
      {e.requestBody !== undefined && <BodyPreview body={e.requestBody} />}
      <div className="dim-note">Response{e.stream === true ? ' (partial — captured mid-stream)' : ''}</div>
      {e.responseHeaders !== undefined && <HeaderTable headers={e.responseHeaders} />}
      {/*
        SSE gets the event view (its raw-body toggle covers the plain preview);
        a body that isn't text can't be an event stream, so it falls back.
      */}
      {e.protocol === 'sse' && e.responseBody?.base64 === undefined ? (
        <SseEvents entry={e} />
      ) : (
        e.responseBody !== undefined && <BodyPreview body={e.responseBody} />
      )}
      <WsFrames entry={e} />
    </div>
  )
}

/** Viewer for run history (Requests) and proxy captures (Recorded). */
export default function HistoryPanel(props: Props): JSX.Element {
  const [tab, setTab] = useState<HistoryTab>('requests')
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  /** null = not fetched yet — recorded loads lazily on the first tab switch. */
  const [recorded, setRecorded] = useState<RecordedExchange[] | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  /** Attached protos + tier-2 decode, keyed by exchange id (gRPC rows only). */
  const [grpcDecode, setGrpcDecode] = useState<Record<string, GrpcDecodeState>>({})
  const [message, setMessage] = useState<{ text: string; kind: 'notice' | 'error' } | null>(null)
  const [loading, setLoading] = useState(true)

  async function load(): Promise<void> {
    setLoading(true)
    try {
      setEntries(await fp().listHistory(props.root))
      setMessage(null)
    } catch (e) {
      setMessage({ text: errMsg(e), kind: 'error' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setRecorded(null)
    setGrpcDecode({})
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.root])

  // Recorded is fetched on the first switch to its tab, not upfront: the
  // Requests tab shouldn't pay for parsing a 500-entry recorded.jsonl.
  useEffect(() => {
    if (tab !== 'recorded' || recorded !== null) return
    fp()
      .listRecorded(props.root)
      .then(setRecorded)
      .catch((e) => setMessage({ text: errMsg(e), kind: 'error' }))
  }, [tab, recorded, props.root])

  // Clear clears the active tab's file only.
  async function clear(): Promise<void> {
    try {
      if (tab === 'requests') {
        await fp().clearHistory(props.root)
        setEntries([])
      } else {
        await fp().clearRecorded(props.root)
        setRecorded([])
        setGrpcDecode({})
      }
    } catch (e) {
      setMessage({ text: errMsg(e), kind: 'error' })
    }
  }

  /**
   * Add one .proto to a gRPC exchange and re-decode every captured message.
   * Nothing is attached unless the decode succeeds — a proto that doesn't
   * describe this method is a mistake, not a new view.
   */
  async function attachProto(entry: RecordedExchange): Promise<void> {
    try {
      const picked = await fp().browseFile({
        title: 'Select a .proto file',
        filters: [
          { name: 'Protocol Buffers', extensions: ['proto'] },
          { name: 'All files', extensions: ['*'] }
        ]
      })
      if (picked === null) return
      const existing = grpcDecode[entry.id]?.protoFiles ?? []
      const protoFiles = existing.includes(picked) ? existing : [...existing, picked]
      const messages = await fp().decodeRecordedGrpc({ root: props.root, entry, protoFiles })
      setGrpcDecode((d) => ({ ...d, [entry.id]: { protoFiles, messages } }))
      setMessage(null)
    } catch (e) {
      setMessage({ text: errMsg(e), kind: 'error' })
    }
  }

  async function saveToCollection(entry: RecordedExchange, mqttPacket?: number): Promise<void> {
    try {
      // With protos attached the saved .grpc file carries them plus the decoded
      // request message; without them it stays the skeleton it always was.
      const decode = grpcDecode[entry.id]
      const sent = entry.grpc?.messages?.findIndex((m) => m.dir === 'send') ?? -1
      const data = sent >= 0 ? decode?.messages[sent]?.json : undefined
      const { written, note } = await fp().saveRecorded({
        root: props.root,
        entry,
        ...(decode !== undefined
          ? { grpc: { protoFiles: decode.protoFiles, ...(data !== undefined ? { data } : {}) } }
          : {}),
        // Which packet of an MQTT session to save; the row-level button sends
        // none, which saves the session's first publish or subscribe.
        ...(mqttPacket !== undefined ? { mqttPacket } : {})
      })
      setMessage({
        text: `Saved ${written.join(', ')}${note !== undefined ? ` — ${note}` : ''}`,
        kind: 'notice'
      })
    } catch (e) {
      setMessage({ text: errMsg(e), kind: 'error' })
    }
  }

  const activeEmpty = tab === 'requests' ? entries.length === 0 : (recorded ?? []).length === 0

  return (
    <div className="modal-overlay" onMouseDown={props.onCancel}>
      <div className="modal modal-wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">
          History
          <div className="topbar-spacer" />
          <button className="btn btn-danger btn-small" onClick={() => void clear()} disabled={activeEmpty}>
            Clear
          </button>
        </div>

        <div className="section-tabs">
          {(['requests', 'recorded'] as HistoryTab[]).map((t) => (
            <button
              key={t}
              className={'section-tab' + (tab === t ? ' section-tab-active' : '')}
              onClick={() => setTab(t)}
            >
              {t === 'requests'
                ? 'Requests'
                : recorded === null
                  ? 'Recorded'
                  : `Recorded (${recorded.length})`}
            </button>
          ))}
        </div>

        {message !== null && (
          <div className={message.kind === 'error' ? 'banner banner-danger' : 'banner banner-warn'}>
            {message.text}
          </div>
        )}

        {tab === 'requests' && (
          <div className="history-list">
            {loading && <div className="dim-note">Loading…</div>}
            {!loading && entries.length === 0 && (
              <div className="dim-note">No requests have been run yet.</div>
            )}
            {entries.map((e, i) => {
              const statusCls =
                e.status === undefined || e.errored
                  ? 'status-err'
                  : e.status >= 200 && e.status < 300
                    ? 'status-ok'
                    : 'status-other'
              return (
                <div
                  key={i}
                  className="history-row"
                  title={`Open ${e.path}`}
                  onClick={() => props.onOpen(e.path)}
                >
                  <span className={'badge badge-' + e.method.toLowerCase()}>{e.method}</span>
                  <span className={'status-pill ' + statusCls}>
                    {e.status !== undefined ? e.status : 'ERR'}
                  </span>
                  <span className="history-url mono">{e.url}</span>
                  {e.timeMs !== undefined && (
                    <span className="resp-meta">{fmtMs(e.timeMs)}</span>
                  )}
                  <span className="history-at">{new Date(e.at).toLocaleString()}</span>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'recorded' && (
          <div className="history-list">
            {recorded === null && <div className="dim-note">Loading…</div>}
            {recorded !== null && recorded.length === 0 && (
              <div className="dim-note">
                Nothing recorded yet — start the proxy from Tools ▸ Proxy Server (Record).
              </div>
            )}
            {(recorded ?? []).map((e) => {
              // MQTT has no HTTP status, so a missing one is only an error when
              // the exchange says so — otherwise the row reads as a failure.
              const statusCls = e.errored
                ? 'status-err'
                : e.status === undefined
                  ? 'status-other'
                  : e.status >= 200 && e.status < 300
                    ? 'status-ok'
                    : 'status-other'
              return (
                <div key={e.id}>
                  <div
                    className="history-row"
                    title="Show request/response detail"
                    onClick={() => setExpanded(expanded === e.id ? null : e.id)}
                  >
                    <span className="badge badge-other">
                      {e.protocol === 'graphql' ? 'GQL' : e.protocol.toUpperCase()}
                    </span>
                    <span className={'badge badge-' + e.method.toLowerCase()}>{e.method}</span>
                    <span className={'status-pill ' + statusCls}>
                      {e.status !== undefined ? e.status : e.errored ? 'ERR' : '—'}
                    </span>
                    <span className="history-url mono">
                      {e.graphql?.operationName !== undefined ? `${e.graphql.operationName} · ` : ''}
                      {e.url}
                      {e.ws !== undefined ? ` · ${e.ws.frames.length} frame${e.ws.frames.length === 1 ? '' : 's'}` : ''}
                      {e.mqtt !== undefined
                        ? ` · ${e.mqtt.packets.length} packet${e.mqtt.packets.length === 1 ? '' : 's'}`
                        : ''}
                    </span>
                    {e.timeMs !== undefined && <span className="resp-meta">{fmtMs(e.timeMs)}</span>}
                    <span className="history-at">{new Date(e.at).toLocaleString()}</span>
                    <button
                      className="btn btn-small"
                      title="Save this exchange as a request file"
                      onClick={(ev) => {
                        ev.stopPropagation()
                        void saveToCollection(e)
                      }}
                    >
                      Save
                    </button>
                  </div>
                  {expanded === e.id && (
                    <RecordedDetail
                      entry={e}
                      decode={grpcDecode[e.id]}
                      onAttachProto={() => void attachProto(e)}
                      onSaveMqttPacket={(index) => void saveToCollection(e, index)}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={props.onCancel}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
