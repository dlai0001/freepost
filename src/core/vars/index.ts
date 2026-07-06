/**
 * Variable resolution and substitution (PLAN.md "Variable resolution").
 *
 * Three tiers, strongest first: session > environment > request parameter
 * defaults (the file's own `${VAR:-default}` assignment block).
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
 * Precedence: session > environment > declaration default. Session and
 * environment may define variables not declared in the file; those are
 * included in `values` (scripts and substitution may reference them).
 */
export function resolveVariables(
  decls: VariableDecl[],
  session: Record<string, string>,
  env: Record<string, string>
): ResolveResult {
  const values: Record<string, string> = {}

  // Weakest tier: request parameter defaults.
  for (const decl of decls) {
    if (decl.defaultValue !== undefined) values[decl.name] = decl.defaultValue
  }
  // Environment overrides defaults; session overrides everything.
  Object.assign(values, env, session)

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
