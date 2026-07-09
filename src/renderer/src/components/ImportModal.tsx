import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { fp, errMsg } from '../api'
import type { OpenApiOperationSummary } from '../../../shared/model'

interface Props {
  root: string
  onDone: (message: string) => void
  onError: (message: string) => void
  onCancel: () => void
}

type Mode = 'file' | 'paste' | 'openapi-url'
type OpenApiStep = 'input' | 'loading' | 'error' | 'listed'

/** Tri-state checkbox: reflects "all"/"none"/"some" via the native indeterminate flag. */
function TriCheckbox(props: { checked: boolean; indeterminate: boolean; onChange: (v: boolean) => void }): JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = props.indeterminate
  }, [props.indeterminate])
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={props.checked}
      onChange={(e) => props.onChange(e.target.checked)}
    />
  )
}

/**
 * Import dialog: browse for a file (Postman collection JSON, or any shell
 * script containing a curl/websocat/wscat command), paste a command, or
 * fetch an OpenAPI/Swagger spec from a URL and pick which endpoints to import.
 */
export default function ImportModal(props: Props): JSX.Element {
  const [mode, setMode] = useState<Mode>('file')

  // file / paste mode state
  const [filePath, setFilePath] = useState<string | null>(null)
  const [pasted, setPasted] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  // openapi-url mode state
  const [specUrl, setSpecUrl] = useState('')
  const [oaStep, setOaStep] = useState<OpenApiStep>('input')
  const [oaError, setOaError] = useState<string | null>(null)
  const [oaVersion, setOaVersion] = useState<string | null>(null)
  const [oaSpecText, setOaSpecText] = useState<string | null>(null)
  const [oaOps, setOaOps] = useState<OpenApiOperationSummary[]>([])
  const [oaSelected, setOaSelected] = useState<Set<string>>(new Set())
  const [oaFolderPrefix, setOaFolderPrefix] = useState('')

  const oaGroups = useMemo(() => {
    const byFolder = new Map<string, OpenApiOperationSummary[]>()
    for (const op of oaOps) {
      const list = byFolder.get(op.folder)
      if (list) list.push(op)
      else byFolder.set(op.folder, [op])
    }
    return [...byFolder.entries()]
  }, [oaOps])

  const canImport =
    !busy &&
    (mode === 'paste'
      ? pasted.trim() !== ''
      : mode === 'file'
        ? filePath !== null
        : oaStep === 'listed' && oaSelected.size > 0)

  async function browse(): Promise<void> {
    try {
      const p = await fp().browseImportFile()
      if (p !== null) setFilePath(p)
    } catch (e) {
      props.onError(errMsg(e))
    }
  }

  function resetOaResult(): void {
    if (oaStep === 'listed' || oaStep === 'error') {
      setOaStep('input')
      setOaError(null)
      setOaVersion(null)
      setOaSpecText(null)
      setOaOps([])
      setOaSelected(new Set())
    }
  }

  async function fetchSpec(): Promise<void> {
    if (specUrl.trim() === '') return
    setOaStep('loading')
    setOaError(null)
    try {
      const res = await fp().listOpenApiFromUrl({ url: specUrl.trim() })
      if (!res.ok) {
        setOaError(res.error)
        setOaStep('error')
        return
      }
      setOaVersion(res.version)
      setOaSpecText(res.specText)
      setOaOps(res.operations)
      setOaSelected(new Set(res.operations.map((o) => o.id)))
      setOaStep('listed')
    } catch (e) {
      setOaError(errMsg(e))
      setOaStep('error')
    }
  }

  function toggleOne(id: string, checked: boolean): void {
    setOaSelected((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  function toggleIds(ids: string[], checked: boolean): void {
    setOaSelected((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (checked) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }

  async function doImport(): Promise<void> {
    const root = props.root
    setBusy(true)
    try {
      let written: string[]
      if (mode === 'openapi-url') {
        const res = await fp().importOpenApiFromUrl({
          root,
          specText: oaSpecText as string,
          selectedIds: [...oaSelected],
          folderPrefix: oaFolderPrefix.trim() === '' ? undefined : oaFolderPrefix.trim()
        })
        written = res.written
      } else {
        const trimmedName = name.trim() === '' ? undefined : name.trim()
        const res =
          mode === 'paste'
            ? await fp().importCommand({ root, text: pasted, name: trimmedName })
            : await fp().importFile({ root, path: filePath as string, name: trimmedName })
        written = res.written
      }
      props.onDone(written.length === 1 ? `Imported ${written[0]}` : `Imported ${written.length} files`)
    } catch (e) {
      setBusy(false)
      props.onError(errMsg(e))
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={props.onCancel}>
      <div className="modal modal-wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">Import</div>

        <div className="import-tabs">
          <button
            className={mode === 'file' ? 'import-tab import-tab-active' : 'import-tab'}
            onClick={() => setMode('file')}
          >
            File
          </button>
          <button
            className={mode === 'paste' ? 'import-tab import-tab-active' : 'import-tab'}
            onClick={() => setMode('paste')}
          >
            Paste command
          </button>
          <button
            className={mode === 'openapi-url' ? 'import-tab import-tab-active' : 'import-tab'}
            onClick={() => setMode('openapi-url')}
          >
            OpenAPI/Swagger URL
          </button>
        </div>

        {mode === 'file' && (
          <>
            <label className="modal-label">
              Postman collection (.json) or any shell script with a curl / websocat / wscat command
            </label>
            <div className="import-file-row">
              <button className="btn" onClick={() => void browse()} disabled={busy}>
                Browse…
              </button>
              <span className={filePath === null ? 'import-file-none' : 'import-file-path mono'}>
                {filePath ?? 'no file selected'}
              </span>
              {filePath !== null && (
                <button className="icon-btn" title="Clear" onClick={() => setFilePath(null)}>
                  ×
                </button>
              )}
            </div>
            <label className="modal-label">Request name (optional — derived from the URL if empty)</label>
            <input
              className="modal-input"
              value={name}
              placeholder="Create user"
              onChange={(e) => setName(e.target.value)}
            />
          </>
        )}

        {mode === 'paste' && (
          <>
            <label className="modal-label">Paste a curl / websocat / wscat command</label>
            <textarea
              className="modal-textarea mono"
              rows={6}
              placeholder={"curl -X POST https://api.example.com/users \\\n  -H 'Content-Type: application/json' \\\n  -d '{\"name\": \"ada\"}'"}
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
            />
            <label className="modal-label">Request name (optional — derived from the URL if empty)</label>
            <input
              className="modal-input"
              value={name}
              placeholder="Create user"
              onChange={(e) => setName(e.target.value)}
            />
          </>
        )}

        {mode === 'openapi-url' && (
          <>
            <label className="modal-label">OpenAPI/Swagger spec URL</label>
            <div className="oa-url-row">
              <input
                className="modal-input"
                value={specUrl}
                placeholder="https://api.example.com/openapi.json"
                onChange={(e) => {
                  setSpecUrl(e.target.value)
                  resetOaResult()
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void fetchSpec()
                }}
              />
              <button
                className="btn"
                onClick={() => void fetchSpec()}
                disabled={oaStep === 'loading' || specUrl.trim() === ''}
              >
                {oaStep === 'loading' ? 'Fetching…' : 'Fetch'}
              </button>
            </div>

            {oaStep === 'error' && oaError !== null && <div className="import-hint">{oaError}</div>}
            {oaVersion !== null && oaStep === 'listed' && <div className="oa-version">Detected {oaVersion}</div>}

            {oaStep === 'listed' && (
              <>
                <label className="modal-label" style={{ marginTop: 10 }}>
                  Destination folder (optional — leave empty to use each operation's own tag/path folder)
                </label>
                <input
                  className="modal-input"
                  value={oaFolderPrefix}
                  placeholder="e.g. External APIs / Acme"
                  onChange={(e) => setOaFolderPrefix(e.target.value)}
                />

                <div className="oa-op-list">
                  <label className="oa-select-all">
                    <TriCheckbox
                      checked={oaOps.length > 0 && oaSelected.size === oaOps.length}
                      indeterminate={oaSelected.size > 0 && oaSelected.size < oaOps.length}
                      onChange={(checked) => setOaSelected(checked ? new Set(oaOps.map((o) => o.id)) : new Set())}
                    />
                    Select all ({oaSelected.size}/{oaOps.length})
                  </label>

                  {oaGroups.map(([folder, ops]) => {
                    const ids = ops.map((o) => o.id)
                    const selectedCount = ids.filter((id) => oaSelected.has(id)).length
                    return (
                      <div className="oa-folder-group" key={folder}>
                        <label className="oa-folder-head">
                          <TriCheckbox
                            checked={selectedCount === ids.length}
                            indeterminate={selectedCount > 0 && selectedCount < ids.length}
                            onChange={(checked) => toggleIds(ids, checked)}
                          />
                          {folder} ({selectedCount}/{ids.length})
                        </label>
                        {ops.map((op) => (
                          <label className="oa-op-row" key={op.id}>
                            <input
                              type="checkbox"
                              checked={oaSelected.has(op.id)}
                              onChange={(e) => toggleOne(op.id, e.target.checked)}
                            />
                            <span className="oa-method">{op.method}</span>
                            <span className="oa-path mono">{op.path}</span>
                            {op.summary !== undefined && <span className="oa-summary">{op.summary}</span>}
                          </label>
                        ))}
                      </div>
                    )
                  })}
                </div>
              </>
            )}
          </>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={props.onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-accent" disabled={!canImport} onClick={() => void doImport()}>
            {busy ? 'Importing…' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  )
}
