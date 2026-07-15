import type { JSX } from 'react'
import { useEffect, useMemo, useState } from 'react'
import type { CookieRecord } from '../../../core/cookies'
import {
  base64Decode,
  base64Encode,
  detectFormat,
  detectValueKind,
  jsonPrettyPrint,
  jwtDecode,
  parseSetCookie,
  toCookieHeader,
  toSetCookie,
  urlDecode,
  urlEncode,
  validateCookie
} from '../../../core/cookies'
import { errMsg, fp } from '../api'
import {
  exportCookies,
  exportFilename,
  formatExpires,
  isExpired,
  parseExpiresInput,
  parseImportText,
  type CookieFormat
} from '../cookieUi'
import { nextId } from '../util'

interface Props {
  root: string
  onClose: () => void
}

interface Row {
  id: number
  /** Identity as persisted in the jar; null = new row not yet saved. */
  saved: CookieRecord | null
  c: CookieRecord
  expiresText: string
  expiresInvalid: boolean
}

type Sub =
  | { kind: 'export' }
  | { kind: 'import' }
  | { kind: 'view'; title: string; text: string }
  | { kind: 'raw'; rowId: number }

type CtxTarget = { type: 'row'; rowId: number } | { type: 'domain'; domain: string }

const SAME_SITES = ['Strict', 'Lax', 'None'] as const

/** Strip an undefined sameSite so the IPC payload stays clean. */
function normalize(c: CookieRecord): CookieRecord {
  const out: CookieRecord = {
    name: c.name.trim(),
    value: c.value,
    domain: c.domain.trim(),
    path: c.path,
    expires: c.expires,
    secure: c.secure,
    httpOnly: c.httpOnly
  }
  if (c.sameSite !== undefined) out.sameSite = c.sameSite
  return out
}

function canPersist(c: CookieRecord): boolean {
  return c.name.trim() !== '' && c.domain.trim() !== ''
}

function sameCookie(a: CookieRecord, b: CookieRecord): boolean {
  return (
    a.name === b.name &&
    a.value === b.value &&
    a.domain === b.domain &&
    a.path === b.path &&
    a.expires === b.expires &&
    a.secure === b.secure &&
    a.httpOnly === b.httpOnly &&
    a.sameSite === b.sameSite
  )
}

function toRow(c: CookieRecord): Row {
  return { id: nextId(), saved: c, c, expiresText: formatExpires(c.expires), expiresInvalid: false }
}

/** Domain-grouped, inline-editable viewer/editor for the collection cookie jar. */
export default function CookieManager(props: Props): JSX.Element {
  const { root } = props
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [onlyIssues, setOnlyIssues] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [ctx, setCtx] = useState<{ x: number; y: number; target: CtxTarget } | null>(null)
  const [sub, setSub] = useState<Sub | null>(null)
  // Raw-edit sub-modal draft (kept here so the sub-modal stays stateless).
  const [rawDraft, setRawDraft] = useState('')

  async function load(): Promise<void> {
    setLoading(true)
    try {
      const list = await fp().cookieList(root)
      list.sort(
        (a, b) =>
          a.domain.localeCompare(b.domain) ||
          a.path.localeCompare(b.path) ||
          a.name.localeCompare(b.name)
      )
      setRows(list.map(toRow))
      setError(null)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root])

  /* ------------------------------ persistence ----------------------------- */

  async function persist(saved: CookieRecord | null, next: CookieRecord): Promise<void> {
    const clean = normalize(next)
    if (
      saved !== null &&
      (saved.domain !== clean.domain || saved.path !== clean.path || saved.name !== clean.name)
    ) {
      await fp().cookieDelete(root, saved.domain, saved.path, saved.name)
    }
    await fp().cookieSet(root, clean)
  }

  function saveRow(row: Row, nextC: CookieRecord): void {
    if (!canPersist(nextC)) return
    if (row.saved !== null && sameCookie(row.saved, nextC)) return
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, saved: normalize(nextC) } : r)))
    void persist(row.saved, nextC).catch((e) => setError(errMsg(e)))
  }

  /** Text-input edit: local only; persisted by commitRow on blur. */
  function patchRow(id: number, patch: Partial<CookieRecord>): void {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, c: { ...r.c, ...patch } } : r)))
  }

  function commitRow(id: number): void {
    const row = rows.find((r) => r.id === id)
    if (row !== undefined) saveRow(row, row.c)
  }

  /** Checkbox/select edit: applied and persisted immediately. */
  function patchAndCommit(id: number, patch: Partial<CookieRecord>): void {
    const row = rows.find((r) => r.id === id)
    if (row === undefined) return
    const nextC = { ...row.c, ...patch }
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, c: nextC } : r)))
    saveRow(row, nextC)
  }

  function commitExpires(id: number): void {
    const row = rows.find((r) => r.id === id)
    if (row === undefined) return
    const parsed = parseExpiresInput(row.expiresText)
    if (!parsed.ok) {
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, expiresInvalid: true } : r)))
      return
    }
    const nextC = { ...row.c, expires: parsed.value }
    setRows((prev) =>
      prev.map((r) =>
        r.id === id
          ? { ...r, c: nextC, expiresText: formatExpires(parsed.value), expiresInvalid: false }
          : r
      )
    )
    saveRow(row, nextC)
  }

  function addCookie(): void {
    const lastDomain = rows.length > 0 ? rows[rows.length - 1].c.domain : ''
    const c: CookieRecord = {
      name: '',
      value: '',
      domain: lastDomain,
      path: '/',
      expires: null,
      secure: false,
      httpOnly: false
    }
    setRows((prev) => [
      ...prev,
      { id: nextId(), saved: null, c, expiresText: '', expiresInvalid: false }
    ])
    // A fresh row must be visible regardless of the active filters.
    setSearch('')
    setOnlyIssues(false)
    setCollapsed((prev) => {
      if (!prev.has(c.domain)) return prev
      const next = new Set(prev)
      next.delete(c.domain)
      return next
    })
  }

  /* -------------------------------- deletion ------------------------------ */

  async function deleteRow(id: number): Promise<void> {
    const row = rows.find((r) => r.id === id)
    if (row === undefined) return
    try {
      if (row.saved !== null) {
        await fp().cookieDelete(root, row.saved.domain, row.saved.path, row.saved.name)
      }
      setRows((prev) => prev.filter((r) => r.id !== id))
    } catch (e) {
      setError(errMsg(e))
    }
  }

  async function clearScope(scope?: { domain?: string; sessionOnly?: boolean }): Promise<void> {
    try {
      await fp().cookieClear(root, scope)
      await load()
    } catch (e) {
      setError(errMsg(e))
    }
  }

  /* ---------------------------- context-menu ops --------------------------- */

  function transformValue(id: number, fn: (value: string) => string | null): void {
    const row = rows.find((r) => r.id === id)
    if (row === undefined) return
    const next = fn(row.c.value)
    if (next === null) {
      setError('Value could not be decoded')
      return
    }
    patchAndCommit(id, { value: next })
  }

  function copyText(text: string): void {
    void navigator.clipboard.writeText(text)
  }

  function openRaw(row: Row): void {
    setRawDraft(toSetCookie(row.c))
    setSub({ kind: 'raw', rowId: row.id })
  }

  async function saveRaw(row: Row, parsed: CookieRecord): Promise<void> {
    try {
      await persist(row.saved, parsed)
      setSub(null)
      await load()
    } catch (e) {
      setError(errMsg(e))
    }
  }

  /* -------------------------------- grouping ------------------------------ */

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase()
    const visible = rows.filter((r) => {
      if (
        q !== '' &&
        !r.c.name.toLowerCase().includes(q) &&
        !r.c.value.toLowerCase().includes(q) &&
        !r.c.domain.toLowerCase().includes(q)
      ) {
        return false
      }
      if (onlyIssues && validateCookie(r.c).length === 0 && !r.expiresInvalid) return false
      return true
    })
    const byDomain = new Map<string, Row[]>()
    for (const r of visible) {
      const key = r.c.domain.trim()
      const list = byDomain.get(key)
      if (list !== undefined) list.push(r)
      else byDomain.set(key, [r])
    }
    return [...byDomain.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [rows, search, onlyIssues])

  const jar = useMemo(
    () => rows.filter((r) => canPersist(r.c)).map((r) => normalize(r.c)),
    [rows]
  )

  const ctxTarget = ctx?.target ?? null
  const ctxRowId = ctxTarget !== null && ctxTarget.type === 'row' ? ctxTarget.rowId : null
  const ctxRow = ctxRowId !== null ? rows.find((r) => r.id === ctxRowId) : undefined
  const ctxDomain =
    ctxTarget === null
      ? null
      : ctxTarget.type === 'domain'
        ? ctxTarget.domain
        : (ctxRow?.c.domain ?? null)

  return (
    <div className="modal-overlay" onMouseDown={props.onClose}>
      <div className="modal modal-wide cookie-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">
          Cookies
          <div className="topbar-spacer" />
          <button className="btn btn-small" onClick={addCookie}>
            + Add cookie
          </button>
          <button className="btn btn-small" onClick={() => setSub({ kind: 'import' })}>
            Import…
          </button>
          <button
            className="btn btn-small"
            onClick={() => setSub({ kind: 'export' })}
            disabled={jar.length === 0}
          >
            Export…
          </button>
        </div>

        {error !== null && (
          <div className="banner banner-danger">
            {error}
            <button className="icon-btn" title="Dismiss" onClick={() => setError(null)}>
              ×
            </button>
          </div>
        )}

        <div className="cookie-toolbar">
          <input
            className="search-input"
            placeholder="Search name, value or domain…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <label className="opt-check">
            <input
              type="checkbox"
              checked={onlyIssues}
              onChange={(e) => setOnlyIssues(e.target.checked)}
            />
            Only show cookies with issues
          </label>
        </div>

        <div className="cookie-scroll">
          {loading && <div className="dim-note">Loading…</div>}
          {!loading && rows.length === 0 && (
            <div className="dim-note">
              The cookie jar is empty. Cookies are captured from Set-Cookie response headers, or
              add one manually.
            </div>
          )}
          {!loading && rows.length > 0 && groups.length === 0 && (
            <div className="dim-note">No cookies match the current filter.</div>
          )}
          {groups.length > 0 && (
            <table className="edit-table cookie-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Value</th>
                  <th>Domain</th>
                  <th>Path</th>
                  <th>Expires</th>
                  <th className="cell-check">Sec</th>
                  <th className="cell-check">HTTP</th>
                  <th>SameSite</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {groups.map(([domain, groupRows]) => {
                  const label = domain === '' ? '(no domain)' : domain
                  const isCollapsed = collapsed.has(domain)
                  return [
                    <tr
                      key={`domain:${domain}`}
                      className="cookie-domain-row"
                      onClick={() =>
                        setCollapsed((prev) => {
                          const next = new Set(prev)
                          if (next.has(domain)) next.delete(domain)
                          else next.add(domain)
                          return next
                        })
                      }
                      onContextMenu={(e) => {
                        e.preventDefault()
                        setCtx({ x: e.clientX, y: e.clientY, target: { type: 'domain', domain } })
                      }}
                    >
                      <td colSpan={9}>
                        <span className="tree-arrow">{isCollapsed ? '▸' : '▾'}</span>
                        <span className="cookie-domain-name mono">{label}</span>
                        <span className="cookie-domain-count">
                          {groupRows.length} cookie{groupRows.length === 1 ? '' : 's'}
                        </span>
                      </td>
                    </tr>,
                    ...(isCollapsed
                      ? []
                      : groupRows.map((row) => {
                          const issues = validateCookie(row.c)
                          const hasError = issues.some((i) => i.severity === 'error')
                          const hasWarning = issues.some((i) => i.severity === 'warning')
                          const expired = isExpired(row.c)
                          const title = issues.map((i) => i.message).join('\n')
                          const cls =
                            (hasError ? 'cookie-row-error' : hasWarning ? 'cookie-row-warn' : '') +
                            (expired ? ' cookie-row-expired' : '')
                          return (
                            <tr
                              key={row.id}
                              className={cls.trim()}
                              title={title === '' ? undefined : title}
                              onContextMenu={(e) => {
                                e.preventDefault()
                                setCtx({
                                  x: e.clientX,
                                  y: e.clientY,
                                  target: { type: 'row', rowId: row.id }
                                })
                              }}
                            >
                              <td>
                                <input
                                  className="cell-input mono"
                                  placeholder="name"
                                  value={row.c.name}
                                  onChange={(e) => patchRow(row.id, { name: e.target.value })}
                                  onBlur={() => commitRow(row.id)}
                                />
                              </td>
                              <td className="cookie-value-cell">
                                <input
                                  className="cell-input mono"
                                  placeholder="value"
                                  value={row.c.value}
                                  onChange={(e) => patchRow(row.id, { value: e.target.value })}
                                  onBlur={() => commitRow(row.id)}
                                />
                              </td>
                              <td>
                                <input
                                  className="cell-input mono"
                                  placeholder="domain"
                                  value={row.c.domain}
                                  onChange={(e) => patchRow(row.id, { domain: e.target.value })}
                                  onBlur={() => commitRow(row.id)}
                                />
                              </td>
                              <td>
                                <input
                                  className="cell-input mono cookie-path"
                                  placeholder="/"
                                  value={row.c.path}
                                  onChange={(e) => patchRow(row.id, { path: e.target.value })}
                                  onBlur={() => commitRow(row.id)}
                                />
                              </td>
                              <td>
                                <div className="cookie-expires">
                                  <input
                                    className={
                                      'cell-input mono' +
                                      (row.expiresInvalid ? ' cookie-input-bad' : '')
                                    }
                                    placeholder="Session"
                                    title="ISO date, or empty for a session cookie"
                                    value={row.expiresText}
                                    onChange={(e) =>
                                      setRows((prev) =>
                                        prev.map((r) =>
                                          r.id === row.id
                                            ? { ...r, expiresText: e.target.value }
                                            : r
                                        )
                                      )
                                    }
                                    onBlur={() => commitExpires(row.id)}
                                  />
                                  {expired && <span className="cookie-expired-tag">expired</span>}
                                </div>
                              </td>
                              <td className="cell-check">
                                <input
                                  type="checkbox"
                                  title="Secure"
                                  checked={row.c.secure}
                                  onChange={(e) =>
                                    patchAndCommit(row.id, { secure: e.target.checked })
                                  }
                                />
                              </td>
                              <td className="cell-check">
                                <input
                                  type="checkbox"
                                  title="HttpOnly"
                                  checked={row.c.httpOnly}
                                  onChange={(e) =>
                                    patchAndCommit(row.id, { httpOnly: e.target.checked })
                                  }
                                />
                              </td>
                              <td>
                                <select
                                  className="cookie-select"
                                  value={row.c.sameSite ?? ''}
                                  onChange={(e) =>
                                    patchAndCommit(row.id, {
                                      sameSite:
                                        e.target.value === ''
                                          ? undefined
                                          : (e.target.value as CookieRecord['sameSite'])
                                    })
                                  }
                                >
                                  <option value="" />
                                  {SAME_SITES.map((s) => (
                                    <option key={s} value={s}>
                                      {s}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td className="cell-check">
                                <button
                                  className="icon-btn"
                                  title="Delete cookie"
                                  onClick={() => void deleteRow(row.id)}
                                >
                                  ×
                                </button>
                              </td>
                            </tr>
                          )
                        }))
                  ]
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={props.onClose}>
            Close
          </button>
        </div>

        {ctx !== null && (
          <>
            <div
              className="ctx-menu-backdrop"
              onMouseDown={(e) => {
                e.stopPropagation()
                setCtx(null)
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                setCtx(null)
              }}
            />
            <div
              className="ctx-menu"
              style={{ top: ctx.y, left: ctx.x }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {ctxRow !== undefined &&
                (() => {
                  const row = ctxRow
                  const kinds = detectValueKind(row.c.value)
                  const item = (label: string, fn: () => void, danger = false): JSX.Element => (
                    <button
                      key={label}
                      className={'ctx-menu-item' + (danger ? ' ctx-menu-danger' : '')}
                      onClick={() => {
                        setCtx(null)
                        fn()
                      }}
                    >
                      {label}
                    </button>
                  )
                  return (
                    <>
                      {kinds.includes('base64') &&
                        item('Decode Base64 into value', () =>
                          transformValue(row.id, base64Decode)
                        )}
                      {item('Encode value as Base64', () =>
                        transformValue(row.id, base64Encode)
                      )}
                      {kinds.includes('url-encoded') &&
                        item('URL-decode value', () => transformValue(row.id, urlDecode))}
                      {item('URL-encode value', () => transformValue(row.id, urlEncode))}
                      {kinds.includes('jwt') &&
                        item('View JWT…', () => {
                          const jwt = jwtDecode(row.c.value)
                          if (jwt === null) return
                          setSub({
                            kind: 'view',
                            title: `JWT — ${row.c.name}`,
                            text: `Header:\n${jwt.header}\n\nPayload:\n${jwt.payload}`
                          })
                        })}
                      {kinds.includes('json') &&
                        item('Pretty-print JSON value…', () => {
                          const pretty = jsonPrettyPrint(row.c.value)
                          if (pretty === null) return
                          setSub({ kind: 'view', title: `JSON — ${row.c.name}`, text: pretty })
                        })}
                      <div className="ctx-menu-sep" />
                      {item('Copy value', () => copyText(row.c.value))}
                      {item('Copy as Set-Cookie', () => copyText(toSetCookie(normalize(row.c))))}
                      {item('Copy as Cookie header', () =>
                        copyText(toCookieHeader([normalize(row.c)]))
                      )}
                      <div className="ctx-menu-sep" />
                      {item('Edit raw…', () => openRaw(row))}
                      <div className="ctx-menu-sep" />
                      {item('Delete cookie', () => void deleteRow(row.id), true)}
                    </>
                  )
                })()}
              {ctxDomain !== null && ctxDomain !== '' && (
                <button
                  className="ctx-menu-item ctx-menu-danger"
                  onClick={() => {
                    const domain = ctxDomain
                    setCtx(null)
                    void clearScope({ domain })
                  }}
                >
                  Delete all for {ctxDomain}
                </button>
              )}
              <button
                className="ctx-menu-item ctx-menu-danger"
                onClick={() => {
                  setCtx(null)
                  void clearScope({ sessionOnly: true })
                }}
              >
                Delete all session cookies
              </button>
              <button
                className="ctx-menu-item ctx-menu-danger"
                onClick={() => {
                  setCtx(null)
                  void clearScope()
                }}
              >
                Delete all cookies
              </button>
            </div>
          </>
        )}

        {sub?.kind === 'view' && (
          <div className="modal-overlay" onMouseDown={(e) => {
            e.stopPropagation()
            setSub(null)
          }}>
            <div className="modal modal-wide" onMouseDown={(e) => e.stopPropagation()}>
              <div className="modal-title">{sub.title}</div>
              <textarea className="modal-textarea mono cookie-view-text" readOnly value={sub.text} />
              <div className="modal-actions">
                <button className="btn" onClick={() => copyText(sub.text)}>
                  Copy
                </button>
                <button className="btn" onClick={() => setSub(null)}>
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

        {sub?.kind === 'raw' &&
          (() => {
            const row = rows.find((r) => r.id === sub.rowId)
            if (row === undefined) return null
            const parsed = parseSetCookie(rawDraft, row.c.domain.trim())
            const issues = parsed === null ? [] : validateCookie(parsed)
            return (
              <div className="modal-overlay" onMouseDown={(e) => {
                e.stopPropagation()
                setSub(null)
              }}>
                <div className="modal modal-wide" onMouseDown={(e) => e.stopPropagation()}>
                  <div className="modal-title">Edit raw Set-Cookie</div>
                  <textarea
                    className="modal-textarea mono"
                    rows={4}
                    value={rawDraft}
                    autoFocus
                    onChange={(e) => setRawDraft(e.target.value)}
                  />
                  {parsed === null ? (
                    <div className="banner banner-danger">
                      Not a valid Set-Cookie line — expected name=value followed by attributes.
                    </div>
                  ) : (
                    <>
                      <div className="dim-note mono">
                        {parsed.name} @ {parsed.domain === '' ? '(no domain)' : parsed.domain}
                        {parsed.path} —{' '}
                        {parsed.expires === null
                          ? 'session'
                          : `expires ${formatExpires(parsed.expires)}`}
                      </div>
                      {issues.map((i, idx) => (
                        <div
                          key={idx}
                          className={
                            'dim-note ' + (i.severity === 'error' ? 'cookie-issue-error' : 'cookie-issue-warn')
                          }
                        >
                          {i.severity === 'error' ? 'Error' : 'Warning'}: {i.message}
                        </div>
                      ))}
                    </>
                  )}
                  <div className="modal-actions">
                    <button className="btn" onClick={() => setSub(null)}>
                      Cancel
                    </button>
                    <button
                      className="btn btn-accent"
                      disabled={parsed === null || !canPersist(parsed)}
                      onClick={() => {
                        if (parsed !== null) void saveRaw(row, parsed)
                      }}
                    >
                      Save
                    </button>
                  </div>
                </div>
              </div>
            )
          })()}

        {sub?.kind === 'export' && (
          <ExportModal cookies={jar} onClose={() => setSub(null)} />
        )}
        {sub?.kind === 'import' && (
          <ImportModal
            root={root}
            onDone={() => {
              setSub(null)
              void load()
            }}
            onClose={() => setSub(null)}
          />
        )}
      </div>
    </div>
  )
}

/* ------------------------------- export modal ------------------------------ */

const FORMAT_LABELS: { id: CookieFormat; label: string }[] = [
  { id: 'json', label: 'JSON' },
  { id: 'netscape', label: 'Netscape cookies.txt' },
  { id: 'header', label: 'Cookie header string' },
  { id: 'set-cookie', label: 'Set-Cookie lines' }
]

function ExportModal(props: { cookies: CookieRecord[]; onClose: () => void }): JSX.Element {
  const [format, setFormat] = useState<CookieFormat>('json')
  const text = useMemo(() => exportCookies(props.cookies, format), [props.cookies, format])

  function download(): void {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = exportFilename(format)
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => {
      e.stopPropagation()
      props.onClose()
    }}>
      <div className="modal modal-wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">Export cookies</div>
        <label className="modal-label">Format</label>
        <select
          className="cookie-select cookie-format-select"
          value={format}
          onChange={(e) => setFormat(e.target.value as CookieFormat)}
        >
          {FORMAT_LABELS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
        <textarea className="modal-textarea mono cookie-view-text" readOnly value={text} />
        <div className="modal-actions">
          <button className="btn" onClick={() => void navigator.clipboard.writeText(text)}>
            Copy
          </button>
          <button className="btn btn-accent" onClick={download}>
            Download {exportFilename(format)}
          </button>
          <button className="btn" onClick={props.onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------- import modal ------------------------------ */

function ImportModal(props: {
  root: string
  onDone: () => void
  onClose: () => void
}): JSX.Element {
  const [text, setText] = useState('')
  const [override, setOverride] = useState<'auto' | CookieFormat>('auto')
  const [domain, setDomain] = useState('')
  const [replace, setReplace] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const detected = useMemo(() => (text.trim() === '' ? null : detectFormat(text)), [text])
  const format = override === 'auto' ? detected : override
  const needsDomain = format === 'header' || format === 'set-cookie'
  const parsed = useMemo(
    () =>
      format === null || text.trim() === ''
        ? { cookies: [], errors: [] }
        : parseImportText(text, format, domain),
    [text, format, domain]
  )

  async function doImport(): Promise<void> {
    try {
      await fp().cookieSetMany(props.root, parsed.cookies, replace)
      props.onDone()
    } catch (e) {
      setError(errMsg(e))
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => {
      e.stopPropagation()
      props.onClose()
    }}>
      <div className="modal modal-wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">
          Import cookies
          {detected !== null && override === 'auto' && (
            <span className="cookie-fmt-badge mono">{detected}</span>
          )}
        </div>
        {error !== null && <div className="banner banner-danger">{error}</div>}
        <textarea
          className="modal-textarea mono"
          rows={8}
          autoFocus
          placeholder="Paste cookies as JSON, Netscape cookies.txt, a Cookie header or Set-Cookie lines…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="cookie-import-opts">
          <label className="modal-label">Format</label>
          <select
            className="cookie-select"
            value={override}
            onChange={(e) => setOverride(e.target.value as 'auto' | CookieFormat)}
          >
            <option value="auto">
              Auto-detect{detected !== null ? ` (${detected})` : ''}
            </option>
            {FORMAT_LABELS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
          {needsDomain && (
            <input
              className="modal-input cookie-import-domain"
              placeholder="Default domain (e.g. api.example.com)"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
            />
          )}
        </div>
        <div className="cookie-import-opts">
          <label className="opt-check">
            <input type="radio" checked={!replace} onChange={() => setReplace(false)} />
            Merge into the jar
          </label>
          <label className="opt-check">
            <input type="radio" checked={replace} onChange={() => setReplace(true)} />
            Replace the jar
          </label>
        </div>
        {text.trim() !== '' && (
          <div className="dim-note">
            Will import {parsed.cookies.length} cookie{parsed.cookies.length === 1 ? '' : 's'}
            {replace ? ', replacing everything currently stored.' : '.'}
          </div>
        )}
        {parsed.errors.map((msg, i) => (
          <div key={i} className="dim-note cookie-issue-error">
            {msg}
          </div>
        ))}
        <div className="modal-actions">
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button
            className="btn btn-accent"
            disabled={parsed.cookies.length === 0}
            onClick={() => void doImport()}
          >
            Import
          </button>
        </div>
      </div>
    </div>
  )
}
