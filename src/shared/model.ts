/**
 * Shared data model — the contract between core modules, the engine, the main
 * process, and the renderer. See PLAN.md for the format specification.
 */

/** Request file type, discriminated by extension: .curl | .ws | .grpc | .mqtt | .mcp */
export type RequestKind = 'curl' | 'websocat' | 'grpc' | 'mqtt' | 'mcp'

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
  /**
   * Subscription endpoint override. When unset, the engine derives it from
   * schemaUrl (or the request URL): http→ws / https→wss for the `ws` transport,
   * unchanged for `sse`.
   */
  subscriptionUrl?: string
  /** Transport for subscription operations. Defaults to `ws` (graphql-transport-ws). */
  subscriptionTransport?: 'ws' | 'sse'
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
    /**
     * Extra CA certificate to trust for this request (curl --cacert): a file
     * path (absolute, or relative to the request) or PEM contents. Supports
     * ${VAR} so the path can live in an environment. Trusts a self-signed /
     * corporate root without disabling verification.
     */
    caCert?: string
  }
}

/** Parsed websocat command. */
export interface WsRequestModel {
  url: string
  headers: Header[]
  protocol?: string
}

/** Parsed grpcurl command (supported-flag subset; see core/format/grpc.ts). */
export interface GrpcRequestModel {
  /** host:port (may contain ${VAR}). */
  target: string
  /** Fully-qualified method, e.g. "helloworld.Greeter/SayHello". */
  fullMethod: string
  /** -plaintext: connect without TLS. */
  plaintext?: boolean
  /** -insecure: TLS without certificate verification. */
  insecure?: boolean
  /** -d: request message as JSON text (may contain ${VAR}). */
  data?: string
  /** -H metadata entries. */
  metadata: Header[]
  /** -proto files (collection-relative or absolute; may contain ${VAR}). */
  protoFiles: string[]
  /** -import-path directories for proto resolution. */
  importPaths: string[]
  /** -max-time seconds. */
  maxTimeSeconds?: number
}

/** Publish or subscribe, inferred from mosquitto_pub / mosquitto_sub. */
export type MqttMode = 'publish' | 'subscribe'

/** Parsed mosquitto_pub / mosquitto_sub command (supported-flag subset). */
export interface MqttRequestModel {
  mode: MqttMode
  /** Broker host (-h). May contain ${VAR}. */
  host: string
  /** Broker port (-p). Default 1883. */
  port?: number
  /** Topic (-t). Publish: exact; subscribe: may use +/# wildcards. */
  topic: string
  /** QoS 0|1|2 (-q). */
  qos?: number
  /** -r retain (publish). */
  retain?: boolean
  /** Message payload (-m), publish only. May contain ${VAR}. */
  message?: string
  /** Client id (-i). */
  clientId?: string
  /** Username (-u). */
  username?: string
  /** Password (-P). */
  password?: string
  /** --cafile: trust this CA (enables TLS). May contain ${VAR}. */
  caFile?: string
}

/**
 * MCP transport. `stdio` spawns the server as a subprocess and speaks JSON-RPC
 * over its stdin/stdout; `http` POSTs JSON-RPC to a Streamable HTTP endpoint.
 * SSE is deliberately unsupported — it is deprecated in the MCP spec.
 */
export type McpTransport = 'stdio' | 'http'

/**
 * The MCP methods a `.mcp` file can invoke, matching the Inspector CLI's
 * `--method` surface. The three list methods are introspection; the other three
 * (tools/call, resources/read, prompts/get) are the invocations. All six are
 * one-shot, so all six are runnable headlessly.
 */
export type McpMethod =
  | 'tools/list'
  | 'tools/call'
  | 'resources/list'
  | 'resources/read'
  | 'prompts/list'
  | 'prompts/get'

/** One `--tool-arg`/`--prompt-args` entry: key=value, order preserved. */
export interface McpArg {
  name: string
  /** Raw text as written; the server coerces per inputSchema. */
  value: string
}

/**
 * Parsed MCP Inspector CLI command (supported-flag subset; see
 * core/format/mcp.ts). stdio uses `command`/`args`; http uses `url`/`headers`.
 */
export interface McpRequestModel {
  transport: McpTransport
  /** stdio: the server program to spawn (may contain ${VAR}). */
  command?: string
  /** stdio: argv passed to the server program. */
  args: string[]
  /** stdio: -e entries, exported into the server subprocess's environment. */
  env: McpArg[]
  /** http: the Streamable HTTP endpoint (may contain ${VAR}). */
  url?: string
  /** http: --header entries. */
  headers: Header[]
  method: McpMethod
  /** tools/call: --tool-name. */
  toolName?: string
  /** tools/call: --tool-arg entries, in file order. */
  toolArgs: McpArg[]
  /** resources/read: --uri. */
  uri?: string
  /** prompts/get: --prompt-name. */
  promptName?: string
  /** prompts/get: --prompt-args entries, in file order. */
  promptArgs: McpArg[]
}

/**
 * An MCP result as it crosses the IPC boundary. Both failure axes are carried:
 * `error` is a protocol failure (transport, spawn, JSON-RPC), `isError` is a
 * tool that ran and reported failure. They are NOT the same thing.
 */
export interface McpToolResponse {
  method: McpMethod
  error?: string
  isError: boolean
  /** The result payload as pretty-printed JSON. */
  body: string
  structuredContent?: Record<string, unknown>
  progress: { progress: number; total?: number; message?: string }[]
  logs: { level: string; data: unknown }[]
  timeMs: number
}

/** What a server said it can do, read at connect time. */
export interface McpIntrospectionSummary {
  tools: unknown[]
  resources: unknown[]
  resourceTemplates: unknown[]
  prompts: unknown[]
  capabilities: Record<string, unknown>
  serverInfo: Record<string, unknown>
}

/** The recorded schema surface of an MCP server (F5 drift detection). */
export interface McpSnapshot {
  version: 1
  server: { name?: string; version?: string }
  capabilities: string[]
  tools: McpSnapshotTool[]
  resources: string[]
  prompts: McpSnapshotPrompt[]
}

export interface McpSnapshotTool {
  name: string
  description?: string
  /** Parameter name -> declared JSON Schema type (or 'unknown'). */
  params: Record<string, string>
  required: string[]
  /** Whether the tool declares an outputSchema. */
  structured?: boolean
}

export interface McpSnapshotPrompt {
  name: string
  args: string[]
}

export type McpDriftKind =
  | 'tool-removed'
  | 'tool-added'
  | 'param-removed'
  | 'param-added'
  | 'param-retyped'
  | 'param-now-required'
  | 'param-now-optional'
  | 'resource-removed'
  | 'resource-added'
  | 'prompt-removed'
  | 'prompt-added'
  | 'prompt-arg-removed'
  | 'prompt-arg-added'

export interface McpDriftEntry {
  kind: McpDriftKind
  /** Whether this change can break an existing caller (fails CI). */
  breaking: boolean
  message: string
}

export interface McpDriftReport {
  clean: boolean
  breaking: boolean
  entries: McpDriftEntry[]
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
  /** Present when kind === 'grpc'. */
  grpc?: GrpcRequestModel
  /** Present when kind === 'mqtt'. */
  mqtt?: MqttRequestModel
  /** Present when kind === 'mcp'. */
  mcp?: McpRequestModel
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

/* ------------------------------ openapi import ---------------------------- */

/** One operation (path x method) discovered while listing an OpenAPI/Swagger spec. */
export interface OpenApiOperationSummary {
  /** Stable selection key: `${method} ${path}` (method upper-cased, path as written in the spec). */
  id: string
  method: string
  path: string
  summary?: string
  /** Sanitized folder this operation will be written under (first tag, else first path segment). */
  folder: string
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
  /**
   * Mock server: the example the mock serves by default for its route. At most
   * one example per file should be active. Optional/back-compat — files saved
   * before this field simply have it undefined (treated as "not active", so the
   * mock falls back to first-in-file order).
   */
  active?: boolean
}

/** One line of the mock server's request log. */
export interface MockRequestLogEntry {
  method: string
  path: string
  status: number
  matched: boolean
  exampleName?: string
  sourcePath?: string
  at: string
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
