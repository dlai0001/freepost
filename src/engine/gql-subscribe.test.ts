import type { AddressInfo } from 'node:net'
import { createServer, type Server } from 'node:http'
import { WebSocketServer } from 'ws'
import {
  execute,
  subscribe,
  GraphQLInt,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString
} from 'graphql'
import { useServer } from 'graphql-ws/use/ws'
import { createHandler } from 'graphql-sse/lib/use/http'
import { afterEach, describe, expect, it } from 'vitest'
import { subscribeGraphql } from './gql-subscribe'

const wsServers: WebSocketServer[] = []
const httpServers: Server[] = []

afterEach(async () => {
  await Promise.all(
    wsServers.splice(0).map(
      (wss) =>
        new Promise<void>((resolve) => {
          for (const c of wss.clients) c.terminate()
          wss.close(() => resolve())
        })
    )
  )
  await Promise.all(
    httpServers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  )
})

/** Schema with a `countdown(from)` subscription yielding from..0 then completing. */
function makeSchema(): GraphQLSchema {
  return new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'Query',
      fields: { hello: { type: GraphQLString, resolve: () => 'world' } }
    }),
    subscription: new GraphQLObjectType({
      name: 'Subscription',
      fields: {
        countdown: {
          type: GraphQLInt,
          args: { from: { type: GraphQLInt } },
          // eslint-disable-next-line @typescript-eslint/require-await
          subscribe: async function* (_root, args: { from?: number }) {
            for (let i = args.from ?? 3; i >= 0; i--) yield { countdown: i }
          }
        },
        // Emits slowly and near-indefinitely so a dispose can interrupt it.
        ticker: {
          type: GraphQLInt,
          subscribe: async function* () {
            for (let i = 0; i < 1000; i++) {
              yield { ticker: i }
              await new Promise((r) => setTimeout(r, 20))
            }
          }
        }
      }
    })
  })
}

function countdownOf(payload: unknown): number {
  return (payload as { data: { countdown: number } }).data.countdown
}

describe('subscribeGraphql', () => {
  it('streams subscription payloads over WebSocket then completes', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    wsServers.push(wss)
    useServer({ schema: makeSchema(), execute, subscribe }, wss)
    await new Promise<void>((r) => wss.on('listening', () => r()))
    const { port } = wss.address() as AddressInfo

    const got: number[] = []
    await new Promise<void>((resolve, reject) => {
      subscribeGraphql(
        {
          url: `ws://127.0.0.1:${port}`,
          transport: 'ws',
          query: 'subscription { countdown(from: 3) }'
        },
        { next: (p) => got.push(countdownOf(p)), error: reject, complete: resolve }
      )
    })
    expect(got).toEqual([3, 2, 1, 0])
  })

  it('streams subscription payloads over SSE then completes', async () => {
    const handler = createHandler({ schema: makeSchema() })
    const server = createServer((req, res) => void handler(req, res))
    httpServers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const { port } = server.address() as AddressInfo

    const got: number[] = []
    await new Promise<void>((resolve, reject) => {
      subscribeGraphql(
        {
          url: `http://127.0.0.1:${port}/graphql/stream`,
          transport: 'sse',
          query: 'subscription { countdown(from: 2) }'
        },
        { next: (p) => got.push(countdownOf(p)), error: reject, complete: resolve }
      )
    })
    expect(got).toEqual([2, 1, 0])
  })

  it('passes variables through to the subscription', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    wsServers.push(wss)
    useServer({ schema: makeSchema(), execute, subscribe }, wss)
    await new Promise<void>((r) => wss.on('listening', () => r()))
    const { port } = wss.address() as AddressInfo

    const got: number[] = []
    await new Promise<void>((resolve, reject) => {
      subscribeGraphql(
        {
          url: `ws://127.0.0.1:${port}`,
          transport: 'ws',
          query: 'subscription C($n: Int) { countdown(from: $n) }',
          variables: { n: 1 }
        },
        { next: (p) => got.push(countdownOf(p)), error: reject, complete: resolve }
      )
    })
    expect(got).toEqual([1, 0])
  })

  it('reports an error for an unreachable WebSocket endpoint', async () => {
    // Bind then close to obtain a dead port.
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((r) => wss.on('listening', () => r()))
    const { port } = wss.address() as AddressInfo
    await new Promise<void>((r) => wss.close(() => r()))

    const err = await new Promise<Error>((resolve) => {
      subscribeGraphql(
        { url: `ws://127.0.0.1:${port}`, transport: 'ws', query: 'subscription { countdown }' },
        {
          next: () => undefined,
          error: (e) => resolve(e),
          complete: () => resolve(new Error('unexpected complete'))
        }
      )
    })
    expect(err).toBeInstanceOf(Error)
  })

  it('stops delivering after dispose()', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    wsServers.push(wss)
    useServer({ schema: makeSchema(), execute, subscribe }, wss)
    await new Promise<void>((r) => wss.on('listening', () => r()))
    const { port } = wss.address() as AddressInfo

    let count = 0
    let dispose: () => void = () => undefined
    dispose = subscribeGraphql(
      { url: `ws://127.0.0.1:${port}`, transport: 'ws', query: 'subscription { ticker }' },
      {
        next: () => {
          count++
          if (count === 1) dispose()
        },
        error: () => undefined,
        complete: () => undefined
      }
    )
    // The ticker emits every 20ms; after disposing on the first payload, no
    // further payloads should arrive over the next several ticks.
    await new Promise<void>((r) => setTimeout(r, 150))
    expect(count).toBe(1)
  })
})
