import { describe, expect, it } from 'vitest'
import type { HttpRequestModel, VariableDecl, WsRequestModel } from '@shared/model'
import { extractVarRefs, resolveVariables, substitute, substituteModel } from './index'

const decl = (name: string, defaultValue?: string, required = false): VariableDecl => ({
  name,
  defaultValue,
  required
})

describe('resolveVariables', () => {
  it('uses the declaration default when neither session nor env define the variable', () => {
    const { values, unresolved } = resolveVariables([decl('BASE_URL', 'https://api.example.com')], {}, {})
    expect(values).toEqual({ BASE_URL: 'https://api.example.com' })
    expect(unresolved).toEqual([])
  })

  it('a non-empty Meta value beats environment', () => {
    const { values } = resolveVariables([decl('BASE_URL', 'from-meta')], {}, { BASE_URL: 'from-env' })
    expect(values.BASE_URL).toBe('from-meta')
  })

  it('a non-empty Meta value beats session and environment (highest precedence)', () => {
    const { values } = resolveVariables(
      [decl('BASE_URL', 'from-meta')],
      { BASE_URL: 'from-session' },
      { BASE_URL: 'from-env' }
    )
    expect(values.BASE_URL).toBe('from-meta')
  })

  it('a blank Meta value does not shadow an env/session value', () => {
    const fromEnv = resolveVariables([decl('BASE_URL', '')], {}, { BASE_URL: 'from-env' })
    expect(fromEnv.values.BASE_URL).toBe('from-env')
    const fromSession = resolveVariables([decl('BASE_URL', '')], { BASE_URL: 'from-session' }, {})
    expect(fromSession.values.BASE_URL).toBe('from-session')
  })

  it('a blank Meta value stands in as empty when nothing else defines it', () => {
    const { values } = resolveVariables([decl('BASE_URL', '')], {}, {})
    expect(values.BASE_URL).toBe('')
  })

  it('expands ${...} references in a Meta value against env/session (derived values)', () => {
    const { values } = resolveVariables(
      [decl('URL', '${env}-${id}')],
      { id: '42' },
      { env: 'staging' }
    )
    expect(values.URL).toBe('staging-42')
  })

  it('expands a Meta value that references another Meta value (chained)', () => {
    const { values } = resolveVariables(
      [decl('base', 'https://${env}.example.com'), decl('url', '${base}/users/${id}'), decl('env', 'prod')],
      { id: '7' },
      {}
    )
    expect(values.base).toBe('https://prod.example.com')
    expect(values.url).toBe('https://prod.example.com/users/7')
  })

  it('lets a Meta value override the env var it also derives from', () => {
    // env=staging in the environment, but the Meta row pins env=prod; the
    // derived URL uses the Meta (highest) value.
    const { values } = resolveVariables(
      [decl('env', 'prod'), decl('URL', '${env}.example.com')],
      {},
      { env: 'staging' }
    )
    expect(values.env).toBe('prod')
    expect(values.URL).toBe('prod.example.com')
  })

  it('terminates on a reference cycle instead of hanging', () => {
    const { values } = resolveVariables([decl('A', '${B}'), decl('B', '${A}')], {}, {})
    // No concrete value exists; the unresolved refs are left as literals.
    expect(values.A).toContain('${')
    expect(values.B).toContain('${')
  })

  it('lists required variables with no session/env value as unresolved', () => {
    const { values, unresolved } = resolveVariables(
      [decl('TOKEN', undefined, true), decl('USER_ID', '42')],
      {},
      {}
    )
    expect(unresolved).toEqual(['TOKEN'])
    expect(values).toEqual({ USER_ID: '42' })
    expect('TOKEN' in values).toBe(false)
  })

  it('does not report a required variable as unresolved when env provides it', () => {
    const { values, unresolved } = resolveVariables([decl('TOKEN', undefined, true)], {}, { TOKEN: 'abc' })
    expect(unresolved).toEqual([])
    expect(values.TOKEN).toBe('abc')
  })

  it('does not report a required variable as unresolved when session provides it', () => {
    const { unresolved } = resolveVariables([decl('TOKEN', undefined, true)], { TOKEN: 'abc' }, {})
    expect(unresolved).toEqual([])
  })

  it('includes session/env variables that are not declared in the file', () => {
    const { values } = resolveVariables([decl('A', '1')], { CAPTURED: 'tok' }, { EXTRA: 'env' })
    expect(values).toEqual({ A: '1', CAPTURED: 'tok', EXTRA: 'env' })
  })

  it('treats an empty-string session value as defined for required-var resolution', () => {
    const { unresolved } = resolveVariables([decl('R', undefined, true)], { R: '' }, {})
    expect(unresolved).toEqual([])
  })

  it('a non-empty Meta value wins even over an empty-string session value', () => {
    const { values } = resolveVariables([decl('X', 'dflt', false)], { X: '' }, { X: 'env' })
    expect(values.X).toBe('dflt')
  })
})

describe('substitute', () => {
  const values = { TOKEN: 'abc123', BASE_URL: 'api.example.com' }

  it('replaces ${NAME} with the resolved value', () => {
    expect(substitute('https://${BASE_URL}/users', values)).toBe('https://api.example.com/users')
  })

  it('replaces ${NAME:-default} with the resolved value when known', () => {
    expect(substitute('${BASE_URL:-localhost}', values)).toBe('api.example.com')
  })

  it('replaces ${NAME:?} with the resolved value when known', () => {
    expect(substitute('Bearer ${TOKEN:?}', values)).toBe('Bearer abc123')
  })

  it('falls back to the inline default for unknown ${NAME:-default}', () => {
    expect(substitute('${MISSING:-fallback}', values)).toBe('fallback')
    expect(substitute('${MISSING:-}', values)).toBe('')
  })

  it('leaves unknown ${NAME} and ${NAME:?} untouched', () => {
    expect(substitute('x ${MISSING} y', values)).toBe('x ${MISSING} y')
    expect(substitute('${MISSING:?}', values)).toBe('${MISSING:?}')
  })

  it('replaces multiple occurrences and mixed forms in one string', () => {
    expect(substitute('${TOKEN}/${TOKEN:-x}/${NOPE:-d}/${NOPE}', values)).toBe(
      'abc123/abc123/d/${NOPE}'
    )
  })

  it('substitutes an empty-string value', () => {
    expect(substitute('[${EMPTY}]', { EMPTY: '' })).toBe('[]')
  })
})

describe('substituteModel', () => {
  const values = { BASE_URL: 'api.example.com', TOKEN: 't0k', USER: 'alice', BODY_NAME: 'bob' }

  it('resolves url, header values, raw body, and options.user of an HttpRequestModel', () => {
    const model: HttpRequestModel = {
      method: 'POST',
      url: 'https://${BASE_URL}/users',
      headers: [
        { name: 'Authorization', value: 'Bearer ${TOKEN}' },
        { name: 'Accept', value: 'application/json' }
      ],
      body: { kind: 'raw', value: '{"name":"${BODY_NAME}"}' },
      options: { insecure: true, user: '${USER}:${TOKEN}' }
    }
    const resolved = substituteModel(model, values)
    expect(resolved.url).toBe('https://api.example.com/users')
    expect(resolved.headers).toEqual([
      { name: 'Authorization', value: 'Bearer t0k' },
      { name: 'Accept', value: 'application/json' }
    ])
    expect(resolved.body).toEqual({ kind: 'raw', value: '{"name":"bob"}' })
    expect(resolved.options).toEqual({ insecure: true, user: 'alice:t0k' })
    expect(resolved.method).toBe('POST')
    // Original untouched.
    expect(model.url).toBe('https://${BASE_URL}/users')
    expect(model.headers[0].value).toBe('Bearer ${TOKEN}')
    expect(model.body?.value).toBe('{"name":"${BODY_NAME}"}')
    expect(model.options.user).toBe('${USER}:${TOKEN}')
  })

  it('leaves a file body reference value alone', () => {
    const model: HttpRequestModel = {
      method: 'POST',
      url: 'https://${BASE_URL}/upload',
      headers: [],
      body: { kind: 'file', value: './payload-${TOKEN}.json' },
      options: {}
    }
    const resolved = substituteModel(model, values)
    expect(resolved.body).toEqual({ kind: 'file', value: './payload-${TOKEN}.json' })
  })

  it('resolves url and header values of a WsRequestModel', () => {
    const model: WsRequestModel = {
      url: 'wss://${BASE_URL}/stream',
      headers: [{ name: 'Authorization', value: 'Bearer ${TOKEN}' }],
      protocol: 'v1.ticker'
    }
    const resolved = substituteModel(model, values)
    expect(resolved.url).toBe('wss://api.example.com/stream')
    expect(resolved.headers[0].value).toBe('Bearer t0k')
    expect(resolved.protocol).toBe('v1.ticker')
    expect(model.url).toBe('wss://${BASE_URL}/stream')
  })
})

describe('extractVarRefs', () => {
  it('extracts names from all three reference forms', () => {
    expect(extractVarRefs('https://${BASE_URL:-x}/u/${USER_ID}?t=${TOKEN:?}')).toEqual([
      'BASE_URL',
      'USER_ID',
      'TOKEN'
    ])
  })

  it('deduplicates while preserving first-appearance order', () => {
    expect(extractVarRefs('${B}${A}${B:-z}${A:?}')).toEqual(['B', 'A'])
  })

  it('returns empty for text with no references', () => {
    expect(extractVarRefs('plain text, $NOTBRACED, ${} and ${1BAD}')).toEqual([])
  })
})
