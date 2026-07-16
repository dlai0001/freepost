import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import type { Header, HistoryEntry, RecordedBody, RecordedExchange } from '../../../shared/model'
import { errMsg, fp } from '../api'
import { fmtMs } from '../util'

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

/** Expandable request/response detail for one recorded exchange. */
function RecordedDetail(props: { entry: RecordedExchange }): JSX.Element {
  const e = props.entry
  return (
    <div style={{ padding: '4px 8px 8px 24px' }}>
      {e.error !== undefined && <div className="banner banner-danger">{e.error}</div>}
      {e.grpc !== undefined && (
        <div className="dim-note mono">
          gRPC {e.grpc.service}/{e.grpc.method} · {e.grpc.requestMessages} message
          {e.grpc.requestMessages === 1 ? '' : 's'} sent / {e.grpc.responseMessages} received
          {e.grpc.grpcStatus !== undefined ? ` · grpc-status ${e.grpc.grpcStatus}` : ''}
        </div>
      )}
      <div className="dim-note">Request</div>
      <HeaderTable headers={e.requestHeaders} />
      {e.requestBody !== undefined && <BodyPreview body={e.requestBody} />}
      <div className="dim-note">Response{e.stream === true ? ' (partial — captured mid-stream)' : ''}</div>
      {e.responseHeaders !== undefined && <HeaderTable headers={e.responseHeaders} />}
      {e.responseBody !== undefined && <BodyPreview body={e.responseBody} />}
      {e.ws !== undefined && (
        <>
          <div className="dim-note">
            Frames ({e.ws.frames.length}
            {e.ws.frames.length >= 200 ? ', capped' : ''})
            {e.ws.closeCode !== undefined ? ` — closed with code ${e.ws.closeCode}` : ''}
          </div>
          <table className="kv-table">
            <tbody>
              {e.ws.frames.map((f, i) => (
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
      )}
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
      }
    } catch (e) {
      setMessage({ text: errMsg(e), kind: 'error' })
    }
  }

  async function saveToCollection(entry: RecordedExchange): Promise<void> {
    try {
      const { written, note } = await fp().saveRecorded({ root: props.root, entry })
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
              const statusCls =
                e.errored || e.status === undefined
                  ? 'status-err'
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
                      {e.status !== undefined ? e.status : 'ERR'}
                    </span>
                    <span className="history-url mono">
                      {e.graphql?.operationName !== undefined ? `${e.graphql.operationName} · ` : ''}
                      {e.url}
                      {e.ws !== undefined ? ` · ${e.ws.frames.length} frame${e.ws.frames.length === 1 ? '' : 's'}` : ''}
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
                  {expanded === e.id && <RecordedDetail entry={e} />}
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
