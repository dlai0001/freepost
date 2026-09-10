import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import type {
  ExecutionReport,
  ScriptOutcome,
  SpecResponseKey,
  SpecValidationError,
  SpecValidationReport
} from '../../../shared/model'
import { errMsg, fp } from '../api'
import { fmtBytes, fmtMs, tryPrettyJson } from '../util'
import CodeEditor from './CodeEditor'
import PromptModal from './PromptModal'
import { jumpToError, specSquiggles } from './specSquiggles'

interface Props {
  report: ExecutionReport | null
  sending: boolean
  below: boolean
  /** Collection root + request path, for saving the response as an example. */
  root: string
  relPath: string
  /** Whether the request links an OpenAPI operation (drives the "no spec" hint). */
  hasSpec?: boolean
  onToggleLayout: () => void
  onClose: () => void
}

type Section = 'body' | 'headers' | 'tests' | 'schema'

function responseKeyLabel(k: SpecResponseKey | undefined): string {
  if (k === undefined) return ''
  return k.mediaType === undefined ? k.status : `${k.status} ${k.mediaType}`
}

/** Short verdict for the header pill and the Schema tab badge. */
function verdictSummary(v: SpecValidationReport): { cls: string; short: string; long: string } {
  switch (v.verdict) {
    case 'match':
      return { cls: 'status-ok', short: '✓', long: `✓ matches ${responseKeyLabel(v.matchedResponse)}`.trimEnd() }
    case 'mismatch': {
      const n = v.errors.length
      return { cls: 'status-err', short: `✗ ${n}`, long: `✗ ${n} mismatch${n === 1 ? '' : 'es'} vs ${responseKeyLabel(v.matchedResponse)}` }
    }
    case 'undocumented-status':
      return {
        cls: 'status-other',
        short: '⚠',
        long: `⚠ status undocumented${v.closestMatch !== undefined ? ` · closest ${responseKeyLabel(v.closestMatch.response)}` : ''}`
      }
    case 'skipped':
      return { cls: 'status-other', short: '–', long: `– spec skipped` }
    case 'error':
      return { cls: 'status-err', short: '!', long: `! spec error` }
  }
}

export default function ResponsePanel(props: Props): JSX.Element {
  const [section, setSection] = useState<Section>('body')
  const [saving, setSaving] = useState(false)
  const [savePrompt, setSavePrompt] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const { report } = props
  const resp = report?.response
  const validation = report?.specValidation
  const bodyView = useRef<EditorView | null>(null)
  const pendingJump = useRef<SpecValidationError | null>(null)

  const pretty = useMemo(() => (resp === undefined ? null : tryPrettyJson(resp.bodyText)), [resp])
  const bodyText = resp === undefined ? '' : (pretty ?? resp.bodyText)
  const isJson = pretty !== null

  // Errors that live in the body (headers are listed, never underlined).
  const bodyErrors = useMemo(() => (validation?.errors ?? []).filter((e) => e.target === 'body'), [validation])
  const headerErrors = useMemo(() => (validation?.errors ?? []).filter((e) => e.target === 'header'), [validation])
  const squiggles = useMemo<Extension[]>(
    () => (isJson && bodyErrors.length > 0 ? [specSquiggles(bodyErrors)] : []),
    [isJson, bodyErrors]
  )

  // Clicking an error in the Schema tab switches to Body then jumps once the
  // editor is mounted (it mounts on the next render).
  useEffect(() => {
    if (section === 'body' && pendingJump.current !== null && bodyView.current !== null) {
      jumpToError(bodyView.current, pendingJump.current)
      pendingJump.current = null
    }
  }, [section])

  function showError(err: SpecValidationError): void {
    if (err.target !== 'body') return
    pendingJump.current = err
    if (section === 'body' && bodyView.current !== null) {
      jumpToError(bodyView.current, err)
      pendingJump.current = null
    } else {
      setSection('body')
    }
  }

  async function saveExample(name: string): Promise<void> {
    setSavePrompt(false)
    setSaving(true)
    setSaveMsg(null)
    try {
      await fp().saveExample({ root: props.root, path: props.relPath, name })
      setSaveMsg(`Saved example “${name}”.`)
    } catch (e) {
      setSaveMsg(errMsg(e))
    } finally {
      setSaving(false)
    }
  }

  const summary = validation !== undefined ? verdictSummary(validation) : null
  const sections: { id: Section; label: string }[] = [
    { id: 'body', label: 'Body' },
    { id: 'headers', label: 'Headers' },
    { id: 'tests', label: 'Tests' },
    { id: 'schema', label: 'Schema' }
  ]

  return (
    <div className="resp-panel">
      <div className="resp-head">
        <span className="resp-title">Response</span>
        {resp !== undefined && (
          <>
            <span
              className={
                'status-pill ' +
                (resp.status >= 200 && resp.status < 300
                  ? 'status-ok'
                  : resp.status >= 400
                    ? 'status-err'
                    : 'status-other')
              }
            >
              {resp.status} {resp.statusText}
            </span>
            <span className="resp-meta">{fmtMs(resp.timeMs)}</span>
            <span className="resp-meta">{fmtBytes(resp.sizeBytes)}</span>
            {summary !== null && (
              <button
                className={'status-pill spec-pill ' + summary.cls}
                title="OpenAPI schema check — open the Schema tab"
                onClick={() => setSection('schema')}
              >
                {summary.long}
              </button>
            )}
          </>
        )}
        <div className="topbar-spacer" />
        {resp !== undefined && (
          <button
            className="btn btn-small"
            title="Snapshot this response as a saved example"
            disabled={saving}
            onClick={() => setSavePrompt(true)}
          >
            {saving ? 'Saving…' : 'Save as example'}
          </button>
        )}
        <button
          className="icon-btn"
          title={props.below ? 'Move response to the right' : 'Move response below'}
          onClick={props.onToggleLayout}
        >
          ⇄
        </button>
        <button className="icon-btn" title="Close response panel" onClick={props.onClose}>
          ×
        </button>
      </div>

      {saveMsg !== null && (
        <div className="banner banner-warn">
          {saveMsg}
          <button className="icon-btn" onClick={() => setSaveMsg(null)}>
            ×
          </button>
        </div>
      )}

      {savePrompt && (
        <PromptModal
          title="Save as example"
          label="Example name"
          placeholder="200 OK — happy path"
          submitText="Save"
          onSubmit={(name) => void saveExample(name)}
          onCancel={() => setSavePrompt(false)}
        />
      )}

      {props.sending && <div className="resp-sending">Sending…</div>}

      {report !== null && !props.sending && (
        <>
          {report.unresolved !== undefined && report.unresolved.length > 0 && (
            <div className="banner banner-warn">
              Unresolved variables: {report.unresolved.join(', ')}
            </div>
          )}
          {report.transportError !== undefined && (
            <div className="banner banner-danger">Transport error: {report.transportError}</div>
          )}

          <div className="section-tabs">
            {sections.map((s) => (
              <button
                key={s.id}
                className={'section-tab' + (section === s.id ? ' section-tab-active' : '')}
                onClick={() => setSection(s.id)}
              >
                {s.label}
                {s.id === 'schema' && summary !== null && (
                  <span className={'spec-tab-badge ' + summary.cls}>{summary.short}</span>
                )}
              </button>
            ))}
          </div>

          <div className={'resp-content' + (section === 'body' ? ' resp-content-fill' : '')}>
            {section === 'body' &&
              (resp !== undefined ? (
                <div className="resp-body-editor">
                  <CodeEditor
                    value={bodyText}
                    onChange={() => undefined}
                    language={isJson ? 'json' : 'text'}
                    readOnly
                    fill
                    extraExtensions={squiggles}
                    onViewReady={(v) => {
                      bodyView.current = v
                    }}
                  />
                </div>
              ) : (
                <div className="dim-note">No response.</div>
              ))}
            {section === 'headers' &&
              (resp !== undefined ? (
                <table className="kv-table">
                  <tbody>
                    {resp.headers.map((h, i) => {
                      const errs = headerErrors.filter((e) => e.instancePath === h.name.toLowerCase())
                      return (
                        <tr key={`${h.name}-${i}`} className={errs.length > 0 ? 'kv-row-error' : undefined}>
                          <td className="mono kv-name">{h.name}</td>
                          <td className="mono">
                            {h.value}
                            {errs.map((e, j) => (
                              <div key={j} className="kv-error">
                                ✗ {e.message}
                              </div>
                            ))}
                          </td>
                        </tr>
                      )
                    })}
                    {headerErrors
                      .filter((e) => e.keyword === 'required')
                      .map((e, i) => (
                        <tr key={`missing-${i}`} className="kv-row-error">
                          <td className="mono kv-name">{e.instancePath}</td>
                          <td className="mono">
                            <div className="kv-error">✗ {e.message}</div>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              ) : (
                <div className="dim-note">No response.</div>
              ))}
            {section === 'tests' && (
              <div className="tests-view">
                <ScriptOutcomeView title="Pre-request script" outcome={report.preScript} />
                <ScriptOutcomeView title="Test script" outcome={report.testScript} />
                {report.preScript === undefined && report.testScript === undefined && (
                  <div className="dim-note">No scripts ran for this request.</div>
                )}
              </div>
            )}
            {section === 'schema' && (
              <SchemaView validation={validation} hasSpec={props.hasSpec === true} hasResponse={resp !== undefined} onShowError={showError} />
            )}
          </div>
        </>
      )}
    </div>
  )
}

function errorLabel(e: SpecValidationError): string {
  if (e.target === 'header') return `header ${e.instancePath}`
  return e.instancePath === '' ? '/' : e.instancePath
}

function ErrorList({ errors, onShow }: { errors: SpecValidationError[]; onShow?: (e: SpecValidationError) => void }): JSX.Element {
  return (
    <div className="spec-errors">
      {errors.map((e, i) => {
        const clickable = onShow !== undefined && e.target === 'body'
        return (
          <div
            key={i}
            className={'spec-error-row' + (clickable ? ' spec-error-clickable' : '')}
            onClick={clickable ? () => onShow(e) : undefined}
            title={clickable ? 'Show in body' : undefined}
          >
            <span className="test-fail">✗</span>
            <span className="mono spec-error-path">{errorLabel(e)}</span>
            <span className="spec-error-msg">{e.message}</span>
            <span className="spec-error-kw">{e.keyword}</span>
          </div>
        )
      })}
    </div>
  )
}

function SchemaView({
  validation,
  hasSpec,
  hasResponse,
  onShowError
}: {
  validation: SpecValidationReport | undefined
  hasSpec: boolean
  hasResponse: boolean
  onShowError: (e: SpecValidationError) => void
}): JSX.Element {
  if (validation === undefined) {
    return (
      <div className="dim-note">
        {!hasSpec
          ? '⚠ No OpenAPI spec attached — use the Spec button above the request to link one.'
          : !hasResponse
            ? 'No response to validate.'
            : 'This response was not validated. Send the request again.'}
      </div>
    )
  }
  const summary = verdictSummary(validation)
  return (
    <div className="spec-view">
      <div className={'spec-verdict ' + summary.cls}>{summary.long}</div>
      <div className="spec-meta">
        <span className="mono">{validation.spec.operationId}</span>
        <span className="resp-meta">
          {validation.spec.path}
          {validation.specVersion !== undefined ? ` · ${validation.specVersion}` : ''}
        </span>
      </div>
      {validation.reason !== undefined && <div className="dim-note">{validation.reason}</div>}
      {validation.documentedStatuses !== undefined && validation.documentedStatuses.length > 0 && (
        <div className="dim-note">Documented responses: {validation.documentedStatuses.join(', ')}</div>
      )}
      {validation.errors.length > 0 && (
        <>
          <div className="script-outcome-title">
            {validation.errors.length} problem{validation.errors.length === 1 ? '' : 's'}
            {validation.matchedResponse !== undefined ? ` against ${responseKeyLabel(validation.matchedResponse)}` : ''}
          </div>
          <ErrorList errors={validation.errors} onShow={onShowError} />
        </>
      )}
      {validation.closestMatch !== undefined && (
        <>
          <div className="script-outcome-title">
            Closest documented response: {responseKeyLabel(validation.closestMatch.response)}
            {validation.closestMatch.errors.length === 0
              ? ' (matches exactly)'
              : ` (${validation.closestMatch.errors.length} problem${validation.closestMatch.errors.length === 1 ? '' : 's'})`}
          </div>
          {validation.closestMatch.errors.length > 0 && <ErrorList errors={validation.closestMatch.errors} />}
        </>
      )}
    </div>
  )
}

function ScriptOutcomeView({
  title,
  outcome
}: {
  title: string
  outcome: ScriptOutcome | undefined
}): JSX.Element | null {
  if (outcome === undefined) return null
  return (
    <div className="script-outcome">
      <div className="script-outcome-title">{title}</div>
      {outcome.error !== undefined && (
        <div className="banner banner-danger">Script error: {outcome.error}</div>
      )}
      {outcome.tests.map((t, i) => (
        <div key={i} className="test-line">
          <span className={t.passed ? 'test-pass' : 'test-fail'}>{t.passed ? '✓' : '✗'}</span>
          <span>{t.name}</span>
          {t.error !== undefined && <span className="test-error">{t.error}</span>}
        </div>
      ))}
      {outcome.consoleLines.length > 0 && (
        <pre className="console-lines mono">{outcome.consoleLines.join('\n')}</pre>
      )}
      {outcome.tests.length === 0 && outcome.consoleLines.length === 0 && outcome.error === undefined && (
        <div className="dim-note">No assertions or console output.</div>
      )}
    </div>
  )
}
