import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type {
  AcquiredToken,
  ExecutionReport,
  Frontmatter,
  GqlSchemaSummary,
  Header,
  OAuth2Config,
  OAuth2Grant,
  ParseError,
  RequestFile,
  VariableDecl,
  VariableMeta
} from '../../../shared/model'
import { errMsg, fp } from '../api'
import { joinPath, nextId } from '../util'
import ResponsePanel from './ResponsePanel'
import CodegenModal from './CodegenModal'
import ExamplesModal from './ExamplesModal'
import CodeEditor from './CodeEditor'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
const OAUTH_GRANTS: OAuth2Grant[] = ['client_credentials', 'password', 'authorization_code']
const DEFAULT_OAUTH_VAR = 'OAUTH_TOKEN'

type Section = 'headers' | 'body' | 'auth' | 'scripts' | 'meta'
type AuthMode = 'none' | 'basic' | 'bearer' | 'oauth2'

interface HeaderRow {
  id: number
  enabled: boolean
  name: string
  value: string
}

interface VarRow {
  id: number
  name: string
  def: string
  required: boolean
  secret: boolean
}

interface Props {
  root: string
  relPath: string
  envPath: string | null
  onDirty: (dirty: boolean) => void
  onMethod: (method: string) => void
}

export default function RequestTab(props: Props): JSX.Element {
  const absPath = joinPath(props.root, props.relPath)

  const [loading, setLoading] = useState(true)
  const [parseErrors, setParseErrors] = useState<ParseError[] | null>(null)
  const [raw, setRaw] = useState('')
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<RequestFile | null>(null)

  // Editor state.
  const [section, setSection] = useState<Section>('headers')
  const [method, setMethod] = useState('GET')
  const [url, setUrl] = useState('')
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>([])
  const [bodyKind, setBodyKind] = useState<'raw' | 'file'>('raw')
  const [bodyText, setBodyText] = useState('')
  const [gqlOn, setGqlOn] = useState(false)
  const [gqlQuery, setGqlQuery] = useState('')
  const [gqlVars, setGqlVars] = useState('')
  const [authMode, setAuthMode] = useState<AuthMode>('none')
  const [authUser, setAuthUser] = useState('')
  const [authPass, setAuthPass] = useState('')
  const [authToken, setAuthToken] = useState('')
  // OAuth2 config fields.
  const [oauthGrant, setOauthGrant] = useState<OAuth2Grant>('client_credentials')
  const [oauthTokenUrl, setOauthTokenUrl] = useState('')
  const [oauthClientId, setOauthClientId] = useState('')
  const [oauthClientSecret, setOauthClientSecret] = useState('')
  const [oauthScope, setOauthScope] = useState('')
  const [oauthUsername, setOauthUsername] = useState('')
  const [oauthPassword, setOauthPassword] = useState('')
  const [oauthSessionVar, setOauthSessionVar] = useState('')
  const [oauthBusy, setOauthBusy] = useState(false)
  const [oauthResult, setOauthResult] = useState<string | null>(null)
  // GraphQL introspection.
  const [gqlSchema, setGqlSchema] = useState<GqlSchemaSummary | null>(null)
  const [gqlSchemaOpen, setGqlSchemaOpen] = useState(false)
  const [gqlBusy, setGqlBusy] = useState(false)
  const [gqlError, setGqlError] = useState<string | null>(null)
  // Modals.
  const [showCodegen, setShowCodegen] = useState(false)
  const [showExamples, setShowExamples] = useState(false)
  const [preScript, setPreScript] = useState('')
  const [testScript, setTestScript] = useState('')
  const [description, setDescription] = useState('')
  const [labelsText, setLabelsText] = useState('')
  const [varRows, setVarRows] = useState<VarRow[]>([])

  // Response state.
  const [report, setReport] = useState<ExecutionReport | null>(null)
  const [sending, setSending] = useState(false)
  const [respOpen, setRespOpen] = useState(false)
  const [respBelow, setRespBelow] = useState(false)
  const [saving, setSaving] = useState(false)

  const dirtyRef = useRef(false)
  const { onDirty } = props
  function touch(): void {
    if (!dirtyRef.current) {
      dirtyRef.current = true
      onDirty(true)
    }
  }
  function clean(): void {
    dirtyRef.current = false
    onDirty(false)
  }

  function populate(file: RequestFile): void {
    fileRef.current = file
    const fm = file.frontmatter
    const http = file.http
    setMethod(http?.method?.toUpperCase() ?? 'GET')
    setUrl(http?.url ?? '')

    const rows: HeaderRow[] = (http?.headers ?? []).map((h) => ({
      id: nextId(),
      enabled: true,
      name: h.name,
      value: h.value
    }))
    for (const [name, value] of Object.entries(fm.disabled?.headers ?? {})) {
      rows.push({ id: nextId(), enabled: false, name, value })
    }
    setHeaderRows(rows)

    setBodyKind(http?.body?.kind ?? 'raw')
    setBodyText(http?.body?.value ?? '')

    if (fm.graphql !== undefined) {
      setGqlOn(true)
      setGqlQuery(fm.graphql.query)
      setGqlVars(
        fm.graphql.variables !== undefined ? JSON.stringify(fm.graphql.variables, null, 2) : ''
      )
    } else {
      setGqlOn(false)
    }

    // Auth: frontmatter.auth => oauth2; --user => basic; Bearer header => bearer.
    const user = http?.options.user
    const bearerHeader = (http?.headers ?? []).find(
      (h) => h.name.toLowerCase() === 'authorization' && /^bearer\s/i.test(h.value)
    )
    if (fm.auth !== undefined) {
      const a = fm.auth
      setAuthMode('oauth2')
      setOauthGrant(a.grant)
      setOauthTokenUrl(a.tokenUrl)
      setOauthClientId(a.clientId)
      setOauthClientSecret(a.clientSecret ?? '')
      setOauthScope(a.scope ?? '')
      setOauthUsername(a.username ?? '')
      setOauthPassword(a.password ?? '')
      setOauthSessionVar(a.sessionVar ?? '')
    } else if (user !== undefined) {
      const colon = user.indexOf(':')
      setAuthMode('basic')
      setAuthUser(colon >= 0 ? user.slice(0, colon) : user)
      setAuthPass(colon >= 0 ? user.slice(colon + 1) : '')
    } else if (bearerHeader !== undefined) {
      setAuthMode('bearer')
      setAuthToken(bearerHeader.value.replace(/^bearer\s+/i, ''))
    } else {
      setAuthMode('none')
    }

    setPreScript(fm.scripts?.['pre-request'] ?? '')
    setTestScript(fm.scripts?.test ?? '')
    setDescription(fm.description ?? '')
    setLabelsText((fm.label ?? []).join(', '))
    setVarRows(
      file.variables.map((v) => ({
        id: nextId(),
        name: v.name,
        def: v.defaultValue ?? '',
        required: v.required,
        secret: fm.variables?.[v.name]?.secret === true
      }))
    )
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const { raw: rawText, parsed } = await fp().readRequest(absPath)
        if (cancelled) return
        setRaw(rawText)
        if (parsed.ok) {
          populate(parsed.file)
          if (parsed.file.http !== undefined) onMethodRef.current(parsed.file.http.method)
        } else {
          setParseErrors(parsed.errors)
        }
      } catch (e) {
        if (!cancelled) setError(errMsg(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [absPath])

  const onMethodRef = useRef(props.onMethod)
  onMethodRef.current = props.onMethod

  /* ------------------------------ assembly ------------------------------ */

  function assemble(): RequestFile | null {
    const orig = fileRef.current
    if (orig === null) return null
    const fm: Frontmatter = { ...orig.frontmatter }

    const desc = description.trim()
    if (desc !== '') fm.description = desc
    else delete fm.description

    const labels = labelsText
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
    if (labels.length > 0) fm.label = labels
    else delete fm.label

    const scripts: NonNullable<Frontmatter['scripts']> = {}
    if (preScript.trim() !== '') scripts['pre-request'] = preScript
    if (testScript.trim() !== '') scripts.test = testScript
    if (Object.keys(scripts).length > 0) fm.scripts = scripts
    else delete fm.scripts

    // Variable metadata (preserve descriptions; secret comes from the table).
    const varMeta: Record<string, VariableMeta | null> = {}
    for (const row of varRows) {
      const name = row.name.trim()
      if (name === '') continue
      const prev = orig.frontmatter.variables?.[name] ?? null
      const meta: VariableMeta = {}
      if (row.secret) meta.secret = true
      if (prev?.description !== undefined) meta.description = prev.description
      if (Object.keys(meta).length > 0) varMeta[name] = meta
    }
    if (Object.keys(varMeta).length > 0) fm.variables = varMeta
    else delete fm.variables

    // Disabled (unchecked) headers move to frontmatter; disabled.query is preserved.
    const disabledHeaders: Record<string, string> = {}
    for (const row of headerRows) {
      if (!row.enabled && row.name.trim() !== '') disabledHeaders[row.name.trim()] = row.value
    }
    const disabled: NonNullable<Frontmatter['disabled']> = { ...(orig.frontmatter.disabled ?? {}) }
    if (Object.keys(disabledHeaders).length > 0) disabled.headers = disabledHeaders
    else delete disabled.headers
    if (disabled.headers !== undefined || disabled.query !== undefined) fm.disabled = disabled
    else delete fm.disabled

    // Enabled headers + auth.
    let headers: Header[] = headerRows
      .filter((r) => r.enabled && r.name.trim() !== '')
      .map((r) => ({ name: r.name.trim(), value: r.value }))
    const options = { ...(orig.http?.options ?? {}) }
    delete options.user
    if (authMode === 'basic') {
      options.user = `${authUser}:${authPass}`
    }
    if (authMode === 'bearer') {
      const value = `Bearer ${authToken}`
      const idx = headers.findIndex((h) => h.name.toLowerCase() === 'authorization')
      if (idx >= 0) headers[idx] = { name: headers[idx].name, value }
      else headers.push({ name: 'Authorization', value })
    } else {
      // The Auth section owns bearer Authorization headers.
      headers = headers.filter(
        (h) => !(h.name.toLowerCase() === 'authorization' && /^bearer\s/i.test(h.value))
      )
    }

    // OAuth2 config is persisted in frontmatter.auth. When active, the token is
    // applied at runtime via the session variable, so we write no Authorization
    // header or --user here.
    if (authMode === 'oauth2') {
      const auth: OAuth2Config = {
        grant: oauthGrant,
        tokenUrl: oauthTokenUrl.trim(),
        clientId: oauthClientId.trim()
      }
      if (oauthClientSecret !== '') auth.clientSecret = oauthClientSecret
      if (oauthScope.trim() !== '') auth.scope = oauthScope.trim()
      if (oauthGrant === 'password') {
        if (oauthUsername !== '') auth.username = oauthUsername
        if (oauthPassword !== '') auth.password = oauthPassword
      }
      if (oauthSessionVar.trim() !== '') auth.sessionVar = oauthSessionVar.trim()
      // Preserve any inherited-only keys the editor doesn't surface.
      const prev = orig.frontmatter.auth
      if (prev?.authUrl !== undefined) auth.authUrl = prev.authUrl
      if (prev?.redirectUri !== undefined) auth.redirectUri = prev.redirectUri
      if (prev?.tokenName !== undefined) auth.tokenName = prev.tokenName
      fm.auth = auth
    } else {
      delete fm.auth
    }

    // Body / GraphQL.
    let body: { kind: 'raw' | 'file'; value: string } | undefined
    if (gqlOn) {
      const varsText = gqlVars.trim()
      let variables: Record<string, unknown> | undefined
      if (varsText !== '') {
        try {
          variables = JSON.parse(varsText) as Record<string, unknown>
        } catch {
          setError('GraphQL variables must be valid JSON.')
          return null
        }
      }
      fm.graphql = variables !== undefined ? { query: gqlQuery, variables } : { query: gqlQuery }
      // The writer regenerates --data from frontmatter.graphql.
      body = orig.http?.body
    } else {
      body = bodyText === '' ? undefined : { kind: bodyKind, value: bodyText }
    }

    const variables: VariableDecl[] = varRows
      .filter((r) => r.name.trim() !== '')
      .map((r) =>
        r.required
          ? { name: r.name.trim(), required: true }
          : { name: r.name.trim(), required: false, defaultValue: r.def }
      )

    return {
      kind: orig.kind,
      frontmatter: fm,
      variables,
      http: { method, url, headers, body, options },
      comments: orig.comments
    }
  }

  async function save(): Promise<void> {
    setError(null)
    const file = assemble()
    if (file === null) return
    setSaving(true)
    try {
      const { raw: newRaw } = await fp().writeRequest(absPath, file)
      setRaw(newRaw)
      fileRef.current = file
      onMethodRef.current(method)
      clean()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setSaving(false)
    }
  }

  async function send(): Promise<void> {
    setError(null)
    setSending(true)
    setRespOpen(true)
    try {
      const rep = await fp().executeRequest({
        root: props.root,
        path: props.relPath,
        envPath: props.envPath ?? undefined
      })
      setReport(rep)
    } catch (e) {
      setReport(null)
      setError(errMsg(e))
    } finally {
      setSending(false)
    }
  }

  async function acquireToken(): Promise<void> {
    setOauthResult(null)
    setOauthBusy(true)
    try {
      const token: AcquiredToken = await fp().acquireOAuthToken({
        root: props.root,
        path: props.relPath,
        envPath: props.envPath ?? undefined
      })
      const truncated =
        token.accessToken.length > 16
          ? `${token.accessToken.slice(0, 8)}…${token.accessToken.slice(-4)}`
          : token.accessToken
      const expiry =
        token.expiresAt !== undefined
          ? ` · expires ${new Date(token.expiresAt).toLocaleString()}`
          : ''
      setOauthResult(`${token.tokenType} ${truncated}${expiry}`)
    } catch (e) {
      setOauthResult(errMsg(e))
    } finally {
      setOauthBusy(false)
    }
  }

  async function introspect(): Promise<void> {
    setGqlError(null)
    setGqlBusy(true)
    try {
      const result = await fp().introspectGraphql({
        root: props.root,
        path: props.relPath,
        envPath: props.envPath ?? undefined
      })
      if (result.ok) {
        setGqlSchema(result.schema)
        setGqlSchemaOpen(true)
      } else {
        setGqlSchema(null)
        setGqlError(result.error)
      }
    } catch (e) {
      setGqlSchema(null)
      setGqlError(errMsg(e))
    } finally {
      setGqlBusy(false)
    }
  }

  /* ------------------------------ rendering ----------------------------- */

  if (loading) return <div className="tab-loading">Loading…</div>

  if (parseErrors !== null) {
    return (
      <div className="request-tab">
        <div className="banner banner-danger">
          This file has parse errors and is shown read-only (freepost never rewrites invalid
          files):
          <ul>
            {parseErrors.map((pe, i) => (
              <li key={i}>
                line {pe.line}: {pe.message}
              </li>
            ))}
          </ul>
        </div>
        <pre className="raw-view mono">{raw}</pre>
      </div>
    )
  }

  const updateHeader = (id: number, patch: Partial<HeaderRow>): void => {
    setHeaderRows((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))
    touch()
  }
  const updateVar = (id: number, patch: Partial<VarRow>): void => {
    setVarRows((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))
    touch()
  }

  return (
    <div className="request-tab">
      {error !== null && (
        <div className="banner banner-danger">
          {error}
          <button className="icon-btn" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}

      <div className="req-topline">
        <select
          className="method-select mono"
          value={method}
          onChange={(e) => {
            setMethod(e.target.value)
            touch()
          }}
        >
          {METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <input
          className="url-input mono"
          value={url}
          placeholder="https://api.example.com/path"
          onChange={(e) => {
            setUrl(e.target.value)
            touch()
          }}
        />
        <button className="btn btn-accent" onClick={() => void send()} disabled={sending}>
          {sending ? 'Sending…' : 'Send'}
        </button>
        <button className="btn" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button className="btn" onClick={() => setShowCodegen(true)}>
          Code
        </button>
        <button className="btn" onClick={() => setShowExamples(true)}>
          Examples
        </button>
      </div>

      <div className={'req-split' + (respBelow ? ' req-split-col' : '')}>
        <div className="req-editor">
          <div className="section-tabs">
            {(['headers', 'body', 'auth', 'scripts', 'meta'] as Section[]).map((s) => (
              <button
                key={s}
                className={'section-tab' + (section === s ? ' section-tab-active' : '')}
                onClick={() => setSection(s)}
              >
                {s === 'headers'
                  ? 'Headers'
                  : s === 'body'
                    ? gqlOn
                      ? 'Body (GraphQL)'
                      : 'Body'
                    : s === 'auth'
                      ? 'Auth'
                      : s === 'scripts'
                        ? 'Scripts'
                        : 'Meta'}
              </button>
            ))}
          </div>

          <div className="section-content">
            {section === 'headers' && (
              <div>
                <table className="edit-table">
                  <tbody>
                    {headerRows.map((row) => (
                      <tr key={row.id} className={row.enabled ? '' : 'row-disabled'}>
                        <td className="cell-check">
                          <input
                            type="checkbox"
                            checked={row.enabled}
                            title="Include header"
                            onChange={(e) => updateHeader(row.id, { enabled: e.target.checked })}
                          />
                        </td>
                        <td>
                          <input
                            className="cell-input mono"
                            placeholder="Name"
                            value={row.name}
                            onChange={(e) => updateHeader(row.id, { name: e.target.value })}
                          />
                        </td>
                        <td>
                          <input
                            className="cell-input mono"
                            placeholder="Value"
                            value={row.value}
                            onChange={(e) => updateHeader(row.id, { value: e.target.value })}
                          />
                        </td>
                        <td className="cell-check">
                          <button
                            className="icon-btn"
                            title="Delete header"
                            onClick={() => {
                              setHeaderRows((rows) => rows.filter((r) => r.id !== row.id))
                              touch()
                            }}
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button
                  className="btn btn-small"
                  onClick={() => {
                    setHeaderRows((rows) => [
                      ...rows,
                      { id: nextId(), enabled: true, name: '', value: '' }
                    ])
                    touch()
                  }}
                >
                  + Add header
                </button>
              </div>
            )}

            {section === 'body' &&
              (gqlOn ? (
                <div className="gql-editor">
                  <div className="gql-toolbar">
                    <button
                      className="btn btn-small"
                      onClick={() => void introspect()}
                      disabled={gqlBusy}
                    >
                      {gqlBusy ? 'Introspecting…' : 'Introspect schema'}
                    </button>
                    {gqlSchema !== null && (
                      <button
                        className="btn btn-small"
                        onClick={() => setGqlSchemaOpen((v) => !v)}
                      >
                        {gqlSchemaOpen ? 'Hide schema' : 'Show schema'}
                      </button>
                    )}
                  </div>
                  {gqlError !== null && (
                    <div className="banner banner-danger">
                      {gqlError}
                      <button className="icon-btn" onClick={() => setGqlError(null)}>
                        ×
                      </button>
                    </div>
                  )}
                  {gqlSchema !== null && gqlSchemaOpen && (
                    <GqlSchemaView
                      schema={gqlSchema}
                      onPick={(name) => {
                        setGqlQuery((q) => (q.trim() === '' ? name : `${q}\n${name}`))
                        touch()
                      }}
                    />
                  )}
                  <label className="field-label">Query</label>
                  <CodeEditor
                    language="text"
                    rows={10}
                    value={gqlQuery}
                    onChange={(v) => {
                      setGqlQuery(v)
                      touch()
                    }}
                  />
                  <label className="field-label">Variables (JSON)</label>
                  <CodeEditor
                    language="json"
                    rows={6}
                    value={gqlVars}
                    placeholder="{}"
                    onChange={(v) => {
                      setGqlVars(v)
                      touch()
                    }}
                  />
                </div>
              ) : (
                <div>
                  {bodyKind === 'file' && (
                    <div className="dim-note">
                      Body is loaded from a sidecar file (<span className="mono">--data @</span>);
                      the value below is the file path.
                    </div>
                  )}
                  <CodeEditor
                    language={bodyKind !== 'file' && /^\s*[[{]/.test(bodyText) ? 'json' : 'text'}
                    rows={14}
                    value={bodyText}
                    placeholder="Request body"
                    onChange={(v) => {
                      setBodyText(v)
                      touch()
                    }}
                  />
                </div>
              ))}

            {section === 'auth' && (
              <div className="auth-editor">
                <select
                  className="method-select"
                  value={authMode}
                  onChange={(e) => {
                    setAuthMode(e.target.value as AuthMode)
                    touch()
                  }}
                >
                  <option value="none">None</option>
                  <option value="basic">Basic</option>
                  <option value="bearer">Bearer</option>
                  <option value="oauth2">OAuth 2.0</option>
                </select>
                {authMode === 'basic' && (
                  <div className="auth-fields">
                    <label className="field-label">Username</label>
                    <input
                      className="cell-input mono"
                      value={authUser}
                      onChange={(e) => {
                        setAuthUser(e.target.value)
                        touch()
                      }}
                    />
                    <label className="field-label">Password</label>
                    <input
                      className="cell-input mono"
                      type="password"
                      value={authPass}
                      onChange={(e) => {
                        setAuthPass(e.target.value)
                        touch()
                      }}
                    />
                    <div className="dim-note">Saved as curl --user "user:pass".</div>
                  </div>
                )}
                {authMode === 'bearer' && (
                  <div className="auth-fields">
                    <label className="field-label">Token</label>
                    <input
                      className="cell-input mono"
                      value={authToken}
                      placeholder="${TOKEN}"
                      onChange={(e) => {
                        setAuthToken(e.target.value)
                        touch()
                      }}
                    />
                    <div className="dim-note">Saved as an Authorization: Bearer header.</div>
                  </div>
                )}
                {authMode === 'oauth2' && (
                  <div className="auth-fields">
                    <label className="field-label">Grant type</label>
                    <select
                      className="method-select"
                      value={oauthGrant}
                      onChange={(e) => {
                        setOauthGrant(e.target.value as OAuth2Grant)
                        touch()
                      }}
                    >
                      {OAUTH_GRANTS.map((g) => (
                        <option key={g} value={g}>
                          {g}
                        </option>
                      ))}
                    </select>
                    <label className="field-label">Token URL</label>
                    <input
                      className="cell-input mono"
                      value={oauthTokenUrl}
                      placeholder="https://auth.example.com/oauth/token"
                      onChange={(e) => {
                        setOauthTokenUrl(e.target.value)
                        touch()
                      }}
                    />
                    <label className="field-label">Client ID</label>
                    <input
                      className="cell-input mono"
                      value={oauthClientId}
                      onChange={(e) => {
                        setOauthClientId(e.target.value)
                        touch()
                      }}
                    />
                    <label className="field-label">Client secret</label>
                    <input
                      className="cell-input mono"
                      type="password"
                      value={oauthClientSecret}
                      onChange={(e) => {
                        setOauthClientSecret(e.target.value)
                        touch()
                      }}
                    />
                    <label className="field-label">Scope</label>
                    <input
                      className="cell-input mono"
                      value={oauthScope}
                      placeholder="read write"
                      onChange={(e) => {
                        setOauthScope(e.target.value)
                        touch()
                      }}
                    />
                    {oauthGrant === 'password' && (
                      <>
                        <label className="field-label">Username</label>
                        <input
                          className="cell-input mono"
                          value={oauthUsername}
                          onChange={(e) => {
                            setOauthUsername(e.target.value)
                            touch()
                          }}
                        />
                        <label className="field-label">Password</label>
                        <input
                          className="cell-input mono"
                          type="password"
                          value={oauthPassword}
                          onChange={(e) => {
                            setOauthPassword(e.target.value)
                            touch()
                          }}
                        />
                      </>
                    )}
                    <label className="field-label">Session variable</label>
                    <input
                      className="cell-input mono"
                      value={oauthSessionVar}
                      placeholder={DEFAULT_OAUTH_VAR}
                      onChange={(e) => {
                        setOauthSessionVar(e.target.value)
                        touch()
                      }}
                    />
                    <div className="oauth-actions">
                      <button
                        className="btn btn-small"
                        onClick={() => void acquireToken()}
                        disabled={oauthBusy}
                      >
                        {oauthBusy ? 'Acquiring…' : 'Acquire token'}
                      </button>
                      {oauthResult !== null && (
                        <span className="oauth-result mono">{oauthResult}</span>
                      )}
                    </div>
                    <div className="dim-note">
                      The acquired token is stored in the session variable{' '}
                      <span className="mono">
                        ${'{'}
                        {oauthSessionVar.trim() === '' ? DEFAULT_OAUTH_VAR : oauthSessionVar.trim()}
                        {'}'}
                      </span>
                      . Reference it in your request&apos;s own Authorization header, e.g.{' '}
                      <span className="mono">
                        Authorization: Bearer ${'{'}
                        {oauthSessionVar.trim() === '' ? DEFAULT_OAUTH_VAR : oauthSessionVar.trim()}
                        {'}'}
                      </span>
                      . The authorization_code grant is not supported interactively.
                    </div>
                  </div>
                )}
              </div>
            )}

            {section === 'scripts' && (
              <div className="scripts-editor">
                <label className="field-label">Pre-request script</label>
                <CodeEditor
                  language="javascript"
                  rows={8}
                  value={preScript}
                  placeholder={'pm.variables.set("ts", Date.now());'}
                  onChange={(v) => {
                    setPreScript(v)
                    touch()
                  }}
                />
                <label className="field-label">Test script</label>
                <CodeEditor
                  language="javascript"
                  rows={8}
                  value={testScript}
                  placeholder={'pm.test("status is 200", () => pm.response.to.have.status(200));'}
                  onChange={(v) => {
                    setTestScript(v)
                    touch()
                  }}
                />
              </div>
            )}

            {section === 'meta' && (
              <div className="meta-editor">
                <label className="field-label">Description</label>
                <textarea
                  className="editor"
                  rows={3}
                  value={description}
                  onChange={(e) => {
                    setDescription(e.target.value)
                    touch()
                  }}
                />
                <label className="field-label">Labels (comma-separated)</label>
                <input
                  className="cell-input"
                  value={labelsText}
                  placeholder="users, smoke"
                  onChange={(e) => {
                    setLabelsText(e.target.value)
                    touch()
                  }}
                />
                <label className="field-label">Variables</label>
                <table className="edit-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Default</th>
                      <th>Required</th>
                      <th>Secret</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {varRows.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <input
                            className="cell-input mono"
                            value={row.name}
                            placeholder="NAME"
                            onChange={(e) => updateVar(row.id, { name: e.target.value })}
                          />
                        </td>
                        <td>
                          <input
                            className="cell-input mono"
                            value={row.def}
                            type={row.secret ? 'password' : 'text'}
                            disabled={row.required}
                            title={row.required ? 'Required variables have no default' : undefined}
                            onChange={(e) => updateVar(row.id, { def: e.target.value })}
                          />
                        </td>
                        <td className="cell-check">
                          <input
                            type="checkbox"
                            checked={row.required}
                            onChange={(e) => updateVar(row.id, { required: e.target.checked })}
                          />
                        </td>
                        <td className="cell-check">
                          <input
                            type="checkbox"
                            checked={row.secret}
                            onChange={(e) => updateVar(row.id, { secret: e.target.checked })}
                          />
                        </td>
                        <td className="cell-check">
                          <button
                            className="icon-btn"
                            title="Delete variable"
                            onClick={() => {
                              setVarRows((rows) => rows.filter((r) => r.id !== row.id))
                              touch()
                            }}
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button
                  className="btn btn-small"
                  onClick={() => {
                    setVarRows((rows) => [
                      ...rows,
                      { id: nextId(), name: '', def: '', required: false, secret: false }
                    ])
                    touch()
                  }}
                >
                  + Add variable
                </button>
              </div>
            )}
          </div>
        </div>

        {respOpen && (
          <ResponsePanel
            report={report}
            sending={sending}
            below={respBelow}
            root={props.root}
            relPath={props.relPath}
            onToggleLayout={() => setRespBelow(!respBelow)}
            onClose={() => setRespOpen(false)}
          />
        )}
      </div>

      {showCodegen && (
        <CodegenModal
          root={props.root}
          relPath={props.relPath}
          envPath={props.envPath}
          onCancel={() => setShowCodegen(false)}
        />
      )}
      {showExamples && (
        <ExamplesModal
          root={props.root}
          relPath={props.relPath}
          onCancel={() => setShowExamples(false)}
        />
      )}
    </div>
  )
}

function GqlSchemaView({
  schema,
  onPick
}: {
  schema: GqlSchemaSummary
  onPick: (name: string) => void
}): JSX.Element {
  return (
    <div className="gql-schema">
      <div className="gql-schema-group">
        <div className="gql-schema-title">Queries ({schema.queries.length})</div>
        {schema.queries.length === 0 && <div className="dim-note">none</div>}
        {schema.queries.map((f) => (
          <button
            key={f.name}
            className="gql-field mono"
            title="Insert into query"
            onClick={() => onPick(f.name)}
          >
            <span className="gql-field-name">{f.name}</span>
            {f.args.length > 0 && <span className="gql-field-args">({f.args.join(', ')})</span>}
            <span className="gql-field-type">: {f.type}</span>
          </button>
        ))}
      </div>
      <div className="gql-schema-group">
        <div className="gql-schema-title">Mutations ({schema.mutations.length})</div>
        {schema.mutations.length === 0 && <div className="dim-note">none</div>}
        {schema.mutations.map((f) => (
          <button
            key={f.name}
            className="gql-field mono"
            title="Insert into query"
            onClick={() => onPick(f.name)}
          >
            <span className="gql-field-name">{f.name}</span>
            {f.args.length > 0 && <span className="gql-field-args">({f.args.join(', ')})</span>}
            <span className="gql-field-type">: {f.type}</span>
          </button>
        ))}
      </div>
      <div className="gql-schema-group">
        <div className="gql-schema-title">Types ({schema.types.length})</div>
        <div className="gql-types">
          {schema.types.map((t) => (
            <span key={t} className="chip gql-type-chip">
              {t}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
