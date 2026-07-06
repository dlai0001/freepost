/**
 * Data-file parsing for data-driven runs (PLAN.md "CSV/JSON data files"). Each
 * row becomes a DataRow (column/key -> string value) loaded into the session at
 * iteration start.
 *
 * No external dependencies: the CSV parser below is a native RFC-4180 reader.
 */

import type { DataRow } from '@shared/model'

export type ParseDataResult =
  | { ok: true; rows: DataRow[] }
  | { ok: false; error: string }

/**
 * Parse a data file, dispatching on filename extension: `.json` is parsed as a
 * JSON array of flat objects; anything else is parsed as CSV.
 */
export function parseDataFile(text: string, filename: string): ParseDataResult {
  if (filename.toLowerCase().endsWith('.json')) {
    return parseJsonData(text)
  }
  return parseCsv(text)
}

/** Coerce a JSON scalar to a string. Rejects nested objects/arrays. */
function coerceCell(value: unknown, rowIndex: number, key: string): string | { error: string } {
  if (value === null) return ''
  switch (typeof value) {
    case 'string':
      return value
    case 'number':
    case 'boolean':
      return String(value)
    default:
      return {
        error: `row ${rowIndex} field "${key}" must be a string, number, boolean, or null (got ${
          Array.isArray(value) ? 'array' : typeof value
        })`
      }
  }
}

function parseJsonData(text: string): ParseDataResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message}` }
  }
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'JSON data file must be an array of objects' }
  }

  const rows: DataRow[] = []
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { ok: false, error: `row ${i} must be a flat object` }
    }
    const row: DataRow = {}
    for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
      const coerced = coerceCell(value, i, key)
      if (typeof coerced === 'object') return { ok: false, error: coerced.error }
      row[key] = coerced
    }
    rows.push(row)
  }
  return { ok: true, rows }
}

/**
 * Parse CSV text into DataRow[] per RFC 4180.
 *
 * - The first record is the header row; each subsequent record maps header -> cell.
 * - Fields may be double-quoted; quoted fields may contain commas, newlines, and
 *   escaped quotes (`""` -> `"`). Content inside/outside quotes is preserved
 *   verbatim (no trimming) apart from stripping a trailing `\r` on unquoted fields
 *   so CRLF and LF line endings both work.
 * - Empty input or a header-only file yields `rows: []`.
 * - A record with fewer cells than headers: missing trailing cells default to `''`.
 *   A record with more cells than headers is an error with the line number.
 */
export function parseCsv(text: string): ParseDataResult {
  const records = tokenizeCsv(text)
  if (records.length === 0) return { ok: true, rows: [] }

  const headers = records[0].fields
  const rows: DataRow[] = []

  for (let r = 1; r < records.length; r++) {
    const { fields, line } = records[r]
    if (fields.length > headers.length) {
      return {
        ok: false,
        error: `line ${line}: expected ${headers.length} columns but found ${fields.length}`
      }
    }
    const row: DataRow = {}
    for (let c = 0; c < headers.length; c++) {
      row[headers[c]] = c < fields.length ? fields[c] : ''
    }
    rows.push(row)
  }

  return { ok: true, rows }
}

interface CsvRecord {
  fields: string[]
  /** 1-based line number where this record begins (for error messages). */
  line: number
}

/**
 * Split CSV text into records of fields. A trailing newline does not produce a
 * spurious empty record; a completely empty input produces no records.
 */
function tokenizeCsv(text: string): CsvRecord[] {
  const records: CsvRecord[] = []
  let field = ''
  let fields: string[] = []
  let inQuotes = false
  let recordStartLine = 1
  let line = 1
  let sawAnyChar = false // any content in the current record (incl. empty field)

  const pushField = (): void => {
    // Strip a trailing \r from unquoted fields (handles CRLF line endings).
    fields.push(field.endsWith('\r') ? field.slice(0, -1) : field)
    field = ''
  }
  const pushRecord = (): void => {
    pushField()
    records.push({ fields, line: recordStartLine })
    fields = []
    sawAnyChar = false
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++ // consume the escaped quote
        } else {
          inQuotes = false
        }
      } else {
        if (ch === '\n') line++
        field += ch
      }
      continue
    }

    if (ch === '"') {
      inQuotes = true
      sawAnyChar = true
    } else if (ch === ',') {
      pushField()
      sawAnyChar = true
    } else if (ch === '\n') {
      pushRecord()
      line++
      recordStartLine = line
    } else {
      // Any other char (including \r, handled at field flush) starts content.
      sawAnyChar = true
      field += ch
    }
  }

  // Flush the final record unless the input ended exactly on a newline with no
  // trailing content (avoids a spurious empty trailing record).
  if (sawAnyChar || field.length > 0) {
    pushRecord()
  }

  return records
}
