import { describe, expect, it } from 'vitest'
import { mapGrpcurlCommand } from './grpc'
import { parseRequestFile, writeRequestFile } from './index'
import type { CommandToken } from './shell'
import type { RequestFile } from '@shared/model'

const argv = (...words: string[]): CommandToken[] => words.map((text, i) => ({ text, line: i + 1 }))

function ok(...words: string[]) {
  const r = mapGrpcurlCommand(argv(...words))
  if (!r.ok) throw new Error(`expected ok, got: ${JSON.stringify(r.errors)}`)
  return r.grpc
}
function err(...words: string[]) {
  const r = mapGrpcurlCommand(argv(...words))
  if (r.ok) throw new Error('expected error')
  return r.errors[0]
}

describe('mapGrpcurlCommand', () => {
  it('maps the full flag subset and positionals', () => {
    const g = ok(
      'grpcurl',
      '-plaintext',
      '-import-path', 'protos',
      '-proto', 'helloworld.proto',
      '-H', 'authorization: Bearer ${TOKEN}',
      '-d', '{"name":"world"}',
      '-max-time', '30',
      '${GRPC_TARGET}',
      'helloworld.Greeter/SayHello'
    )
    expect(g).toEqual({
      target: '${GRPC_TARGET}',
      fullMethod: 'helloworld.Greeter/SayHello',
      plaintext: true,
      data: '{"name":"world"}',
      metadata: [{ name: 'authorization', value: 'Bearer ${TOKEN}' }],
      protoFiles: ['helloworld.proto'],
      importPaths: ['protos'],
      maxTimeSeconds: 30
    })
  })

  it('allows multiple -proto and -import-path flags', () => {
    const g = ok('grpcurl', '-proto', 'a.proto', '-proto', 'b.proto', '-import-path', 'x', '-import-path', 'y', 'h:1', 'p.S/M')
    expect(g.protoFiles).toEqual(['a.proto', 'b.proto'])
    expect(g.importPaths).toEqual(['x', 'y'])
  })

  it('errors on an unknown flag', () => {
    expect(err('grpcurl', '-nope', 'h:1', 'p.S/M').message).toMatch(/unsupported grpcurl flag/)
  })
  it('errors when the method is missing', () => {
    expect(err('grpcurl', 'host:50051').message).toMatch(/requires a target address and a method/)
  })
  it('errors on a third positional', () => {
    expect(err('grpcurl', 'h:1', 'p.S/M', 'extra').message).toMatch(/unexpected extra argument/)
  })
})

describe('grpc round-trip through parse/write', () => {
  it('parses a written .grpc file back to the same model', () => {
    const file: RequestFile = {
      kind: 'grpc',
      frontmatter: { description: 'say hello' },
      variables: [{ name: 'GRPC_TARGET', defaultValue: 'localhost:50051', required: false }],
      grpc: {
        target: '${GRPC_TARGET}',
        fullMethod: 'helloworld.Greeter/SayHello',
        plaintext: true,
        data: '{"name":"world"}',
        metadata: [{ name: 'authorization', value: 'Bearer ${TOKEN}' }],
        protoFiles: ['helloworld.proto'],
        importPaths: ['protos'],
        maxTimeSeconds: 30
      },
      comments: []
    }
    const text = writeRequestFile(file)
    expect(text).toContain('grpcurl')
    const parsed = parseRequestFile(text, 'grpc')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.file.grpc).toEqual(file.grpc)
  })

  it('rejects a curl body in a .grpc file', () => {
    const parsed = parseRequestFile("curl --url 'http://x'\n", 'grpc')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.errors[0].message).toMatch(/expected a grpcurl invocation/)
  })
})
