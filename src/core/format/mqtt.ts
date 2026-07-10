/**
 * Map a tokenized mosquitto_pub / mosquitto_sub invocation onto
 * MqttRequestModel. The command name selects the mode (publish/subscribe).
 * Pinned flag subset: -h, -p, -t, -q, -r, -m, -i, -u, -P, --cafile. Anything
 * else is a ParseError (same strictness as curl/websocat/grpcurl).
 */
import type { MqttRequestModel, ParseError } from '@shared/model'
import type { CommandToken } from './shell'

export type MqttResult = { ok: true; mqtt: MqttRequestModel } | { ok: false; errors: ParseError[] }

const fail = (line: number, message: string): { ok: false; errors: ParseError[] } => ({
  ok: false,
  errors: [{ line, message }]
})

export function mapMosquittoCommand(argv: CommandToken[]): MqttResult {
  const head = argv[0]
  const mode = head.text === 'mosquitto_pub' ? 'publish' : head.text === 'mosquitto_sub' ? 'subscribe' : null
  if (mode === null) {
    return fail(head.line, `expected mosquitto_pub or mosquitto_sub, got ${JSON.stringify(head.text)}`)
  }

  let host: string | undefined
  let topic: string | undefined
  let port: number | undefined
  let qos: number | undefined
  let retain = false
  let message: string | undefined
  let clientId: string | undefined
  let username: string | undefined
  let password: string | undefined
  let caFile: string | undefined

  let i = 1
  const takeValue = (): CommandToken | null => (i + 1 < argv.length ? argv[++i] : null)

  while (i < argv.length) {
    const tok = argv[i]
    switch (tok.text) {
      case '-h': {
        const v = takeValue()
        if (!v) return fail(tok.line, 'missing value for -h')
        host = v.text
        break
      }
      case '-p': {
        const v = takeValue()
        if (!v) return fail(tok.line, 'missing value for -p')
        const n = Number(v.text)
        if (!Number.isInteger(n) || n < 1 || n > 65535) return fail(v.line, `invalid port: ${v.text}`)
        port = n
        break
      }
      case '-t': {
        const v = takeValue()
        if (!v) return fail(tok.line, 'missing value for -t')
        topic = v.text
        break
      }
      case '-q': {
        const v = takeValue()
        if (!v) return fail(tok.line, 'missing value for -q')
        const n = Number(v.text)
        if (n !== 0 && n !== 1 && n !== 2) return fail(v.line, `invalid QoS: ${v.text} (expected 0, 1, or 2)`)
        qos = n
        break
      }
      case '-r':
        retain = true
        break
      case '-m': {
        const v = takeValue()
        if (!v) return fail(tok.line, 'missing value for -m')
        message = v.text
        break
      }
      case '-i': {
        const v = takeValue()
        if (!v) return fail(tok.line, 'missing value for -i')
        clientId = v.text
        break
      }
      case '-u': {
        const v = takeValue()
        if (!v) return fail(tok.line, 'missing value for -u')
        username = v.text
        break
      }
      case '-P': {
        const v = takeValue()
        if (!v) return fail(tok.line, 'missing value for -P')
        password = v.text
        break
      }
      case '--cafile': {
        const v = takeValue()
        if (!v) return fail(tok.line, 'missing value for --cafile')
        caFile = v.text
        break
      }
      default:
        return fail(tok.line, `unsupported mosquitto flag: ${tok.text}`)
    }
    i++
  }

  if (host === undefined) return fail(head.line, `${head.text} requires -h <host>`)
  if (topic === undefined) return fail(head.line, `${head.text} requires -t <topic>`)
  if (mode === 'publish' && message === undefined) {
    return fail(head.line, 'mosquitto_pub requires -m <message>')
  }

  const mqtt: MqttRequestModel = { mode, host, topic }
  if (port !== undefined) mqtt.port = port
  if (qos !== undefined) mqtt.qos = qos
  if (retain) mqtt.retain = true
  if (message !== undefined) mqtt.message = message
  if (clientId !== undefined) mqtt.clientId = clientId
  if (username !== undefined) mqtt.username = username
  if (password !== undefined) mqtt.password = password
  if (caFile !== undefined) mqtt.caFile = caFile
  return { ok: true, mqtt }
}
