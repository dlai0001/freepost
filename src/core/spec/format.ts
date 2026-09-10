/**
 * Plain-text rendering of a SpecValidationReport, shared by the CLI reporter
 * and the MCP `run_request` tool. Returns lines without indentation or colour;
 * callers add both.
 */
import type { SpecResponseKey, SpecValidationError, SpecValidationReport } from '@shared/model'

const MAX_ERROR_LINES = 10

export function formatResponseKey(k: SpecResponseKey): string {
  return k.mediaType === undefined ? k.status : `${k.status} ${k.mediaType}`
}

export function formatSpecError(e: SpecValidationError): string {
  if (e.target === 'header') return `header ${e.instancePath}: ${e.message}`
  return `${e.instancePath === '' ? '/' : e.instancePath}: ${e.message}`
}

/**
 * First line is the verdict (prefixed ✓ / ✗ / –), the rest are error details.
 * `kind` tells the caller how to colour the verdict line.
 */
export function formatSpecValidation(r: SpecValidationReport): { kind: 'ok' | 'fail' | 'muted'; lines: string[] } {
  const errorLines = (errors: SpecValidationError[]): string[] => {
    const lines = errors.slice(0, MAX_ERROR_LINES).map((e) => '  ' + formatSpecError(e))
    if (errors.length > MAX_ERROR_LINES) lines.push(`  … ${errors.length - MAX_ERROR_LINES} more`)
    return lines
  }
  switch (r.verdict) {
    case 'match':
      return { kind: 'ok', lines: [`✓ spec ${r.matchedResponse === undefined ? 'matches' : formatResponseKey(r.matchedResponse)}`] }
    case 'mismatch': {
      const n = r.errors.length
      const lines = [
        `✗ spec ${r.matchedResponse === undefined ? '' : formatResponseKey(r.matchedResponse) + ' '}— ${n} mismatch${n === 1 ? '' : 'es'}`,
        ...errorLines(r.errors)
      ]
      if (r.closestMatch !== undefined) {
        const c = r.closestMatch.errors.length
        lines.push(`  closest: ${formatResponseKey(r.closestMatch.response)} (${c} error${c === 1 ? '' : 's'})`)
      }
      return { kind: 'fail', lines }
    }
    case 'undocumented-status': {
      const documented = r.documentedStatuses?.length ? ` (documented: ${r.documentedStatuses.join(', ')})` : ''
      const lines = [`✗ spec: ${r.reason ?? 'status not documented'}${documented}`]
      if (r.closestMatch !== undefined) {
        const c = r.closestMatch.errors.length
        lines.push(`  closest: ${formatResponseKey(r.closestMatch.response)} (${c} error${c === 1 ? '' : 's'})`)
      }
      return { kind: 'fail', lines }
    }
    case 'skipped':
      return { kind: 'muted', lines: [`– spec skipped: ${r.reason ?? 'not applicable'}`, ...errorLines(r.errors)] }
    case 'error':
      return { kind: 'fail', lines: [`✗ spec error: ${r.reason ?? 'unknown'}`] }
  }
}
