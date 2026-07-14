import { describe, expect, it } from 'vitest'
import {
  buildSnapshot,
  diffSnapshots,
  parseSnapshot,
  serializeSnapshot,
  type McpSnapshot
} from './snapshot'

const introspection = (
  tools: unknown[],
  resources: unknown[] = [],
  prompts: unknown[] = []
): Parameters<typeof buildSnapshot>[0] => ({
  tools,
  resources,
  resourceTemplates: [],
  prompts,
  capabilities: { tools: {}, resources: {} },
  serverInfo: { name: 'srv', version: '1.0.0' }
})

const GET_SUM = {
  name: 'get-sum',
  description: 'add',
  inputSchema: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b']
  }
}

const base = (): McpSnapshot =>
  buildSnapshot(introspection([GET_SUM], [{ uri: 'demo://x' }], [{ name: 'greet', arguments: [{ name: 'who' }] }]))

describe('buildSnapshot', () => {
  it('normalises the introspection surface into a stable, sorted shape', () => {
    const s = buildSnapshot(introspection([{ name: 'z', inputSchema: { properties: { b: { type: 'string' } } } }, GET_SUM]))
    expect(s.version).toBe(1)
    expect(s.tools.map((t) => t.name)).toEqual(['get-sum', 'z']) // sorted, so git diffs stay small
    expect(s.tools[0].params).toEqual({ a: 'number', b: 'number' })
    expect(s.tools[0].required).toEqual(['a', 'b'])
    expect(s.server).toEqual({ name: 'srv', version: '1.0.0' })
    expect(s.capabilities).toEqual(['resources', 'tools'])
  })

  it('records an unknown param type rather than dropping the param', () => {
    const s = buildSnapshot(introspection([{ name: 't', inputSchema: { properties: { x: {} } } }]))
    expect(s.tools[0].params).toEqual({ x: 'unknown' })
  })

  it('flags tools that declare structured output', () => {
    const s = buildSnapshot(introspection([{ name: 't', outputSchema: { type: 'object' } }]))
    expect(s.tools[0].structured).toBe(true)
  })
})

describe('diffSnapshots — breaking changes fail CI', () => {
  it('reports a clean diff when nothing changed', () => {
    const r = diffSnapshots(base(), base())
    expect(r.clean).toBe(true)
    expect(r.breaking).toBe(false)
    expect(r.entries).toEqual([])
  })

  it('flags a removed tool as breaking', () => {
    const r = diffSnapshots(base(), buildSnapshot(introspection([], [{ uri: 'demo://x' }], [{ name: 'greet', arguments: [{ name: 'who' }] }])))
    expect(r.breaking).toBe(true)
    expect(r.entries[0]).toMatchObject({ kind: 'tool-removed', breaking: true })
    expect(r.entries[0].message).toMatch(/get-sum/)
  })

  it('flags a retyped param as breaking', () => {
    const retyped = { ...GET_SUM, inputSchema: { properties: { a: { type: 'string' }, b: { type: 'number' } }, required: ['a', 'b'] } }
    const r = diffSnapshots(base(), buildSnapshot(introspection([retyped], [{ uri: 'demo://x' }], [{ name: 'greet', arguments: [{ name: 'who' }] }])))
    expect(r.breaking).toBe(true)
    expect(r.entries.find((e) => e.kind === 'param-retyped')?.message).toMatch(/number -> string/)
  })

  it('flags a removed param as breaking', () => {
    const gone = { ...GET_SUM, inputSchema: { properties: { a: { type: 'number' } }, required: ['a'] } }
    const r = diffSnapshots(base(), buildSnapshot(introspection([gone], [{ uri: 'demo://x' }], [{ name: 'greet', arguments: [{ name: 'who' }] }])))
    expect(r.entries.some((e) => e.kind === 'param-removed' && e.breaking)).toBe(true)
  })

  it('treats a NEW REQUIRED param as breaking but a new optional one as additive', () => {
    const withRequired = {
      ...GET_SUM,
      inputSchema: { properties: { a: { type: 'number' }, b: { type: 'number' }, c: { type: 'number' } }, required: ['a', 'b', 'c'] }
    }
    const req = diffSnapshots(base(), buildSnapshot(introspection([withRequired], [{ uri: 'demo://x' }], [{ name: 'greet', arguments: [{ name: 'who' }] }])))
    expect(req.breaking).toBe(true)
    expect(req.entries.find((e) => e.kind === 'param-added')?.message).toMatch(/\(required\)/)

    const withOptional = {
      ...GET_SUM,
      inputSchema: { properties: { a: { type: 'number' }, b: { type: 'number' }, c: { type: 'number' } }, required: ['a', 'b'] }
    }
    const opt = diffSnapshots(base(), buildSnapshot(introspection([withOptional], [{ uri: 'demo://x' }], [{ name: 'greet', arguments: [{ name: 'who' }] }])))
    expect(opt.breaking).toBe(false)
    expect(opt.clean).toBe(false)
    expect(opt.entries[0].kind).toBe('param-added')
  })

  it('flags a param that became required, and does not flag one that became optional', () => {
    const nowRequired = buildSnapshot(
      introspection([{ name: 'get-sum', description: 'add', inputSchema: { properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } }])
    )
    const wasOptional = buildSnapshot(
      introspection([{ name: 'get-sum', description: 'add', inputSchema: { properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a'] } }])
    )
    const tighten = diffSnapshots(wasOptional, nowRequired)
    expect(tighten.breaking).toBe(true)
    expect(tighten.entries[0].kind).toBe('param-now-required')

    const relax = diffSnapshots(nowRequired, wasOptional)
    expect(relax.breaking).toBe(false)
    expect(relax.entries[0].kind).toBe('param-now-optional')
  })

  it('treats an added tool as additive, not breaking', () => {
    const more = buildSnapshot(
      introspection([GET_SUM, { name: 'new-tool' }], [{ uri: 'demo://x' }], [{ name: 'greet', arguments: [{ name: 'who' }] }])
    )
    const r = diffSnapshots(base(), more)
    expect(r.breaking).toBe(false)
    expect(r.clean).toBe(false)
    expect(r.entries[0]).toMatchObject({ kind: 'tool-added', breaking: false })
  })

  it('flags removed resources and prompts as breaking', () => {
    const r = diffSnapshots(base(), buildSnapshot(introspection([GET_SUM])))
    expect(r.breaking).toBe(true)
    expect(r.entries.map((e) => e.kind)).toEqual(expect.arrayContaining(['resource-removed', 'prompt-removed']))
  })

  it('flags a removed prompt argument as breaking', () => {
    const r = diffSnapshots(
      base(),
      buildSnapshot(introspection([GET_SUM], [{ uri: 'demo://x' }], [{ name: 'greet', arguments: [] }]))
    )
    expect(r.entries.find((e) => e.kind === 'prompt-arg-removed')?.breaking).toBe(true)
  })
})

describe('snapshot serialization', () => {
  it('round-trips through serialize/parse', () => {
    const s = base()
    const parsed = parseSnapshot(serializeSnapshot(s))
    expect(parsed).toEqual(s)
  })

  it('ends with a newline so git diffs stay clean', () => {
    expect(serializeSnapshot(base()).endsWith('\n')).toBe(true)
  })

  it('rejects junk and a future snapshot version', () => {
    expect(parseSnapshot('not json')).toBeNull()
    expect(parseSnapshot(JSON.stringify({ version: 2, tools: [] }))).toBeNull()
  })
})
