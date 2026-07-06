/**
 * IPC channel names and payload shapes between renderer and main.
 * The preload script exposes these as window.freepost.*
 */
import type {
  AcquiredToken,
  CodegenTarget,
  CodegenTargetInfo,
  ExecutionReport,
  GqlIntrospectResult,
  HistoryEntry,
  ParseResult,
  RequestFile,
  SavedExample,
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
  importCommand: 'import:command', // ({ root, text, name? }) => { written: string[] } — pasted curl/websocat/wscat
  importOpenApi: 'import:openapi', // ({ root, path }) => { written: string[] } — OpenAPI/Swagger

  codegenTargets: 'codegen:targets', // () => CodegenTargetInfo[]
  codegenGenerate: 'codegen:generate', // ({ root, path, target, envPath?, resolve? }) => { code: string }

  historyList: 'history:list', // (root) => HistoryEntry[]
  historyClear: 'history:clear', // (root) => void

  exampleSave: 'example:save', // ({ root, path, name }) => void — snapshots last response
  exampleList: 'example:list', // ({ root, path }) => SavedExample[]
  exampleDelete: 'example:delete', // ({ root, path, name }) => void

  oauthAcquire: 'oauth:acquire', // ({ root, path, envPath? }) => AcquiredToken (stores in session)

  gqlIntrospect: 'gql:introspect', // ({ root, path, envPath? }) => { schema: GqlSchemaSummary } | { error }

  browseDataFile: 'data:browse' // () => string | null (native file picker for CSV/JSON)
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
  /** Import an OpenAPI 3.x / Swagger 2.0 document (JSON or YAML). */
  importOpenApi(args: { root: string; path: string }): Promise<{ written: string[] }>

  codegenTargets(): Promise<CodegenTargetInfo[]>
  generateCode(args: {
    root: string
    path: string
    target: CodegenTarget
    envPath?: string
    resolve?: boolean
  }): Promise<{ code: string }>

  listHistory(root: string): Promise<HistoryEntry[]>
  clearHistory(root: string): Promise<void>

  saveExample(args: { root: string; path: string; name: string }): Promise<void>
  listExamples(args: { root: string; path: string }): Promise<SavedExample[]>
  deleteExample(args: { root: string; path: string; name: string }): Promise<void>

  /** Acquire an OAuth2 token for the request and store it in the session. */
  acquireOAuthToken(args: { root: string; path: string; envPath?: string }): Promise<AcquiredToken>

  /** Run a GraphQL introspection query for schema hints. */
  introspectGraphql(args: { root: string; path: string; envPath?: string }): Promise<GqlIntrospectResult>

  /** Native file picker for a CSV/JSON data file; returns the chosen path or null. */
  browseDataFile(): Promise<string | null>
}
