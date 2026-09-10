import type { JSX } from 'react'
import { useEffect, useMemo, useState } from 'react'
import type { OpenApiOperationSummary, SpecRef } from '../../../shared/model'
import { suggestOperation } from '../../../core/spec'
import { errMsg, fp } from '../api'

interface Props {
  root: string
  method: string
  url: string
  current: SpecRef | null
  onAttach: (ref: SpecRef) => void
  /** Detach the current spec from this request (the caller then offers to delete the file). */
  onRemove: () => void
  onCancel: () => void
}

type Source = 'stored' | 'file' | 'url'

/**
 * Link a request to an OpenAPI/Swagger operation: pick (or import) a spec
 * stored in the collection's specs/ folder, then choose the operation. The
 * operation matching the request's method + path is preselected.
 */
export default function AttachSpecModal(props: Props): JSX.Element {
  const [source, setSource] = useState<Source>('stored')
  const [stored, setStored] = useState<string[]>([])
  const [specPath, setSpecPath] = useState<string | null>(props.current?.path ?? null)
  const [specUrl, setSpecUrl] = useState('')
  const [version, setVersion] = useState<string | null>(null)
  const [ops, setOps] = useState<OpenApiOperationSummary[]>([])
  const [selected, setSelected] = useState<string | null>(props.current?.operationId ?? null)
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    void fp()
      .listSpecs({ root: props.root })
      .then((list) => {
        setStored(list)
        if (props.current === null && list.length > 0 && specPath === null) setSpecPath(list[0])
        if (list.length === 0 && props.current === null) setSource('file')
      })
      .catch((e) => setError(errMsg(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.root])

  // Load operations whenever the chosen spec changes; preselect the best match.
  useEffect(() => {
    if (specPath === null) {
      setOps([])
      return
    }
    let cancelled = false
    setBusy(true)
    void fp()
      .listSpecOperations({ root: props.root, path: specPath })
      .then((r) => {
        if (cancelled) return
        if (!r.ok) {
          setError(r.error)
          setOps([])
          return
        }
        setError(null)
        setVersion(r.version)
        setOps(r.operations)
        const keep = props.current !== null && props.current.path === specPath ? props.current.operationId : null
        setSelected(keep ?? suggestOperation(r.operations, props.method, props.url) ?? null)
      })
      .catch((e) => {
        if (!cancelled) setError(errMsg(e))
      })
      .finally(() => {
        if (!cancelled) setBusy(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specPath])

  const suggested = useMemo(() => suggestOperation(ops, props.method, props.url), [ops, props.method, props.url])

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const byFolder = new Map<string, OpenApiOperationSummary[]>()
    for (const op of ops) {
      if (q !== '' && !`${op.method} ${op.path} ${op.summary ?? ''}`.toLowerCase().includes(q)) continue
      const list = byFolder.get(op.folder)
      if (list) list.push(op)
      else byFolder.set(op.folder, [op])
    }
    return [...byFolder.entries()]
  }, [ops, filter])

  async function browse(): Promise<void> {
    setError(null)
    try {
      const p = await fp().browseFile({
        title: 'Choose an OpenAPI / Swagger document',
        filters: [{ name: 'OpenAPI / Swagger', extensions: ['json', 'yaml', 'yml'] }]
      })
      if (p === null) return
      setBusy(true)
      const r = await fp().importSpec({ root: props.root, source: { kind: 'file', absPath: p } })
      setStored((s) => (s.includes(r.path) ? s : [...s, r.path].sort()))
      setSpecPath(r.path)
      setNotice(r.replaced ? `Replaced ${r.path} with the file you picked.` : `Copied into ${r.path}.`)
      setSource('stored')
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  async function fetchUrl(): Promise<void> {
    const url = specUrl.trim()
    if (url === '') return
    setError(null)
    setBusy(true)
    try {
      const listed = await fp().listOpenApiFromUrl({ url })
      if (!listed.ok) {
        setError(listed.error)
        return
      }
      let name = 'openapi'
      try {
        const last = new URL(url).pathname.split('/').filter((s) => s !== '').pop()
        if (last !== undefined && last !== '') name = last
      } catch {
        /* keep default */
      }
      const r = await fp().importSpec({ root: props.root, source: { kind: 'text', text: listed.specText, name } })
      setStored((s) => (s.includes(r.path) ? s : [...s, r.path].sort()))
      setSpecPath(r.path)
      setNotice(r.replaced ? `Replaced ${r.path} with the fetched spec.` : `Saved to ${r.path}.`)
      setSource('stored')
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const canAttach = specPath !== null && selected !== null && !busy

  return (
    <div className="modal-overlay" onMouseDown={props.onCancel}>
      <div className="modal modal-wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">Attach OpenAPI spec</div>

        <div className="import-tabs">
          <button className={source === 'stored' ? 'import-tab import-tab-active' : 'import-tab'} onClick={() => setSource('stored')}>
            In collection
          </button>
          <button className={source === 'file' ? 'import-tab import-tab-active' : 'import-tab'} onClick={() => setSource('file')}>
            From file
          </button>
          <button className={source === 'url' ? 'import-tab import-tab-active' : 'import-tab'} onClick={() => setSource('url')}>
            From URL
          </button>
        </div>

        {source === 'stored' && (
          <>
            <label className="modal-label">Spec (stored under specs/)</label>
            {stored.length === 0 ? (
              <div className="dim-note">No specs in this collection yet — import one from a file or URL.</div>
            ) : (
              <select className="modal-input" value={specPath ?? ''} onChange={(e) => setSpecPath(e.target.value)}>
                {stored.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            )}
          </>
        )}
        {source === 'file' && (
          <>
            <label className="modal-label">
              Copy an OpenAPI 3.x / Swagger 2.0 document (JSON or YAML) into specs/. Re-picking a file you
              already imported replaces the stored copy, so edits to it take effect everywhere.
            </label>
            <div className="import-file-row">
              <button className="btn" onClick={() => void browse()} disabled={busy}>
                Browse…
              </button>
            </div>
          </>
        )}
        {source === 'url' && (
          <>
            <label className="modal-label">Fetch a spec and store it in specs/</label>
            <div className="oa-url-row">
              <input
                className="modal-input"
                value={specUrl}
                placeholder="https://api.example.com/openapi.json"
                onChange={(e) => setSpecUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void fetchUrl()
                }}
              />
              <button className="btn" onClick={() => void fetchUrl()} disabled={busy || specUrl.trim() === ''}>
                {busy ? 'Fetching…' : 'Fetch'}
              </button>
            </div>
          </>
        )}

        {error !== null && <div className="banner banner-danger">{error}</div>}
        {notice !== null && <div className="banner banner-ok">{notice}</div>}

        {specPath !== null && ops.length > 0 && (
          <>
            <div className="oa-version">
              {specPath}
              {version !== null ? ` · ${version}` : ''} · {ops.length} operation{ops.length === 1 ? '' : 's'}
            </div>
            <input
              className="modal-input"
              value={filter}
              placeholder="Filter operations…"
              onChange={(e) => setFilter(e.target.value)}
            />
            <div className="oa-op-list">
              {groups.map(([folder, list]) => (
                <div className="oa-folder-group" key={folder}>
                  <div className="oa-folder-head">{folder}</div>
                  {list.map((op) => (
                    <label className={'oa-op-row' + (selected === op.id ? ' oa-op-row-selected' : '')} key={op.id}>
                      <input type="radio" name="spec-op" checked={selected === op.id} onChange={() => setSelected(op.id)} />
                      <span className="oa-method">{op.method}</span>
                      <span className="oa-path mono">{op.path}</span>
                      {op.id === suggested && <span className="spec-suggested">suggested</span>}
                      {op.summary !== undefined && <span className="oa-summary">{op.summary}</span>}
                    </label>
                  ))}
                </div>
              ))}
              {groups.length === 0 && <div className="dim-note">No operations match the filter.</div>}
            </div>
          </>
        )}

        <div className="modal-actions">
          {props.current !== null && (
            <button
              className="btn btn-danger spec-remove"
              onClick={props.onRemove}
              disabled={busy}
              title="Stop validating this request against a spec"
            >
              Remove spec
            </button>
          )}
          <button className="btn" onClick={props.onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-accent"
            disabled={!canAttach}
            onClick={() => {
              if (specPath !== null && selected !== null) props.onAttach({ path: specPath, operationId: selected })
            }}
          >
            Attach
          </button>
        </div>
      </div>
    </div>
  )
}
