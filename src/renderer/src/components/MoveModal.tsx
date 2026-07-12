import type { JSX } from 'react'
import { useMemo, useState } from 'react'
import type { TreeNode } from '../../../shared/model'
import { parentDir } from '../util'

interface Props {
  /** The collection root node (path === '.'). */
  tree: TreeNode
  /** The node being moved. */
  node: TreeNode
  /** Display name of the node being moved (extension-stripped for leaves). */
  displayName: string
  onSubmit: (destFolder: string) => void
  onCancel: () => void
}

interface FolderOption {
  path: string
  label: string
}

/** Flatten every folder in the tree into an indented, selectable option. */
function folderOptions(root: TreeNode): FolderOption[] {
  const out: FolderOption[] = []
  function walk(node: TreeNode, depth: number): void {
    if (node.type !== 'folder') return
    const label =
      node.path === '.' ? '/ (collection root)' : `${'  '.repeat(depth - 1)}${node.name}`
    out.push({ path: node.path, label })
    for (const child of node.children ?? []) walk(child, depth + 1)
  }
  walk(root, 0)
  return out
}

/** Pick a destination folder for a request/folder move (within the collection). */
export default function MoveModal(props: Props): JSX.Element {
  const currentParent = parentDir(props.node.path)
  const isFolder = props.node.type === 'folder'

  const options = useMemo(() => {
    return folderOptions(props.tree).filter((f) => {
      // No-op: same folder it already lives in.
      if (f.path === currentParent) return false
      // A folder can't move into itself or any of its descendants.
      if (isFolder && (f.path === props.node.path || f.path.startsWith(props.node.path + '/'))) {
        return false
      }
      return true
    })
  }, [props.tree, props.node.path, currentParent, isFolder])

  const [dest, setDest] = useState<string>(options[0]?.path ?? '')

  return (
    <div className="modal-overlay" onMouseDown={props.onCancel}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">Move “{props.displayName}”</div>
        {options.length === 0 ? (
          <div className="modal-message">There is no other folder to move this into.</div>
        ) : (
          <>
            <label className="modal-label">Destination folder</label>
            <select
              className="modal-input"
              value={dest}
              onChange={(e) => setDest(e.target.value)}
              autoFocus
            >
              {options.map((o) => (
                <option key={o.path} value={o.path}>
                  {o.label}
                </option>
              ))}
            </select>
          </>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={props.onCancel}>
            Cancel
          </button>
          <button
            className="btn btn-accent"
            onClick={() => props.onSubmit(dest)}
            disabled={options.length === 0}
          >
            Move
          </button>
        </div>
      </div>
    </div>
  )
}
