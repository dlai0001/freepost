import { promises as fs } from 'fs'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join, relative, sep } from 'path'
import type { TreeNode } from '../shared/model'
import { requestKindForPath } from '../core/format'

/** PLAN.md leak guardrail: .freepost/ always carries a self-regenerating ignore-all. */
export function ensureFreepostDir(root: string): string {
  const dir = join(root, '.freepost')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.gitignore'), '*\n')
  const hist = join(dir, 'history')
  if (!existsSync(hist)) mkdirSync(hist)
  return dir
}

function isHidden(name: string): boolean {
  return name.startsWith('.')
}

export async function scanCollection(root: string): Promise<TreeNode> {
  async function scanDir(abs: string, rel: string, name: string): Promise<TreeNode> {
    const children: TreeNode[] = []
    const entries = await fs.readdir(abs, { withFileTypes: true })
    for (const e of entries) {
      if (isHidden(e.name) || e.name === 'node_modules') continue
      const childAbs = join(abs, e.name)
      const childRel = rel === '.' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) {
        children.push(await scanDir(childAbs, childRel, e.name))
      } else if (e.name.endsWith('.workflow.json')) {
        children.push({
          name: e.name.replace(/\.workflow\.json$/, ''),
          path: childRel,
          type: 'workflow'
        })
      } else {
        const kind = requestKindForPath(e.name)
        if (kind !== null) {
          children.push({
            name: e.name.replace(/\.(curl|ws)$/i, ''),
            path: childRel,
            type: 'request',
            kind
          })
        }
      }
    }
    children.sort((a, b) => {
      if (a.type === 'folder' && b.type !== 'folder') return -1
      if (a.type !== 'folder' && b.type === 'folder') return 1
      return a.name.localeCompare(b.name)
    })
    return { name, path: rel, type: 'folder', children }
  }
  return scanDir(root, '.', root.split(sep).pop() ?? root)
}

/** Recursively collect collection-relative paths of all request/workflow files. */
export async function listFiles(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(abs: string): Promise<void> {
    const entries = await fs.readdir(abs, { withFileTypes: true })
    for (const e of entries) {
      if (isHidden(e.name) || e.name === 'node_modules') continue
      const childAbs = join(abs, e.name)
      if (e.isDirectory()) await walk(childAbs)
      else out.push(relative(root, childAbs).split(sep).join('/'))
    }
  }
  await walk(root)
  return out
}
