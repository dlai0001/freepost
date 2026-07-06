import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSettings, writeSettings } from './settings'

let dir = ''
let file = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'freepost-settings-'))
  file = join(dir, 'settings.json')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('settings read/write', () => {
  it('returns empty settings when the file is absent', async () => {
    expect(await readSettings(file)).toEqual({})
  })

  it('returns empty settings when the file is corrupt', async () => {
    writeFileSync(file, 'not json {')
    expect(await readSettings(file)).toEqual({})
  })

  it('round-trips lastRoot', async () => {
    await writeSettings(file, { lastRoot: '/some/collection' })
    expect(await readSettings(file)).toEqual({ lastRoot: '/some/collection' })
  })

  it('merges patches rather than clobbering existing keys', async () => {
    await writeSettings(file, { lastRoot: '/first' })
    await writeSettings(file, {}) // no-op patch must preserve lastRoot
    expect((await readSettings(file)).lastRoot).toBe('/first')
    await writeSettings(file, { lastRoot: '/second' })
    expect((await readSettings(file)).lastRoot).toBe('/second')
  })

  it('creates the parent directory if missing', async () => {
    const nested = join(dir, 'a', 'b', 'settings.json')
    await writeSettings(nested, { lastRoot: '/x' })
    expect(await readSettings(nested)).toEqual({ lastRoot: '/x' })
  })
})
