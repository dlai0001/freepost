import type { ForwardedRef, JSX } from 'react'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { ExecutionReport, MqttMode, MqttRequestModel, RequestFile } from '../../../shared/model'
import { errMsg, fp } from '../api'
import { joinPath } from '../util'
import type { TabHandle } from '../state'

interface Props {
  root: string
  relPath: string
  envPath: string | null
  onDirty: (dirty: boolean) => void
}

function MqttTab(props: Props, ref: ForwardedRef<TabHandle>): JSX.Element {
  const absPath = joinPath(props.root, props.relPath)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const [mode, setMode] = useState<MqttMode>('publish')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const [topic, setTopic] = useState('')
  const [qos, setQos] = useState('0')
  const [retain, setRetain] = useState(false)
  const [message, setMessage] = useState('')
  const [clientId, setClientId] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [subscribed, setSubscribed] = useState(false)
  const subIdRef = useRef<string | null>(null)

  const preservedRef = useRef<{ variables: RequestFile['variables']; frontmatter: RequestFile['frontmatter']; comments: RequestFile['comments'] }>({
    variables: [],
    frontmatter: {},
    comments: []
  })
  const dirtyRef = useRef(false)
  const { onDirty } = props
  function touch(): void {
    if (!dirtyRef.current) {
      dirtyRef.current = true
      onDirty(true)
    }
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      try {
        const { parsed } = await fp().readRequest(absPath)
        if (cancelled) return
        if (parsed.ok && parsed.file.mqtt !== undefined) {
          const m = parsed.file.mqtt
          setMode(m.mode)
          setHost(m.host)
          setPort(m.port !== undefined ? String(m.port) : '')
          setTopic(m.topic)
          setQos(m.qos !== undefined ? String(m.qos) : '0')
          setRetain(m.retain === true)
          setMessage(m.message ?? '')
          setClientId(m.clientId ?? '')
          setUsername(m.username ?? '')
          setPassword(m.password ?? '')
          preservedRef.current = {
            variables: parsed.file.variables,
            frontmatter: parsed.file.frontmatter,
            comments: parsed.file.comments
          }
        } else if (!parsed.ok) {
          setError(parsed.errors.map((e) => `line ${e.line}: ${e.message}`).join('; '))
        }
      } catch (e) {
        if (!cancelled) setError(errMsg(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
      const id = subIdRef.current
      if (id !== null) void fp().unsubscribeMqtt(id).catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [absPath])

  useEffect(() => {
    const off = fp().onMqttEvent((e) => {
      if (e.id !== subIdRef.current) return
      if (e.type === 'open') setLog((l) => [...l, '— subscribed —'])
      else if (e.type === 'message') setLog((l) => [...l, `${e.topic ?? ''}  ${e.data ?? ''}`])
      else if (e.type === 'error') {
        setLog((l) => [...l, `error: ${e.data ?? ''}`])
        setSubscribed(false)
        subIdRef.current = null
      } else {
        setLog((l) => [...l, '— disconnected —'])
        setSubscribed(false)
        subIdRef.current = null
      }
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function buildModel(): RequestFile {
    const m: MqttRequestModel = { mode, host: host.trim(), topic: topic.trim() }
    const p = Number(port)
    if (port.trim() !== '' && Number.isInteger(p)) m.port = p
    const q = Number(qos)
    if (q === 1 || q === 2) m.qos = q
    if (mode === 'publish') {
      if (retain) m.retain = true
      if (message !== '') m.message = message
    }
    if (clientId.trim() !== '') m.clientId = clientId.trim()
    if (username.trim() !== '') m.username = username.trim()
    if (password !== '') m.password = password
    return {
      kind: 'mqtt',
      frontmatter: preservedRef.current.frontmatter,
      variables: preservedRef.current.variables,
      comments: preservedRef.current.comments,
      mqtt: m
    }
  }

  async function save(): Promise<boolean> {
    setError(null)
    setSaving(true)
    try {
      await fp().writeRequest(absPath, buildModel())
      dirtyRef.current = false
      onDirty(false)
      return true
    } catch (e) {
      setError(errMsg(e))
      return false
    } finally {
      setSaving(false)
    }
  }
  useImperativeHandle(ref, () => ({ save }))

  async function publish(): Promise<void> {
    setResult(null)
    setSending(true)
    try {
      const report: ExecutionReport = await fp().executeRequest({
        root: props.root,
        path: props.relPath,
        envPath: props.envPath ?? undefined,
        model: buildModel()
      })
      setResult(
        report.transportError !== undefined
          ? `Error: ${report.transportError}`
          : `Published to ${topic} · ${Math.round(report.response?.timeMs ?? 0)}ms`
      )
    } catch (e) {
      setResult(errMsg(e))
    } finally {
      setSending(false)
    }
  }

  async function subscribe(): Promise<void> {
    setLog([])
    try {
      const { id } = await fp().subscribeMqtt({
        root: props.root,
        path: props.relPath,
        envPath: props.envPath ?? undefined,
        model: buildModel()
      })
      subIdRef.current = id
      setSubscribed(true)
    } catch (e) {
      setLog([errMsg(e)])
    }
  }
  function unsubscribe(): void {
    const id = subIdRef.current
    if (id !== null) void fp().unsubscribeMqtt(id).catch(() => undefined)
    subIdRef.current = null
    setSubscribed(false)
  }

  if (loading) return <div className="tab-loading">Loading…</div>

  return (
    <div className="grpc-tab">
      <div className="grpc-bar">
        <select
          className="method-select"
          value={mode}
          onChange={(e) => { setMode(e.target.value as MqttMode); touch() }}
        >
          <option value="publish">Publish</option>
          <option value="subscribe">Subscribe</option>
        </select>
        <input
          className="cell-input mono grpc-target"
          value={host}
          placeholder="broker host (supports ${VAR})"
          onChange={(e) => { setHost(e.target.value); touch() }}
        />
        <input
          className="cell-input mono"
          style={{ width: 90 }}
          value={port}
          placeholder="port"
          onChange={(e) => { setPort(e.target.value); touch() }}
        />
        {mode === 'publish' ? (
          <button className="btn" onClick={() => void publish()} disabled={sending}>
            {sending ? 'Publishing…' : 'Publish'}
          </button>
        ) : subscribed ? (
          <button className="btn btn-danger" onClick={unsubscribe}>
            Disconnect
          </button>
        ) : (
          <button className="btn" onClick={() => void subscribe()}>
            Subscribe
          </button>
        )}
        <button className="btn" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {error !== null && <div className="banner banner-danger">{error}</div>}

      <label className="field-label">Topic</label>
      <input
        className="cell-input mono"
        value={topic}
        placeholder={mode === 'subscribe' ? 'sensors/# (wildcards allowed)' : 'sensors/temp'}
        onChange={(e) => { setTopic(e.target.value); touch() }}
      />

      <div className="grpc-opts">
        <label>
          QoS
          <select className="method-select" value={qos} onChange={(e) => { setQos(e.target.value); touch() }}>
            <option value="0">0</option>
            <option value="1">1</option>
            <option value="2">2</option>
          </select>
        </label>
        {mode === 'publish' && (
          <label>
            <input type="checkbox" checked={retain} onChange={(e) => { setRetain(e.target.checked); touch() }} />
            retain
          </label>
        )}
      </div>

      {mode === 'publish' && (
        <>
          <label className="field-label">Message</label>
          <textarea
            className="cell-input mono grpc-data"
            rows={5}
            value={message}
            onChange={(e) => { setMessage(e.target.value); touch() }}
          />
        </>
      )}

      <div className="grpc-grid">
        <div>
          <label className="field-label">Client ID</label>
          <input className="cell-input mono" value={clientId} onChange={(e) => { setClientId(e.target.value); touch() }} />
        </div>
        <div>
          <label className="field-label">Username</label>
          <input className="cell-input mono" value={username} onChange={(e) => { setUsername(e.target.value); touch() }} />
        </div>
        <div>
          <label className="field-label">Password</label>
          <input className="cell-input mono" type="password" value={password} onChange={(e) => { setPassword(e.target.value); touch() }} />
        </div>
      </div>

      {result !== null && <div className="banner banner-ok">{result}</div>}

      {mode === 'subscribe' && (
        <div className="grpc-response">
          <div className="field-label">Messages</div>
          <pre className="mono grpc-response-body">{log.join('\n')}</pre>
        </div>
      )}
    </div>
  )
}

export default forwardRef(MqttTab)
