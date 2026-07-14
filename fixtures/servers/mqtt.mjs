/**
 * Fixture: an MQTT broker for .mqtt requests (port 1883).
 *
 * Publishes a heartbeat to `freepost/tick` every 2s so a subscribe request has
 * traffic to show, and logs everything clients publish.
 */
import { createServer } from 'node:net'
import Aedes from 'aedes'

const PORT = Number(process.env.PORT ?? 1883)

const broker = new Aedes()
const server = createServer(broker.handle)

broker.on('client', (c) => console.log('[mqtt] client connected:', c.id))
broker.on('clientDisconnect', (c) => console.log('[mqtt] client disconnected:', c.id))
broker.on('publish', (packet, client) => {
  if (client === null || client === undefined) return // broker's own heartbeat
  console.log(`[mqtt] <- ${client.id} ${packet.topic}: ${packet.payload.toString()}`)
})

server.listen(PORT, () => {
  console.log(`[mqtt] MQTT broker fixture on mqtt://localhost:${PORT}`)
  console.log('[mqtt] heartbeat topic: freepost/tick — publish anywhere, e.g. freepost/demo')
})

let n = 0
setInterval(() => {
  broker.publish({
    topic: 'freepost/tick',
    payload: Buffer.from(JSON.stringify({ tick: ++n, at: new Date().toISOString() })),
    qos: 0,
    retain: false
  })
}, 2000)
