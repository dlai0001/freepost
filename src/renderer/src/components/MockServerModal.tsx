import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { MockRequestLogEntry } from '../../../shared/model'
import { errMsg, fp } from '../api'

interface Props {
  root: string
  onCancel: () => void
}

/** Start/stop the collection's mock server and watch its live request log. */
export default function MockServerModal(props: Props): JSX.Element {
  const [running, setRunning] = useState(false)
  const [port, setPort] = useState<number | null>(null)
  const [routes, setRoutes] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [log, setLog] = useState<MockRequestLogEntry[]>([])
  const rootRef = useRef(props.root)
  rootRef.current = props.root

  useEffect(() => {
    void fp()
      .mockStatus({ root: props.root })
      .then((s) => {
        setRunning(s.running)
        setPort(s.port ?? null)
      })
      .catch(() => undefined)
    const off = fp().onMockLog((e) => {
      if (e.root !== rootRef.current) return
      setLog((l) => [...l.slice(-199), e.entry])
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.root])

  async function start(): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      const { port: p, routes: n } = await fp().startMock({ root: props.root })
      setRunning(true)
      setPort(p)
      setRoutes(n)
    } catch (e) {
      setMessage(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  async function stop(): Promise<void> {
    setBusy(true)
    try {
      await fp().stopMock({ root: props.root })
      setRunning(false)
      setPort(null)
    } catch (e) {
      setMessage(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const baseUrl = port !== null ? `http://127.0.0.1:${port}` : null

  return (
    <div className="modal-overlay" onMouseDown={props.onCancel}>
      <div className="modal modal-wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">
          Mock server
          <div className="topbar-spacer" />
          {running ? (
            <button className="btn btn-danger btn-small" onClick={() => void stop()} disabled={busy}>
              {busy ? 'Stopping…' : 'Stop'}
            </button>
          ) : (
            <button className="btn btn-small" onClick={() => void start()} disabled={busy}>
              {busy ? 'Starting…' : 'Start'}
            </button>
          )}
        </div>

        {message !== null && <div className="banner banner-danger">{message}</div>}

        <div className="dim-note">
          The mock server replays your saved response examples over HTTP. Mark an example{' '}
          <strong>active</strong> from a request&apos;s Examples list to choose which one it serves;
          add <span className="mono">?__example=NAME</span> to a request to force a specific one.
          Unmatched paths return 404 (requests never leave your machine).
        </div>

        {running && baseUrl !== null ? (
          <div className="banner banner-ok">
            Listening at <span className="mono">{baseUrl}</span>
            {routes !== null ? ` · ${routes} route(s)` : ''}{' '}
            <button
              className="btn btn-small"
              onClick={() => void navigator.clipboard?.writeText(baseUrl)}
            >
              Copy
            </button>
          </div>
        ) : (
          <div className="dim-note">Not running.</div>
        )}

        <div className="history-list">
          {log.length === 0 && <div className="dim-note">No requests yet.</div>}
          {log.map((e, i) => {
            const statusCls = !e.matched
              ? 'status-err'
              : e.status >= 200 && e.status < 300
                ? 'status-ok'
                : 'status-other'
            return (
              <div key={i} className="history-row">
                <span className={'badge badge-' + e.method.toLowerCase()}>{e.method}</span>
                <span className={'status-pill ' + statusCls}>{e.status}</span>
                <span className="history-url mono">{e.path}</span>
                {e.exampleName !== undefined && <span className="resp-meta">{e.exampleName}</span>}
                <span className="history-at">{new Date(e.at).toLocaleTimeString()}</span>
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
