import type { ForwardedRef, JSX } from 'react'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type {
  ExecutionReport,
  Header,
  McpArg,
  McpDriftReport,
  McpMethod,
  McpRequestModel,
  McpTransport,
  RequestFile,
  VariableDecl
} from '../../../shared/model'
import { errMsg, fp } from '../api'
import { joinPath } from '../util'
import type { TabHandle } from '../state'
import ConfirmModal from './ConfirmModal'

interface Props {
  root: string
  relPath: string
  envPath: string | null
  onDirty: (dirty: boolean) => void
}

const METHODS: McpMethod[] = [
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/read',
  'prompts/list',
  'prompts/get'
]

/** name: value lines <-> Header[]. */
function parseHeaders(text: string): Header[] {
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
const formatHeaders = (hs: Header[]): string => hs.map((h) => `${h.name}: ${h.value}`).join('\n')

/** key=value lines <-> McpArg[]. */
function parseArgs(text: string): McpArg[] {
  const out: McpArg[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t === '') continue
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    out.push({ name: t.slice(0, eq).trim(), value: t.slice(eq + 1) })
  }
  return out
}
const formatArgs = (as: McpArg[]): string => as.map((a) => `${a.name}=${a.value}`).join('\n')

/** Shape of a tool as it comes back from tools/list. */
interface ToolInfo {
  name: string
  description?: string
  inputSchema?: { properties?: Record<string, { type?: string; description?: string }>; required?: string[] }
}
interface ResourceInfo {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}
interface PromptInfo {
  name: string
  description?: string
  arguments?: { name: string; description?: string; required?: boolean }[]
}

type Pane = 'tools' | 'resources' | 'prompts'

function McpTab(props: Props, ref: ForwardedRef<TabHandle>): JSX.Element {
  const absPath = joinPath(props.root, props.relPath)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const [transport, setTransport] = useState<McpTransport>('http')
  const [url, setUrl] = useState('')
  const [command, setCommand] = useState('')
  const [argsText, setArgsText] = useState('')
  const [envText, setEnvText] = useState('')
  const [headersText, setHeadersText] = useState('')
  const [method, setMethod] = useState<McpMethod>('tools/list')
  const [toolName, setToolName] = useState('')
  const [toolArgsText, setToolArgsText] = useState('')
  const [uri, setUri] = useState('')
  const [promptName, setPromptName] = useState('')
  const [promptArgsText, setPromptArgsText] = useState('')

  const [sending, setSending] = useState(false)
  const [response, setResponse] = useState<string | null>(null)
  const [respMeta, setRespMeta] = useState<string | null>(null)

  // Session (F2 introspection + F4 server-initiated traffic).
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [resources, setResources] = useState<ResourceInfo[]>([])
  const [prompts, setPrompts] = useState<PromptInfo[]>([])
  const [serverInfo, setServerInfo] = useState<string | null>(null)
  const [pane, setPane] = useState<Pane>('tools')
  const [log, setLog] = useState<string[]>([])
  const sessionIdRef = useRef<string | null>(null)

  // F5 drift.
  const [drift, setDrift] = useState<McpDriftReport | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // Spawn consent (stdio only).
  const [consent, setConsent] = useState<{ command: string; then: () => void } | null>(null)

  const preservedRef = useRef<{
    variables: VariableDecl[]
    frontmatter: RequestFile['frontmatter']
    comments: RequestFile['comments']
  }>({ variables: [], frontmatter: {}, comments: [] })
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
        if (parsed.ok && parsed.file.mcp !== undefined) {
          const m = parsed.file.mcp
          setTransport(m.transport)
          setUrl(m.url ?? '')
          setCommand(m.command ?? '')
          setArgsText(m.args.join('\n'))
          setEnvText(formatArgs(m.env))
          setHeadersText(formatHeaders(m.headers))
          setMethod(m.method)
          setToolName(m.toolName ?? '')
          setToolArgsText(formatArgs(m.toolArgs))
          setUri(m.uri ?? '')
          setPromptName(m.promptName ?? '')
          setPromptArgsText(formatArgs(m.promptArgs))
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
      // A leaked stdio session is an orphaned subprocess — always tear it down.
      const id = sessionIdRef.current
      if (id !== null) void fp().disconnectMcp(id).catch(() => undefined)
      sessionIdRef.current = null
    }
  }, [absPath])

  useEffect(() => {
    const off = fp().onMcpEvent((e) => {
      if (e.id !== sessionIdRef.current) return
      if (e.type === 'log') {
        const l = e.data as { level: string; data: unknown }
        setLog((prev) => [...prev, `log[${l.level}] ${JSON.stringify(l.data)}`])
      } else if (e.type === 'notification') {
        const n = e.data as { method: string }
        setLog((prev) => [...prev, `notification: ${n.method}`])
      } else if (e.type === 'error') {
        setLog((prev) => [...prev, `error: ${String(e.data ?? '')}`])
      } else {
        setLog((prev) => [...prev, '— disconnected —'])
        setConnected(false)
        sessionIdRef.current = null
      }
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function buildModel(): RequestFile {
    const mcp: McpRequestModel = {
      transport,
      args: transport === 'stdio' ? argsText.split('\n').map((a) => a.trim()).filter((a) => a !== '') : [],
      env: transport === 'stdio' ? parseArgs(envText) : [],
      headers: transport === 'http' ? parseHeaders(headersText) : [],
      method,
      toolArgs: method === 'tools/call' ? parseArgs(toolArgsText) : [],
      promptArgs: method === 'prompts/get' ? parseArgs(promptArgsText) : []
    }
    if (transport === 'http') mcp.url = url
    else mcp.command = command
    if (method === 'tools/call' && toolName !== '') mcp.toolName = toolName
    if (method === 'resources/read' && uri !== '') mcp.uri = uri
    if (method === 'prompts/get' && promptName !== '') mcp.promptName = promptName

    return {
      kind: 'mcp',
      frontmatter: preservedRef.current.frontmatter,
      variables: preservedRef.current.variables,
      comments: preservedRef.current.comments,
      mcp
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

  /**
   * Every path that could spawn a subprocess goes through here first. An http
   * server never spawns, so `required` comes back false and this is a no-op.
   * (Main enforces the same gate — this is the UI in front of it, not the lock.)
   */
  async function withSpawnConsent(action: () => void): Promise<void> {
    try {
      const { required, command: cmd } = await fp().checkMcpConsent({
        root: props.root,
        path: props.relPath,
        model: buildModel()
      })
      if (!required) {
        action()
        return
      }
      setConsent({ command: cmd, then: action })
    } catch (e) {
      setError(errMsg(e))
    }
  }

  async function approveAndRun(): Promise<void> {
    const c = consent
    if (c === null) return
    try {
      await fp().approveMcpConsent({ root: props.root, command: c.command })
      setConsent(null)
      c.then()
    } catch (e) {
      setConsent(null)
      setError(errMsg(e))
    }
  }

  function send(): void {
    void withSpawnConsent(() => void doSend())
  }

  async function doSend(): Promise<void> {
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
      if (report.unresolved !== undefined && report.unresolved.length > 0) {
        setResponse(`Unresolved required variables: ${report.unresolved.join(', ')}`)
      } else if (report.response !== undefined) {
        setResponse(report.response.bodyText)
        // statusText carries the axis: OK | TOOL_ERROR | PROTOCOL_ERROR.
        setRespMeta(`${report.response.statusText} · ${Math.round(report.response.timeMs)}ms`)
      } else if (report.transportError !== undefined) {
        setResponse(report.transportError)
      }
    } catch (e) {
      setResponse(errMsg(e))
    } finally {
      setSending(false)
    }
  }

  function connect(): void {
    void withSpawnConsent(() => void doConnect())
  }

  async function doConnect(): Promise<void> {
    setConnecting(true)
    setLog([])
    setError(null)
    try {
      const { id, introspection } = await fp().connectMcp({
        root: props.root,
        path: props.relPath,
        envPath: props.envPath ?? undefined,
        model: buildModel()
      })
      sessionIdRef.current = id
      setTools(introspection.tools as ToolInfo[])
      setResources(introspection.resources as ResourceInfo[])
      setPrompts(introspection.prompts as PromptInfo[])
      const info = introspection.serverInfo as { name?: string; version?: string }
      setServerInfo(info.name !== undefined ? `${info.name} ${info.version ?? ''}`.trim() : null)
      setConnected(true)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setConnecting(false)
    }
  }

  function disconnect(): void {
    const id = sessionIdRef.current
    if (id !== null) void fp().disconnectMcp(id).catch(() => undefined)
    sessionIdRef.current = null
    setConnected(false)
  }

  /** Click a tool in the Tools pane: load it into the request as a tools/call. */
  function useTool(t: ToolInfo): void {
    setMethod('tools/call')
    setToolName(t.name)
    const params = Object.keys(t.inputSchema?.properties ?? {})
    setToolArgsText(params.map((p) => `${p}=`).join('\n'))
    touch()
  }

  function useResource(r: ResourceInfo): void {
    setMethod('resources/read')
    setUri(r.uri)
    touch()
  }

  function usePrompt(p: PromptInfo): void {
    setMethod('prompts/get')
    setPromptName(p.name)
    setPromptArgsText((p.arguments ?? []).map((a) => `${a.name}=`).join('\n'))
    touch()
  }

  async function snapshot(): Promise<void> {
    setNotice(null)
    setDrift(null)
    await withSpawnConsent(() => {
      void (async () => {
        try {
          const { path } = await fp().snapshotMcp({
            root: props.root,
            path: props.relPath,
            envPath: props.envPath ?? undefined,
            model: buildModel()
          })
          setNotice(`Schema snapshot written to ${path}`)
        } catch (e) {
          setError(errMsg(e))
        }
      })()
    })
  }

  async function checkDrift(): Promise<void> {
    setNotice(null)
    setDrift(null)
    await withSpawnConsent(() => {
      void (async () => {
        try {
          const report = await fp().driftMcp({
            root: props.root,
            path: props.relPath,
            envPath: props.envPath ?? undefined,
            model: buildModel()
          })
          setDrift(report)
          if (report.clean) setNotice('No schema drift — the server matches the snapshot.')
        } catch (e) {
          setError(errMsg(e))
        }
      })()
    })
  }

  if (loading) return <div className="tab-loading">Loading…</div>

  return (
    <div className="grpc-tab">
      {error !== null && (
        <div className="banner banner-danger">
          {error}
          <button className="icon-btn" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}
      {notice !== null && (
        <div className="banner banner-warn">
          {notice}
          <button className="icon-btn" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      )}

      <div className="grpc-bar">
        <select
          className="method-select"
          value={transport}
          onChange={(e) => {
            setTransport(e.target.value as McpTransport)
            touch()
          }}
        >
          <option value="http">Streamable HTTP</option>
          <option value="stdio">stdio (spawns a subprocess)</option>
        </select>
        {transport === 'http' ? (
          <input
            className="cell-input grpc-target"
            placeholder="http://localhost:3011/mcp"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value)
              touch()
            }}
          />
        ) : (
          <input
            className="cell-input grpc-target"
            placeholder="node (the server program to spawn)"
            value={command}
            onChange={(e) => {
              setCommand(e.target.value)
              touch()
            }}
          />
        )}
        <button className="btn" onClick={send} disabled={sending}>
          {sending ? 'Sending…' : 'Send'}
        </button>
        {connected ? (
          <button className="btn btn-danger" onClick={disconnect}>
            Disconnect
          </button>
        ) : (
          <button className="btn" onClick={connect} disabled={connecting}>
            {connecting ? 'Connecting…' : 'Connect'}
          </button>
        )}
        <button className="btn btn-small" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      <div className="grpc-bar">
        <select
          className="method-select"
          value={method}
          onChange={(e) => {
            setMethod(e.target.value as McpMethod)
            touch()
          }}
        >
          {METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        {method === 'tools/call' && (
          <input
            className="cell-input grpc-method"
            placeholder="tool name"
            value={toolName}
            onChange={(e) => {
              setToolName(e.target.value)
              touch()
            }}
          />
        )}
        {method === 'resources/read' && (
          <input
            className="cell-input grpc-method"
            placeholder="resource URI, e.g. demo://greeting"
            value={uri}
            onChange={(e) => {
              setUri(e.target.value)
              touch()
            }}
          />
        )}
        {method === 'prompts/get' && (
          <input
            className="cell-input grpc-method"
            placeholder="prompt name"
            value={promptName}
            onChange={(e) => {
              setPromptName(e.target.value)
              touch()
            }}
          />
        )}
        <button className="btn btn-small" onClick={() => void snapshot()}>
          Snapshot schema
        </button>
        <button className="btn btn-small" onClick={() => void checkDrift()}>
          Check drift
        </button>
      </div>

      <div className="grpc-grid">
        {transport === 'stdio' ? (
          <>
            <div>
              <div className="field-label">Server args (one per line)</div>
              <textarea
                className="cell-input mono"
                rows={4}
                placeholder={'-y\n@modelcontextprotocol/server-everything'}
                value={argsText}
                onChange={(e) => {
                  setArgsText(e.target.value)
                  touch()
                }}
              />
            </div>
            <div>
              <div className="field-label">Environment (KEY=value)</div>
              <textarea
                className="cell-input mono"
                rows={4}
                placeholder="GITHUB_TOKEN=${TOKEN}"
                value={envText}
                onChange={(e) => {
                  setEnvText(e.target.value)
                  touch()
                }}
              />
            </div>
          </>
        ) : (
          <div>
            <div className="field-label">Headers (name: value)</div>
            <textarea
              className="cell-input mono"
              rows={4}
              placeholder="Authorization: Bearer ${TOKEN}"
              value={headersText}
              onChange={(e) => {
                setHeadersText(e.target.value)
                touch()
              }}
            />
          </div>
        )}

        {method === 'tools/call' && (
          <div>
            <div className="field-label">Tool arguments (key=value)</div>
            <textarea
              className="cell-input mono"
              rows={4}
              placeholder={'a=20\nb=22'}
              value={toolArgsText}
              onChange={(e) => {
                setToolArgsText(e.target.value)
                touch()
              }}
            />
          </div>
        )}
        {method === 'prompts/get' && (
          <div>
            <div className="field-label">Prompt arguments (key=value)</div>
            <textarea
              className="cell-input mono"
              rows={4}
              placeholder="who=Ada"
              value={promptArgsText}
              onChange={(e) => {
                setPromptArgsText(e.target.value)
                touch()
              }}
            />
          </div>
        )}
      </div>

      {drift !== null && !drift.clean && (
        <div className={`banner ${drift.breaking ? 'banner-danger' : 'banner-warn'}`}>
          <div>
            {drift.breaking ? 'BREAKING schema drift' : 'Schema drift (additive)'} —{' '}
            {drift.entries.length} change(s):
            <ul className="mcp-drift-list">
              {drift.entries.map((e, i) => (
                <li key={i}>
                  {e.breaking ? 'BREAKING: ' : 'additive: '}
                  {e.message}
                </li>
              ))}
            </ul>
          </div>
          <button className="icon-btn" onClick={() => setDrift(null)}>
            ×
          </button>
        </div>
      )}

      {connected && (
        <div className="mcp-session">
          <div className="field-label">
            Connected {serverInfo !== null && <span className="resp-meta">{serverInfo}</span>}
          </div>
          <div className="section-tabs">
            {(['tools', 'resources', 'prompts'] as Pane[]).map((p) => (
              <button
                key={p}
                className={`section-tab${pane === p ? ' section-tab-active' : ''}`}
                onClick={() => setPane(p)}
              >
                {p} (
                {p === 'tools' ? tools.length : p === 'resources' ? resources.length : prompts.length})
              </button>
            ))}
          </div>

          {pane === 'tools' && (
            <div className="mcp-list">
              {tools.length === 0 && <div className="dim-note">This server exposes no tools.</div>}
              {tools.map((t) => (
                <button key={t.name} className="mcp-item" onClick={() => useTool(t)}>
                  <span className="mono">{t.name}</span>
                  <span className="mcp-item-params">
                    ({Object.entries(t.inputSchema?.properties ?? {})
                      .map(([n, s]) => `${n}: ${s.type ?? '?'}`)
                      .join(', ')})
                  </span>
                  {t.description !== undefined && <span className="dim-note"> {t.description}</span>}
                </button>
              ))}
            </div>
          )}
          {pane === 'resources' && (
            <div className="mcp-list">
              {resources.length === 0 && <div className="dim-note">This server exposes no resources.</div>}
              {resources.map((r) => (
                <button key={r.uri} className="mcp-item" onClick={() => useResource(r)}>
                  <span className="mono">{r.uri}</span>
                  {r.description !== undefined && <span className="dim-note"> {r.description}</span>}
                </button>
              ))}
            </div>
          )}
          {pane === 'prompts' && (
            <div className="mcp-list">
              {prompts.length === 0 && <div className="dim-note">This server exposes no prompts.</div>}
              {prompts.map((p) => (
                <button key={p.name} className="mcp-item" onClick={() => usePrompt(p)}>
                  <span className="mono">{p.name}</span>
                  <span className="mcp-item-params">
                    ({(p.arguments ?? []).map((a) => a.name).join(', ')})
                  </span>
                  {p.description !== undefined && <span className="dim-note"> {p.description}</span>}
                </button>
              ))}
            </div>
          )}

          {log.length > 0 && (
            <>
              <div className="field-label">Server notifications</div>
              <pre className="mono grpc-response-body">{log.join('\n')}</pre>
            </>
          )}
        </div>
      )}

      {response !== null && (
        <div className="grpc-response">
          <div className="field-label">
            Response {respMeta !== null && <span className="resp-meta">{respMeta}</span>}
          </div>
          <pre className="mono grpc-response-body">{response}</pre>
        </div>
      )}

      {consent !== null && (
        <ConfirmModal
          title="Run this MCP server?"
          message={
            <>
              <div>This request starts a program on your machine:</div>
              <pre className="mono mcp-consent-cmd">{consent.command}</pre>
              <div>
                Only approve a command you trust. Freepost will remember this server for this
                collection.
              </div>
            </>
          }
          confirmText="Approve & run"
          onConfirm={() => void approveAndRun()}
          cancelText="Cancel"
          onCancel={() => setConsent(null)}
        />
      )}
    </div>
  )
}

export default forwardRef(McpTab)
