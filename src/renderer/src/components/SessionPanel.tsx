import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { errMsg, fp } from '../api'

/** Inspect/edit the runtime session variable store (never written to disk). */
export default function SessionPanel(): JSX.Element {
  const [vars, setVars] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [newValue, setNewValue] = useState('')

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
          />
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
        />
        <button className="btn btn-small" onClick={() => void add()} disabled={newName.trim() === ''}>
          Add
        </button>
      </div>
    </div>
  )
}
