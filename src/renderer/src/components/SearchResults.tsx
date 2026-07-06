import type { SearchEntry } from '../../../shared/model'
import MethodBadge from './MethodBadge'

interface Props {
  results: SearchEntry[] | null
  onOpen: (entry: SearchEntry) => void
  onLabelClick: (label: string) => void
}

export default function SearchResults(props: Props): JSX.Element {
  if (props.results === null) return <div className="search-status">Searching…</div>
  if (props.results.length === 0) return <div className="search-status">No matches.</div>

  return (
    <div className="search-results">
      {props.results.map((entry) => (
        <div
          key={entry.path}
          className="search-row"
          title={entry.path}
          onClick={() => props.onOpen(entry)}
        >
          <div className="search-row-head">
            {entry.type === 'workflow' ? (
              <span className="wf-icon">▶</span>
            ) : (
              <MethodBadge
                method={entry.path.toLowerCase().endsWith('.ws') ? 'WS' : entry.method}
              />
            )}
            <span className="tree-name">{entry.name}</span>
          </div>
          {entry.labels.length > 0 && (
            <div className="search-labels">
              {entry.labels.map((label) => (
                <button
                  key={label}
                  className="chip"
                  title={`Filter by label:${label}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    props.onLabelClick(label)
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {entry.description !== undefined && entry.description !== '' && (
            <div className="search-desc">{entry.description}</div>
          )}
        </div>
      ))}
    </div>
  )
}
