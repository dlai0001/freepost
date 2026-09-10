import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { json } from '@codemirror/lang-json'
import type { SpecValidationError } from '../../../shared/model'
import { locateError, locatePointer, pointerTokens, specSquiggles } from './specSquiggles'

const doc = JSON.stringify(
  {
    id: 1,
    'a/b': { '~x': true },
    items: [{ id: 'one', name: 'x' }, { id: 2 }],
    dup: 1,
    // eslint-disable-next-line no-dupe-keys
    dupe: 2,
    nested: { deep: { value: null } }
  },
  null,
  2
).replace('"dupe": 2', '"dup": 2') // a genuine duplicate key, which JSON.parse resolves last-wins

function state(text = doc, extensions: unknown[] = []): EditorState {
  return EditorState.create({ doc: text, extensions: [json(), ...(extensions as never[])] })
}

function slice(s: EditorState, pointer: string): string | null {
  const t = locatePointer(s, pointer)
  return t === null ? null : s.doc.sliceString(t.from, t.to)
}

describe('pointerTokens', () => {
  it('splits and unescapes', () => {
    expect(pointerTokens('')).toEqual([])
    expect(pointerTokens('/a/0/b')).toEqual(['a', '0', 'b'])
    expect(pointerTokens('/a~1b/~0x')).toEqual(['a/b', '~x'])
  })
})

describe('locatePointer', () => {
  const s = state()
  it('finds root, nested properties and array items', () => {
    expect(slice(s, '')?.startsWith('{')).toBe(true)
    expect(slice(s, '/id')).toBe('1')
    expect(slice(s, '/items/0/id')).toBe('"one"')
    expect(slice(s, '/items/1')).toBe('{\n      "id": 2\n    }')
    expect(slice(s, '/nested/deep/value')).toBe('null')
  })
  it('handles escaped keys', () => {
    expect(slice(s, '/a~1b/~0x')).toBe('true')
  })
  it('resolves duplicate keys last-wins like JSON.parse', () => {
    expect(slice(s, '/dup')).toBe('2')
  })
  it('returns null for missing paths and type mismatches', () => {
    expect(locatePointer(s, '/nope')).toBeNull()
    expect(locatePointer(s, '/items/9')).toBeNull()
    expect(locatePointer(s, '/id/0')).toBeNull()
    expect(locatePointer(s, '/items/x')).toBeNull()
  })
})

describe('locateError', () => {
  const s = state()
  const err = (partial: Partial<SpecValidationError>): SpecValidationError => ({
    target: 'body',
    instancePath: '',
    keyword: 'type',
    message: 'm',
    ...partial
  })
  it('points required errors at the enclosing object brace', () => {
    const t = locateError(s, err({ keyword: 'required', instancePath: '/items/1', params: { missingProperty: 'name' } }))
    expect(t?.kind).toBe('object-open')
    expect(s.doc.sliceString(t!.from, t!.to)).toBe('{')
  })
  it('points additionalProperties errors at the property name', () => {
    const t = locateError(s, err({ keyword: 'additionalProperties', instancePath: '/items/0', params: { additionalProperty: 'name' } }))
    expect(t?.kind).toBe('property-name')
    expect(s.doc.sliceString(t!.from, t!.to)).toBe('"name"')
  })
  it('ignores header errors', () => {
    expect(locateError(s, err({ target: 'header', instancePath: 'x-id' }))).toBeNull()
  })
})

describe('specSquiggles', () => {
  it('produces a mark per located error and one message block per line', () => {
    const errors: SpecValidationError[] = [
      { target: 'body', instancePath: '/items/0/id', keyword: 'type', message: 'must be integer' },
      { target: 'body', instancePath: '/items/0/id', keyword: 'minimum', message: 'must be >= 0' },
      { target: 'body', instancePath: '/id', keyword: 'type', message: 'must be string' },
      { target: 'body', instancePath: '/missing', keyword: 'type', message: 'unlocatable' },
      { target: 'header', instancePath: 'x-id', keyword: 'required', message: 'no header' }
    ]
    const ext = specSquiggles(errors)
    const s = state(doc, [ext])
    const set = s.field(ext as never) as { size: number }
    // 2 located values → 2 marks (the duplicate pointer marks twice) + 2 line widgets.
    expect(set.size).toBe(5)
  })

  it('is empty when nothing can be located', () => {
    const ext = specSquiggles([{ target: 'body', instancePath: '/nope', keyword: 'type', message: 'x' }])
    const s = state('{"a":1}', [ext])
    expect((s.field(ext as never) as { size: number }).size).toBe(0)
  })
})
