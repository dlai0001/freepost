import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpRequestModel } from '../shared/model'

/**
 * The consent store lives in the app's userData dir (NOT in the collection —
 * consent shipped inside a collection could be forged by whoever wrote it).
 * electron's `app` is the only thing to stub here.
 */
const userData = mkdtempSync(join(tmpdir(), 'freepost-consent-'))
vi.mock('electron', () => ({ app: { getPath: (): string => userData } }))

const { approveSpawn, approvedCommands, isSpawnApproved, needsConsent, revokeSpawn, spawnCommand } =
  await import('./mcp-consent')

const stdio = (over: Partial<McpRequestModel> = {}): McpRequestModel => ({
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@evil/server'],
  env: [],
  headers: [],
  method: 'tools/list',
  toolArgs: [],
  promptArgs: [],
  ...over
})

const http = (): McpRequestModel => ({
  transport: 'http',
  url: 'http://localhost:3011/mcp',
  args: [],
  env: [],
  headers: [],
  method: 'tools/list',
  toolArgs: [],
  promptArgs: []
})

const ROOT = '/collections/demo'

beforeEach(() => {
  for (const c of approvedCommands(ROOT)) revokeSpawn(ROOT, c)
})

afterAll(() => rmSync(userData, { recursive: true, force: true }))

describe('needsConsent', () => {
  it('requires consent for a stdio server (it spawns a subprocess)', () => {
    expect(needsConsent(stdio())).toBe(true)
  })

  it('never requires consent for an http server (nothing is spawned)', () => {
    expect(needsConsent(http())).toBe(false)
    expect(isSpawnApproved(ROOT, http())).toBe(true)
  })

  it('does not require consent for a stdio model with no command', () => {
    expect(needsConsent(stdio({ command: '', args: [] }))).toBe(false)
  })
})

describe('spawnCommand', () => {
  it('is the exact command line the user will be shown and that will run', () => {
    expect(spawnCommand(stdio())).toBe('npx -y @evil/server')
  })
})

describe('approval', () => {
  it('denies an unapproved server, allows it only after approval', () => {
    const m = stdio()
    expect(isSpawnApproved(ROOT, m)).toBe(false)
    approveSpawn(ROOT, spawnCommand(m))
    expect(isSpawnApproved(ROOT, m)).toBe(true)
  })

  it('scopes approval to the exact command — a changed argument needs re-approval', () => {
    approveSpawn(ROOT, spawnCommand(stdio()))
    // The collection now points at a DIFFERENT program: consent must not carry over.
    expect(isSpawnApproved(ROOT, stdio({ args: ['-y', '@other/server'] }))).toBe(false)
  })

  it('scopes approval to the collection — the same command elsewhere needs re-approval', () => {
    approveSpawn(ROOT, spawnCommand(stdio()))
    expect(isSpawnApproved('/collections/untrusted', stdio())).toBe(false)
  })

  it('persists across reads and can be revoked', () => {
    const m = stdio()
    approveSpawn(ROOT, spawnCommand(m))
    expect(approvedCommands(ROOT)).toEqual(['npx -y @evil/server'])
    revokeSpawn(ROOT, spawnCommand(m))
    expect(isSpawnApproved(ROOT, m)).toBe(false)
    expect(approvedCommands(ROOT)).toEqual([])
  })
})
