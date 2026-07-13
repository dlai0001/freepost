import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { errMsg, fp } from '../api'
import { looksLikeFilePathKey } from '../util'

/** Inspect/edit the runtime session variable store (never written to disk). */
export default function SessionPanel(): JSX.Element {
  const [vars, setVars] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [newValue, setNewValue] = useState('')
  // Right-click "Browse file" menu; `name` is the target var, or null for the add row.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; name: string | null } | null>(null)

  const refresh = useCallback(async () => {
    try {
      setVars(await fp().getSession())
      setError(null)
    } catch (e) {
      setError(errMsg(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function commit(name: string, value: string): Promise<void> {
    try {
      await fp().setSessionVar(name, value)
      await refresh()
    } catch (e) {
      setError(errMsg(e))
    }
  }

  async function clearAll(): Promise<void> {
    try {
      await fp().clearSession()
      await refresh()
    } catch (e) {
      setError(errMsg(e))
    }
  }

  async function add(): Promise<void> {
    const name = newName.trim()
    if (name === '') return
    await commit(name, newValue)
    setNewName('')
    setNewValue('')
  }

  /** Pick a file via the system dialog and store its path as the value. */
  async function browseValueFile(name: string | null): Promise<void> {
    setCtxMenu(null)
    const path = await fp().browseFile({ title: 'Select a file' })
    if (path === null) return
    if (name === null) setNewValue(path)
    else await commit(name, path)
  }

  const entries = Object.entries(vars).sort(([a], [b]) => a.localeCompare(b))

  return (
    <div className="session-panel">
      <div className="session-head">
        <span className="session-title">Session variables</span>
        <button className="btn btn-small" onClick={() => void clearAll()} title="Delete all">
          Clear all
        </button>
      </div>
      {error !== null && <div className="banner banner-danger">{error}</div>}
      {entries.length === 0 && <div className="session-empty">No session variables.</div>}
      {entries.map(([name, value]) => (
        <div className="session-row" key={name}>
          <span className="session-name" title={name}>
            {name}
          </span>
          <input
            key={`${name}:${value}`}
            className="session-value mono"
            defaultValue={value}
            onBlur={(e) => {
              if (e.target.value !== value) void commit(name, e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              setCtxMenu({ x: e.clientX, y: e.clientY, name })
            }}
          />
          {looksLikeFilePathKey(name) && (
            <span className="file-hint" title="Right-click the value to browse for a file">
              📁
            </span>
          )}
        </div>
      ))}
      <div className="session-row session-add">
        <input
          className="session-name-input mono"
          placeholder="name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <input
          className="session-value mono"
          placeholder="value"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add()
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            setCtxMenu({ x: e.clientX, y: e.clientY, name: null })
          }}
        />
        {looksLikeFilePathKey(newName) && (
          <span className="file-hint" title="Right-click the value to browse for a file">
            📁
          </span>
        )}
        <button className="btn btn-small" onClick={() => void add()} disabled={newName.trim() === ''}>
          Add
        </button>
      </div>

      {ctxMenu !== null && (
        <>
          <div
            className="ctx-menu-backdrop"
            onMouseDown={() => setCtxMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault()
              setCtxMenu(null)
            }}
          />
          <div className="ctx-menu" style={{ top: ctxMenu.y, left: ctxMenu.x }}>
            <button
              className="ctx-menu-item"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => void browseValueFile(ctxMenu.name)}
            >
              Browse file…
            </button>
          </div>
        </>
      )}
    </div>
  )
}
