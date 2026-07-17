import { describe, expect, it } from 'vitest'
import { mqttConnectIdentity, summarizeMqttPacket } from './mqtt-packets'
import type { MqttPacketLike } from './mqtt-packets'
import type { RecordedMqttPacket } from '@shared/model'

const AT = '2026-07-16T10:00:00.000Z'
const CAP = 2 * 1024

/** summarizeMqttPacket with the fixed dir/at/cap the tables don't vary. */
function sum(packet: MqttPacketLike, dir: 'send' | 'recv' = 'send'): RecordedMqttPacket {
  return summarizeMqttPacket(packet, dir, AT, CAP)
}

const bytes = (...b: number[]): Uint8Array => new Uint8Array(b)
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('summarizeMqttPacket', () => {
  const cases: { name: string; packet: MqttPacketLike; expected: RecordedMqttPacket }[] = [
    {
      name: 'a CONNECT (identity lives on the session, not the packet row)',
      packet: { cmd: 'connect', clientId: 'c-1', protocolVersion: 4, clean: true },
      expected: { dir: 'send', at: AT, type: 'connect' }
    },
    {
      name: 'a CONNACK',
      packet: { cmd: 'connack', returnCode: 0, sessionPresent: false },
      expected: { dir: 'send', at: AT, type: 'connack' }
    },
    {
      name: 'a PUBLISH with a text payload',
      packet: { cmd: 'publish', topic: 'a/b', qos: 0, retain: false, dup: false, payload: utf8('hello') },
      expected: { dir: 'send', at: AT, type: 'publish', topic: 'a/b', qos: 0, preview: 'hello' }
    },
    {
      name: 'a PUBLISH at QoS 1, retained, duplicated',
      packet: {
        cmd: 'publish',
        topic: 'a/b',
        qos: 1,
        retain: true,
        dup: true,
        messageId: 7,
        payload: utf8('{"n":1}')
      },
      expected: {
        dir: 'send',
        at: AT,
        type: 'publish',
        messageId: 7,
        topic: 'a/b',
        qos: 1,
        retain: true,
        dup: true,
        preview: '{"n":1}'
      }
    },
    {
      name: 'a PUBLISH whose payload is a string (generated, not parsed)',
      packet: { cmd: 'publish', topic: 'a/b', qos: 0, payload: 'stringly' },
      expected: { dir: 'send', at: AT, type: 'publish', topic: 'a/b', qos: 0, preview: 'stringly' }
    },
    {
      name: 'a PUBLISH with an empty payload (no preview, not an empty one)',
      packet: { cmd: 'publish', topic: 'a/b', qos: 0, payload: bytes() },
      expected: { dir: 'send', at: AT, type: 'publish', topic: 'a/b', qos: 0 }
    },
    {
      name: 'a PUBLISH with binary payload -> base64',
      packet: { cmd: 'publish', topic: 'a/b', qos: 0, payload: bytes(0x00, 0x01, 0xff) },
      expected: { dir: 'send', at: AT, type: 'publish', topic: 'a/b', qos: 0, preview: 'AAH/', base64: true }
    },
    {
      name: 'a PUBLISH with invalid UTF-8 -> base64',
      packet: { cmd: 'publish', topic: 'a/b', qos: 0, payload: bytes(0xc3, 0x28) },
      expected: { dir: 'send', at: AT, type: 'publish', topic: 'a/b', qos: 0, preview: 'wyg=', base64: true }
    },
    {
      name: 'a PUBLISH with multi-byte UTF-8 stays text',
      packet: { cmd: 'publish', topic: 'a/b', qos: 0, payload: utf8('héllo — ok') },
      expected: { dir: 'send', at: AT, type: 'publish', topic: 'a/b', qos: 0, preview: 'héllo — ok' }
    },
    {
      name: 'a SUBSCRIBE (topic is the first, preview lists them all)',
      packet: { cmd: 'subscribe', messageId: 2, subscriptions: [{ topic: 'a/#', qos: 1 }] },
      expected: {
        dir: 'send',
        at: AT,
        type: 'subscribe',
        messageId: 2,
        topic: 'a/#',
        qos: 1,
        preview: 'a/# (qos 1)'
      }
    },
    {
      name: 'a batched SUBSCRIBE',
      packet: {
        cmd: 'subscribe',
        messageId: 3,
        subscriptions: [
          { topic: 'a/#', qos: 0 },
          { topic: 'b/+', qos: 2 }
        ]
      },
      expected: {
        dir: 'send',
        at: AT,
        type: 'subscribe',
        messageId: 3,
        topic: 'a/#',
        qos: 0,
        preview: 'a/# (qos 0), b/+ (qos 2)'
      }
    },
    {
      name: 'an UNSUBSCRIBE',
      packet: { cmd: 'unsubscribe', messageId: 4, unsubscriptions: ['a/#', 'b/+'] },
      expected: { dir: 'send', at: AT, type: 'unsubscribe', messageId: 4, topic: 'a/#', preview: 'a/#, b/+' }
    },
    {
      name: 'a SUBACK',
      packet: { cmd: 'suback', messageId: 2, granted: [1] },
      expected: { dir: 'send', at: AT, type: 'suback', messageId: 2 }
    },
    {
      name: 'a PUBACK',
      packet: { cmd: 'puback', messageId: 7 },
      expected: { dir: 'send', at: AT, type: 'puback', messageId: 7 }
    },
    {
      name: 'a PINGREQ',
      packet: { cmd: 'pingreq' },
      expected: { dir: 'send', at: AT, type: 'pingreq' }
    },
    {
      name: 'a DISCONNECT',
      packet: { cmd: 'disconnect' },
      expected: { dir: 'send', at: AT, type: 'disconnect' }
    }
  ]

  for (const c of cases) {
    it(`summarizes ${c.name}`, () => {
      expect(sum(c.packet)).toEqual(c.expected)
    })
  }

  it('records the direction it is told', () => {
    expect(sum({ cmd: 'connack' }, 'recv').dir).toBe('recv')
  })

  it('caps a long payload and says so', () => {
    const out = sum({ cmd: 'publish', topic: 't', payload: utf8('x'.repeat(CAP + 100)) })
    expect(out.preview).toBe('x'.repeat(CAP))
    expect(out.truncated).toBe(true)
    expect(out.base64).toBeUndefined()
  })

  it('keeps a payload cut mid-codepoint readable rather than demoting it to base64', () => {
    // 'é' is 2 bytes: capping at an odd length lands inside it. A strict UTF-8
    // decode of that slice fails, which must not turn readable text binary.
    const out = summarizeMqttPacket({ cmd: 'publish', topic: 't', payload: utf8('éé') }, 'send', AT, 3)
    expect(out.preview).toBe('é')
    expect(out.truncated).toBe(true)
    expect(out.base64).toBeUndefined()
  })

  it('does not cap a payload that exactly fits', () => {
    const out = summarizeMqttPacket({ cmd: 'publish', topic: 't', payload: utf8('abcd') }, 'send', AT, 4)
    expect(out).toEqual({ dir: 'send', at: AT, type: 'publish', topic: 't', preview: 'abcd' })
  })
})

/**
 * The relay decodes whatever is on the wire, so this is fed what the types say
 * cannot happen. Nothing here may throw: a decoder that crashes on a malformed
 * packet would take the recording (and the connection's tee) down with it.
 */
describe('summarizeMqttPacket — malformed input never throws', () => {
  const junk: { name: string; packet: unknown }[] = [
    { name: 'an empty object', packet: {} },
    { name: 'a null cmd', packet: { cmd: null } },
    { name: 'a numeric cmd', packet: { cmd: 42 } },
    { name: 'a non-string topic', packet: { cmd: 'publish', topic: 99 } },
    { name: 'a non-numeric qos', packet: { cmd: 'publish', topic: 't', qos: 'high' } },
    { name: 'a NaN messageId', packet: { cmd: 'puback', messageId: NaN } },
    { name: 'a non-boolean retain', packet: { cmd: 'publish', topic: 't', retain: 'yes' } },
    { name: 'a numeric payload', packet: { cmd: 'publish', topic: 't', payload: 5 } },
    { name: 'a null payload', packet: { cmd: 'publish', topic: 't', payload: null } },
    { name: 'subscriptions that are not an array', packet: { cmd: 'subscribe', subscriptions: 'a/#' } },
    { name: 'an empty subscriptions array', packet: { cmd: 'subscribe', subscriptions: [] } },
    { name: 'a subscription with no topic', packet: { cmd: 'subscribe', subscriptions: [{ qos: 1 }] } },
    { name: 'a null subscription', packet: { cmd: 'subscribe', subscriptions: [null] } },
    { name: 'unsubscriptions of the wrong type', packet: { cmd: 'unsubscribe', unsubscriptions: [1, 2] } }
  ]

  for (const c of junk) {
    it(`survives ${c.name}`, () => {
      const out = sum(c.packet as MqttPacketLike)
      expect(() => JSON.stringify(out)).not.toThrow()
      expect(out.dir).toBe('send')
      expect(out.at).toBe(AT)
      expect(typeof out.type).toBe('string')
    })
  }

  it('names an unreadable packet type rather than dropping the row', () => {
    expect(sum({} as MqttPacketLike).type).toBe('unknown')
    expect(sum({ cmd: 42 } as unknown as MqttPacketLike).type).toBe('unknown')
  })

  it('ignores a NaN qos rather than recording one', () => {
    expect(sum({ cmd: 'publish', topic: 't', qos: NaN }).qos).toBeUndefined()
  })
})

describe('mqttConnectIdentity', () => {
  it('lifts the client id and protocol version off a CONNECT', () => {
    expect(mqttConnectIdentity({ cmd: 'connect', clientId: 'c-1', protocolVersion: 5 })).toEqual({
      clientId: 'c-1',
      protocolVersion: 5
    })
  })

  it('is null for every other packet, so the caller need not switch on type', () => {
    expect(mqttConnectIdentity({ cmd: 'publish', clientId: 'nope' })).toBeNull()
    expect(mqttConnectIdentity({})).toBeNull()
  })

  it('omits an empty client id (the broker assigns one; we never saw it)', () => {
    expect(mqttConnectIdentity({ cmd: 'connect', clientId: '', protocolVersion: 4 })).toEqual({
      protocolVersion: 4
    })
  })

  it('omits fields it cannot read rather than guessing', () => {
    expect(mqttConnectIdentity({ cmd: 'connect' })).toEqual({})
    expect(mqttConnectIdentity({ cmd: 'connect', clientId: 7, protocolVersion: 'v5' })).toEqual({})
  })
})
