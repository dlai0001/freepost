/**
 * The recorded.jsonl store, shared by the app's proxy and `freepost proxy`.
 *
 * No Electron mock here, deliberately: this module must import cleanly without
 * one, since the CLI bundle contains it. An `import { app } from 'electron'`
 * creeping back in fails this file before it fails the CLI build.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RecordedExchange } from '../shared/model'
import { appendRecorded, recordedFilePath } from './recorded-store'

let root: string

function entry(over: Partial<RecordedExchange> = {}): RecordedExchange {
  return {
    id: 'e1',
    at: '2026-01-01T00:00:00Z',
    protocol: 'rest',
    method: 'GET',
    url: 'http://t/x',
    requestHeaders: [],
    status: 200,
    errored: false,
    ...over
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'freepost-recorded-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('recordedFilePath', () => {
  it('is the collection-relative recorded.jsonl the proxy and History share', () => {
    expect(recordedFilePath(root)).toBe(join(root, '.freepost', 'history', 'recorded.jsonl'))
  })
})

describe('appendRecorded', () => {
  it('appends jsonl lines owner-only (chmod 600)', () => {
    appendRecorded(root, entry({ id: 'a' }))
    appendRecorded(root, entry({ id: 'b' }))
    const file = recordedFilePath(root)
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    expect(lines.map((l) => (JSON.parse(l) as RecordedExchange).id)).toEqual(['a', 'b'])
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600)
    }
  })

  // 1001 appends — the in-memory line counter keeps this append-only until
  // the cap trips, but keep a generous timeout for a loaded suite.
  it('caps the file at 500 entries', { timeout: 30000 }, () => {
    for (let i = 0; i < 1001; i++) appendRecorded(root, entry({ id: `e${i}` }))
    const lines = readFileSync(recordedFilePath(root), 'utf8').split('\n').filter(Boolean)
    expect(lines.length).toBeLessThanOrEqual(1000)
    expect(lines.length).toBeGreaterThanOrEqual(500)
    // The newest entry always survives the trim.
    expect(lines[lines.length - 1]).toContain('"e1000"')
  })

  it('initializes its line counter from a pre-existing file (still trims at the cap)', () => {
    // 1000 lines written behind appendRecorded's back — the first append must
    // count them (not restart at 0) so the very next append trims.
    const file = recordedFilePath(root)
    mkdirSync(join(root, '.freepost', 'history'), { recursive: true })
    writeFileSync(
      file,
      Array.from({ length: 1000 }, (_, i) => JSON.stringify(entry({ id: `pre${i}` }))).join('\n') + '\n'
    )
    appendRecorded(root, entry({ id: 'fresh' }))
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    expect(lines.length).toBe(500)
    expect(lines[lines.length - 1]).toContain('"fresh"')
  })

  it('never throws when the collection root is unwritable — recording is best-effort', () => {
    expect(() => appendRecorded(join(root, 'does', 'not', 'exist', '\0bad'), entry())).not.toThrow()
  })
})
