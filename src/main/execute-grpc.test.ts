import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import { writeRequestFile } from '../core/format'
import type { RecordedExchange, RequestFile } from '../shared/model'
import { recordedToRequestFile } from '../core/record/to-request'
import { executeRequest } from './execute'

const PROTO = `syntax = "proto3";
package helloworld;
service Greeter { rpc SayHello (HelloRequest) returns (HelloReply) {} }
message HelloRequest { string name = 1; }
message HelloReply { string message = 1; }
`

let root = ''
let server: grpc.Server
let target = ''

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'freepost-execgrpc-'))
  writeFileSync(join(root, 'helloworld.proto'), PROTO)

  const pkgDef = protoLoader.loadSync(join(root, 'helloworld.proto'), { keepCase: true })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proto = grpc.loadPackageDefinition(pkgDef) as any
  server = new grpc.Server()
  server.addService(proto.helloworld.Greeter.service, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    SayHello: (call: any, cb: any) => cb(null, { message: `Hello ${call.request.name}` })
  })
  const port: number = await new Promise((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) =>
      e !== null ? reject(e) : resolve(p)
    )
  })
  target = `127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise<void>((r) => server.tryShutdown(() => r()))
  rmSync(root, { recursive: true, force: true })
})

function writeGrpc(rel: string, file: RequestFile): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, writeRequestFile(file))
}

describe('executeRequest for .grpc', () => {
  it('runs a unary call and maps the reply, with a passing test script', async () => {
    writeGrpc('Hello.grpc', {
      kind: 'grpc',
      frontmatter: {
        scripts: {
          test: 'pm.test("greets", () => pm.expect(pm.response.json().message).to.equal("Hello dave"));'
        }
      },
      variables: [{ name: 'GRPC_TARGET', defaultValue: target, required: false }],
      grpc: {
        target: '${GRPC_TARGET}',
        fullMethod: 'helloworld.Greeter/SayHello',
        plaintext: true,
        data: '{"name":"dave"}',
        metadata: [],
        protoFiles: ['helloworld.proto'],
        importPaths: []
      },
      comments: []
    })
    const report = await executeRequest({ root, path: 'Hello.grpc', session: new Map() })
    expect(report.errored).toBe(false)
    expect(report.response?.statusText).toBe('OK')
    expect(JSON.parse(report.response!.bodyText)).toEqual({ message: 'Hello dave' })
    expect(report.testScript?.tests).toEqual([{ name: 'greets', passed: true }])
  })

  it('runs a .grpc saved from a recorded exchange, whose proto path the save made relative', async () => {
    // The portability claim end to end: the file picker's ABSOLUTE proto path
    // is what "Save to collection" is handed, and what lands in the file must
    // be a collection-relative path that still resolves when run.
    const entry: RecordedExchange = {
      id: '1',
      at: '2026-01-01T00:00:00Z',
      protocol: 'grpc',
      method: 'POST',
      url: `http://${target}/helloworld.Greeter/SayHello`,
      requestHeaders: [],
      errored: false,
      grpc: { service: 'helloworld.Greeter', method: 'SayHello', requestMessages: 1, responseMessages: 1 }
    }
    const file = recordedToRequestFile(entry, {
      data: '{"name":"dave"}',
      protoFiles: [join(root, 'helloworld.proto')],
      root
    })
    expect(file.grpc?.protoFiles).toEqual(['helloworld.proto'])

    writeGrpc('Recorded.grpc', file)
    const report = await executeRequest({ root, path: 'Recorded.grpc', session: new Map() })
    expect(report.errored).toBe(false)
    expect(JSON.parse(report.response!.bodyText)).toEqual({ message: 'Hello dave' })
  })

  it('marks a non-OK gRPC status as errored', async () => {
    writeGrpc('Bad.grpc', {
      kind: 'grpc',
      frontmatter: {},
      variables: [{ name: 'GRPC_TARGET', defaultValue: target, required: false }],
      grpc: {
        target: '${GRPC_TARGET}',
        fullMethod: 'helloworld.Greeter/Missing',
        plaintext: true,
        data: '{}',
        metadata: [],
        protoFiles: ['helloworld.proto'],
        importPaths: []
      },
      comments: []
    })
    const report = await executeRequest({ root, path: 'Bad.grpc', session: new Map() })
    expect(report.errored).toBe(true)
    expect(report.response?.status).toBe(500)
  })
})
