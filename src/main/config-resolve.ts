import { promises as fs } from 'fs'
import { join } from 'path'
import type { ResolvedConfig } from '../shared/model'
import { parseConfig, resolveConfig, type ConfigChainEntry } from '../core/config'

/**
 * Walk from the collection root down to the folder containing `relPath`,
 * collecting collection.json (root) and folder.json (each folder) into an
 * outermost-first config chain, and resolve it. Missing/invalid files are
 * skipped (invalid ones are surfaced via the returned `warnings`).
 */
export async function resolveConfigChain(
  root: string,
  relPath: string
): Promise<{ config: ResolvedConfig; warnings: string[] }> {
  const warnings: string[] = []
  const chain: ConfigChainEntry[] = []

  const segments = relPath.split('/')
  segments.pop() // drop the request filename

  // Collection-level config at the root.
  await addConfig(root, 'collection.json', '<collection>', chain, warnings)

  // Folder-level config at each ancestor folder.
  let dir = ''
  for (const seg of segments) {
    dir = dir === '' ? seg : `${dir}/${seg}`
    await addConfig(join(root, dir), 'folder.json', dir, chain, warnings)
  }

  return { config: resolveConfig(chain), warnings }
}

async function addConfig(
  dirAbs: string,
  filename: string,
  origin: string,
  chain: ConfigChainEntry[],
  warnings: string[]
): Promise<void> {
  let raw: string
  try {
    raw = await fs.readFile(join(dirAbs, filename), 'utf8')
  } catch {
    return // no config at this level — normal
  }
  const parsed = parseConfig(raw)
  if (parsed.ok) chain.push({ origin, config: parsed.config })
  else warnings.push(`${origin}/${filename}: ${parsed.error}`)
}
