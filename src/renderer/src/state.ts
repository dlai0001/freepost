/** App-shell state: collection, environments, tabs. Per-tab editor state lives
 *  in the tab components themselves (they stay mounted while open). */
import type { TreeNode } from '../../shared/model'

export type TabType = 'request' | 'websocket' | 'workflow' | 'grpc' | 'mqtt'

/** Imperative handle a tab component exposes so the shell can save it on close. */
export interface TabHandle {
  /** Persist unsaved edits. Resolves true on success (or if nothing to save). */
  save(): Promise<boolean>
}

export interface Tab {
  /** Collection-relative path doubles as the tab id. */
  id: string
  path: string
  name: string
  type: TabType
  dirty: boolean
}

export interface AppState {
  root: string | null
  tree: TreeNode | null
  envs: string[]
  envPath: string | null
  tabs: Tab[]
  activeTabId: string | null
  sessionOpen: boolean
  /** path -> HTTP method, for tree badges (primed from the search index). */
  methods: Record<string, string>
}

export const initialState: AppState = {
  root: null,
  tree: null,
  envs: [],
  envPath: null,
  tabs: [],
  activeTabId: null,
  sessionOpen: false,
  methods: {}
}

export type AppAction =
  | { type: 'collection-loaded'; root: string; tree: TreeNode }
  | { type: 'set-envs'; envs: string[] }
  | { type: 'set-env'; envPath: string | null }
  | { type: 'set-methods'; methods: Record<string, string> }
  | { type: 'open-tab'; tab: Tab }
  | { type: 'close-tab'; id: string }
  | { type: 'activate-tab'; id: string }
  | { type: 'set-dirty'; id: string; dirty: boolean }
  | { type: 'toggle-session' }

export function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'collection-loaded': {
      const changedRoot = state.root !== null && state.root !== action.root
      return {
        ...state,
        root: action.root,
        tree: action.tree,
        // Opening a different collection closes tabs from the old one.
        tabs: changedRoot ? [] : state.tabs,
        activeTabId: changedRoot ? null : state.activeTabId,
        envPath: changedRoot ? null : state.envPath
      }
    }
    case 'set-envs': {
      const envPath =
        state.envPath !== null && action.envs.includes(state.envPath) ? state.envPath : null
      return { ...state, envs: action.envs, envPath }
    }
    case 'set-env':
      return { ...state, envPath: action.envPath }
    case 'set-methods':
      return { ...state, methods: { ...state.methods, ...action.methods } }
    case 'open-tab': {
      const existing = state.tabs.find((t) => t.id === action.tab.id)
      if (existing) return { ...state, activeTabId: existing.id }
      return { ...state, tabs: [...state.tabs, action.tab], activeTabId: action.tab.id }
    }
    case 'close-tab': {
      const idx = state.tabs.findIndex((t) => t.id === action.id)
      if (idx < 0) return state
      const tabs = state.tabs.filter((t) => t.id !== action.id)
      let activeTabId = state.activeTabId
      if (activeTabId === action.id) {
        const neighbor = tabs[Math.min(idx, tabs.length - 1)]
        activeTabId = neighbor ? neighbor.id : null
      }
      return { ...state, tabs, activeTabId }
    }
    case 'activate-tab':
      return { ...state, activeTabId: action.id }
    case 'set-dirty':
      return {
        ...state,
        tabs: state.tabs.map((t) => (t.id === action.id ? { ...t, dirty: action.dirty } : t))
      }
    case 'toggle-session':
      return { ...state, sessionOpen: !state.sessionOpen }
    default:
      return state
  }
}
