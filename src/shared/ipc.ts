/**
 * IPC channel names and payload shapes between renderer and main.
 * The preload script exposes these as window.freepost.*
 */
import type {
  ExecutionReport,
  ParseResult,
  RequestFile,
  SearchEntry,
  TreeNode,
  WorkflowRunReport,
  WorkflowValidationIssue
} from './model'

export const IPC = {
  collectionOpen: 'collection:open', // () => string | null (chosen root, via dialog)
  collectionScan: 'collection:scan', // (root) => TreeNode
  collectionChanged: 'collection:changed', // main -> renderer event (root)

  requestRead: 'request:read', // (absPath) => { raw: string; parsed: ParseResult }
  requestWrite: 'request:write', // (absPath, file: RequestFile) => { raw: string }
  requestCreate: 'request:create', // (absPath, kind) => void
  requestRename: 'request:rename', // (absPath, newAbsPath) => void  (auto-heals workflow refs)
  requestDelete: 'request:delete', // (absPath) => void
  requestExecute: 'request:execute', // ({ root, path, envPath? }) => ExecutionReport

  envList: 'env:list', // (root) => string[]
  envRead: 'env:read', // (absPath) => Record<string,string>

  sessionGet: 'session:get', // () => Record<string,string>
  sessionSet: 'session:set', // (name, value) => void
  sessionClear: 'session:clear', // () => void

  searchQuery: 'search:query', // ({ root, query }) => SearchEntry[]

  workflowRead: 'workflow:read', // (absPath) => WorkflowFile
  workflowWrite: 'workflow:write', // (absPath, wf) => void
  workflowValidate: 'workflow:validate', // ({ root, path }) => WorkflowValidationIssue[]
  workflowRun: 'workflow:run', // ({ root, path, envPath? }) => WorkflowRunReport
  workflowProgress: 'workflow:progress', // main -> renderer event (WorkflowStepResult)

  wsConnect: 'ws:connect', // ({ root, path, envPath? }) => { id }
  wsSend: 'ws:send', // (id, text) => void
  wsClose: 'ws:close', // (id) => void
  wsEvent: 'ws:event', // main -> renderer event ({ id, type: 'open'|'message'|'close'|'error', data? })

  importPostman: 'import:postman', // ({ root, collectionJsonPath }) => { written: string[] }
  importBrowse: 'import:browse', // () => string | null (native file picker)
  importFile: 'import:file', // ({ root, path, name? }) => { written: string[] } — Postman JSON or shell script
  importCommand: 'import:command' // ({ root, text, name? }) => { written: string[] } — pasted curl/websocat/wscat
} as const

/** Surface exposed on window.freepost by the preload script. */
export interface FreepostApi {
  openCollection(): Promise<string | null>
  scanCollection(root: string): Promise<TreeNode>
  onCollectionChanged(cb: (root: string) => void): () => void

  readRequest(absPath: string): Promise<{ raw: string; parsed: ParseResult }>
  writeRequest(absPath: string, file: RequestFile): Promise<{ raw: string }>
  createRequest(absPath: string, kind: 'curl' | 'websocat'): Promise<void>
  renameRequest(absPath: string, newAbsPath: string): Promise<void>
  deleteRequest(absPath: string): Promise<void>
  executeRequest(args: { root: string; path: string; envPath?: string }): Promise<ExecutionReport>

  listEnvs(root: string): Promise<string[]>
  readEnv(absPath: string): Promise<Record<string, string>>

  getSession(): Promise<Record<string, string>>
  setSessionVar(name: string, value: string): Promise<void>
  clearSession(): Promise<void>

  search(args: { root: string; query: string }): Promise<SearchEntry[]>

  readWorkflow(absPath: string): Promise<import('./model').WorkflowFile>
  writeWorkflow(absPath: string, wf: import('./model').WorkflowFile): Promise<void>
  validateWorkflow(args: { root: string; path: string }): Promise<WorkflowValidationIssue[]>
  runWorkflow(args: { root: string; path: string; envPath?: string }): Promise<WorkflowRunReport>
  onWorkflowProgress(cb: (r: import('./model').WorkflowStepResult) => void): () => void

  wsConnect(args: { root: string; path: string; envPath?: string }): Promise<{ id: string }>
  wsSend(id: string, text: string): Promise<void>
  wsClose(id: string): Promise<void>
  onWsEvent(
    cb: (e: { id: string; type: 'open' | 'message' | 'close' | 'error'; data?: string }) => void
  ): () => void

  importPostman(args: { root: string; collectionJsonPath: string }): Promise<{ written: string[] }>
  /** Native file picker for import; returns the chosen path or null. */
  browseImportFile(): Promise<string | null>
  /** Import a file: Postman collection JSON, or any shell script containing a curl/websocat/wscat command. */
  importFile(args: { root: string; path: string; name?: string }): Promise<{ written: string[] }>
  /** Import a pasted curl/websocat/wscat command as a new request file. */
  importCommand(args: { root: string; text: string; name?: string }): Promise<{ written: string[] }>
}
