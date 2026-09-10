/**
 * CodeMirror decorations for OpenAPI response-validation errors: a red wavy
 * underline on each offending JSON value plus an inline message block under
 * its line. Locating a value means walking the JSON syntax tree by the error's
 * JSON pointer — the body shown is pretty-printed, so offsets are recomputed
 * against the document actually on screen rather than the wire bytes.
 *
 * Built as a StateField (not a ViewPlugin like varHighlight.ts) because block
 * widgets may only be provided through the state.
 */
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view'
import { EditorState, RangeSetBuilder, StateField, type Extension } from '@codemirror/state'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'
import type { SpecValidationError } from '../../../shared/model'

export interface PointerTarget {
  from: number
  to: number
  /** What the range covers: the value itself, an object's opening brace, or a property name. */
  kind: 'value' | 'object-open' | 'property-name'
}

/** Split a JSON pointer into unescaped tokens ('' → []). */
export function pointerTokens(pointer: string): string[] {
  if (pointer === '' || pointer === '/') return pointer === '/' ? [''] : []
  return pointer
    .split('/')
    .slice(1)
    .map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'))
}

/** Punctuation is a real node in @lezer/json's tree (`{`, `,`, `]`, …); skip it. */
const PUNCTUATION = new Set(['{', '}', '[', ']', ',', ':'])

function namedChildren(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = []
  for (let c = node.firstChild; c !== null; c = c.nextSibling) if (!PUNCTUATION.has(c.name)) out.push(c)
  return out
}

function propertyName(state: EditorState, prop: SyntaxNode): string | undefined {
  const nameNode = prop.getChild('PropertyName')
  if (nameNode === null) return undefined
  try {
    return JSON.parse(state.doc.sliceString(nameNode.from, nameNode.to)) as string
  } catch {
    return undefined
  }
}

/** Descend one pointer token from `node`, or null when it does not exist. */
function stepInto(state: EditorState, node: SyntaxNode, token: string): SyntaxNode | null {
  if (node.name === 'Object') {
    // JSON.parse keeps the last duplicate key, so match from the end.
    const props = namedChildren(node).filter((c) => c.name === 'Property')
    for (let i = props.length - 1; i >= 0; i--) {
      if (propertyName(state, props[i]) === token) {
        const value = props[i].lastChild
        return value === null || value.name === 'PropertyName' ? null : value
      }
    }
    return null
  }
  if (node.name === 'Array') {
    const index = Number(token)
    if (!Number.isInteger(index) || index < 0) return null
    const items = namedChildren(node)
    return index < items.length ? items[index] : null
  }
  return null
}

/** The syntax node for a JSON pointer, or null when the path does not exist in the document. */
function nodeAtPointer(state: EditorState, pointer: string): SyntaxNode | null {
  const tree = ensureSyntaxTree(state, state.doc.length, 500) ?? syntaxTree(state)
  let node = tree.topNode.firstChild
  for (const token of pointerTokens(pointer)) {
    if (node === null) return null
    node = stepInto(state, node, token)
  }
  return node
}

/** Character range for a JSON pointer in the (pretty-printed) document. */
export function locatePointer(state: EditorState, pointer: string): PointerTarget | null {
  const node = nodeAtPointer(state, pointer)
  if (node === null) return null
  return { from: node.from, to: node.to, kind: 'value' }
}

/** Where an error should be underlined, given its keyword. */
export function locateError(state: EditorState, err: SpecValidationError): PointerTarget | null {
  if (err.target !== 'body') return null
  if (err.keyword === 'required') {
    const obj = nodeAtPointer(state, err.instancePath)
    if (obj === null) return null
    return { from: obj.from, to: Math.min(obj.from + 1, obj.to), kind: 'object-open' }
  }
  if (err.keyword === 'additionalProperties') {
    const extra = err.params?.additionalProperty
    if (typeof extra === 'string') {
      const obj = nodeAtPointer(state, err.instancePath)
      if (obj !== null && obj.name === 'Object') {
        for (const prop of namedChildren(obj)) {
          if (prop.name === 'Property' && propertyName(state, prop) === extra) {
            const nameNode = prop.getChild('PropertyName')
            if (nameNode !== null) return { from: nameNode.from, to: nameNode.to, kind: 'property-name' }
          }
        }
      }
    }
  }
  return locatePointer(state, err.instancePath)
}

class MessageWidget extends WidgetType {
  constructor(private readonly messages: string[]) {
    super()
  }
  eq(other: MessageWidget): boolean {
    return other.messages.join('\n') === this.messages.join('\n')
  }
  toDOM(): HTMLElement {
    const dom = document.createElement('div')
    dom.className = 'cm-spec-msg'
    for (const m of this.messages) {
      const line = document.createElement('div')
      line.textContent = `✗ ${m}`
      dom.appendChild(line)
    }
    return dom
  }
  ignoreEvent(): boolean {
    return true
  }
}

const errorMark = Decoration.mark({ class: 'cm-spec-error' })

function buildDecorations(state: EditorState, errors: SpecValidationError[]): DecorationSet {
  const marks: { from: number; to: number }[] = []
  const byLine = new Map<number, string[]>()
  for (const err of errors) {
    const t = locateError(state, err)
    if (t === null) continue
    if (t.to > t.from) marks.push({ from: t.from, to: t.to })
    const line = state.doc.lineAt(t.from)
    const list = byLine.get(line.number) ?? []
    if (!list.includes(err.message)) list.push(err.message)
    byLine.set(line.number, list)
  }
  // RangeSetBuilder wants ranges sorted by start, then by side.
  const ranges: { from: number; to: number; deco: Decoration }[] = marks.map((m) => ({ ...m, deco: errorMark }))
  for (const [lineNo, messages] of byLine) {
    const line = state.doc.line(lineNo)
    ranges.push({ from: line.to, to: line.to, deco: Decoration.widget({ widget: new MessageWidget(messages), block: true, side: 1 }) })
  }
  ranges.sort((a, b) => a.from - b.from || a.to - b.to)
  const builder = new RangeSetBuilder<Decoration>()
  for (const r of ranges) builder.add(r.from, r.to, r.deco)
  return builder.finish()
}

/** Decoration extension for one validation report's body errors. */
export function specSquiggles(errors: SpecValidationError[]): Extension {
  const field = StateField.define<DecorationSet>({
    create: (state) => buildDecorations(state, errors),
    update: (value, tr) => (tr.docChanged ? buildDecorations(tr.state, errors) : value),
    provide: (f) => EditorView.decorations.from(f)
  })
  return field
}

/** Scroll the editor to an error's location and put the cursor there. */
export function jumpToError(view: EditorView, err: SpecValidationError): boolean {
  const t = locateError(view.state, err)
  if (t === null) return false
  view.dispatch({
    selection: { anchor: t.from, head: t.to },
    effects: EditorView.scrollIntoView(t.from, { y: 'center' })
  })
  return true
}
