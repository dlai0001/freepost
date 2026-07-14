/**
 * MCP schema snapshot & drift detection (F5).
 *
 * The ecosystem's loudest complaint is SILENT SCHEMA DRIFT: a server renames a
 * tool or retypes a parameter between versions, and every agent downstream
 * breaks with no error. Freepost's answer is its whole thesis applied to MCP —
 * write the introspection surface to a file in the collection, review it with
 * `git diff`, and fail CI when it changes in a breaking way.
 *
 * This module is PURE: no fs, no network. The caller supplies the live
 * introspection and the stored snapshot; it returns the diff.
 *
 * Breaking (fails CI):
 *   - a tool / resource / prompt disappears
 *   - a tool parameter disappears, changes type, or becomes newly required
 * Additive (warns):
 *   - anything new: a tool, a resource, a prompt, an optional parameter
 */

import type {
  McpDriftEntry,
  McpDriftReport,
  McpIntrospectionSummary,
  McpSnapshot,
  McpSnapshotTool
} from '@shared/model'

export type { McpDriftEntry, McpDriftReport, McpSnapshot, McpSnapshotTool }

/** Raw introspection (engine `McpIntrospection`) -> the comparable snapshot. */
export function buildSnapshot(introspection: McpIntrospectionSummary): McpSnapshot {
  const tools = (introspection.tools as RawTool[]).map(normaliseTool).sort(byName)
  const resources = (introspection.resources as { uri?: string }[])
    .map((r) => String(r.uri ?? ''))
    .filter((u) => u !== '')
    .sort()
  const prompts = (introspection.prompts as RawPrompt[])
    .map((p) => ({
      name: String(p.name ?? ''),
      args: (p.arguments ?? []).map((a) => String(a.name ?? '')).sort()
    }))
    .sort(byName)

  return {
    version: 1,
    server: {
      name: asString(introspection.serverInfo?.name),
      version: asString(introspection.serverInfo?.version)
    },
    capabilities: Object.keys(introspection.capabilities ?? {}).sort(),
    tools,
    resources,
    prompts
  }
}

interface RawTool {
  name?: string
  description?: string
  inputSchema?: { properties?: Record<string, { type?: string }>; required?: string[] }
  outputSchema?: unknown
}

interface RawPrompt {
  name?: string
  arguments?: { name?: string }[]
}

const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

function normaliseTool(t: RawTool): McpSnapshotTool {
  const props = t.inputSchema?.properties ?? {}
  const params: Record<string, string> = {}
  for (const key of Object.keys(props).sort()) {
    params[key] = props[key]?.type ?? 'unknown'
  }
  const out: McpSnapshotTool = {
    name: String(t.name ?? ''),
    params,
    required: [...(t.inputSchema?.required ?? [])].map(String).sort()
  }
  if (t.description !== undefined) out.description = String(t.description)
  if (t.outputSchema !== undefined) out.structured = true
  return out
}

/** Compare a live snapshot against the stored one. */
export function diffSnapshots(stored: McpSnapshot, live: McpSnapshot): McpDriftReport {
  const entries: McpDriftEntry[] = []

  const storedTools = new Map(stored.tools.map((t) => [t.name, t]))
  const liveTools = new Map(live.tools.map((t) => [t.name, t]))

  for (const [name, before] of storedTools) {
    const after = liveTools.get(name)
    if (after === undefined) {
      entries.push({ kind: 'tool-removed', breaking: true, message: `tool "${name}" was removed` })
      continue
    }
    for (const [param, type] of Object.entries(before.params)) {
      const now = after.params[param]
      if (now === undefined) {
        entries.push({
          kind: 'param-removed',
          breaking: true,
          message: `tool "${name}": param "${param}" was removed`
        })
      } else if (now !== type) {
        entries.push({
          kind: 'param-retyped',
          breaking: true,
          message: `tool "${name}": param "${param}" changed type ${type} -> ${now}`
        })
      }
    }
    for (const param of Object.keys(after.params)) {
      if (before.params[param] !== undefined) continue
      // A NEW REQUIRED param breaks every existing caller; a new optional one doesn't.
      const nowRequired = after.required.includes(param)
      entries.push({
        kind: 'param-added',
        breaking: nowRequired,
        message: `tool "${name}": param "${param}" was added${nowRequired ? ' (required)' : ''}`
      })
    }
    for (const param of after.required) {
      if (!before.params[param]) continue // already reported as param-added
      if (before.required.includes(param)) continue
      entries.push({
        kind: 'param-now-required',
        breaking: true,
        message: `tool "${name}": param "${param}" is now required`
      })
    }
    for (const param of before.required) {
      if (after.params[param] === undefined) continue // already reported as param-removed
      if (after.required.includes(param)) continue
      entries.push({
        kind: 'param-now-optional',
        breaking: false,
        message: `tool "${name}": param "${param}" is no longer required`
      })
    }
  }
  for (const name of liveTools.keys()) {
    if (!storedTools.has(name)) {
      entries.push({ kind: 'tool-added', breaking: false, message: `tool "${name}" was added` })
    }
  }

  diffList(stored.resources, live.resources, 'resource', entries)

  const storedPrompts = new Map(stored.prompts.map((p) => [p.name, p]))
  const livePrompts = new Map(live.prompts.map((p) => [p.name, p]))
  for (const [name, before] of storedPrompts) {
    const after = livePrompts.get(name)
    if (after === undefined) {
      entries.push({ kind: 'prompt-removed', breaking: true, message: `prompt "${name}" was removed` })
      continue
    }
    for (const a of before.args) {
      if (!after.args.includes(a)) {
        entries.push({
          kind: 'prompt-arg-removed',
          breaking: true,
          message: `prompt "${name}": argument "${a}" was removed`
        })
      }
    }
    for (const a of after.args) {
      if (!before.args.includes(a)) {
        entries.push({
          kind: 'prompt-arg-added',
          breaking: false,
          message: `prompt "${name}": argument "${a}" was added`
        })
      }
    }
  }
  for (const name of livePrompts.keys()) {
    if (!storedPrompts.has(name)) {
      entries.push({ kind: 'prompt-added', breaking: false, message: `prompt "${name}" was added` })
    }
  }

  return {
    clean: entries.length === 0,
    breaking: entries.some((e) => e.breaking),
    entries
  }
}

function diffList(before: string[], after: string[], label: 'resource', entries: McpDriftEntry[]): void {
  for (const x of before) {
    if (!after.includes(x)) {
      entries.push({ kind: 'resource-removed', breaking: true, message: `${label} "${x}" was removed` })
    }
  }
  for (const x of after) {
    if (!before.includes(x)) {
      entries.push({ kind: 'resource-added', breaking: false, message: `${label} "${x}" was added` })
    }
  }
}

/** Canonical on-disk form: stable key order, newline-terminated, git-diff friendly. */
export function serializeSnapshot(s: McpSnapshot): string {
  return JSON.stringify(s, null, 2) + '\n'
}

export function parseSnapshot(text: string): McpSnapshot | null {
  try {
    const parsed = JSON.parse(text) as McpSnapshot
    if (parsed.version !== 1 || !Array.isArray(parsed.tools)) return null
    return parsed
  } catch {
    return null
  }
}
