import { useState } from 'react'
import type { ExecutionReport, ScriptOutcome } from '../../../shared/model'
import { fmtBytes, fmtMs, tryPrettyJson } from '../util'

interface Props {
  report: ExecutionReport | null
  sending: boolean
  below: boolean
  onToggleLayout: () => void
  onClose: () => void
}

type Section = 'body' | 'headers' | 'tests'

export default function ResponsePanel(props: Props): JSX.Element {
  const [section, setSection] = useState<Section>('body')
  const { report } = props
  const resp = report?.response

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
          </>
        )}
        <div className="topbar-spacer" />
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
            {(['body', 'headers', 'tests'] as Section[]).map((s) => (
              <button
                key={s}
                className={'section-tab' + (section === s ? ' section-tab-active' : '')}
                onClick={() => setSection(s)}
              >
                {s === 'body' ? 'Body' : s === 'headers' ? 'Headers' : 'Tests'}
              </button>
            ))}
          </div>

          <div className="resp-content">
            {section === 'body' && (
              <pre className="resp-body mono">
                {resp !== undefined
                  ? (tryPrettyJson(resp.bodyText) ?? resp.bodyText)
                  : 'No response.'}
              </pre>
            )}
            {section === 'headers' &&
              (resp !== undefined ? (
                <table className="kv-table">
                  <tbody>
                    {resp.headers.map((h, i) => (
                      <tr key={`${h.name}-${i}`}>
                        <td className="mono kv-name">{h.name}</td>
                        <td className="mono">{h.value}</td>
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
          </div>
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
