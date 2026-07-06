/**
 * Strict POSIX-shell-subset parser for the request-file body (PLAN.md
 * "Strict file grammar"): an assignment block followed by exactly ONE
 * command invocation. Blank lines are ignored; standalone `#` comment lines
 * are preserved as trivia attached to the following statement. Anything
 * else — pipes, chaining, redirects, heredocs, control structures, a second
 * command — is a ParseError, and invalid files are never rewritten.
 */
import type { BodyComment, ParseError, VariableDecl } from '@shared/model'

/** One argv word of the command, with the physical line it starts on. */
export interface CommandToken {
  text: string
  line: number
}

export interface ParsedBody {
  variables: VariableDecl[]
  comments: BodyComment[]
  /** argv of the single command invocation, command name first. */
  argv: CommandToken[]
}

export type BodyResult = { ok: true; body: ParsedBody } | { ok: false; errors: ParseError[] }

const stripCr = (s: string): string => (s.endsWith('\r') ? s.slice(0, -1) : s)

const fail = (line: number, message: string): { ok: false; errors: ParseError[] } => ({
  ok: false,
  errors: [{ line, message }],
})

const SHELL_KEYWORDS = new Set([
  'if', 'then', 'elif', 'else', 'fi',
  'for', 'while', 'until', 'do', 'done',
  'case', 'esac', 'select', 'function', 'time', 'coproc',
])

const ASSIGNMENT_START = /^[A-Za-z_][A-Za-z0-9_]*=/
const REQUIRED_FORM = /^"\$\{([A-Za-z_][A-Za-z0-9_]*):\?\}"$/
const DEFAULT_FORM = /^"\$\{([A-Za-z_][A-Za-z0-9_]*):-([\s\S]*)\}"$/

type TokenizeResult = { ok: true; tokens: CommandToken[] } | { ok: false; error: ParseError }

function readDollar(
  src: string,
  pos: number,
  lineAt: (p: number) => number,
): { ok: true; text: string; next: number } | { ok: false; error: ParseError } {
  const next: string | undefined = src[pos + 1]
  if (next === '{') {
    const close = src.indexOf('}', pos + 2)
    if (close === -1) {
      return { ok: false, error: { line: lineAt(pos), message: 'unterminated ${...} variable reference' } }
    }
    return { ok: true, text: src.slice(pos, close + 1), next: close + 1 }
  }
  if (next === '(') {
    return {
      ok: false,
      error: { line: lineAt(pos), message: 'command substitution "$(...)" is not supported in request files' },
    }
  }
  if (next !== undefined && /[A-Za-z0-9_]/.test(next)) {
    return {
      ok: false,
      error: { line: lineAt(pos), message: `bare "$${next}..." variable references are not supported; write \${NAME} instead` },
    }
  }
  return { ok: true, text: '$', next: pos + 1 }
}

/**
 * Tokenize one logical command line (continuations already joined) into argv
 * words. Quoting: single quotes are literal (the `'\''` idiom works via word
 * concatenation), double quotes pass `${VAR}` references through as text.
 * Shell operators are strict-grammar parse errors.
 */
export function tokenizeCommandText(src: string, lineAt: (p: number) => number): TokenizeResult {
  const terr = (line: number, message: string): { ok: false; error: ParseError } => ({
    ok: false,
    error: { line, message },
  })
  const tokens: CommandToken[] = []
  let pos = 0
  while (pos < src.length) {
    const c0 = src[pos]
    if (c0 === ' ' || c0 === '\t') {
      pos++
      continue
    }
    const startLine = lineAt(pos)
    let text = ''
    let sawQuote = false
    word: while (pos < src.length) {
      const c = src[pos]
      if (c === ' ' || c === '\t') break word
      switch (c) {
        case "'": {
          const close = src.indexOf("'", pos + 1)
          if (close === -1) return terr(lineAt(pos), 'unterminated single-quoted string')
          text += src.slice(pos + 1, close)
          pos = close + 1
          sawQuote = true
          break
        }
        case '"': {
          pos++
          for (;;) {
            if (pos >= src.length) return terr(startLine, 'unterminated double-quoted string')
            const d = src[pos]
            if (d === '"') {
              pos++
              break
            }
            if (d === '\\') {
              const nx: string | undefined = src[pos + 1]
              if (nx === undefined) return terr(lineAt(pos), 'unterminated double-quoted string')
              text += nx === '"' || nx === '\\' || nx === '$' || nx === '`' ? nx : '\\' + nx
              pos += 2
              continue
            }
            if (d === '`') {
              return terr(lineAt(pos), 'command substitution "`...`" is not supported in request files')
            }
            if (d === '$') {
              const r = readDollar(src, pos, lineAt)
              if (!r.ok) return r
              text += r.text
              pos = r.next
              continue
            }
            text += d
            pos++
          }
          sawQuote = true
          break
        }
        case '\\': {
          const nx: string | undefined = src[pos + 1]
          if (nx === undefined) return terr(lineAt(pos), 'dangling backslash at end of command')
          text += nx
          pos += 2
          break
        }
        case '#': {
          if (text === '' && !sawQuote) {
            return terr(lineAt(pos), "unexpected '#' inside a command (comments must be standalone lines)")
          }
          text += c
          pos++
          break
        }
        case '|':
          return terr(lineAt(pos), 'pipes ("|") are not supported: a request file must contain exactly one command')
        case '&':
          return terr(lineAt(pos), '"&" / "&&" chaining is not supported: a request file must contain exactly one command')
        case ';':
          return terr(lineAt(pos), '";" command chaining is not supported: a request file must contain exactly one command')
        case '<': {
          if (src[pos + 1] === '<') return terr(lineAt(pos), 'heredocs ("<<") are not supported in request files')
          return terr(lineAt(pos), 'input redirection ("<") is not supported in request files')
        }
        case '>':
          return terr(lineAt(pos), 'output redirection (">") is not supported in request files')
        case '(':
        case ')':
          return terr(lineAt(pos), 'subshells ("(...)") are not supported in request files')
        case '`':
          return terr(lineAt(pos), 'command substitution "`...`" is not supported in request files')
        case '$': {
          const r = readDollar(src, pos, lineAt)
          if (!r.ok) return r
          text += r.text
          pos = r.next
          break
        }
        default: {
          text += c
          pos++
        }
      }
    }
    tokens.push({ text, line: startLine })
  }
  return { ok: true, tokens }
}

function parseAssignment(
  line: string,
  lineNo: number,
): { ok: true; decl: VariableDecl } | { ok: false; errors: ParseError[] } {
  const eq = line.indexOf('=')
  const name = line.slice(0, eq)
  const value = line.slice(eq + 1)

  const required = REQUIRED_FORM.exec(value)
  if (required) {
    if (required[1] !== name) {
      return fail(lineNo, `assignment must reference its own name: expected ${name}="\${${name}:?}", found \${${required[1]}:?}`)
    }
    return { ok: true, decl: { name, required: true } }
  }

  const withDefault = DEFAULT_FORM.exec(value)
  if (withDefault) {
    if (withDefault[1] !== name) {
      return fail(lineNo, `assignment must reference its own name: expected ${name}="\${${name}:-...}", found \${${withDefault[1]}:-...}`)
    }
    return { ok: true, decl: { name, required: false, defaultValue: withDefault[2] } }
  }

  if (value.startsWith("'") || value.startsWith('"')) {
    const tokenized = tokenizeCommandText(value, () => lineNo)
    if (!tokenized.ok) return { ok: false, errors: [tokenized.error] }
    if (tokenized.tokens.length === 1) {
      return { ok: true, decl: { name, required: false, defaultValue: tokenized.tokens[0].text } }
    }
  }

  return fail(
    lineNo,
    `malformed assignment "${name}=...": allowed forms are ${name}="\${${name}:-default}", ${name}="\${${name}:?}", or ${name}='literal'`,
  )
}

/**
 * Parse the body starting at `lines[startIndex]` (0-based over the whole
 * file's physical lines; error line numbers are `index + 1`).
 */
export function parseBody(lines: string[], startIndex: number): BodyResult {
  const variables: VariableDecl[] = []
  const comments: BodyComment[] = []
  let argv: CommandToken[] | null = null

  let i = startIndex
  while (i < lines.length) {
    const raw = stripCr(lines[i])
    const trimmed = raw.trim()

    if (trimmed === '') {
      i++
      continue
    }

    if (trimmed.startsWith('#')) {
      const statementCount = variables.length + (argv ? 1 : 0)
      comments.push({ beforeStatement: statementCount, text: trimmed.slice(1).trim() })
      i++
      continue
    }

    if (argv) {
      return fail(i + 1, 'unexpected content after the command: a request file must contain exactly one command invocation')
    }

    if (ASSIGNMENT_START.test(trimmed)) {
      const r = parseAssignment(trimmed, i + 1)
      if (!r.ok) return r
      variables.push(r.decl)
      i++
      continue
    }

    // Command invocation: join backslash-newline continuations, then tokenize.
    const segments: { text: string; line: number }[] = []
    let j = i
    let current = stripCr(lines[j])
    while (current.endsWith('\\')) {
      segments.push({ text: current.slice(0, -1), line: j + 1 })
      j++
      if (j >= lines.length) return fail(j, 'line continuation ("\\") at end of file')
      current = stripCr(lines[j])
    }
    segments.push({ text: current, line: j + 1 })

    let src = ''
    const marks = segments.map((s) => {
      const mark = { pos: src.length, line: s.line }
      src += s.text
      return mark
    })
    const lineAt = (pos: number): number => {
      let line = segments[0].line
      for (const m of marks) if (m.pos <= pos) line = m.line
      return line
    }

    const tokenized = tokenizeCommandText(src, lineAt)
    if (!tokenized.ok) return { ok: false, errors: [tokenized.error] }
    if (tokenized.tokens.length === 0) return fail(i + 1, 'expected a command')
    const head = tokenized.tokens[0].text
    if (SHELL_KEYWORDS.has(head)) {
      return fail(i + 1, `shell control structures ("${head}") are not supported in request files`)
    }
    argv = tokenized.tokens
    i = j + 1
  }

  if (!argv) {
    return fail(Math.max(lines.length, 1), 'missing command: a request file must contain exactly one curl or websocat invocation')
  }
  return { ok: true, body: { variables, comments, argv } }
}
