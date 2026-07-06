/**
 * Main-process IPC: wires the pure core modules (format, vars, search,
 * sandbox, workflow, importers) and the engine to the renderer.
 */
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { existsSync, watch, type FSWatcher } from 'fs'
import { dirname, isAbsolute, join, relative, sep } from 'path'
import { IPC } from '../shared/ipc'
import type {
  RequestFile,
  RequestKind,
  SearchEntry,
  WorkflowFile,
  WorkflowValidationIssue
} from '../shared/model'
import { parseRequestFile, requestKindForPath, writeRequestFile } from '../core/format'
import { buildSearchEntry, queryIndex } from '../core/search'
import {
  healReferences,
  parseWorkflow,
  runWorkflow,
  serializeWorkflow,
  validateReferences
} from '../core/workflow'
import { importPostmanCollection } from '../core/importers/postman'
import { importCommandText } from '../core/importers/command'
import { resolveVariables, substituteModel } from '../core/vars'
import { WsClient } from '../engine'
import { ensureFreepostDir, listFiles, scanCollection } from './collection'
import { executeRequest, readEnvFile } from './execute'

/** App-global runtime variable store (PLAN.md: the "session" tier). */
const session = new Map<string, string>()

const watchers = new Map<string, FSWatcher>()
let wsCounter = 0
const wsClients = new Map<string, WsClient>()

function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, ...args)
}

function toRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/')
}

function ensureWatcher(root: string): void {
  if (watchers.has(root)) return
  let timer: NodeJS.Timeout | null = null
  try {
    const w = watch(root, { recursive: true }, (_event, filename) => {
      const name = String(filename ?? '')
      if (name.includes('.freepost') || name.includes('.git')) return
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => broadcast(IPC.collectionChanged, root), 300)
    })
    watchers.set(root, w)
  } catch {
    // Watching is best-effort (e.g. exotic filesystems); manual refresh still works.
  }
}

async function readWorkflowFile(abs: string): Promise<WorkflowFile> {
  const raw = await fs.readFile(abs, 'utf8')
  const parsed = parseWorkflow(raw)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.wf
}

function requestExistsCheck(root: string): (rel: string) => 'request' | 'missing' | 'not-a-request' {
  return (rel) => {
    const abs = join(root, rel)
    if (!existsSync(abs)) return 'missing'
    return requestKindForPath(rel) !== null ? 'request' : 'not-a-request'
  }
}

async function buildIndex(root: string): Promise<SearchEntry[]> {
  const entries: SearchEntry[] = []
  for (const rel of await listFiles(root)) {
    const abs = join(root, rel)
    if (rel.endsWith('.workflow.json')) {
      try {
        const wf = await readWorkflowFile(abs)
        entries.push(buildSearchEntry(rel, 'workflow', undefined, undefined, undefined, wf.description))
      } catch {
        /* unparseable workflow: skip from index */
      }
      continue
    }
    const kind = requestKindForPath(rel)
    if (kind === null) continue
    try {
      const raw = await fs.readFile(abs, 'utf8')
      const parsed = parseRequestFile(raw, kind)
      if (parsed.ok) {
        entries.push(
          buildSearchEntry(rel, 'request', parsed.file.frontmatter, parsed.file.http, parsed.file.ws)
        )
      } else {
        entries.push(buildSearchEntry(rel, 'request', undefined))
      }
    } catch {
      /* unreadable: skip */
    }
  }
  return entries
}

const STARTERS: Record<RequestKind, RequestFile> = {
  curl: {
    kind: 'curl',
    frontmatter: { description: '' },
    variables: [{ name: 'BASE_URL', defaultValue: 'https://api.example.com', required: false }],
    http: {
      method: 'GET',
      url: 'https://${BASE_URL}/',
      headers: [{ name: 'Accept', value: 'application/json' }],
      options: {}
    },
    comments: []
  },
  websocat: {
    kind: 'websocat',
    frontmatter: { messages: { ping: '{"op":"ping"}' } },
    variables: [{ name: 'WS_URL', defaultValue: 'ws://localhost:8080', required: false }],
    ws: { url: '${WS_URL}', headers: [] },
    comments: []
  }
}

/** PLAN.md: never persist a literal default for secret-marked variables. */
function stripSecretDefaults(file: RequestFile): RequestFile {
  const secrets = new Set(
    Object.entries(file.frontmatter.variables ?? {})
      .filter(([, meta]) => meta !== null && meta !== undefined && meta.secret === true)
      .map(([name]) => name)
  )
  if (secrets.size === 0) return file
  return {
    ...file,
    variables: file.variables.map((v) =>
      secrets.has(v.name) ? { name: v.name, required: true } : v
    )
  }
}

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC.collectionOpen, async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (res.canceled || res.filePaths.length === 0) return null
    const root = res.filePaths[0]
    ensureFreepostDir(root)
    ensureWatcher(root)
    return root
  })

  ipcMain.handle(IPC.collectionScan, async (_e, root: string) => {
    ensureFreepostDir(root)
    ensureWatcher(root)
    return scanCollection(root)
  })

  ipcMain.handle(IPC.requestRead, async (_e, abs: string) => {
    const raw = await fs.readFile(abs, 'utf8')
    const kind = requestKindForPath(abs)
    if (kind === null) throw new Error(`Not a request file: ${abs}`)
    return { raw, parsed: parseRequestFile(raw, kind) }
  })

  ipcMain.handle(IPC.requestWrite, async (_e, abs: string, file: RequestFile) => {
    const raw = writeRequestFile(stripSecretDefaults(file))
    await fs.mkdir(dirname(abs), { recursive: true })
    await fs.writeFile(abs, raw)
    return { raw }
  })

  ipcMain.handle(IPC.requestCreate, async (_e, abs: string, kind: RequestKind) => {
    if (existsSync(abs)) throw new Error('File already exists')
    await fs.mkdir(dirname(abs), { recursive: true })
    await fs.writeFile(abs, writeRequestFile(STARTERS[kind]))
  })

  ipcMain.handle(IPC.requestRename, async (_e, abs: string, newAbs: string) => {
    await fs.mkdir(dirname(newAbs), { recursive: true })
    await fs.rename(abs, newAbs)
    // Auto-heal workflow references in the containing collection (PLAN.md).
    const root = [...watchers.keys()].find((r) => abs.startsWith(r + sep))
    if (root !== undefined) {
      const oldRel = toRel(root, abs)
      const newRel = toRel(root, newAbs)
      for (const rel of await listFiles(root)) {
        if (!rel.endsWith('.workflow.json')) continue
        try {
          const wfAbs = join(root, rel)
          const wf = await readWorkflowFile(wfAbs)
          const healed = healReferences(wf, oldRel, newRel)
          if (healed.changed) await fs.writeFile(wfAbs, serializeWorkflow(healed.wf))
        } catch {
          /* unparseable workflow: leave as-is */
        }
      }
    }
  })

  ipcMain.handle(IPC.requestDelete, async (_e, abs: string) => {
    await fs.rm(abs)
  })

  ipcMain.handle(
    IPC.requestExecute,
    async (_e, args: { root: string; path: string; envPath?: string }) => {
      return executeRequest({ ...args, session })
    }
  )

  ipcMain.handle(IPC.envList, async (_e, root: string) => {
    const out: string[] = []
    for (const dir of [root, join(root, 'environments')]) {
      if (!existsSync(dir)) continue
      for (const name of await fs.readdir(dir)) {
        if (name.endsWith('.env.json')) out.push(toRel(root, join(dir, name)))
      }
    }
    return out.sort()
  })

  ipcMain.handle(IPC.envRead, async (_e, abs: string) => {
    return readEnvFile(dirname(abs), abs)
  })

  ipcMain.handle(IPC.sessionGet, () => Object.fromEntries(session))
  ipcMain.handle(IPC.sessionSet, (_e, name: string, value: string) => {
    session.set(name, value)
  })
  ipcMain.handle(IPC.sessionClear, () => {
    session.clear()
  })

  ipcMain.handle(IPC.searchQuery, async (_e, args: { root: string; query: string }) => {
    return queryIndex(await buildIndex(args.root), args.query)
  })

  ipcMain.handle(IPC.workflowRead, async (_e, abs: string) => readWorkflowFile(abs))

  ipcMain.handle(IPC.workflowWrite, async (_e, abs: string, wf: WorkflowFile) => {
    await fs.mkdir(dirname(abs), { recursive: true })
    await fs.writeFile(abs, serializeWorkflow(wf))
  })

  ipcMain.handle(
    IPC.workflowValidate,
    async (_e, args: { root: string; path: string }): Promise<WorkflowValidationIssue[]> => {
      const wf = await readWorkflowFile(join(args.root, args.path))
      return validateReferences(wf, requestExistsCheck(args.root))
    }
  )

  ipcMain.handle(
    IPC.workflowRun,
    async (_e, args: { root: string; path: string; envPath?: string }) => {
      const wf = await readWorkflowFile(join(args.root, args.path))
      const issues = validateReferences(wf, requestExistsCheck(args.root))
      if (issues.length > 0) {
        throw new Error(
          `Workflow has broken references: ${issues.map((i) => i.request).join(', ')}`
        )
      }
      const report = await runWorkflow({
        workflowPath: args.path,
        wf,
        execute: (rel) =>
          executeRequest({ root: args.root, path: rel, envPath: args.envPath, session }),
        onProgress: (r) => broadcast(IPC.workflowProgress, r)
      })
      try {
        const dir = ensureFreepostDir(args.root)
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        await fs.writeFile(
          join(dir, 'history', `workflow-${stamp}.json`),
          JSON.stringify(report, null, 2)
        )
      } catch {
        /* best-effort */
      }
      return report
    }
  )

  ipcMain.handle(
    IPC.wsConnect,
    async (_e, args: { root: string; path: string; envPath?: string }) => {
      const abs = join(args.root, args.path)
      const raw = await fs.readFile(abs, 'utf8')
      const parsed = parseRequestFile(raw, 'websocat')
      if (!parsed.ok) {
        const msgs = parsed.errors.map((er) => `line ${er.line}: ${er.message}`).join('; ')
        throw new Error(`Parse error: ${msgs}`)
      }
      const ws = parsed.file.ws
      if (ws === undefined) throw new Error('File has no websocat command')
      const env = readEnvFile(args.root, args.envPath)
      const { values, unresolved } = resolveVariables(
        parsed.file.variables,
        Object.fromEntries(session),
        env
      )
      if (unresolved.length > 0) {
        throw new Error(`Unresolved required variables: ${unresolved.join(', ')}`)
      }
      const resolved = substituteModel(ws, values)
      const id = `ws${++wsCounter}`
      const client = new WsClient()
      wsClients.set(id, client)
      client
        .on('open', () => broadcast(IPC.wsEvent, { id, type: 'open' }))
        .on('message', (data: string) => broadcast(IPC.wsEvent, { id, type: 'message', data }))
        .on('close', (code: number, reason: string) => {
          broadcast(IPC.wsEvent, { id, type: 'close', data: `${code}${reason ? ' ' + reason : ''}` })
          wsClients.delete(id)
        })
        .on('error', (err: unknown) =>
          broadcast(IPC.wsEvent, {
            id,
            type: 'error',
            data: err instanceof Error ? err.message : String(err)
          })
        )
      client.connect({ url: resolved.url, headers: resolved.headers, protocol: ws.protocol })
      return { id }
    }
  )

  ipcMain.handle(IPC.wsSend, (_e, id: string, text: string) => {
    const c = wsClients.get(id)
    if (c === undefined) throw new Error('Connection not found')
    c.send(text)
  })

  ipcMain.handle(IPC.wsClose, (_e, id: string) => {
    wsClients.get(id)?.close()
    wsClients.delete(id)
  })

  ipcMain.handle(
    IPC.importPostman,
    async (_e, args: { root: string; collectionJsonPath: string }) => {
      const jsonPath = isAbsolute(args.collectionJsonPath)
        ? args.collectionJsonPath
        : join(args.root, args.collectionJsonPath)
      return importPostmanJson(args.root, await fs.readFile(jsonPath, 'utf8'))
    }
  )

  ipcMain.handle(IPC.importBrowse, async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'Importable (shell scripts, Postman JSON)', extensions: ['sh', 'bash', 'curl', 'ws', 'txt', 'json'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  ipcMain.handle(
    IPC.importFile,
    async (_e, args: { root: string; path: string; name?: string }) => {
      const text = await fs.readFile(args.path, 'utf8')
      const trimmed = text.trimStart()
      // Postman collection JSON is auto-detected; anything else is treated as
      // a shell script containing a curl/websocat/wscat command.
      if (trimmed.startsWith('{')) {
        try {
          const obj = JSON.parse(text) as { info?: unknown }
          if (obj !== null && typeof obj === 'object' && obj.info !== undefined) {
            return importPostmanJson(args.root, text)
          }
        } catch {
          /* not JSON — fall through to command import */
        }
      }
      const fallback = args.path.split(/[\\/]/).pop()?.replace(/\.(sh|bash|txt|curl|ws)$/i, '')
      return importAsCommand(args.root, text, args.name ?? fallback)
    }
  )

  ipcMain.handle(
    IPC.importCommand,
    async (_e, args: { root: string; text: string; name?: string }) => {
      return importAsCommand(args.root, args.text, args.name)
    }
  )
}

async function importPostmanJson(root: string, json: string): Promise<{ written: string[] }> {
  const result = importPostmanCollection(json)
  if (!result.ok) throw new Error(result.error)
  const written: string[] = []
  for (const f of result.files) {
    const abs = join(root, f.relPath)
    await fs.mkdir(dirname(abs), { recursive: true })
    await fs.writeFile(abs, writeRequestFile(f.file))
    written.push(f.relPath)
  }
  return { written }
}

async function importAsCommand(
  root: string,
  text: string,
  name?: string
): Promise<{ written: string[] }> {
  const result = importCommandText(text)
  if (!result.ok) throw new Error(result.error)
  const ext = result.kind === 'curl' ? '.curl' : '.ws'
  const base = (name !== undefined && name.trim() !== '' ? name.trim() : result.suggestedName)
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\.$/, '')
  // Avoid clobbering an existing request: suffix -2, -3, ...
  let rel = `${base}${ext}`
  for (let n = 2; existsSync(join(root, rel)); n++) rel = `${base}-${n}${ext}`
  await fs.writeFile(join(root, rel), writeRequestFile(result.file))
  return { written: [rel] }
}
