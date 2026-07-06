import { useEffect, useState } from 'react'
import type { SavedExample } from '../../../shared/model'
import { errMsg, fp } from '../api'
import ExampleModal from './ExampleModal'

interface Props {
  root: string
  relPath: string
  onCancel: () => void
}

/** Lists saved response examples for a request; view or delete each. */
export default function ExamplesModal(props: Props): JSX.Element {
  const [examples, setExamples] = useState<SavedExample[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [viewing, setViewing] = useState<SavedExample | null>(null)

  async function load(): Promise<void> {
    setLoading(true)
    try {
      const list = await fp().listExamples({ root: props.root, path: props.relPath })
      setExamples(list)
      setMessage(null)
    } catch (e) {
      setMessage(errMsg(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.root, props.relPath])

  async function remove(name: string): Promise<void> {
    try {
      await fp().deleteExample({ root: props.root, path: props.relPath, name })
      await load()
    } catch (e) {
      setMessage(errMsg(e))
    }
  }

  if (viewing !== null) {
    return <ExampleModal example={viewing} onCancel={() => setViewing(null)} />
  }

  return (
    <div className="modal-overlay" onMouseDown={props.onCancel}>
      <div className="modal modal-wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">Saved examples</div>

        {message !== null && <div className="banner banner-danger">{message}</div>}

        <div className="example-list">
          {loading && <div className="dim-note">Loading…</div>}
          {!loading && examples.length === 0 && (
            <div className="dim-note">
              No examples saved yet — send the request, then use “Save as example”.
            </div>
          )}
          {examples.map((ex) => {
            const s = ex.response.status
            const statusCls =
              s >= 200 && s < 300 ? 'status-ok' : s >= 400 ? 'status-err' : 'status-other'
            return (
              <div key={ex.name} className="example-row">
                <span className={'status-pill ' + statusCls}>{s}</span>
                <button className="example-name" onClick={() => setViewing(ex)}>
                  {ex.name}
                </button>
                <span className="history-at">{new Date(ex.savedAt).toLocaleString()}</span>
                <button
                  className="btn btn-danger btn-small"
                  onClick={() => void remove(ex.name)}
                >
                  Delete
                </button>
              </div>
            )
          })}
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={props.onCancel}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
