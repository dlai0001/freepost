/**
 * On-disk cookie jar persistence, kept inside the collection's `.freepost/`
 * subfolder (one `cookies.json` per collection root). Reads are best-effort:
 * a missing or corrupt file yields an empty jar, never a hard failure.
 */
import { promises as fs } from 'fs'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { CookieRecord } from '../shared/model'
import { CookieJar } from '../engine'
import { ensureFreepostDir } from './collection'
import { secureFile } from './security'

export function cookieFilePath(root: string): string {
  return join(root, '.freepost', 'cookies.json')
}

/** Rebuild the jar from `<root>/.freepost/cookies.json` (empty jar when absent/corrupt). */
export function loadJar(root: string): CookieJar {
  try {
    const records: unknown = JSON.parse(readFileSync(cookieFilePath(root), 'utf8'))
    if (Array.isArray(records)) return CookieJar.fromJSON(records as CookieRecord[])
  } catch {
    /* absent or corrupt — start with an empty jar */
  }
  return new CookieJar()
}

/** Persist the jar (0600, under the gitignored `.freepost/`). Best-effort. */
export async function saveJar(root: string, jar: CookieJar): Promise<void> {
  try {
    const dir = ensureFreepostDir(root)
    const file = join(dir, 'cookies.json')
    await fs.writeFile(file, JSON.stringify(jar.toJSON(), null, 2) + '\n')
    await secureFile(file)
  } catch {
    /* persisting cookies is best-effort; never fail a request over it */
  }
}
