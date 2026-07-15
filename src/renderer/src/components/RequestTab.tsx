import type { ForwardedRef, JSX } from 'react'
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { buildClientSchema, type GraphQLSchema, type IntrospectionQuery } from 'graphql'
import type {
  AcquiredToken,
  ExecutionReport,
  FormField,
  FormFieldType,
  Frontmatter,
  GqlVariableDef,
  GraphqlBody,
  Header,
  OAuth2Config,
  OAuth2Grant,
  ParseError,
  RequestFile,
  VariableDecl,
  VariableMeta
} from '../../../shared/model'
import { errMsg, fp } from '../api'
import { joinPath, looksLikeCommand, looksLikeFilePathKey, nextId } from '../util'
import { detectOperationType } from '../../../core/graphql/operation'
import ResponsePanel from './ResponsePanel'
import CodegenModal from './CodegenModal'
import ExamplesModal from './ExamplesModal'
import CodeEditor from './CodeEditor'
import GqlSchemaExplorer from './GqlSchemaExplorer'
import StreamLog, { streamEntry, type StreamEntry } from './StreamLog'
import ConfirmModal from './ConfirmModal'
import VarInput from './VarInput'
import { FolderIcon } from './Icon'
import type { VarLookup } from './varHighlight'
import { makeVarLookup, useVarSources, type VarDecl } from './varContext'
import type { TabHandle } from '../state'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
const OAUTH_GRANTS: OAuth2Grant[] = ['client_credentials', 'password', 'authorization_code']
const DEFAULT_OAUTH_VAR = 'OAUTH_TOKEN'

type Section = 'headers' | 'body' | 'auth' | 'scripts' | 'meta'
type AuthMode = 'none' | 'basic' | 'bearer' | 'oauth2'
type BodyMode = 'raw' | 'multipart' | 'graphql'
const BODY_MODES: { id: BodyMode; label: string }[] = [
  { id: 'raw', label: 'Raw · JSON' },
  { id: 'multipart', label: 'Multipart form' },
  { id: 'graphql', label: 'GraphQL' }
]

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

/** A row of the multipart form table. */
interface FormRow {
  id: number
  name: string
  type: FormFieldType
  /** text: the value. file: the source path. */
  value: string
  /** json/file: Content-Disposition filename. */
  filename: string
  /** json: the inline JSON payload. */
  content: string
}

/** A typed row of the GraphQL variables table. */
interface GqlVarRow {
  id: number
  name: string
  /** GraphQL type annotation, e.g. "ID!", "Int". Empty = untyped. */
  type: string
  /** JSON literal; parsed into the variables object (raw string on parse failure). */
  value: string
}

/** Parse a table cell as a JSON literal, falling back to the raw string. */
function parseGqlValue(raw: string): unknown {
  const t = raw.trim()
  if (t === '') return ''
  try {
    return JSON.parse(t)
  } catch {
    return raw
  }
}

/** Pretty-print a JSON string for the subscription log; pass through on failure. */
function prettyJson(s?: string): string {
  if (s === undefined) return ''
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}

interface Props {
  root: string
  relPath: string
  envPath: string | null
  onDirty: (dirty: boolean) => void
  onMethod: (method: string) => void
}

function RequestTab(props: Props, ref: ForwardedRef<TabHandle>): JSX.Element {
  const absPath = joinPath(props.root, props.relPath)

  const [loading, setLoading] = useState(true)
  const [parseErrors, setParseErrors] = useState<ParseError[] | null>(null)
  const [raw, setRaw] = useState('')
  const [error, setError] = useState<string | null>(null)
  // Non-error notice (e.g. dropped flags after a curl paste).
  const [notice, setNotice] = useState<string | null>(null)
  // A parsed pasted command awaiting confirmation before it overwrites fields.
  const [pendingPaste, setPendingPaste] = useState<RequestFile | null>(null)
  const fileRef = useRef<RequestFile | null>(null)

  // Editor state.
  const [section, setSection] = useState<Section>('headers')
  // Raw-edit pane: edit the canonical curl/websocat text directly. rawDraft is
  // the source of truth while rawMode is on; rawErrors block leaving it invalid.
  const [rawMode, setRawMode] = useState(false)
  const [rawDraft, setRawDraft] = useState('')
  const [rawErrors, setRawErrors] = useState<ParseError[] | null>(null)
  const [method, setMethod] = useState('GET')
  const [url, setUrl] = useState('')
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>([])
  const [bodyKind, setBodyKind] = useState<'raw' | 'file'>('raw')
  const [bodyText, setBodyText] = useState('')
  const [bodyMode, setBodyMode] = useState<BodyMode>('raw')
  // Per-request transport options (curl --insecure / -k, --cacert).
  const [insecure, setInsecure] = useState(false)
  const [caCert, setCaCert] = useState('')
  // Cookie jar opt-out (frontmatter cookies: false); absent = enabled.
  const [sendCookies, setSendCookies] = useState(true)
  const [formRows, setFormRows] = useState<FormRow[]>([])
  const [gqlQuery, setGqlQuery] = useState('')
  const [gqlVars, setGqlVars] = useState('')
  const [gqlSchemaUrl, setGqlSchemaUrl] = useState('')
  const [gqlVarRows, setGqlVarRows] = useState<GqlVarRow[]>([])
  // Variables editor: structured table vs. raw JSON escape hatch.
  const [gqlVarsJson, setGqlVarsJson] = useState(false)
  // Subscription endpoint override + transport (only used for subscription ops).
  const [gqlSubUrl, setGqlSubUrl] = useState('')
  const [gqlSubTransport, setGqlSubTransport] = useState<'ws' | 'sse'>('ws')
  const [subLog, setSubLog] = useState<StreamEntry[]>([])
  const [subActive, setSubActive] = useState(false)
  const subIdRef = useRef<string | null>(null)
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
  // authorization_code interactive flow.
  const [oauthAuthUrl, setOauthAuthUrl] = useState('')
  const [oauthRedirectUri, setOauthRedirectUri] = useState('')
  const oauthFlowIdRef = useRef<string | null>(null)
  const [oauthFlowActive, setOauthFlowActive] = useState(false)
  const [oauthBusy, setOauthBusy] = useState(false)
  const [oauthResult, setOauthResult] = useState<string | null>(null)
  // GraphQL introspection.
  const [gqlSchemaObj, setGqlSchemaObj] = useState<GraphQLSchema | null>(null)
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
  // Right-click "Browse file" menu anchored over a meta variable's value cell.
  const [varCtxMenu, setVarCtxMenu] = useState<{ x: number; y: number; rowId: number } | null>(null)

  // Variable resolution context for `${VAR}` highlighting + hover hints.
  const varSources = useVarSources(props.root, props.envPath)

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

    // GraphQL + multipart are loaded independently so switching modes restores
    // each mode's data; the active mode follows precedence graphql > form > raw.
    if (fm.graphql !== undefined) {
      setGqlQuery(fm.graphql.query)
      setGqlSchemaUrl(fm.graphql.schemaUrl ?? '')
      setGqlSubUrl(fm.graphql.subscriptionUrl ?? '')
      setGqlSubTransport(fm.graphql.subscriptionTransport ?? 'ws')
      setGqlVars(
        fm.graphql.variables !== undefined ? JSON.stringify(fm.graphql.variables, null, 2) : ''
      )
      // Prefer typed variableDefs; fall back to reconstructing rows from the
      // derived variables object (older files / imports without defs).
      const defs = fm.graphql.variableDefs
      if (defs !== undefined && defs.length > 0) {
        setGqlVarRows(
          defs.map((d) => ({ id: nextId(), name: d.name, type: d.type, value: d.value }))
        )
        setGqlVarsJson(false)
      } else if (fm.graphql.variables !== undefined) {
        setGqlVarRows(
          Object.entries(fm.graphql.variables).map(([name, v]) => ({
            id: nextId(),
            name,
            type: '',
            value: JSON.stringify(v)
          }))
        )
        setGqlVarsJson(false)
      } else {
        setGqlVarRows([])
      }
    }
    if (fm.form !== undefined) {
      setFormRows(
        fm.form.map((f) => ({
          id: nextId(),
          name: f.name,
          type: f.type,
          value: f.value ?? '',
          filename: f.filename ?? '',
          content: f.content ?? ''
        }))
      )
    }
    setBodyMode(fm.graphql !== undefined ? 'graphql' : fm.form !== undefined ? 'multipart' : 'raw')
    setInsecure(http?.options.insecure === true)
    setCaCert(http?.options.caCert ?? '')
    setSendCookies(fm.cookies !== false)

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
      setOauthAuthUrl(a.authUrl ?? '')
      setOauthRedirectUri(a.redirectUri ?? '')
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
        setRawMode(false)
        setRawErrors(null)
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

  /* -------------------------- variable context -------------------------- */

  // Request-declared defaults reflect the live (unsaved) Meta table; session
  // and environment come from the shared source hook.
  const varLookup = useMemo<VarLookup>(() => {
    const decls = new Map<string, VarDecl>()
    for (const r of varRows) {
      const name = r.name.trim()
      if (name !== '') decls.set(name, { def: r.def, required: r.required, secret: r.secret })
    }
    return makeVarLookup(varSources, decls)
  }, [varSources, varRows])

  // A subscription operation streams over ws/sse instead of a one-shot POST.
  const gqlOpType = useMemo(() => detectOperationType(gqlQuery), [gqlQuery])
  const isGqlSubscription = bodyMode === 'graphql' && gqlOpType === 'subscription'

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

    // Cookie jar opt-out: only `cookies: false` is persisted; enabled is the default.
    if (!sendCookies) fm.cookies = false
    else delete fm.cookies

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
    if (insecure) options.insecure = true
    else delete options.insecure
    if (caCert.trim() !== '') options.caCert = caCert.trim()
    else delete options.caCert
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
      // authorization_code carries the authorize URL and (optional) redirect URI,
      // edited on the Auth tab.
      if (oauthGrant === 'authorization_code') {
        if (oauthAuthUrl.trim() !== '') auth.authUrl = oauthAuthUrl.trim()
        if (oauthRedirectUri.trim() !== '') auth.redirectUri = oauthRedirectUri.trim()
      }
      // Preserve any inherited-only keys the editor doesn't surface.
      const prev = orig.frontmatter.auth
      if (prev?.tokenName !== undefined) auth.tokenName = prev.tokenName
      fm.auth = auth
    } else {
      delete fm.auth
    }

    // Body / GraphQL / multipart. Only the active mode's frontmatter is written
    // (precedence graphql > form > raw), so the loaded mode is unambiguous.
    delete fm.graphql
    delete fm.form
    let body: { kind: 'raw' | 'file'; value: string } | undefined
    if (bodyMode === 'multipart') {
      const fields: FormField[] = formRows
        .filter((r) => r.name.trim() !== '')
        .map((r) => {
          const f: FormField = { name: r.name.trim(), type: r.type }
          if (r.type === 'json') {
            f.content = r.content
            if (r.filename.trim() !== '') f.filename = r.filename.trim()
          } else if (r.type === 'file') {
            f.value = r.value
            if (r.filename.trim() !== '') f.filename = r.filename.trim()
          } else {
            f.value = r.value
          }
          return f
        })
      if (fields.length > 0) fm.form = fields
      // The writer regenerates --form from frontmatter.form; no --data body.
      body = undefined
    } else if (bodyMode === 'graphql') {
      let variables: Record<string, unknown> | undefined
      let variableDefs: GqlVariableDef[] | undefined
      if (gqlVarsJson) {
        // Raw-JSON escape hatch: the textarea is authoritative.
        const varsText = gqlVars.trim()
        if (varsText !== '') {
          try {
            variables = JSON.parse(varsText) as Record<string, unknown>
          } catch {
            setError('GraphQL variables must be valid JSON.')
            return null
          }
        }
      } else {
        const rows = gqlVarRows.filter((r) => r.name.trim() !== '')
        if (rows.length > 0) {
          variableDefs = rows.map((r) => ({
            name: r.name.trim(),
            type: r.type.trim(),
            value: r.value
          }))
          variables = {}
          for (const r of rows) variables[r.name.trim()] = parseGqlValue(r.value)
        }
      }
      const g: GraphqlBody = { query: gqlQuery }
      if (variables !== undefined) g.variables = variables
      if (variableDefs !== undefined) g.variableDefs = variableDefs
      if (gqlSchemaUrl.trim() !== '') g.schemaUrl = gqlSchemaUrl.trim()
      if (gqlSubUrl.trim() !== '') g.subscriptionUrl = gqlSubUrl.trim()
      if (gqlSubTransport !== 'ws') g.subscriptionTransport = gqlSubTransport
      fm.graphql = g
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

  /** Pick a CA certificate file via the system dialog, filling the path field. */
  async function browseCaCert(): Promise<void> {
    const path = await fp().browseFile({
      title: 'Select a CA certificate',
      filters: [
        { name: 'Certificates', extensions: ['pem', 'crt', 'cer', 'ca', 'ca-bundle'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (path !== null) {
      setCaCert(path)
      touch()
    }
  }

  /** Pick a file via the system dialog and store its path as a variable's value. */
  async function browseVarFile(rowId: number): Promise<void> {
    setVarCtxMenu(null)
    const path = await fp().browseFile({ title: 'Select a file' })
    if (path !== null) updateVar(rowId, { def: path })
  }

  /**
   * The model for the active view: the raw draft (parsed strictly) when the raw
   * pane is open, otherwise the assembled form state. Returns null and surfaces
   * errors (raw parse errors, or an assemble error) when the view is invalid.
   */
  async function resolveModel(): Promise<RequestFile | null> {
    if (rawMode) {
      const res = await fp().parseCommand({
        text: rawDraft,
        strict: true,
        kind: fileRef.current?.kind
      })
      if (!res.ok) {
        setRawErrors(res.errors)
        return null
      }
      setRawErrors(null)
      return res.file
    }
    return assemble()
  }

  async function save(): Promise<boolean> {
    setError(null)
    const file = await resolveModel()
    if (file === null) return false
    setSaving(true)
    try {
      const { raw: newRaw } = await fp().writeRequest(absPath, file)
      setRaw(newRaw)
      fileRef.current = file
      // Keep both views consistent with the canonical text just written.
      if (rawMode) {
        populate(file)
        setRawDraft(newRaw)
      }
      onMethodRef.current(file.http?.method ?? method)
      clean()
      return true
    } catch (e) {
      setError(errMsg(e))
      return false
    } finally {
      setSaving(false)
    }
  }

  // Let the shell save this tab when closing it (or the app) with unsaved edits.
  useImperativeHandle(ref, () => ({ save }))

  async function send(): Promise<void> {
    setError(null)
    // Execute the live editor state (assembled model or raw draft), not the
    // on-disk file, so unsaved edits are what runs.
    const model = await resolveModel()
    if (model === null) return
    setSending(true)
    setRespOpen(true)
    try {
      const rep = await fp().executeRequest({
        root: props.root,
        path: props.relPath,
        envPath: props.envPath ?? undefined,
        model
      })
      setReport(rep)
    } catch (e) {
      setReport(null)
      setError(errMsg(e))
    } finally {
      setSending(false)
    }
  }

  /* ------------------------ graphql subscriptions ------------------------ */

  /** The current editor variables (typed rows or the raw-JSON escape hatch). */
  function currentGqlVariables(): Record<string, unknown> | undefined {
    if (gqlVarsJson) {
      const t = gqlVars.trim()
      if (t === '') return undefined
      try {
        return JSON.parse(t) as Record<string, unknown>
      } catch {
        return undefined
      }
    }
    const rows = gqlVarRows.filter((r) => r.name.trim() !== '')
    if (rows.length === 0) return undefined
    const out: Record<string, unknown> = {}
    for (const r of rows) out[r.name.trim()] = parseGqlValue(r.value)
    return out
  }

  async function subscribe(): Promise<void> {
    setError(null)
    // Query + variables + endpoint come from the live editor; the main process
    // reads the saved file only for auth headers and ${VAR} resolution (as
    // introspection does), so unsaved header edits require a save first.
    setSubLog((l) => [...l, streamEntry('info', `subscribing over ${gqlSubTransport}…`)])
    setSubActive(true)
    try {
      const { id } = await fp().subscribeGraphql({
        root: props.root,
        path: props.relPath,
        envPath: props.envPath ?? undefined,
        query: gqlQuery,
        variables: currentGqlVariables(),
        url: gqlSubUrl.trim() === '' ? undefined : gqlSubUrl.trim(),
        transport: gqlSubTransport
      })
      subIdRef.current = id
    } catch (e) {
      setSubActive(false)
      setSubLog((l) => [...l, streamEntry('error', errMsg(e))])
    }
  }

  async function stopSubscription(): Promise<void> {
    const id = subIdRef.current
    subIdRef.current = null
    setSubActive(false)
    if (id !== null) {
      setSubLog((l) => [...l, streamEntry('info', 'stopped')])
      try {
        await fp().unsubscribeGraphql(id)
      } catch {
        /* already gone */
      }
    }
  }

  // Accumulate streamed subscription payloads; filter to our active connection.
  useEffect(() => {
    const off = fp().onGqlSubEvent((e) => {
      if (e.id !== subIdRef.current) return
      if (e.type === 'next') {
        setSubLog((l) => [...l, streamEntry('recv', prettyJson(e.data))])
      } else if (e.type === 'error') {
        setSubLog((l) => [...l, streamEntry('error', e.data ?? 'error')])
        setSubActive(false)
        subIdRef.current = null
      } else {
        setSubLog((l) => [...l, streamEntry('info', 'complete')])
        setSubActive(false)
        subIdRef.current = null
      }
    })
    return () => {
      off()
      const id = subIdRef.current
      if (id !== null) void fp().unsubscribeGraphql(id).catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* --------------------------- paste-curl-to-fill --------------------------- */

  /** Overwrite every field from a parsed request and surface any import notes. */
  function fillFromParsed(file: RequestFile): void {
    populate(file)
    touch()
    if (file.http !== undefined) onMethodRef.current(file.http.method)
    const note = file.frontmatter['import-note']
    setNotice(typeof note === 'string' ? `Imported, dropping: ${note}` : null)
  }

  /** Parse a pasted command; fill directly if the request is empty, else confirm. */
  async function applyPastedCommand(text: string): Promise<void> {
    setError(null)
    setNotice(null)
    let res
    try {
      res = await fp().parseCommand({ text })
    } catch (e) {
      setError(errMsg(e))
      return
    }
    if (!res.ok) {
      setError(res.errors[0]?.message ?? 'Could not parse the pasted command')
      return
    }
    const tabKind = fileRef.current?.kind ?? 'curl'
    if (res.kind !== tabKind) {
      setError(
        `Pasted a ${res.kind} command into a ${tabKind} request. Use Import to create a new ${res.kind} request instead.`
      )
      return
    }
    if (url.trim() !== '' || dirtyRef.current) setPendingPaste(res.file)
    else fillFromParsed(res.file)
  }

  /** VarInput paste hook: consume the paste only when it is a command. */
  function handleUrlPaste(text: string): boolean {
    if (!looksLikeCommand(text)) return false
    void applyPastedCommand(text)
    return true
  }

  /* ------------------------------ raw-edit pane ----------------------------- */

  /** Toggle Form ⇄ Raw. Form→Raw serializes the live model; Raw→Form parses the
   *  draft (strictly) and repopulates, blocking the switch on a parse error. */
  async function toggleRawMode(): Promise<void> {
    setError(null)
    if (rawMode) {
      const file = await resolveModel()
      if (file === null) return // rawErrors set by resolveModel; stay in Raw
      populate(file)
      touch()
      if (file.http !== undefined) onMethodRef.current(file.http.method)
      setRawMode(false)
    } else {
      const file = assemble()
      if (file === null) return // assemble surfaced an error (e.g. bad GraphQL JSON)
      try {
        const { raw: text } = await fp().formatRequest(file)
        setRawDraft(text)
        setRawErrors(null)
        setRawMode(true)
      } catch (e) {
        setError(errMsg(e))
      }
    }
  }

  /** Format an acquired token for the small status line next to the button. */
  function tokenSummary(token: AcquiredToken): string {
    const truncated =
      token.accessToken.length > 16
        ? `${token.accessToken.slice(0, 8)}…${token.accessToken.slice(-4)}`
        : token.accessToken
    const expiry =
      token.expiresAt !== undefined
        ? ` · expires ${new Date(token.expiresAt).toLocaleString()}`
        : ''
    return `${token.tokenType} ${truncated}${expiry}`
  }

  async function acquireToken(): Promise<void> {
    setOauthResult(null)
    // authorization_code needs an interactive browser sign-in (handled by the
    // main process + a loopback listener); other grants are a direct POST.
    if (oauthGrant === 'authorization_code') {
      setOauthBusy(true)
      setOauthResult('Waiting for browser sign-in…')
      try {
        const { id } = await fp().authorizeOAuthStart({
          root: props.root,
          path: props.relPath,
          envPath: props.envPath ?? undefined
        })
        oauthFlowIdRef.current = id
        setOauthFlowActive(true)
        // The terminal outcome arrives via onOAuthAuthorizeEvent.
      } catch (e) {
        setOauthResult(errMsg(e))
        setOauthBusy(false)
      }
      return
    }
    setOauthBusy(true)
    try {
      const token: AcquiredToken = await fp().acquireOAuthToken({
        root: props.root,
        path: props.relPath,
        envPath: props.envPath ?? undefined
      })
      setOauthResult(tokenSummary(token))
    } catch (e) {
      setOauthResult(errMsg(e))
    } finally {
      setOauthBusy(false)
    }
  }

  function cancelOAuthFlow(): void {
    const id = oauthFlowIdRef.current
    if (id !== null) void fp().authorizeOAuthCancel(id).catch(() => undefined)
    oauthFlowIdRef.current = null
    setOauthFlowActive(false)
    setOauthBusy(false)
  }

  // Terminal outcome of an interactive authorization_code sign-in.
  useEffect(() => {
    const off = fp().onOAuthAuthorizeEvent((e) => {
      if (e.id !== oauthFlowIdRef.current) return
      oauthFlowIdRef.current = null
      setOauthFlowActive(false)
      setOauthBusy(false)
      setOauthResult(e.ok ? tokenSummary(e.token) : errMsg(e.error))
    })
    return () => {
      off()
      const id = oauthFlowIdRef.current
      if (id !== null) void fp().authorizeOAuthCancel(id).catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function introspect(opts?: { open?: boolean }): Promise<void> {
    setGqlError(null)
    setGqlBusy(true)
    try {
      const result = await fp().introspectGraphql({
        root: props.root,
        path: props.relPath,
        envPath: props.envPath ?? undefined,
        schemaUrl: gqlSchemaUrl.trim() === '' ? undefined : gqlSchemaUrl.trim()
      })
      if (result.ok) {
        if (opts?.open !== false) setGqlSchemaOpen(true)
        // Build the full client schema for editor completion/linting + explorer.
        if (result.introspection !== undefined) {
          try {
            setGqlSchemaObj(buildClientSchema(result.introspection as IntrospectionQuery))
          } catch {
            setGqlSchemaObj(null)
          }
        } else {
          setGqlSchemaObj(null)
        }
      } else {
        setGqlSchemaObj(null)
        setGqlError(result.error)
      }
    } catch (e) {
      setGqlSchemaObj(null)
      setGqlError(errMsg(e))
    } finally {
      setGqlBusy(false)
    }
  }

  // Auto-fetch the schema when the URL settles (debounced), so editor
  // highlighting/completion becomes available without an explicit click.
  useEffect(() => {
    if (bodyMode !== 'graphql') return
    const url = gqlSchemaUrl.trim()
    if (url === '') return
    const t = setTimeout(() => void introspect({ open: false }), 600)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gqlSchemaUrl, bodyMode])

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
  const updateGqlVar = (id: number, patch: Partial<GqlVarRow>): void => {
    setGqlVarRows((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))
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
      {notice !== null && (
        <div className="banner banner-warn">
          {notice}
          <button className="icon-btn" onClick={() => setNotice(null)}>
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
        <VarInput
          className="grow"
          value={url}
          placeholder="https://api.example.com/path — or paste a curl command"
          varLookup={varLookup}
          onPaste={handleUrlPaste}
          onChange={(v) => {
            setUrl(v)
            touch()
          }}
        />
        {isGqlSubscription ? (
          subActive ? (
            <button className="btn btn-danger" onClick={() => void stopSubscription()}>
              Stop
            </button>
          ) : (
            <button className="btn btn-accent" onClick={() => void subscribe()}>
              Subscribe
            </button>
          )
        ) : (
          <button className="btn btn-accent" onClick={() => void send()} disabled={sending}>
            {sending ? 'Sending…' : 'Send'}
          </button>
        )}
        <button className="btn" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          className={'btn' + (rawMode ? ' btn-toggled' : '')}
          onClick={() => void toggleRawMode()}
          title={rawMode ? 'Switch to the form editor' : 'Edit the raw request file as text'}
        >
          {rawMode ? 'Form' : 'Raw'}
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
          {rawMode ? (
            <div className="section-content raw-edit">
              {rawErrors !== null && (
                <div className="banner banner-danger">
                  <ul>
                    {rawErrors.map((pe, i) => (
                      <li key={i}>
                        line {pe.line}: {pe.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <CodeEditor
                language="text"
                rows={22}
                value={rawDraft}
                placeholder={'curl https://api.example.com/path \\\n  --header ...'}
                varLookup={varLookup}
                onChange={(v) => {
                  setRawDraft(v)
                  touch()
                  if (rawErrors !== null) setRawErrors(null)
                }}
              />
              <div className="dim-note">
                Editing the canonical request file. Switch back to <b>Form</b> to apply, or{' '}
                <b>Save</b> to write it. Invalid syntax is reported and blocks the switch.
              </div>
            </div>
          ) : (
            <>
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
                    ? bodyMode === 'graphql'
                      ? 'Body (GraphQL)'
                      : bodyMode === 'multipart'
                        ? 'Body (Form)'
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
                          <VarInput
                            className="cell-var"
                            placeholder="Value"
                            value={row.value}
                            varLookup={varLookup}
                            onChange={(v) => updateHeader(row.id, { value: v })}
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

            {section === 'body' && (
              <div className="body-editor">
                <div className="body-mode-tabs">
                  {BODY_MODES.map((m) => (
                    <button
                      key={m.id}
                      className={'section-tab' + (bodyMode === m.id ? ' section-tab-active' : '')}
                      onClick={() => {
                        setBodyMode(m.id)
                        touch()
                      }}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
                {bodyMode === 'graphql' && (
                <div className="gql-editor">
                  <label className="field-label">Schema URL</label>
                  <input
                    className="cell-input mono"
                    value={gqlSchemaUrl}
                    placeholder="https://api.example.com/graphql (defaults to the request URL)"
                    onChange={(e) => {
                      setGqlSchemaUrl(e.target.value)
                      touch()
                    }}
                  />
                  <div className="gql-toolbar">
                    <button
                      className="btn btn-small"
                      onClick={() => void introspect()}
                      disabled={gqlBusy}
                    >
                      {gqlBusy ? 'Introspecting…' : 'Introspect schema'}
                    </button>
                    {gqlSchemaObj !== null && (
                      <span className="dim-note">Schema loaded · completion active</span>
                    )}
                    {gqlSchemaObj !== null && (
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
                  {gqlSchemaObj !== null && gqlSchemaOpen && (
                    <GqlSchemaExplorer
                      schema={gqlSchemaObj}
                      onPick={(name) => {
                        setGqlQuery((q) => (q.trim() === '' ? name : `${q}\n${name}`))
                        touch()
                      }}
                    />
                  )}
                  {isGqlSubscription && (
                    <div className="gql-sub-config">
                      <label className="field-label">Subscription endpoint</label>
                      <div className="gql-sub-row">
                        <input
                          className="cell-input mono grow"
                          value={gqlSubUrl}
                          placeholder="(derives from the request URL — http→ws)"
                          onChange={(e) => {
                            setGqlSubUrl(e.target.value)
                            touch()
                          }}
                        />
                        <select
                          className="cell-input gql-sub-transport"
                          value={gqlSubTransport}
                          onChange={(e) => {
                            setGqlSubTransport(e.target.value as 'ws' | 'sse')
                            touch()
                          }}
                        >
                          <option value="ws">WebSocket</option>
                          <option value="sse">SSE</option>
                        </select>
                      </div>
                    </div>
                  )}
                  <label className="field-label">Query</label>
                  <CodeEditor
                    language="graphql"
                    graphqlSchema={gqlSchemaObj}
                    rows={10}
                    value={gqlQuery}
                    placeholder="query { }"
                    varLookup={varLookup}
                    onChange={(v) => {
                      setGqlQuery(v)
                      touch()
                    }}
                  />
                  <div className="gql-vars-head">
                    <label className="field-label">Variables</label>
                    <button
                      className="btn btn-small"
                      title="Toggle between the table and raw JSON"
                      onClick={() => {
                        // Sync across representations when switching views.
                        if (gqlVarsJson) {
                          // JSON -> table: reparse the JSON object into rows.
                          try {
                            const obj = gqlVars.trim() === '' ? {} : JSON.parse(gqlVars)
                            setGqlVarRows(
                              Object.entries(obj as Record<string, unknown>).map(([name, v]) => ({
                                id: nextId(),
                                name,
                                type: '',
                                value: JSON.stringify(v)
                              }))
                            )
                            setGqlVarsJson(false)
                          } catch {
                            setError('GraphQL variables must be valid JSON to switch to the table.')
                          }
                        } else {
                          // table -> JSON: serialize the current rows.
                          const obj: Record<string, unknown> = {}
                          for (const r of gqlVarRows) {
                            if (r.name.trim() !== '') obj[r.name.trim()] = parseGqlValue(r.value)
                          }
                          setGqlVars(JSON.stringify(obj, null, 2))
                          setGqlVarsJson(true)
                        }
                      }}
                    >
                      {gqlVarsJson ? 'Table' : 'Raw JSON'}
                    </button>
                  </div>
                  {gqlVarsJson ? (
                    <CodeEditor
                      language="json"
                      rows={6}
                      value={gqlVars}
                      placeholder="{}"
                      varLookup={varLookup}
                      onChange={(v) => {
                        setGqlVars(v)
                        touch()
                      }}
                    />
                  ) : (
                    <>
                      <table className="edit-table">
                        <thead>
                          <tr>
                            <th>Name</th>
                            <th>Type</th>
                            <th>Value</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {gqlVarRows.map((row) => (
                            <tr key={row.id}>
                              <td>
                                <input
                                  className="cell-input mono"
                                  placeholder="id"
                                  value={row.name}
                                  onChange={(e) => updateGqlVar(row.id, { name: e.target.value })}
                                />
                              </td>
                              <td>
                                <input
                                  className="cell-input mono"
                                  placeholder="ID!"
                                  value={row.type}
                                  onChange={(e) => updateGqlVar(row.id, { type: e.target.value })}
                                />
                              </td>
                              <td>
                                <input
                                  className="cell-input mono"
                                  placeholder='"123"'
                                  value={row.value}
                                  onChange={(e) => updateGqlVar(row.id, { value: e.target.value })}
                                />
                              </td>
                              <td className="cell-check">
                                <button
                                  className="icon-btn"
                                  title="Delete variable"
                                  onClick={() => {
                                    setGqlVarRows((rows) => rows.filter((r) => r.id !== row.id))
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
                          setGqlVarRows((rows) => [
                            ...rows,
                            { id: nextId(), name: '', type: '', value: '' }
                          ])
                          touch()
                        }}
                      >
                        + Add variable
                      </button>
                      <div className="dim-note">
                        Value is a JSON literal (<span className="mono">&quot;text&quot;</span>,{' '}
                        <span className="mono">42</span>, <span className="mono">true</span>); bare
                        text is treated as a string.
                      </div>
                    </>
                  )}
                  {isGqlSubscription && (subActive || subLog.length > 0) && (
                    <div className="gql-sub-stream">
                      <div className="gql-vars-head">
                        <label className="field-label">
                          Subscription stream{subActive ? ' · live' : ''}
                        </label>
                        {subLog.length > 0 && (
                          <button className="btn btn-small" onClick={() => setSubLog([])}>
                            Clear
                          </button>
                        )}
                      </div>
                      <StreamLog entries={subLog} empty="Waiting for data…" />
                    </div>
                  )}
                </div>
                )}
                {bodyMode === 'raw' && (
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
                    varLookup={varLookup}
                    onChange={(v) => {
                      setBodyText(v)
                      touch()
                    }}
                  />
                </div>
                )}
                {bodyMode === 'multipart' && (
                  <MultipartEditor
                    rows={formRows}
                    varLookup={varLookup}
                    onChange={(rows) => {
                      setFormRows(rows)
                      touch()
                    }}
                  />
                )}
              </div>
            )}

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
                    <VarInput
                      className="cell-var"
                      value={authToken}
                      placeholder="${TOKEN}"
                      varLookup={varLookup}
                      onChange={(v) => {
                        setAuthToken(v)
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
                    {oauthGrant === 'authorization_code' && (
                      <>
                        <label className="field-label">Authorization URL</label>
                        <input
                          className="cell-input mono"
                          value={oauthAuthUrl}
                          placeholder="https://provider/authorize"
                          onChange={(e) => {
                            setOauthAuthUrl(e.target.value)
                            touch()
                          }}
                        />
                        <label className="field-label">Redirect URI</label>
                        <input
                          className="cell-input mono"
                          value={oauthRedirectUri}
                          placeholder="blank = auto-picked loopback port"
                          onChange={(e) => {
                            setOauthRedirectUri(e.target.value)
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
                        {oauthGrant === 'authorization_code'
                          ? oauthBusy
                            ? 'Signing in…'
                            : 'Sign in'
                          : oauthBusy
                            ? 'Acquiring…'
                            : 'Acquire token'}
                      </button>
                      {oauthFlowActive && (
                        <button className="btn btn-small" onClick={cancelOAuthFlow}>
                          Cancel
                        </button>
                      )}
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
                      .{' '}
                      {oauthGrant === 'authorization_code'
                        ? 'Sign in opens your system browser; the token is cached under .freepost/ and refreshed automatically on later runs. Headless CLI runs reuse that cached token (no browser), so sign in here at least once first.'
                        : ''}
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
                <label className="field-label">Options</label>
                <label className="opt-check" title="curl --insecure / -k">
                  <input
                    type="checkbox"
                    checked={insecure}
                    onChange={(e) => {
                      setInsecure(e.target.checked)
                      touch()
                    }}
                  />
                  Skip HTTPS validation (do not verify the server certificate)
                </label>
                <label
                  className="opt-check"
                  title="Uncheck to keep this request out of the collection cookie jar"
                >
                  <input
                    type="checkbox"
                    checked={sendCookies}
                    onChange={(e) => {
                      setSendCookies(e.target.checked)
                      touch()
                    }}
                  />
                  Send and store cookies
                </label>
                <label className="field-label">CA certificate</label>
                <div className="opt-file">
                  <VarInput
                    className="cell-var grow"
                    value={caCert}
                    placeholder="/path/to/ca.pem or ${CA_CERT} — blank uses system + bundled roots"
                    varLookup={varLookup}
                    onChange={(v) => {
                      setCaCert(v)
                      touch()
                    }}
                  />
                  <button className="btn btn-small" onClick={() => void browseCaCert()}>
                    Browse…
                  </button>
                </div>
                <div className="dim-note">
                  Trust a self-signed or corporate root for this request (curl{' '}
                  <span className="mono">--cacert</span>). The path may be absolute or relative to
                  this request; <span className="mono">${'{'}VAR{'}'}</span> resolves from your
                  environment.
                </div>
                <label className="field-label">Variables</label>
                <table className="edit-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Value</th>
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
                          <div className="cell-file">
                            <input
                              className="cell-input mono grow"
                              value={row.def}
                              type={row.secret ? 'password' : 'text'}
                              disabled={row.required}
                              placeholder={row.required ? '' : 'value or ${OTHER}'}
                              title={
                                row.required
                                  ? 'Required variables take their value from the session or environment'
                                  : 'Highest-precedence value for this request. May reference other variables, e.g. ${env}-${id}. Leave blank to fall back to session/environment.'
                              }
                              onChange={(e) => updateVar(row.id, { def: e.target.value })}
                              onContextMenu={(e) => {
                                if (row.required) return
                                e.preventDefault()
                                setVarCtxMenu({ x: e.clientX, y: e.clientY, rowId: row.id })
                              }}
                            />
                            {!row.required && looksLikeFilePathKey(row.name) && (
                              <span
                                className="file-hint"
                                title="Right-click the value to browse for a file"
                              >
                                <FolderIcon />
                              </span>
                            )}
                          </div>
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
            </>
          )}
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
      {pendingPaste !== null && (
        <ConfirmModal
          title="Replace request?"
          message="Replace this request's URL, method, headers, body, and auth with the pasted command?"
          confirmText="Replace"
          onConfirm={() => {
            fillFromParsed(pendingPaste)
            setPendingPaste(null)
          }}
          onCancel={() => setPendingPaste(null)}
        />
      )}

      {varCtxMenu !== null && (
        <>
          <div
            className="ctx-menu-backdrop"
            onMouseDown={() => setVarCtxMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault()
              setVarCtxMenu(null)
            }}
          />
          <div className="ctx-menu" style={{ top: varCtxMenu.y, left: varCtxMenu.x }}>
            <button
              className="ctx-menu-item"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => void browseVarFile(varCtxMenu.rowId)}
            >
              Browse file…
            </button>
          </div>
        </>
      )}
    </div>
  )
}

export default forwardRef(RequestTab)

const FORM_TYPES: FormFieldType[] = ['text', 'file', 'json']

/** Editor for a multipart/form-data body: one row per field, with a revealed
 *  filename input + JSON editor for `json` fields. */
function MultipartEditor({
  rows,
  varLookup,
  onChange
}: {
  rows: FormRow[]
  varLookup: VarLookup
  onChange: (rows: FormRow[]) => void
}): JSX.Element {
  const patch = (id: number, p: Partial<FormRow>): void =>
    onChange(rows.map((r) => (r.id === id ? { ...r, ...p } : r)))
  const remove = (id: number): void => onChange(rows.filter((r) => r.id !== id))
  const add = (): void =>
    onChange([...rows, { id: nextId(), name: '', type: 'text', value: '', filename: '', content: '' }])

  return (
    <div className="form-editor">
      {rows.map((row) => (
        <div key={row.id} className="form-field">
          <div className="form-field-head">
            <input
              className="cell-input mono"
              placeholder="Field name"
              value={row.name}
              onChange={(e) => patch(row.id, { name: e.target.value })}
            />
            <select
              className="method-select"
              value={row.type}
              onChange={(e) => patch(row.id, { type: e.target.value as FormFieldType })}
            >
              {FORM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t === 'text' ? 'Text' : t === 'file' ? 'File' : 'JSON'}
                </option>
              ))}
            </select>
            {row.type === 'text' && (
              <VarInput
                className="cell-var grow"
                placeholder="Value"
                value={row.value}
                varLookup={varLookup}
                onChange={(v) => patch(row.id, { value: v })}
              />
            )}
            {row.type === 'file' && (
              <VarInput
                className="cell-var grow"
                placeholder="./path/to/file (relative to the request)"
                value={row.value}
                varLookup={varLookup}
                onChange={(v) => patch(row.id, { value: v })}
              />
            )}
            {row.type === 'json' && (
              <input
                className="cell-input mono"
                placeholder="filename, e.g. payload.json"
                value={row.filename}
                onChange={(e) => patch(row.id, { filename: e.target.value })}
              />
            )}
            <button className="icon-btn" title="Delete field" onClick={() => remove(row.id)}>
              ×
            </button>
          </div>
          {row.type === 'file' && (
            <input
              className="cell-input mono form-field-filename"
              placeholder="filename override (optional; defaults to the file's name)"
              value={row.filename}
              onChange={(e) => patch(row.id, { filename: e.target.value })}
            />
          )}
          {row.type === 'json' && (
            <CodeEditor
              language="json"
              rows={6}
              value={row.content}
              placeholder="{}"
              varLookup={varLookup}
              onChange={(v) => patch(row.id, { content: v })}
            />
          )}
        </div>
      ))}
      <button className="btn btn-small" onClick={add}>
        + Add field
      </button>
    </div>
  )
}
