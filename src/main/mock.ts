/**
 * Build a mock-server route table from a collection on disk: walk the tree,
 * parse each HTTP request, read its saved examples, and hand the pair to the
 * pure router. No sockets here — the listener lives in src/engine/mock-server.
 */
import { promises as fs } from 'fs'
import { join } from 'path'
import { parseRequestFile, requestKindForPath } from '../core/format'
import { buildRoutes, type MockRoute } from '../core/mock/router'
import { listFiles } from './collection'
import { exampleFilePath, readExamples } from './examples'

/** Collect every `.curl` request with saved examples into a route table. */
export async function buildRoutesForCollection(root: string): Promise<MockRoute[]> {
  const files = await listFiles(root)
  const inputs: { relPath: string; file: import('../shared/model').RequestFile; examples: import('../shared/model').SavedExample[] }[] = []
  for (const rel of files) {
    if (requestKindForPath(rel) !== 'curl') continue // only HTTP requests mock
    let raw: string
    try {
      raw = await fs.readFile(join(root, rel), 'utf8')
    } catch {
      continue
    }
    const parsed = parseRequestFile(raw, 'curl')
    if (!parsed.ok || parsed.file.http === undefined) continue
    const examples = await readExamples(exampleFilePath(root, rel))
    if (examples.length === 0) continue
    inputs.push({ relPath: rel, file: parsed.file, examples })
  }
  return buildRoutes(inputs)
}
