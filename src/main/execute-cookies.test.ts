import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseRequestFile, writeRequestFile } from '../core/format'
import type { CookieRecord, RequestFile } from '../shared/model'
import { executeRequest } from './execute'
import { cookieFilePath } from './cookie-store'

let server: Server
let baseUrl = ''
let root = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/set') {
      res.setHeader('Set-Cookie', 'sid=abc; Path=/')
      res.end('set')
      return
    }
    if (req.url === '/set-other') {
      res.setHeader('Set-Cookie', 'other=1; Path=/')
      res.end('set-other')
      return
    }
    res.end(req.headers.cookie ?? '(none)')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no address')
  baseUrl = `127.0.0.1:${addr.port}`
  root = mkdtempSync(join(tmpdir(), 'freepost-exec-cookies-'))
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(root, { recursive: true, force: true })
})

function writeRequest(rel: string, file: RequestFile): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, writeRequestFile(file))
}

function curlFile(path: string, frontmatter: RequestFile['frontmatter'] = {}): RequestFile {
  return {
    kind: 'curl',
    frontmatter,
    variables: [{ name: 'BASE_URL', defaultValue: baseUrl, required: false }],
    http: { method: 'GET', url: `http://\${BASE_URL}${path}`, headers: [], options: {} },
    comments: []
  }
}

describe('executeRequest cookie jar', () => {
  it('stores cookies, replays them, and persists the jar to .freepost/cookies.json', async () => {
    writeRequest('Set.curl', curlFile('/set'))
    writeRequest('Echo.curl', curlFile('/echo'))
    const session = new Map<string, string>()

    await executeRequest({ root, path: 'Set.curl', session })
    expect(existsSync(cookieFilePath(root))).toBe(true)
    const records = JSON.parse(readFileSync(cookieFilePath(root), 'utf8')) as CookieRecord[]
    expect(records.map((c) => c.name)).toEqual(['sid'])

    const echo = await executeRequest({ root, path: 'Echo.curl', session })
    expect(echo.response?.bodyText).toBe('sid=abc')
  })

  it('cookies: false disables both sending and storing', async () => {
    writeRequest('EchoOff.curl', curlFile('/echo', { cookies: false }))
    writeRequest('SetOff.curl', curlFile('/set-other', { cookies: false }))
    writeRequest('Echo.curl', curlFile('/echo'))
    const session = new Map<string, string>()

    // The jar already holds sid=abc, but an opted-out request must not send it.
    const off = await executeRequest({ root, path: 'EchoOff.curl', session })
    expect(off.response?.bodyText).toBe('(none)')

    // An opted-out request must not capture Set-Cookie either.
    await executeRequest({ root, path: 'SetOff.curl', session })
    const echo = await executeRequest({ root, path: 'Echo.curl', session })
    expect(echo.response?.bodyText).toBe('sid=abc')
  })

  it('the cookies: false frontmatter field round-trips through serialize/parse', () => {
    const raw = writeRequestFile(curlFile('/echo', { cookies: false }))
    const parsed = parseRequestFile(raw, 'curl')
    if (!parsed.ok) throw new Error('parse failed')
    expect(parsed.file.frontmatter.cookies).toBe(false)
    // Absent field stays absent (default-on).
    const parsedDefault = parseRequestFile(writeRequestFile(curlFile('/echo')), 'curl')
    if (!parsedDefault.ok) throw new Error('parse failed')
    expect(parsedDefault.file.frontmatter.cookies).toBeUndefined()
  })
})
