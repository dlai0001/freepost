import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { WsClient } from './ws'

const wsServers: WebSocketServer[] = []

afterEach(async () => {
  await Promise.all(
    wsServers.splice(0).map(
      (wss) =>
        new Promise<void>((resolve) => {
          for (const client of wss.clients) client.terminate()
          wss.close(() => resolve())
        })
    )
  )
})

function startWss(options: ConstructorParameters<typeof WebSocketServer>[0] = {}): Promise<{
  wss: WebSocketServer
  url: string
}> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', ...options })
    wsServers.push(wss)
    wss.on('listening', () => {
      const { port } = wss.address() as AddressInfo
      resolve({ wss, url: `ws://127.0.0.1:${port}` })
    })
  })
}

describe('WsClient', () => {
  it('runs the connect -> open -> message echo -> close event flow', async () => {
    const { wss, url } = await startWss()
    wss.on('connection', (socket) => {
      socket.on('message', (data) => socket.send(`echo:${data.toString()}`))
    })

    const client = new WsClient()
    const eventOrder: string[] = []
    const opened = new Promise<void>((resolve) =>
      client.on('open', () => {
        eventOrder.push('open')
        resolve()
      })
    )
    const messaged = new Promise<string>((resolve) =>
      client.on('message', (data) => {
        eventOrder.push('message')
        resolve(data)
      })
    )
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      client.on('close', (code, reason) => {
        eventOrder.push('close')
        resolve({ code, reason })
      })
    )

    expect(client.state).toBe('idle')
    client.connect({ url })
    expect(client.state).toBe('connecting')

    await opened
    expect(client.state).toBe('open')

    client.send('hi there')
    expect(await messaged).toBe('echo:hi there')

    client.close()
    const { code } = await closed
    expect(client.state).toBe('closed')
    expect(code).toBe(1000)
    expect(eventOrder).toEqual(['open', 'message', 'close'])
  })

  it('passes connection headers and subprotocol', async () => {
    const { wss, url } = await startWss({
      handleProtocols: (protocols: Set<string>) => protocols.values().next().value ?? false
    })
    const seen = new Promise<{ token?: string; protocol: string }>((resolve) => {
      wss.on('connection', (socket, req) => {
        resolve({ token: req.headers['x-token'] as string | undefined, protocol: socket.protocol })
      })
    })

    const client = new WsClient()
    client.connect({
      url,
      headers: [{ name: 'X-Token', value: 'secret-token' }],
      protocol: 'v1.ticker'
    })
    await new Promise<void>((resolve) => client.on('open', resolve))
    expect(await seen).toEqual({ token: 'secret-token', protocol: 'v1.ticker' })
    client.close()
  })

  it('throws when send() is called before the connection is open', async () => {
    const client = new WsClient()
    expect(() => client.send('too early')).toThrow(/not open/)

    const { url } = await startWss()
    client.connect({ url })
    // still connecting — send must throw
    expect(() => client.send('still too early')).toThrow(/not open/)
    await new Promise<void>((resolve) => client.on('open', resolve))
    client.close()
  })

  it('throws when connect() is called while already connected', async () => {
    const { url } = await startWss()
    const client = new WsClient()
    client.connect({ url })
    expect(() => client.connect({ url })).toThrow(/already connected/)
    await new Promise<void>((resolve) => client.on('open', resolve))
    client.close()
  })

  it('emits error for an unreachable server', async () => {
    // Open then close a server to get a dead port.
    const { wss, url } = await startWss()
    await new Promise<void>((resolve) => wss.close(() => resolve()))
    wsServers.pop()

    const client = new WsClient()
    const errored = new Promise<Error>((resolve) => client.on('error', resolve))
    client.connect({ url })
    const err = await errored
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/ECONNREFUSED/)
  })
})
