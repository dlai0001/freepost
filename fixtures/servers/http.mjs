/**
 * Fixture: a tiny REST API for .curl requests (port 3010).
 *
 *   GET  /health          -> { ok: true }
 *   GET  /users           -> [ ... ]
 *   GET  /users/:id       -> user | 404
 *   POST /users           -> 201 + the created user (echoes the JSON body)
 *   GET  /slow?ms=500     -> delayed response (timeout testing)
 *   GET  /status/:code    -> responds with that status code
 *   Any  /echo            -> echoes method, headers, query and body
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 3010)

const users = [
  { id: 1, name: 'Ada Lovelace', email: 'ada@example.com' },
  { id: 2, name: 'Alan Turing', email: 'alan@example.com' }
]

const json = (res, code, body) => {
  const text = JSON.stringify(body, null, 2)
  res.writeHead(code, { 'content-type': 'application/json', 'x-fixture': 'http' })
  res.end(text)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const path = url.pathname
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')

  if (path === '/health') return json(res, 200, { ok: true, server: 'http' })

  if (path === '/users' && req.method === 'GET') return json(res, 200, users)

  if (path === '/users' && req.method === 'POST') {
    let body
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      return json(res, 400, { error: 'invalid JSON body' })
    }
    const created = { id: users.length + 1, ...body }
    users.push(created)
    return json(res, 201, created)
  }

  const userMatch = path.match(/^\/users\/(\d+)$/)
  if (userMatch !== null && req.method === 'GET') {
    const user = users.find((u) => u.id === Number(userMatch[1]))
    return user ? json(res, 200, user) : json(res, 404, { error: 'not found' })
  }

  if (path === '/slow') {
    const ms = Number(url.searchParams.get('ms') ?? 500)
    await new Promise((r) => setTimeout(r, ms))
    return json(res, 200, { sleptMs: ms })
  }

  const statusMatch = path.match(/^\/status\/(\d{3})$/)
  if (statusMatch !== null) return json(res, Number(statusMatch[1]), { status: Number(statusMatch[1]) })

  if (path === '/echo') {
    return json(res, 200, {
      method: req.method,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body: raw
    })
  }

  json(res, 404, { error: `no fixture route for ${req.method} ${path}` })
})

server.listen(PORT, () => {
  console.log(`[http] REST fixture on http://localhost:${PORT}`)
  console.log('[http] routes: /health /users /users/:id /slow?ms= /status/:code /echo')
})
