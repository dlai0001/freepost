import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import { GrpcStreamClient, sendGrpcUnary } from './grpc'

const PROTO = `syntax = "proto3";
package helloworld;
service Greeter {
  rpc SayHello (HelloRequest) returns (HelloReply) {}
  rpc SayHellos (HelloRequest) returns (stream HelloReply) {}
}
message HelloRequest { string name = 1; }
message HelloReply { string message = 1; }
`

let dir = ''
let protoPath = ''
let server: grpc.Server
let target = ''

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'freepost-grpc-'))
  protoPath = join(dir, 'helloworld.proto')
  writeFileSync(protoPath, PROTO)

  const pkgDef = protoLoader.loadSync(protoPath, { keepCase: true })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proto = grpc.loadPackageDefinition(pkgDef) as any
  server = new grpc.Server()
  server.addService(proto.helloworld.Greeter.service, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    SayHello: (call: any, cb: any) => {
      if (call.request.name === 'boom') {
        cb({ code: grpc.status.INVALID_ARGUMENT, details: 'no boom allowed' })
        return
      }
      cb(null, { message: `Hello ${call.request.name}` })
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    SayHellos: (call: any) => {
      for (let i = 1; i <= 3; i++) call.write({ message: `Hello ${call.request.name} #${i}` })
      call.end()
    }
  })
  const port: number = await new Promise((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, p) => {
      if (err !== null) reject(err)
      else resolve(p)
    })
  })
  target = `127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.tryShutdown(() => resolve()))
  rmSync(dir, { recursive: true, force: true })
})

describe('sendGrpcUnary', () => {
  it('invokes a unary method and returns the response JSON', async () => {
    const res = await sendGrpcUnary({
      target,
      fullMethod: 'helloworld.Greeter/SayHello',
      data: '{"name":"world"}',
      protoFiles: [protoPath],
      plaintext: true
    })
    expect(res.code).toBe(0)
    expect(res.codeName).toBe('OK')
    expect(JSON.parse(res.message)).toEqual({ message: 'Hello world' })
  })

  it('returns a non-OK code with details on a server error', async () => {
    const res = await sendGrpcUnary({
      target,
      fullMethod: 'helloworld.Greeter/SayHello',
      data: '{"name":"boom"}',
      protoFiles: [protoPath],
      plaintext: true
    })
    expect(res.code).toBe(grpc.status.INVALID_ARGUMENT)
    expect(res.codeName).toBe('INVALID_ARGUMENT')
    expect(JSON.parse(res.message).error).toMatch(/no boom/)
  })

  it('reports a clear error for an unknown method', async () => {
    const res = await sendGrpcUnary({
      target,
      fullMethod: 'helloworld.Greeter/Nope',
      protoFiles: [protoPath],
      plaintext: true
    })
    expect(res.code).toBe(grpc.status.INVALID_ARGUMENT)
    expect(JSON.parse(res.message).error).toMatch(/method not found/)
  })

  it('errors when no proto file is given', async () => {
    const res = await sendGrpcUnary({
      target,
      fullMethod: 'helloworld.Greeter/SayHello',
      protoFiles: [],
      plaintext: true
    })
    expect(JSON.parse(res.message).error).toMatch(/at least one -proto/)
  })
})

describe('GrpcStreamClient', () => {
  it('streams server responses then ends', async () => {
    const messages: string[] = []
    await new Promise<void>((resolve, reject) => {
      new GrpcStreamClient()
        .on('data', (j) => messages.push(JSON.parse(j).message))
        .on('error', reject)
        .on('end', resolve)
        .start({
          target,
          fullMethod: 'helloworld.Greeter/SayHellos',
          data: '{"name":"stream"}',
          protoFiles: [protoPath],
          plaintext: true
        })
    })
    expect(messages).toEqual(['Hello stream #1', 'Hello stream #2', 'Hello stream #3'])
  })
})
