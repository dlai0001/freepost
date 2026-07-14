/**
 * Fixture: a gRPC server for .grpc requests (port 50051, plaintext).
 *
 * Serves fixtures/servers/greeter.proto:
 *   Greeter/SayHello   — unary; name "boom" returns INVALID_ARGUMENT
 *   Greeter/SayHellos  — server-streaming (3 messages)
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'

const here = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 50051)

const pkgDef = protoLoader.loadSync(join(here, 'greeter.proto'), { keepCase: true })
const proto = grpc.loadPackageDefinition(pkgDef)

const server = new grpc.Server()
server.addService(proto.helloworld.Greeter.service, {
  SayHello: (call, cb) => {
    const name = call.request.name ?? ''
    console.log('[grpc] SayHello', JSON.stringify(name))
    if (name === 'boom') {
      cb({ code: grpc.status.INVALID_ARGUMENT, details: 'no boom allowed' })
      return
    }
    cb(null, { message: `Hello ${name}` })
  },
  SayHellos: (call) => {
    const name = call.request.name ?? ''
    console.log('[grpc] SayHellos', JSON.stringify(name))
    for (let i = 1; i <= 3; i++) call.write({ message: `Hello ${name} #${i}` })
    call.end()
  }
})

server.bindAsync(`0.0.0.0:${PORT}`, grpc.ServerCredentials.createInsecure(), (err, port) => {
  if (err !== null) {
    console.error('[grpc] failed to bind:', err.message)
    process.exit(1)
  }
  console.log(`[grpc] gRPC fixture on localhost:${port} (plaintext)`)
  console.log('[grpc] methods: helloworld.Greeter/SayHello, helloworld.Greeter/SayHellos')
})
