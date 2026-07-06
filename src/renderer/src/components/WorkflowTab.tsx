import { useEffect, useRef, useState } from 'react'
import type {
  StepStatus,
  WorkflowRunReport,
  WorkflowValidationIssue
} from '../../../shared/model'
import { errMsg, fp } from '../api'
import { joinPath, nextId } from '../util'

interface StepRow {
  id: number
  request: string
  expectError: boolean
}

interface Props {
  root: string
  relPath: string
  envPath: string | null
  onDirty: (dirty: boolean) => void
}

const STATUS_ICON: Record<StepStatus, { icon: string; cls: string; label: string }> = {
  passed: { icon: '✓', cls: 'st-pass', label: 'passed' },
  'expected-error': { icon: '⚠', cls: 'st-warn', label: 'errored as expected' },
  'unexpected-success': { icon: '⚠', cls: 'st-warn', label: 'expected an error but succeeded' },
  failed: { icon: '✗', cls: 'st-fail', label: 'failed' },
  skipped: { icon: '○', cls: 'st-skip', label: 'skipped' }
}

export default function WorkflowTab(props: Props): JSX.Element {
  const absPath = joinPath(props.root, props.relPath)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [description, setDescription] = useState('')
  const [steps, setSteps] = useState<StepRow[]>([])
  const [newStepPath, setNewStepPath] = useState('')
  const [issues, setIssues] = useState<WorkflowValidationIssue[]>([])
  const [running, setRunning] = useState(false)
  const [statuses, setStatuses] = useState<(StepStatus | null)[]>([])
  const [summary, setSummary] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [dataFile, setDataFile] = useState('')
  const [dataWarning, setDataWarning] = useState<string | null>(null)
  const [iterations, setIterations] = useState<string[] | null>(null)

  const dirtyRef = useRef(false)
  const runningRef = useRef(false)
  const progressIdxRef = useRef(0)
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

  async function validate(): Promise<WorkflowValidationIssue[]> {
    try {
      const found = await fp().validateWorkflow({ root: props.root, path: props.relPath })
      setIssues(found)
      return found
    } catch (e) {
      setError(errMsg(e))
      return []
    }
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const wf = await fp().readWorkflow(absPath)
        if (cancelled) return
        setDescription(wf.description ?? '')
        setDataFile(wf.dataFile ?? '')
        setSteps(
          wf.steps.map((s) => ({
            id: nextId(),
            request: s.request,
            expectError: s.expectError === true
          }))
        )
        await validate()
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

  // Live per-step progress. Steps run strictly sequentially, so the n-th
  // progress event maps to the n-th step.
  useEffect(() => {
    return fp().onWorkflowProgress((result) => {
      if (!runningRef.current) return
      const i = progressIdxRef.current++
      setStatuses((prev) => {
        const next = [...prev]
        if (i < next.length) next[i] = result.status
        return next
      })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function save(): Promise<void> {
    setError(null)
    setSaving(true)
    try {
      await fp().writeWorkflow(absPath, {
        description: description.trim() === '' ? undefined : description.trim(),
        dataFile: dataFile.trim() === '' ? undefined : dataFile.trim(),
        steps: steps
          .filter((s) => s.request.trim() !== '')
          .map((s) =>
            s.expectError
              ? { request: s.request.trim(), expectError: true }
              : { request: s.request.trim() }
          )
      })
      clean()
      await validate()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setSaving(false)
    }
  }

  function summarize(report: WorkflowRunReport): string {
    const counts = new Map<StepStatus, number>()
    for (const s of report.steps) counts.set(s.status, (counts.get(s.status) ?? 0) + 1)
    const parts: string[] = []
    for (const key of [
      'passed',
      'expected-error',
      'unexpected-success',
      'failed',
      'skipped'
    ] as StepStatus[]) {
      const n = counts.get(key) ?? 0
      if (n > 0) parts.push(`${n} ${key}`)
    }
    if (parts.length === 0) parts.push('no steps')
    return parts.join(' · ') + (report.halted ? ' · halted' : '')
  }

  async function browseData(): Promise<void> {
    setDataWarning(null)
    try {
      const chosen = await fp().browseDataFile()
      if (chosen === null) return
      // The main process expects a collection-relative path.
      const norm = props.root.replace(/[/\\]$/, '')
      if (chosen.startsWith(norm + '/') || chosen.startsWith(norm + '\\')) {
        setDataFile(chosen.slice(norm.length + 1))
      } else {
        setDataFile(chosen)
        setDataWarning('Data files should live inside the collection; this path is outside it.')
      }
      touch()
    } catch (e) {
      setError(errMsg(e))
    }
  }

  function iterationSummary(report: WorkflowRunReport, i: number): string {
    let passed = 0
    let failed = 0
    for (const s of report.steps) {
      if (s.status === 'passed' || s.status === 'expected-error') passed++
      else if (s.status === 'failed' || s.status === 'unexpected-success') failed++
    }
    return `iteration ${i + 1}: ${passed} passed / ${failed} failed${report.halted ? ' · halted' : ''}`
  }

  async function run(): Promise<void> {
    setError(null)
    setSummary(null)
    setIterations(null)
    const found = await validate()
    if (found.length > 0) return
    runningRef.current = true
    progressIdxRef.current = 0
    setStatuses(Array<StepStatus | null>(steps.length).fill(null))
    setRunning(true)
    try {
      const report = await fp().runWorkflow({
        root: props.root,
        path: props.relPath,
        envPath: props.envPath ?? undefined
      })
      setStatuses(report.steps.map((s) => s.status))
      setSummary(summarize(report))
      if (report.iterations !== undefined && report.iterations.length > 0) {
        setIterations(report.iterations.map((it, i) => iterationSummary(it, i)))
      }
    } catch (e) {
      setError(errMsg(e))
    } finally {
      runningRef.current = false
      setRunning(false)
    }
  }

  if (loading) return <div className="tab-loading">Loading…</div>

  const issueByIndex = new Map(issues.map((i) => [i.stepIndex, i]))
  const firstPending = statuses.findIndex((s) => s === null)

  return (
    <div className="workflow-tab">
      {error !== null && (
        <div className="banner banner-danger">
          {error}
          <button className="icon-btn" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}

      {issues.length > 0 && (
        <div className="banner banner-danger">
          <strong>Broken step references — fix before running:</strong>
          <ul>
            {issues.map((issue) => (
              <li key={issue.stepIndex}>
                step {issue.stepIndex + 1}: <span className="mono">{issue.request}</span>{' '}
                {issue.reason === 'missing' ? 'file not found' : 'is not a request file'}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="wf-toolbar">
        <button
          className="btn btn-accent"
          onClick={() => void run()}
          disabled={running || issues.length > 0 || steps.length === 0}
          title={issues.length > 0 ? 'Resolve broken references first' : 'Run workflow'}
        >
          {running ? 'Running…' : '▶ Run'}
        </button>
        <button className="btn" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {summary !== null && <span className="wf-summary">{summary}</span>}
      </div>

      <label className="field-label">Description</label>
      <input
        className="cell-input"
        value={description}
        onChange={(e) => {
          setDescription(e.target.value)
          touch()
        }}
      />

      <label className="field-label">Data file (collection-relative CSV/JSON — one run per row)</label>
      <div className="wf-datafile">
        <input
          className="cell-input mono"
          value={dataFile}
          placeholder="data/users.csv"
          onChange={(e) => {
            setDataFile(e.target.value)
            setDataWarning(null)
            touch()
          }}
        />
        <button className="btn btn-small" onClick={() => void browseData()}>
          Browse…
        </button>
        <button
          className="btn btn-small"
          disabled={dataFile === ''}
          onClick={() => {
            setDataFile('')
            setDataWarning(null)
            touch()
          }}
        >
          Clear
        </button>
      </div>
      {dataWarning !== null && <div className="banner banner-warn">{dataWarning}</div>}

      {iterations !== null && (
        <div className="wf-iterations">
          <div className="wf-iterations-title">Data-driven iterations</div>
          {iterations.map((line, i) => (
            <div key={i} className="wf-iteration mono">
              {line}
            </div>
          ))}
        </div>
      )}

      <label className="field-label">Steps (collection-relative request paths, run in order)</label>
      <div className="wf-steps">
        {steps.length === 0 && <div className="dim-note">No steps yet — add one below.</div>}
        {steps.map((step, idx) => {
          const issue = issueByIndex.get(idx)
          const status = statuses[idx] ?? null
          const isCurrent = running && status === null && idx === firstPending
          return (
            <div key={step.id} className={'wf-step' + (issue !== undefined ? ' wf-step-broken' : '')}>
              <span className="wf-step-index">{idx + 1}</span>
              <span className="wf-step-status">
                {isCurrent ? (
                  <span className="spin" title="Running" />
                ) : status !== null ? (
                  <span className={STATUS_ICON[status].cls} title={STATUS_ICON[status].label}>
                    {STATUS_ICON[status].icon}
                  </span>
                ) : null}
              </span>
              <input
                className="cell-input mono"
                value={step.request}
                placeholder="folder/Request name.curl"
                onChange={(e) => {
                  setSteps((rows) =>
                    rows.map((r) => (r.id === step.id ? { ...r, request: e.target.value } : r))
                  )
                  touch()
                }}
              />
              <label className="wf-expect" title="This step is supposed to error">
                <input
                  type="checkbox"
                  checked={step.expectError}
                  onChange={(e) => {
                    setSteps((rows) =>
                      rows.map((r) =>
                        r.id === step.id ? { ...r, expectError: e.target.checked } : r
                      )
                    )
                    touch()
                  }}
                />
                expect error
              </label>
              <button
                className="icon-btn"
                title="Remove step"
                onClick={() => {
                  setSteps((rows) => rows.filter((r) => r.id !== step.id))
                  touch()
                }}
              >
                ×
              </button>
            </div>
          )
        })}
      </div>

      <div className="wf-addstep">
        <input
          className="cell-input mono"
          value={newStepPath}
          placeholder="Add step: path/to/Request.curl"
          onChange={(e) => setNewStepPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && newStepPath.trim() !== '') {
              setSteps((rows) => [
                ...rows,
                { id: nextId(), request: newStepPath.trim(), expectError: false }
              ])
              setNewStepPath('')
              touch()
            }
          }}
        />
        <button
          className="btn btn-small"
          disabled={newStepPath.trim() === ''}
          onClick={() => {
            setSteps((rows) => [
              ...rows,
              { id: nextId(), request: newStepPath.trim(), expectError: false }
            ])
            setNewStepPath('')
            touch()
          }}
        >
          + Add step
        </button>
      </div>
    </div>
  )
}
