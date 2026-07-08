/**
 * Shared data model — the contract between core modules, the engine, the main
 * process, and the renderer. See PLAN.md for the format specification.
 */

/** Request file type, discriminated by extension: .curl | .ws */
export type RequestKind = 'curl' | 'websocat'

/** Optional per-variable metadata carried in frontmatter `variables`. */
export interface VariableMeta {
  secret?: boolean
  description?: string
}

/** One typed row of the GraphQL variables table. */
export interface GqlVariableDef {
  name: string
  /** GraphQL type annotation, e.g. "ID!", "Int", "[String]". Empty = untyped. */
  type: string
  /** The value as a JSON-encoded string; parsed into the `variables` object. */
  value: string
}

/** GraphQL body definition stored in frontmatter. */
export interface GraphqlBody {
  query: string
  /** Derived JSON object sent as the payload's `variables` (from variableDefs). */
  variables?: Record<string, unknown>
  /** Endpoint used for introspection; falls back to the request URL when unset. */
  schemaUrl?: string
  /** Typed variable rows (editor source of truth); `variables` is derived from these. */
  variableDefs?: GqlVariableDef[]
}

/** How a multipart form field supplies its value. */
export type FormFieldType = 'text' | 'file' | 'json'

/** One part of a multipart/form-data body. */
export interface FormField {
  name: string
  type: FormFieldType
  /** text: the literal value. file: the source path (relative to the request dir). */
  value?: string
  /** json/file: the filename sent in the part's Content-Disposition. */
  filename?: string
  /** json: the inline JSON payload (source of truth; sent verbatim as the part body). */
  content?: string
}

/**
 * YAML-in-comments frontmatter. Unknown keys MUST be preserved verbatim on
 * rewrite (PLAN.md rewrite contract).
 */
export interface Frontmatter {
  description?: string
  label?: string[]
  seq?: number
  variables?: Record<string, VariableMeta | null>
  scripts?: { 'pre-request'?: string; test?: string }
  /** Unchecked-but-kept rows; absent from the executable command. */
  disabled?: { headers?: Record<string, string>; query?: Record<string, string> }
  /** GraphQL source of truth; the command's --data is generated from it. */
  graphql?: GraphqlBody
  /**
   * Multipart form source of truth; the command's --form flags are generated
   * from it and the executed body is assembled by the engine (json parts carry
   * their content inline here, so bare curl cannot reproduce them).
   */
  form?: FormField[]
  /** WebSocket saved message presets (websocat files only). */
  messages?: Record<string, string>
  /** OAuth2 config for this request (overrides inherited collection/folder auth). */
  auth?: OAuth2Config
  [key: string]: unknown
}

/** One entry of the shell assignment block. */
export interface VariableDecl {
  name: string
  /** From ${NAME:-default}. Undefined when required. */
  defaultValue?: string
  /** True for ${NAME:?}. */
  required: boolean
}

export interface Header {
  name: string
  value: string
}

/** Parsed curl command (supported-flag subset; see core/format/curl.ts). */
export interface HttpRequestModel {
  method: string
  /** May contain ${VAR} references. */
  url: string
  headers: Header[]
  body?: { kind: 'raw' | 'file'; value: string }
  /**
   * Parsed multipart fields (curl -F/--form). When frontmatter.form is present
   * it is canonical and the command's --form flags are regenerated from it
   * (mirrors the graphql/--data relationship).
   */
  form?: FormField[]
  options: {
    insecure?: boolean
    followRedirects?: boolean
    timeoutSeconds?: number
    /** --user for basic auth, "user:pass" (may contain ${VAR}). */
    user?: string
  }
}

/** Parsed websocat command. */
export interface WsRequestModel {
  url: string
  headers: Header[]
  protocol?: string
}

/** Standalone comment line in the body, preserved on rewrite. */
export interface BodyComment {
  /** Index of the statement (assignment or command) this comment precedes;
   *  statements are numbered in file order, command last. */
  beforeStatement: number
  /** Comment text without leading '#' or surrounding whitespace. */
  text: string
}

export interface RequestFile {
  kind: RequestKind
  frontmatter: Frontmatter
  /** Assignment block, in file order. */
  variables: VariableDecl[]
  /** Present when kind === 'curl'. */
  http?: HttpRequestModel
  /** Present when kind === 'websocat'. */
  ws?: WsRequestModel
  comments: BodyComment[]
}

export interface ParseError {
  line: number
  message: string
}

export type ParseResult =
  | { ok: true; file: RequestFile }
  | { ok: false; errors: ParseError[] }

/**
 * Result of parsing free text (a pasted command or an edited canonical file)
 * into a request model without touching disk. Carries `kind` so the caller can
 * repopulate the correct editor; lenient parses may drop unknown flags, which
 * are recorded in `file.frontmatter['import-note']`.
 */
export type ParseCommandResult =
  | { ok: true; kind: RequestKind; file: RequestFile }
  | { ok: false; errors: ParseError[] }

/* ------------------------------- workflows ------------------------------- */

export interface WorkflowStep {
  /** Collection-relative path to a .curl/.ws file. */
  request: string
  expectError?: boolean
}

export interface WorkflowFile {
  description?: string
  steps: WorkflowStep[]
  /** Optional data file (collection-relative CSV/JSON) for data-driven runs. */
  dataFile?: string
}

export type StepStatus =
  | 'passed'
  | 'expected-error'
  | 'unexpected-success' // expectError step that succeeded: warn, continue
  | 'failed'             // unexpected error: halt
  | 'skipped'            // after a halt

export interface WorkflowStepResult {
  request: string
  status: StepStatus
  response?: HttpResponseModel
  tests: TestResult[]
  errorMessage?: string
}

export interface WorkflowRunReport {
  workflow: string
  startedAt: string
  steps: WorkflowStepResult[]
  halted: boolean
  /** For data-driven runs: one iteration report per data row. */
  iterations?: WorkflowRunReport[]
}

/** A broken step reference found during validation. */
export interface WorkflowValidationIssue {
  stepIndex: number
  request: string
  reason: 'missing' | 'not-a-request'
}

/* ------------------------------- execution ------------------------------- */

export interface HttpResponseModel {
  status: number
  statusText: string
  headers: Header[]
  bodyText: string
  timeMs: number
  sizeBytes: number
}

export interface TestResult {
  name: string
  passed: boolean
  error?: string
}

/** Result of running a pre-request or test script in the sandbox. */
export interface ScriptOutcome {
  tests: TestResult[]
  consoleLines: string[]
  /** Uncaught script error, if any. */
  error?: string
  /** Variables the script wrote to the session. */
  sessionWrites: Record<string, string>
}

/** Full result of executing one request (resolve -> pre -> send -> test). */
export interface ExecutionReport {
  requestPath: string
  resolvedUrl: string
  /** The concrete request that was sent (post variable resolution). */
  resolvedRequest?: { method: string; url: string; headers: Header[]; body?: string }
  response?: HttpResponseModel
  preScript?: ScriptOutcome
  testScript?: ScriptOutcome
  /** Transport-level failure (DNS, refused, timeout...). */
  transportError?: string
  /** Missing required variables that blocked the send. */
  unresolved?: string[]
  /** errored = transport error || status >= 400 || any failed test. */
  errored: boolean
}

/* ------------------------------ collections ------------------------------ */

export interface TreeNode {
  name: string
  /** Collection-relative path. */
  path: string
  type: 'folder' | 'request' | 'workflow'
  kind?: RequestKind
  children?: TreeNode[]
}

/** Search index entry / result. */
export interface SearchEntry {
  path: string
  name: string
  type: 'request' | 'workflow'
  labels: string[]
  description?: string
  method?: string
  url?: string
}

/** Environment file: flat name -> value map (*.env.json). */
export type EnvFile = Record<string, string>

/* ---------------------------------- auth --------------------------------- */

export type OAuth2Grant = 'client_credentials' | 'password' | 'authorization_code'

/** OAuth2 config; stored in frontmatter `auth` or in collection/folder config. */
export interface OAuth2Config {
  grant: OAuth2Grant
  tokenUrl: string
  /** authorization_code only. */
  authUrl?: string
  clientId: string
  clientSecret?: string
  scope?: string
  /** password grant. */
  username?: string
  password?: string
  /** authorization_code: the redirect URI registered with the provider. */
  redirectUri?: string
  /** Where to put the acquired token; default: header "Authorization: Bearer". */
  tokenName?: string
  /** Session variable name to store the acquired access token in. Default: OAUTH_TOKEN. */
  sessionVar?: string
}

export interface AcquiredToken {
  accessToken: string
  tokenType: string
  /** Epoch millis when the token expires, if the provider returned expires_in. */
  expiresAt?: number
  refreshToken?: string
  scope?: string
}

/* ---------------------------- collection config -------------------------- */

/**
 * collection.json / folder.json sidecar. Provides defaults inherited by every
 * request under that folder (collection.json = collection root). See PLAN.md.
 */
export interface CollectionConfig {
  /** Headers merged into every request (request's own headers win by name). */
  defaultHeaders?: Header[]
  /** OAuth2 config inherited by requests lacking their own. */
  auth?: OAuth2Config
  /** Scripts wrapping every request under this folder/collection. */
  scripts?: { 'pre-request'?: string; test?: string }
  /** Collection-relative paths to a client certificate / key for mTLS. */
  clientCert?: string
  clientKey?: string
  clientKeyPassphrase?: string
  /** HTTP/HTTPS proxy URL (e.g. http://user:pass@proxy.corp:8080) for requests under this scope. */
  proxy?: string
  /** Extra CA certificate to trust: PEM contents or a collection-relative path (corporate MITM CAs). */
  caCert?: string
}

/** Resolved (merged) config applied to a single request at execution time. */
export interface ResolvedConfig {
  defaultHeaders: Header[]
  /** Ordered outermost-first: collection, then nested folders. */
  preScripts: { source: string; origin: string }[]
  testScripts: { source: string; origin: string }[]
  auth?: OAuth2Config
  clientCert?: string
  clientKey?: string
  clientKeyPassphrase?: string
  proxy?: string
  caCert?: string
}

/* ---------------------------- data-driven runs --------------------------- */

/** One row of a CSV/JSON data file: column/key -> value. */
export type DataRow = Record<string, string>

/* ------------------------------- history --------------------------------- */

export interface HistoryEntry {
  at: string
  path: string
  method: string
  url: string
  status?: number
  timeMs?: number
  errored: boolean
}

/* ---------------------------- saved examples ----------------------------- */

/** A curated response example saved alongside a request (Name.examples.json). */
export interface SavedExample {
  name: string
  savedAt: string
  request: { method: string; url: string; headers: Header[]; body?: string }
  response: HttpResponseModel
}

/* ------------------------------ code generation -------------------------- */

export type CodegenTarget =
  | 'curl'
  | 'python-requests'
  | 'javascript-fetch'
  | 'node-fetch'
  | 'go'
  | 'ruby'
  | 'php'
  | 'httpie'

export interface CodegenTargetInfo {
  id: CodegenTarget
  label: string
  language: string
}

/* --------------------------- graphql introspection ----------------------- */

export interface GqlField {
  name: string
  type: string
  args: string[]
}

/** Trimmed introspection result for editor hints. */
export interface GqlSchemaSummary {
  queryType?: string
  mutationType?: string
  subscriptionType?: string
  /** Root query/mutation fields for autocomplete. */
  queries: GqlField[]
  mutations: GqlField[]
  /** All type names in the schema. */
  types: string[]
}

export type GqlIntrospectResult =
  | { ok: true; schema: GqlSchemaSummary; introspection?: unknown }
  | { ok: false; error: string }
