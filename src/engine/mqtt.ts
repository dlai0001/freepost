/**
 * MQTT client engine. Runs in the Electron MAIN process. Part of src/engine —
 * the only module allowed to open a socket. Wraps mqtt.js: publishMqtt is a
 * one-shot connect/publish/disconnect (mirrors sendHttp); MqttSubscribeClient
 * is a long-lived subscription (mirrors WsClient).
 */
import mqtt from 'mqtt'
import type { MqttClient } from 'mqtt'
import { readFileSync } from 'node:fs'
import type { MqttRequestModel } from '../shared/model'

export interface MqttConnectArgs {
  host: string
  port?: number
  clientId?: string
  username?: string
  password?: string
  /** Path to a CA file; presence enables TLS (mqtts). */
  caFile?: string
}

/** Build mqtt.js connect options + broker URL from the model's connection bits. */
function connectOptions(args: MqttConnectArgs): { url: string; opts: Record<string, unknown> } {
  const tls = args.caFile !== undefined && args.caFile !== ''
  const port = args.port ?? (tls ? 8883 : 1883)
  const url = `${tls ? 'mqtts' : 'mqtt'}://${args.host}:${port}`
  const opts: Record<string, unknown> = { connectTimeout: 10_000, reconnectPeriod: 0 }
  if (args.clientId !== undefined && args.clientId !== '') opts.clientId = args.clientId
  if (args.username !== undefined && args.username !== '') opts.username = args.username
  if (args.password !== undefined && args.password !== '') opts.password = args.password
  if (tls) opts.ca = readFileSync(args.caFile as string)
  return { url, opts }
}

export interface MqttPublishArgs extends MqttConnectArgs {
  topic: string
  message: string
  qos?: number
  retain?: boolean
}

export interface MqttPublishResult {
  ok: boolean
  error?: string
  timeMs: number
}

/** Connect, publish one message, disconnect. Never throws. */
export async function publishMqtt(args: MqttPublishArgs): Promise<MqttPublishResult> {
  const started = Date.now()
  let client: MqttClient | undefined
  try {
    const { url, opts } = connectOptions(args)
    client = mqtt.connect(url, opts)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), timeMs: Date.now() - started }
  }
  const c = client
  return await new Promise<MqttPublishResult>((resolve) => {
    let settled = false
    const finish = (r: MqttPublishResult): void => {
      if (settled) return
      settled = true
      c.end(true, () => undefined)
      resolve(r)
    }
    c.on('error', (err: Error) => finish({ ok: false, error: err.message, timeMs: Date.now() - started }))
    c.on('connect', () => {
      const qos = (args.qos ?? 0) as 0 | 1 | 2
      c.publish(args.topic, args.message, { qos, retain: args.retain === true }, (err?: Error) => {
        if (err !== undefined && err !== null) {
          finish({ ok: false, error: err.message, timeMs: Date.now() - started })
        } else {
          finish({ ok: true, timeMs: Date.now() - started })
        }
      })
    })
  })
}

export type MqttSubState = 'idle' | 'connecting' | 'open' | 'closed'

export interface MqttMessage {
  topic: string
  payload: string
}

export interface MqttSubEvents {
  open: () => void
  message: (msg: MqttMessage) => void
  error: (err: Error) => void
  close: () => void
}

export interface MqttSubscribeArgs extends MqttConnectArgs {
  topic: string
  qos?: number
}

/** Long-lived MQTT subscription, emitter-style like WsClient. */
export class MqttSubscribeClient {
  private client?: MqttClient
  private _state: MqttSubState = 'idle'
  private readonly listeners: { [E in keyof MqttSubEvents]: MqttSubEvents[E][] } = {
    open: [],
    message: [],
    error: [],
    close: []
  }

  get state(): MqttSubState {
    return this._state
  }

  on<E extends keyof MqttSubEvents>(event: E, cb: MqttSubEvents[E]): this {
    this.listeners[event].push(cb)
    return this
  }
  private emit<E extends keyof MqttSubEvents>(event: E, ...a: Parameters<MqttSubEvents[E]>): void {
    for (const cb of this.listeners[event]) (cb as (...x: Parameters<MqttSubEvents[E]>) => void)(...a)
  }

  connect(args: MqttSubscribeArgs): void {
    if (this._state === 'connecting' || this._state === 'open') {
      throw new Error('MqttSubscribeClient already connected')
    }
    this._state = 'connecting'
    const { url, opts } = connectOptions(args)
    const client = mqtt.connect(url, opts)
    this.client = client
    client.on('connect', () => {
      const qos = (args.qos ?? 0) as 0 | 1 | 2
      client.subscribe(args.topic, { qos }, (err) => {
        if (err !== null) {
          this.emit('error', err)
          return
        }
        this._state = 'open'
        this.emit('open')
      })
    })
    client.on('message', (topic: string, payload: Buffer) => {
      this.emit('message', { topic, payload: payload.toString('utf8') })
    })
    client.on('error', (err: Error) => this.emit('error', err))
    client.on('close', () => {
      if (this._state !== 'closed') {
        this._state = 'closed'
        this.emit('close')
      }
    })
  }

  close(): void {
    if (this.client !== undefined && this._state !== 'closed') {
      this._state = 'closed'
      this.client.end(true, () => undefined)
    }
  }
}

/** Extract just the connection fields from a model (for publish/subscribe). */
export function mqttConnectArgs(m: MqttRequestModel): MqttConnectArgs {
  return {
    host: m.host,
    port: m.port,
    clientId: m.clientId,
    username: m.username,
    password: m.password,
    caFile: m.caFile
  }
}
