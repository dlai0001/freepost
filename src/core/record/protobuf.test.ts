import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import { decodeProtobuf, decodeProtobufBase64, formatProtobuf } from './protobuf'
import type { ProtobufMessage } from './protobuf'

/** Wire bytes from a hex string ("0a 03 41 64 61" — spaces optional). */
function hex(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, '')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

describe('decodeProtobuf', () => {
  const cases: { name: string; bytes: Uint8Array; expected: ProtobufMessage }[] = [
    { name: 'empty input', bytes: hex(''), expected: { fields: [] } },
    {
      name: 'a string field',
      bytes: hex('0a 03 41 64 61'),
      expected: { fields: [{ field: 1, kind: 'string', text: 'Ada' }] }
    },
    {
      name: 'a varint field',
      bytes: hex('08 96 01'),
      expected: { fields: [{ field: 1, kind: 'varint', value: '150' }] }
    },
    {
      name: 'a varint past Number.MAX_SAFE_INTEGER (uint64 max)',
      bytes: hex('08 ff ff ff ff ff ff ff ff ff 01'),
      expected: { fields: [{ field: 1, kind: 'varint', value: '18446744073709551615' }] }
    },
    {
      name: 'a high field number',
      bytes: hex('f8 ff ff ff 0f 01'),
      expected: { fields: [{ field: 536870911, kind: 'varint', value: '1' }] }
    },
    {
      name: 'a nested message',
      bytes: hex('1a 03 08 96 01'),
      expected: {
        fields: [{ field: 3, kind: 'message', fields: [{ field: 1, kind: 'varint', value: '150' }] }]
      }
    },
    {
      name: 'a repeated field (same number twice)',
      bytes: hex('08 01 08 02'),
      expected: {
        fields: [
          { field: 1, kind: 'varint', value: '1' },
          { field: 1, kind: 'varint', value: '2' }
        ]
      }
    },
    {
      name: 'fixed32 (little-endian)',
      bytes: hex('0d 15 cd 5b 07'),
      expected: { fields: [{ field: 1, kind: 'fixed32', value: '123456789' }] }
    },
    {
      name: 'fixed64 (little-endian)',
      bytes: hex('09 ff ff ff ff ff ff ff ff'),
      expected: { fields: [{ field: 1, kind: 'fixed64', value: '18446744073709551615' }] }
    },
    {
      name: 'binary payload -> bytes, not mojibake',
      bytes: hex('12 03 00 01 02'),
      expected: { fields: [{ field: 2, kind: 'bytes', bytes: 3, base64: 'AAEC' }] }
    },
    {
      name: 'an empty length-delimited field reads as the empty string',
      bytes: hex('0a 00'),
      expected: { fields: [{ field: 1, kind: 'string', text: '' }] }
    },
    {
      name: 'multi-byte UTF-8 stays a string',
      bytes: hex('0a 04 e2 9c 93 21'),
      expected: { fields: [{ field: 1, kind: 'string', text: '✓!' }] }
    }
  ]

  for (const c of cases) {
    it(`decodes ${c.name}`, () => {
      expect(decodeProtobuf(c.bytes)).toEqual(c.expected)
    })
  }
})

describe('decodeProtobuf on malformed input', () => {
  const cases: { name: string; bytes: Uint8Array; fields: ProtobufMessage['fields'] }[] = [
    { name: 'a length that runs past the end', bytes: hex('0a 05 41'), fields: [] },
    { name: 'a tag with no value', bytes: hex('08'), fields: [] },
    { name: 'a truncated varint', bytes: hex('08 96'), fields: [] },
    { name: 'the removed group wire type', bytes: hex('0b'), fields: [] },
    { name: 'field number 0', bytes: hex('00 01'), fields: [] },
    { name: 'an over-long varint', bytes: hex('08 ff ff ff ff ff ff ff ff ff ff 01'), fields: [] },
    {
      // Whatever parsed before the bad bytes is kept — a partial capture is the
      // normal case, and its leading fields are still real.
      name: 'trailing garbage after a good field',
      bytes: hex('08 01 0a 05 41'),
      fields: [{ field: 1, kind: 'varint', value: '1' }]
    }
  ]

  for (const c of cases) {
    it(`reports ${c.name} without throwing`, () => {
      const out = decodeProtobuf(c.bytes)
      expect(out.error).toEqual(expect.any(String))
      expect(out.fields).toEqual(c.fields)
    })
  }

  it('never throws on random bytes', () => {
    for (let seed = 0; seed < 200; seed++) {
      const bytes = new Uint8Array(24)
      for (let i = 0; i < bytes.length; i++) bytes[i] = (seed * 31 + i * 17) % 256
      expect(() => decodeProtobuf(bytes)).not.toThrow()
    }
  })
})

describe('decodeProtobuf length-delimited ambiguity', () => {
  // Locked in deliberately: without a schema a payload that parses cleanly as
  // a message IS shown as one, even when the sender meant a string. "hi" is
  // 68 69 — field 13, varint 105 — and consumes exactly. Nothing can tell the
  // two apart at tier 3; attaching the .proto (tier 2) is the answer.
  it('prefers a clean nested-message parse over a printable string', () => {
    expect(decodeProtobuf(hex('0a 02 68 69'))).toEqual({
      fields: [{ field: 1, kind: 'message', fields: [{ field: 13, kind: 'varint', value: '105' }] }]
    })
  })
})

describe('decodeProtobufBase64', () => {
  it('decodes a captured payload', () => {
    expect(decodeProtobufBase64('CgNBZGE=')).toEqual({
      fields: [{ field: 1, kind: 'string', text: 'Ada' }]
    })
  })

  it('reports base64 that is not base64', () => {
    expect(decodeProtobufBase64('not base64!')).toEqual({
      fields: [],
      error: 'payload is not valid base64'
    })
  })
})

/* --------------------- against real protobuf serializers -------------------- */

const GREETER_PROTO = join(__dirname, '..', '..', '..', 'fixtures', 'servers', 'greeter.proto')

/* eslint-disable @typescript-eslint/no-explicit-any */
function greeterService(): any {
  const pkgDef = protoLoader.loadSync(GREETER_PROTO, { keepCase: true })
  return (grpc.loadPackageDefinition(pkgDef) as any).helloworld.Greeter.service
}

describe('decodeProtobuf against proto-loader-serialized messages', () => {
  it('decodes a HelloRequest the way the schema says it was built', () => {
    const bytes: Buffer = greeterService().SayHello.requestSerialize({ name: 'Ada Lovelace' })
    // Field 1 is `string name` — tier 3 knows the number, not the name.
    expect(decodeProtobuf(bytes)).toEqual({
      fields: [{ field: 1, kind: 'string', text: 'Ada Lovelace' }]
    })
  })

  it('decodes a HelloReply', () => {
    const bytes: Buffer = greeterService().SayHello.responseSerialize({ message: 'Hello Ada' })
    expect(formatProtobuf(decodeProtobuf(bytes))).toBe('1: "Hello Ada"')
  })

  it('round-trips through base64 the way the proxy stores payloads', () => {
    const bytes: Buffer = greeterService().SayHello.requestSerialize({ name: 'Grace' })
    expect(decodeProtobufBase64(bytes.toString('base64'))).toEqual({
      fields: [{ field: 1, kind: 'string', text: 'Grace' }]
    })
  })
})

describe('formatProtobuf', () => {
  it('renders a nested tree with indentation', () => {
    // field 1 varint 150, field 3 { field 1: "hey", field 2 { field 1: 1 } }
    const msg = decodeProtobuf(hex('08 96 01 1a 09 0a 03 68 65 79 12 02 08 01'))
    expect(msg.error).toBeUndefined()
    expect(formatProtobuf(msg)).toBe(
      ['1: 150', '3 {', '  1: "hey"', '  2 {', '    1: 1', '  }', '}'].join('\n')
    )
  })

  it('renders the empty message as empty text', () => {
    expect(formatProtobuf({ fields: [] })).toBe('')
  })

  it('appends the error marker after whatever parsed', () => {
    const out = formatProtobuf(decodeProtobuf(hex('08 01 0b')))
    expect(out).toContain('1: 1')
    expect(out).toContain('(decode stopped:')
  })
})
