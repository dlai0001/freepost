import { describe, expect, it } from 'vitest'
import { mapCurlCommand } from './curl'
import type { CommandToken } from './shell'

const argv = (...words: string[]): CommandToken[] => words.map((text, i) => ({ text, line: i + 1 }))

function ok(...words: string[]) {
  const r = mapCurlCommand(argv(...words))
  expect(r.ok).toBe(true)
  if (!r.ok) throw new Error(`expected ok, got: ${JSON.stringify(r.errors)}`)
  return r.http
}

function err(...words: string[]) {
  const r = mapCurlCommand(argv(...words))
  expect(r.ok).toBe(false)
  if (r.ok) throw new Error('expected error')
  return r.errors[0]
}

describe('mapCurlCommand', () => {
  it('maps the full supported long-form flag set', () => {
    const http = ok(
      'curl',
      '--request', 'PUT',
      '--url', 'https://e.com/x',
      '--header', 'A: 1',
      '--header', 'B: 2',
      '--data', '{"k":"v"}',
      '--user', 'me:pw',
      '--insecure',
      '--location',
      '--max-time', '30',
    )
    expect(http).toEqual({
      method: 'PUT',
      url: 'https://e.com/x',
      headers: [
        { name: 'A', value: '1' },
        { name: 'B', value: '2' },
      ],
      body: { kind: 'raw', value: '{"k":"v"}' },
      options: { user: 'me:pw', insecure: true, followRedirects: true, timeoutSeconds: 30 },
    })
  })

  it('maps short flags (-X, -H, -d, -u, -k, -L)', () => {
    const http = ok('curl', '-X', 'DELETE', '-H', 'A: 1', '-d', 'x=1', '-u', 'a:b', '-k', '-L', 'https://e.com')
    expect(http.method).toBe('DELETE')
    expect(http.url).toBe('https://e.com')
    expect(http.headers).toEqual([{ name: 'A', value: '1' }])
    expect(http.body).toEqual({ kind: 'raw', value: 'x=1' })
    expect(http.options).toEqual({ user: 'a:b', insecure: true, followRedirects: true })
  })

  it('accepts a positional URL', () => {
    expect(ok('curl', 'https://e.com/x').url).toBe('https://e.com/x')
  })

  it('defaults the method to GET without a body', () => {
    expect(ok('curl', '--url', 'https://e.com').method).toBe('GET')
  })

  it('defaults the method to POST when a body is present and no -X', () => {
    expect(ok('curl', '--url', 'https://e.com', '--data', 'x').method).toBe('POST')
  })

  it('keeps an explicit method even with a body', () => {
    expect(ok('curl', '-X', 'PATCH', '--url', 'https://e.com', '--data', 'x').method).toBe('PATCH')
  })

  it('maps @-prefixed data to a file body', () => {
    expect(ok('curl', '--url', 'https://e.com', '--data', '@./payload.json').body).toEqual({
      kind: 'file',
      value: './payload.json',
    })
  })

  it('parses -F/--form fields (text, file, and json via type modifier)', () => {
    const http = ok(
      'curl',
      '--url', 'https://e.com',
      '--form', 'title=hello',
      '--form', 'avatar=@./pic.png;filename=me.png',
      '--form', 'payload={"k":1};type=application/json',
    )
    expect(http.method).toBe('POST')
    expect(http.body).toBeUndefined()
    expect(http.form).toEqual([
      { name: 'title', type: 'text', value: 'hello' },
      { name: 'avatar', type: 'file', value: './pic.png', filename: 'me.png' },
      { name: 'payload', type: 'json', content: '{"k":1}' },
    ])
  })

  it('rejects combining --data with --form', () => {
    expect(err('curl', '--url', 'https://e.com', '--data', 'x', '--form', 'a=b').message).toMatch(
      /cannot combine --data with --form/,
    )
  })

  it('rejects a malformed form field with no "="', () => {
    expect(err('curl', '--url', 'https://e.com', '--form', 'nope').message).toMatch(/malformed form field/)
  })

  it('treats --data-raw like --data', () => {
    expect(ok('curl', '--url', 'https://e.com', '--data-raw', '{"a":1}').body).toEqual({
      kind: 'raw',
      value: '{"a":1}',
    })
  })

  it('parses headers on the first colon and trims whitespace', () => {
    const http = ok('curl', '--url', 'https://e.com', '-H', 'X-Time:  12:30:00 ')
    expect(http.headers).toEqual([{ name: 'X-Time', value: '12:30:00' }])
  })

  it('accepts fractional --max-time', () => {
    expect(ok('curl', '--url', 'https://e.com', '--max-time', '2.5').options.timeoutSeconds).toBe(2.5)
  })

  it('rejects any unsupported flag by name with line info', () => {
    const e = err('curl', '--url', 'https://e.com', '--compressed')
    expect(e.message).toBe('unsupported curl flag: --compressed')
    expect(e.line).toBe(4)
    expect(err('curl', '-o', 'out.json', '--url', 'https://e.com').message).toBe('unsupported curl flag: -o')
  })

  it('rejects a missing URL', () => {
    expect(err('curl', '-k').message).toMatch(/missing URL/)
  })

  it('rejects a missing flag value', () => {
    expect(err('curl', 'https://e.com', '--header').message).toMatch(/missing value for --header/)
    expect(err('curl', '--url').message).toMatch(/missing value for --url/)
  })

  it('rejects malformed headers', () => {
    expect(err('curl', '--url', 'https://e.com', '-H', 'NoColonHere').message).toMatch(/malformed header/)
    expect(err('curl', '--url', 'https://e.com', '-H', ': empty name').message).toMatch(/malformed header/)
  })

  it('rejects a non-numeric --max-time', () => {
    expect(err('curl', '--url', 'https://e.com', '--max-time', 'abc').message).toMatch(/expects a number/)
  })

  it('rejects two URLs (positional + positional, or --url twice)', () => {
    expect(err('curl', 'https://a', 'https://b').message).toMatch(/already set/)
    expect(err('curl', '--url', 'https://a', '--url', 'https://b').message).toMatch(/duplicate URL/)
  })

  it('rejects duplicate --data and --request', () => {
    expect(err('curl', '--url', 'https://a', '-d', '1', '-d', '2').message).toMatch(/duplicate data/)
    expect(err('curl', '--url', 'https://a', '-X', 'GET', '-X', 'POST').message).toMatch(/duplicate --request/)
  })
})
