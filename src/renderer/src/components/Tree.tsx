import type { JSX } from 'react'
import { useState } from 'react'
import type { TreeNode } from '../../../shared/model'
import MethodBadge from './MethodBadge'

export type NewItemKind = 'curl' | 'websocat' | 'grpc' | 'mqtt' | 'mcp' | 'workflow'

/** Context-menu actions raised from a tree node (new-item stays on its own prop). */
export type TreeAction =
  | { type: 'new-folder'; parent: string }
  | { type: 'rename'; node: TreeNode }
  | { type: 'duplicate'; node: TreeNode }
  | { type: 'move'; node: TreeNode }
  | { type: 'delete'; node: TreeNode }
  | { type: 'reveal'; node: TreeNode }

interface CtxMenu {
  x: number
  y: number
  node: TreeNode
}

interface TreeCtx {
  methods: Record<string, string>
  onOpen: (node: TreeNode) => void
  onNewItem: (folderRelPath: string, kind: NewItemKind) => void
  onAction: (action: TreeAction) => void
  menuPath: string | null
  setMenuPath: (p: string | null) => void
  ctxMenu: CtxMenu | null
  setCtxMenu: (m: CtxMenu | null) => void
}

interface TreeProps {
  root: TreeNode
  methods: Record<string, string>
  onOpen: (node: TreeNode) => void
  onNewItem: (folderRelPath: string, kind: NewItemKind) => void
  onAction: (action: TreeAction) => void
}

export default function Tree(props: TreeProps): JSX.Element {
  const [menuPath, setMenuPath] = useState<string | null>(null)
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null)
  const ctx: TreeCtx = {
    methods: props.methods,
    onOpen: props.onOpen,
    onNewItem: props.onNewItem,
    onAction: props.onAction,
    menuPath,
    setMenuPath,
    ctxMenu,
    setCtxMenu
  }
  return (
    <div className="tree">
      <NodeView node={props.root} depth={0} ctx={ctx} />
      {menuPath !== null && <div className="menu-overlay" onClick={() => setMenuPath(null)} />}
      {ctxMenu !== null && <ContextMenu menu={ctxMenu} ctx={ctx} />}
    </div>
  )
}

function openCtxMenu(e: React.MouseEvent, node: TreeNode, ctx: TreeCtx): void {
  e.preventDefault()
  e.stopPropagation()
  ctx.setMenuPath(null)
  ctx.setCtxMenu({ x: e.clientX, y: e.clientY, node })
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
    ) : node.kind === 'mcp' ? (
      <MethodBadge method="MCP" />
    ) : (
      <MethodBadge method={ctx.methods[node.path]} />
    )

  return (
    <div
      className="tree-row tree-leaf"
      style={{ paddingLeft: 8 + depth * 14 }}
      title={node.path}
      onClick={() => ctx.onOpen(node)}
      onContextMenu={(e) => openCtxMenu(e, node, ctx)}
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
        onContextMenu={(e) => openCtxMenu(e, node, ctx)}
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
            <NewItemButtons folder={node.path} ctx={ctx} />
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

/** The six "New X" entries shared by the + menu and the folder context menu. */
function NewItemButtons({ folder, ctx }: { folder: string; ctx: TreeCtx }): JSX.Element {
  const items: { kind: NewItemKind; label: string }[] = [
    { kind: 'curl', label: 'New Request (.curl)' },
    { kind: 'websocat', label: 'New WebSocket (.ws)' },
    { kind: 'grpc', label: 'New gRPC (.grpc)' },
    { kind: 'mqtt', label: 'New MQTT (.mqtt)' },
    { kind: 'mcp', label: 'New MCP (.mcp)' },
    { kind: 'workflow', label: 'New Workflow' }
  ]
  return (
    <>
      {items.map((it) => (
        <button
          key={it.kind}
          className="menu-item"
          onClick={() => {
            ctx.setMenuPath(null)
            ctx.onNewItem(folder, it.kind)
          }}
        >
          {it.label}
        </button>
      ))}
    </>
  )
}

function ContextMenu({ menu, ctx }: { menu: CtxMenu; ctx: TreeCtx }): JSX.Element {
  const { node } = menu
  const isFolder = node.type === 'folder'
  const isRoot = node.path === '.'
  const close = (): void => ctx.setCtxMenu(null)
  const act = (action: TreeAction): void => {
    close()
    ctx.onAction(action)
  }
  const newItem = (kind: NewItemKind): void => {
    close()
    ctx.onNewItem(node.path, kind)
  }

  return (
    <>
      <div
        className="ctx-menu-backdrop"
        onMouseDown={(e) => {
          e.stopPropagation()
          close()
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          close()
        }}
      />
      <div
        className="ctx-menu"
        style={{ top: menu.y, left: menu.x }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {isFolder ? (
          <>
            <button className="ctx-menu-item" onClick={() => newItem('curl')}>
              New Request
            </button>
            <button className="ctx-menu-item" onClick={() => newItem('websocat')}>
              New WebSocket
            </button>
            <button className="ctx-menu-item" onClick={() => newItem('grpc')}>
              New gRPC
            </button>
            <button className="ctx-menu-item" onClick={() => newItem('mqtt')}>
              New MQTT
            </button>
            <button className="ctx-menu-item" onClick={() => newItem('mcp')}>
              New MCP
            </button>
            <button className="ctx-menu-item" onClick={() => newItem('workflow')}>
              New Workflow
            </button>
            <button
              className="ctx-menu-item"
              onClick={() => act({ type: 'new-folder', parent: node.path })}
            >
              New Folder…
            </button>
            {!isRoot && (
              <>
                <div className="ctx-menu-sep" />
                <button className="ctx-menu-item" onClick={() => act({ type: 'rename', node })}>
                  Rename Folder…
                </button>
                <button className="ctx-menu-item" onClick={() => act({ type: 'move', node })}>
                  Move to Folder…
                </button>
                <button
                  className="ctx-menu-item ctx-menu-danger"
                  onClick={() => act({ type: 'delete', node })}
                >
                  Delete Folder
                </button>
              </>
            )}
          </>
        ) : (
          <>
            <button className="ctx-menu-item" onClick={() => act({ type: 'duplicate', node })}>
              Duplicate
            </button>
            <button className="ctx-menu-item" onClick={() => act({ type: 'rename', node })}>
              Rename…
            </button>
            <button className="ctx-menu-item" onClick={() => act({ type: 'move', node })}>
              Move to Folder…
            </button>
            <button
              className="ctx-menu-item ctx-menu-danger"
              onClick={() => act({ type: 'delete', node })}
            >
              Delete
            </button>
          </>
        )}
        <div className="ctx-menu-sep" />
        <button className="ctx-menu-item" onClick={() => act({ type: 'reveal', node })}>
          Reveal in File Explorer
        </button>
      </div>
    </>
  )
}
