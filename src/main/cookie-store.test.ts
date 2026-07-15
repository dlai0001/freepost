import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CookieRecord } from '../shared/model'
import { CookieJar } from '../engine'
import { cookieFilePath, loadJar, saveJar } from './cookie-store'

let root = ''

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'freepost-cookies-'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function record(overrides: Partial<CookieRecord>): CookieRecord {
  return {
    name: 'c',
    value: 'v',
    domain: 'h.test',
    path: '/',
    expires: null,
    secure: false,
    httpOnly: false,
    ...overrides
  }
}

describe('cookie-store', () => {
  it('returns an empty jar when the file is absent', () => {
    expect(loadJar(root).list()).toEqual([])
  })

  it('saves and reloads the jar, dropping cookies that expired on disk', async () => {
    const jar = new CookieJar()
    jar.setCookie(record({ name: 'sess' }))
    jar.setCookie(record({ name: 'live', expires: Date.now() + 60_000, sameSite: 'Strict' }))
    await saveJar(root, jar)
    expect(existsSync(cookieFilePath(root))).toBe(true)

    const loaded = loadJar(root)
    expect(loaded.list().map((c) => c.name).sort()).toEqual(['live', 'sess'])
    expect(loaded.list().find((c) => c.name === 'live')?.sameSite).toBe('Strict')

    // An expired-on-disk cookie is dropped on load.
    const stale = JSON.parse(readFileSync(cookieFilePath(root), 'utf8')) as CookieRecord[]
    stale.push(record({ name: 'dead', expires: Date.now() - 1000 }))
    writeFileSync(cookieFilePath(root), JSON.stringify(stale))
    expect(loadJar(root).list().map((c) => c.name).sort()).toEqual(['live', 'sess'])
  })

  it('tolerates a corrupt file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'freepost-cookies-corrupt-'))
    try {
      mkdirSync(join(dir, '.freepost'), { recursive: true })
      writeFileSync(cookieFilePath(dir), 'not json {')
      expect(loadJar(dir).list()).toEqual([])
      writeFileSync(cookieFilePath(dir), '{"not":"an array"}')
      expect(loadJar(dir).list()).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
