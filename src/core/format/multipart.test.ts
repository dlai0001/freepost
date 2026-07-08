import { describe, expect, it } from 'vitest'
import { buildMultipartBody, multipartContentType, type MultipartPart } from './multipart'

describe('multipartContentType', () => {
  it('embeds the boundary', () => {
    expect(multipartContentType('abc')).toBe('multipart/form-data; boundary=abc')
  })
})

describe('buildMultipartBody', () => {
  const B = 'X'

  it('emits a text part with CRLF framing and a closing boundary', () => {
    const body = buildMultipartBody([{ name: 'a', content: 'hello' }], B).toString('utf8')
    expect(body).toBe(
      '--X\r\n' + 'Content-Disposition: form-data; name="a"\r\n' + '\r\n' + 'hello\r\n' + '--X--\r\n'
    )
  })

  it('adds filename and Content-Type for a json part', () => {
    const parts: MultipartPart[] = [
      { name: 'payload', filename: 'p.json', contentType: 'application/json', content: '{"k":1}' }
    ]
    const body = buildMultipartBody(parts, B).toString('utf8')
    expect(body).toContain('Content-Disposition: form-data; name="payload"; filename="p.json"\r\n')
    expect(body).toContain('Content-Type: application/json\r\n')
    expect(body).toContain('\r\n{"k":1}\r\n')
  })

  it('preserves binary file content byte-for-byte', () => {
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x80])
    const body = buildMultipartBody([{ name: 'f', filename: 'x.bin', content: bytes }], B)
    // The raw bytes must appear intact between the header CRLFCRLF and the trailing CRLF.
    expect(body.includes(bytes)).toBe(true)
    // Byte length is the header + bytes + framing, not a UTF-8 re-encoding.
    expect(Buffer.isBuffer(body)).toBe(true)
  })

  it('escapes quotes in the field name', () => {
    const body = buildMultipartBody([{ name: 'a"b', content: 'v' }], B).toString('utf8')
    expect(body).toContain('name="a\\"b"')
  })
})
