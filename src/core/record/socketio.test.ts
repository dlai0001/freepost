import { describe, expect, it } from 'vitest'
import { decodeSocketIoPacket, isSocketIoHeartbeat, isSocketIoUrl } from './socketio'
import type { SocketIoPacket } from './socketio'

describe('isSocketIoUrl', () => {
  const cases: { url: string; expected: boolean }[] = [
    { url: 'ws://localhost:3000/socket.io/?EIO=4&transport=websocket', expected: true },
    { url: 'wss://api.example.com/socket.io/?EIO=4&transport=websocket&sid=abc', expected: true },
    // A custom path still handshakes with EIO=.
    { url: 'ws://localhost:3000/rt/?EIO=4&transport=websocket', expected: true },
    // The default path is enough on its own.
    { url: 'ws://localhost:3000/socket.io/', expected: true },
    { url: 'ws://localhost:4000/graphql', expected: false },
    { url: 'wss://example.com/ws?token=abc', expected: false },
    // Not a substring match on a lookalike path or param.
    { url: 'ws://localhost/api/socket.iox/', expected: false },
    { url: 'ws://localhost/ws?NOTEIO=4', expected: false },
    { url: 'not a url at all', expected: false },
    { url: '', expected: false }
  ]

  for (const c of cases) {
    it(`${c.expected ? 'accepts' : 'rejects'} ${c.url || '(empty)'}`, () => {
      expect(isSocketIoUrl(c.url)).toBe(c.expected)
    })
  }
})

describe('decodeSocketIoPacket', () => {
  const cases: { name: string; text: string; expected: SocketIoPacket }[] = [
    {
      name: 'engine.io OPEN with its handshake payload',
      text: '0{"sid":"abc","upgrades":[],"pingInterval":25000}',
      expected: {
        engineType: 0,
        engineTypeName: 'open',
        payload: { sid: 'abc', upgrades: [], pingInterval: 25000 },
        raw: '0{"sid":"abc","upgrades":[],"pingInterval":25000}'
      }
    },
    {
      name: 'engine.io CLOSE',
      text: '1',
      expected: { engineType: 1, engineTypeName: 'close', raw: '1' }
    },
    {
      name: 'engine.io PING',
      text: '2',
      expected: { engineType: 2, engineTypeName: 'ping', raw: '2' }
    },
    {
      name: 'engine.io PONG',
      text: '3',
      expected: { engineType: 3, engineTypeName: 'pong', raw: '3' }
    },
    {
      name: 'the upgrade probe (non-JSON engine payload)',
      text: '2probe',
      expected: { engineType: 2, engineTypeName: 'ping', payloadText: 'probe', raw: '2probe' }
    },
    {
      name: 'the probe response',
      text: '3probe',
      expected: { engineType: 3, engineTypeName: 'pong', payloadText: 'probe', raw: '3probe' }
    },
    {
      name: 'engine.io UPGRADE',
      text: '5',
      expected: { engineType: 5, engineTypeName: 'upgrade', raw: '5' }
    },
    {
      name: 'engine.io NOOP',
      text: '6',
      expected: { engineType: 6, engineTypeName: 'noop', raw: '6' }
    },
    {
      name: 'socket.io CONNECT',
      text: '40',
      expected: {
        engineType: 4,
        engineTypeName: 'message',
        socketType: 0,
        socketTypeName: 'CONNECT',
        raw: '40'
      }
    },
    {
      name: 'socket.io CONNECT with a namespace and payload',
      text: '40/admin,{"token":"x"}',
      expected: {
        engineType: 4,
        engineTypeName: 'message',
        socketType: 0,
        socketTypeName: 'CONNECT',
        namespace: '/admin',
        payload: { token: 'x' },
        raw: '40/admin,{"token":"x"}'
      }
    },
    {
      name: 'the server CONNECT ack carrying the sid',
      text: '40{"sid":"J9dl"}',
      expected: {
        engineType: 4,
        engineTypeName: 'message',
        socketType: 0,
        socketTypeName: 'CONNECT',
        payload: { sid: 'J9dl' },
        raw: '40{"sid":"J9dl"}'
      }
    },
    {
      name: 'socket.io DISCONNECT',
      text: '41',
      expected: {
        engineType: 4,
        engineTypeName: 'message',
        socketType: 1,
        socketTypeName: 'DISCONNECT',
        raw: '41'
      }
    },
    {
      name: 'socket.io EVENT, hoisting the event name out of the args',
      text: '42["chat",{"msg":"hi"}]',
      expected: {
        engineType: 4,
        engineTypeName: 'message',
        socketType: 2,
        socketTypeName: 'EVENT',
        eventName: 'chat',
        payload: [{ msg: 'hi' }],
        raw: '42["chat",{"msg":"hi"}]'
      }
    },
    {
      name: 'an EVENT with no args beyond the name',
      text: '42["ping"]',
      expected: {
        engineType: 4,
        engineTypeName: 'message',
        socketType: 2,
        socketTypeName: 'EVENT',
        eventName: 'ping',
        payload: [],
        raw: '42["ping"]'
      }
    },
    {
      name: 'an EVENT on a namespace with an ack id',
      text: '42/admin,17["ev",1]',
      expected: {
        engineType: 4,
        engineTypeName: 'message',
        socketType: 2,
        socketTypeName: 'EVENT',
        namespace: '/admin',
        ackId: 17,
        eventName: 'ev',
        payload: [1],
        raw: '42/admin,17["ev",1]'
      }
    },
    {
      name: 'an explicit default namespace left undefined',
      text: '42/,["ev"]',
      expected: {
        engineType: 4,
        engineTypeName: 'message',
        socketType: 2,
        socketTypeName: 'EVENT',
        eventName: 'ev',
        payload: [],
        raw: '42/,["ev"]'
      }
    },
    {
      name: 'a nested namespace',
      text: '42/a/b,["ev"]',
      expected: {
        engineType: 4,
        engineTypeName: 'message',
        socketType: 2,
        socketTypeName: 'EVENT',
        namespace: '/a/b',
        eventName: 'ev',
        payload: [],
        raw: '42/a/b,["ev"]'
      }
    },
    {
      name: 'socket.io ACK (no event name to hoist)',
      text: '431["ok",{"n":1}]',
      expected: {
        engineType: 4,
        engineTypeName: 'message',
        socketType: 3,
        socketTypeName: 'ACK',
        ackId: 1,
        payload: ['ok', { n: 1 }],
        raw: '431["ok",{"n":1}]'
      }
    },
    {
      name: 'socket.io CONNECT_ERROR',
      text: '44{"message":"Not authorized"}',
      expected: {
        engineType: 4,
        engineTypeName: 'message',
        socketType: 4,
        socketTypeName: 'CONNECT_ERROR',
        payload: { message: 'Not authorized' },
        raw: '44{"message":"Not authorized"}'
      }
    },
    {
      name: 'socket.io BINARY_EVENT (attachment count then the placeholder args)',
      text: '451-["file",{"_placeholder":true,"num":0}]',
      expected: {
        engineType: 4,
        engineTypeName: 'message',
        socketType: 5,
        socketTypeName: 'BINARY_EVENT',
        // `1-` is the attachment count, not an ack id.
        attachments: 1,
        eventName: 'file',
        payload: [{ _placeholder: true, num: 0 }],
        raw: '451-["file",{"_placeholder":true,"num":0}]'
      }
    },
    {
      name: 'socket.io BINARY_ACK',
      text: '461-["done"]',
      expected: {
        engineType: 4,
        engineTypeName: 'message',
        socketType: 6,
        socketTypeName: 'BINARY_ACK',
        attachments: 1,
        payload: ['done'],
        raw: '461-["done"]'
      }
    },
    {
      // Ordering check: attachments precede the namespace, the ack id follows
      // it — the one place where two digit runs mean different things.
      name: 'a BINARY_EVENT with attachments, namespace and ack id',
      text: '452-/admin,3["file",{"_placeholder":true,"num":0}]',
      expected: {
        engineType: 4,
        engineTypeName: 'message',
        socketType: 5,
        socketTypeName: 'BINARY_EVENT',
        attachments: 2,
        namespace: '/admin',
        ackId: 3,
        eventName: 'file',
        payload: [{ _placeholder: true, num: 0 }],
        raw: '452-/admin,3["file",{"_placeholder":true,"num":0}]'
      }
    },
    {
      name: 'a multi-digit ack id',
      text: '42123["ev"]',
      expected: {
        engineType: 4,
        engineTypeName: 'message',
        socketType: 2,
        socketTypeName: 'EVENT',
        ackId: 123,
        eventName: 'ev',
        payload: [],
        raw: '42123["ev"]'
      }
    },
    {
      name: 'an EVENT whose first arg is not a string (nothing to hoist)',
      text: '42[1,2]',
      expected: {
        engineType: 4,
        engineTypeName: 'message',
        socketType: 2,
        socketTypeName: 'EVENT',
        payload: [1, 2],
        raw: '42[1,2]'
      }
    }
  ]

  for (const c of cases) {
    it(`decodes ${c.name}`, () => {
      expect(decodeSocketIoPacket(c.text)).toEqual(c.expected)
    })
  }
})

describe('decodeSocketIoPacket on text that is not a packet', () => {
  const cases: { name: string; text: string }[] = [
    { name: 'the empty frame', text: '' },
    // A graphql-ws session on plain WS: JSON, but never socket.io framing.
    { name: 'a graphql-ws message', text: '{"type":"connection_init","payload":{}}' },
    { name: 'a bare JSON array', text: '["chat",{"msg":"hi"}]' },
    { name: 'plain prose', text: 'hello world' },
    { name: 'an engine.io type out of range', text: '7["ev"]' },
    { name: 'an engine.io type out of range (9)', text: '9' },
    { name: 'a message frame with no socket.io type', text: '4' },
    { name: 'a message frame whose socket.io type is not a digit', text: '4x["ev"]' },
    { name: 'a message frame with an out-of-range socket.io type', text: '47["ev"]' },
    { name: 'a negative-looking frame', text: '-42["ev"]' },
    { name: 'whitespace before the type', text: ' 42["ev"]' }
  ]

  for (const c of cases) {
    it(`returns null for ${c.name}`, () => {
      expect(decodeSocketIoPacket(c.text)).toBeNull()
    })
  }
})

describe('decodeSocketIoPacket on truncated or malformed payloads', () => {
  // The engine caps frame previews at 2 KiB, so a JSON payload cut mid-value is
  // routine. The framing still decodes; the payload is surfaced as raw text so
  // the caller can say "cut off" rather than render a broken value.
  const cases: { name: string; text: string; payloadText: string }[] = [
    {
      name: 'an EVENT cut mid-JSON',
      text: '42["chat",{"msg":"hel',
      payloadText: '["chat",{"msg":"hel'
    },
    { name: 'an EVENT cut before its args close', text: '42["chat"', payloadText: '["chat"' },
    { name: 'an OPEN cut mid-handshake', text: '0{"sid":"ab', payloadText: '{"sid":"ab' },
    { name: 'trailing garbage after valid JSON', text: '42["ev"]junk', payloadText: '["ev"]junk' }
  ]

  for (const c of cases) {
    it(`keeps the framing and reports the raw payload for ${c.name}`, () => {
      const p = decodeSocketIoPacket(c.text)
      expect(p).not.toBeNull()
      expect(p?.payload).toBeUndefined()
      expect(p?.payloadText).toBe(c.payloadText)
      // No event name is claimed when the args never parsed.
      expect(p?.eventName).toBeUndefined()
    })
  }

  it('decodes the framing of a namespaced EVENT with no comma terminator', () => {
    // socket.io always writes the comma; a capture cut inside the namespace
    // must still not throw or mis-report an event.
    const p = decodeSocketIoPacket('42/admin')
    expect(p).toMatchObject({ engineType: 4, socketType: 2, namespace: '/admin' })
    expect(p?.eventName).toBeUndefined()
  })

  it('never throws on arbitrary text', () => {
    const chars = ['4', '2', '/', ',', '[', ']', '{', '}', '"', 'a', '-', '\\', '\n']
    for (let seed = 0; seed < 400; seed++) {
      let text = ''
      for (let i = 0; i < 14; i++) text += chars[(seed * 11 + i * 7) % chars.length]
      expect(() => decodeSocketIoPacket(text)).not.toThrow()
    }
  })
})

describe('isSocketIoHeartbeat', () => {
  const noise = ['2', '3', '2probe', '3probe', '5', '6']
  const signal = ['0{"sid":"a"}', '40', '42["chat"]', '41', '44{"message":"no"}']

  for (const text of noise) {
    it(`treats ${text} as heartbeat/transport noise`, () => {
      const p = decodeSocketIoPacket(text)
      expect(p).not.toBeNull()
      expect(isSocketIoHeartbeat(p as SocketIoPacket)).toBe(true)
    })
  }

  for (const text of signal) {
    it(`treats ${text} as signal`, () => {
      const p = decodeSocketIoPacket(text)
      expect(p).not.toBeNull()
      expect(isSocketIoHeartbeat(p as SocketIoPacket)).toBe(false)
    })
  }
})
