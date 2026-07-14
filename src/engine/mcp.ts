/**
 * MCP (Model Context Protocol) engine, on @modelcontextprotocol/sdk.
 *
 * Mirrors the shape of grpc.ts: a one-shot `callMcp` (like sendGrpcUnary) plus
 * a connection-oriented `McpSessionClient` (like GrpcStreamClient) for
 * introspection and server-initiated traffic.
 *
 * Two transports, both live: `stdio` (the server is a SUBPROCESS — this is the
 * only engine that spawns one) and `http` (Streamable HTTP). SSE is deliberately
 * absent: it is deprecated in the MCP spec.
 *
 * MCP has TWO distinct failure axes and they must not be collapsed:
 *   - McpResponse.error   — a protocol error: transport/spawn failure, or a
 *     JSON-RPC error from a non-tool method (e.g. reading an unknown resource
 *     URI).
 *   - McpResponse.isError — an ordinary result whose tool ran and reported
 *     failure. Verified against SDK 1.29: this covers input-schema rejections
 *     AND unknown tool names (the high-level McpServer answers those with an
 *     isError result carrying "MCP error -32602", it does NOT throw).
 * Both are surfaced so pm.* can assert on either.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  LoggingMessageNotificationSchema
} from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { Header, McpArg, McpMethod, McpRequestModel, McpTransport } from '../shared/model'

/** Connection half of a `.mcp` request, shared by one-shot and session use. */
export interface McpConnectArgs {
  transport: McpTransport
  /** stdio: program to spawn. */
  command?: string
  /** stdio: argv for the program. */
  args?: string[]
  /** stdio: extra environment for the subprocess. */
  env?: Record<string, string>
  /** stdio: working directory for the subprocess (the request's folder). */
  cwd?: string
  /** http: Streamable HTTP endpoint. */
  url?: string
  /** http: request headers (auth etc). */
  headers?: Header[]
}

/** Operation half of a `.mcp` request. */
export interface McpCallArgs extends McpConnectArgs {
  method: McpMethod
  toolName?: string
  toolArgs?: McpArg[]
  uri?: string
  promptName?: string
  promptArgs?: McpArg[]
  timeoutMs?: number
  /** Answers a server->client sampling request. Absent => the request is refused. */
  sampling?: McpSamplingResponder
  /** Answers a server->client elicitation request. Absent => the request is declined. */
  elicitation?: McpElicitationResponder
  /** Server progress notifications for this call. */
  onProgress?: (p: { progress: number; total?: number; message?: string }) => void
  /** Server log notifications for this call. */
  onLog?: (l: { level: string; data: unknown }) => void
}

/** Canned answer to a server's sampling (LLM completion) request. */
export type McpSamplingResponder = (req: unknown) => {
  role: 'assistant'
  content: { type: 'text'; text: string }
  model: string
  stopReason?: string
}

/** Canned answer to a server's elicitation (ask-the-user) request. */
export type McpElicitationResponder = (req: unknown) => {
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, unknown>
}

export interface McpResponse {
  /** The method that was invoked. */
  method: McpMethod
  /**
   * Protocol-level failure (JSON-RPC error, transport/spawn failure, bad
   * config). Distinct from `isError` — see the file header.
   */
  error?: string
  /** Tool-level failure: the call succeeded but the tool reported failure. */
  isError: boolean
  /** The result payload, pretty-printed JSON (`{ error }` on protocol failure). */
  body: string
  /** tools/call structured output, when the tool declares an outputSchema. */
  structuredContent?: Record<string, unknown>
  /** Progress notifications received during the call. */
  progress: { progress: number; total?: number; message?: string }[]
  /** Log notifications received during the call. */
  logs: { level: string; data: unknown }[]
  timeMs: number
}

/** Extract just the connection fields from a model (for one-shot or session). */
export function mcpConnectArgs(m: McpRequestModel): McpConnectArgs {
  const out: McpConnectArgs = { transport: m.transport }
  if (m.command !== undefined) out.command = m.command
  if (m.args.length > 0) out.args = m.args
  if (m.env.length > 0) out.env = Object.fromEntries(m.env.map((e) => [e.name, e.value]))
  if (m.url !== undefined) out.url = m.url
  if (m.headers.length > 0) out.headers = m.headers
  return out
}

const argsToObject = (args: McpArg[] | undefined): Record<string, string> =>
  Object.fromEntries((args ?? []).map((a) => [a.name, a.value]))

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Build the SDK transport. stdio spawns a subprocess; the caller is responsible
 * for having obtained the user's consent to run that command (see the spawn
 * consent gate in the main process) — the engine does not prompt.
 */
function makeTransport(args: McpConnectArgs): Transport {
  if (args.transport === 'stdio') {
    if (args.command === undefined || args.command === '') {
      throw new Error('stdio transport requires a server command')
    }
    return new StdioClientTransport({
      command: args.command,
      args: args.args ?? [],
      // Inherit the parent env so servers can see PATH etc, then layer -e on top.
      env: { ...(process.env as Record<string, string>), ...(args.env ?? {}) },
      cwd: args.cwd,
      stderr: 'pipe'
    })
  }
  if (args.url === undefined || args.url === '') {
    throw new Error('http transport requires an endpoint URL')
  }
  const headers = Object.fromEntries((args.headers ?? []).map((h) => [h.name, h.value]))
  return new StreamableHTTPClientTransport(new URL(args.url), { requestInit: { headers } })
}

/**
 * A client that declares sampling + elicitation, so servers may call back.
 *
 * `elicitation` needs the `form` SUB-capability — the SDK gates
 * `server.elicitInput()` on `clientCapabilities.elicitation.form` and rejects
 * with "Client does not support form elicitation" if only `elicitation: {}` is
 * declared. (`url` elicitation is a separate sub-capability we do not answer.)
 */
function makeClient(): Client {
  return new Client(
    { name: 'freepost', version: '1.0.0' },
    { capabilities: { sampling: {}, elicitation: { form: {} } } }
  )
}

/** Wire the server->client handlers a test client must answer (F4). */
function installClientHandlers(client: Client, args: McpCallArgs, res: McpResponse): void {
  client.setRequestHandler(CreateMessageRequestSchema, (req) => {
    if (args.sampling === undefined) {
      throw new Error('the server requested an LLM completion (sampling) but this request has no sampling response configured')
    }
    return args.sampling(req)
  })
  client.setRequestHandler(ElicitRequestSchema, (req) => {
    if (args.elicitation === undefined) return { action: 'decline' as const }
    return args.elicitation(req)
  })
  client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
    const entry = { level: String(n.params.level), data: n.params.data }
    res.logs.push(entry)
    args.onLog?.(entry)
  })
}

/**
 * One-shot MCP call: connect, invoke one method, disconnect. Never rejects —
 * failures come back as `error` (protocol) or `isError` (tool), per the two
 * failure axes.
 */
export async function callMcp(args: McpCallArgs): Promise<McpResponse> {
  const started = Date.now()
  const res: McpResponse = {
    method: args.method,
    isError: false,
    body: '',
    progress: [],
    logs: [],
    timeMs: 0
  }

  let client: Client | undefined
  try {
    const transport = makeTransport(args)
    client = makeClient()
    installClientHandlers(client, args, res)
    await client.connect(transport)

    const opts = {
      timeout: args.timeoutMs,
      onprogress: (p: { progress: number; total?: number; message?: string }) => {
        res.progress.push(p)
        args.onProgress?.(p)
      }
    }

    let payload: unknown
    switch (args.method) {
      case 'tools/list':
        payload = await client.listTools(undefined, opts)
        break
      case 'tools/call': {
        if (args.toolName === undefined) throw new Error('tools/call requires a tool name')
        const schema = await toolInputSchema(client, args.toolName)
        const r = await client.callTool(
          { name: args.toolName, arguments: coerceToolArgs(args.toolArgs, schema) },
          undefined,
          opts
        )
        payload = r
        res.isError = r.isError === true
        if (r.structuredContent !== undefined) {
          res.structuredContent = r.structuredContent as Record<string, unknown>
        }
        break
      }
      case 'resources/list':
        payload = await client.listResources(undefined, opts)
        break
      case 'resources/read': {
        if (args.uri === undefined) throw new Error('resources/read requires a uri')
        payload = await client.readResource({ uri: args.uri }, opts)
        break
      }
      case 'prompts/list':
        payload = await client.listPrompts(undefined, opts)
        break
      case 'prompts/get': {
        if (args.promptName === undefined) throw new Error('prompts/get requires a prompt name')
        payload = await client.getPrompt(
          { name: args.promptName, arguments: argsToObject(args.promptArgs) },
          opts
        )
        break
      }
    }
    res.body = JSON.stringify(payload, null, 2)
  } catch (e) {
    res.error = errorMessage(e)
    res.body = JSON.stringify({ error: res.error }, null, 2)
  } finally {
    // Always tear down: close the HTTP session / kill the stdio child.
    try {
      await client?.close()
    } catch {
      // A close failure must not mask the call's own result.
    }
  }

  res.timeMs = Date.now() - started
  return res
}

/** A tool's JSON Schema `properties` map, when the server advertises one. */
export type ToolSchema = Record<string, { type?: string }> | undefined

/** Look up one tool's inputSchema properties, for argument coercion. */
async function toolInputSchema(client: Client, name: string): Promise<ToolSchema> {
  try {
    const { tools } = await client.listTools()
    const tool = tools.find((t) => t.name === name)
    const props = tool?.inputSchema?.properties
    return props as ToolSchema
  } catch {
    // If the server won't list tools, fall back to shape-based coercion.
    return undefined
  }
}

/**
 * Tool arguments arrive as strings — the file format is a shell command, and
 * `--tool-arg a=20` cannot say whether 20 is a number or the string "20". The
 * MCP Inspector answers that from the tool's inputSchema, and so do we: when a
 * declared type is known, coerce to it (a `string` property keeps "20" as text);
 * otherwise fall back to JSON shape.
 */
export function coerceToolArgs(args: McpArg[] | undefined, schema?: ToolSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const a of args ?? []) {
    const declared = schema?.[a.name]?.type
    out[a.name] = declared === undefined ? coerceByShape(a.value) : coerceToType(a.value, declared)
  }
  return out
}

function coerceToType(text: string, type: string): unknown {
  switch (type) {
    case 'string':
      return text
    case 'number':
    case 'integer': {
      const n = Number(text.trim())
      // A non-numeric value for a numeric property is passed through unchanged
      // so the SERVER reports the schema violation (isError), not us.
      return Number.isFinite(n) && text.trim() !== '' ? n : text
    }
    case 'boolean':
      if (text === 'true') return true
      if (text === 'false') return false
      return text
    case 'object':
    case 'array':
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
    default:
      return coerceByShape(text)
  }
}

/** Schema-free fallback: JSON-parse what looks like JSON, else keep the string. */
function coerceByShape(text: string): unknown {
  const t = text.trim()
  if (t === '') return text
  if (t === 'true') return true
  if (t === 'false') return false
  if (t === 'null') return null
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) {
    const n = Number(t)
    if (Number.isFinite(n)) return n
  }
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.parse(t)
    } catch {
      return text
    }
  }
  return text
}

/** The introspection surface of a server: what it can do. */
export interface McpIntrospection {
  tools: unknown[]
  resources: unknown[]
  resourceTemplates: unknown[]
  prompts: unknown[]
  /** Server-declared capabilities from the initialize handshake. */
  capabilities: Record<string, unknown>
  serverInfo: Record<string, unknown>
}

export type McpSessionState = 'idle' | 'connecting' | 'open' | 'closed'

export interface McpSessionEvents {
  open: (info: McpIntrospection) => void
  log: (l: { level: string; data: unknown }) => void
  notification: (n: { method: string; params?: unknown }) => void
  error: (err: Error) => void
  close: () => void
}

/**
 * Connection-oriented MCP client: connects, introspects, stays open for
 * repeated calls and server-initiated notifications. Mirrors the emitter API of
 * GrpcStreamClient / MqttSubscribeClient (4-state, because MCP has a real
 * `initialize` handshake phase).
 */
export class McpSessionClient {
  private _state: McpSessionState = 'idle'
  private client?: Client

  private readonly listeners: { [E in keyof McpSessionEvents]: McpSessionEvents[E][] } = {
    open: [],
    log: [],
    notification: [],
    error: [],
    close: []
  }

  get state(): McpSessionState {
    return this._state
  }

  on<E extends keyof McpSessionEvents>(event: E, cb: McpSessionEvents[E]): this {
    this.listeners[event].push(cb)
    return this
  }

  private emit<E extends keyof McpSessionEvents>(event: E, ...a: Parameters<McpSessionEvents[E]>): void {
    for (const cb of this.listeners[event]) {
      ;(cb as (...x: Parameters<McpSessionEvents[E]>) => void)(...a)
    }
  }

  /** Connect + introspect. Setup failures surface as an `error` event. */
  async connect(args: McpConnectArgs): Promise<void> {
    if (this._state !== 'idle') throw new Error('McpSessionClient already started')
    this._state = 'connecting'
    try {
      const transport = makeTransport(args)
      const client = makeClient()
      this.client = client
      client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
        this.emit('log', { level: String(n.params.level), data: n.params.data })
      })
      client.fallbackNotificationHandler = async (n): Promise<void> => {
        this.emit('notification', { method: n.method, params: n.params })
      }
      transport.onclose = (): void => {
        if (this._state === 'closed') return
        this._state = 'closed'
        this.emit('close')
      }
      await client.connect(transport)
      const info = await this.introspect()
      this._state = 'open'
      this.emit('open', info)
    } catch (e) {
      this._state = 'closed'
      this.emit('error', e instanceof Error ? e : new Error(String(e)))
      await this.close()
    }
  }

  /**
   * Read the server's full introspection surface. Servers need not implement
   * every capability, so each list is best-effort: an unsupported list method
   * yields an empty array rather than failing the whole introspection.
   */
  async introspect(): Promise<McpIntrospection> {
    const client = this.client
    if (client === undefined) throw new Error('not connected')

    const caps = client.getServerCapabilities() ?? {}
    const version = client.getServerVersion() ?? {}
    const out: McpIntrospection = {
      tools: [],
      resources: [],
      resourceTemplates: [],
      prompts: [],
      capabilities: caps as Record<string, unknown>,
      serverInfo: version as Record<string, unknown>
    }
    if (caps.tools !== undefined) {
      out.tools = (await client.listTools()).tools ?? []
    }
    if (caps.resources !== undefined) {
      out.resources = (await client.listResources()).resources ?? []
      try {
        out.resourceTemplates = (await client.listResourceTemplates()).resourceTemplates ?? []
      } catch {
        // Templates are optional even when resources are supported.
      }
    }
    if (caps.prompts !== undefined) {
      out.prompts = (await client.listPrompts()).prompts ?? []
    }
    return out
  }

  /** Invoke a tool on the open session (the GUI's run button). */
  async callTool(name: string, args: McpArg[]): Promise<McpResponse> {
    const started = Date.now()
    const client = this.client
    if (client === undefined) throw new Error('not connected')
    const res: McpResponse = {
      method: 'tools/call',
      isError: false,
      body: '',
      progress: [],
      logs: [],
      timeMs: 0
    }
    try {
      const schema = await toolInputSchema(client, name)
      const r = await client.callTool({ name, arguments: coerceToolArgs(args, schema) })
      res.isError = r.isError === true
      if (r.structuredContent !== undefined) {
        res.structuredContent = r.structuredContent as Record<string, unknown>
      }
      res.body = JSON.stringify(r, null, 2)
    } catch (e) {
      res.error = errorMessage(e)
      res.body = JSON.stringify({ error: res.error }, null, 2)
    }
    res.timeMs = Date.now() - started
    return res
  }

  async close(): Promise<void> {
    const client = this.client
    this.client = undefined
    if (client === undefined) return
    try {
      await client.close()
    } catch {
      // Already gone.
    }
    if (this._state !== 'closed') {
      this._state = 'closed'
      this.emit('close')
    }
  }
}
