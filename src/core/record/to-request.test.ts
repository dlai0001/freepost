import { describe, expect, it } from 'vitest'
import type { RecordedExchange, RecordedMqttPacket } from '@shared/model'
import { parseRequestFile, writeRequestFile } from '../format'
import { omittedNote, recordedName, recordedToRequestFile } from './to-request'

function exchange(over: Partial<RecordedExchange> = {}): RecordedExchange {
  return {
    id: 'x1',
    at: '2026-01-01T00:00:00Z',
    protocol: 'rest',
    method: 'GET',
    url: 'http://localhost:3010/users/42',
    requestHeaders: [
      { name: 'accept', value: 'application/json' },
      { name: 'host', value: '127.0.0.1:7699' },
      { name: 'connection', value: 'keep-alive' },
      { name: 'content-length', value: '0' },
      { name: 'proxy-connection', value: 'keep-alive' }
    ],
    status: 200,
    errored: false,
    ...over
  }
}

describe('recordedToRequestFile', () => {
  it('maps a REST exchange to a curl model, stripping connection-level headers', () => {
    const file = recordedToRequestFile(exchange())
    expect(file.kind).toBe('curl')
    expect(file.http?.method).toBe('GET')
    expect(file.http?.url).toBe('http://localhost:3010/users/42')
    expect(file.http?.headers).toEqual([{ name: 'accept', value: 'application/json' }])
    expect(file.http?.body).toBeUndefined()
  })

  it('keeps a text request body as a raw body', () => {
    const file = recordedToRequestFile(
      exchange({
        method: 'POST',
        requestBody: { text: '{"name":"Grace"}', bytes: 16, truncated: false }
      })
    )
    expect(file.http?.body).toEqual({ kind: 'raw', value: '{"name":"Grace"}' })
  })

  it('drops a binary request body (not representable in a shell file), noting why', () => {
    const file = recordedToRequestFile(
      exchange({
        method: 'POST',
        requestBody: { text: '', bytes: 4, truncated: false, base64: 'AAECAw==' }
      })
    )
    expect(file.http?.body).toBeUndefined()
    expect(file.comments).toEqual([{ beforeStatement: 0, text: 'body omitted: binary capture' }])
    expect(omittedNote(file)).toBe('body omitted: binary capture')
  })

  it('never saves a truncated body as if it were complete', () => {
    const file = recordedToRequestFile(
      exchange({
        method: 'POST',
        requestBody: { text: 'a'.repeat(100), bytes: 128 * 1024, truncated: true }
      })
    )
    expect(file.http?.body).toBeUndefined()
    expect(file.comments).toEqual([
      { beforeStatement: 0, text: `body omitted: capture truncated at 64 KiB (${128 * 1024} bytes on the wire)` }
    ])
    expect(omittedNote(file)).toContain('truncated at 64 KiB')
    // The comment survives the writer + strict parser round trip.
    const parsed = parseRequestFile(writeRequestFile(file), 'curl')
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.file.comments.map((c) => c.text)).toEqual(file.comments.map((c) => c.text))
  })

  it('does not save a truncated graphql-classified payload as a corrupt body', () => {
    const file = recordedToRequestFile(
      exchange({
        protocol: 'graphql',
        method: 'POST',
        requestBody: { text: '{"query":"query Big { x', bytes: 90000, truncated: true }
      })
    )
    expect(file.frontmatter.graphql).toBeUndefined()
    expect(file.http?.body).toBeUndefined()
    expect(omittedNote(file)).toContain('truncated')
  })

  it('reports no note for a complete body', () => {
    const file = recordedToRequestFile(
      exchange({ method: 'POST', requestBody: { text: '{}', bytes: 2, truncated: false } })
    )
    expect(omittedNote(file)).toBeNull()
  })

  it('saves a GraphQL exchange with frontmatter.graphql so it opens in the GraphQL editor', () => {
    const payload = {
      query: 'query GetUser($id: ID!) { user(id: $id) { name } }',
      variables: { id: '42' }
    }
    const file = recordedToRequestFile(
      exchange({
        protocol: 'graphql',
        method: 'POST',
        url: 'http://localhost:4000/graphql',
        requestHeaders: [{ name: 'content-type', value: 'application/json' }],
        requestBody: { text: JSON.stringify(payload), bytes: 99, truncated: false },
        graphql: { operationName: 'GetUser', operationType: 'query' }
      })
    )
    expect(file.frontmatter.graphql).toEqual(payload)
    // No inline body: the writer generates --data from frontmatter.graphql.
    expect(file.http?.body).toBeUndefined()

    // The written file round-trips through the strict parser with graphql intact.
    const parsed = parseRequestFile(writeRequestFile(file), 'curl')
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.file.frontmatter.graphql).toMatchObject({ query: payload.query })
    }
  })

  it('falls back to a plain body when a graphql-classified payload does not parse', () => {
    const file = recordedToRequestFile(
      exchange({
        protocol: 'graphql',
        method: 'POST',
        requestBody: { text: 'not json', bytes: 8, truncated: false }
      })
    )
    expect(file.frontmatter.graphql).toBeUndefined()
    expect(file.http?.body).toEqual({ kind: 'raw', value: 'not json' })
  })
})

describe('recordedToRequestFile — gRPC', () => {
  const grpcExchange = (): RecordedExchange =>
    exchange({
      protocol: 'grpc',
      method: 'POST',
      url: 'http://127.0.0.1:50051/helloworld.Greeter/SayHello',
      requestHeaders: [
        { name: 'content-type', value: 'application/grpc' },
        { name: 'te', value: 'trailers' },
        { name: 'grpc-timeout', value: '5S' },
        { name: 'user-agent', value: 'grpc-node-js/1.14.4' },
        { name: 'authorization', value: 'Bearer tok' }
      ],
      grpc: { service: 'helloworld.Greeter', method: 'SayHello', grpcStatus: 0, requestMessages: 1, responseMessages: 1 }
    })

  it('maps to a .grpc skeleton: target, fullMethod, plaintext, filtered metadata, no data', () => {
    const file = recordedToRequestFile(grpcExchange())
    expect(file.kind).toBe('grpc')
    expect(file.grpc?.target).toBe('127.0.0.1:50051')
    expect(file.grpc?.fullMethod).toBe('helloworld.Greeter/SayHello')
    expect(file.grpc?.plaintext).toBe(true)
    expect(file.grpc?.data).toBeUndefined()
    // Transport headers regenerated by the channel are dropped; auth survives.
    expect(file.grpc?.metadata).toEqual([{ name: 'authorization', value: 'Bearer tok' }])
    expect(file.grpc?.protoFiles).toEqual([])
  })

  it('bakes in the tier-2 decode and the protos behind it when the viewer has them', () => {
    const file = recordedToRequestFile(grpcExchange(), {
      data: '{\n  "name": "Ada"\n}',
      protoFiles: ['/protos/greeter.proto'],
      importPaths: ['/protos']
    })
    expect(file.grpc?.data).toBe('{\n  "name": "Ada"\n}')
    expect(file.grpc?.protoFiles).toEqual(['/protos/greeter.proto'])
    expect(file.grpc?.importPaths).toEqual(['/protos'])
  })

  it('writes a proto under the collection root as a collection-relative path', () => {
    // Collections are committed to git: the file picker's absolute path is the
    // one machine's, and every other .grpc holds a path relative to its own
    // directory (see execute.ts's resolveProtoPath).
    const file = recordedToRequestFile(grpcExchange(), {
      protoFiles: ['/Users/ada/work/api/protos/greeter.proto'],
      importPaths: ['/Users/ada/work/api/protos'],
      root: '/Users/ada/work/api'
    })
    expect(file.grpc?.protoFiles).toEqual(['protos/greeter.proto'])
    expect(file.grpc?.importPaths).toEqual(['protos'])
  })

  it('keeps a proto outside the collection root absolute — it has no portable form', () => {
    const file = recordedToRequestFile(grpcExchange(), {
      protoFiles: ['/opt/shared/greeter.proto', '/Users/ada/work/api/local.proto'],
      root: '/Users/ada/work/api'
    })
    expect(file.grpc?.protoFiles).toEqual(['/opt/shared/greeter.proto', 'local.proto'])
  })

  it('does not mistake a sibling directory with the root as a prefix', () => {
    const file = recordedToRequestFile(grpcExchange(), {
      protoFiles: ['/Users/ada/work/api-v2/greeter.proto'],
      root: '/Users/ada/work/api'
    })
    expect(file.grpc?.protoFiles).toEqual(['/Users/ada/work/api-v2/greeter.proto'])
  })

  it('leaves paths alone when no root is given', () => {
    const file = recordedToRequestFile(grpcExchange(), { protoFiles: ['/protos/greeter.proto'] })
    expect(file.grpc?.protoFiles).toEqual(['/protos/greeter.proto'])
  })

  it('leaves data empty when the decode produced nothing', () => {
    // Only a real .proto decode may fill `data` — tier-3 field numbers are not
    // valid grpcurl JSON, so an undecoded capture stays a skeleton.
    const file = recordedToRequestFile(grpcExchange(), { protoFiles: ['/protos/greeter.proto'] })
    expect(file.grpc?.data).toBeUndefined()
    expect(file.grpc?.protoFiles).toEqual(['/protos/greeter.proto'])
  })

  it('does not throw on an unparseable url without grpc capture info', () => {
    const e = grpcExchange()
    e.url = 'not a url'
    e.grpc = undefined
    const file = recordedToRequestFile(e)
    expect(file.grpc?.target).toBe('not a url')
    expect(file.grpc?.fullMethod).toBe('')
  })

  it('omits plaintext for an https target', () => {
    const e = grpcExchange()
    e.url = 'https://api.example.com:8443/helloworld.Greeter/SayHello'
    const file = recordedToRequestFile(e)
    expect(file.grpc?.plaintext).toBeUndefined()
    expect(file.grpc?.target).toBe('api.example.com:8443')
  })

  it('round-trips through the writer and strict parser', () => {
    const file = recordedToRequestFile(grpcExchange())
    const parsed = parseRequestFile(writeRequestFile(file), 'grpc')
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.file.grpc).toMatchObject({
        target: '127.0.0.1:50051',
        fullMethod: 'helloworld.Greeter/SayHello',
        plaintext: true,
        metadata: [{ name: 'authorization', value: 'Bearer tok' }]
      })
    }
  })
})

describe('recordedToRequestFile — WebSocket', () => {
  const wsExchange = (): RecordedExchange =>
    exchange({
      protocol: 'ws',
      method: 'WS',
      url: 'ws://127.0.0.1:3013/live?room=1',
      status: 101,
      requestHeaders: [
        { name: 'sec-websocket-key', value: 'abc==' },
        { name: 'sec-websocket-version', value: '13' },
        { name: 'connection', value: 'Upgrade' },
        { name: 'upgrade', value: 'websocket' },
        { name: 'host', value: '127.0.0.1:7699' },
        { name: 'cookie', value: 'session=1' }
      ],
      responseHeaders: [{ name: 'sec-websocket-protocol', value: 'graphql-transport-ws' }],
      ws: {
        closeCode: 1000,
        frames: [
          { dir: 'out', at: '2026-01-01T00:00:01Z', text: true, preview: '{"type":"ping"}', truncated: false },
          { dir: 'in', at: '2026-01-01T00:00:02Z', text: true, preview: '{"type":"pong"}', truncated: false },
          { dir: 'out', at: '2026-01-01T00:00:03Z', text: false, preview: 'AAECAw==', truncated: false },
          { dir: 'out', at: '2026-01-01T00:00:04Z', text: true, preview: 'cut off', truncated: true },
          { dir: 'out', at: '2026-01-01T00:00:05Z', text: true, preview: 'second', truncated: false }
        ]
      }
    })

  it('maps to a .ws connection with filtered headers + negotiated subprotocol', () => {
    const file = recordedToRequestFile(wsExchange())
    expect(file.kind).toBe('websocat')
    expect(file.ws?.url).toBe('ws://127.0.0.1:3013/live?room=1')
    // Handshake headers are the engine's job on every connect; cookies survive.
    expect(file.ws?.headers).toEqual([{ name: 'cookie', value: 'session=1' }])
    expect(file.ws?.protocol).toBe('graphql-transport-ws')
  })

  it('saves client-sent text frames as messages presets (binary/truncated dropped)', () => {
    const file = recordedToRequestFile(wsExchange())
    expect(file.frontmatter.messages).toEqual({
      'message-1': '{"type":"ping"}',
      'message-2': 'second'
    })
  })

  it('round-trips through the writer and strict parser', () => {
    const file = recordedToRequestFile(wsExchange())
    const parsed = parseRequestFile(writeRequestFile(file), 'websocat')
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.file.ws).toMatchObject({
        url: 'ws://127.0.0.1:3013/live?room=1',
        protocol: 'graphql-transport-ws'
      })
      expect(parsed.file.frontmatter.messages).toEqual({
        'message-1': '{"type":"ping"}',
        'message-2': 'second'
      })
    }
  })

  it('saves just the connection when no client text frames were captured', () => {
    const e = wsExchange()
    e.ws = { frames: [] }
    e.responseHeaders = []
    const file = recordedToRequestFile(e)
    expect(file.frontmatter.messages).toBeUndefined()
    expect(file.ws?.protocol).toBeUndefined()
  })
})


describe('recordedToRequestFile — MQTT', () => {
  const packet = (over: Partial<RecordedMqttPacket> = {}): RecordedMqttPacket => ({
    dir: 'send',
    at: '2026-01-01T00:00:01Z',
    type: 'publish',
    topic: 'freepost/demo',
    qos: 1,
    preview: 'hello',
    ...over
  })

  const mqttExchange = (packets: RecordedMqttPacket[]): RecordedExchange =>
    exchange({
      protocol: 'mqtt',
      method: 'MQTT',
      url: 'mqtt://127.0.0.1:1883',
      status: undefined,
      requestHeaders: [],
      mqtt: { clientId: 'recorded-client', protocolVersion: 4, packets }
    })

  it('maps a chosen PUBLISH packet to a publish .mqtt file', () => {
    const e = mqttExchange([packet({ type: 'connect', topic: undefined, qos: undefined, preview: undefined }), packet()])
    const file = recordedToRequestFile(e, undefined, 1)
    expect(file.kind).toBe('mqtt')
    expect(file.mqtt).toEqual({
      mode: 'publish',
      host: '127.0.0.1',
      port: 1883,
      topic: 'freepost/demo',
      qos: 1,
      message: 'hello'
    })
    expect(file.comments).toEqual([])
  })

  it('carries the retain flag', () => {
    const e = mqttExchange([packet({ retain: true })])
    expect(recordedToRequestFile(e, undefined, 0).mqtt?.retain).toBe(true)
  })

  it('maps a SUBSCRIBE packet to a subscribe request, with no message', () => {
    const e = mqttExchange([
      packet({ type: 'subscribe', topic: 'freepost/tick', qos: 2, preview: 'freepost/tick (qos 2)' })
    ])
    const file = recordedToRequestFile(e, undefined, 0)
    expect(file.mqtt).toEqual({
      mode: 'subscribe',
      host: '127.0.0.1',
      port: 1883,
      topic: 'freepost/tick',
      qos: 2
    })
  })

  it('never silently drops the other topics of a multi-topic SUBSCRIBE', () => {
    // SUBSCRIBE is legally a batch; .mqtt is one topic per file. The first
    // topic is saved and the rest MUST be reported — a clean-looking save that
    // quietly lost two of three subscriptions is the failure under test.
    const e = mqttExchange([
      packet({
        type: 'subscribe',
        topic: 'freepost/a',
        qos: 1,
        preview: 'freepost/a (qos 1), freepost/b (qos 2), freepost/c'
      })
    ])
    const file = recordedToRequestFile(e, undefined, 0)
    expect(file.mqtt?.topic).toBe('freepost/a')
    const note = omittedNote(file)
    expect(note).not.toBeNull()
    expect(note).toContain('freepost/b (qos 2), freepost/c')
  })

  it('says nothing about dropped topics for a single-topic SUBSCRIBE', () => {
    const e = mqttExchange([packet({ type: 'subscribe', topic: 'freepost/a', qos: 1, preview: 'freepost/a (qos 1)' })])
    expect(omittedNote(recordedToRequestFile(e, undefined, 0))).toBeNull()
  })

  it('saves a PUBLISH the client received, not only ones it sent', () => {
    const e = mqttExchange([packet({ dir: 'recv', preview: 'from the broker' })])
    expect(recordedToRequestFile(e, undefined, 0).mqtt?.message).toBe('from the broker')
  })

  it('refuses to write a truncated payload as if it were the whole message', () => {
    const e = mqttExchange([packet({ preview: 'cut off here', truncated: true })])
    const file = recordedToRequestFile(e, undefined, 0)
    expect(file.mqtt?.message).toBeUndefined()
    expect(omittedNote(file)).toMatch(/truncated/)
  })

  it('refuses to write a binary payload (a base64 preview is not the payload)', () => {
    const e = mqttExchange([packet({ preview: 'AAECAw==', base64: true })])
    const file = recordedToRequestFile(e, undefined, 0)
    expect(file.mqtt?.message).toBeUndefined()
    expect(omittedNote(file)).toMatch(/binary/)
  })

  it('says nothing was omitted when the publish carried no payload at all', () => {
    const e = mqttExchange([packet({ preview: undefined })])
    const file = recordedToRequestFile(e, undefined, 0)
    expect(file.mqtt?.message).toBeUndefined()
    expect(omittedNote(file)).toBeNull()
  })

  it('never carries the recorded clientId — MQTT ids are exclusive', () => {
    const e = mqttExchange([packet()])
    expect(recordedToRequestFile(e, undefined, 0).mqtt?.clientId).toBeUndefined()
  })

  it('omits the port when the broker URL names none (the .mqtt default applies)', () => {
    const e = exchange({
      protocol: 'mqtt',
      method: 'MQTT',
      url: 'mqtt://broker.example',
      requestHeaders: [],
      mqtt: { packets: [packet()] }
    })
    expect(recordedToRequestFile(e, undefined, 0).mqtt).toMatchObject({ host: 'broker.example' })
    expect(recordedToRequestFile(e, undefined, 0).mqtt?.port).toBeUndefined()
  })

  it('picks the first saveable packet when no index is given (the row-level Save)', () => {
    const e = mqttExchange([
      packet({ type: 'connect', topic: undefined, preview: undefined }),
      packet({ type: 'pingreq', topic: undefined, preview: undefined }),
      packet({ type: 'subscribe', topic: 'first/saveable', qos: 0, preview: 'first/saveable (qos 0)' }),
      packet({ topic: 'later/publish' })
    ])
    expect(recordedToRequestFile(e).mqtt).toMatchObject({ mode: 'subscribe', topic: 'first/saveable' })
  })

  it('refuses a packet with no runnable form rather than writing a dead file', () => {
    const e = mqttExchange([packet({ type: 'connack', topic: undefined, preview: undefined })])
    expect(() => recordedToRequestFile(e, undefined, 0)).toThrow(/publish or subscribe/)
    // A session of pure mechanics has nothing to save at all.
    expect(() => recordedToRequestFile(e)).toThrow(/publish or subscribe/)
  })

  it('refuses an index that is not in the capture', () => {
    const e = mqttExchange([packet()])
    expect(() => recordedToRequestFile(e, undefined, 9)).toThrow(/publish or subscribe/)
  })

  it('round-trips through the .mqtt writer/parser', () => {
    const e = mqttExchange([packet()])
    const file = recordedToRequestFile(e, undefined, 0)
    const parsed = parseRequestFile(writeRequestFile(file), 'mqtt')
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.file.mqtt).toMatchObject({
        mode: 'publish',
        host: '127.0.0.1',
        port: 1883,
        topic: 'freepost/demo',
        message: 'hello'
      })
    }
  })
})

describe('recordedName', () => {
  it('prefers the GraphQL operation name', () => {
    const e = exchange({ protocol: 'graphql', graphql: { operationName: 'GetUser' } })
    expect(recordedName(e, recordedToRequestFile(e))).toBe('GetUser')
  })

  it('trims a padded operation name', () => {
    const e = exchange({ protocol: 'graphql', graphql: { operationName: '  GetUser  ' } })
    expect(recordedName(e, recordedToRequestFile(e))).toBe('GetUser')
  })

  it('falls back to the URL-derived suggestion', () => {
    const e = exchange()
    expect(recordedName(e, recordedToRequestFile(e))).toBe('42')
  })

  it('uses the gRPC method name', () => {
    const e = exchange({
      protocol: 'grpc',
      url: 'http://127.0.0.1:50051/helloworld.Greeter/SayHello',
      grpc: { service: 'helloworld.Greeter', method: 'SayHello', requestMessages: 1, responseMessages: 1 }
    })
    expect(recordedName(e, recordedToRequestFile(e))).toBe('SayHello')
  })

  it('uses the ws path for a session', () => {
    const e = exchange({ protocol: 'ws', method: 'WS', url: 'ws://127.0.0.1:3013/live', ws: { frames: [] } })
    expect(recordedName(e, recordedToRequestFile(e))).toBe('live')
  })

  it('names an MQTT request after its whole topic, not the broker URL', () => {
    const e = exchange({
      protocol: 'mqtt',
      method: 'MQTT',
      url: 'mqtt://127.0.0.1:1883',
      requestHeaders: [],
      mqtt: {
        packets: [{ dir: 'send', at: '2026-01-01T00:00:01Z', type: 'publish', topic: 'freepost/demo' }]
      }
    })
    // Slashes would be stripped by the filename sanitizer, losing the
    // hierarchy that distinguishes 'freepost/tick' from 'other/tick'.
    expect(recordedName(e, recordedToRequestFile(e, undefined, 0))).toBe('freepost-demo')
  })

  it('keeps an MQTT wildcard topic readable', () => {
    const e = exchange({
      protocol: 'mqtt',
      method: 'MQTT',
      url: 'mqtt://127.0.0.1:1883',
      requestHeaders: [],
      mqtt: {
        packets: [
          { dir: 'send', at: '2026-01-01T00:00:01Z', type: 'subscribe', topic: 'freepost/#', qos: 0 }
        ]
      }
    })
    expect(recordedName(e, recordedToRequestFile(e, undefined, 0))).toBe('freepost-#')
  })
})
