/**
 * GraphQL introspection: build the standard introspection query and reduce the
 * response into a compact GqlSchemaSummary for editor hints. Pure — the actual
 * network request is made by the engine in the main process.
 */
import type { GqlField, GqlSchemaSummary } from '@shared/model'

/** A trimmed standard introspection query (enough for root fields + type names). */
export const INTROSPECTION_QUERY = `query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types {
      name
      kind
      fields(includeDeprecated: true) {
        name
        args { name type { ...TypeRef } }
        type { ...TypeRef }
      }
    }
  }
}
fragment TypeRef on __Type {
  kind name
  ofType { kind name ofType { kind name ofType { kind name } } }
}`.replace(/\s+/g, ' ')

interface TypeRef {
  kind: string
  name: string | null
  ofType?: TypeRef | null
}

interface IntrospField {
  name: string
  args?: { name: string; type: TypeRef }[]
  type: TypeRef
}

interface IntrospType {
  name: string | null
  kind: string
  fields?: IntrospField[] | null
}

/** Render a possibly-wrapped type ref to GraphQL SDL notation (e.g. [User!]!). */
export function renderTypeRef(ref: TypeRef | null | undefined): string {
  if (ref === null || ref === undefined) return 'Unknown'
  switch (ref.kind) {
    case 'NON_NULL':
      return `${renderTypeRef(ref.ofType)}!`
    case 'LIST':
      return `[${renderTypeRef(ref.ofType)}]`
    default:
      return ref.name ?? 'Unknown'
  }
}

function toField(f: IntrospField): GqlField {
  return {
    name: f.name,
    type: renderTypeRef(f.type),
    args: (f.args ?? []).map((a) => `${a.name}: ${renderTypeRef(a.type)}`)
  }
}

/**
 * Parse an introspection response body (the JSON text of `{ data: { __schema }}`)
 * into a compact summary. Returns null if the shape isn't valid introspection.
 */
export function parseIntrospection(responseText: string): GqlSchemaSummary | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(responseText)
  } catch {
    return null
  }
  const schema =
    (parsed as { data?: { __schema?: unknown } })?.data?.__schema ??
    (parsed as { __schema?: unknown })?.__schema
  if (schema === undefined || schema === null || typeof schema !== 'object') return null

  const s = schema as {
    queryType?: { name?: string } | null
    mutationType?: { name?: string } | null
    subscriptionType?: { name?: string } | null
    types?: IntrospType[]
  }
  const types = Array.isArray(s.types) ? s.types : []
  const byName = new Map<string, IntrospType>()
  for (const t of types) if (t.name) byName.set(t.name, t)

  const rootFields = (typeName?: string): GqlField[] => {
    if (typeName === undefined) return []
    const t = byName.get(typeName)
    return (t?.fields ?? []).map(toField)
  }

  return {
    queryType: s.queryType?.name,
    mutationType: s.mutationType?.name,
    subscriptionType: s.subscriptionType?.name,
    queries: rootFields(s.queryType?.name),
    mutations: rootFields(s.mutationType?.name),
    types: types
      .map((t) => t.name)
      .filter((n): n is string => n !== null && n !== undefined && !n.startsWith('__'))
      .sort()
  }
}
