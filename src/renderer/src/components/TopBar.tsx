interface Props {
  root: string | null
  notice: string | null
  onDismissNotice: () => void
  onImport: () => void
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
      <button className="btn" onClick={props.onImport} disabled={props.root === null}>
        Import
      </button>
    </header>
  )
}
