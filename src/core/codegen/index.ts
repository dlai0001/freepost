/**
 * Code generation — turn a parsed RequestFile into a runnable snippet in a
 * target language. Pure string generation; no network, no dependencies.
 *
 *   CODEGEN_TARGETS            — the supported targets (id/label/language).
 *   generateCode(file, target) — a snippet for the request in that language.
 *
 * ${VAR} shell-style references in url/headers/body are left VERBATIM as
 * literal text in the output — resolving them is the app's job, not codegen's.
 */
import type {
  CodegenTarget,
  CodegenTargetInfo,
  Header,
  HttpRequestModel,
  RequestFile,
  WsRequestModel,
} from '@shared/model'

export const CODEGEN_TARGETS: CodegenTargetInfo[] = [
  { id: 'curl', label: 'cURL', language: 'shell' },
  { id: 'python-requests', label: 'Python — requests', language: 'python' },
  { id: 'javascript-fetch', label: 'JavaScript — fetch', language: 'javascript' },
  { id: 'node-fetch', label: 'Node.js — node-fetch', language: 'javascript' },
  { id: 'go', label: 'Go — net/http', language: 'go' },
  { id: 'ruby', label: 'Ruby — net/http', language: 'ruby' },
  { id: 'php', label: 'PHP — cURL', language: 'php' },
  { id: 'httpie', label: 'HTTPie', language: 'shell' },
]

export function generateCode(file: RequestFile, target: CodegenTarget): string {
  if (file.kind === 'websocat') {
    const ws = file.ws
    if (!ws) return '# no websocket model'
    return generateWs(ws, target)
  }
  const http = file.http
  if (!http) return '# no http model'
  switch (target) {
    case 'curl':
      return genCurl(http)
    case 'python-requests':
      return genPython(http)
    case 'javascript-fetch':
      return genFetch(http, false)
    case 'node-fetch':
      return genFetch(http, true)
    case 'go':
      return genGo(http)
    case 'ruby':
      return genRuby(http)
    case 'php':
      return genPhp(http)
    case 'httpie':
      return genHttpie(http)
    default:
      return assertNever(target)
  }
}

function assertNever(x: never): string {
  return `# unsupported target: ${String(x)}`
}

/* ------------------------------- helpers -------------------------------- */

/** Parse "user:pass" (either half may be empty / contain ${VAR}). */
function splitUser(user: string): { user: string; pass: string } {
  const i = user.indexOf(':')
  if (i < 0) return { user, pass: '' }
  return { user: user.slice(0, i), pass: user.slice(i + 1) }
}

function rawBody(http: HttpRequestModel): string | undefined {
  return http.body && http.body.kind === 'raw' ? http.body.value : undefined
}
function fileBody(http: HttpRequestModel): string | undefined {
  return http.body && http.body.kind === 'file' ? http.body.value : undefined
}

/** Escape for a single-quoted shell string ('' style with '\'' idiom). */
function shSingle(s: string): string {
  return `'${s.split("'").join("'\\''")}'`
}

/** Escape for a double-quoted string in C-family languages (JS/Go/PHP/Ruby). */
function dq(s: string): string {
  let out = '"'
  for (const c of s) {
    if (c === '\\') out += '\\\\'
    else if (c === '"') out += '\\"'
    else if (c === '\n') out += '\\n'
    else if (c === '\r') out += '\\r'
    else if (c === '\t') out += '\\t'
    else out += c
  }
  return out + '"'
}

/** Python string literal (single-quoted, escaped). */
function pyStr(s: string): string {
  let out = "'"
  for (const c of s) {
    if (c === '\\') out += '\\\\'
    else if (c === "'") out += "\\'"
    else if (c === '\n') out += '\\n'
    else if (c === '\r') out += '\\r'
    else if (c === '\t') out += '\\t'
    else out += c
  }
  return out + "'"
}

/* --------------------------------- curl --------------------------------- */

function genCurl(http: HttpRequestModel): string {
  const parts: string[] = ['curl']
  if (http.method && http.method.toUpperCase() !== 'GET') {
    parts.push(`-X ${http.method.toUpperCase()}`)
  }
  parts.push(shSingle(http.url))
  for (const h of http.headers) {
    parts.push(`-H ${shSingle(`${h.name}: ${h.value}`)}`)
  }
  if (http.options.user) parts.push(`-u ${shSingle(http.options.user)}`)
  if (http.options.insecure) parts.push('-k')
  if (http.options.followRedirects) parts.push('-L')
  if (typeof http.options.timeoutSeconds === 'number') {
    parts.push(`--max-time ${http.options.timeoutSeconds}`)
  }
  const raw = rawBody(http)
  const fpath = fileBody(http)
  if (raw !== undefined) parts.push(`--data ${shSingle(raw)}`)
  else if (fpath !== undefined) parts.push(`--data ${shSingle('@' + fpath)}`)
  // one flag per line, backslash-continued
  return parts.join(' \\\n  ')
}

/* -------------------------------- python -------------------------------- */

function genPython(http: HttpRequestModel): string {
  const lines: string[] = ['import requests', '']
  const method = (http.method || 'GET').toLowerCase()
  const headers = http.headers
  if (headers.length) {
    lines.push('headers = {')
    for (const h of headers) lines.push(`    ${pyStr(h.name)}: ${pyStr(h.value)},`)
    lines.push('}')
  }
  const kwargs: string[] = [pyStr(http.url)]
  if (headers.length) kwargs.push('headers=headers')
  const raw = rawBody(http)
  const fpath = fileBody(http)
  if (raw !== undefined) kwargs.push(`data=${pyStr(raw)}`)
  else if (fpath !== undefined) kwargs.push(`data=open(${pyStr(fpath)}, 'rb')`)
  if (http.options.user) {
    const { user, pass } = splitUser(http.options.user)
    kwargs.push(`auth=(${pyStr(user)}, ${pyStr(pass)})`)
  }
  if (http.options.insecure) kwargs.push('verify=False')
  if (http.options.followRedirects === false) kwargs.push('allow_redirects=False')
  if (typeof http.options.timeoutSeconds === 'number') {
    kwargs.push(`timeout=${http.options.timeoutSeconds}`)
  }
  lines.push('')
  lines.push(`response = requests.${method}(${kwargs.join(', ')})`)
  lines.push('print(response.status_code)')
  lines.push('print(response.text)')
  return lines.join('\n')
}

/* --------------------------- javascript / node -------------------------- */

function genFetch(http: HttpRequestModel, node: boolean): string {
  const lines: string[] = []
  if (node) lines.push("import fetch from 'node-fetch'", '')

  const method = (http.method || 'GET').toUpperCase()
  const opt: string[] = [`  method: ${dq(method)}`]

  const headers = [...http.headers]
  // Basic auth -> Authorization header note (base64 not resolved: use literal token).
  if (http.options.user) {
    // Represent with btoa at runtime so ${VAR} refs would break base64; instead
    // emit a literal Authorization header built from the user string.
    headers.push({ name: 'Authorization', value: `Basic <base64 of ${http.options.user}>` })
  }
  if (headers.length) {
    const hlines = headers.map((h) => `    ${dq(h.name)}: ${dq(h.value)}`)
    opt.push(`  headers: {\n${hlines.join(',\n')}\n  }`)
  }
  const raw = rawBody(http)
  const fpath = fileBody(http)
  if (raw !== undefined) {
    opt.push(`  body: ${dq(raw)}`)
  } else if (fpath !== undefined) {
    if (node) opt.push(`  body: fs.readFileSync(${dq(fpath)})`)
    else opt.push(`  body: await fetch(${dq(fpath)}).then(r => r.blob())`)
  }
  if (http.options.followRedirects === false) opt.push(`  redirect: 'manual'`)

  if (node && fpath !== undefined) lines.push("import fs from 'node:fs'", '')

  lines.push(`const response = await fetch(${dq(http.url)}, {`)
  lines.push(opt.join(',\n'))
  lines.push('})')
  lines.push('const data = await response.text()')
  lines.push('console.log(response.status)')
  lines.push('console.log(data)')
  if (http.options.insecure && node) {
    lines.unshift("// insecure TLS: run with NODE_TLS_REJECT_UNAUTHORIZED=0 or pass a custom https.Agent")
  } else if (http.options.insecure) {
    lines.unshift('// note: browsers cannot disable TLS verification (insecure flag ignored)')
  }
  return lines.join('\n')
}

/* ---------------------------------- go ---------------------------------- */

function genGo(http: HttpRequestModel): string {
  const method = (http.method || 'GET').toUpperCase()
  const lines: string[] = []
  lines.push('package main', '')
  const imports = ['\t"fmt"', '\t"io"', '\t"net/http"']
  const raw = rawBody(http)
  const fpath = fileBody(http)
  const needsStrings = raw !== undefined
  const needsOs = fpath !== undefined
  const needsTls = !!http.options.insecure
  if (needsStrings) imports.push('\t"strings"')
  if (needsOs) imports.push('\t"os"')
  if (needsTls) imports.push('\t"crypto/tls"')
  imports.sort()
  lines.push('import (')
  lines.push(...imports)
  lines.push(')', '')
  lines.push('func main() {')

  let bodyExpr = 'nil'
  if (raw !== undefined) {
    lines.push(`\tbody := strings.NewReader(${dq(raw)})`)
    bodyExpr = 'body'
  } else if (fpath !== undefined) {
    lines.push(`\tbody, _ := os.Open(${dq(fpath)})`)
    lines.push('\tdefer body.Close()')
    bodyExpr = 'body'
  }
  lines.push(`\treq, _ := http.NewRequest(${dq(method)}, ${dq(http.url)}, ${bodyExpr})`)
  for (const h of http.headers) {
    lines.push(`\treq.Header.Set(${dq(h.name)}, ${dq(h.value)})`)
  }
  if (http.options.user) {
    const { user, pass } = splitUser(http.options.user)
    lines.push(`\treq.SetBasicAuth(${dq(user)}, ${dq(pass)})`)
  }

  if (needsTls || http.options.followRedirects === false) {
    lines.push('\tclient := &http.Client{}')
    if (needsTls) {
      lines.push('\tclient.Transport = &http.Transport{')
      lines.push('\t\tTLSClientConfig: &tls.Config{InsecureSkipVerify: true},')
      lines.push('\t}')
    }
    if (http.options.followRedirects === false) {
      lines.push('\tclient.CheckRedirect = func(req *http.Request, via []*http.Request) error {')
      lines.push('\t\treturn http.ErrUseLastResponse')
      lines.push('\t}')
    }
    lines.push('\tresp, err := client.Do(req)')
  } else {
    lines.push('\tresp, err := http.DefaultClient.Do(req)')
  }
  lines.push('\tif err != nil {')
  lines.push('\t\tpanic(err)')
  lines.push('\t}')
  lines.push('\tdefer resp.Body.Close()')
  lines.push('\tout, _ := io.ReadAll(resp.Body)')
  lines.push('\tfmt.Println(resp.Status)')
  lines.push('\tfmt.Println(string(out))')
  lines.push('}')
  return lines.join('\n')
}

/* --------------------------------- ruby --------------------------------- */

function genRuby(http: HttpRequestModel): string {
  const method = (http.method || 'GET').toUpperCase()
  const klass = rubyClass(method)
  const lines: string[] = ["require 'net/http'", "require 'uri'", '']
  lines.push(`uri = URI(${dq(http.url)})`)
  lines.push(`request = Net::HTTP::${klass}.new(uri)`)
  for (const h of http.headers) {
    lines.push(`request[${dq(h.name)}] = ${dq(h.value)}`)
  }
  if (http.options.user) {
    const { user, pass } = splitUser(http.options.user)
    lines.push(`request.basic_auth(${dq(user)}, ${dq(pass)})`)
  }
  const raw = rawBody(http)
  const fpath = fileBody(http)
  if (raw !== undefined) lines.push(`request.body = ${dq(raw)}`)
  else if (fpath !== undefined) lines.push(`request.body = File.read(${dq(fpath)})`)

  lines.push('')
  const opts: string[] = ['use_ssl: uri.scheme == "https"']
  if (http.options.insecure) opts.push('verify_mode: OpenSSL::SSL::VERIFY_NONE')
  lines.push(`response = Net::HTTP.start(uri.hostname, uri.port, ${opts.join(', ')}) do |http|`)
  lines.push('  http.request(request)')
  lines.push('end')
  lines.push('')
  lines.push('puts response.code')
  lines.push('puts response.body')
  return lines.join('\n')
}

function rubyClass(method: string): string {
  const m = method.toUpperCase()
  const map: Record<string, string> = {
    GET: 'Get',
    POST: 'Post',
    PUT: 'Put',
    DELETE: 'Delete',
    PATCH: 'Patch',
    HEAD: 'Head',
    OPTIONS: 'Options',
  }
  return map[m] || m.charAt(0) + m.slice(1).toLowerCase()
}

/* ---------------------------------- php --------------------------------- */

function genPhp(http: HttpRequestModel): string {
  const method = (http.method || 'GET').toUpperCase()
  const lines: string[] = ['<?php', '', '$ch = curl_init();', '']
  lines.push(`curl_setopt($ch, CURLOPT_URL, ${dq(http.url)});`)
  lines.push('curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);')
  lines.push(`curl_setopt($ch, CURLOPT_CUSTOMREQUEST, ${dq(method)});`)

  if (http.headers.length) {
    const hlines = http.headers.map((h) => `    ${dq(`${h.name}: ${h.value}`)},`)
    lines.push('curl_setopt($ch, CURLOPT_HTTPHEADER, [')
    lines.push(...hlines)
    lines.push(']);')
  }
  if (http.options.user) {
    lines.push(`curl_setopt($ch, CURLOPT_USERPWD, ${dq(http.options.user)});`)
  }
  const raw = rawBody(http)
  const fpath = fileBody(http)
  if (raw !== undefined) {
    lines.push(`curl_setopt($ch, CURLOPT_POSTFIELDS, ${dq(raw)});`)
  } else if (fpath !== undefined) {
    lines.push(`curl_setopt($ch, CURLOPT_POSTFIELDS, file_get_contents(${dq(fpath)}));`)
  }
  if (http.options.insecure) {
    lines.push('curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);')
    lines.push('curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 0);')
  }
  if (http.options.followRedirects) {
    lines.push('curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);')
  }
  if (typeof http.options.timeoutSeconds === 'number') {
    lines.push(`curl_setopt($ch, CURLOPT_TIMEOUT, ${http.options.timeoutSeconds});`)
  }
  lines.push('')
  lines.push('$response = curl_exec($ch);')
  lines.push('echo curl_getinfo($ch, CURLINFO_HTTP_CODE) . "\\n";')
  lines.push('echo $response;')
  lines.push('curl_close($ch);')
  return lines.join('\n')
}

/* -------------------------------- httpie -------------------------------- */

function genHttpie(http: HttpRequestModel): string {
  const parts: string[] = ['http']
  if (http.options.insecure) parts.push('--verify=no')
  if (http.options.followRedirects) parts.push('--follow')
  if (http.options.user) parts.push(`-a ${shSingle(http.options.user)}`)
  if (typeof http.options.timeoutSeconds === 'number') {
    parts.push(`--timeout=${http.options.timeoutSeconds}`)
  }
  parts.push((http.method || 'GET').toUpperCase())
  parts.push(shSingle(http.url))
  for (const h of http.headers) {
    parts.push(shSingle(`${h.name}:${h.value}`))
  }
  const raw = rawBody(http)
  const fpath = fileBody(http)
  if (raw !== undefined) {
    // Pipe the raw body on stdin; httpie reads it as the request body.
    return `echo ${shSingle(raw)} | ${parts.join(' \\\n  ')}`
  }
  if (fpath !== undefined) {
    parts.push(`< ${shSingle(fpath)}`)
  }
  return parts.join(' \\\n  ')
}

/* ------------------------------ websocket ------------------------------- */

function generateWs(ws: WsRequestModel, target: CodegenTarget): string {
  switch (target) {
    case 'python-requests':
      return wsPython(ws)
    case 'javascript-fetch':
    case 'node-fetch':
      return wsJs(ws, target === 'node-fetch')
    case 'curl':
    case 'httpie':
    case 'go':
    case 'ruby':
    case 'php':
    default:
      return wsCli(ws)
  }
}

function wsHeaderArgs(headers: Header[]): string {
  return headers.map((h) => ` -H ${shSingle(`${h.name}: ${h.value}`)}`).join('')
}

function wsCli(ws: WsRequestModel): string {
  const proto = ws.protocol ? ` --protocol ${shSingle(ws.protocol)}` : ''
  return [
    '# WebSocket — run with the websocat CLI:',
    `websocat${wsHeaderArgs(ws.headers)}${proto} ${shSingle(ws.url)}`,
  ].join('\n')
}

function wsPython(ws: WsRequestModel): string {
  const lines: string[] = ['import asyncio', 'import websockets', '']
  const extra: string[] = []
  if (ws.headers.length) {
    const hlines = ws.headers.map((h) => `        ${pyStr(h.name)}: ${pyStr(h.value)},`)
    extra.push('additional_headers={\n' + hlines.join('\n') + '\n    }')
  }
  if (ws.protocol) extra.push(`subprotocols=[${pyStr(ws.protocol)}]`)
  const connectArgs = [pyStr(ws.url), ...extra].join(', ')
  lines.push('async def main():')
  lines.push(`    async with websockets.connect(${connectArgs}) as ws:`)
  lines.push("        await ws.send('hello')")
  lines.push('        print(await ws.recv())')
  lines.push('')
  lines.push('asyncio.run(main())')
  return lines.join('\n')
}

function wsJs(ws: WsRequestModel, node: boolean): string {
  const lines: string[] = []
  if (node) lines.push("import WebSocket from 'ws'", '')
  const proto = ws.protocol ? `, ${dq(ws.protocol)}` : ''
  // Browser WebSocket cannot set arbitrary headers; note them for node ('ws' supports options).
  if (node && ws.headers.length) {
    const hlines = ws.headers.map((h) => `    ${dq(h.name)}: ${dq(h.value)}`)
    lines.push(`const ws = new WebSocket(${dq(ws.url)}${proto}, {`)
    lines.push('  headers: {')
    lines.push(hlines.join(',\n'))
    lines.push('  }')
    lines.push('})')
  } else {
    if (!node && ws.headers.length) {
      lines.push('// note: browser WebSocket cannot set custom connection headers')
    }
    lines.push(`const ws = new WebSocket(${dq(ws.url)}${proto})`)
  }
  lines.push("ws.addEventListener('open', () => ws.send('hello'))")
  lines.push("ws.addEventListener('message', (e) => console.log(e.data))")
  return lines.join('\n')
}
