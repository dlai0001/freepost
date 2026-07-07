import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import type { SearchEntry, TreeNode } from '../../../shared/model'
import { fp } from '../api'
import { displayName } from '../util'
import Tree, { type NewItemKind } from './Tree'
import SearchResults from './SearchResults'
import SessionPanel from './SessionPanel'

interface Props {
  root: string | null
  tree: TreeNode | null
  envs: string[]
  envPath: string | null
  methods: Record<string, string>
  sessionOpen: boolean
  onOpenCollection: () => void
  onOpenNode: (node: TreeNode) => void
  onOpenEntry: (entry: SearchEntry) => void
  onNewItem: (folderRelPath: string, kind: NewItemKind) => void
  onEnvChange: (envPath: string | null) => void
  onToggleSession: () => void
}

export default function Sidebar(props: Props): JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchEntry[] | null>(null)
  const searching = query.trim() !== ''
  const { root } = props

  useEffect(() => {
    if (root === null || query.trim() === '') {
      setResults(null)
      return
    }
    let cancelled = false
    setResults(null)
    const t = setTimeout(() => {
      fp()
        .search({ root, query })
        .then((r) => {
          if (!cancelled) setResults(r)
        })
        .catch(() => {
          if (!cancelled) setResults([])
        })
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [query, root])

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <button className="btn btn-block" onClick={props.onOpenCollection}>
          Open Collection
        </button>
        {root !== null && (
          <input
            className="search-input"
            placeholder="Search… (label:foo filters)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
      </div>

      <div className="sidebar-scroll">
        {root === null ? (
          <div className="sidebar-empty">
            Open a folder to load a collection. Any folder of .curl / .ws / .workflow.json files
            works.
          </div>
        ) : searching ? (
          <SearchResults
            results={results}
            onOpen={props.onOpenEntry}
            onLabelClick={(label) => setQuery(`label:${label}`)}
          />
        ) : props.tree !== null ? (
          <Tree
            root={props.tree}
            methods={props.methods}
            onOpen={props.onOpenNode}
            onNewItem={props.onNewItem}
          />
        ) : null}
      </div>

      {props.sessionOpen && <SessionPanel />}

      <div className="sidebar-bottom">
        <select
          className="env-select"
          title="Environment"
          value={props.envPath ?? ''}
          disabled={root === null}
          onChange={(e) => props.onEnvChange(e.target.value === '' ? null : e.target.value)}
        >
          <option value="">No environment</option>
          {props.envs.map((env) => (
            <option key={env} value={env}>
              {displayName(env)}
            </option>
          ))}
        </select>
        <button
          className={'btn' + (props.sessionOpen ? ' btn-toggled' : '')}
          title="Session variables"
          onClick={props.onToggleSession}
        >
          Session
        </button>
      </div>
    </aside>
  )
}
