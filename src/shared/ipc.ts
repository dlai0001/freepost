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
  OpenApiOperationSummary,
  ParseCommandResult,
  ParseResult,
  RequestFile,
  RequestKind,
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
  collectionLast: 'collection:last-root', // () => string | null (last-opened root, if still present)
  collectionSecurityCheck: 'collection:security-check', // (root) => string[] (git-tracked .freepost/ paths)

  requestRead: 'request:read', // (absPath) => { raw: string; parsed: ParseResult }
  requestWrite: 'request:write', // (absPath, file: RequestFile) => { raw: string }
  requestFormat: 'request:format', // (file: RequestFile) => { raw: string } — serialize model to canonical text, no write
  commandParse: 'command:parse', // ({ text, strict?, kind? }) => ParseCommandResult — parse text to model, no write
  requestCreate: 'request:create', // (absPath, kind) => void
  requestRename: 'request:rename', // (absPath, newAbsPath) => void  (auto-heals workflow refs)
  requestDelete: 'request:delete', // (absPath) => void
  requestExecute: 'request:execute', // ({ root, path, envPath?, model? }) => ExecutionReport (model runs unsaved editor state)

  envList: 'env:list', // (root) => string[]
  envRead: 'env:read', // (absPath) => Record<string,string>
  envCreate: 'env:create', // ({ root, name, local }) => string (new collection-relative path)
  envWrite: 'env:write', // ({ root, path, values }) => void
  envDelete: 'env:delete', // ({ root, path }) => void
  envRename: 'env:rename', // ({ root, path, newName }) => string (new rel path)
  envDuplicate: 'env:duplicate', // ({ root, path, newName }) => string (new rel path)

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
  fileBrowse: 'file:browse', // ({ title?, filters? }) => string | null (generic native file picker)
  importFile: 'import:file', // ({ root, path, name? }) => { written: string[] } — Postman JSON or shell script
  importCommand: 'import:command', // ({ root, text, name? }) => { written: string[] } — pasted curl/websocat/wscat
  importOpenApi: 'import:openapi', // ({ root, path }) => { written: string[] } — OpenAPI/Swagger
  importOpenApiListUrl: 'import:openapi-list-url', // ({ url }) => { ok, operations, version, specText } | { ok:false, error } — fetch + list, no writes
  importOpenApiApplyUrl: 'import:openapi-apply-url', // ({ root, specText, selectedIds, folderPrefix? }) => { written: string[] }

  codegenTargets: 'codegen:targets', // () => CodegenTargetInfo[]
  codegenGenerate: 'codegen:generate', // ({ root, path, target, envPath?, resolve? }) => { code: string }

  historyList: 'history:list', // (root) => HistoryEntry[]
  historyClear: 'history:clear', // (root) => void

  exampleSave: 'example:save', // ({ root, path, name }) => void — snapshots last response
  exampleList: 'example:list', // ({ root, path }) => SavedExample[]
  exampleDelete: 'example:delete', // ({ root, path, name }) => void

  oauthAcquire: 'oauth:acquire', // ({ root, path, envPath? }) => AcquiredToken (stores in session)

  gqlIntrospect: 'gql:introspect', // ({ root, path, envPath? }) => { schema: GqlSchemaSummary } | { error }
  gqlSubscribe: 'gql:subscribe', // ({ root, path, envPath?, query, variables?, url?, transport? }) => { id }
  gqlUnsubscribe: 'gql:unsubscribe', // (id) => void
  gqlSubEvent: 'gql:subEvent', // main -> renderer event ({ id, type: 'next'|'error'|'complete', data? })

  browseDataFile: 'data:browse', // () => string | null (native file picker for CSV/JSON)

  appBeforeClose: 'app:before-close', // main -> renderer event: window close requested; renderer decides
  appCloseConfirmed: 'app:close-confirmed' // renderer -> main: proceed with closing the window
} as const

/** Surface exposed on window.freepost by the preload script. */
export interface FreepostApi {
  openCollection(): Promise<string | null>
  scanCollection(root: string): Promise<TreeNode>
  onCollectionChanged(cb: (root: string) => void): () => void
  /** The last-opened collection root, if one is remembered and still exists. */
  lastCollection(): Promise<string | null>
  /** Paths under `.freepost/` that git is tracking (should be empty); for a leak warning. */
  checkCollectionSecurity(root: string): Promise<string[]>

  readRequest(absPath: string): Promise<{ raw: string; parsed: ParseResult }>
  writeRequest(absPath: string, file: RequestFile): Promise<{ raw: string }>
  /** Serialize a request model to canonical curl/websocat text without writing to disk. */
  formatRequest(file: RequestFile): Promise<{ raw: string }>
  /**
   * Parse free text into a request model without writing to disk. `strict`
   * (with `kind`) uses the canonical-file parser and reports parse errors;
   * lenient (default) accepts a loose pasted curl/websocat/wscat command,
   * dropping unknown flags into `frontmatter['import-note']`.
   */
  parseCommand(args: {
    text: string
    strict?: boolean
    kind?: RequestKind
  }): Promise<ParseCommandResult>
  createRequest(absPath: string, kind: 'curl' | 'websocat'): Promise<void>
  renameRequest(absPath: string, newAbsPath: string): Promise<void>
  deleteRequest(absPath: string): Promise<void>
  executeRequest(args: {
    root: string
    path: string
    envPath?: string
    /** Unsaved editor state to execute in place of the on-disk file. */
    model?: RequestFile
  }): Promise<ExecutionReport>

  listEnvs(root: string): Promise<string[]>
  readEnv(absPath: string): Promise<Record<string, string>>
  createEnv(args: { root: string; name: string; local: boolean }): Promise<string>
  writeEnv(args: { root: string; path: string; values: Record<string, string> }): Promise<void>
  deleteEnv(args: { root: string; path: string }): Promise<void>
  renameEnv(args: { root: string; path: string; newName: string }): Promise<string>
  duplicateEnv(args: { root: string; path: string; newName: string }): Promise<string>

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
  /** Generic native file picker; returns the chosen path or null. */
  browseFile(args?: {
    title?: string
    filters?: { name: string; extensions: string[] }[]
  }): Promise<string | null>
  /** Import a file: Postman collection JSON, or any shell script containing a curl/websocat/wscat command. */
  importFile(args: { root: string; path: string; name?: string }): Promise<{ written: string[] }>
  /** Import a pasted curl/websocat/wscat command as a new request file. */
  importCommand(args: { root: string; text: string; name?: string }): Promise<{ written: string[] }>
  /** Import an OpenAPI 3.x / Swagger 2.0 document (JSON or YAML). */
  importOpenApi(args: { root: string; path: string }): Promise<{ written: string[] }>
  /** Fetch an OpenAPI/Swagger document from a URL and list its operations, without writing anything. */
  listOpenApiFromUrl(args: { url: string }): Promise<
    | { ok: true; operations: OpenApiOperationSummary[]; version: string; specText: string }
    | { ok: false; error: string }
  >
  /**
   * Write only the selected operations from a previously-fetched spec (see
   * `listOpenApiFromUrl`) as new request files. `folderPrefix`, if given, is
   * prepended as an extra leading folder segment (sanitized against path
   * traversal); omitted, each operation lands in its own tag/path-derived
   * folder at the collection root.
   */
  importOpenApiFromUrl(args: {
    root: string
    specText: string
    selectedIds: string[]
    folderPrefix?: string
  }): Promise<{ written: string[] }>

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

  /**
   * Run a GraphQL introspection query for schema hints. `schemaUrl` overrides
   * the request's saved endpoint (for live editing before save); ${VAR}
   * references in it are resolved against the request's variables.
   */
  introspectGraphql(args: {
    root: string
    path: string
    envPath?: string
    schemaUrl?: string
  }): Promise<GqlIntrospectResult>

  /**
   * Start a GraphQL subscription over WebSocket (graphql-transport-ws) or SSE.
   * `query`/`variables` are the live editor state (so unsaved edits run). `url`
   * overrides the endpoint; when unset it derives from the graphql
   * subscriptionUrl/schemaUrl or the request URL. Streams via `onGqlSubEvent`.
   */
  subscribeGraphql(args: {
    root: string
    path: string
    envPath?: string
    query: string
    variables?: Record<string, unknown>
    url?: string
    transport?: 'ws' | 'sse'
  }): Promise<{ id: string }>
  unsubscribeGraphql(id: string): Promise<void>
  onGqlSubEvent(
    cb: (e: { id: string; type: 'next' | 'error' | 'complete'; data?: string }) => void
  ): () => void

  /** Native file picker for a CSV/JSON data file; returns the chosen path or null. */
  browseDataFile(): Promise<string | null>

  /** Fires when the user tries to close the window; the renderer prompts to save. */
  onAppBeforeClose(cb: () => void): () => void
  /** Tell main it's safe to close the window (after handling unsaved changes). */
  confirmAppClose(): Promise<void>
}
