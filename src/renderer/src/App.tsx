import type { JSX } from 'react'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { RequestKind, SearchEntry, TreeNode } from '../../shared/model'
import { errMsg, fp, hasApi } from './api'
import { initialState, reducer, type Tab, type TabHandle, type TabType } from './state'
import { baseName, displayName, INVALID_NAME, joinPath, knownExt, parentDir } from './util'
import TopBar from './components/TopBar'
import Sidebar from './components/Sidebar'
import TabBar from './components/TabBar'
import RequestTab from './components/RequestTab'
import WebSocketTab from './components/WebSocketTab'
import WorkflowTab from './components/WorkflowTab'
import GrpcTab from './components/GrpcTab'
import MqttTab from './components/MqttTab'
import McpTab from './components/McpTab'
import PromptModal from './components/PromptModal'
import ConfirmModal from './components/ConfirmModal'
import ImportModal from './components/ImportModal'
import HistoryPanel from './components/HistoryPanel'
import MockServerModal from './components/MockServerModal'
import EnvironmentManager from './components/EnvironmentManager'
import MoveModal from './components/MoveModal'
import type { NewItemKind, TreeAction } from './components/Tree'

type ModalSpec =
  | { kind: 'import' }
  | { kind: 'history' }
  | { kind: 'mock' }
  | { kind: 'env-manager' }
  | { kind: 'new-item'; folder: string; itemKind: NewItemKind }
  | { kind: 'new-folder'; parent: string }
  | { kind: 'rename'; node: TreeNode }
  | { kind: 'duplicate'; node: TreeNode }
  | { kind: 'move'; node: TreeNode }
  | { kind: 'delete'; node: TreeNode }
  | { kind: 'close-tab'; id: string }
  | { kind: 'quit' }

export default function App(): JSX.Element {
  if (!hasApi()) return <NotElectron />
  return <Shell />
}

function NotElectron(): JSX.Element {
  return (
    <div className="boot">
      <h1>freepost</h1>
      <p>
        This UI must run inside the freepost Electron app — <code>window.freepost</code> is not
        available in a bare browser.
      </p>
      <p className="boot-hint">
        Start it with <code>npm run dev</code> from the repository root.
      </p>
    </div>
  )
}

function Shell(): JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialState)
  const [modal, setModal] = useState<ModalSpec | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const rootRef = useRef<string | null>(null)
  rootRef.current = state.root

  // Per-tab imperative save handles (request/workflow tabs register themselves),
  // plus a live mirror of the tab list for the window-close listener below.
  const tabHandles = useRef(new Map<string, TabHandle>())
  const tabsRef = useRef<Tab[]>(state.tabs)
  tabsRef.current = state.tabs

  const setTabHandle = useCallback((id: string, handle: TabHandle | null): void => {
    if (handle) tabHandles.current.set(id, handle)
    else tabHandles.current.delete(id)
  }, [])

  // Closing a tab with unsaved edits prompts first; a clean tab closes at once.
  const requestCloseTab = useCallback((id: string): void => {
    const tab = tabsRef.current.find((t) => t.id === id)
    if (tab?.dirty) setModal({ kind: 'close-tab', id })
    else dispatch({ type: 'close-tab', id })
  }, [])

  // Save every dirty tab; returns false if any save failed (so we don't quit).
  const saveDirtyTabs = useCallback(async (): Promise<boolean> => {
    let allOk = true
    for (const tab of tabsRef.current) {
      if (!tab.dirty) continue
      const handle = tabHandles.current.get(tab.id)
      if (handle === undefined) continue
      if (!(await handle.save())) allOk = false
    }
    return allOk
  }, [])

  // The window-close request is handed to us by main; decide based on unsaved work.
  useEffect(() => {
    return fp().onAppBeforeClose(() => {
      const hasDirty = tabsRef.current.some((t) => t.dirty)
      if (hasDirty) setModal({ kind: 'quit' })
      else void fp().confirmAppClose()
    })
  }, [])

  const loadCollection = useCallback(async (root: string): Promise<void> => {
    const tree = await fp().scanCollection(root)
    dispatch({ type: 'collection-loaded', root, tree })
    try {
      const envs = await fp().listEnvs(root)
      dispatch({ type: 'set-envs', envs })
    } catch {
      dispatch({ type: 'set-envs', envs: [] })
    }
    try {
      // Empty query returns the whole index; prime method badges for the tree.
      const entries = await fp().search({ root, query: '' })
      const methods: Record<string, string> = {}
      for (const e of entries) if (e.method !== undefined) methods[e.path] = e.method
      dispatch({ type: 'set-methods', methods })
    } catch {
      // Index unavailable — tree falls back to generic badges.
    }
    try {
      // Leak guardrail: warn if secrets/history under .freepost/ are git-tracked.
      const tracked = await fp().checkCollectionSecurity(root)
      if (tracked.length > 0) {
        setNotice(
          `⚠ ${tracked.length} file(s) under .freepost/ are tracked by git — secrets/history may be committed. Run: git rm -r --cached .freepost`
        )
      }
    } catch {
      // Security check is best-effort.
    }
  }, [])

  const loadRef = useRef(loadCollection)
  loadRef.current = loadCollection

  const refreshEnvs = useCallback(async (): Promise<void> => {
    const root = rootRef.current
    if (root === null) return
    try {
      const envs = await fp().listEnvs(root)
      dispatch({ type: 'set-envs', envs })
    } catch (e) {
      setNotice(errMsg(e))
    }
  }, [])

  useEffect(() => {
    return fp().onCollectionChanged((root) => {
      if (rootRef.current !== null && root === rootRef.current) {
        void loadRef.current(root).catch((e) => setNotice(errMsg(e)))
      }
    })
  }, [])

  // On startup, reopen the collection that was open last time (if it still exists).
  useEffect(() => {
    void (async () => {
      try {
        const last = await fp().lastCollection()
        if (last !== null) await loadRef.current(last)
      } catch {
        // No remembered collection or it failed to load — user picks one manually.
      }
    })()
  }, [])

  async function handleOpenCollection(): Promise<void> {
    try {
      const root = await fp().openCollection()
      if (root === null) return
      await loadCollection(root)
    } catch (e) {
      setNotice(errMsg(e))
    }
  }

  function openPath(path: string, type: 'request' | 'workflow', kind?: RequestKind): void {
    const tabType: TabType =
      type === 'workflow'
        ? 'workflow'
        : kind === 'websocat' || path.toLowerCase().endsWith('.ws')
          ? 'websocket'
          : kind === 'grpc' || path.toLowerCase().endsWith('.grpc')
            ? 'grpc'
            : kind === 'mqtt' || path.toLowerCase().endsWith('.mqtt')
              ? 'mqtt'
              : kind === 'mcp' || path.toLowerCase().endsWith('.mcp')
                ? 'mcp'
                : 'request'
    const tab: Tab = { id: path, path, name: displayName(path), type: tabType, dirty: false }
    dispatch({ type: 'open-tab', tab })
  }

  function openNode(node: TreeNode): void {
    if (node.type === 'folder') return
    openPath(node.path, node.type, node.kind)
  }

  function openEntry(entry: SearchEntry): void {
    openPath(entry.path, entry.type)
  }

  async function createItem(folder: string, itemKind: NewItemKind, name: string): Promise<void> {
    const root = state.root
    if (root === null) return
    if (INVALID_NAME.test(name)) {
      setNotice('Invalid name: cannot contain < > : " / \\ | ? *')
      return
    }
    const ext =
      itemKind === 'curl'
        ? '.curl'
        : itemKind === 'websocat'
          ? '.ws'
          : itemKind === 'grpc'
            ? '.grpc'
            : itemKind === 'mqtt'
              ? '.mqtt'
              : itemKind === 'mcp'
                ? '.mcp'
                : '.workflow.json'
    const folderRel = folder === '.' ? '' : folder
    const rel = folderRel === '' ? `${name}${ext}` : `${folderRel}/${name}${ext}`
    const abs = joinPath(root, rel)
    try {
      if (itemKind === 'workflow') {
        await fp().writeWorkflow(abs, { description: '', steps: [] })
      } else {
        await fp().createRequest(abs, itemKind)
      }
      await loadCollection(root)
      openPath(rel, itemKind === 'workflow' ? 'workflow' : 'request', itemKind === 'workflow' ? undefined : itemKind)
    } catch (e) {
      setNotice(errMsg(e))
    }
  }

  // --- sidebar context-menu operations -------------------------------------

  const INVALID = 'Invalid name: cannot contain < > : " / \\ | ? *'

  /** Open tabs invalidated by an operation on `rel` (a file, or a folder + its subtree). */
  function affectedTabIds(rel: string, isFolder: boolean): string[] {
    return state.tabs
      .filter((t) => (isFolder ? t.path === rel || t.path.startsWith(rel + '/') : t.path === rel))
      .map((t) => t.id)
  }

  function handleTreeAction(action: TreeAction): void {
    switch (action.type) {
      case 'new-folder':
        setModal({ kind: 'new-folder', parent: action.parent })
        break
      case 'rename':
        setModal({ kind: 'rename', node: action.node })
        break
      case 'duplicate':
        setModal({ kind: 'duplicate', node: action.node })
        break
      case 'move':
        setModal({ kind: 'move', node: action.node })
        break
      case 'delete':
        setModal({ kind: 'delete', node: action.node })
        break
      case 'reveal': {
        const root = state.root
        if (root === null) return
        void fp()
          .revealInFolder(joinPath(root, action.node.path))
          .catch((e) => setNotice(errMsg(e)))
        break
      }
    }
  }

  async function createFolder(parent: string, name: string): Promise<void> {
    const root = state.root
    if (root === null) return
    if (INVALID_NAME.test(name)) {
      setNotice(INVALID)
      return
    }
    const parentRel = parent === '.' ? '' : parent
    const rel = parentRel === '' ? name : `${parentRel}/${name}`
    try {
      await fp().createFolder(joinPath(root, rel))
      await loadCollection(root)
    } catch (e) {
      setNotice(errMsg(e))
    }
  }

  /** Rename a request/workflow file (preserving its extension) or a folder. */
  async function renameNode(node: TreeNode, newName: string): Promise<void> {
    const root = state.root
    if (root === null) return
    if (INVALID_NAME.test(newName)) {
      setNotice(INVALID)
      return
    }
    const isFolder = node.type === 'folder'
    const parent = parentDir(node.path)
    const prefix = parent === '.' ? '' : `${parent}/`
    const newRel = isFolder ? `${prefix}${newName}` : `${prefix}${newName}${knownExt(node.path)}`
    if (newRel === node.path) return
    const affected = affectedTabIds(node.path, isFolder)
    try {
      if (isFolder) await fp().renameFolder(joinPath(root, node.path), joinPath(root, newRel))
      else await fp().renameRequest(joinPath(root, node.path), joinPath(root, newRel))
      for (const id of affected) dispatch({ type: 'close-tab', id })
      await loadCollection(root)
      if (!isFolder && affected.includes(node.path)) {
        openPath(newRel, node.type as 'request' | 'workflow', node.kind)
      }
    } catch (e) {
      setNotice(errMsg(e))
    }
  }

  /** Copy a request/workflow file to a sibling with a new name. */
  async function duplicateNode(node: TreeNode, newName: string): Promise<void> {
    const root = state.root
    if (root === null) return
    if (INVALID_NAME.test(newName)) {
      setNotice(INVALID)
      return
    }
    const parent = parentDir(node.path)
    const prefix = parent === '.' ? '' : `${parent}/`
    const newRel = `${prefix}${newName}${knownExt(node.path)}`
    try {
      await fp().duplicateRequest(joinPath(root, node.path), joinPath(root, newRel))
      await loadCollection(root)
      openPath(newRel, node.type as 'request' | 'workflow', node.kind)
    } catch (e) {
      setNotice(errMsg(e))
    }
  }

  /** Move a request/workflow file or a folder into `destFolder` (keeps its name). */
  async function moveNode(node: TreeNode, destFolder: string): Promise<void> {
    const root = state.root
    if (root === null) return
    const isFolder = node.type === 'folder'
    const destPrefix = destFolder === '.' ? '' : `${destFolder}/`
    const newRel = `${destPrefix}${baseName(node.path)}`
    if (newRel === node.path) return
    const affected = affectedTabIds(node.path, isFolder)
    try {
      if (isFolder) await fp().renameFolder(joinPath(root, node.path), joinPath(root, newRel))
      else await fp().renameRequest(joinPath(root, node.path), joinPath(root, newRel))
      for (const id of affected) dispatch({ type: 'close-tab', id })
      await loadCollection(root)
      if (!isFolder && affected.includes(node.path)) {
        openPath(newRel, node.type as 'request' | 'workflow', node.kind)
      }
    } catch (e) {
      setNotice(errMsg(e))
    }
  }

  async function deleteNode(node: TreeNode): Promise<void> {
    const root = state.root
    if (root === null) return
    const isFolder = node.type === 'folder'
    const affected = affectedTabIds(node.path, isFolder)
    try {
      if (isFolder) await fp().deleteFolder(joinPath(root, node.path))
      else await fp().deleteRequest(joinPath(root, node.path))
      for (const id of affected) dispatch({ type: 'close-tab', id })
      await loadCollection(root)
    } catch (e) {
      setNotice(errMsg(e))
    }
  }

  return (
    <div className="app">
      <TopBar
        root={state.root}
        notice={notice}
        onDismissNotice={() => setNotice(null)}
        onImport={() => setModal({ kind: 'import' })}
        onHistory={() => setModal({ kind: 'history' })}
        onMock={() => setModal({ kind: 'mock' })}
      />
      <div className="app-body">
        <Sidebar
          root={state.root}
          tree={state.tree}
          envs={state.envs}
          envPath={state.envPath}
          methods={state.methods}
          sessionOpen={state.sessionOpen}
          onOpenCollection={() => void handleOpenCollection()}
          onOpenNode={openNode}
          onOpenEntry={openEntry}
          onNewItem={(folder, kind) => setModal({ kind: 'new-item', folder, itemKind: kind })}
          onTreeAction={handleTreeAction}
          onEnvChange={(envPath) => dispatch({ type: 'set-env', envPath })}
          onToggleSession={() => dispatch({ type: 'toggle-session' })}
          onManageEnvs={() => setModal({ kind: 'env-manager' })}
        />
        <main className="main-area">
          {state.tabs.length > 0 && (
            <TabBar
              tabs={state.tabs}
              activeId={state.activeTabId}
              onActivate={(id) => dispatch({ type: 'activate-tab', id })}
              onClose={requestCloseTab}
            />
          )}
          <div className="tab-panes">
            {state.tabs.length === 0 && (
              <div className="empty-main">
                <div className="empty-title">freepost</div>
                <div className="empty-sub">
                  {state.root === null
                    ? 'Open a collection folder to get started.'
                    : 'Select a request, websocket, or workflow from the sidebar.'}
                </div>
              </div>
            )}
            {state.root !== null &&
              state.tabs.map((tab) => (
                <div
                  key={tab.id}
                  className={'tab-pane' + (tab.id === state.activeTabId ? '' : ' tab-pane-hidden')}
                >
                  {tab.type === 'request' && (
                    <RequestTab
                      ref={(h) => setTabHandle(tab.id, h)}
                      root={state.root as string}
                      relPath={tab.path}
                      envPath={state.envPath}
                      onDirty={(dirty) => dispatch({ type: 'set-dirty', id: tab.id, dirty })}
                      onMethod={(m) =>
                        dispatch({ type: 'set-methods', methods: { [tab.path]: m } })
                      }
                    />
                  )}
                  {tab.type === 'websocket' && (
                    <WebSocketTab
                      root={state.root as string}
                      relPath={tab.path}
                      envPath={state.envPath}
                    />
                  )}
                  {tab.type === 'workflow' && (
                    <WorkflowTab
                      ref={(h) => setTabHandle(tab.id, h)}
                      root={state.root as string}
                      relPath={tab.path}
                      envPath={state.envPath}
                      onDirty={(dirty) => dispatch({ type: 'set-dirty', id: tab.id, dirty })}
                    />
                  )}
                  {tab.type === 'grpc' && (
                    <GrpcTab
                      ref={(h) => setTabHandle(tab.id, h)}
                      root={state.root as string}
                      relPath={tab.path}
                      envPath={state.envPath}
                      onDirty={(dirty) => dispatch({ type: 'set-dirty', id: tab.id, dirty })}
                    />
                  )}
                  {tab.type === 'mqtt' && (
                    <MqttTab
                      ref={(h) => setTabHandle(tab.id, h)}
                      root={state.root as string}
                      relPath={tab.path}
                      envPath={state.envPath}
                      onDirty={(dirty) => dispatch({ type: 'set-dirty', id: tab.id, dirty })}
                    />
                  )}
                  {tab.type === 'mcp' && (
                    <McpTab
                      ref={(h) => setTabHandle(tab.id, h)}
                      root={state.root as string}
                      relPath={tab.path}
                      envPath={state.envPath}
                      onDirty={(dirty) => dispatch({ type: 'set-dirty', id: tab.id, dirty })}
                    />
                  )}
                </div>
              ))}
          </div>
        </main>
      </div>

      {modal?.kind === 'import' && state.root !== null && (
        <ImportModal
          root={state.root}
          onDone={(message) => {
            setModal(null)
            setNotice(message)
            void loadCollection(state.root as string).catch((e) => setNotice(errMsg(e)))
          }}
          onError={(message) => setNotice(message)}
          onCancel={() => setModal(null)}
        />
      )}
      {modal?.kind === 'history' && state.root !== null && (
        <HistoryPanel
          root={state.root}
          onOpen={(path) => {
            setModal(null)
            openPath(path, 'request')
          }}
          onCancel={() => setModal(null)}
        />
      )}
      {modal?.kind === 'mock' && state.root !== null && (
        <MockServerModal root={state.root} onCancel={() => setModal(null)} />
      )}
      {modal?.kind === 'env-manager' && state.root !== null && (
        <EnvironmentManager
          root={state.root}
          envs={state.envs}
          activeEnvPath={state.envPath}
          onSelectEnv={(p) => dispatch({ type: 'set-env', envPath: p })}
          onChanged={() => {
            void refreshEnvs()
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === 'new-item' && (
        <PromptModal
          title={
            modal.itemKind === 'curl'
              ? 'New Request'
              : modal.itemKind === 'websocat'
                ? 'New WebSocket'
                : modal.itemKind === 'grpc'
                  ? 'New gRPC'
                  : modal.itemKind === 'mqtt'
                    ? 'New MQTT'
                    : modal.itemKind === 'mcp'
                      ? 'New MCP'
                      : 'New Workflow'
          }
          label={`Name (becomes the filename${modal.folder !== '' && modal.folder !== '.' ? ` in ${modal.folder}` : ''})`}
          placeholder={modal.itemKind === 'workflow' ? 'Signup smoke test' : 'Get user by id'}
          submitText="Create"
          onSubmit={(name) => {
            const m = modal
            setModal(null)
            void createItem(m.folder, m.itemKind, name)
          }}
          onCancel={() => setModal(null)}
        />
      )}
      {modal?.kind === 'new-folder' && (
        <PromptModal
          title="New Folder"
          label={`Folder name${modal.parent !== '' && modal.parent !== '.' ? ` (in ${modal.parent})` : ''}`}
          placeholder="auth"
          submitText="Create"
          onSubmit={(name) => {
            const parent = modal.parent
            setModal(null)
            void createFolder(parent, name)
          }}
          onCancel={() => setModal(null)}
        />
      )}
      {modal?.kind === 'rename' && (
        <PromptModal
          title={modal.node.type === 'folder' ? 'Rename Folder' : 'Rename'}
          label="New name"
          initial={modal.node.type === 'folder' ? modal.node.name : displayName(modal.node.path)}
          submitText="Rename"
          onSubmit={(name) => {
            const node = modal.node
            setModal(null)
            void renameNode(node, name)
          }}
          onCancel={() => setModal(null)}
        />
      )}
      {modal?.kind === 'duplicate' && (
        <PromptModal
          title="Duplicate"
          label="Name for the copy"
          initial={`${displayName(modal.node.path)} copy`}
          submitText="Duplicate"
          onSubmit={(name) => {
            const node = modal.node
            setModal(null)
            void duplicateNode(node, name)
          }}
          onCancel={() => setModal(null)}
        />
      )}
      {modal?.kind === 'move' && state.tree !== null && (
        <MoveModal
          tree={state.tree}
          node={modal.node}
          displayName={
            modal.node.type === 'folder' ? modal.node.name : displayName(modal.node.path)
          }
          onSubmit={(dest) => {
            const node = modal.node
            setModal(null)
            void moveNode(node, dest)
          }}
          onCancel={() => setModal(null)}
        />
      )}
      {modal?.kind === 'delete' &&
        (() => {
          const node = modal.node
          const isFolder = node.type === 'folder'
          const label = isFolder ? node.name : displayName(node.path)
          return (
            <ConfirmModal
              title={isFolder ? 'Delete folder' : 'Delete'}
              message={
                isFolder
                  ? `Delete the folder “${label}” and everything inside it? This cannot be undone.`
                  : `Delete “${label}”? This cannot be undone.`
              }
              confirmText="Delete"
              danger
              onConfirm={() => {
                setModal(null)
                void deleteNode(node)
              }}
              onCancel={() => setModal(null)}
            />
          )
        })()}
      {modal?.kind === 'close-tab' &&
        (() => {
          const id = modal.id
          const name = state.tabs.find((t) => t.id === id)?.name ?? 'this tab'
          return (
            <ConfirmModal
              title="Unsaved changes"
              message={`"${name}" has unsaved changes. Save before closing?`}
              confirmText="Save"
              discardText="Don't Save"
              busy={saving}
              onConfirm={() =>
                void (async () => {
                  setSaving(true)
                  const handle = tabHandles.current.get(id)
                  const ok = handle ? await handle.save() : true
                  setSaving(false)
                  setModal(null)
                  if (ok) dispatch({ type: 'close-tab', id })
                  else setNotice(`Could not save "${name}" — fix the error in the tab and retry.`)
                })()
              }
              onDiscard={() => {
                setModal(null)
                dispatch({ type: 'close-tab', id })
              }}
              onCancel={() => setModal(null)}
            />
          )
        })()}
      {modal?.kind === 'quit' &&
        (() => {
          const count = state.tabs.filter((t) => t.dirty).length
          return (
            <ConfirmModal
              title="Unsaved changes"
              message={`You have unsaved changes in ${count} ${count === 1 ? 'tab' : 'tabs'}. Save before quitting?`}
              confirmText="Save All"
              discardText="Discard"
              busy={saving}
              onConfirm={() =>
                void (async () => {
                  setSaving(true)
                  const ok = await saveDirtyTabs()
                  setSaving(false)
                  setModal(null)
                  if (ok) await fp().confirmAppClose()
                  else setNotice('Some tabs could not be saved — fix the errors and try again.')
                })()
              }
              onDiscard={() => {
                setModal(null)
                void fp().confirmAppClose()
              }}
              onCancel={() => setModal(null)}
            />
          )
        })()}
    </div>
  )
}
