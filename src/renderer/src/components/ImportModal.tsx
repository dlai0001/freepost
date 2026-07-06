import { useState } from 'react'
import { fp } from '../api'

interface Props {
  root: string
  onDone: (message: string) => void
  onError: (message: string) => void
  onCancel: () => void
}

/**
 * Import dialog: browse for a file (Postman collection JSON, or any shell
 * script containing a curl/websocat/wscat command), or paste a command.
 */
export default function ImportModal(props: Props): JSX.Element {
  const [filePath, setFilePath] = useState<string | null>(null)
  const [pasted, setPasted] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  const canImport = !busy && (pasted.trim() !== '' || filePath !== null)

  async function browse(): Promise<void> {
    try {
      const p = await fp().browseImportFile()
      if (p !== null) setFilePath(p)
    } catch (e) {
      props.onError(e instanceof Error ? e.message : String(e))
    }
  }

  async function doImport(): Promise<void> {
    const root = props.root
    setBusy(true)
    try {
      const trimmedName = name.trim() === '' ? undefined : name.trim()
      const { written } =
        pasted.trim() !== ''
          ? await fp().importCommand({ root, text: pasted, name: trimmedName })
          : await fp().importFile({ root, path: filePath as string, name: trimmedName })
      props.onDone(
        written.length === 1
          ? `Imported ${written[0]}`
          : `Imported ${written.length} files`
      )
    } catch (e) {
      setBusy(false)
      props.onError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={props.onCancel}>
      <div className="modal modal-wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">Import</div>

        <label className="modal-label">
          From a file — Postman collection (.json) or any shell script with a curl / websocat /
          wscat command
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

        <label className="modal-label">Or paste a curl / websocat / wscat command</label>
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

        {pasted.trim() !== '' && filePath !== null && (
          <div className="import-hint">Pasted command takes precedence over the selected file.</div>
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
