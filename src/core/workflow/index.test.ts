import { describe, expect, it } from 'vitest'
import type { ExecutionReport, WorkflowFile, WorkflowStepResult } from '@shared/model'
import {
  healReferences,
  parseWorkflow,
  runWorkflow,
  serializeWorkflow,
  validateReferences
} from './index'

/* --------------------------------- parse --------------------------------- */

describe('parseWorkflow', () => {
  it('accepts a conforming workflow', () => {
    const r = parseWorkflow(
      JSON.stringify({
        description: 'End-to-end signup happy path',
        steps: [
          { request: 'auth/Create account.curl' },
          { request: 'auth/Create account.curl', expectError: true }
        ]
      })
    )
    expect(r).toEqual({
      ok: true,
      wf: {
        description: 'End-to-end signup happy path',
        steps: [
          { request: 'auth/Create account.curl' },
          { request: 'auth/Create account.curl', expectError: true }
        ]
      }
    })
  })

  it('accepts a minimal workflow without description', () => {
    const r = parseWorkflow('{"steps": []}')
    expect(r).toEqual({ ok: true, wf: { steps: [] } })
  })

  it('rejects invalid JSON', () => {
    const r = parseWorkflow('{nope')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/invalid JSON/)
  })

  it('rejects a non-object root', () => {
    const r = parseWorkflow('[1, 2]')
    expect(r).toEqual({ ok: false, error: 'workflow root must be a JSON object' })
  })

  it('rejects missing steps', () => {
    const r = parseWorkflow('{"description": "x"}')
    expect(r).toEqual({ ok: false, error: 'missing required "steps" array' })
  })

  it('rejects non-array steps', () => {
    const r = parseWorkflow('{"steps": {"request": "a.curl"}}')
    expect(r).toEqual({ ok: false, error: '"steps" must be an array' })
  })

  it('rejects a non-object step with its index', () => {
    const r = parseWorkflow('{"steps": [{"request": "a.curl"}, "b.curl"]}')
    expect(r).toEqual({ ok: false, error: 'steps[1] must be an object' })
  })

  it('rejects a step with missing request', () => {
    const r = parseWorkflow('{"steps": [{"expectError": true}]}')
    expect(r).toEqual({ ok: false, error: 'steps[0].request must be a non-empty string' })
  })

  it('rejects a non-string request', () => {
    const r = parseWorkflow('{"steps": [{"request": 42}]}')
    expect(r).toEqual({ ok: false, error: 'steps[0].request must be a non-empty string' })
  })

  it('rejects a non-boolean expectError', () => {
    const r = parseWorkflow('{"steps": [{"request": "a.curl", "expectError": "yes"}]}')
    expect(r).toEqual({ ok: false, error: 'steps[0].expectError must be a boolean' })
  })

  it('rejects unknown step keys (typo protection)', () => {
    const r = parseWorkflow('{"steps": [{"reqeust": "a.curl", "request": "a.curl"}]}')
    expect(r).toEqual({ ok: false, error: 'unknown key "reqeust" in steps[0]' })
  })

  it('rejects unknown root keys', () => {
    const r = parseWorkflow('{"steps": [], "step": []}')
    expect(r).toEqual({ ok: false, error: 'unknown key "step" at workflow root' })
  })

  it('rejects a non-string description', () => {
    const r = parseWorkflow('{"description": 7, "steps": []}')
    expect(r).toEqual({ ok: false, error: '"description" must be a string' })
  })
})

/* ------------------------------- serialize ------------------------------- */

describe('serializeWorkflow', () => {
  it('emits stable 2-space pretty JSON that round-trips', () => {
    const wf: WorkflowFile = {
      description: 'smoke',
      steps: [{ request: 'a.curl' }, { request: 'b.curl', expectError: true }]
    }
    const json = serializeWorkflow(wf)
    expect(json).toBe(
      JSON.stringify(
        { description: 'smoke', steps: [{ request: 'a.curl' }, { request: 'b.curl', expectError: true }] },
        null,
        2
      ) + '\n'
    )
    const back = parseWorkflow(json)
    expect(back).toEqual({ ok: true, wf })
  })

  it('omits absent description', () => {
    const json = serializeWorkflow({ steps: [] })
    expect(json).toBe('{\n  "steps": []\n}\n')
  })

  it('round-trips dataFile (data-driven workflows)', () => {
    const wf: WorkflowFile = {
      description: 'smoke',
      dataFile: 'data/rows.csv',
      steps: [{ request: 'a.curl' }]
    }
    const json = serializeWorkflow(wf)
    // dataFile is emitted between description and steps.
    expect(json).toBe(
      JSON.stringify(
        { description: 'smoke', dataFile: 'data/rows.csv', steps: [{ request: 'a.curl' }] },
        null,
        2
      ) + '\n'
    )
    expect(parseWorkflow(json)).toEqual({ ok: true, wf })
  })

  it('rejects a non-string dataFile', () => {
    const result = parseWorkflow('{ "dataFile": 5, "steps": [] }')
    expect(result.ok).toBe(false)
  })
})

/* ------------------------------- validation ------------------------------ */

describe('validateReferences', () => {
  const wf: WorkflowFile = {
    steps: [
      { request: 'auth/Create account.curl' },
      { request: 'gone/Deleted.curl' },
      { request: 'notes/readme.workflow.json' }
    ]
  }

  it('reports missing and not-a-request steps, passes real requests', () => {
    const lookup = (p: string): 'request' | 'missing' | 'not-a-request' =>
      p === 'auth/Create account.curl' ? 'request' : p === 'gone/Deleted.curl' ? 'missing' : 'not-a-request'
    expect(validateReferences(wf, lookup)).toEqual([
      { stepIndex: 1, request: 'gone/Deleted.curl', reason: 'missing' },
      { stepIndex: 2, request: 'notes/readme.workflow.json', reason: 'not-a-request' }
    ])
  })

  it('returns an empty array when everything resolves', () => {
    expect(validateReferences(wf, () => 'request')).toEqual([])
  })
})

/* --------------------------------- healing ------------------------------- */

describe('healReferences', () => {
  it('rewrites every matching step and reports changed', () => {
    const wf: WorkflowFile = {
      description: 'd',
      steps: [
        { request: 'a.curl' },
        { request: 'b.curl', expectError: true },
        { request: 'a.curl', expectError: true }
      ]
    }
    const { wf: healed, changed } = healReferences(wf, 'a.curl', 'moved/a.curl')
    expect(changed).toBe(true)
    expect(healed).toEqual({
      description: 'd',
      steps: [
        { request: 'moved/a.curl' },
        { request: 'b.curl', expectError: true },
        { request: 'moved/a.curl', expectError: true }
      ]
    })
    // Input untouched.
    expect(wf.steps[0].request).toBe('a.curl')
  })

  it('returns changed: false and the same object when nothing matches', () => {
    const wf: WorkflowFile = { steps: [{ request: 'a.curl' }] }
    const { wf: same, changed } = healReferences(wf, 'x.curl', 'y.curl')
    expect(changed).toBe(false)
    expect(same).toBe(wf)
  })

  it('preserves dataFile when healing (folder move / rename must not drop it)', () => {
    const wf: WorkflowFile = {
      description: 'd',
      dataFile: 'data/rows.csv',
      steps: [{ request: 'auth/Login.curl' }]
    }
    const { wf: healed, changed } = healReferences(wf, 'auth/Login.curl', 'id/auth/Login.curl')
    expect(changed).toBe(true)
    expect(healed.dataFile).toBe('data/rows.csv')
    expect(healed.steps[0].request).toBe('id/auth/Login.curl')
  })
})

/* --------------------------------- running ------------------------------- */

function okReport(path: string): ExecutionReport {
  return {
    requestPath: path,
    resolvedUrl: `https://api.example.com/${path}`,
    response: {
      status: 200,
      statusText: 'OK',
      headers: [],
      bodyText: '{}',
      timeMs: 5,
      sizeBytes: 2
    },
    testScript: {
      tests: [{ name: 'status is 200', passed: true }],
      consoleLines: [],
      sessionWrites: {}
    },
    errored: false
  }
}

function errorReport(path: string): ExecutionReport {
  return {
    requestPath: path,
    resolvedUrl: `https://api.example.com/${path}`,
    response: {
      status: 409,
      statusText: 'Conflict',
      headers: [],
      bodyText: '',
      timeMs: 5,
      sizeBytes: 0
    },
    testScript: {
      tests: [{ name: 'expects conflict', passed: true }],
      consoleLines: [],
      sessionWrites: {}
    },
    errored: true
  }
}

describe('runWorkflow', () => {
  it('all-passing run: every step passed, not halted, report fields set', async () => {
    const wf: WorkflowFile = { steps: [{ request: 'a.curl' }, { request: 'b.curl' }] }
    const report = await runWorkflow({
      workflowPath: 'smoke.workflow.json',
      wf,
      execute: async (p) => okReport(p),
      now: () => '2026-07-06T00:00:00.000Z'
    })
    expect(report.workflow).toBe('smoke.workflow.json')
    expect(report.startedAt).toBe('2026-07-06T00:00:00.000Z')
    expect(report.halted).toBe(false)
    expect(report.steps.map((s) => s.status)).toEqual(['passed', 'passed'])
    expect(report.steps[0].response?.status).toBe(200)
    expect(report.steps[0].tests).toEqual([{ name: 'status is 200', passed: true }])
    expect(report.steps[0].errorMessage).toBeUndefined()
  })

  it('failed step halts; remaining steps recorded skipped', async () => {
    const wf: WorkflowFile = {
      steps: [{ request: 'a.curl' }, { request: 'boom.curl' }, { request: 'c.curl' }, { request: 'd.curl' }]
    }
    const executed: string[] = []
    const report = await runWorkflow({
      workflowPath: 'w.workflow.json',
      wf,
      execute: async (p) => {
        executed.push(p)
        return p === 'boom.curl' ? errorReport(p) : okReport(p)
      }
    })
    expect(executed).toEqual(['a.curl', 'boom.curl']) // c and d never executed
    expect(report.halted).toBe(true)
    expect(report.steps.map((s) => s.status)).toEqual(['passed', 'failed', 'skipped', 'skipped'])
    expect(report.steps[1].errorMessage).toBe('HTTP 409 Conflict')
    expect(report.steps[2].tests).toEqual([])
  })

  it('expectError + errored step -> expected-error, run continues', async () => {
    const wf: WorkflowFile = {
      steps: [{ request: 'dup.curl', expectError: true }, { request: 'b.curl' }]
    }
    const report = await runWorkflow({
      workflowPath: 'w.workflow.json',
      wf,
      execute: async (p) => (p === 'dup.curl' ? errorReport(p) : okReport(p))
    })
    expect(report.halted).toBe(false)
    expect(report.steps.map((s) => s.status)).toEqual(['expected-error', 'passed'])
    expect(report.steps[0].errorMessage).toBe('HTTP 409 Conflict')
    expect(report.steps[0].response?.status).toBe(409)
  })

  it('expectError + success -> unexpected-success warning, run continues', async () => {
    const wf: WorkflowFile = {
      steps: [{ request: 'a.curl', expectError: true }, { request: 'b.curl' }]
    }
    const report = await runWorkflow({
      workflowPath: 'w.workflow.json',
      wf,
      execute: async (p) => okReport(p)
    })
    expect(report.halted).toBe(false)
    expect(report.steps.map((s) => s.status)).toEqual(['unexpected-success', 'passed'])
  })

  it('a thrown execute is a failed step (halts) unless expectError', async () => {
    const wf: WorkflowFile = {
      steps: [{ request: 'kaput.curl', expectError: true }, { request: 'boom.curl' }, { request: 'c.curl' }]
    }
    const report = await runWorkflow({
      workflowPath: 'w.workflow.json',
      wf,
      execute: async (p) => {
        if (p !== 'c.curl') throw new Error(`ECONNREFUSED ${p}`)
        return okReport(p)
      }
    })
    expect(report.steps.map((s) => s.status)).toEqual(['expected-error', 'failed', 'skipped'])
    expect(report.steps[1].errorMessage).toBe('ECONNREFUSED boom.curl')
    expect(report.halted).toBe(true)
  })

  it('derives errorMessage from transport errors and failed tests', async () => {
    const transport: ExecutionReport = {
      requestPath: 'a.curl',
      resolvedUrl: 'https://x',
      transportError: 'getaddrinfo ENOTFOUND x',
      errored: true
    }
    const failedTests: ExecutionReport = {
      ...okReport('b.curl'),
      errored: true,
      testScript: {
        tests: [
          { name: 'status is 200', passed: true },
          { name: 'has email', passed: false, error: 'expected undefined to be a string' }
        ],
        consoleLines: [],
        sessionWrites: {}
      }
    }
    const wf: WorkflowFile = {
      steps: [{ request: 'a.curl', expectError: true }, { request: 'b.curl', expectError: true }]
    }
    const reports: Record<string, ExecutionReport> = { 'a.curl': transport, 'b.curl': failedTests }
    const report = await runWorkflow({
      workflowPath: 'w.workflow.json',
      wf,
      execute: async (p) => reports[p]
    })
    expect(report.steps[0].errorMessage).toBe('getaddrinfo ENOTFOUND x')
    expect(report.steps[1].errorMessage).toBe('failed tests: has email')
  })

  it('calls onProgress after each step, in order, including skipped', async () => {
    const wf: WorkflowFile = {
      steps: [{ request: 'a.curl' }, { request: 'boom.curl' }, { request: 'c.curl' }]
    }
    const progress: { request: string; status: string }[] = []
    const report = await runWorkflow({
      workflowPath: 'w.workflow.json',
      wf,
      execute: async (p) => (p === 'boom.curl' ? errorReport(p) : okReport(p)),
      onProgress: (r: WorkflowStepResult) => progress.push({ request: r.request, status: r.status })
    })
    expect(progress).toEqual([
      { request: 'a.curl', status: 'passed' },
      { request: 'boom.curl', status: 'failed' },
      { request: 'c.curl', status: 'skipped' }
    ])
    expect(progress.length).toBe(report.steps.length)
  })

  it('is strictly sequential: a step starts only after the previous fully settles', async () => {
    const wf: WorkflowFile = {
      steps: [{ request: 'slow.curl' }, { request: 'mid.curl' }, { request: 'fast.curl' }]
    }
    const events: string[] = []
    const delays: Record<string, number> = { 'slow.curl': 30, 'mid.curl': 15, 'fast.curl': 1 }
    await runWorkflow({
      workflowPath: 'w.workflow.json',
      wf,
      execute: async (p) => {
        events.push(`start:${p}`)
        await new Promise((res) => setTimeout(res, delays[p]))
        events.push(`end:${p}`)
        return okReport(p)
      }
    })
    // Despite the first step being the slowest, no overlap is allowed.
    expect(events).toEqual([
      'start:slow.curl',
      'end:slow.curl',
      'start:mid.curl',
      'end:mid.curl',
      'start:fast.curl',
      'end:fast.curl'
    ])
  })
})
