/**
 * Variable resolution and substitution (PLAN.md "Variable resolution").
 *
 * Tiers, strongest first: request parameters (the file's own Meta variable
 * values) > session > environment. A Meta value may itself reference other
 * variables (`${env}-${id}`); those references are expanded against the rest of
 * the resolved set, so developers can define derived, request-scoped values.
 *
 * A Meta value only wins when it is non-empty: a declared-but-blank row is a
 * fallback (it must not shadow an environment/session value of the same name),
 * and a required (`${NAME:?}`) parameter has no value of its own at all.
 */

import type { HttpRequestModel, VariableDecl, WsRequestModel } from '@shared/model'

export interface ResolveResult {
  /** Resolved name -> value map (includes session/env vars not declared in the file). */
  values: Record<string, string>
  /** Required (`${NAME:?}`) variables with no session/env value. */
  unresolved: string[]
}

/**
 * Resolve the effective variable values for a request.
 *
 * Precedence: Meta parameter value (non-empty) > session > environment. Session
 * and environment may define variables not declared in the file; those are
 * included in `values` (scripts and substitution may reference them). Meta
 * values are expanded (`${...}`) against session/environment and each other.
 */
export function resolveVariables(
  decls: VariableDecl[],
  session: Record<string, string>,
  env: Record<string, string>
): ResolveResult {
  // Lower tiers, concrete: environment then session (session wins).
  const base: Record<string, string> = { ...env, ...session }

  // Meta parameter defaults (raw, may contain `${...}` references).
  const rawMeta: Record<string, string> = {}
  for (const decl of decls) {
    if (decl.defaultValue !== undefined) rawMeta[decl.name] = decl.defaultValue
  }

  // Expand Meta values to a fixpoint. Each pass re-substitutes the original
  // raw value against a scope where non-empty Meta values override base — this
  // resolves chained/derived references (A -> B -> concrete). Bounded by the
  // number of declarations (+1) so reference cycles terminate rather than hang.
  let meta: Record<string, string> = { ...rawMeta }
  for (let pass = 0; pass <= decls.length; pass++) {
    const scope: Record<string, string> = { ...base }
    for (const name in meta) if (meta[name] !== '') scope[name] = meta[name]
    let changed = false
    const next: Record<string, string> = { ...meta }
    for (const name in rawMeta) {
      const expanded = substitute(rawMeta[name], scope)
      if (expanded !== meta[name]) {
        next[name] = expanded
        changed = true
      }
    }
    meta = next
    if (!changed) break
  }

  // Compose: base, then Meta on top. A non-empty Meta value is highest
  // precedence; a blank one only fills a name nothing else defines.
  const values: Record<string, string> = { ...base }
  for (const name in meta) {
    if (meta[name] !== '') values[name] = meta[name]
    else if (!(name in values)) values[name] = ''
  }

  const unresolved = decls
    .filter((d) => d.required && !(d.name in session) && !(d.name in env))
    .map((d) => d.name)

  return { values, unresolved }
}

/**
 * Matches ${NAME}, ${NAME:-default}, ${NAME:?}.
 * Groups: 1 = name, 2 = operator ('-' or '?'), 3 = inline default text.
 */
const VAR_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([-?])([^}]*))?\}/g

/**
 * Substitute `${...}` references in a string.
 *
 * - `${NAME}` / `${NAME:-def}` / `${NAME:?}` -> resolved value when NAME is
 *   in `values`.
 * - `${NAME:-def}` with NAME unknown -> the inline default `def`.
 * - `${NAME}` / `${NAME:?}` with NAME unknown -> left untouched.
 */
export function substitute(text: string, values: Record<string, string>): string {
  return text.replace(VAR_REF, (match, name: string, op: string | undefined, def: string) => {
    if (name in values) return values[name]
    if (op === '-') return def
    return match
  })
}

/**
 * Apply substitute() over a request model (url, header values, raw body
 * value, options.user), returning a resolved deep copy.
 */
export function substituteModel<T extends HttpRequestModel | WsRequestModel>(
  model: T,
  values: Record<string, string>
): T {
  const sub = (s: string): string => substitute(s, values)

  if (isHttpModel(model)) {
    const resolved: HttpRequestModel = {
      ...model,
      url: sub(model.url),
      headers: model.headers.map((h) => ({ ...h, value: sub(h.value) })),
      body:
        model.body === undefined
          ? undefined
          : model.body.kind === 'raw'
            ? { ...model.body, value: sub(model.body.value) }
            : { ...model.body },
      options: {
        ...model.options,
        ...(model.options.user !== undefined ? { user: sub(model.options.user) } : {})
      }
    }
    return resolved as T
  }

  const resolved: WsRequestModel = {
    ...model,
    url: sub(model.url),
    headers: model.headers.map((h) => ({ ...h, value: sub(h.value) }))
  }
  return resolved as T
}

function isHttpModel(m: HttpRequestModel | WsRequestModel): m is HttpRequestModel {
  return 'method' in m && 'options' in m
}

/** Variable names referenced in a string, unique, in order of first appearance. */
export function extractVarRefs(text: string): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(VAR_REF)) {
    const name = match[1]
    if (!seen.has(name)) {
      seen.add(name)
      names.push(name)
    }
  }
  return names
}
