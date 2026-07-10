import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server, type AddressInfo } from 'node:net'
import Aedes from 'aedes'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writeRequestFile } from '../core/format'
import type { RequestFile } from '../shared/model'
import { executeRequest } from './execute'

let broker: Aedes
let server: Server
let port = 0
let root = ''

beforeAll(async () => {
  broker = new Aedes()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server = createServer(broker.handle as any)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
  root = mkdtempSync(join(tmpdir(), 'freepost-execmqtt-'))
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  await new Promise<void>((r) => broker.close(() => r()))
  rmSync(root, { recursive: true, force: true })
})

function writeMqtt(rel: string, file: RequestFile): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, writeRequestFile(file))
}

describe('executeRequest for .mqtt', () => {
  it('publishes a message and reports success, with a passing test script', async () => {
    // Confirm delivery by subscribing on the broker directly.
    const delivered = new Promise<string>((resolve) => {
      broker.subscribe('sensors/temp', (packet, cb) => {
        resolve(packet.payload.toString())
        cb()
      }, () => undefined)
    })
    writeMqtt('Pub.mqtt', {
      kind: 'mqtt',
      frontmatter: {
        scripts: { test: 'pm.test("ok", () => pm.expect(pm.response.json().published).to.equal(true));' }
      },
      variables: [{ name: 'MQTT_HOST', defaultValue: '127.0.0.1', required: false }],
      mqtt: { mode: 'publish', host: '${MQTT_HOST}', port, topic: 'sensors/temp', qos: 1, message: '{"c":21}' },
      comments: []
    })
    const report = await executeRequest({ root, path: 'Pub.mqtt', session: new Map() })
    expect(report.errored).toBe(false)
    expect(report.response?.statusText).toBe('PUBLISHED')
    expect(report.testScript?.tests).toEqual([{ name: 'ok', passed: true }])
    expect(await delivered).toBe('{"c":21}')
  })

  it('errors when the broker is unreachable', async () => {
    writeMqtt('Bad.mqtt', {
      kind: 'mqtt',
      frontmatter: {},
      variables: [],
      mqtt: { mode: 'publish', host: '127.0.0.1', port: 1, topic: 't', message: 'm' },
      comments: []
    })
    const report = await executeRequest({ root, path: 'Bad.mqtt', session: new Map() })
    expect(report.errored).toBe(true)
    expect(report.response?.status).toBe(500)
  })

  it('rejects subscribe as not one-shot runnable', async () => {
    writeMqtt('Sub.mqtt', {
      kind: 'mqtt',
      frontmatter: {},
      variables: [],
      mqtt: { mode: 'subscribe', host: '127.0.0.1', port, topic: 'sensors/#' },
      comments: []
    })
    const report = await executeRequest({ root, path: 'Sub.mqtt', session: new Map() })
    expect(report.errored).toBe(true)
    expect(report.transportError).toMatch(/not one-shot/)
  })
})
