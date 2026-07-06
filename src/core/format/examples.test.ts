import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseRequestFile, requestKindForPath, writeRequestFile } from './index'

const ROOT = join(__dirname, '..', '..', '..', 'examples', 'demo-collection')

function collect(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...collect(full))
    else out.push(full)
  }
  return out
}

describe('shipped examples', () => {
  const requestFiles = collect(ROOT).filter((p) => requestKindForPath(p) !== null)

  it('exist', () => {
    expect(requestFiles.length).toBeGreaterThanOrEqual(4)
  })

  for (const path of requestFiles) {
    it(`${path.split('/').pop()} parses and is canonical`, () => {
      const raw = readFileSync(path, 'utf8')
      const kind = requestKindForPath(path)!
      const parsed = parseRequestFile(raw, kind)
      expect(parsed.ok, JSON.stringify(!parsed.ok ? parsed.errors : '')).toBe(true)
      if (parsed.ok) {
        // Shipped examples must be in canonical form (writer is the source).
        expect(writeRequestFile(parsed.file)).toBe(raw)
      }
    })
  }
})
