/**
 * The byte helpers the capture views share. Covered directly here rather than
 * only through protobuf.ts/mqtt-packets.ts: they are the contract those views
 * rely on (never throw, base64 round-trips, binary never renders as text).
 */
import { describe, expect, it } from 'vitest'
import { asText, fromBase64, toBase64 } from './bytes'

describe('toBase64', () => {
  it('matches Buffer for every padding remainder', () => {
    for (const len of [0, 1, 2, 3, 4, 5, 6, 7, 255]) {
      const bytes = Buffer.from(Array.from({ length: len }, (_, i) => (i * 7 + 3) & 0xff))
      expect(toBase64(new Uint8Array(bytes))).toBe(bytes.toString('base64'))
    }
  })
})

describe('fromBase64', () => {
  it('round-trips toBase64', () => {
    const bytes = new Uint8Array([0x00, 0x01, 0xff, 0x80, 0x7f])
    expect(fromBase64(toBase64(bytes))).toEqual(bytes)
  })

  it('ignores the line breaks a wrapped encoding carries', () => {
    expect(fromBase64('AAEC\n')).toEqual(new Uint8Array([0, 1, 2]))
  })

  it('is null for anything that is not well-formed base64', () => {
    expect(fromBase64('not base64!')).toBeNull()
    expect(fromBase64('AAE')).toBeNull() // length not a multiple of 4
  })
})

describe('asText', () => {
  it('decodes printable UTF-8, including multi-byte and the allowed controls', () => {
    expect(asText(new TextEncoder().encode('héllo ✓'))).toBe('héllo ✓')
    expect(asText(new TextEncoder().encode('a\tb\r\nc'))).toBe('a\tb\r\nc')
  })

  it('is null for invalid UTF-8', () => {
    expect(asText(new Uint8Array([0xff, 0xfe]))).toBeNull()
  })

  it('is null for C0 control bytes — text that decodes but is really binary', () => {
    expect(asText(new Uint8Array([0x68, 0x00, 0x69]))).toBeNull()
    expect(asText(new Uint8Array([0x01]))).toBeNull()
  })
})
