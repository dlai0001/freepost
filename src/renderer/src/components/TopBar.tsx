import type { JSX } from 'react'
interface Props {
  root: string | null
  notice: string | null
  onDismissNotice: () => void
  onImport: () => void
  onHistory: () => void
  onMock: () => void
}

export default function TopBar(props: Props): JSX.Element {
  return (
    <header className="topbar">
      <span className="topbar-brand">freepost</span>
      <span className="topbar-root" title={props.root ?? undefined}>
        {props.root ?? 'no collection open'}
      </span>
      <div className="topbar-spacer" />
      {props.notice !== null && (
        <span className="topbar-notice">
          {props.notice}
          <button className="icon-btn" title="Dismiss" onClick={props.onDismissNotice}>
            ×
          </button>
        </span>
      )}
      <button className="btn" onClick={props.onHistory} disabled={props.root === null}>
        History
      </button>
      <button className="btn" onClick={props.onMock} disabled={props.root === null}>
        Mock Server
      </button>
      <button className="btn" onClick={props.onImport} disabled={props.root === null}>
        Import
      </button>
    </header>
  )
}
