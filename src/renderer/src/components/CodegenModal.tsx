import { useEffect, useState } from 'react'
import type { CodegenTarget, CodegenTargetInfo } from '../../../shared/model'
import { errMsg, fp } from '../api'

interface Props {
  root: string
  relPath: string
  envPath: string | null
  onCancel: () => void
}

/** Generate client code for the current request in a selectable target language. */
export default function CodegenModal(props: Props): JSX.Element {
  const [targets, setTargets] = useState<CodegenTargetInfo[]>([])
  const [target, setTarget] = useState<CodegenTarget | null>(null)
  const [resolve, setResolve] = useState(false)
  const [code, setCode] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // Load available targets once.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await fp().codegenTargets()
        if (cancelled) return
        setTargets(list)
        if (list.length > 0) setTarget(list[0].id)
      } catch (e) {
        if (!cancelled) setMessage(errMsg(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Regenerate whenever target or resolve changes.
  useEffect(() => {
    if (target === null) return
    let cancelled = false
    setCopied(false)
    void (async () => {
      try {
        const { code: generated } = await fp().generateCode({
          root: props.root,
          path: props.relPath,
          target,
          envPath: props.envPath ?? undefined,
          resolve
        })
        if (cancelled) return
        setCode(generated)
        setMessage(null)
      } catch (e) {
        if (!cancelled) {
          setCode('')
          setMessage(errMsg(e))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [target, resolve, props.root, props.relPath, props.envPath])

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
    } catch (e) {
      setMessage(errMsg(e))
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={props.onCancel}>
      <div className="modal modal-wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">Generate code</div>

        <div className="codegen-controls">
          <select
            className="method-select"
            value={target ?? ''}
            onChange={(e) => setTarget(e.target.value as CodegenTarget)}
          >
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label} ({t.language})
              </option>
            ))}
          </select>
          <label className="codegen-check">
            <input
              type="checkbox"
              checked={resolve}
              onChange={(e) => setResolve(e.target.checked)}
            />
            Resolve variables
          </label>
          <div className="topbar-spacer" />
          <button className="btn" onClick={() => void copy()} disabled={code === ''}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>

        {message !== null && <div className="banner banner-danger">{message}</div>}

        <pre className="codegen-code mono">{code === '' ? '' : code}</pre>

        <div className="modal-actions">
          <button className="btn" onClick={props.onCancel}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
