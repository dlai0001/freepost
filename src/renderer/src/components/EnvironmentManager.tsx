import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { errMsg, fp } from '../api'
import { displayName, joinPath, looksLikeFilePathKey, nextId } from '../util'

interface Props {
  root: string
  envs: string[] // collection-relative paths (from App state.envs)
  activeEnvPath: string | null
  onChanged: () => void // call after any create/delete/rename/duplicate so App reloads the env list
  onSelectEnv: (path: string | null) => void // set the app's active environment
  onClose: () => void
}

interface Row {
  id: number
  name: string
  value: string
}

function isSecret(path: string): boolean {
  return path.toLowerCase().endsWith('.local.env.json')
}

function rowsToValues(rows: Row[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of rows) {
    const name = r.name.trim()
    if (name === '') continue
    out[name] = r.value
  }
  return out
}

function valuesToRows(values: Record<string, string>): Row[] {
  return Object.entries(values).map(([name, value]) => ({ id: nextId(), name, value }))
}

function rowsToBulk(rows: Row[]): string {
  return rows
    .filter((r) => r.name.trim() !== '')
    .map((r) => `${r.name}=${r.value}`)
    .join('\n')
}

/** Parse KEY=value lines; blank lines and #comments are ignored. */
function bulkToRows(text: string): Row[] {
  const rows: Row[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = raw.indexOf('=')
    if (eq < 0) {
      const name = line
      if (name !== '') rows.push({ id: nextId(), name, value: '' })
      continue
    }
    const name = raw.slice(0, eq).trim()
    if (name === '') continue
    rows.push({ id: nextId(), name, value: raw.slice(eq + 1) })
  }
  return rows
}

function sameValues(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  for (const k of ak) if (a[k] !== b[k]) return false
  return true
}

/** Bruno-style two-pane environment manager: pick an env on the left, edit its variables on the right. */
export default function EnvironmentManager(props: Props): JSX.Element {
  const { root, envs, activeEnvPath } = props

  const [selected, setSelected] = useState<string | null>(
    activeEnvPath ?? (envs.length > 0 ? envs[0] : null)
  )
  const [error, setError] = useState<string | null>(null)

  // Left-pane create form.
  const [showNew, setShowNew] = useState(false)
  const [newName, setNewName] = useState('')
  const [newLocal, setNewLocal] = useState(false)

  // Left-pane rename / duplicate / delete inline flows.
  const [renaming, setRenaming] = useState(false)
  const [renameName, setRenameName] = useState('')
  const [duplicating, setDuplicating] = useState(false)
  const [dupName, setDupName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Right-pane editor state.
  const [rows, setRows] = useState<Row[]>([])
  const [baseline, setBaseline] = useState<Record<string, string>>({})
  const [revealed, setRevealed] = useState<Set<number>>(new Set())
  const [bulkMode, setBulkMode] = useState(false)
  const [bulkText, setBulkText] = useState('')
  const [addName, setAddName] = useState('')
  const [addValue, setAddValue] = useState('')
  // Right-click "Browse file" menu anchored over a value cell.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; rowId: number } | null>(null)

  // Pending selection while there are unsaved changes.
  const [pendingSelect, setPendingSelect] = useState<string | null | undefined>(undefined)

  const currentRows = useMemo(() => (bulkMode ? bulkToRows(bulkText) : rows), [bulkMode, bulkText, rows])
  const currentValues = useMemo(() => rowsToValues(currentRows), [currentRows])
  const dirty = useMemo(() => !sameValues(currentValues, baseline), [currentValues, baseline])

  // Reset the per-env editor sub-state whenever the selection changes.
  function resetEditorFlags(): void {
    setRevealed(new Set())
    setBulkMode(false)
    setBulkText('')
    setAddName('')
    setAddValue('')
    setRenaming(false)
    setDuplicating(false)
    setConfirmDelete(false)
  }

  const selectedRef = useRef<string | null>(selected)
  selectedRef.current = selected

  // Load values for the selected env.
  useEffect(() => {
    if (selected === null) {
      setRows([])
      setBaseline({})
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const values = await fp().readEnv(joinPath(root, selected))
        if (cancelled) return
        setRows(valuesToRows(values))
        setBaseline(values)
        setError(null)
      } catch (e) {
        if (!cancelled) setError(errMsg(e))
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, root])

  function selectEnv(path: string | null): void {
    if (path === selected) return
    if (dirty) {
      setPendingSelect(path)
      return
    }
    resetEditorFlags()
    setSelected(path)
  }

  function confirmDiscardAndSwitch(): void {
    if (pendingSelect === undefined) return
    const next = pendingSelect
    setPendingSelect(undefined)
    resetEditorFlags()
    setSelected(next)
  }

  async function save(): Promise<void> {
    if (selected === null) return
    const values = currentValues
    try {
      await fp().writeEnv({ root, path: selected, values })
      setBaseline(values)
      // Normalize local rows to the saved snapshot (drops empty-name rows).
      setRows(valuesToRows(values))
      if (bulkMode) setBulkText(rowsToBulk(valuesToRows(values)))
      setError(null)
    } catch (e) {
      setError(errMsg(e))
    }
  }

  function revert(): void {
    setRows(valuesToRows(baseline))
    if (bulkMode) setBulkText(rowsToBulk(valuesToRows(baseline)))
    setRevealed(new Set())
    setAddName('')
    setAddValue('')
  }

  function toggleBulk(): void {
    if (bulkMode) {
      // Bulk -> table: parse the textarea into rows.
      setRows(bulkToRows(bulkText))
      setBulkMode(false)
    } else {
      setBulkText(rowsToBulk(rows))
      setBulkMode(true)
    }
  }

  function updateRow(id: number, patch: Partial<Row>): void {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  /** Pick a file via the system dialog and store its path as the row's value. */
  async function browseValueFile(rowId: number): Promise<void> {
    setCtxMenu(null)
    const path = await fp().browseFile({ title: 'Select a file' })
    if (path !== null) updateRow(rowId, { value: path })
  }

  function removeRow(id: number): void {
    setRows((prev) => prev.filter((r) => r.id !== id))
  }

  function addRow(): void {
    const name = addName.trim()
    if (name === '') return
    setRows((prev) => [...prev, { id: nextId(), name, value: addValue }])
    setAddName('')
    setAddValue('')
  }

  function toggleReveal(id: number): void {
    setRevealed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // ------------------------------- left-pane actions ------------------------
  async function createEnv(): Promise<void> {
    const name = newName.trim()
    if (name === '') {
      setError('Environment name is required.')
      return
    }
    try {
      const path = await fp().createEnv({ root, name, local: newLocal })
      props.onChanged()
      setShowNew(false)
      setNewName('')
      setNewLocal(false)
      resetEditorFlags()
      setSelected(path)
      setError(null)
    } catch (e) {
      setError(errMsg(e))
    }
  }

  async function renameEnv(): Promise<void> {
    if (selected === null) return
    const name = renameName.trim()
    if (name === '') {
      setError('New name is required.')
      return
    }
    try {
      const path = await fp().renameEnv({ root, path: selected, newName: name })
      const wasActive = activeEnvPath === selected
      props.onChanged()
      if (wasActive) props.onSelectEnv(path)
      setRenaming(false)
      setSelected(path)
      setError(null)
    } catch (e) {
      setError(errMsg(e))
    }
  }

  async function duplicateEnv(): Promise<void> {
    if (selected === null) return
    const name = dupName.trim()
    if (name === '') {
      setError('Name for the copy is required.')
      return
    }
    try {
      const path = await fp().duplicateEnv({ root, path: selected, newName: name })
      props.onChanged()
      setDuplicating(false)
      setDupName('')
      resetEditorFlags()
      setSelected(path)
      setError(null)
    } catch (e) {
      setError(errMsg(e))
    }
  }

  async function deleteEnv(): Promise<void> {
    if (selected === null) return
    const removed = selected
    try {
      await fp().deleteEnv({ root, path: removed })
      if (activeEnvPath === removed) props.onSelectEnv(null)
      props.onChanged()
      const remaining = envs.filter((e) => e !== removed)
      resetEditorFlags()
      setSelected(remaining.length > 0 ? remaining[0] : null)
      setError(null)
    } catch (e) {
      setError(errMsg(e))
    }
  }

  const secretSelected = selected !== null && isSecret(selected)

  return (
    <div className="modal-overlay" onMouseDown={props.onClose}>
      <div
        className="modal modal-wide env-manager-modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-title">Environments</div>

        {error !== null && (
          <div className="banner banner-danger">
            {error}
            <button className="icon-btn" title="Dismiss" onClick={() => setError(null)}>
              ×
            </button>
          </div>
        )}

        {pendingSelect !== undefined && (
          <div className="banner banner-warn">
            Discard unsaved changes?
            <div className="env-confirm-actions">
              <button className="btn btn-small" onClick={() => setPendingSelect(undefined)}>
                Keep editing
              </button>
              <button
                className="btn btn-small btn-danger"
                onClick={confirmDiscardAndSwitch}
              >
                Discard
              </button>
            </div>
          </div>
        )}

        <div className="env-manager">
          {/* ------------------------------ left pane ------------------------------ */}
          <div className="env-manager-list">
            <div className="env-list-scroll">
              {envs.length === 0 && (
                <div className="env-list-empty">No environments yet.</div>
              )}
              {envs.map((path) => (
                <button
                  key={path}
                  className={
                    'env-list-row' +
                    (path === selected ? ' selected' : '') +
                    (path === activeEnvPath ? ' active' : '')
                  }
                  onClick={() => selectEnv(path)}
                  title={path}
                >
                  <span className="env-list-name">{displayName(path)}</span>
                  {isSecret(path) && <span className="env-secret-tag">secret</span>}
                  {path === activeEnvPath && <span className="env-active-hint">● active</span>}
                </button>
              ))}
            </div>

            {showNew ? (
              <div className="env-new-form">
                <input
                  className="modal-input"
                  placeholder="Environment name"
                  value={newName}
                  autoFocus
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void createEnv()
                    if (e.key === 'Escape') setShowNew(false)
                  }}
                />
                <label className="env-check">
                  <input
                    type="checkbox"
                    checked={newLocal}
                    onChange={(e) => setNewLocal(e.target.checked)}
                  />
                  Secret (git-ignored)
                </label>
                <div className="env-form-actions">
                  <button
                    className="btn btn-small btn-accent"
                    onClick={() => void createEnv()}
                    disabled={newName.trim() === ''}
                  >
                    Create
                  </button>
                  <button
                    className="btn btn-small"
                    onClick={() => {
                      setShowNew(false)
                      setNewName('')
                      setNewLocal(false)
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                className="btn btn-small btn-block env-new-btn"
                onClick={() => {
                  setShowNew(true)
                  setNewName('')
                  setNewLocal(false)
                }}
              >
                + New
              </button>
            )}

            {selected !== null && (
              <div className="env-list-actions">
                {activeEnvPath !== selected && (
                  <button
                    className="btn btn-small btn-block"
                    onClick={() => props.onSelectEnv(selected)}
                  >
                    Set active
                  </button>
                )}

                {duplicating ? (
                  <div className="env-inline-form">
                    <input
                      className="modal-input"
                      placeholder="Name for copy"
                      value={dupName}
                      autoFocus
                      onChange={(e) => setDupName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void duplicateEnv()
                        if (e.key === 'Escape') setDuplicating(false)
                      }}
                    />
                    <div className="env-form-actions">
                      <button
                        className="btn btn-small btn-accent"
                        onClick={() => void duplicateEnv()}
                        disabled={dupName.trim() === ''}
                      >
                        Duplicate
                      </button>
                      <button className="btn btn-small" onClick={() => setDuplicating(false)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : renaming ? (
                  <div className="env-inline-form">
                    <input
                      className="modal-input"
                      placeholder="New name"
                      value={renameName}
                      autoFocus
                      onChange={(e) => setRenameName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void renameEnv()
                        if (e.key === 'Escape') setRenaming(false)
                      }}
                    />
                    <div className="env-form-actions">
                      <button
                        className="btn btn-small btn-accent"
                        onClick={() => void renameEnv()}
                        disabled={renameName.trim() === ''}
                      >
                        Rename
                      </button>
                      <button className="btn btn-small" onClick={() => setRenaming(false)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : confirmDelete ? (
                  <div className="env-inline-form">
                    <span className="env-confirm-text">Delete this environment?</span>
                    <div className="env-form-actions">
                      <button
                        className="btn btn-small btn-danger"
                        onClick={() => void deleteEnv()}
                      >
                        Delete
                      </button>
                      <button className="btn btn-small" onClick={() => setConfirmDelete(false)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="env-action-row">
                    <button
                      className="btn btn-small"
                      onClick={() => {
                        setDuplicating(true)
                        setDupName(`${displayName(selected)} copy`)
                      }}
                    >
                      Duplicate
                    </button>
                    <button
                      className="btn btn-small"
                      onClick={() => {
                        setRenaming(true)
                        setRenameName(displayName(selected))
                      }}
                    >
                      Rename
                    </button>
                    <button
                      className="btn btn-small btn-danger"
                      onClick={() => setConfirmDelete(true)}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ------------------------------ right pane ----------------------------- */}
          <div className="env-manager-editor">
            {selected === null ? (
              <div className="env-editor-empty">No environments yet — create one.</div>
            ) : (
              <>
                <div className="env-editor-head">
                  <span className="env-editor-title">
                    {displayName(selected)}
                    {secretSelected && <span className="env-secret-tag">secret</span>}
                  </span>
                  <div className="topbar-spacer" />
                  <button className="btn btn-small" onClick={toggleBulk}>
                    {bulkMode ? 'Table edit' : 'Bulk edit'}
                  </button>
                  <button
                    className="btn btn-small"
                    onClick={revert}
                    disabled={!dirty}
                  >
                    Revert
                  </button>
                  <button
                    className="btn btn-small btn-accent"
                    onClick={() => void save()}
                    disabled={!dirty}
                  >
                    Save
                  </button>
                </div>

                {bulkMode ? (
                  <textarea
                    className="modal-textarea mono env-bulk"
                    placeholder={'KEY=value\n# comments and blank lines are ignored'}
                    value={bulkText}
                    onChange={(e) => setBulkText(e.target.value)}
                  />
                ) : (
                  <div className="env-var-table">
                    {rows.length === 0 && (
                      <div className="env-var-empty">No variables. Add one below.</div>
                    )}
                    {rows.map((r) => (
                      <div className="env-var-row" key={r.id}>
                        <input
                          className="env-var-name mono"
                          placeholder="name"
                          value={r.name}
                          onChange={(e) => updateRow(r.id, { name: e.target.value })}
                        />
                        <input
                          className="env-var-value mono"
                          type={revealed.has(r.id) ? 'text' : 'password'}
                          placeholder="value"
                          value={r.value}
                          title="Right-click to browse for a file"
                          onChange={(e) => updateRow(r.id, { value: e.target.value })}
                          onContextMenu={(e) => {
                            e.preventDefault()
                            setCtxMenu({ x: e.clientX, y: e.clientY, rowId: r.id })
                          }}
                        />
                        {looksLikeFilePathKey(r.name) && (
                          <span className="file-hint" title="Right-click the value to browse for a file">
                            📁
                          </span>
                        )}
                        <button
                          className="icon-btn"
                          title={revealed.has(r.id) ? 'Hide value' : 'Reveal value'}
                          onClick={() => toggleReveal(r.id)}
                        >
                          {revealed.has(r.id) ? '🙈' : '👁'}
                        </button>
                        <button
                          className="icon-btn"
                          title="Remove variable"
                          onClick={() => removeRow(r.id)}
                        >
                          ✕
                        </button>
                      </div>
                    ))}

                    <div className="env-var-row env-var-add">
                      <input
                        className="env-var-name mono"
                        placeholder="name"
                        value={addName}
                        onChange={(e) => setAddName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') addRow()
                        }}
                      />
                      <input
                        className="env-var-value mono"
                        placeholder="value"
                        value={addValue}
                        onChange={(e) => setAddValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') addRow()
                        }}
                      />
                      <button
                        className="btn btn-small"
                        onClick={addRow}
                        disabled={addName.trim() === ''}
                      >
                        Add
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={props.onClose}>
            Close
          </button>
        </div>

        {ctxMenu !== null && (
          <>
            <div
              className="ctx-menu-backdrop"
              onMouseDown={(e) => {
                e.stopPropagation()
                setCtxMenu(null)
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                setCtxMenu(null)
              }}
            />
            <div className="ctx-menu" style={{ top: ctxMenu.y, left: ctxMenu.x }}>
              <button
                className="ctx-menu-item"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => void browseValueFile(ctxMenu.rowId)}
              >
                Browse file…
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
