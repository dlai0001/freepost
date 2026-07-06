import { describe, expect, it } from 'vitest'
import { extractFrontmatter, serializeFrontmatter } from './frontmatter'

const lines = (text: string): string[] => text.split('\n')

function extractOk(text: string, startIndex = 0) {
  const r = extractFrontmatter(lines(text), startIndex)
  expect(r.ok).toBe(true)
  if (!r.ok) throw new Error('expected ok')
  return r
}

function extractErr(text: string, startIndex = 0) {
  const r = extractFrontmatter(lines(text), startIndex)
  expect(r.ok).toBe(false)
  if (r.ok) throw new Error('expected error')
  expect(r.errors.length).toBeGreaterThan(0)
  return r.errors[0]
}

describe('extractFrontmatter', () => {
  it('parses the PLAN.md-style block', () => {
    const text = [
      '# ---',
      '# description: Fetches a single user record by id',
      '# label:',
      '#   - users',
      '#   - smoke',
      '# seq: 20',
      '# variables:',
      '#   token: { secret: true }',
      '# scripts:',
      '#   pre-request: |',
      '#     pm.variables.set("ts", Date.now());',
      '# ---',
      'rest',
    ].join('\n')
    const r = extractOk(text)
    expect(r.frontmatter).toEqual({
      description: 'Fetches a single user record by id',
      label: ['users', 'smoke'],
      seq: 20,
      variables: { token: { secret: true } },
      scripts: { 'pre-request': 'pm.variables.set("ts", Date.now());\n' },
    })
    expect(r.nextIndex).toBe(12)
  })

  it('returns empty frontmatter when no block is present', () => {
    const r = extractOk('curl --url x')
    expect(r.frontmatter).toEqual({})
    expect(r.nextIndex).toBe(0)
  })

  it('accepts bare "#" as an empty YAML line', () => {
    const r = extractOk(['# ---', '# description: a', '#', '# seq: 1', '# ---'].join('\n'))
    expect(r.frontmatter).toEqual({ description: 'a', seq: 1 })
  })

  it('treats an all-comment empty block as empty frontmatter', () => {
    const r = extractOk(['# ---', '# ---', 'x'].join('\n'))
    expect(r.frontmatter).toEqual({})
    expect(r.nextIndex).toBe(2)
  })

  it('rejects an unterminated block with the opening line number', () => {
    const e = extractErr(['# ---', '# description: a'].join('\n'))
    expect(e.line).toBe(1)
    expect(e.message).toMatch(/unterminated frontmatter/)
  })

  it('rejects a non-comment line inside the block with its line number', () => {
    const e = extractErr(['# ---', '# description: a', 'oops: not a comment', '# ---'].join('\n'))
    expect(e.line).toBe(3)
    expect(e.message).toMatch(/must start with "# "/)
  })

  it('rejects invalid YAML with a line number inside the block', () => {
    const e = extractErr(['# ---', '# description: a', '# [broken', '# ---'].join('\n'))
    expect(e.message).toMatch(/invalid YAML/)
    expect(e.line).toBeGreaterThanOrEqual(3)
  })

  it('rejects non-mapping YAML', () => {
    const e = extractErr(['# ---', '# - just', '# - a list', '# ---'].join('\n'))
    expect(e.message).toMatch(/YAML mapping/)
  })

  it('respects startIndex (block after a shebang)', () => {
    const r = extractOk(['#!/usr/bin/env bash', '# ---', '# seq: 3', '# ---'].join('\n'), 1)
    expect(r.frontmatter).toEqual({ seq: 3 })
    expect(r.nextIndex).toBe(4)
  })
})

describe('serializeFrontmatter', () => {
  it('returns an empty string for empty frontmatter', () => {
    expect(serializeFrontmatter({})).toBe('')
    expect(serializeFrontmatter({ description: undefined })).toBe('')
  })

  it('emits a # ----delimited block with "# " prefixes', () => {
    const block = serializeFrontmatter({ description: 'hello', label: ['a', 'b'] })
    expect(block.split('\n')).toEqual([
      '# ---',
      '# description: hello',
      '# label:',
      '#   - a',
      '#   - b',
      '# ---',
    ])
  })

  it('round-trips unknown keys verbatim (values preserved)', () => {
    const original = {
      description: 'd',
      'x-vendor-extension': { nested: ['a', 'b'], num: 3.5, flag: true },
      anotherUnknown: 'plain string',
      variables: { token: { secret: true }, plain: null },
    }
    const block = serializeFrontmatter(original)
    const r = extractFrontmatter(block.split('\n'), 0)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('expected ok')
    expect(r.frontmatter).toEqual(original)
  })

  it('round-trips multiline script values', () => {
    const original = {
      scripts: {
        'pre-request': 'pm.variables.set("ts", Date.now());\n',
        test: 'pm.test("a", () => 1);\npm.test("b", () => 2);\n',
      },
    }
    const block = serializeFrontmatter(original)
    const r = extractFrontmatter(block.split('\n'), 0)
    if (!r.ok) throw new Error('expected ok')
    expect(r.frontmatter).toEqual(original)
  })

  it('round-trips empty lines inside block scalars via bare "#"', () => {
    const original = { scripts: { test: 'line1;\n\nline2;\n' } }
    const block = serializeFrontmatter(original)
    expect(block).toContain('\n#\n')
    const r = extractFrontmatter(block.split('\n'), 0)
    if (!r.ok) throw new Error('expected ok')
    expect(r.frontmatter).toEqual(original)
  })
})
