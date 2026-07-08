/**
 * Shared CodeMirror + input helpers for `${VAR}` variable highlighting.
 *
 * Wherever a request references a variable, we colour the `${...}` token by
 * where its value resolves from (session > environment > request default) and
 * offer a hover tooltip showing the effective value and its source. The lookup
 * is supplied by the host component (RequestTab) via a getter, so decorations
 * and tooltips always reflect the live session/env/declaration state.
 */
import {
  Decoration,
  type DecorationSet,
  EditorView,
  hoverTooltip,
  ViewPlugin,
  type ViewUpdate
} from '@codemirror/view'
import { type Extension, RangeSetBuilder, StateEffect } from '@codemirror/state'

/** Where a variable's effective value comes from. */
export type VarSource = 'session' | 'env' | 'request' | 'unresolved'

/** Resolution outcome for one variable reference, driving colour + tooltip. */
export interface VarInfo {
  name: string
  /** Effective value, if any. Undefined when unresolved. */
  value?: string
  source: VarSource
  /** Value is masked (secret request var or secret environment). */
  secret?: boolean
  /** Declared `${NAME:?}` with no session/env value — a hard blocker at send. */
  required?: boolean
}

/** Resolve a variable name to its effective value + source. */
export type VarLookup = (name: string) => VarInfo

/**
 * Dispatch this effect to force decorations to rebuild when the underlying
 * variable data (session/env/declarations) changes without an edit.
 */
export const refreshVarsEffect = StateEffect.define<null>()

/** Matches ${NAME}, ${NAME:-default}, ${NAME:?}; group 1 is the name. */
const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::[-?][^}]*)?\}/g

function markFor(info: VarInfo): Decoration {
  const cls = `cm-var cm-var-${info.source}` + (info.secret === true ? ' cm-var-secret' : '')
  return Decoration.mark({ class: cls })
}

function buildDecorations(view: EditorView, lookup: VarLookup | null): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  if (lookup === null) return builder.finish()
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to)
    VAR_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = VAR_RE.exec(text)) !== null) {
      const start = from + m.index
      builder.add(start, start + m[0].length, markFor(lookup(m[1])))
    }
  }
  return builder.finish()
}

/** Human label for the source tier. */
function sourceLabel(source: VarSource): string {
  switch (source) {
    case 'session':
      return 'session variable'
    case 'env':
      return 'environment variable'
    case 'request':
      return 'request variable'
    default:
      return 'unresolved'
  }
}

/** Build the tooltip DOM for a hovered variable reference. */
function tooltipDom(info: VarInfo): HTMLElement {
  const dom = document.createElement('div')
  dom.className = 'cm-var-tip'

  const head = document.createElement('div')
  head.className = 'cm-var-tip-head'
  const badge = document.createElement('span')
  badge.className = `cm-var-tip-badge cm-var-badge-${info.source}`
  badge.textContent = sourceLabel(info.source)
  head.appendChild(badge)
  const name = document.createElement('span')
  name.className = 'cm-var-tip-name'
  name.textContent = info.name
  head.appendChild(name)
  dom.appendChild(head)

  const body = document.createElement('div')
  body.className = 'cm-var-tip-value'
  if (info.source === 'unresolved') {
    body.classList.add('cm-var-tip-empty')
    body.textContent = info.required === true
      ? 'Required — no value set; the request cannot be sent until it is.'
      : 'No value — left unsubstituted at send.'
  } else if (info.secret === true) {
    body.classList.add('cm-var-tip-empty')
    body.textContent = '•••••• (hidden secret)'
  } else {
    const v = info.value ?? ''
    body.textContent = v === '' ? '(empty string)' : v
    if (v === '') body.classList.add('cm-var-tip-empty')
  }
  dom.appendChild(body)
  return dom
}

/** Hover tooltip that reads the live lookup when the pointer settles. */
function varHover(getLookup: () => VarLookup | null): Extension {
  return hoverTooltip((view, pos) => {
    const lookup = getLookup()
    if (lookup === null) return null
    const line = view.state.doc.lineAt(pos)
    const rel = pos - line.from
    VAR_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = VAR_RE.exec(line.text)) !== null) {
      const start = m.index
      const end = start + m[0].length
      if (rel >= start && rel <= end) {
        const info = lookup(m[1])
        return {
          pos: line.from + start,
          end: line.from + end,
          above: true,
          create: () => ({ dom: tooltipDom(info) })
        }
      }
    }
    return null
  })
}

/**
 * The complete variable-highlighting extension: live decorations + hover
 * tooltip. `getLookup` is polled on each rebuild/hover so the host can swap in
 * fresh session/env data (paired with a {@link refreshVarsEffect} dispatch).
 */
export function variableHighlighting(getLookup: () => VarLookup | null): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, getLookup())
      }
      update(u: ViewUpdate): void {
        const forced = u.transactions.some((tr) =>
          tr.effects.some((e) => e.is(refreshVarsEffect))
        )
        if (u.docChanged || u.viewportChanged || forced) {
          this.decorations = buildDecorations(u.view, getLookup())
        }
      }
    },
    { decorations: (v) => v.decorations }
  )
  return [plugin, varHover(getLookup)]
}
