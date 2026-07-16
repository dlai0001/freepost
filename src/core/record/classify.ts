/**
 * Protocol classification for the record proxy. Pure — the engine tees the
 * wire bytes and hands header/body previews here; no sockets. Order matters:
 * gRPC and GraphQL are recognized from the request, SSE only from the
 * response, and REST is the fallback. (WebSocket sessions never reach this —
 * they are classified at upgrade time in the engine.)
 */
import { parse, type OperationDefinitionNode } from 'graphql'
import type { RecordedProtocol } from '@shared/model'

/**
 * Hop-by-hop headers (RFC 9110 §7.6.1 + the legacy Proxy-Connection): they
 * describe one connection, not the message, so a proxy must not forward them
 * and a saved request must not carry them.
 */
export const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'proxy-connection'
])

/**
 * True for native gRPC content types (application/grpc, +proto, +json).
 * grpc-web is deliberately excluded: it's HTTP/1.1-framed and replayable as a
 * plain HTTP request, so recording it as 'grpc' (tier-1, body dropped) would
 * lose the exchange.
 */
export function isGrpcContentType(contentType: string | undefined): boolean {
  const t = contentType?.toLowerCase() ?? ''
  return t.startsWith('application/grpc') && !t.startsWith('application/grpc-web')
}

export interface ClassifyRequest {
  contentType?: string
  /** Decoded body preview (may be truncated — a 64 KiB prefix still classifies). */
  bodyText?: string
}

export interface ClassifyResponse {
  contentType?: string
}

export interface ExchangeClassification {
  protocol: RecordedProtocol
  graphql?: { operationName?: string; operationType?: string }
}

/** A JSON object with a top-level `query` string is treated as GraphQL. */
function graphqlBody(bodyText: string | undefined): { query: string; operationName?: string } | null {
  if (bodyText === undefined || !bodyText.trimStart().startsWith('{')) return null
  try {
    const obj: unknown = JSON.parse(bodyText)
    if (obj === null || typeof obj !== 'object') return null
    const query = (obj as { query?: unknown }).query
    if (typeof query !== 'string') return null
    const name = (obj as { operationName?: unknown }).operationName
    return { query, operationName: typeof name === 'string' && name !== '' ? name : undefined }
  } catch {
    return null // truncated or invalid JSON — not confidently GraphQL
  }
}

/**
 * operationName/operationType for a GraphQL request. The payload's
 * `operationName` field wins; when absent both come from parsing the query
 * text (first operation definition — mirrors graphql-js execution). An
 * unparseable query keeps whatever the payload said.
 */
function graphqlInfo(body: {
  query: string
  operationName?: string
}): { operationName?: string; operationType?: string } {
  let ops: OperationDefinitionNode[]
  try {
    ops = parse(body.query).definitions.filter(
      (d): d is OperationDefinitionNode => d.kind === 'OperationDefinition'
    )
  } catch {
    return body.operationName !== undefined ? { operationName: body.operationName } : {}
  }
  const chosen =
    body.operationName !== undefined
      ? (ops.find((o) => o.name?.value === body.operationName) ?? ops[0])
      : ops[0]
  const operationName = body.operationName ?? chosen?.name?.value
  return {
    ...(operationName !== undefined ? { operationName } : {}),
    ...(chosen !== undefined ? { operationType: chosen.operation } : {})
  }
}

/** Classify one proxied exchange. `res` is absent when the upstream errored. */
export function classifyExchange(
  req: ClassifyRequest,
  res?: ClassifyResponse
): ExchangeClassification {
  if (isGrpcContentType(req.contentType)) return { protocol: 'grpc' }

  const gql = graphqlBody(req.bodyText)
  if (gql !== null) return { protocol: 'graphql', graphql: graphqlInfo(gql) }

  const resType = res?.contentType?.toLowerCase() ?? ''
  if (resType.startsWith('text/event-stream')) return { protocol: 'sse' }

  return { protocol: 'rest' }
}
