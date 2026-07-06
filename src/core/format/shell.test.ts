import { describe, expect, it } from 'vitest'
import { parseBody } from './shell'

const parse = (text: string, startIndex = 0) => parseBody(text.split('\n'), startIndex)

function ok(text: string, startIndex = 0) {
  const r = parse(text, startIndex)
  expect(r.ok).toBe(true)
  if (!r.ok) throw new Error(`expected ok, got: ${JSON.stringify(r.errors)}`)
  return r.body
}

function err(text: string, startIndex = 0) {
  const r = parse(text, startIndex)
  expect(r.ok).toBe(false)
  if (r.ok) throw new Error('expected error')
  return r.errors[0]
}

describe('parseBody: assignments', () => {
  it('parses the three accepted assignment forms', () => {
    const body = ok(
      [
        'BASE_URL="${BASE_URL:-https://api.example.com}"',
        'TOKEN="${TOKEN:?}"',
        "GREETING='hello world'",
        'MODE="fast"',
        'curl --url "${BASE_URL}"',
      ].join('\n'),
    )
    expect(body.variables).toEqual([
      { name: 'BASE_URL', required: false, defaultValue: 'https://api.example.com' },
      { name: 'TOKEN', required: true },
      { name: 'GREETING', required: false, defaultValue: 'hello world' },
      { name: 'MODE', required: false, defaultValue: 'fast' },
    ])
  })

  it('parses an empty default', () => {
    const body = ok(['SUFFIX="${SUFFIX:-}"', 'curl x'].join('\n'))
    expect(body.variables).toEqual([{ name: 'SUFFIX', required: false, defaultValue: '' }])
  })

  it("handles the '\\'' escape inside a literal assignment", () => {
    const body = ok(["NAME='It'\\''s'", 'curl x'].join('\n'))
    expect(body.variables[0].defaultValue).toBe("It's")
  })

  it('rejects an unquoted assignment value with line info', () => {
    const e = err(['A="${A:-1}"', 'TOKEN=abc', 'curl x'].join('\n'))
    expect(e.line).toBe(2)
    expect(e.message).toMatch(/malformed assignment/)
  })

  it('rejects a ${OTHER:-} default referencing a different name', () => {
    const e = err(['TOKEN="${OTHER:-x}"', 'curl x'].join('\n'))
    expect(e.line).toBe(1)
    expect(e.message).toMatch(/must reference its own name/)
  })

  it('rejects a ${OTHER:?} referencing a different name', () => {
    const e = err(['TOKEN="${OTHER:?}"', 'curl x'].join('\n'))
    expect(e.line).toBe(1)
    expect(e.message).toMatch(/must reference its own name/)
  })

  it('rejects command substitution in an assignment', () => {
    const e = err(['NOW="$(date)"', 'curl x'].join('\n'))
    expect(e.line).toBe(1)
    expect(e.message).toMatch(/command substitution/)
  })

  it('rejects an env-prefixed command (looks like a malformed assignment)', () => {
    const e = err("TOKEN='x' curl https://x")
    expect(e.line).toBe(1)
    expect(e.message).toMatch(/malformed assignment/)
  })
})

describe('parseBody: command tokenization', () => {
  it('joins backslash-newline continuations into one argv', () => {
    const body = ok(['curl --request GET \\', "  --url 'https://x' \\", "  --header 'A: b'"].join('\n'))
    expect(body.argv.map((t) => t.text)).toEqual(['curl', '--request', 'GET', '--url', 'https://x', '--header', 'A: b'])
    expect(body.argv[0].line).toBe(1)
    expect(body.argv[3].line).toBe(2)
    expect(body.argv[5].line).toBe(3)
  })

  it('passes ${VAR} through double quotes as text', () => {
    const body = ok('curl --url "https://${HOST}/p?q=1"')
    expect(body.argv[2].text).toBe('https://${HOST}/p?q=1')
  })

  it('concatenates adjacent quoted segments into one word', () => {
    const body = ok(`curl --url 'https://'"\${HOST}"'/x'`)
    expect(body.argv[2].text).toBe('https://${HOST}/x')
  })

  it("handles the '\\'' single-quote escape idiom", () => {
    const body = ok("curl --url 'https://x' --data 'It'\\''s'")
    expect(body.argv[4].text).toBe("It's")
  })

  it('preserves an escaped \\$ in double quotes as a literal dollar', () => {
    const body = ok('curl --url "https://x/\\$literal"')
    expect(body.argv[2].text).toBe('https://x/$literal')
  })

  it('parses an empty quoted argument', () => {
    const body = ok("curl --url 'https://x' --data ''")
    expect(body.argv[4].text).toBe('')
  })

  it('keeps URLs with query strings intact inside quotes', () => {
    const body = ok("curl --url 'https://x/a?b=1&c=2#frag'")
    expect(body.argv[2].text).toBe('https://x/a?b=1&c=2#frag')
  })

  it('rejects an unquoted & (even in a URL) with line info', () => {
    const e = err('curl --url https://x/a?b=1&c=2')
    expect(e.line).toBe(1)
    expect(e.message).toMatch(/"&"/)
  })

  it('rejects unterminated single quotes', () => {
    const e = err("curl --url 'https://x")
    expect(e.line).toBe(1)
    expect(e.message).toMatch(/unterminated single-quoted/)
  })

  it('rejects unterminated double quotes', () => {
    const e = err('curl --url "https://x')
    expect(e.message).toMatch(/unterminated double-quoted/)
  })

  it('rejects bare $VAR references (unquoted and quoted)', () => {
    expect(err('curl --url https://$HOST/x').message).toMatch(/write \$\{NAME\}/)
    expect(err('curl --url "https://$HOST/x"').message).toMatch(/write \$\{NAME\}/)
  })

  it('reports the physical line of an error inside a continuation', () => {
    const e = err(['curl \\', "  --url 'https://x' \\", '  --data `boom`'].join('\n'))
    expect(e.line).toBe(3)
    expect(e.message).toMatch(/command substitution/)
  })
})

describe('parseBody: strict grammar rejections', () => {
  it('rejects pipes with line info', () => {
    const e = err("curl --url 'https://x' | jq .")
    expect(e.line).toBe(1)
    expect(e.message).toMatch(/pipes/)
  })

  it('rejects && chaining', () => {
    expect(err("curl --url 'https://x' && echo done").message).toMatch(/"&"/)
  })

  it('rejects ; chaining', () => {
    expect(err("curl --url 'https://x'; echo done").message).toMatch(/";"/)
  })

  it('rejects output redirects', () => {
    expect(err("curl --url 'https://x' > out.json").message).toMatch(/redirection/)
  })

  it('rejects heredocs specifically', () => {
    const e = err(["curl --url 'https://x' --data @- <<EOF", '{}', 'EOF'].join('\n'))
    expect(e.line).toBe(1)
    expect(e.message).toMatch(/heredoc/)
  })

  it('rejects input redirects', () => {
    expect(err("curl --url 'https://x' < in.json").message).toMatch(/input redirection/)
  })

  it('rejects command substitution via $() and backticks', () => {
    expect(err('curl --url "$(get-url)"').message).toMatch(/command substitution/)
    expect(err('curl --url `get-url`').message).toMatch(/command substitution/)
  })

  it('rejects subshells', () => {
    expect(err("(curl --url 'https://x')").message).toMatch(/subshells/)
  })

  it('rejects a second command with its line number', () => {
    const e = err(["curl --url 'https://a'", "curl --url 'https://b'"].join('\n'))
    expect(e.line).toBe(2)
    expect(e.message).toMatch(/exactly one command/)
  })

  it('rejects an assignment after the command', () => {
    const e = err(["curl --url 'https://a'", 'LATE="${LATE:-1}"'].join('\n'))
    expect(e.line).toBe(2)
    expect(e.message).toMatch(/after the command/)
  })

  it('rejects shell control structures (if/for)', () => {
    expect(err(['if true', 'fi'].join('\n')).message).toMatch(/control structures/)
    expect(err('for x in a b').message).toMatch(/control structures/)
  })

  it('rejects a file with no command', () => {
    const e = err('A="${A:-1}"')
    expect(e.message).toMatch(/missing command/)
  })

  it('rejects a trailing line continuation at end of file', () => {
    expect(err("curl --url 'https://x' \\").message).toMatch(/end of file/)
  })

  it('rejects a comment glued into a continuation', () => {
    const e = err(['curl \\', "  # not a real comment --url 'x'"].join('\n'))
    expect(e.line).toBe(2)
    expect(e.message).toMatch(/'#'/)
  })
})

describe('parseBody: comments as trivia', () => {
  it('attaches comments to the following statement, command last', () => {
    const body = ok(
      [
        '# base url of the service',
        'BASE_URL="${BASE_URL:-x}"',
        '',
        '# auth token',
        'TOKEN="${TOKEN:?}"',
        '',
        '# the main call',
        '# spans two comment lines',
        "curl --url 'https://x'",
        '# trailing note',
      ].join('\n'),
    )
    expect(body.comments).toEqual([
      { beforeStatement: 0, text: 'base url of the service' },
      { beforeStatement: 1, text: 'auth token' },
      { beforeStatement: 2, text: 'the main call' },
      { beforeStatement: 2, text: 'spans two comment lines' },
      { beforeStatement: 3, text: 'trailing note' },
    ])
  })

  it('normalizes comment text (no leading # or surrounding whitespace)', () => {
    const body = ok(['#   padded   ', "curl --url 'x'"].join('\n'))
    expect(body.comments).toEqual([{ beforeStatement: 0, text: 'padded' }])
  })

  it('preserves empty comment lines as empty text', () => {
    const body = ok(['#', "curl --url 'x'"].join('\n'))
    expect(body.comments).toEqual([{ beforeStatement: 0, text: '' }])
  })
})
