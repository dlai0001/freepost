/**
 * HTTP request engine. Runs in the Electron MAIN process (Node context).
 *
 * This module is part of src/engine — the ONLY place in the codebase allowed
 * to use network APIs (PLAN.md "Network policy", enforced by `npm run fence`).
 *
 * Uses node:http / node:https directly (not fetch) for full control over
 * redirects, timing, decompression, and TLS verification.
 */

import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { request as httpsRequest, type RequestOptions } from 'node:https'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import type { Header, HttpResponseModel } from '../shared/model'
import type { CookieJar } from './cookies'
import { parseProxy, proxyAuthHeader, proxyTunnel } from './proxy'

export interface SendHttpOptions {
  /** Skip TLS certificate verification (curl --insecure). */
  insecure?: boolean
  /** Follow 3xx redirects, default true (curl -L). */
  followRedirects?: boolean
  /** Overall deadline, default 30. */
  timeoutSeconds?: number
  /** "user:pass" for Basic auth (curl --user). */
  user?: string
  /** mTLS client certificate: PEM contents OR a filesystem path (https only). */
  clientCert?: string
  /** mTLS client private key: PEM contents OR a filesystem path (https only). */
  clientKey?: string
  /** Passphrase for an encrypted clientKey. */
  clientKeyPassphrase?: string
  /** Extra CA to trust: PEM contents OR a filesystem path (https only). */
  caCert?: string
  /** Proxy URL (http://[user:pass@]host:port). http via absolute-form, https via CONNECT. */
  proxy?: string
}

/**
 * Resolve a PEM-bearing option that may be either the PEM text itself or a
 * path to a file on disk. Returns the value unchanged when it looks like PEM
 * (starts with the standard `-----BEGIN` armor), otherwise reads the file.
 */
export function loadPem(value: string): Buffer | string {
  if (value.trimStart().startsWith('-----BEGIN')) return value
  return readFileSync(value)
}

export interface SendHttpRequest {
  method: string
  url: string
  headers: Header[]
  bodyText?: string
  /** Raw request body (e.g. an assembled multipart payload); wins over bodyText. */
  bodyBuffer?: Buffer
  options?: SendHttpOptions
}

const MAX_REDIRECTS = 10
const DEFAULT_TIMEOUT_SECONDS = 30
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** Case-insensitive key lookup in a header record. */
function findKey(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase()
  return Object.keys(headers).find((k) => k.toLowerCase() === lower)
}

function deleteHeader(headers: Record<string, string>, name: string): void {
  const key = findKey(headers, name)
  if (key !== undefined) delete headers[key]
}

/**
 * Send one HTTP request and resolve with the final response.
 *
 * - 4xx/5xx resolve normally; only transport-level failures (DNS, connection
 *   refused, timeout, TLS, malformed body encoding) reject.
 * - Redirects are followed per curl -L semantics: 303 always becomes GET
 *   without body, 301/302 become GET without body for non-GET/HEAD methods,
 *   307/308 preserve method and body. Up to 10 hops.
 * - timeMs spans from request start to final body end (across redirects).
 * - sizeBytes is the received (wire) body byte length of the final response.
 */
export function sendHttp(req: SendHttpRequest, jar?: CookieJar): Promise<HttpResponseModel> {
  return new Promise<HttpResponseModel>((resolve, reject) => {
    const opts = req.options ?? {}
    const timeoutSeconds = opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS
    const followRedirects = opts.followRedirects ?? true
    const start = process.hrtime.bigint()

    let settled = false
    let currentReq: ClientRequest | undefined
    let currentRes: IncomingMessage | undefined

    const timer = setTimeout(() => {
      fail(new Error(`Request timed out after ${timeoutSeconds}s`))
      currentRes?.destroy()
      currentReq?.destroy()
    }, timeoutSeconds * 1000)

    function fail(err: Error): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    }

    function succeed(response: HttpResponseModel): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(response)
    }

    // Base headers, caller casing preserved; duplicates folded with ", ".
    const baseHeaders: Record<string, string> = {}
    for (const h of req.headers) {
      const existing = findKey(baseHeaders, h.name)
      if (existing !== undefined) baseHeaders[existing] += ', ' + h.value
      else baseHeaders[h.name] = h.value
    }
    if (opts.user !== undefined && findKey(baseHeaders, 'authorization') === undefined) {
      baseHeaders['Authorization'] = 'Basic ' + Buffer.from(opts.user).toString('base64')
    }
    if (findKey(baseHeaders, 'accept-encoding') === undefined) {
      baseHeaders['Accept-Encoding'] = 'gzip, deflate, br'
    }
    if (findKey(baseHeaders, 'user-agent') === undefined) {
      baseHeaders['User-Agent'] = 'freepost'
    }
    // Host is set by node from the URL on every hop; never pinned here.

    function doRequest(
      method: string,
      urlStr: string,
      body: string | Buffer | undefined,
      hop: number,
      bodyDropped: boolean
    ): void {
      let url: URL
      try {
        url = new URL(urlStr)
      } catch {
        fail(new Error(`Invalid URL: ${urlStr}`))
        return
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        fail(new Error(`Unsupported protocol: ${url.protocol}//`))
        return
      }
      const isHttps = url.protocol === 'https:'

      const hopHeaders: Record<string, string> = { ...baseHeaders }
      if (bodyDropped) {
        // Redirect converted the request to GET: body headers no longer apply.
        deleteHeader(hopHeaders, 'content-length')
        deleteHeader(hopHeaders, 'content-type')
      }
      if (body !== undefined && findKey(hopHeaders, 'content-length') === undefined) {
        hopHeaders['Content-Length'] = String(Buffer.byteLength(body))
      }
      if (jar) {
        const cookie = jar.cookieHeader(url)
        if (cookie !== undefined) {
          const existing = findKey(hopHeaders, 'cookie')
          if (existing !== undefined) hopHeaders[existing] += '; ' + cookie
          else hopHeaders['Cookie'] = cookie
        }
      }

      const requestOptions: RequestOptions = {
        method,
        headers: hopHeaders,
        ...(isHttps && opts.insecure ? { rejectUnauthorized: false } : {})
      }
      const ca = opts.caCert !== undefined ? loadPem(opts.caCert) : undefined
      // TLS material — https only; ignored for plain http targets.
      if (isHttps) {
        if (opts.clientCert !== undefined) requestOptions.cert = loadPem(opts.clientCert)
        if (opts.clientKey !== undefined) requestOptions.key = loadPem(opts.clientKey)
        if (opts.clientKeyPassphrase !== undefined) {
          requestOptions.passphrase = opts.clientKeyPassphrase
        }
        if (ca !== undefined) requestOptions.ca = ca
      }

      // Proxy dispatch: https tunnels via CONNECT (createConnection returns the
      // TLS socket); http goes through the proxy in absolute-form.
      const proxy = parseProxy(opts.proxy)
      if (proxy !== undefined && isHttps) {
        requestOptions.createConnection = proxyTunnel(proxy, true, {
          insecure: opts.insecure,
          ca,
          servername: url.hostname
        }) as unknown as RequestOptions['createConnection']
      }

      const onResponse = (res: IncomingMessage): void => {
        currentRes = res
        if (jar && res.headers['set-cookie']) {
          jar.storeFromResponse(url, res.headers['set-cookie'])
        }

        const status = res.statusCode ?? 0
        const location = res.headers['location']

        if (followRedirects && REDIRECT_STATUSES.has(status) && location !== undefined) {
          if (hop >= MAX_REDIRECTS) {
            fail(new Error(`Too many redirects (exceeded ${MAX_REDIRECTS})`))
            res.resume()
            return
          }
          let nextUrl: string
          try {
            nextUrl = new URL(location, url).toString()
          } catch {
            fail(new Error(`Invalid redirect Location: ${location}`))
            res.resume()
            return
          }
          // curl -L semantics: 303 always becomes GET; 301/302 become GET for
          // non-GET/HEAD methods; 307/308 preserve method and body.
          let nextMethod = method
          let nextBody = body
          let nextDropped = bodyDropped
          if (
            status === 303 ||
            ((status === 301 || status === 302) && method !== 'GET' && method !== 'HEAD')
          ) {
            nextMethod = 'GET'
            nextBody = undefined
            nextDropped = true
          }
          res.resume() // drain this hop
          res.on('end', () => doRequest(nextMethod, nextUrl, nextBody, hop + 1, nextDropped))
          res.on('error', (err) => fail(err))
          return
        }

        // Final response: decompress per Content-Encoding, count wire bytes.
        const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase()
        let bodyStream: NodeJS.ReadableStream = res
        if (encoding === 'gzip' || encoding === 'x-gzip') bodyStream = res.pipe(createGunzip())
        else if (encoding === 'deflate') bodyStream = res.pipe(createInflate())
        else if (encoding === 'br') bodyStream = res.pipe(createBrotliDecompress())

        let sizeBytes = 0
        res.on('data', (chunk: Buffer) => {
          sizeBytes += chunk.length
        })

        const chunks: Buffer[] = []
        bodyStream.on('data', (chunk: Buffer) => chunks.push(chunk))
        bodyStream.on('error', (err: Error) => fail(err))
        bodyStream.on('end', () => {
          const timeMs = Number(process.hrtime.bigint() - start) / 1e6
          const headers: Header[] = []
          for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
            headers.push({ name: res.rawHeaders[i], value: res.rawHeaders[i + 1] })
          }
          succeed({
            status,
            statusText: res.statusMessage ?? '',
            headers,
            bodyText: Buffer.concat(chunks).toString('utf8'),
            timeMs,
            sizeBytes
          })
        })
      }

      let request: ClientRequest
      if (proxy !== undefined && !isHttps) {
        // HTTP forward proxy: dispatch to the proxy with the target's absolute
        // URL as the request-target (RFC 7230 §5.3.2), plus proxy auth.
        const auth = proxyAuthHeader(proxy)
        if (auth !== undefined) hopHeaders['Proxy-Authorization'] = auth
        request = httpRequest(
          {
            host: proxy.hostname,
            port: Number(proxy.port) || 80,
            method,
            path: url.href,
            headers: hopHeaders
          },
          onResponse
        )
      } else {
        request = (isHttps ? httpsRequest : httpRequest)(url, requestOptions, onResponse)
      }

      currentReq = request
      request.on('error', (err) => fail(err))
      if (body !== undefined) request.write(body)
      request.end()
    }

    doRequest(req.method.toUpperCase(), req.url, req.bodyBuffer ?? req.bodyText, 0, false)
  })
}
