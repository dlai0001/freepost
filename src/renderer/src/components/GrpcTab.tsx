import type { ForwardedRef, JSX } from 'react'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { ExecutionReport, GrpcRequestModel, Header, RequestFile, VariableDecl } from '../../../shared/model'
import { errMsg, fp } from '../api'
import { joinPath } from '../util'
import type { TabHandle } from '../state'

interface Props {
  root: string
  relPath: string
  envPath: string | null
  onDirty: (dirty: boolean) => void
}

/** name: value lines <-> Header[]. */
function parseMetadata(text: string): Header[] {
  const out: Header[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t === '') continue
    const colon = t.indexOf(':')
    if (colon <= 0) continue
    out.push({ name: t.slice(0, colon).trim(), value: t.slice(colon + 1).trim() })
  }
  return out
}
function formatMetadata(md: Header[]): string {
  return md.map((h) => `${h.name}: ${h.value}`).join('\n')
}
/** One item per line <-> string[]. */
function parseLines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter((l) => l !== '')
}

function GrpcTab(props: Props, ref: ForwardedRef<TabHandle>): JSX.Element {
  const absPath = joinPath(props.root, props.relPath)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const [target, setTarget] = useState('')
  const [fullMethod, setFullMethod] = useState('')
  const [plaintext, setPlaintext] = useState(true)
  const [insecure, setInsecure] = useState(false)
  const [data, setData] = useState('{}')
  const [metadataText, setMetadataText] = useState('')
  const [protoText, setProtoText] = useState('')
  const [importText, setImportText] = useState('')
  const [maxTime, setMaxTime] = useState('')

  const [sending, setSending] = useState(false)
  const [response, setResponse] = useState<string | null>(null)
  const [respMeta, setRespMeta] = useState<string | null>(null)
  const [streamLog, setStreamLog] = useState<string[]>([])
  const [streaming, setStreaming] = useState(false)
  const streamIdRef = useRef<string | null>(null)

  const preservedRef = useRef<{ variables: VariableDecl[]; frontmatter: RequestFile['frontmatter']; comments: RequestFile['comments'] }>({
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
        if (parsed.ok && parsed.file.grpc !== undefined) {
          const g = parsed.file.grpc
          setTarget(g.target)
          setFullMethod(g.fullMethod)
          setPlaintext(g.plaintext === true)
          setInsecure(g.insecure === true)
          setData(g.data ?? '{}')
          setMetadataText(formatMetadata(g.metadata))
          setProtoText(g.protoFiles.join('\n'))
          setImportText(g.importPaths.join('\n'))
          setMaxTime(g.maxTimeSeconds !== undefined ? String(g.maxTimeSeconds) : '')
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
      const id = streamIdRef.current
      if (id !== null) void fp().cancelGrpcStream(id).catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [absPath])

  // Stream events for our active call.
  useEffect(() => {
    const off = fp().onGrpcStreamEvent((e) => {
      if (e.id !== streamIdRef.current) return
      if (e.type === 'data') setStreamLog((l) => [...l, e.data ?? ''])
      else if (e.type === 'error') {
        setStreamLog((l) => [...l, `error: ${e.data ?? ''}`])
        setStreaming(false)
        streamIdRef.current = null
      } else {
        setStreamLog((l) => [...l, '— stream ended —'])
        setStreaming(false)
        streamIdRef.current = null
      }
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function buildModel(): RequestFile {
    const grpc: GrpcRequestModel = {
      target: target.trim(),
      fullMethod: fullMethod.trim(),
      metadata: parseMetadata(metadataText),
      protoFiles: parseLines(protoText),
      importPaths: parseLines(importText)
    }
    if (plaintext) grpc.plaintext = true
    if (insecure) grpc.insecure = true
    if (data.trim() !== '') grpc.data = data
    const n = Number(maxTime)
    if (maxTime.trim() !== '' && Number.isFinite(n) && n > 0) grpc.maxTimeSeconds = n
    return {
      kind: 'grpc',
      frontmatter: preservedRef.current.frontmatter,
      variables: preservedRef.current.variables,
      comments: preservedRef.current.comments,
      grpc
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

  async function send(): Promise<void> {
    setResponse(null)
    setRespMeta(null)
    setSending(true)
    try {
      const report: ExecutionReport = await fp().executeRequest({
        root: props.root,
        path: props.relPath,
        envPath: props.envPath ?? undefined,
        model: buildModel()
      })
      if (report.transportError !== undefined) {
        setResponse(report.transportError)
      } else if (report.response !== undefined) {
        setResponse(report.response.bodyText)
        setRespMeta(`${report.response.statusText} · ${Math.round(report.response.timeMs)}ms`)
      }
    } catch (e) {
      setResponse(errMsg(e))
    } finally {
      setSending(false)
    }
  }

  async function startStream(): Promise<void> {
    setStreamLog([])
    try {
      const { id } = await fp().startGrpcStream({
        root: props.root,
        path: props.relPath,
        envPath: props.envPath ?? undefined,
        model: buildModel()
      })
      streamIdRef.current = id
      setStreaming(true)
    } catch (e) {
      setStreamLog([errMsg(e)])
    }
  }
  function stopStream(): void {
    const id = streamIdRef.current
    if (id !== null) void fp().cancelGrpcStream(id).catch(() => undefined)
    streamIdRef.current = null
    setStreaming(false)
  }

  if (loading) return <div className="tab-loading">Loading…</div>

  return (
    <div className="grpc-tab">
      <div className="grpc-bar">
        <input
          className="cell-input mono grpc-target"
          value={target}
          placeholder="host:50051 (supports ${VAR})"
          onChange={(e) => {
            setTarget(e.target.value)
            touch()
          }}
        />
        <input
          className="cell-input mono grpc-method"
          value={fullMethod}
          placeholder="package.Service/Method"
          onChange={(e) => {
            setFullMethod(e.target.value)
            touch()
          }}
        />
        <button className="btn" onClick={() => void send()} disabled={sending}>
          {sending ? 'Sending…' : 'Send'}
        </button>
        {streaming ? (
          <button className="btn btn-danger" onClick={stopStream}>
            Stop
          </button>
        ) : (
          <button className="btn" onClick={() => void startStream()}>
            Stream
          </button>
        )}
        <button className="btn" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {error !== null && <div className="banner banner-danger">{error}</div>}

      <div className="grpc-opts">
        <label>
          <input type="checkbox" checked={plaintext} onChange={(e) => { setPlaintext(e.target.checked); touch() }} />
          plaintext (no TLS)
        </label>
        <label>
          <input type="checkbox" checked={insecure} onChange={(e) => { setInsecure(e.target.checked); touch() }} />
          insecure TLS (skip verify)
        </label>
        <label className="grpc-maxtime">
          max-time (s)
          <input
            className="cell-input mono"
            value={maxTime}
            onChange={(e) => { setMaxTime(e.target.value); touch() }}
          />
        </label>
      </div>

      <label className="field-label">Request (JSON)</label>
      <textarea
        className="cell-input mono grpc-data"
        rows={6}
        value={data}
        onChange={(e) => { setData(e.target.value); touch() }}
      />

      <div className="grpc-grid">
        <div>
          <label className="field-label">Metadata (name: value per line)</label>
          <textarea
            className="cell-input mono"
            rows={3}
            value={metadataText}
            onChange={(e) => { setMetadataText(e.target.value); touch() }}
          />
        </div>
        <div>
          <label className="field-label">Proto files (one per line)</label>
          <textarea
            className="cell-input mono"
            rows={3}
            value={protoText}
            placeholder="helloworld.proto"
            onChange={(e) => { setProtoText(e.target.value); touch() }}
          />
        </div>
        <div>
          <label className="field-label">Import paths (one per line)</label>
          <textarea
            className="cell-input mono"
            rows={3}
            value={importText}
            placeholder="protos"
            onChange={(e) => { setImportText(e.target.value); touch() }}
          />
        </div>
      </div>

      {response !== null && (
        <div className="grpc-response">
          <div className="field-label">
            Response {respMeta !== null && <span className="resp-meta">{respMeta}</span>}
          </div>
          <pre className="mono grpc-response-body">{response}</pre>
        </div>
      )}

      {streamLog.length > 0 && (
        <div className="grpc-response">
          <div className="field-label">Stream</div>
          <pre className="mono grpc-response-body">{streamLog.join('\n\n')}</pre>
        </div>
      )}
    </div>
  )
}

export default forwardRef(GrpcTab)
