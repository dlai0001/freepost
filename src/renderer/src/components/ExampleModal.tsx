import type { JSX } from 'react'
import { useState } from 'react'
import type { SavedExample } from '../../../shared/model'
import { fmtBytes, fmtMs, tryPrettyJson } from '../util'

interface Props {
  example: SavedExample
  onCancel: () => void
}

type Section = 'body' | 'headers' | 'request'

/** Read-only viewer for a saved response example (response + originating request). */
export default function ExampleModal(props: Props): JSX.Element {
  const [section, setSection] = useState<Section>('body')
  const { response, request } = props.example
  const statusCls =
    response.status >= 200 && response.status < 300
      ? 'status-ok'
      : response.status >= 400
        ? 'status-err'
        : 'status-other'

  return (
    <div className="modal-overlay" onMouseDown={props.onCancel}>
      <div className="modal modal-wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">
          Example: {props.example.name}
          <div className="topbar-spacer" />
          <span className={'status-pill ' + statusCls}>
            {response.status} {response.statusText}
          </span>
          <span className="resp-meta">{fmtMs(response.timeMs)}</span>
          <span className="resp-meta">{fmtBytes(response.sizeBytes)}</span>
        </div>

        <div className="section-tabs">
          {(['body', 'headers', 'request'] as Section[]).map((s) => (
            <button
              key={s}
              className={'section-tab' + (section === s ? ' section-tab-active' : '')}
              onClick={() => setSection(s)}
            >
              {s === 'body' ? 'Body' : s === 'headers' ? 'Headers' : 'Request'}
            </button>
          ))}
        </div>

        <div className="example-content">
          {section === 'body' && (
            <pre className="resp-body mono">
              {tryPrettyJson(response.bodyText) ?? response.bodyText}
            </pre>
          )}
          {section === 'headers' && (
            <table className="kv-table">
              <tbody>
                {response.headers.map((h, i) => (
                  <tr key={`${h.name}-${i}`}>
                    <td className="mono kv-name">{h.name}</td>
                    <td className="mono">{h.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {section === 'request' && (
            <div>
              <div className="mono example-req-line">
                {request.method} {request.url}
              </div>
              <table className="kv-table">
                <tbody>
                  {request.headers.map((h, i) => (
                    <tr key={`${h.name}-${i}`}>
                      <td className="mono kv-name">{h.name}</td>
                      <td className="mono">{h.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {request.body !== undefined && request.body !== '' && (
                <pre className="resp-body mono">
                  {tryPrettyJson(request.body) ?? request.body}
                </pre>
              )}
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={props.onCancel}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
