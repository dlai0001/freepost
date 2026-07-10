/**
 * gRPC client engine (unary + server-streaming). Runs in the Electron MAIN
 * process. Part of src/engine — the only module allowed to open a socket.
 * Wraps @grpc/grpc-js + @grpc/proto-loader; schema comes from local .proto
 * files. Mirrors the shape of http.ts (one-shot sendGrpcUnary) and ws.ts
 * (connection-oriented GrpcStreamClient).
 */
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import type { Header } from '../shared/model'

export interface GrpcCallArgs {
  target: string
  fullMethod: string
  /** Request message as JSON text. */
  data?: string
  metadata?: Header[]
  /** Absolute paths to .proto files. */
  protoFiles: string[]
  /** Directories for proto import resolution. */
  importPaths?: string[]
  plaintext?: boolean
  insecure?: boolean
  deadlineMs?: number
}

export interface GrpcResponse {
  /** gRPC status code (0 = OK). */
  code: number
  /** Status code name (e.g. "OK", "NOT_FOUND"). */
  codeName: string
  /** Response message JSON (unary), or error details on failure. */
  message: string
  /** Trailing metadata, flattened. */
  metadata: Header[]
  timeMs: number
}

interface ResolvedMethod {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ServiceCtor: any
  methodName: string
  responseStream: boolean
  requestStream: boolean
}

/** Split "pkg.Service/Method" or "pkg.Service.Method" into [service, method]. */
function splitMethod(full: string): { service: string; method: string } {
  const slash = full.lastIndexOf('/')
  if (slash >= 0) return { service: full.slice(0, slash), method: full.slice(slash + 1) }
  const dot = full.lastIndexOf('.')
  if (dot >= 0) return { service: full.slice(0, dot), method: full.slice(dot + 1) }
  throw new Error(`invalid method "${full}": expected pkg.Service/Method`)
}

/** Navigate a dotted path (e.g. "helloworld.Greeter") within a loaded package. */
function navigate(root: Record<string, unknown>, dotted: string): unknown {
  let cur: unknown = root
  for (const part of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

function loadMethod(args: GrpcCallArgs): ResolvedMethod {
  if (args.protoFiles.length === 0) {
    throw new Error('gRPC needs at least one -proto file (reflection is not supported)')
  }
  const pkgDef = protoLoader.loadSync(args.protoFiles, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: args.importPaths && args.importPaths.length > 0 ? args.importPaths : undefined
  })
  const loaded = grpc.loadPackageDefinition(pkgDef) as unknown as Record<string, unknown>
  const { service, method } = splitMethod(args.fullMethod)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ServiceCtor = navigate(loaded, service) as any
  if (typeof ServiceCtor !== 'function' || ServiceCtor.service === undefined) {
    throw new Error(`service not found in proto(s): ${service}`)
  }
  // Method definitions are keyed by their original (or lower-cased) name.
  const def = ServiceCtor.service as Record<string, { requestStream: boolean; responseStream: boolean; originalName?: string }>
  const key =
    Object.keys(def).find((k) => k === method) ??
    Object.keys(def).find((k) => k.toLowerCase() === method.toLowerCase()) ??
    Object.keys(def).find((k) => def[k].originalName === method)
  if (key === undefined) throw new Error(`method not found on ${service}: ${method}`)
  const md = def[key]
  // grpc-js exposes the callable as the lower-cased-first-letter camel name.
  const callName = md.originalName ?? key
  return {
    ServiceCtor,
    methodName: callName,
    responseStream: md.responseStream,
    requestStream: md.requestStream
  }
}

function makeCredentials(args: GrpcCallArgs): grpc.ChannelCredentials {
  if (args.plaintext) return grpc.credentials.createInsecure()
  if (args.insecure) {
    // TLS transport, skip cert verification (checkServerIdentity always passes).
    return grpc.credentials.createSsl(null, null, null, {
      checkServerIdentity: () => undefined
    })
  }
  return grpc.credentials.createSsl()
}

function toMetadata(headers?: Header[]): grpc.Metadata {
  const md = new grpc.Metadata()
  for (const h of headers ?? []) md.add(h.name, h.value)
  return md
}

function flattenMetadata(md: grpc.Metadata | undefined): Header[] {
  if (md === undefined) return []
  const out: Header[] = []
  const obj = md.getMap()
  for (const [k, v] of Object.entries(obj)) out.push({ name: k, value: String(v) })
  return out
}

function codeName(code: number): string {
  return grpc.status[code] ?? String(code)
}

/** One-shot unary call. Never rejects — failures come back as a non-OK code. */
export async function sendGrpcUnary(args: GrpcCallArgs): Promise<GrpcResponse> {
  const started = Date.now()
  let resolved: ResolvedMethod
  let reqObj: unknown
  try {
    resolved = loadMethod(args)
    reqObj = JSON.parse(args.data !== undefined && args.data.trim() !== '' ? args.data : '{}')
  } catch (e) {
    return {
      code: grpc.status.INVALID_ARGUMENT,
      codeName: codeName(grpc.status.INVALID_ARGUMENT),
      message: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      metadata: [],
      timeMs: Date.now() - started
    }
  }
  if (resolved.responseStream || resolved.requestStream) {
    return {
      code: grpc.status.INVALID_ARGUMENT,
      codeName: codeName(grpc.status.INVALID_ARGUMENT),
      message: JSON.stringify({ error: 'not a unary method; use the streaming client' }),
      metadata: [],
      timeMs: Date.now() - started
    }
  }
  const client = new resolved.ServiceCtor(args.target, makeCredentials(args))
  const options: grpc.CallOptions = {}
  if (args.deadlineMs !== undefined) options.deadline = Date.now() + args.deadlineMs

  return await new Promise<GrpcResponse>((resolve) => {
    client[resolved.methodName](
      reqObj,
      toMetadata(args.metadata),
      options,
      (err: grpc.ServiceError | null, response: unknown) => {
        const timeMs = Date.now() - started
        client.close()
        if (err !== null) {
          resolve({
            code: err.code ?? grpc.status.UNKNOWN,
            codeName: codeName(err.code ?? grpc.status.UNKNOWN),
            message: JSON.stringify({ error: err.details || err.message }, null, 2),
            metadata: flattenMetadata(err.metadata),
            timeMs
          })
        } else {
          resolve({
            code: grpc.status.OK,
            codeName: 'OK',
            message: JSON.stringify(response, null, 2),
            metadata: [],
            timeMs
          })
        }
      }
    )
  })
}

export type GrpcStreamState = 'idle' | 'open' | 'closed'

export interface GrpcStreamEvents {
  data: (json: string) => void
  error: (err: Error) => void
  end: () => void
}

/** Server-streaming call, mirroring WsClient's emitter API. */
export class GrpcStreamClient {
  private _state: GrpcStreamState = 'idle'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private call?: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client?: any
  private readonly listeners: { [E in keyof GrpcStreamEvents]: GrpcStreamEvents[E][] } = {
    data: [],
    error: [],
    end: []
  }

  get state(): GrpcStreamState {
    return this._state
  }

  on<E extends keyof GrpcStreamEvents>(event: E, cb: GrpcStreamEvents[E]): this {
    this.listeners[event].push(cb)
    return this
  }
  private emit<E extends keyof GrpcStreamEvents>(
    event: E,
    ...a: Parameters<GrpcStreamEvents[E]>
  ): void {
    for (const cb of this.listeners[event]) (cb as (...x: Parameters<GrpcStreamEvents[E]>) => void)(...a)
  }

  start(args: GrpcCallArgs): void {
    if (this._state !== 'idle') throw new Error('GrpcStreamClient already started')
    let resolved: ResolvedMethod
    let reqObj: unknown
    try {
      resolved = loadMethod(args)
      if (!resolved.responseStream) throw new Error('not a server-streaming method')
      reqObj = JSON.parse(args.data !== undefined && args.data.trim() !== '' ? args.data : '{}')
    } catch (e) {
      this.emit('error', e instanceof Error ? e : new Error(String(e)))
      return
    }
    this.client = new resolved.ServiceCtor(args.target, makeCredentials(args))
    this._state = 'open'
    const call = this.client[resolved.methodName](reqObj, toMetadata(args.metadata))
    this.call = call
    call.on('data', (msg: unknown) => this.emit('data', JSON.stringify(msg, null, 2)))
    call.on('error', (err: Error) => {
      this._state = 'closed'
      this.emit('error', err)
      this.client?.close()
    })
    call.on('end', () => {
      this._state = 'closed'
      this.emit('end')
      this.client?.close()
    })
  }

  cancel(): void {
    if (this.call !== undefined && this._state === 'open') {
      this.call.cancel()
      this._state = 'closed'
      this.client?.close()
    }
  }
}
