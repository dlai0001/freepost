/**
 * collection.json / folder.json sidecar parsing, serialization, and inheritance
 * resolution (PLAN.md "collection.json/folder.json sidecars", "folder/collection
 * scripts").
 *
 * A config chain is ordered OUTERMOST-FIRST: the collection root, then each nested
 * folder toward the request. Resolution merges the chain into a single
 * ResolvedConfig applied at execution time.
 */

import type {
  CollectionConfig,
  Header,
  OAuth2Config,
  OAuth2Grant,
  ResolvedConfig
} from '@shared/model'

export type ParseConfigResult =
  | { ok: true; config: CollectionConfig }
  | { ok: false; error: string }

/** One link in the inheritance chain. `origin` labels where the config came from. */
export interface ConfigChainEntry {
  origin: string
  config: CollectionConfig
}

const OAUTH2_GRANTS: readonly OAuth2Grant[] = [
  'client_credentials',
  'password',
  'authorization_code'
]

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Validate a Header[] shape, returning an error string or null. */
function validateHeaders(value: unknown, field: string): string | null {
  if (!Array.isArray(value)) return `${field} must be an array of headers`
  for (let i = 0; i < value.length; i++) {
    const h = value[i]
    if (!isPlainObject(h)) return `${field}[${i}] must be an object with name and value`
    if (typeof h.name !== 'string') return `${field}[${i}].name must be a string`
    if (typeof h.value !== 'string') return `${field}[${i}].value must be a string`
  }
  return null
}

/** Validate an OAuth2Config shape, returning an error string or null. */
function validateAuth(value: unknown): string | null {
  if (!isPlainObject(value)) return 'auth must be an object'
  if (typeof value.grant !== 'string') return 'auth.grant must be a string'
  if (!OAUTH2_GRANTS.includes(value.grant as OAuth2Grant)) {
    return `auth.grant must be one of ${OAUTH2_GRANTS.join(', ')}`
  }
  if (typeof value.tokenUrl !== 'string') return 'auth.tokenUrl must be a string'
  if (typeof value.clientId !== 'string') return 'auth.clientId must be a string'
  // Optional string fields, when present, must be strings.
  const optionalStrings = [
    'authUrl',
    'clientSecret',
    'scope',
    'username',
    'password',
    'redirectUri',
    'tokenName',
    'sessionVar'
  ] as const
  for (const key of optionalStrings) {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      return `auth.${key} must be a string`
    }
  }
  return null
}

/** Validate scripts = { 'pre-request'?: string; test?: string }. */
function validateScripts(value: unknown): string | null {
  if (!isPlainObject(value)) return 'scripts must be an object'
  for (const key of ['pre-request', 'test'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      return `scripts['${key}'] must be a string`
    }
  }
  return null
}

/**
 * Parse and validate a collection.json / folder.json document.
 *
 * Validates the shape of every known field. Unknown extra keys are ignored
 * (forward-compat), but a known field with the wrong type is rejected with a
 * precise message.
 */
export function parseConfig(json: string): ParseConfigResult {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message}` }
  }
  if (!isPlainObject(raw)) {
    return { ok: false, error: 'config must be a JSON object' }
  }

  const config: CollectionConfig = {}

  if (raw.defaultHeaders !== undefined) {
    const err = validateHeaders(raw.defaultHeaders, 'defaultHeaders')
    if (err) return { ok: false, error: err }
    config.defaultHeaders = (raw.defaultHeaders as Header[]).map((h) => ({
      name: h.name,
      value: h.value
    }))
  }

  if (raw.auth !== undefined) {
    const err = validateAuth(raw.auth)
    if (err) return { ok: false, error: err }
    config.auth = raw.auth as OAuth2Config
  }

  if (raw.scripts !== undefined) {
    const err = validateScripts(raw.scripts)
    if (err) return { ok: false, error: err }
    const s = raw.scripts as Record<string, unknown>
    const scripts: { 'pre-request'?: string; test?: string } = {}
    if (typeof s['pre-request'] === 'string') scripts['pre-request'] = s['pre-request']
    if (typeof s.test === 'string') scripts.test = s.test
    config.scripts = scripts
  }

  for (const key of ['clientCert', 'clientKey', 'clientKeyPassphrase'] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== 'string') return { ok: false, error: `${key} must be a string` }
      config[key] = raw[key] as string
    }
  }

  return { ok: true, config }
}

/**
 * Serialize a config to stable, 2-space-indented JSON with a trailing newline.
 * Keys are emitted in a fixed, canonical order for diff-friendliness.
 */
export function serializeConfig(config: CollectionConfig): string {
  // Rebuild in canonical key order so serialization is stable regardless of the
  // order fields were set on the input object.
  const ordered: CollectionConfig = {}
  if (config.defaultHeaders !== undefined) ordered.defaultHeaders = config.defaultHeaders
  if (config.auth !== undefined) ordered.auth = config.auth
  if (config.scripts !== undefined) ordered.scripts = config.scripts
  if (config.clientCert !== undefined) ordered.clientCert = config.clientCert
  if (config.clientKey !== undefined) ordered.clientKey = config.clientKey
  if (config.clientKeyPassphrase !== undefined) {
    ordered.clientKeyPassphrase = config.clientKeyPassphrase
  }
  return JSON.stringify(ordered, null, 2) + '\n'
}

/**
 * Merge an inheritance chain (OUTERMOST-FIRST) into a single ResolvedConfig.
 *
 * Merge rules:
 * - defaultHeaders: all configs' headers are concatenated in chain order, but a
 *   later (more specific) header REPLACES an earlier one with the same name
 *   (case-insensitive). The final list is deduped by name keeping the most-specific
 *   value, otherwise preserving first-seen order.
 * - preScripts / testScripts: one {source, origin} entry per config whose
 *   corresponding script is non-empty, kept OUTERMOST-FIRST (collection script runs
 *   first, then folders inward — matches Postman's collection-then-folder ordering).
 * - auth: the most-specific (last in chain) config that defines auth wins.
 * - clientCert / clientKey / clientKeyPassphrase: most-specific (last defined) wins,
 *   each resolved independently.
 */
export function resolveConfig(chain: ConfigChainEntry[]): ResolvedConfig {
  const resolved: ResolvedConfig = {
    defaultHeaders: [],
    preScripts: [],
    testScripts: []
  }

  // Headers: track insertion order + index by lowercased name so a later header
  // replaces the earlier one's value in place (preserving first-seen position).
  const headerOrder: string[] = [] // lowercased names, first-seen order
  const headerByLower = new Map<string, Header>()

  for (const { origin, config } of chain) {
    if (config.defaultHeaders) {
      for (const h of config.defaultHeaders) {
        const lower = h.name.toLowerCase()
        if (!headerByLower.has(lower)) headerOrder.push(lower)
        headerByLower.set(lower, { name: h.name, value: h.value })
      }
    }

    const pre = config.scripts?.['pre-request']
    if (pre) resolved.preScripts.push({ source: pre, origin })

    const test = config.scripts?.test
    if (test) resolved.testScripts.push({ source: test, origin })

    if (config.auth) resolved.auth = config.auth
    if (config.clientCert !== undefined) resolved.clientCert = config.clientCert
    if (config.clientKey !== undefined) resolved.clientKey = config.clientKey
    if (config.clientKeyPassphrase !== undefined) {
      resolved.clientKeyPassphrase = config.clientKeyPassphrase
    }
  }

  resolved.defaultHeaders = headerOrder.map((lower) => headerByLower.get(lower)!)
  return resolved
}

/**
 * Merge inherited config default headers with a request's own headers.
 *
 * A request's own header wins by name (case-insensitive) over a config default.
 * The result is the surviving config defaults (those not overridden) followed by
 * the request's headers, each group preserving its original order.
 */
export function mergeRequestHeaders(
  configHeaders: Header[],
  requestHeaders: Header[]
): Header[] {
  const requestNames = new Set(requestHeaders.map((h) => h.name.toLowerCase()))
  const survivingDefaults = configHeaders.filter(
    (h) => !requestNames.has(h.name.toLowerCase())
  )
  return [...survivingDefaults, ...requestHeaders]
}
