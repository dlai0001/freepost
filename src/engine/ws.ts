/**
 * WebSocket client engine. Runs in the Electron MAIN process (Node context).
 *
 * Part of src/engine — the ONLY module allowed to use network APIs
 * (PLAN.md "Network policy"). Wraps the 'ws' package behind a small
 * emitter-style API so the rest of the app never touches sockets.
 */

import WebSocket from 'ws'
import type { Header } from '../shared/model'

export type WsState = 'idle' | 'connecting' | 'open' | 'closed'

export interface WsConnectArgs {
  url: string
  headers?: Header[]
  protocol?: string
}

export interface WsClientEvents {
  open: () => void
  message: (data: string) => void
  close: (code: number, reason: string) => void
  error: (err: Error) => void
}

export class WsClient {
  private ws?: WebSocket
  private _state: WsState = 'idle'
  private listeners: { [E in keyof WsClientEvents]: WsClientEvents[E][] } = {
    open: [],
    message: [],
    close: [],
    error: []
  }

  get state(): WsState {
    return this._state
  }

  on<E extends keyof WsClientEvents>(event: E, cb: WsClientEvents[E]): this {
    this.listeners[event].push(cb)
    return this
  }

  private emit<E extends keyof WsClientEvents>(
    event: E,
    ...args: Parameters<WsClientEvents[E]>
  ): void {
    for (const cb of this.listeners[event]) {
      ;(cb as (...a: Parameters<WsClientEvents[E]>) => void)(...args)
    }
  }

  connect(args: WsConnectArgs): void {
    if (this._state === 'connecting' || this._state === 'open') {
      throw new Error('WsClient is already connected or connecting')
    }
    const headers: Record<string, string> = {}
    for (const h of args.headers ?? []) headers[h.name] = h.value

    this._state = 'connecting'
    const ws = new WebSocket(args.url, args.protocol !== undefined ? [args.protocol] : [], {
      headers
    })
    this.ws = ws

    ws.on('open', () => {
      this._state = 'open'
      this.emit('open')
    })
    ws.on('message', (data) => {
      this.emit('message', data.toString())
    })
    ws.on('close', (code, reason) => {
      this._state = 'closed'
      this.emit('close', code, reason.toString())
    })
    ws.on('error', (err) => {
      this.emit('error', err)
    })
  }

  send(text: string): void {
    if (this._state !== 'open' || this.ws === undefined) {
      throw new Error(`Cannot send: WebSocket is not open (state: ${this._state})`)
    }
    this.ws.send(text)
  }

  close(): void {
    if (this.ws !== undefined && this._state !== 'closed') {
      this.ws.close(1000) // normal closure
    }
  }
}
