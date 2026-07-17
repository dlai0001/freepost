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

  it('round-trips the proxy target and port alongside other keys', async () => {
    await writeSettings(file, { lastRoot: '/some/collection' })
    await writeSettings(file, { proxyTarget: 'http://localhost:3000', proxyPort: 7699 })
    await writeSettings(file, { proxyHttpsEnabled: true, proxyHttpsPort: 7700 })
    expect(await readSettings(file)).toEqual({
      lastRoot: '/some/collection',
      proxyTarget: 'http://localhost:3000',
      proxyPort: 7699,
      proxyHttpsEnabled: true,
      proxyHttpsPort: 7700
    })
  })

  it('round-trips the MQTT relay prefill (its own target, not proxyTarget)', async () => {
    await writeSettings(file, { proxyTarget: 'http://localhost:3000', proxyPort: 7699 })
    await writeSettings(file, {
      proxyMqttEnabled: true,
      proxyMqttTarget: 'mqtt://127.0.0.1:1883',
      proxyMqttPort: 7883
    })
    expect(await readSettings(file)).toEqual({
      proxyTarget: 'http://localhost:3000',
      proxyPort: 7699,
      proxyMqttEnabled: true,
      proxyMqttTarget: 'mqtt://127.0.0.1:1883',
      proxyMqttPort: 7883
    })
  })

  it('remembers the MQTT relay being turned back off, keeping its prefill', async () => {
    await writeSettings(file, { proxyMqttEnabled: true, proxyMqttTarget: 'mqtt://b:1883' })
    await writeSettings(file, { proxyMqttEnabled: false })
    expect(await readSettings(file)).toEqual({
      proxyMqttEnabled: false,
      proxyMqttTarget: 'mqtt://b:1883'
    })
  })

  it('creates the parent directory if missing', async () => {
    const nested = join(dir, 'a', 'b', 'settings.json')
    await writeSettings(nested, { lastRoot: '/x' })
    expect(await readSettings(nested)).toEqual({ lastRoot: '/x' })
  })
})
