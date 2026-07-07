import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, placeholder as cmPlaceholder } from '@codemirror/view'
import { syntaxHighlighting } from '@codemirror/language'
import { basicSetup } from 'codemirror'
import { json } from '@codemirror/lang-json'
import { javascript } from '@codemirror/lang-javascript'
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark'

export type EditorLanguage = 'json' | 'javascript' | 'text'

interface Props {
  value: string
  onChange: (value: string) => void
  language?: EditorLanguage
  placeholder?: string
  /** Visible height in text rows (approx). */
  rows?: number
  readOnly?: boolean
}

function languageExtension(lang: EditorLanguage): ReturnType<typeof json> | [] {
  if (lang === 'json') return json()
  if (lang === 'javascript') return javascript()
  return []
}

/** Editor chrome themed to match the app's GitHub-dark palette (styles.css vars). */
function theme(rows: number): ReturnType<typeof EditorView.theme> {
  return EditorView.theme({
    '&': {
      color: 'var(--text)',
      backgroundColor: 'var(--bg)',
      border: '1px solid var(--border)',
      borderRadius: '6px',
      fontSize: '13px'
    },
    '&.cm-focused': { outline: 'none', borderColor: 'var(--accent)' },
    '.cm-scroller': {
      fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
      lineHeight: '1.5',
      minHeight: `${rows * 1.5 + 1}em`,
      maxHeight: '60vh'
    },
    '.cm-content': { caretColor: 'var(--text)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
    '.cm-gutters': {
      backgroundColor: 'var(--bg)',
      color: 'var(--muted)',
      border: 'none',
      borderRight: '1px solid var(--border)'
    },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.03)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(255,255,255,0.03)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'rgba(88,166,255,0.25)'
    },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
      backgroundColor: 'rgba(63,185,80,0.2)',
      outline: 'none'
    }
  })
}

/**
 * CodeMirror 6 editor as a controlled React component. Replaces plain
 * <textarea> for JSON/JS/GraphQL editing — syntax highlighting, bracket
 * matching, line numbers, and undo history.
 */
export default function CodeEditor(props: Props): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const langComp = useRef(new Compartment())
  const onChangeRef = useRef(props.onChange)
  onChangeRef.current = props.onChange

  // Create the editor once; later prop changes are applied via effects below.
  useEffect(() => {
    if (host.current === null) return
    const state = EditorState.create({
      doc: props.value,
      extensions: [
        basicSetup,
        langComp.current.of(languageExtension(props.language ?? 'text')),
        syntaxHighlighting(oneDarkHighlightStyle),
        theme(props.rows ?? 8),
        EditorView.lineWrapping,
        EditorState.readOnly.of(props.readOnly === true),
        props.placeholder !== undefined ? cmPlaceholder(props.placeholder) : [],
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString())
        })
      ]
    })
    const v = new EditorView({ state, parent: host.current })
    view.current = v
    return () => {
      v.destroy()
      view.current = null
    }
    // Intentionally created once — value/language/readOnly are synced via effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Sync external value changes (e.g. loading a different request) without
  // clobbering the cursor when the change originated from user typing.
  useEffect(() => {
    const v = view.current
    if (v === null) return
    const current = v.state.doc.toString()
    if (current !== props.value) {
      v.dispatch({ changes: { from: 0, to: current.length, insert: props.value } })
    }
  }, [props.value])

  useEffect(() => {
    view.current?.dispatch({
      effects: langComp.current.reconfigure(languageExtension(props.language ?? 'text'))
    })
  }, [props.language])

  return <div className="cm-host" ref={host} />
}
