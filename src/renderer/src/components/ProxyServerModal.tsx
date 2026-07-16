import type { JSX } from 'react'
import { memo, useCallback, useEffect, useState } from 'react'
import type { RecordedExchange } from '../../../shared/model'
import { errMsg, fp } from '../api'

interface Props {
  root: string
  onCancel: () => void
}

/** Display label for a recorded exchange's protocol badge. */
function protocolLabel(p: RecordedExchange['protocol']): string {
  return p === 'graphql' ? 'GQL' : p.toUpperCase()
}

/**
 * The log column: GraphQL shows the operation name, gRPC the service/method,
 * WebSocket the path plus frame count, everything else the path.
 */
function pathOrOpName(e: RecordedExchange): string {
  if (e.graphql?.operationName !== undefined) return e.graphql.operationName
  if (e.grpc !== undefined) return `${e.grpc.service}/${e.grpc.method}`
  let path: string
  try {
    path = new URL(e.url).pathname
  } catch {
    path = e.url
  }
  if (e.ws !== undefined) {
    const n = e.ws.frames.length
    path += ` · ${n} frame${n === 1 ? '' : 's'}`
  }
  return path
}

/** Per-stack examples for trusting the local CA (shown when HTTPS is on). */
function trustSnippets(caPath: string, httpsUrl: string): { label: string; code: string }[] {
  const port = ((): string => {
    try {
      return new URL(httpsUrl).port
    } catch {
      return '7700'
    }
  })()
  return [
    { label: 'curl', code: `curl --cacert '${caPath}' ${httpsUrl}/path\n# or skip verification: curl -k ${httpsUrl}/path` },
    { label: 'Node.js', code: `NODE_EXTRA_CA_CERTS='${caPath}' node app.js` },
    { label: 'Python (requests)', code: `requests.get('${httpsUrl}/path', verify='${caPath}')` },
    {
      label: 'Go',
      code: `pool := x509.NewCertPool()\npem, _ := os.ReadFile("${caPath}")\npool.AppendCertsFromPEM(pem)\nclient := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool}}}`
    },
    {
      label: 'gRPC (grpc-js)',
      code: `const creds = grpc.credentials.createSsl(fs.readFileSync('${caPath}'))\nnew MyService('localhost:${port}', creds)`
    },
    { label: 'grpcurl', code: `grpcurl -cacert '${caPath}' localhost:${port} pkg.Service/Method` }
  ]
}

/** One capture log row. Memo'd: a new exchange must not re-render 200 rows. */
const ProxyLogRow = memo(function ProxyLogRow(props: {
  entry: RecordedExchange
  onSave: (entry: RecordedExchange) => Promise<void>
}): JSX.Element {
  const e = props.entry
  const statusCls =
    e.errored || e.status === undefined
      ? 'status-err'
      : e.status >= 200 && e.status < 300
        ? 'status-ok'
        : 'status-other'
  return (
    <div className="history-row">
      <span className="badge badge-other">{protocolLabel(e.protocol)}</span>
      <span className={'badge badge-' + e.method.toLowerCase()}>{e.method}</span>
      <span className={'status-pill ' + statusCls}>
        {e.status !== undefined ? e.status : 'ERR'}
      </span>
      <span className="history-url mono">{pathOrOpName(e)}</span>
      {e.timeMs !== undefined && <span className="resp-meta">{e.timeMs} ms</span>}
      <span className="history-at">{new Date(e.at).toLocaleTimeString()}</span>
      <button
        className="btn btn-small"
        title="Save this exchange as a request file"
        onClick={() => void props.onSave(e)}
      >
        Save
      </button>
    </div>
  )
})

/** Start/stop the record proxy and watch its live capture log. */
export default function ProxyServerModal(props: Props): JSX.Element {
  const [running, setRunning] = useState(false)
  const [url, setUrl] = useState<string | null>(null)
  const [target, setTarget] = useState('')
  const [port, setPort] = useState('')
  const [https, setHttps] = useState(false)
  const [httpsPort, setHttpsPort] = useState('')
  const [httpsUrl, setHttpsUrl] = useState<string | null>(null)
  const [caPath, setCaPath] = useState<string | null>(null)
  const [showSnippets, setShowSnippets] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [log, setLog] = useState<RecordedExchange[]>([])

  useEffect(() => {
    void fp()
      .proxyStatus()
      .then(async (s) => {
        setRunning(s.running)
        setUrl(s.url ?? null)
        setTarget(s.target)
        setPort(String(s.port))
        setHttps(s.https)
        setHttpsPort(String(s.httpsPort))
        setHttpsUrl(s.httpsUrl ?? null)
        setCaPath(s.caPath ?? null)
        if (s.running) {
          // The proxy was already running when the modal opened: seed the log
          // with the recent tail of recorded.jsonl (most recent last), keeping
          // any live events that raced the fetch, de-duped by id.
          const recent = await fp().listRecorded(props.root).catch(() => [])
          setLog((l) => {
            const seeded = recent.slice(0, 200).reverse()
            const seen = new Set(seeded.map((x) => x.id))
            return [...seeded, ...l.filter((x) => !seen.has(x.id))].slice(-200)
          })
        }
      })
      .catch(() => undefined)
    return fp().onProxyLog((e) => {
      setLog((l) => (l.some((x) => x.id === e.entry.id) ? l : [...l.slice(-199), e.entry]))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function start(): Promise<void> {
    setBusy(true)
    setMessage(null)
    setNotice(null)
    try {
      const parsedPort = port.trim() === '' ? undefined : Number(port)
      const parsedHttpsPort = httpsPort.trim() === '' ? undefined : Number(httpsPort)
      const res = await fp().startProxy({
        target: target.trim(),
        port: parsedPort,
        https,
        httpsPort: parsedHttpsPort
      })
      setRunning(true)
      setUrl(res.url)
      setPort(String(new URL(res.url).port))
      setHttpsUrl(res.httpsUrl ?? null)
      setCaPath(res.caPath ?? null)
      if (res.httpsUrl !== undefined) setHttpsPort(new URL(res.httpsUrl).port)
    } catch (e) {
      setMessage(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  async function stop(): Promise<void> {
    setBusy(true)
    try {
      await fp().stopProxy()
      setRunning(false)
      setUrl(null)
      setHttpsUrl(null)
    } catch (e) {
      setMessage(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  // Stable so the memo'd log rows don't re-render on every new exchange.
  const saveToCollection = useCallback(async (entry: RecordedExchange): Promise<void> => {
    setSaved(null)
    try {
      const { written, note } = await fp().saveRecorded({ root: props.root, entry })
      setSaved(`Saved ${written.join(', ')}${note !== undefined ? ` — ${note}` : ''}`)
    } catch (e) {
      setMessage(errMsg(e))
    }
  }, [props.root])

  async function exportCa(): Promise<void> {
    setNotice(null)
    try {
      const res = await fp().exportProxyCa()
      if (res.saved) setNotice(`CA certificate exported to ${res.path}`)
    } catch (e) {
      setMessage(errMsg(e))
    }
  }

  async function regenerateCa(): Promise<void> {
    const sure = window.confirm(
      'Regenerate the proxy CA?\n\nThe current CA and its key are destroyed and a new one is created. ' +
        'Anywhere the old CA was trusted (system keychains, --cacert files, CI images) will stop ' +
        'trusting the proxy until the new CA is exported and installed again.'
    )
    if (!sure) return
    setNotice(null)
    try {
      const { caPath: p } = await fp().regenerateProxyCa()
      setCaPath(p)
      setNotice(
        running
          ? 'CA regenerated. Restart the proxy to serve a certificate from the new CA.'
          : 'CA regenerated. Export it again for your clients.'
      )
    } catch (e) {
      setMessage(errMsg(e))
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={props.onCancel}>
      <div className="modal modal-wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">
          Proxy server (record)
          <div className="topbar-spacer" />
          {running ? (
            <button className="btn btn-danger btn-small" onClick={() => void stop()} disabled={busy}>
              {busy ? 'Stopping…' : 'Stop'}
            </button>
          ) : (
            <button
              className="btn btn-small"
              onClick={() => void start()}
              disabled={busy || target.trim() === ''}
            >
              {busy ? 'Starting…' : 'Start'}
            </button>
          )}
        </div>

        {message !== null && <div className="banner banner-danger">{message}</div>}

        <div className="dim-note">
          Point your app at the proxy instead of the real server: every request is forwarded to
          the target and recorded. Recorded traffic lands in History ▸ Recorded, where each
          exchange can be saved into the collection.
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <label className="modal-label">Target (where requests are forwarded)</label>
            <input
              className="modal-input mono"
              style={{ width: '100%', boxSizing: 'border-box' }}
              placeholder="http://localhost:3000"
              value={target}
              disabled={running}
              onChange={(e) => setTarget(e.target.value)}
            />
          </div>
          <div>
            <label className="modal-label">Port</label>
            <input
              className="modal-input mono"
              style={{ width: 80 }}
              value={port}
              disabled={running}
              onChange={(e) => setPort(e.target.value)}
            />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={https}
              disabled={running}
              onChange={(e) => setHttps(e.target.checked)}
            />
            Enable HTTPS (self-signed local CA)
          </label>
          {https && (
            <>
              <label className="modal-label" style={{ margin: 0 }}>
                HTTPS port
              </label>
              <input
                className="modal-input mono"
                style={{ width: 80 }}
                value={httpsPort}
                disabled={running}
                onChange={(e) => setHttpsPort(e.target.value)}
              />
            </>
          )}
        </div>

        {running && url !== null ? (
          <div className="banner banner-ok">
            Recording → <span className="mono">{target}</span> on <span className="mono">{url}</span>{' '}
            <button className="btn btn-small" onClick={() => void navigator.clipboard?.writeText(url)}>
              Copy
            </button>
            {httpsUrl !== null && (
              <>
                {' '}
                and <span className="mono">{httpsUrl}</span>{' '}
                <button
                  className="btn btn-small"
                  onClick={() => void navigator.clipboard?.writeText(httpsUrl)}
                >
                  Copy
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="dim-note">Not running.</div>
        )}

        {https && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-small" onClick={() => void exportCa()}>
              Export CA certificate…
            </button>
            {caPath !== null && (
              <button
                className="btn btn-small"
                title={caPath}
                onClick={() => {
                  void navigator.clipboard?.writeText(caPath)
                  setNotice('CA path copied.')
                }}
              >
                Copy CA path
              </button>
            )}
            {caPath !== null && httpsUrl !== null && (
              <button className="btn btn-small" onClick={() => setShowSnippets((v) => !v)}>
                {showSnippets ? 'Hide trust snippets' : 'Trust snippets…'}
              </button>
            )}
            <button className="btn btn-small" onClick={() => void regenerateCa()}>
              Regenerate CA…
            </button>
            <button
              className="btn btn-small"
              title="Opens the operating system's certificate import UI — nothing is installed without you confirming there."
              onClick={() => void fp().installProxyCa().catch((e) => setMessage(errMsg(e)))}
            >
              Install CA into system trust…
            </button>
          </div>
        )}

        {https && showSnippets && caPath !== null && httpsUrl !== null && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {trustSnippets(caPath, httpsUrl).map((s) => (
              <div key={s.label}>
                <div className="modal-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {s.label}
                  <button
                    className="btn btn-small"
                    onClick={() => void navigator.clipboard?.writeText(s.code)}
                  >
                    Copy
                  </button>
                </div>
                <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap', overflowX: 'auto' }}>
                  {s.code}
                </pre>
              </div>
            ))}
          </div>
        )}

        {notice !== null && <div className="dim-note">{notice}</div>}
        {saved !== null && <div className="dim-note">{saved}</div>}

        <div className="history-list">
          {log.length === 0 && <div className="dim-note">No traffic yet.</div>}
          {log.map((e) => (
            <ProxyLogRow key={e.id} entry={e} onSave={saveToCollection} />
          ))}
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
