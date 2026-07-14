/**
 * Fixture: a GraphQL server for GraphQL-mode .curl requests (port 3014).
 *
 *   POST http://localhost:3014/graphql   — queries, mutations, introspection
 *   ws://localhost:3014/graphql          — subscriptions (graphql-transport-ws)
 *
 * Schema:
 *   query    { hello(name: String): String, users: [User!]!, user(id: ID!): User }
 *   mutation { addUser(name: String!, email: String!): User! }
 *   subscription { ticks: Int! }
 */
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { useServer } from 'graphql-ws/use/ws'
import { buildSchema, execute, subscribe } from 'graphql'

const PORT = Number(process.env.PORT ?? 3014)

const schema = buildSchema(`
  type User { id: ID!, name: String!, email: String! }
  type Query {
    hello(name: String): String!
    users: [User!]!
    user(id: ID!): User
  }
  type Mutation { addUser(name: String!, email: String!): User! }
  type Subscription { ticks: Int! }
`)

const users = [
  { id: '1', name: 'Ada Lovelace', email: 'ada@example.com' },
  { id: '2', name: 'Alan Turing', email: 'alan@example.com' }
]

const roots = {
  hello: ({ name }) => `Hello ${name ?? 'world'}`,
  users: () => users,
  user: ({ id }) => users.find((u) => u.id === String(id)) ?? null,
  addUser: ({ name, email }) => {
    const created = { id: String(users.length + 1), name, email }
    users.push(created)
    return created
  },
  ticks: async function* () {
    let n = 0
    while (true) {
      await new Promise((r) => setTimeout(r, 1000))
      yield { ticks: ++n }
    }
  }
}

const http = createServer(async (req, res) => {
  if (req.url?.startsWith('/health')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, server: 'graphql' }))
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405).end()
    return
  }
  const chunks = []
  for await (const c of req) chunks.push(c)
  let body
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ errors: [{ message: 'invalid JSON body' }] }))
    return
  }
  const { parse } = await import('graphql')
  let document
  try {
    document = parse(body.query ?? '')
  } catch (e) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ errors: [{ message: e.message }] }))
    return
  }
  const result = await execute({
    schema,
    document,
    rootValue: roots,
    variableValues: body.variables ?? {},
    operationName: body.operationName
  })
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(result, null, 2))
})

const wss = new WebSocketServer({ server: http, path: '/graphql' })
useServer({ schema, roots: { subscription: roots }, execute, subscribe }, wss)

http.listen(PORT, () => {
  console.log(`[graphql] GraphQL fixture on http://localhost:${PORT}/graphql`)
  console.log(`[graphql] subscriptions on ws://localhost:${PORT}/graphql — subscription { ticks }`)
})
