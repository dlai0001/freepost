import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { VariableDecl } from '../../../shared/model'
import { errMsg, fp } from '../api'
import { joinPath } from '../util'
import VarInput from './VarInput'
import type { VarLookup } from './varHighlight'
import { makeVarLookup, useVarSources, type VarDecl } from './varContext'

type ConnState = 'closed' | 'connecting' | 'open'

interface LogEntry {
  id: number
  dir: 'sent' | 'recv' | 'info' | 'error'
  text: string
  at: string
}

interface Props {
  root: string
  relPath: string
  envPath: string | null
}

let logId = 1

/** WebSocket (.ws / websocat) tab. All socket I/O happens in the main process;
 *  the renderer only exchanges IPC messages (zero-network fence). */
export default function WebSocketTab(props: Props): JSX.Element {
  const absPath = joinPath(props.root, props.relPath)

  const [url, setUrl] = useState('')
  const [presets, setPresets] = useState<Record<string, string>>({})
  // Declared variables (with secret flags) for `${VAR}` highlighting in the URL.
  const [varDecls, setVarDecls] = useState<Map<string, VarDecl>>(new Map())
  const [state, setState] = useState<ConnState>('closed')
  const [log, setLog] = useState<LogEntry[]>([])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const connIdRef = useRef<string | null>(null)
  const logEndRef = useRef<HTMLDivElement>(null)

  const varSources = useVarSources(props.root, props.envPath)
  const varLookup = useMemo<VarLookup>(
    () => makeVarLookup(varSources, varDecls),
    [varSources, varDecls]
  )

  function append(dir: LogEntry['dir'], text: string): void {
    setLog((l) => [...l, { id: logId++, dir, text, at: new Date().toLocaleTimeString() }])
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const { parsed } = await fp().readRequest(absPath)
        if (cancelled) return
        if (parsed.ok) {
          setUrl(parsed.file.ws?.url ?? '')
          setPresets(parsed.file.frontmatter.messages ?? {})
          const meta = parsed.file.frontmatter.variables ?? {}
          const decls = new Map<string, VarDecl>()
          for (const d of parsed.file.variables as VariableDecl[]) {
            decls.set(d.name, {
              def: d.defaultValue ?? '',
              required: d.required,
              secret: meta[d.name]?.secret === true
            })
          }
          setVarDecls(decls)
        } else {
          setError(`File has parse errors (line ${parsed.errors[0]?.line}): ${parsed.errors[0]?.message}`)
        }
      } catch (e) {
        if (!cancelled) setError(errMsg(e))
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [absPath])

  useEffect(() => {
    const off = fp().onWsEvent((e) => {
      if (e.id !== connIdRef.current) return
      switch (e.type) {
        case 'open':
          setState('open')
          append('info', 'connected')
          break
        case 'message':
          append('recv', e.data ?? '')
          break
        case 'close':
          setState('closed')
          connIdRef.current = null
          append('info', `closed${e.data !== undefined ? `: ${e.data}` : ''}`)
          break
        case 'error':
          setState('closed')
          append('error', `error${e.data !== undefined ? `: ${e.data}` : ''}`)
          break
      }
    })
    return () => {
      off()
      const id = connIdRef.current
      if (id !== null) void fp().wsClose(id).catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: 'end' })
  }, [log])

  async function connect(): Promise<void> {
    setError(null)
    setState('connecting')
    try {
      const { id } = await fp().wsConnect({
        root: props.root,
        path: props.relPath,
        envPath: props.envPath ?? undefined
      })
      connIdRef.current = id
    } catch (e) {
      setState('closed')
      setError(errMsg(e))
    }
  }

  async function disconnect(): Promise<void> {
    const id = connIdRef.current
    if (id === null) return
    try {
      await fp().wsClose(id)
    } catch (e) {
      setError(errMsg(e))
    }
  }

  async function send(): Promise<void> {
    const id = connIdRef.current
    if (id === null || draft === '') return
    try {
      await fp().wsSend(id, draft)
      append('sent', draft)
      setDraft('')
    } catch (e) {
      setError(errMsg(e))
    }
  }

  return (
    <div className="ws-tab">
      {error !== null && (
        <div className="banner banner-danger">
          {error}
          <button className="icon-btn" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}

      <div className="req-topline">
        <span className={`ws-dot ws-dot-${state}`} title={state} />
        {url === '' ? (
          <span className="ws-url mono ws-url-empty">(no url)</span>
        ) : (
          <VarInput className="ws-url plain grow" value={url} varLookup={varLookup} readOnly />
        )}
        {state === 'closed' ? (
          <button className="btn btn-accent" onClick={() => void connect()}>
            Connect
          </button>
        ) : (
          <button className="btn btn-danger" onClick={() => void disconnect()}>
            {state === 'connecting' ? 'Cancel' : 'Disconnect'}
          </button>
        )}
      </div>

      {Object.keys(presets).length > 0 && (
        <div className="ws-presets">
          {Object.entries(presets).map(([name, value]) => (
            <button
              key={name}
              className="chip"
              title={value}
              onClick={() => setDraft(value)}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      <div className="ws-log">
        {log.length === 0 && <div className="dim-note">No messages yet.</div>}
        {log.map((entry) => (
          <div key={entry.id} className={`ws-msg ws-msg-${entry.dir}`}>
            <div className="ws-msg-meta">
              {entry.dir === 'sent' ? '↑ sent' : entry.dir === 'recv' ? '↓ received' : entry.dir}{' '}
              · {entry.at}
            </div>
            <pre className="mono">{entry.text}</pre>
          </div>
        ))}
        <div ref={logEndRef} />
      </div>

      <div className="ws-sendbox">
        <textarea
          className="editor mono"
          rows={3}
          value={draft}
          placeholder="Message to send"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send()
          }}
        />
        <button
          className="btn btn-accent"
          onClick={() => void send()}
          disabled={state !== 'open' || draft === ''}
        >
          Send
        </button>
      </div>
    </div>
  )
}
