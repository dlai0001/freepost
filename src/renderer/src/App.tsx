import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { RequestKind, SearchEntry, TreeNode } from '../../shared/model'
import { errMsg, fp, hasApi } from './api'
import { initialState, reducer, type Tab, type TabType } from './state'
import { displayName, INVALID_NAME, joinPath } from './util'
import TopBar from './components/TopBar'
import Sidebar from './components/Sidebar'
import TabBar from './components/TabBar'
import RequestTab from './components/RequestTab'
import WebSocketTab from './components/WebSocketTab'
import WorkflowTab from './components/WorkflowTab'
import PromptModal from './components/PromptModal'
import type { NewItemKind } from './components/Tree'

type ModalSpec =
  | { kind: 'import' }
  | { kind: 'new-item'; folder: string; itemKind: NewItemKind }

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

  const rootRef = useRef<string | null>(null)
  rootRef.current = state.root

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
  }, [])

  const loadRef = useRef(loadCollection)
  loadRef.current = loadCollection

  useEffect(() => {
    return fp().onCollectionChanged((root) => {
      if (rootRef.current !== null && root === rootRef.current) {
        void loadRef.current(root).catch((e) => setNotice(errMsg(e)))
      }
    })
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
    const ext = itemKind === 'curl' ? '.curl' : itemKind === 'websocat' ? '.ws' : '.workflow.json'
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

  async function doImport(collectionJsonPath: string): Promise<void> {
    const root = state.root
    if (root === null) return
    try {
      const { written } = await fp().importPostman({ root, collectionJsonPath })
      setNotice(`Imported ${written.length} file${written.length === 1 ? '' : 's'}`)
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
          onEnvChange={(envPath) => dispatch({ type: 'set-env', envPath })}
          onToggleSession={() => dispatch({ type: 'toggle-session' })}
        />
        <main className="main-area">
          {state.tabs.length > 0 && (
            <TabBar
              tabs={state.tabs}
              activeId={state.activeTabId}
              onActivate={(id) => dispatch({ type: 'activate-tab', id })}
              onClose={(id) => dispatch({ type: 'close-tab', id })}
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

      {modal?.kind === 'import' && (
        <PromptModal
          title="Import Postman collection"
          label="Path to the exported collection .json file"
          placeholder="/path/to/collection.postman_collection.json"
          submitText="Import"
          onSubmit={(p) => {
            setModal(null)
            void doImport(p)
          }}
          onCancel={() => setModal(null)}
        />
      )}
      {modal?.kind === 'new-item' && (
        <PromptModal
          title={
            modal.itemKind === 'curl'
              ? 'New Request'
              : modal.itemKind === 'websocat'
                ? 'New WebSocket'
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
    </div>
  )
}
