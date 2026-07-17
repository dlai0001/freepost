/**
 * The relay is tested against a REAL broker (aedes, the fixtures' broker) with
 * a REAL client (mqtt.js) speaking through it: the whole design claim is that a
 * transparent relay preserves MQTT semantics it never implements, and only an
 * end-to-end round trip can show that. Relay fidelity is asserted first and
 * separately from the recording — a recorded packet list is worthless if the
 * client's messages didn't arrive.
 */
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import Aedes from 'aedes'
import { generate } from 'mqtt-packet'
import mqtt from 'mqtt'
import type { MqttClient } from 'mqtt'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RecordedExchange } from '../shared/model'
import { MQTT_PACKET_CAP, MqttRecordProxy } from './mqtt-proxy'

let broker: Aedes
let brokerServer: Server
let brokerPort = 0

beforeAll(async () => {
  broker = new Aedes()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  brokerServer = createServer(broker.handle as any)
  await new Promise<void>((resolve) => brokerServer.listen(0, '127.0.0.1', resolve))
  brokerPort = (brokerServer.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => brokerServer.close(() => resolve()))
  await new Promise<void>((resolve) => broker.close(() => resolve()))
})

/** A started relay plus the exchanges it emitted, stopped by the caller. */
async function startRelay(
  target = `mqtt://127.0.0.1:${brokerPort}`
): Promise<{ proxy: MqttRecordProxy; port: number; exchanges: RecordedExchange[] }> {
  const proxy = new MqttRecordProxy()
  const exchanges: RecordedExchange[] = []
  proxy.on('exchange', (e) => exchanges.push(e))
  const { port } = await proxy.start({ target })
  return { proxy, port, exchanges }
}

/** Resolves once `check` holds, so a test never sleeps a fixed guess. */
async function until(check: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition')
    await new Promise((r) => setTimeout(r, 10))
  }
}

function connect(port: number, opts: mqtt.IClientOptions = {}): MqttClient {
  return mqtt.connect(`mqtt://127.0.0.1:${port}`, { reconnectPeriod: 0, ...opts })
}

async function ended(client: MqttClient): Promise<void> {
  await new Promise<void>((resolve) => client.end(false, {}, () => resolve()))
}

describe('MqttRecordProxy — relay fidelity', () => {
  it('carries a publish/subscribe round trip through to the real broker', async () => {
    const { proxy, port } = await startRelay()
    const sub = connect(port)
    const received: { topic: string; payload: string }[] = []
    await new Promise<void>((resolve, reject) => {
      sub.on('error', reject)
      sub.on('connect', () => sub.subscribe('freepost/relay', { qos: 0 }, (e) => (e ? reject(e) : resolve())))
    })
    sub.on('message', (topic, payload) => received.push({ topic, payload: payload.toString() }))

    // Publishing through the relay too: both legs are relayed sockets.
    const pub = connect(port)
    await new Promise<void>((resolve, reject) => {
      pub.on('error', reject)
      pub.on('connect', () => resolve())
    })
    pub.publish('freepost/relay', 'hello', { qos: 0 })

    await until(() => received.length > 0)
    expect(received[0]).toEqual({ topic: 'freepost/relay', payload: 'hello' })

    await ended(sub)
    await ended(pub)
    await proxy.stop()
  })

  it('preserves QoS 1 delivery (the broker, not the relay, acks)', async () => {
    const { proxy, port } = await startRelay()
    const sub = connect(port)
    const received: string[] = []
    await new Promise<void>((resolve, reject) => {
      sub.on('error', reject)
      sub.on('connect', () => sub.subscribe('freepost/qos1', { qos: 1 }, (e) => (e ? reject(e) : resolve())))
    })
    sub.on('message', (_t, payload) => received.push(payload.toString()))

    const pub = connect(port)
    await new Promise<void>((resolve, reject) => {
      pub.on('error', reject)
      pub.on('connect', () => resolve())
    })
    // The callback only fires on the broker's PUBACK — proof the ack round
    // trip survived the relay rather than being faked by it.
    await new Promise<void>((resolve, reject) => {
      pub.publish('freepost/qos1', 'acked', { qos: 1 }, (e) => (e ? reject(e) : resolve()))
    })
    await until(() => received.length > 0)
    expect(received).toEqual(['acked'])

    await ended(sub)
    await ended(pub)
    await proxy.stop()
  })

  it('preserves retained messages (broker state the relay never models)', async () => {
    const { proxy, port } = await startRelay()
    const pub = connect(port)
    await new Promise<void>((resolve, reject) => {
      pub.on('error', reject)
      pub.on('connect', () =>
        pub.publish('freepost/retained', 'kept', { qos: 1, retain: true }, (e) => (e ? reject(e) : resolve()))
      )
    })
    await ended(pub)

    // A subscriber connecting AFTER the publish still gets it — only the real
    // broker can do that, so this is the transparency claim under test.
    const sub = connect(port)
    const got = await new Promise<string>((resolve, reject) => {
      sub.on('error', reject)
      sub.on('message', (_t, payload) => resolve(payload.toString()))
      sub.on('connect', () => sub.subscribe('freepost/retained', (e) => (e ? reject(e) : undefined)))
    })
    expect(got).toBe('kept')

    await ended(sub)
    await proxy.stop()
  })
})

describe('MqttRecordProxy — recording', () => {
  it('records one exchange per connection, with the packets that went past', async () => {
    const { proxy, port, exchanges } = await startRelay()
    const client = connect(port, { clientId: 'recorder-1' })
    await new Promise<void>((resolve, reject) => {
      client.on('error', reject)
      client.on('connect', () => client.subscribe('freepost/rec', { qos: 1 }, (e) => (e ? reject(e) : resolve())))
    })
    await new Promise<void>((resolve, reject) => {
      client.publish('freepost/rec', 'payload-here', { qos: 1, retain: true }, (e) => (e ? reject(e) : resolve()))
    })
    await ended(client)
    await until(() => exchanges.length > 0)
    await proxy.stop()

    const e = exchanges[0]
    expect(e.protocol).toBe('mqtt')
    expect(e.method).toBe('MQTT')
    expect(e.url).toBe(`mqtt://127.0.0.1:${brokerPort}`)
    // No HTTP status on an MQTT session — the UI must not print one.
    expect(e.status).toBeUndefined()
    expect(e.mqtt?.clientId).toBe('recorder-1')
    expect(e.mqtt?.protocolVersion).toBe(4)
    // A clean client.end() sends DISCONNECT, so the session is not errored.
    expect(e.errored).toBe(false)

    const types = e.mqtt?.packets.map((p) => p.type) ?? []
    expect(types).toContain('connect')
    expect(types).toContain('connack')
    expect(types).toContain('subscribe')
    expect(types).toContain('suback')
    expect(types).toContain('publish')
    expect(types).toContain('disconnect')

    // Direction is as seen from the client, like the gRPC message capture.
    const connectPacket = e.mqtt?.packets.find((p) => p.type === 'connect')
    expect(connectPacket?.dir).toBe('send')
    expect(e.mqtt?.packets.find((p) => p.type === 'connack')?.dir).toBe('recv')
    expect(typeof connectPacket?.at).toBe('string')

    const sent = e.mqtt?.packets.find((p) => p.type === 'publish' && p.dir === 'send')
    expect(sent?.topic).toBe('freepost/rec')
    expect(sent?.preview).toBe('payload-here')
    expect(sent?.qos).toBe(1)
    expect(sent?.retain).toBe(true)
    expect(sent?.base64).toBeUndefined()
    expect(sent?.truncated).toBeUndefined()

    const subscribe = e.mqtt?.packets.find((p) => p.type === 'subscribe')
    expect(subscribe?.topic).toBe('freepost/rec')
    expect(subscribe?.qos).toBe(1)
  })

  it('previews a binary payload as base64 and caps a large one', async () => {
    const { proxy, port, exchanges } = await startRelay()
    const client = connect(port)
    await new Promise<void>((resolve, reject) => {
      client.on('error', reject)
      client.on('connect', () => resolve())
    })
    await new Promise<void>((resolve, reject) => {
      client.publish('freepost/bin', Buffer.from([0x00, 0x01, 0x02, 0xff]), { qos: 1 }, (e) =>
        e ? reject(e) : resolve()
      )
    })
    await new Promise<void>((resolve, reject) => {
      client.publish('freepost/big', 'x'.repeat(8 * 1024), { qos: 1 }, (e) => (e ? reject(e) : resolve()))
    })
    await ended(client)
    await until(() => exchanges.length > 0)
    await proxy.stop()

    const packets = exchanges[0].mqtt?.packets ?? []
    const bin = packets.find((p) => p.topic === 'freepost/bin' && p.dir === 'send')
    expect(bin?.base64).toBe(true)
    expect(bin?.preview).toBe(Buffer.from([0x00, 0x01, 0x02, 0xff]).toString('base64'))

    const big = packets.find((p) => p.topic === 'freepost/big' && p.dir === 'send')
    expect(big?.truncated).toBe(true)
    expect(big?.preview?.length).toBe(2 * 1024)
  })

  it('caps the packet list without dropping the connection', async () => {
    const { proxy, port, exchanges } = await startRelay()
    const client = connect(port, { clientId: 'chatty' })
    await new Promise<void>((resolve, reject) => {
      client.on('error', reject)
      client.on('connect', () => resolve())
    })
    // Well past MQTT_PACKET_CAP, at QoS 1 so each publish is acked: the last
    // one resolving proves the relay still worked after the cap was hit.
    for (let i = 0; i < MQTT_PACKET_CAP + 40; i++) {
      await new Promise<void>((resolve, reject) => {
        client.publish('freepost/cap', String(i), { qos: 1 }, (e) => (e ? reject(e) : resolve()))
      })
    }
    await ended(client)
    await until(() => exchanges.length > 0)
    await proxy.stop()

    expect(exchanges[0].mqtt?.packets.length).toBe(MQTT_PACKET_CAP)
    expect(exchanges[0].mqtt?.clientId).toBe('chatty')
  })

  it('marks an abnormal close errored (no DISCONNECT), like a 1006 WS close', async () => {
    const { proxy, port, exchanges } = await startRelay()
    const client = connect(port)
    await new Promise<void>((resolve, reject) => {
      client.on('error', reject)
      client.on('connect', () => resolve())
    })
    // Kill the socket under the client: no DISCONNECT reaches the broker.
    client.stream.destroy()
    await until(() => exchanges.length > 0)
    await proxy.stop()

    expect(exchanges[0].errored).toBe(true)
    expect(exchanges[0].error).toContain('DISCONNECT')
    client.end(true)
  })

  it('records an errored session when the broker is unreachable', async () => {
    const { proxy, port, exchanges } = await startRelay('mqtt://127.0.0.1:1')
    const client = connect(port)
    client.on('error', () => undefined)
    await until(() => exchanges.length > 0)
    await proxy.stop()

    expect(exchanges[0].errored).toBe(true)
    expect(exchanges[0].error).toBeDefined()
    client.end(true)
  })

})

/**
 * MQTT 5 needs a hand-written peer on both ends: aedes (the fixtures' broker,
 * and the only one in devDependencies) speaks 3.1.1 only, and mqtt.js won't
 * proceed past its refusal. Generated packets are the honest substitute —
 * v5 frames a CONNECT, a PUBLISH and a CONNACK differently from 3.1.1, so
 * decoding them at all is what proves the version was picked up from the
 * CONNECT and applied to BOTH parsers.
 */
describe('MqttRecordProxy — MQTT 5', () => {
  let stub: Server
  let stubPort = 0

  beforeAll(async () => {
    // Answers the CONNECT with a v5 CONNACK, so the broker direction has a v5
    // frame to decode. Everything else it just swallows.
    stub = createServer((socket) => {
      socket.once('data', () => socket.write(generate({ cmd: 'connack', sessionPresent: false, reasonCode: 0 }, { protocolVersion: 5 })))
    })
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
    stubPort = (stub.address() as AddressInfo).port
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => stub.close(() => resolve()))
  })

  it('decodes both directions at the version the CONNECT declared', async () => {
    const { proxy, port, exchanges } = await startRelay(`mqtt://127.0.0.1:${stubPort}`)
    const socket = createConnection({ host: '127.0.0.1', port })
    let sawConnack = false
    socket.on('data', () => (sawConnack = true))
    await new Promise<void>((resolve, reject) => {
      socket.on('error', reject)
      socket.on('connect', () => resolve())
    })
    const v5 = { protocolVersion: 5 } as const
    socket.write(generate({ cmd: 'connect', protocolId: 'MQTT', protocolVersion: 5, clientId: 'v5-client', clean: true, keepalive: 0 }, v5))
    // A v5 PUBLISH carries a property-length byte a 3.1.1 parser would read as
    // payload — an exact payload match means it was parsed as v5.
    socket.write(generate({ cmd: 'publish', topic: 'freepost/v5', payload: Buffer.from('five'), qos: 0, dup: false, retain: false }, v5))
    socket.write(generate({ cmd: 'disconnect', reasonCode: 0 }, v5))

    // The reply proves every client packet has been through the tee already —
    // the stub only writes once it has received them. The exchange itself is
    // emitted on close, so the socket has to go first.
    await until(() => sawConnack)
    socket.end()
    await until(() => exchanges.length > 0)
    await proxy.stop()

    const e = exchanges[0]
    expect(e.mqtt?.protocolVersion).toBe(5)
    expect(e.mqtt?.clientId).toBe('v5-client')
    expect(e.errored).toBe(false) // a DISCONNECT went past — an orderly close
    expect(e.mqtt?.packets.find((p) => p.type === 'publish')?.preview).toBe('five')
    // The broker leg: a v4 parser mis-frames a v5 CONNACK's property block.
    expect(e.mqtt?.packets.find((p) => p.type === 'connack')?.dir).toBe('recv')
  })
})

describe('MqttRecordProxy — degradation', () => {
  it('keeps relaying garbage bytes it cannot decode, and does not throw', async () => {
    // The broker will reject this, but the relay must not be what breaks: a
    // decode failure is a display problem, never a transport one.
    const { proxy, port, exchanges } = await startRelay()
    const socket = createConnection({ host: '127.0.0.1', port })
    await new Promise<void>((resolve, reject) => {
      socket.on('error', reject)
      socket.on('connect', () => resolve())
    })
    socket.write(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x00, 0x13, 0x37]))
    // The listener survives: a second, well-formed session still works.
    const client = connect(port)
    await new Promise<void>((resolve, reject) => {
      client.on('error', reject)
      client.on('connect', () => resolve())
    })
    await ended(client)
    socket.destroy()

    await until(() => exchanges.length >= 2)
    await proxy.stop()
    expect(proxy.state).toBe('stopped')
    // The garbage session recorded at all, rather than crashing anything — and
    // without an invented outcome: its decoder died, so the relay never knew
    // how the client closed and does not claim to.
    const garbage = exchanges.find((e) => (e.mqtt?.clientId ?? '') === '')
    expect(garbage).toBeDefined()
    expect(garbage?.errored).toBe(false)
  })

  it('does not blame the session for a decode failure: a clean DISCONNECT is not errored', async () => {
    // The parser is a display tee. Once garbage has killed it, the relay can no
    // longer SEE the client's DISCONNECT — but the client still sent one, and a
    // recorded 'closed without DISCONNECT' would be the relay reporting its own
    // blind spot as the peer's fault.
    //
    // A silent broker rather than aedes: aedes drops the connection over the
    // garbage, and a transport failure is a real recorded error — this is about
    // what the DECODER's failure alone implies, so the transport must stay
    // clean. It answers nothing and closes back on the client's half-close.
    const upstreams: Socket[] = []
    const silent = createServer((s) => {
      upstreams.push(s)
      s.on('end', () => s.end())
    })
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
    const { proxy, port, exchanges } = await startRelay(
      `mqtt://127.0.0.1:${(silent.address() as AddressInfo).port}`
    )
    const socket = createConnection({ host: '127.0.0.1', port })
    await new Promise<void>((resolve, reject) => {
      socket.on('error', reject)
      socket.on('connect', () => resolve())
    })
    // Wire type 15 with a nonsense remaining length: kills the send parser.
    socket.write(Buffer.from([0xf0, 0xff, 0xff, 0xff, 0xff, 0x7f]))
    socket.write(generate({ cmd: 'disconnect' }, { protocolVersion: 4 }))
    socket.end()

    await until(() => exchanges.length > 0)
    await proxy.stop()
    for (const s of upstreams) s.destroy()
    await new Promise<void>((resolve) => silent.close(() => resolve()))
    expect(exchanges[0].errored).toBe(false)
    expect(exchanges[0].error).toBeUndefined()
    // Not blaming the client is only half of it: the packet list stops where
    // the decoder did, so the session has to say so rather than look quiet.
    expect(exchanges[0].mqtt?.decodeStopped).toEqual(['send'])
  })

  it('leaves decodeStopped off a session it decoded to the end', async () => {
    const { proxy, port, exchanges } = await startRelay()
    const client = connect(port)
    await new Promise<void>((resolve, reject) => {
      client.on('error', reject)
      client.on('connect', () => resolve())
    })
    await ended(client)
    await until(() => exchanges.length > 0)
    await proxy.stop()
    // Absence is the signal a full capture carries — and what every recording
    // made before the field existed reads as.
    expect(exchanges[0].mqtt?.decodeStopped).toBeUndefined()
  })

  it('rejects a TLS broker rather than silently relaying cleartext to it', async () => {
    const proxy = new MqttRecordProxy()
    await expect(proxy.start({ target: 'mqtts://127.0.0.1:8883' })).rejects.toThrow(/mqtts/)
    expect(proxy.state).toBe('idle')
  })

  it('rejects an unparseable broker address', async () => {
    const proxy = new MqttRecordProxy()
    await expect(proxy.start({ target: 'http://example.com' })).rejects.toThrow(/mqtt:\/\//)
    await expect(proxy.start({ target: '' })).rejects.toThrow(/required/)
  })

  it('refuses to start twice, and stops cleanly', async () => {
    const { proxy, port } = await startRelay()
    expect(proxy.state).toBe('listening')
    expect(proxy.port).toBe(port)
    await expect(proxy.start({ target: `mqtt://127.0.0.1:${brokerPort}` })).rejects.toThrow(/already running/)
    await proxy.stop()
    expect(proxy.state).toBe('stopped')
    expect(proxy.port).toBeUndefined()
  })
})
