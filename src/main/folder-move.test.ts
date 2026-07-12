import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { listFiles } from './collection'
import { healReferences, parseWorkflow, serializeWorkflow } from '../core/workflow'
import type { WorkflowFile } from '../shared/model'

/**
 * Mirrors the IPC folder-rename handler's ref-healing (ipc-handlers.ts): build a
 * [oldRel, newRel] pair for every file under the folder, then rewrite every
 * workflow in the collection. Kept in lock-step with the handler.
 */
const toRel = (root: string, abs: string): string => relative(root, abs).split(sep).join('/')

async function healWorkflowRefs(root: string, pairs: [string, string][]): Promise<void> {
  if (pairs.length === 0) return
  for (const rel of await listFiles(root)) {
    if (!rel.endsWith('.workflow.json')) continue
    const wfAbs = join(root, rel)
    const parsed = parseWorkflow(await fs.readFile(wfAbs, 'utf8'))
    if (!parsed.ok) continue
    let wf: WorkflowFile = parsed.wf
    let changed = false
    for (const [oldRel, newRel] of pairs) {
      const healed = healReferences(wf, oldRel, newRel)
      if (healed.changed) {
        wf = healed.wf
        changed = true
      }
    }
    if (changed) await fs.writeFile(wfAbs, serializeWorkflow(wf))
  }
}

async function moveFolder(root: string, abs: string, newAbs: string): Promise<void> {
  const oldRel = toRel(root, abs)
  const newRel = toRel(root, newAbs)
  const pairs: [string, string][] = []
  for (const rel of await listFiles(abs)) pairs.push([`${oldRel}/${rel}`, `${newRel}/${rel}`])
  await fs.mkdir(dirname(newAbs), { recursive: true })
  await fs.rename(abs, newAbs)
  await healWorkflowRefs(root, pairs)
}

let root = ''
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'fp-move-'))
  await fs.mkdir(join(root, 'auth'), { recursive: true })
  await fs.writeFile(join(root, 'auth', 'Login.curl'), 'curl http://x/login\n')
  await fs.writeFile(join(root, 'Get IP.curl'), 'curl http://x/ip\n')
  await fs.writeFile(
    join(root, 'Smoke.workflow.json'),
    JSON.stringify({
      description: 'smoke',
      steps: [{ request: 'auth/Login.curl' }, { request: 'Get IP.curl' }]
    })
  )
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('folder move + workflow-ref healing', () => {
  it('moves the folder and re-points every affected workflow step', async () => {
    await moveFolder(root, join(root, 'auth'), join(root, 'identity', 'auth'))

    expect(existsSync(join(root, 'identity', 'auth', 'Login.curl'))).toBe(true)
    expect(existsSync(join(root, 'auth'))).toBe(false)

    const wf = JSON.parse(await fs.readFile(join(root, 'Smoke.workflow.json'), 'utf8'))
    expect(wf.steps.map((s: { request: string }) => s.request)).toEqual([
      'identity/auth/Login.curl', // re-pointed to the moved file
      'Get IP.curl' // untouched
    ])
  })
})
