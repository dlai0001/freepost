/**
 * Shared plumbing for `${VAR}` highlighting: fetch the live variable sources
 * (session store + active environment) and build a {@link VarLookup} that
 * resolves a name to its effective value + tier. Used by both the request and
 * websocket editors so their highlighting stays consistent.
 */
import { useEffect, useMemo, useState } from 'react'
import { joinPath } from '../util'
import { fp } from '../api'
import type { VarInfo, VarLookup } from './varHighlight'

/** Live variable tiers below the request's own declarations. */
export interface VarSources {
  session: Record<string, string>
  env: Record<string, string>
  /** The active environment is a git-ignored `.local.env.json` (values masked). */
  envIsSecret: boolean
}

/** One request-declared variable (weakest tier). */
export interface VarDecl {
  def: string
  required: boolean
  secret: boolean
}

/**
 * Fetch the session store and active-environment values for a collection.
 * Session vars can change out-of-band (Session panel, OAuth acquire), so we
 * also refresh when the window regains focus.
 */
export function useVarSources(root: string, envPath: string | null): VarSources {
  const [session, setSession] = useState<Record<string, string>>({})
  const [env, setEnv] = useState<Record<string, string>>({})

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const s = await fp().getSession()
        if (!cancelled) setSession(s)
      } catch {
        /* session store unavailable — treat as empty */
      }
    }
    void load()
    const onFocus = (): void => void load()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (envPath === null) {
        if (!cancelled) setEnv({})
        return
      }
      try {
        const values = await fp().readEnv(joinPath(root, envPath))
        if (!cancelled) setEnv(values)
      } catch {
        if (!cancelled) setEnv({})
      }
    })()
    return () => {
      cancelled = true
    }
  }, [root, envPath])

  const envIsSecret = envPath?.toLowerCase().endsWith('.local.env.json') === true
  return useMemo(() => ({ session, env, envIsSecret }), [session, env, envIsSecret])
}

/**
 * Resolve a variable name against session > environment > request declaration,
 * mirroring the engine's precedence (see core/vars `resolveVariables`).
 */
export function makeVarLookup(sources: VarSources, decls: Map<string, VarDecl>): VarLookup {
  return (name: string): VarInfo => {
    if (name in sources.session) return { name, value: sources.session[name], source: 'session' }
    if (name in sources.env) {
      return { name, value: sources.env[name], source: 'env', secret: sources.envIsSecret }
    }
    const decl = decls.get(name)
    if (decl !== undefined) {
      if (decl.required) return { name, source: 'unresolved', required: true }
      return { name, value: decl.def, source: 'request', secret: decl.secret }
    }
    return { name, source: 'unresolved' }
  }
}
