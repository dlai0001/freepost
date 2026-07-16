import { describe, expect, it } from 'vitest'
import { classifyExchange, HOP_BY_HOP_HEADERS, isGrpcContentType } from './classify'

describe('classifyExchange', () => {
  it('classifies plain requests as rest', () => {
    expect(classifyExchange({}, { contentType: 'application/json' })).toEqual({ protocol: 'rest' })
    expect(
      classifyExchange(
        { contentType: 'application/json', bodyText: '{"name":"Ada"}' },
        { contentType: 'text/html' }
      )
    ).toEqual({ protocol: 'rest' })
  })

  it('classifies application/grpc* content types as grpc, ahead of everything', () => {
    expect(classifyExchange({ contentType: 'application/grpc' })).toEqual({ protocol: 'grpc' })
    expect(classifyExchange({ contentType: 'application/grpc+proto' })).toEqual({ protocol: 'grpc' })
    // Even with a GraphQL-looking body: the content type is authoritative.
    expect(
      classifyExchange({ contentType: 'application/grpc', bodyText: '{"query":"{ x }"}' }).protocol
    ).toBe('grpc')
  })

  it('does NOT classify grpc-web as grpc — it is HTTP/1.1-framed and replayable', () => {
    expect(classifyExchange({ contentType: 'application/grpc-web' }).protocol).toBe('rest')
    expect(classifyExchange({ contentType: 'application/grpc-web+proto' }).protocol).toBe('rest')
    expect(classifyExchange({ contentType: 'application/grpc-web-text' }).protocol).toBe('rest')
    expect(isGrpcContentType('application/grpc')).toBe(true)
    expect(isGrpcContentType('application/grpc+json')).toBe(true)
    expect(isGrpcContentType('application/grpc-web+proto')).toBe(false)
    expect(isGrpcContentType(undefined)).toBe(false)
  })

  it('classifies a JSON body with a top-level query string as graphql', () => {
    const c = classifyExchange({
      contentType: 'application/json',
      bodyText: JSON.stringify({ query: 'query GetUser($id: ID!) { user(id: $id) { name } }' })
    })
    expect(c.protocol).toBe('graphql')
    expect(c.graphql).toEqual({ operationName: 'GetUser', operationType: 'query' })
  })

  it('prefers the payload operationName field over the parsed one', () => {
    const c = classifyExchange({
      bodyText: JSON.stringify({
        query: 'query A { a } mutation B { b }',
        operationName: 'B'
      })
    })
    expect(c.graphql).toEqual({ operationName: 'B', operationType: 'mutation' })
  })

  it('parses name and type from the query text when operationName is absent', () => {
    const c = classifyExchange({ bodyText: JSON.stringify({ query: 'mutation AddUser { add }' }) })
    expect(c.graphql).toEqual({ operationName: 'AddUser', operationType: 'mutation' })
  })

  it('handles anonymous shorthand queries', () => {
    const c = classifyExchange({ bodyText: JSON.stringify({ query: '{ users { id } }' }) })
    expect(c.protocol).toBe('graphql')
    expect(c.graphql).toEqual({ operationType: 'query' })
  })

  it('keeps a payload operationName even when the query does not parse', () => {
    const c = classifyExchange({
      bodyText: JSON.stringify({ query: 'query Broken {', operationName: 'Broken' })
    })
    expect(c.protocol).toBe('graphql')
    expect(c.graphql).toEqual({ operationName: 'Broken' })
  })

  it('does not treat a query field of the wrong type as graphql', () => {
    expect(classifyExchange({ bodyText: '{"query": 42}' }).protocol).toBe('rest')
    expect(classifyExchange({ bodyText: 'query { x }' }).protocol).toBe('rest')
  })

  it('classifies a text/event-stream response as sse', () => {
    expect(classifyExchange({}, { contentType: 'text/event-stream' })).toEqual({ protocol: 'sse' })
    expect(classifyExchange({}, { contentType: 'text/event-stream; charset=utf-8' }).protocol).toBe(
      'sse'
    )
  })

  it('falls back to rest when the upstream never responded', () => {
    expect(classifyExchange({ bodyText: 'hello' })).toEqual({ protocol: 'rest' })
  })
})

describe('HOP_BY_HOP_HEADERS', () => {
  it('covers the RFC set plus proxy-connection', () => {
    for (const h of [
      'connection',
      'keep-alive',
      'te',
      'trailer',
      'transfer-encoding',
      'upgrade',
      'proxy-authorization',
      'proxy-connection'
    ]) {
      expect(HOP_BY_HOP_HEADERS.has(h)).toBe(true)
    }
    expect(HOP_BY_HOP_HEADERS.has('content-type')).toBe(false)
  })
})
