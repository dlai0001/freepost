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
  graphql?: { query: string; variables?: Record<string, unknown> }
  /** WebSocket saved message presets (websocat files only). */
  messages?: Record<string, string>
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

/* ------------------------------- workflows ------------------------------- */

export interface WorkflowStep {
  /** Collection-relative path to a .curl/.ws file. */
  request: string
  expectError?: boolean
}

export interface WorkflowFile {
  description?: string
  steps: WorkflowStep[]
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
