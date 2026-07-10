import { createServer, type Server } from 'node:net'
import type { AddressInfo } from 'node:net'
import Aedes from 'aedes'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MqttSubscribeClient, publishMqtt } from './mqtt'

let broker: Aedes
let server: Server
let host = '127.0.0.1'
let port = 0

beforeAll(async () => {
  broker = new Aedes()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server = createServer(broker.handle as any)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await new Promise<void>((resolve) => broker.close(() => resolve()))
})

describe('publishMqtt', () => {
  it('connects, publishes, and disconnects', async () => {
    const res = await publishMqtt({ host, port, topic: 'freepost/test', message: 'hi', qos: 1 })
    expect(res.ok).toBe(true)
    expect(res.error).toBeUndefined()
  })

  it('reports an error when the broker is unreachable', async () => {
    const res = await publishMqtt({ host, port: 1, topic: 't', message: 'm' })
    expect(res.ok).toBe(false)
    expect(res.error).toBeDefined()
  })
})

describe('MqttSubscribeClient', () => {
  it('receives a published message on its topic', async () => {
    const got = await new Promise<{ topic: string; payload: string }>((resolve, reject) => {
      const sub = new MqttSubscribeClient()
      const timer = setTimeout(() => reject(new Error('timeout')), 4000)
      sub
        .on('open', () => {
          // Publish only once the subscription is live.
          void publishMqtt({ host, port, topic: 'sensors/temp', message: '{"c":21}', qos: 1 })
        })
        .on('message', (msg) => {
          clearTimeout(timer)
          sub.close()
          resolve(msg)
        })
        .on('error', (e) => {
          clearTimeout(timer)
          reject(e)
        })
        .connect({ host, port, topic: 'sensors/#', qos: 1 })
    })
    expect(got.topic).toBe('sensors/temp')
    expect(got.payload).toBe('{"c":21}')
  })
})
