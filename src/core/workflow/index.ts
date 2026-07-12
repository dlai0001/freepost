/**
 * Workflow files (PLAN.md "Workflows"): parse/serialize `*.workflow.json`,
 * validate step references, auto-heal references on in-app rename/move, and
 * run steps strictly sequentially.
 *
 * Pure module — no fs, no network. The runner receives an injected `execute`.
 */

import type {
  ExecutionReport,
  TestResult,
  WorkflowFile,
  WorkflowRunReport,
  WorkflowStep,
  WorkflowStepResult,
  WorkflowValidationIssue
} from '@shared/model'

/* --------------------------------- parse --------------------------------- */

export type ParseWorkflowResult =
  | { ok: true; wf: WorkflowFile }
  | { ok: false; error: string }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Parse and schema-validate a workflow JSON document.
 *
 * Accepted shape: `{ description?: string, steps: { request: string,
 * expectError?: boolean }[] }`. Unknown root/step keys are rejected so typos
 * (`"reqeust"`) surface instead of silently producing broken steps.
 */
export function parseWorkflow(json: string): ParseWorkflowResult {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` }
  }

  if (!isPlainObject(data)) {
    return { ok: false, error: 'workflow root must be a JSON object' }
  }
  if (data.description !== undefined && typeof data.description !== 'string') {
    return { ok: false, error: '"description" must be a string' }
  }
  if (data.dataFile !== undefined && typeof data.dataFile !== 'string') {
    return { ok: false, error: '"dataFile" must be a string' }
  }
  if (!('steps' in data)) {
    return { ok: false, error: 'missing required "steps" array' }
  }
  if (!Array.isArray(data.steps)) {
    return { ok: false, error: '"steps" must be an array' }
  }
  for (const key of Object.keys(data)) {
    if (key !== 'description' && key !== 'steps' && key !== 'dataFile') {
      return { ok: false, error: `unknown key "${key}" at workflow root` }
    }
  }

  const steps: WorkflowStep[] = []
  for (let i = 0; i < data.steps.length; i++) {
    const raw = data.steps[i] as unknown
    if (!isPlainObject(raw)) {
      return { ok: false, error: `steps[${i}] must be an object` }
    }
    if (typeof raw.request !== 'string' || raw.request.length === 0) {
      return { ok: false, error: `steps[${i}].request must be a non-empty string` }
    }
    if (raw.expectError !== undefined && typeof raw.expectError !== 'boolean') {
      return { ok: false, error: `steps[${i}].expectError must be a boolean` }
    }
    for (const key of Object.keys(raw)) {
      if (key !== 'request' && key !== 'expectError') {
        return { ok: false, error: `unknown key "${key}" in steps[${i}]` }
      }
    }
    const step: WorkflowStep = { request: raw.request }
    if (raw.expectError !== undefined) step.expectError = raw.expectError
    steps.push(step)
  }

  const wf: WorkflowFile = { steps }
  if (typeof data.description === 'string') wf.description = data.description
  if (typeof data.dataFile === 'string') wf.dataFile = data.dataFile
  return { ok: true, wf }
}

/* ------------------------------- serialize ------------------------------- */

/** Stable pretty JSON: description, then dataFile (when present), then steps; 2-space indent. */
export function serializeWorkflow(wf: WorkflowFile): string {
  const out: Record<string, unknown> = {}
  if (wf.description !== undefined) out.description = wf.description
  if (wf.dataFile !== undefined) out.dataFile = wf.dataFile
  out.steps = wf.steps.map((s) => {
    const step: Record<string, unknown> = { request: s.request }
    if (s.expectError !== undefined) step.expectError = s.expectError
    return step
  })
  return JSON.stringify(out, null, 2) + '\n'
}

/* ------------------------------- validation ------------------------------ */

/**
 * Resolve every step reference via the injected lookup; returns one issue per
 * broken step ('missing' or 'not-a-request'). Empty array = runnable.
 */
export function validateReferences(
  wf: WorkflowFile,
  requestExists: (relPath: string) => 'request' | 'missing' | 'not-a-request'
): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = []
  wf.steps.forEach((step, stepIndex) => {
    const outcome = requestExists(step.request)
    if (outcome !== 'request') {
      issues.push({ stepIndex, request: step.request, reason: outcome })
    }
  })
  return issues
}

/* --------------------------------- healing ------------------------------- */

/**
 * Rewrite step references after an in-app rename/move: every step pointing at
 * `oldPath` now points at `newPath`. Returns a new WorkflowFile (input is not
 * mutated) and whether anything changed.
 */
export function healReferences(
  wf: WorkflowFile,
  oldPath: string,
  newPath: string
): { wf: WorkflowFile; changed: boolean } {
  let changed = false
  const steps = wf.steps.map((step) => {
    if (step.request !== oldPath) return step
    changed = true
    return { ...step, request: newPath }
  })
  if (!changed) return { wf, changed: false }
  const healed: WorkflowFile = { steps }
  if (wf.description !== undefined) healed.description = wf.description
  if (wf.dataFile !== undefined) healed.dataFile = wf.dataFile
  return { wf: healed, changed: true }
}

/* --------------------------------- running ------------------------------- */

export interface RunWorkflowArgs {
  /** Collection-relative path of the workflow file (recorded in the report). */
  workflowPath: string
  wf: WorkflowFile
  /** Executes one request fully (resolve -> pre -> send -> test). */
  execute: (relPath: string) => Promise<ExecutionReport>
  /** Called after each step's result is finalized (including skipped steps). */
  onProgress?: (r: WorkflowStepResult) => void
  /** Injectable clock; defaults to `new Date().toISOString()`. */
  now?: () => string
}

function collectTests(report: ExecutionReport): TestResult[] {
  return [...(report.preScript?.tests ?? []), ...(report.testScript?.tests ?? [])]
}

/** Best human-readable cause for an errored report. */
function deriveErrorMessage(report: ExecutionReport): string | undefined {
  if (report.transportError) return report.transportError
  if (report.unresolved && report.unresolved.length > 0) {
    return `unresolved required variables: ${report.unresolved.join(', ')}`
  }
  if (report.preScript?.error) return `pre-request script error: ${report.preScript.error}`
  if (report.testScript?.error) return `test script error: ${report.testScript.error}`
  if (report.response && report.response.status >= 400) {
    return `HTTP ${report.response.status} ${report.response.statusText}`.trimEnd()
  }
  const failed = collectTests(report).filter((t) => !t.passed)
  if (failed.length > 0) {
    return `failed tests: ${failed.map((t) => t.name).join(', ')}`
  }
  return report.errored ? 'request errored' : undefined
}

/**
 * Run a workflow strictly sequentially: each step is fully awaited (response
 * received, test script completed) before the next fires.
 *
 * Status matrix (PLAN.md execution semantics):
 * - errored + !expectError -> 'failed', halt; remaining steps -> 'skipped'
 * - errored +  expectError -> 'expected-error', continue
 * - ok      +  expectError -> 'unexpected-success' (warning), continue
 * - ok      + !expectError -> 'passed'
 *
 * A thrown `execute` is treated as an errored step (transport-level failure).
 */
export async function runWorkflow(args: RunWorkflowArgs): Promise<WorkflowRunReport> {
  const { workflowPath, wf, execute, onProgress, now } = args
  const startedAt = now ? now() : new Date().toISOString()
  const steps: WorkflowStepResult[] = []
  let halted = false

  for (const step of wf.steps) {
    if (halted) {
      const result: WorkflowStepResult = { request: step.request, status: 'skipped', tests: [] }
      steps.push(result)
      onProgress?.(result)
      continue
    }

    let result: WorkflowStepResult
    try {
      const report = await execute(step.request)
      const status = report.errored
        ? step.expectError
          ? 'expected-error'
          : 'failed'
        : step.expectError
          ? 'unexpected-success'
          : 'passed'
      result = { request: step.request, status, tests: collectTests(report) }
      if (report.response) result.response = report.response
      const errorMessage = report.errored ? deriveErrorMessage(report) : undefined
      if (errorMessage !== undefined) result.errorMessage = errorMessage
    } catch (e) {
      const status = step.expectError ? 'expected-error' : 'failed'
      result = {
        request: step.request,
        status,
        tests: [],
        errorMessage: e instanceof Error ? e.message : String(e)
      }
    }

    if (result.status === 'failed') halted = true
    steps.push(result)
    onProgress?.(result)
  }

  return { workflow: workflowPath, startedAt, steps, halted }
}
