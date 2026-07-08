import { describe, expect, it } from 'vitest'
import { buildClientSchema, getIntrospectionQuery, graphqlSync, buildSchema } from 'graphql'
import {
  FULL_INTROSPECTION_QUERY,
  INTROSPECTION_QUERY,
  extractIntrospectionData,
  parseIntrospection,
  renderTypeRef
} from './introspection'

describe('renderTypeRef', () => {
  it('renders wrapped types in SDL notation', () => {
    expect(renderTypeRef({ kind: 'SCALAR', name: 'String' })).toBe('String')
    expect(
      renderTypeRef({ kind: 'NON_NULL', name: null, ofType: { kind: 'SCALAR', name: 'ID' } })
    ).toBe('ID!')
    expect(
      renderTypeRef({
        kind: 'NON_NULL',
        name: null,
        ofType: {
          kind: 'LIST',
          name: null,
          ofType: { kind: 'NON_NULL', name: null, ofType: { kind: 'OBJECT', name: 'User' } }
        }
      })
    ).toBe('[User!]!')
  })
})

describe('parseIntrospection', () => {
  const schema = {
    data: {
      __schema: {
        queryType: { name: 'Query' },
        mutationType: { name: 'Mutation' },
        subscriptionType: null,
        types: [
          {
            name: 'Query',
            kind: 'OBJECT',
            fields: [
              {
                name: 'user',
                args: [{ name: 'id', type: { kind: 'NON_NULL', name: null, ofType: { kind: 'SCALAR', name: 'ID' } } }],
                type: { kind: 'OBJECT', name: 'User' }
              },
              { name: 'users', args: [], type: { kind: 'LIST', name: null, ofType: { kind: 'OBJECT', name: 'User' } } }
            ]
          },
          {
            name: 'Mutation',
            kind: 'OBJECT',
            fields: [{ name: 'createUser', args: [], type: { kind: 'OBJECT', name: 'User' } }]
          },
          { name: 'User', kind: 'OBJECT', fields: [] },
          { name: '__Type', kind: 'OBJECT', fields: [] }
        ]
      }
    }
  }

  it('extracts root query/mutation fields and type names', () => {
    const s = parseIntrospection(JSON.stringify(schema))
    expect(s).not.toBeNull()
    if (s === null) return
    expect(s.queryType).toBe('Query')
    expect(s.mutationType).toBe('Mutation')
    expect(s.queries.map((f) => f.name)).toEqual(['user', 'users'])
    expect(s.queries[0]).toEqual({ name: 'user', type: 'User', args: ['id: ID!'] })
    expect(s.mutations.map((f) => f.name)).toEqual(['createUser'])
    // __-prefixed introspection types are filtered out; real types remain sorted.
    expect(s.types).toEqual(['Mutation', 'Query', 'User'])
  })

  it('accepts a bare __schema (no data wrapper) and null response', () => {
    expect(parseIntrospection(JSON.stringify({ __schema: schema.data.__schema }))).not.toBeNull()
    expect(parseIntrospection('not json')).toBeNull()
    expect(parseIntrospection(JSON.stringify({ data: {} }))).toBeNull()
  })

  it('ships a single-line introspection query', () => {
    expect(INTROSPECTION_QUERY).toContain('__schema')
    expect(INTROSPECTION_QUERY).not.toContain('\n')
  })
})

describe('extractIntrospectionData', () => {
  // A real introspection response produced from an SDL schema, so the extracted
  // data is guaranteed to satisfy graphql's buildClientSchema (editor path).
  const sdl = buildSchema('type Query { hello: String }')
  const introspectionResult = graphqlSync({ schema: sdl, source: getIntrospectionQuery() })
  const responseText = JSON.stringify(introspectionResult)

  it('returns data usable by buildClientSchema', () => {
    const data = extractIntrospectionData(responseText)
    expect(data).not.toBeNull()
    const schema = buildClientSchema(data as never)
    expect(schema.getQueryType()?.name).toBe('Query')
  })

  it('accepts a bare __schema and rejects non-introspection', () => {
    const bare = JSON.stringify({ __schema: (introspectionResult.data as { __schema: unknown }).__schema })
    expect(extractIntrospectionData(bare)).not.toBeNull()
    expect(extractIntrospectionData('nope')).toBeNull()
    expect(extractIntrospectionData(JSON.stringify({ data: {} }))).toBeNull()
  })

  it('FULL_INTROSPECTION_QUERY is the canonical full query', () => {
    expect(FULL_INTROSPECTION_QUERY).toContain('IntrospectionQuery')
    expect(FULL_INTROSPECTION_QUERY).toContain('__schema')
  })
})
