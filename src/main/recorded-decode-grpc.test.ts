/**
 * The recorded:decode-grpc IPC handler (tier 2 of the History ▸ Recorded gRPC
 * view). Driven through the registered handler rather than decodeGrpcMessages
 * directly: the finding is about which paths the HANDLER hands the engine, so
 * the resolution step is the thing under test.
 *
 * Electron is mocked down to what registration touches — ipcMain.handle, which
 * is captured so the handler can be invoked, and the userData path settings.ts
 * reads.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as protoLoader from '@grpc/proto-loader'
import type { GrpcDecodedMessage, RecordedExchange } from '../shared/model'

const PROTO = `syntax = "proto3";
package helloworld;
service Greeter { rpc SayHello (HelloRequest) returns (HelloReply) {} }
message HelloRequest { string name = 1; }
message HelloReply { string message = 1; }
`

let userData = ''
/** Channel -> handler, filled by the mocked ipcMain at registration. */
const handlers = new Map<string, (e: unknown, args: unknown) => unknown>()

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  ipcMain: {
    handle: (channel: string, fn: (e: unknown, args: unknown) => unknown) => handlers.set(channel, fn)
  },
  dialog: {},
  shell: {},
  BrowserWindow: { getAllWindows: () => [] }
}))

const { IPC } = await import('../shared/ipc')
const { registerIpcHandlers } = await import('./ipc-handlers')

let root = ''
/** The request payload a real capture would hold, as base64 on the wire. */
let helloBase64 = ''

beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'freepost-decode-ud-'))
  root = mkdtempSync(join(tmpdir(), 'freepost-decode-'))
  mkdirSync(join(root, 'protos'))
  writeFileSync(join(root, 'protos', 'helloworld.proto'), PROTO)

  const pkg = protoLoader.loadSync(join(root, 'protos', 'helloworld.proto'), { keepCase: true })
  const def = pkg['helloworld.Greeter'] as unknown as Record<
    string,
    { requestSerialize: (v: unknown) => Buffer }
  >
  helloBase64 = def.SayHello.requestSerialize({ name: 'Ada' }).toString('base64')
  registerIpcHandlers()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
})

const entry = (): RecordedExchange => ({
  id: '1',
  at: '2026-01-01T00:00:00Z',
  protocol: 'grpc',
  method: 'POST',
  url: 'http://127.0.0.1:50051/helloworld.Greeter/SayHello',
  requestHeaders: [],
  errored: false,
  grpc: {
    service: 'helloworld.Greeter',
    method: 'SayHello',
    requestMessages: 1,
    responseMessages: 0,
    messages: [{ dir: 'send', bytes: 5, truncated: false, base64: helloBase64 }]
  }
})

async function decode(args: object): Promise<GrpcDecodedMessage[]> {
  const handler = handlers.get(IPC.recordedDecodeGrpc)
  if (handler === undefined) throw new Error('recorded:decode-grpc is not registered')
  return (await handler({}, args)) as GrpcDecodedMessage[]
}

describe('recorded:decode-grpc', () => {
  it('resolves a collection-relative proto path against the root, as every other gRPC path does', async () => {
    // The paths a saved .grpc carries. Without a resolve step the loader is
    // handed 'protos/helloworld.proto' and looks for it in the cwd.
    const decoded = await decode({
      root,
      entry: entry(),
      protoFiles: ['protos/helloworld.proto'],
      importPaths: ['protos']
    })
    expect(JSON.parse(decoded[0].json as string)).toEqual({ name: 'Ada' })
  })

  it('still accepts an absolute path (what the file picker hands it)', async () => {
    const decoded = await decode({
      root,
      entry: entry(),
      protoFiles: [join(root, 'protos', 'helloworld.proto')]
    })
    expect(JSON.parse(decoded[0].json as string)).toEqual({ name: 'Ada' })
  })

  it('refuses an exchange that is not gRPC', async () => {
    const e = { ...entry(), grpc: undefined }
    await expect(decode({ root, entry: e, protoFiles: [] })).rejects.toThrow(/Not a gRPC exchange/)
  })
})
