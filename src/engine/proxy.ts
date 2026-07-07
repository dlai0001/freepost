/**
 * HTTP/HTTPS proxy support for the request engine (corporate networks).
 *
 * Part of src/engine — the only place allowed to open sockets (PLAN.md network
 * policy). HTTP targets go through a forward proxy in absolute-form; HTTPS
 * targets are tunneled with the CONNECT method, then TLS-wrapped by us so the
 * caller hands node an already-secured socket.
 */
import { connect as netConnect, isIP, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

/** Parse a proxy spec into a URL, or undefined if empty/blank/invalid. */
export function parseProxy(spec: string | undefined): URL | undefined {
  if (spec === undefined || spec.trim() === '') return undefined
  try {
    // Bare "host:port" (no scheme) is common in *_PROXY vars — default to http.
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(spec) ? spec : `http://${spec}`)
  } catch {
    return undefined
  }
}

/** Proxy-Authorization header value from a proxy URL's credentials, if any. */
export function proxyAuthHeader(proxy: URL): string | undefined {
  if (proxy.username === '') return undefined
  const user = decodeURIComponent(proxy.username)
  const pass = decodeURIComponent(proxy.password)
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
}

/**
 * True when `host` should bypass the proxy per a NO_PROXY-style list
 * (comma/space-separated suffixes; `*` matches everything). Leading dots and
 * `*.` prefixes are treated as domain-suffix matches.
 */
export function shouldBypassProxy(host: string, noProxy: string | undefined): boolean {
  if (noProxy === undefined || noProxy.trim() === '') return false
  const h = host.toLowerCase()
  for (const raw of noProxy.split(/[,\s]+/)) {
    const entry = raw.trim().toLowerCase()
    if (entry === '') continue
    if (entry === '*') return true
    const suffix = entry.replace(/^\*?\.?/, '') // "*.corp" / ".corp" -> "corp"
    if (h === suffix || h.endsWith('.' + suffix)) return true
  }
  return false
}

export interface TunnelOptions {
  /** Skip TLS verification to the target (curl --insecure). */
  insecure?: boolean
  /** Extra CA to trust for the target TLS handshake. */
  ca?: string | Buffer
  /** SNI/servername for the target TLS handshake. */
  servername?: string
}

type ConnCallback = (err: Error | null, socket?: Socket) => void

/**
 * Build a `createConnection` for node's https/http request that tunnels to the
 * target through `proxy` via CONNECT. When `isHttps`, the returned socket is
 * TLS-wrapped against the target; otherwise the raw tunnel socket is returned.
 */
export function proxyTunnel(
  proxy: URL,
  isHttps: boolean,
  opts: TunnelOptions
): (options: { host?: string; port?: number | string }, callback: ConnCallback) => void {
  // Must NOT return the socket: node's http client uses a truthy return value
  // immediately as the connection. We return void so it awaits `callback`
  // (fired only after CONNECT succeeds and, for https, TLS is established).
  return (options, callback) => {
    const proxyPort = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80)
    const targetHost = String(options.host)
    const targetPort = Number(options.port) || (isHttps ? 443 : 80)
    const socket = netConnect(proxyPort, proxy.hostname)

    socket.once('connect', () => {
      const auth = proxyAuthHeader(proxy)
      let msg = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n`
      msg += `Host: ${targetHost}:${targetPort}\r\n`
      if (auth !== undefined) msg += `Proxy-Authorization: ${auth}\r\n`
      msg += '\r\n'
      socket.write(msg)
    })

    let buf = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk])
      const end = buf.indexOf('\r\n\r\n')
      if (end === -1) return // wait for full CONNECT response header
      socket.removeListener('data', onData)
      const statusLine = buf.slice(0, buf.indexOf('\r\n')).toString('latin1')
      const m = /^HTTP\/\d\.\d (\d{3})/.exec(statusLine)
      if (m === null || m[1] !== '200') {
        socket.destroy()
        callback(new Error(`Proxy CONNECT failed: ${statusLine.trim() || 'no response'}`))
        return
      }
      if (isHttps) {
        // SNI must be a hostname, never an IP literal (RFC 6066).
        const sni = opts.servername ?? targetHost
        const secure = tlsConnect(
          {
            socket,
            host: targetHost, // identity is verified against the real target, not 'localhost'
            ...(isIP(sni) === 0 ? { servername: sni } : {}),
            rejectUnauthorized: opts.insecure !== true,
            ...(opts.ca !== undefined ? { ca: opts.ca } : {})
          },
          () => callback(null, secure)
        )
        secure.once('error', (err) => callback(err))
      } else {
        callback(null, socket)
      }
    }
    socket.on('data', onData)
    socket.once('error', (err) => callback(err))
  }
}
