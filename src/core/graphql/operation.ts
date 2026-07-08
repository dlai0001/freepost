/**
 * Detect the executed operation type of a GraphQL document. Pure — used by the
 * renderer to decide Send vs Subscribe, and by the main process to pick the
 * transport (POST for query/mutation, ws/sse stream for subscription).
 */
import { parse, type OperationDefinitionNode } from 'graphql'

export type GqlOperationType = 'query' | 'mutation' | 'subscription'

/**
 * Return the operation type that would execute for `query`, or null when the
 * document has no operation or fails to parse.
 *
 * When multiple operations are present, `operationName` selects one; without a
 * name the first operation definition wins (mirrors graphql-js execution, which
 * requires a name only to disambiguate).
 */
export function detectOperationType(
  query: string,
  operationName?: string
): GqlOperationType | null {
  let ops: OperationDefinitionNode[]
  try {
    ops = parse(query).definitions.filter(
      (d): d is OperationDefinitionNode => d.kind === 'OperationDefinition'
    )
  } catch {
    return null
  }
  if (ops.length === 0) return null
  const chosen =
    operationName !== undefined && operationName !== ''
      ? ops.find((o) => o.name?.value === operationName)
      : ops[0]
  return chosen?.operation ?? null
}
