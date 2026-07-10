import type { JSX } from 'react'
import { useState } from 'react'
import type { TreeNode } from '../../../shared/model'
import MethodBadge from './MethodBadge'

export type NewItemKind = 'curl' | 'websocat' | 'grpc' | 'workflow'

interface TreeCtx {
  methods: Record<string, string>
  onOpen: (node: TreeNode) => void
  onNewItem: (folderRelPath: string, kind: NewItemKind) => void
  menuPath: string | null
  setMenuPath: (p: string | null) => void
}

interface TreeProps {
  root: TreeNode
  methods: Record<string, string>
  onOpen: (node: TreeNode) => void
  onNewItem: (folderRelPath: string, kind: NewItemKind) => void
}

export default function Tree(props: TreeProps): JSX.Element {
  const [menuPath, setMenuPath] = useState<string | null>(null)
  const ctx: TreeCtx = {
    methods: props.methods,
    onOpen: props.onOpen,
    onNewItem: props.onNewItem,
    menuPath,
    setMenuPath
  }
  return (
    <div className="tree">
      <NodeView node={props.root} depth={0} ctx={ctx} />
      {menuPath !== null && <div className="menu-overlay" onClick={() => setMenuPath(null)} />}
    </div>
  )
}

function NodeView({
  node,
  depth,
  ctx
}: {
  node: TreeNode
  depth: number
  ctx: TreeCtx
}): JSX.Element {
  if (node.type === 'folder') return <FolderView node={node} depth={depth} ctx={ctx} />

  const badge =
    node.type === 'workflow' ? (
      <span className="wf-icon">▶</span>
    ) : node.kind === 'websocat' ? (
      <MethodBadge method="WS" />
    ) : (
      <MethodBadge method={ctx.methods[node.path]} />
    )

  return (
    <div
      className="tree-row tree-leaf"
      style={{ paddingLeft: 8 + depth * 14 }}
      title={node.path}
      onClick={() => ctx.onOpen(node)}
    >
      {badge}
      <span className="tree-name">{node.name}</span>
    </div>
  )
}

function FolderView({
  node,
  depth,
  ctx
}: {
  node: TreeNode
  depth: number
  ctx: TreeCtx
}): JSX.Element {
  const [open, setOpen] = useState(true)
  const menuOpen = ctx.menuPath === node.path

  return (
    <div>
      <div
        className="tree-row tree-folder"
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => setOpen(!open)}
      >
        <span className="tree-arrow">{open ? '▾' : '▸'}</span>
        <span className="tree-name">{node.name}</span>
        <button
          className="tree-add"
          title="New item in this folder"
          onClick={(e) => {
            e.stopPropagation()
            ctx.setMenuPath(menuOpen ? null : node.path)
          }}
        >
          +
        </button>
        {menuOpen && (
          <div className="menu" onClick={(e) => e.stopPropagation()}>
            <button
              className="menu-item"
              onClick={() => {
                ctx.setMenuPath(null)
                ctx.onNewItem(node.path, 'curl')
              }}
            >
              New Request (.curl)
            </button>
            <button
              className="menu-item"
              onClick={() => {
                ctx.setMenuPath(null)
                ctx.onNewItem(node.path, 'websocat')
              }}
            >
              New WebSocket (.ws)
            </button>
            <button
              className="menu-item"
              onClick={() => {
                ctx.setMenuPath(null)
                ctx.onNewItem(node.path, 'grpc')
              }}
            >
              New gRPC (.grpc)
            </button>
            <button
              className="menu-item"
              onClick={() => {
                ctx.setMenuPath(null)
                ctx.onNewItem(node.path, 'workflow')
              }}
            >
              New Workflow
            </button>
          </div>
        )}
      </div>
      {open &&
        (node.children ?? []).map((child) => (
          <NodeView key={child.path} node={child} depth={depth + 1} ctx={ctx} />
        ))}
    </div>
  )
}
