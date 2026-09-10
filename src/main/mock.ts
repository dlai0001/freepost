/**
 * Build a mock-server route table from a collection on disk: walk the tree,
 * parse each HTTP request, read its saved examples, and hand the pair to the
 * pure router. Requests that link an OpenAPI spec (`frontmatter.spec`) also
 * contribute that spec's operations as fallback routes, synthesised from the
 * documented responses. No sockets here — the listener lives in
 * src/engine/mock-server.
 */
import { promises as fs } from 'fs'
import { join } from 'path'
import { parseRequestFile, requestKindForPath } from '../core/format'
import { buildRoutes, type MockRoute } from '../core/mock/router'
import { buildSpecRoutes, type SpecRoute } from '../core/spec/mock'
import type { RequestFile, SavedExample } from '../shared/model'
import { listFiles } from './collection'
import { exampleFilePath, readExamples } from './examples'
import { readSpec } from './spec-store'

export interface MockTables {
  /** Routes replaying saved examples (matched first). */
  routes: MockRoute[]
  /** Routes synthesised from attached specs (fallback when no example matches). */
  specRoutes: SpecRoute[]
}

/** Collect example routes and spec fallback routes in one pass over the collection. */
export async function buildMockTables(root: string): Promise<MockTables> {
  const files = await listFiles(root)
  const inputs: { relPath: string; file: RequestFile; examples: SavedExample[] }[] = []
  const specPaths = new Set<string>()
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
    const spec = parsed.file.frontmatter.spec
    if (spec !== undefined && typeof spec === 'object' && typeof spec.path === 'string') specPaths.add(spec.path)
    const examples = await readExamples(exampleFilePath(root, rel))
    if (examples.length === 0) continue
    inputs.push({ relPath: rel, file: parsed.file, examples })
  }
  const specRoutes: SpecRoute[] = []
  for (const specPath of [...specPaths].sort()) {
    const read = await readSpec(root, specPath)
    if (!read.ok) continue // a missing/broken spec just contributes no routes
    specRoutes.push(...buildSpecRoutes(read.spec, specPath))
  }
  specRoutes.sort((a, b) => paramCount(a) - paramCount(b))
  return { routes: buildRoutes(inputs), specRoutes }
}

function paramCount(r: SpecRoute): number {
  return r.segments.filter((s) => 'param' in s).length
}

/** Collect every `.curl` request with saved examples into a route table. */
export async function buildRoutesForCollection(root: string): Promise<MockRoute[]> {
  return (await buildMockTables(root)).routes
}
