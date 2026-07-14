import { describe, expect, it } from 'vitest'
import { mapInspectorCommand } from './mcp'
import { parseRequestFile, writeRequestFile } from './index'
import type { CommandToken } from './shell'
import type { RequestFile } from '@shared/model'

const argv = (...words: string[]): CommandToken[] => words.map((text, i) => ({ text, line: i + 1 }))

const INSPECTOR = ['npx', '@modelcontextprotocol/inspector', '--cli']

function ok(...words: string[]) {
  const r = mapInspectorCommand(argv(...INSPECTOR, ...words))
  if (!r.ok) throw new Error(`expected ok, got: ${JSON.stringify(r.errors)}`)
  return r.mcp
}
function err(...words: string[]) {
  const r = mapInspectorCommand(argv(...INSPECTOR, ...words))
  if (r.ok) throw new Error('expected error')
  return r.errors[0]
}

describe('mapInspectorCommand', () => {
  it('maps a stdio tools/call with the full flag subset', () => {
    const m = ok(
      'npx',
      '-y',
      '@modelcontextprotocol/server-everything',
      '-e',
      'GITHUB_TOKEN=abc',
      '--method',
      'tools/call',
      '--tool-name',
      'get-sum',
      '--tool-arg',
      'a=20',
      '--tool-arg',
      'b=22'
    )
    expect(m).toEqual({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-everything'],
      env: [{ name: 'GITHUB_TOKEN', value: 'abc' }],
      headers: [],
      method: 'tools/call',
      toolName: 'get-sum',
      toolArgs: [
        { name: 'a', value: '20' },
        { name: 'b', value: '22' }
      ],
      promptArgs: []
    })
  })

  it('infers the http transport from a URL positional', () => {
    const m = ok('http://localhost:3001/mcp', '--header', 'Authorization: Bearer t', '--method', 'tools/list')
    expect(m).toEqual({
      transport: 'http',
      url: 'http://localhost:3001/mcp',
      args: [],
      env: [],
      headers: [{ name: 'Authorization', value: 'Bearer t' }],
      method: 'tools/list',
      toolArgs: [],
      promptArgs: []
    })
  })

  it('treats server flags after --cli as server args, not inspector flags', () => {
    const m = ok('node', '--enable-source-maps', 'server.mjs', '--method', 'tools/list')
    expect(m.command).toBe('node')
    expect(m.args).toEqual(['--enable-source-maps', 'server.mjs'])
  })

  it('maps resources/read and prompts/get', () => {
    expect(ok('node', 's.mjs', '--method', 'resources/read', '--uri', 'demo://a').uri).toBe('demo://a')
    const p = ok('node', 's.mjs', '--method', 'prompts/get', '--prompt-name', 'greet', '--prompt-args', 'city=Oakland')
    expect(p.promptName).toBe('greet')
    expect(p.promptArgs).toEqual([{ name: 'city', value: 'Oakland' }])
  })

  it('honours an explicit --transport over inference', () => {
    // A stdio server whose command happens to be a URL-shaped string still
    // spawns when --transport says so.
    expect(ok('node', 's.mjs', '--transport', 'stdio', '--method', 'tools/list').transport).toBe('stdio')
  })

  it('rejects the deprecated sse transport', () => {
    expect(err('http://h/mcp', '--transport', 'sse', '--method', 'tools/list').message).toMatch(/sse is deprecated/)
  })

  it('rejects a missing --method', () => {
    expect(err('node', 's.mjs').message).toMatch(/missing --method/)
  })

  it('rejects an unknown method', () => {
    expect(err('node', 's.mjs', '--method', 'tools/nope').message).toMatch(/unsupported --method/)
  })

  it('rejects tools/call without a tool name', () => {
    expect(err('node', 's.mjs', '--method', 'tools/call').message).toMatch(/requires --tool-name/)
  })

  it('rejects tool args on a non-tools/call method', () => {
    expect(err('node', 's.mjs', '--method', 'tools/list', '--tool-name', 'x').message).toMatch(
      /only valid with --method tools\/call/
    )
  })

  it('rejects resources/read without a uri, and a uri elsewhere', () => {
    expect(err('node', 's.mjs', '--method', 'resources/read').message).toMatch(/requires --uri/)
    expect(err('node', 's.mjs', '--method', 'tools/list', '--uri', 'x://y').message).toMatch(/--uri is only valid/)
  })

  it('rejects prompts/get without a prompt name', () => {
    expect(err('node', 's.mjs', '--method', 'prompts/get').message).toMatch(/requires --prompt-name/)
  })

  it('rejects a header on stdio and -e on http', () => {
    expect(err('node', 's.mjs', '--header', 'A: b', '--method', 'tools/list').message).toMatch(
      /--header is only valid with the http transport/
    )
    expect(err('http://h/mcp', '-e', 'A=b', '--method', 'tools/list').message).toMatch(
      /-e is only valid with the stdio transport/
    )
  })

  it('rejects a missing target, a malformed tool arg, and an unknown flag', () => {
    expect(err('--method', 'tools/list').message).toMatch(/missing MCP server target/)
    expect(err('node', 's.mjs', '--method', 'tools/call', '--tool-name', 't', '--tool-arg', 'oops').message).toMatch(
      /expected "key=value"/
    )
    expect(err('node', 's.mjs', '--method', 'tools/list', '--bogus').message).toMatch(/unsupported inspector flag/)
  })

  it('rejects a non-inspector npx package and a missing --cli', () => {
    const a = mapInspectorCommand(argv('npx', 'cowsay', '--cli', '--method', 'tools/list'))
    expect(a.ok).toBe(false)
    if (a.ok) return
    expect(a.errors[0].message).toMatch(/expected an npx @modelcontextprotocol\/inspector invocation/)

    const b = mapInspectorCommand(argv('npx', '@modelcontextprotocol/inspector', '--method', 'tools/list'))
    expect(b.ok).toBe(false)
    if (b.ok) return
    expect(b.errors[0].message).toMatch(/expected --cli/)
  })

  it('accepts npx -y and a versioned inspector package', () => {
    const r = mapInspectorCommand(
      argv('npx', '-y', '@modelcontextprotocol/inspector@0.22.0', '--cli', 'node', 's.mjs', '--method', 'tools/list')
    )
    expect(r.ok).toBe(true)
  })
})

describe('mcp round-trip through parse/write', () => {
  it('parses a written stdio .mcp file back to the same model', () => {
    const file: RequestFile = {
      kind: 'mcp',
      frontmatter: { description: 'add two numbers' },
      variables: [{ name: 'TOKEN', required: true }],
      mcp: {
        transport: 'stdio',
        command: 'npx',
        // '-y' is a server arg: the round-trip must not read it as an inspector flag.
        args: ['-y', '@modelcontextprotocol/server-everything'],
        env: [{ name: 'API_TOKEN', value: '${TOKEN}' }],
        headers: [],
        method: 'tools/call',
        toolName: 'get-sum',
        toolArgs: [
          { name: 'a', value: '20' },
          { name: 'b', value: '22' }
        ],
        promptArgs: []
      },
      comments: []
    }
    const text = writeRequestFile(file)
    expect(text).toContain('npx @modelcontextprotocol/inspector')
    const parsed = parseRequestFile(text, 'mcp')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.file.mcp).toEqual(file.mcp)
  })

  it('parses a written http .mcp file back to the same model', () => {
    const file: RequestFile = {
      kind: 'mcp',
      frontmatter: {},
      variables: [],
      mcp: {
        transport: 'http',
        url: 'http://localhost:3001/mcp',
        args: [],
        env: [],
        headers: [{ name: 'Authorization', value: 'Bearer ${TOKEN}' }],
        method: 'resources/read',
        toolArgs: [],
        uri: 'demo://resource/1',
        promptArgs: []
      },
      comments: []
    }
    const parsed = parseRequestFile(writeRequestFile(file), 'mcp')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.file.mcp).toEqual(file.mcp)
  })

  it('is idempotent: write(parse(write(f))) === write(f)', () => {
    const file: RequestFile = {
      kind: 'mcp',
      frontmatter: {},
      variables: [],
      mcp: {
        transport: 'stdio',
        command: 'node',
        args: ['--enable-source-maps', 'server.mjs'],
        env: [],
        headers: [],
        method: 'tools/list',
        toolArgs: [],
        promptArgs: []
      },
      comments: []
    }
    const once = writeRequestFile(file)
    const parsed = parseRequestFile(once, 'mcp')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(writeRequestFile(parsed.file)).toBe(once)
  })

  it('rejects a curl body in a .mcp file', () => {
    const parsed = parseRequestFile("curl --url 'http://x'\n", 'mcp')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.errors[0].message).toMatch(/expected a npx invocation/)
  })
})
