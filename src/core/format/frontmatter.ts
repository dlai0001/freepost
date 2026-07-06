/**
 * YAML-in-comments frontmatter: a leading comment block delimited by `# ---`
 * lines, inner lines prefixed `# ` (or a bare `#` for empty lines). The
 * stripped content is standard YAML. Unknown keys round-trip verbatim
 * (PLAN.md rewrite contract) — values are preserved, key order need not be.
 */
import yaml from 'js-yaml'
import type { Frontmatter, ParseError } from '@shared/model'

const DELIMITER = '# ---'

export type FrontmatterResult =
  | { ok: true; frontmatter: Frontmatter; nextIndex: number }
  | { ok: false; errors: ParseError[] }

const stripCr = (s: string): string => (s.endsWith('\r') ? s.slice(0, -1) : s)

const fail = (line: number, message: string): { ok: false; errors: ParseError[] } => ({
  ok: false,
  errors: [{ line, message }],
})

/**
 * Extract the frontmatter block starting at `lines[startIndex]` (0-based;
 * line numbers in errors are `index + 1`). When no block is present, returns
 * an empty frontmatter and `nextIndex === startIndex`.
 */
export function extractFrontmatter(lines: string[], startIndex: number): FrontmatterResult {
  const first = stripCr(lines[startIndex] ?? '')
  if (first.trimEnd() !== DELIMITER) {
    return { ok: true, frontmatter: {}, nextIndex: startIndex }
  }
  const inner: string[] = []
  let i = startIndex + 1
  for (;; i++) {
    if (i >= lines.length) {
      return fail(startIndex + 1, 'unterminated frontmatter block: missing closing "# ---" line')
    }
    const line = stripCr(lines[i])
    if (line.trimEnd() === DELIMITER) break
    if (line.trimEnd() === '#') {
      inner.push('')
      continue
    }
    if (line.startsWith('# ')) {
      inner.push(line.slice(2))
      continue
    }
    return fail(
      i + 1,
      `invalid frontmatter line: every line inside the "# ---" block must start with "# " (got ${JSON.stringify(line)})`,
    )
  }
  let doc: unknown
  try {
    doc = yaml.load(inner.join('\n'))
  } catch (e) {
    const mark = (e as { mark?: { line?: number } }).mark
    const line = startIndex + 2 + (mark?.line ?? 0)
    const reason = (e as { reason?: string }).reason ?? String(e)
    return fail(line, `invalid YAML in frontmatter: ${reason}`)
  }
  if (doc === undefined || doc === null) doc = {}
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    return fail(startIndex + 2, 'frontmatter must be a YAML mapping (key: value pairs)')
  }
  return { ok: true, frontmatter: doc as Frontmatter, nextIndex: i + 1 }
}

/**
 * Serialize frontmatter back to a `# ---`-delimited comment block (no
 * trailing newline). Returns '' when there is nothing to emit.
 */
export function serializeFrontmatter(frontmatter: Frontmatter): string {
  const entries = Object.entries(frontmatter).filter(([, v]) => v !== undefined)
  if (entries.length === 0) return ''
  const dumped = yaml.dump(Object.fromEntries(entries), { lineWidth: -1, noRefs: true })
  const prefixed = dumped
    .replace(/\n$/, '')
    .split('\n')
    .map((l) => (l === '' ? '#' : `# ${l}`))
  return [DELIMITER, ...prefixed, DELIMITER].join('\n')
}
