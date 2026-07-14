import type { JSX, ReactNode } from 'react'

interface Props {
  title: string
  /** Plain text, or rich content (e.g. a <pre> showing a command to approve). */
  message: ReactNode
  /** Primary action (e.g. "Save"). */
  confirmText: string
  onConfirm: () => void
  /** Middle action (e.g. "Don't Save"). Omit for a two-button dialog. */
  discardText?: string
  onDiscard?: () => void
  cancelText?: string
  onCancel: () => void
  busy?: boolean
  /** Style the primary action as destructive (filled red) instead of accent green. */
  danger?: boolean
}

/** Save / Don't Save / Cancel dialog for closing tabs or the app with unsaved edits. */
export default function ConfirmModal(props: Props): JSX.Element {
  return (
    <div className="modal-overlay" onMouseDown={props.onCancel}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">{props.title}</div>
        <div className="modal-message">{props.message}</div>
        <div className="modal-actions">
          <button className="btn" onClick={props.onCancel} disabled={props.busy}>
            {props.cancelText ?? 'Cancel'}
          </button>
          {props.discardText !== undefined && props.onDiscard !== undefined && (
            <button className="btn" onClick={props.onDiscard} disabled={props.busy}>
              {props.discardText}
            </button>
          )}
          <button
            className={'btn ' + (props.danger ? 'btn-danger-solid' : 'btn-accent')}
            onClick={props.onConfirm}
            disabled={props.busy}
          >
            {props.confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
