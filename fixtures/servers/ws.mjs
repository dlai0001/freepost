/**
 * Fixture: a WebSocket server for .ws requests (port 3013).
 *
 * Echoes every message back as {"echo": <text>}, and pushes a {"tick": n}
 * message every 2s so a subscription pane has something to show.
 */
import { WebSocketServer } from 'ws'

const PORT = Number(process.env.PORT ?? 3013)
const wss = new WebSocketServer({ port: PORT })

wss.on('connection', (socket) => {
  console.log('[ws] client connected')
  socket.send(JSON.stringify({ hello: 'from the freepost ws fixture' }))

  let n = 0
  const timer = setInterval(() => socket.send(JSON.stringify({ tick: ++n })), 2000)

  socket.on('message', (data) => {
    const text = data.toString()
    console.log('[ws] <-', text)
    socket.send(JSON.stringify({ echo: text }))
  })

  socket.on('close', () => {
    clearInterval(timer)
    console.log('[ws] client disconnected')
  })
})

console.log(`[ws] WebSocket fixture on ws://localhost:${PORT}`)
