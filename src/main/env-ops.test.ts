import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEnv, deleteEnv, duplicateEnv, renameEnv, writeEnv } from './env-ops'

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'freepost-envops-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const read = (rel: string): string => readFileSync(join(root, rel), 'utf8')

describe('createEnv', () => {
  it('creates an empty env under environments/ and returns its rel path', async () => {
    const rel = await createEnv({ root, name: 'staging', local: false })
    expect(rel).toBe('environments/staging.env.json')
    expect(read(rel)).toBe('{}\n')
  })

  it('routes secret envs to a .local.env.json file', async () => {
    const rel = await createEnv({ root, name: 'staging', local: true })
    expect(rel).toBe('environments/staging.local.env.json')
    expect(existsSync(join(root, rel))).toBe(true)
  })

  it('sanitizes the name and strips a typed suffix', async () => {
    const rel = await createEnv({ root, name: 'my/prod.env.json', local: false })
    expect(rel).toBe('environments/myprod.env.json')
  })

  it('rejects a name that sanitizes to empty', async () => {
    await expect(createEnv({ root, name: '///', local: false })).rejects.toThrow(
      'Invalid environment name'
    )
  })

  it('refuses to clobber an existing env', async () => {
    await createEnv({ root, name: 'prod', local: false })
    await expect(createEnv({ root, name: 'prod', local: false })).rejects.toThrow(
      'already exists'
    )
  })
})

describe('writeEnv', () => {
  it('writes canonical, key-sorted JSON', async () => {
    const rel = await createEnv({ root, name: 'prod', local: false })
    await writeEnv({ root, path: rel, values: { TOKEN: 'xyz', BASE_URL: 'https://api' } })
    expect(read(rel)).toBe('{\n  "BASE_URL": "https://api",\n  "TOKEN": "xyz"\n}\n')
  })

  it('creates parent directories if missing', async () => {
    await writeEnv({ root, path: 'environments/deep.env.json', values: { A: '1' } })
    expect(read('environments/deep.env.json')).toContain('"A": "1"')
  })
})

describe('renameEnv', () => {
  it('renames in place and preserves the .local secret suffix', async () => {
    const rel = await createEnv({ root, name: 'stag', local: true })
    await writeEnv({ root, path: rel, values: { A: '1' } })
    const newRel = await renameEnv({ root, path: rel, newName: 'staging' })
    expect(newRel).toBe('environments/staging.local.env.json')
    expect(existsSync(join(root, rel))).toBe(false)
    expect(read(newRel)).toContain('"A": "1"')
  })

  it('rejects a rename that collides with another env', async () => {
    const a = await createEnv({ root, name: 'a', local: false })
    await createEnv({ root, name: 'b', local: false })
    await expect(renameEnv({ root, path: a, newName: 'b' })).rejects.toThrow('already exists')
  })
})

describe('duplicateEnv', () => {
  it('copies the variables into a new file, preserving secret-ness', async () => {
    const rel = await createEnv({ root, name: 'prod', local: true })
    await writeEnv({ root, path: rel, values: { TOKEN: 'secret' } })
    const copy = await duplicateEnv({ root, path: rel, newName: 'prod-copy' })
    expect(copy).toBe('environments/prod-copy.local.env.json')
    expect(read(copy)).toContain('"TOKEN": "secret"')
    // Source is untouched.
    expect(read(rel)).toContain('"TOKEN": "secret"')
  })

  it('refuses to overwrite an existing target', async () => {
    const rel = await createEnv({ root, name: 'prod', local: false })
    await createEnv({ root, name: 'prod-copy', local: false })
    await expect(duplicateEnv({ root, path: rel, newName: 'prod-copy' })).rejects.toThrow(
      'already exists'
    )
  })
})

describe('deleteEnv', () => {
  it('removes the file', async () => {
    const rel = await createEnv({ root, name: 'temp', local: false })
    await deleteEnv({ root, path: rel })
    expect(existsSync(join(root, rel))).toBe(false)
  })
})

describe('full lifecycle on a root-level env', () => {
  it('handles envs that live at the collection root, not just environments/', async () => {
    // A pre-existing root-level env (freepost lists these too).
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'legacy.env.json'), '{"OLD":"1"}\n')
    const renamed = await renameEnv({ root, path: 'legacy.env.json', newName: 'current' })
    expect(renamed).toBe('current.env.json') // stays at root, no environments/ prefix
    // rename moves the file as-is (no reserialization), so original bytes survive.
    expect(JSON.parse(read('current.env.json'))).toEqual({ OLD: '1' })
    expect(existsSync(join(root, 'legacy.env.json'))).toBe(false)
  })
})
