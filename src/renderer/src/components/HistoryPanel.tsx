import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import type { HistoryEntry } from '../../../shared/model'
import { errMsg, fp } from '../api'
import { fmtMs } from '../util'

interface Props {
  root: string
  /** Opens a request tab for a history entry's path (if it still exists). */
  onOpen: (path: string) => void
  onCancel: () => void
}

/** Read-only viewer for the request execution history log. */
export default function HistoryPanel(props: Props): JSX.Element {
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  async function load(): Promise<void> {
    setLoading(true)
    try {
      const list = await fp().listHistory(props.root)
      setEntries(list)
      setMessage(null)
    } catch (e) {
      setMessage(errMsg(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.root])

  async function clear(): Promise<void> {
    try {
      await fp().clearHistory(props.root)
      setEntries([])
    } catch (e) {
      setMessage(errMsg(e))
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={props.onCancel}>
      <div className="modal modal-wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">
          History
          <div className="topbar-spacer" />
          <button
            className="btn btn-danger btn-small"
            onClick={() => void clear()}
            disabled={entries.length === 0}
          >
            Clear history
          </button>
        </div>

        {message !== null && <div className="banner banner-danger">{message}</div>}

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

        <div className="modal-actions">
          <button className="btn" onClick={props.onCancel}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
