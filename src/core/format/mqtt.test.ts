import { describe, expect, it } from 'vitest'
import { mapMosquittoCommand } from './mqtt'
import { parseRequestFile, writeRequestFile } from './index'
import type { CommandToken } from './shell'
import type { RequestFile } from '@shared/model'

const argv = (...words: string[]): CommandToken[] => words.map((text, i) => ({ text, line: i + 1 }))
function ok(...words: string[]) {
  const r = mapMosquittoCommand(argv(...words))
  if (!r.ok) throw new Error(`expected ok, got: ${JSON.stringify(r.errors)}`)
  return r.mqtt
}
function err(...words: string[]) {
  const r = mapMosquittoCommand(argv(...words))
  if (r.ok) throw new Error('expected error')
  return r.errors[0]
}

describe('mapMosquittoCommand', () => {
  it('parses a publish command', () => {
    const m = ok('mosquitto_pub', '-h', '${MQTT_HOST}', '-p', '8883', '-t', 'sensors/temp', '-q', '1', '-r', '-m', '{"c":21}')
    expect(m).toEqual({
      mode: 'publish',
      host: '${MQTT_HOST}',
      port: 8883,
      topic: 'sensors/temp',
      qos: 1,
      retain: true,
      message: '{"c":21}'
    })
  })

  it('parses a subscribe command with auth', () => {
    const m = ok('mosquitto_sub', '-h', 'broker', '-t', 'sensors/#', '-u', 'alice', '-P', 'pw', '-i', 'cli-1')
    expect(m).toEqual({
      mode: 'subscribe',
      host: 'broker',
      topic: 'sensors/#',
      username: 'alice',
      password: 'pw',
      clientId: 'cli-1'
    })
  })

  it('requires -m for publish', () => {
    expect(err('mosquitto_pub', '-h', 'x', '-t', 'y').message).toMatch(/requires -m/)
  })
  it('requires -h and -t', () => {
    expect(err('mosquitto_sub', '-t', 'y').message).toMatch(/requires -h/)
    expect(err('mosquitto_sub', '-h', 'x').message).toMatch(/requires -t/)
  })
  it('rejects an invalid QoS', () => {
    expect(err('mosquitto_sub', '-h', 'x', '-t', 'y', '-q', '5').message).toMatch(/invalid QoS/)
  })
  it('rejects an unknown flag', () => {
    expect(err('mosquitto_pub', '-h', 'x', '-t', 'y', '-m', 'z', '-Z').message).toMatch(/unsupported mosquitto flag/)
  })
  it('rejects a non-mosquitto command', () => {
    expect(err('curl', '-h', 'x').message).toMatch(/expected mosquitto_pub or mosquitto_sub/)
  })
})

describe('mqtt round-trip through parse/write', () => {
  it('round-trips a publish file', () => {
    const file: RequestFile = {
      kind: 'mqtt',
      frontmatter: { description: 'temp' },
      variables: [{ name: 'MQTT_HOST', defaultValue: 'localhost', required: false }],
      mqtt: {
        mode: 'publish',
        host: '${MQTT_HOST}',
        port: 1883,
        topic: 'sensors/temp',
        qos: 1,
        retain: true,
        message: '{"c":21}'
      },
      comments: []
    }
    const text = writeRequestFile(file)
    expect(text).toContain('mosquitto_pub')
    const parsed = parseRequestFile(text, 'mqtt')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.file.mqtt).toEqual(file.mqtt)
  })

  it('round-trips a subscribe file', () => {
    const file: RequestFile = {
      kind: 'mqtt',
      frontmatter: {},
      variables: [],
      mqtt: { mode: 'subscribe', host: 'broker', topic: 'sensors/#', qos: 2 },
      comments: []
    }
    const parsed = parseRequestFile(writeRequestFile(file), 'mqtt')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.file.mqtt).toEqual(file.mqtt)
  })
})
