/**
 * GraphQL subscription client. Runs in the Electron MAIN process (Node context).
 *
 * Part of src/engine — the ONLY module allowed to use network APIs
 * (PLAN.md "Network policy"). Wraps the official `graphql-ws` (WebSocket,
 * graphql-transport-ws) and `graphql-sse` (Server-Sent Events) clients behind
 * one small subscribe API so the rest of the app never touches sockets.
 */
import WebSocket from 'ws'
import { createClient as createWsClient } from 'graphql-ws'
import { createClient as createSseClient } from 'graphql-sse'
import type { Header } from '../shared/model'

export type GqlTransport = 'ws' | 'sse'

export interface GqlSubscribeArgs {
  url: string
  transport: GqlTransport
  headers?: Header[]
  query: string
  variables?: Record<string, unknown>
  operationName?: string
}

export interface GqlSubscribeHandlers {
  /** One streamed execution result ({ data?, errors? }). */
  next: (payload: unknown) => void
  error: (err: Error) => void
  complete: () => void
}

/**
 * Start a GraphQL subscription over WebSocket (graphql-transport-ws) or SSE.
 * Returns a dispose function that cancels the subscription and tears down the
 * underlying transport.
 */
export function subscribeGraphql(
  args: GqlSubscribeArgs,
  handlers: GqlSubscribeHandlers
): () => void {
  const headerObj: Record<string, string> = {}
  for (const h of args.headers ?? []) headerObj[h.name] = h.value
  const hasHeaders = Object.keys(headerObj).length > 0

  const payload = {
    query: args.query,
    variables: args.variables,
    operationName: args.operationName
  }
  const sink = {
    next: (value: unknown) => handlers.next(value),
    error: (err: unknown) => handlers.error(err instanceof Error ? err : new Error(formatErr(err))),
    complete: () => handlers.complete()
  }

  if (args.transport === 'sse') {
    // Distinct-connections mode: one request per operation — the most broadly
    // compatible mode across servers (no reservation handshake).
    const client = createSseClient({
      url: args.url,
      singleConnection: false,
      headers: hasHeaders ? headerObj : undefined,
      fetchFn: fetch
    })
    const unsubscribe = client.subscribe(payload, sink)
    return () => {
      unsubscribe()
      client.dispose()
    }
  }

  // WebSocket transport. graphql-ws has no per-connection header option, so when
  // handshake headers are needed we subclass `ws` to inject them; auth is also
  // forwarded via connectionParams (the standard graphql-ws auth channel).
  const impl = hasHeaders
    ? class WsWithHeaders extends WebSocket {
        constructor(address: string, protocols?: string | string[]) {
          super(address, protocols, { headers: headerObj })
        }
      }
    : WebSocket
  const client = createWsClient({
    url: args.url,
    webSocketImpl: impl,
    connectionParams: hasHeaders ? headerObj : undefined,
    lazy: true,
    retryAttempts: 0
  })
  const unsubscribe = client.subscribe(payload, sink)
  return () => {
    unsubscribe()
    void client.dispose()
  }
}

/** Best-effort human-readable message from the varied error shapes the sinks
 *  emit (GraphQLError[], CloseEvent-like, Event, or Error). */
function formatErr(err: unknown): string {
  if (Array.isArray(err)) {
    return err
      .map((e) =>
        e !== null && typeof e === 'object' && 'message' in e
          ? String((e as { message: unknown }).message)
          : String(e)
      )
      .join('; ')
  }
  if (err !== null && typeof err === 'object') {
    const o = err as { message?: unknown; reason?: unknown; code?: unknown }
    if (typeof o.message === 'string' && o.message !== '') return o.message
    if (typeof o.reason === 'string' && o.reason !== '') {
      return o.code !== undefined ? `${o.reason} (${String(o.code)})` : o.reason
    }
    try {
      return JSON.stringify(err)
    } catch {
      return String(err)
    }
  }
  return String(err)
}
