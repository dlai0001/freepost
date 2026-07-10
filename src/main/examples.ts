/**
 * Saved-example sidecar helpers (Name.curl -> Name.examples.json). Shared by the
 * IPC example handlers, the mock server (src/main/mock.ts), and the CLI.
 */
import { promises as fs } from 'fs'
import { join } from 'path'
import type { SavedExample } from '../shared/model'

/** Path of the examples sidecar next to a request file. */
export function exampleFilePath(root: string, relPath: string): string {
  const base = relPath.replace(/\.(curl|ws)$/i, '')
  return join(root, `${base}.examples.json`)
}

/** Read a request's saved examples, or [] when absent/unparseable. */
export async function readExamples(file: string): Promise<SavedExample[]> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as SavedExample[]
  } catch {
    return []
  }
}
