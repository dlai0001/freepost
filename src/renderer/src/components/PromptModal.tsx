import { useEffect, useRef, useState } from 'react'

interface Props {
  title: string
  label: string
  placeholder?: string
  initial?: string
  submitText?: string
  onSubmit: (value: string) => void
  onCancel: () => void
}

/** Minimal text-input modal (window.prompt is unavailable in Electron). */
export default function PromptModal(props: Props): JSX.Element {
  const [value, setValue] = useState(props.initial ?? '')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  function submit(): void {
    const v = value.trim()
    if (v !== '') props.onSubmit(v)
  }

  return (
    <div className="modal-overlay" onMouseDown={props.onCancel}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">{props.title}</div>
        <label className="modal-label">{props.label}</label>
        <input
          ref={inputRef}
          className="modal-input"
          value={value}
          placeholder={props.placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') props.onCancel()
          }}
        />
        <div className="modal-actions">
          <button className="btn" onClick={props.onCancel}>
            Cancel
          </button>
          <button className="btn btn-accent" onClick={submit} disabled={value.trim() === ''}>
            {props.submitText ?? 'OK'}
          </button>
        </div>
      </div>
    </div>
  )
}
