import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { trackedSecrets } from './security'

let root = ''

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'freepost-sec-'))
  mkdirSync(join(root, '.freepost'), { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('trackedSecrets', () => {
  it('returns [] when the collection is not a git repo', async () => {
    expect(await trackedSecrets(root)).toEqual([])
  })

  it('returns [] when .freepost/ exists but nothing under it is tracked', async () => {
    git(root, 'init')
    writeFileSync(join(root, '.freepost', 'secret.token'), 'abc')
    // Not added — the app's .gitignore would normally exclude it.
    expect(await trackedSecrets(root)).toEqual([])
  })

  it('flags files under .freepost/ that were force-added to git', async () => {
    git(root, 'init')
    git(root, 'config', 'user.email', 'test@example.com')
    git(root, 'config', 'user.name', 'Test')
    writeFileSync(join(root, '.freepost', '.gitignore'), '*\n')
    writeFileSync(join(root, '.freepost', 'token.json'), '{"t":"secret"}')
    git(root, 'add', '-f', '.freepost/token.json') // someone bypassed the ignore
    const tracked = await trackedSecrets(root)
    expect(tracked).toContain('.freepost/token.json')
  })
})
