import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { EditorState, type Extension } from '@codemirror/state'
import {
  drawSelection,
  EditorView,
  highlightSpecialChars,
  keymap,
  placeholder as cmPlaceholder
} from '@codemirror/view'
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands'
import { refreshVarsEffect, variableHighlighting, type VarLookup } from './varHighlight'

interface Props {
  value: string
  onChange?: (value: string) => void
  placeholder?: string
  /** `${VAR}` references are highlighted and get a hover hint when set. */
  varLookup?: VarLookup
  /** Extra classes on the wrapper (e.g. "grow" to flex-fill a toolbar). */
  className?: string
  title?: string
  /** Display-only: no editing, still highlighted + hoverable. */
  readOnly?: boolean
}

/** Block any edit that would introduce a newline — this is a one-line field. */
const singleLine = EditorState.transactionFilter.of((tr) =>
  tr.newDoc.lines > 1 ? [] : tr
)

/** Chrome for the single-line editor; visuals live in styles.css (.var-input). */
const inputTheme = EditorView.theme({
  '&': { backgroundColor: 'transparent' },
  '.cm-content': {
    padding: '5px 8px',
    fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
    fontSize: '13px',
    caretColor: 'var(--text)'
  },
  '.cm-line': { padding: '0' },
  '.cm-scroller': { overflowX: 'auto', overflowY: 'hidden' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'rgba(88,166,255,0.25)'
  }
})

/**
 * A single-line, input-like editor built on CodeMirror so `${VAR}` references
 * get the same highlighting + hover hints as the multi-line body/query editors.
 * Drop-in for a plain `<input className="cell-input mono">`.
 */
export default function VarInput(props: Props): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const onChangeRef = useRef(props.onChange)
  onChangeRef.current = props.onChange
  const varLookupRef = useRef(props.varLookup)
  varLookupRef.current = props.varLookup

  useEffect(() => {
    if (host.current === null) return
    const extensions: Extension[] = [
      history(),
      drawSelection(),
      highlightSpecialChars(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      singleLine,
      inputTheme,
      variableHighlighting(() => varLookupRef.current ?? null),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChangeRef.current?.(u.state.doc.toString())
      })
    ]
    if (props.readOnly === true) {
      extensions.push(EditorState.readOnly.of(true), EditorView.editable.of(false))
    }
    if (props.placeholder !== undefined) extensions.push(cmPlaceholder(props.placeholder))
    const state = EditorState.create({ doc: props.value, extensions })
    const v = new EditorView({ state, parent: host.current })
    view.current = v
    return () => {
      v.destroy()
      view.current = null
    }
    // Created once; value/lookup are synced via the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Sync external value changes without clobbering the cursor during typing.
  useEffect(() => {
    const v = view.current
    if (v === null) return
    const current = v.state.doc.toString()
    if (current !== props.value) {
      v.dispatch({ changes: { from: 0, to: current.length, insert: props.value } })
    }
  }, [props.value])

  // Rebuild decorations when the variable data changes.
  useEffect(() => {
    view.current?.dispatch({ effects: refreshVarsEffect.of(null) })
  }, [props.varLookup])

  return (
    <div
      className={'var-input mono' + (props.className !== undefined ? ' ' + props.className : '')}
      ref={host}
      title={props.title}
    />
  )
}
