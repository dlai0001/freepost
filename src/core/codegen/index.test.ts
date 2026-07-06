import { describe, it, expect } from 'vitest'
import type { CodegenTarget, RequestFile } from '@shared/model'
import { CODEGEN_TARGETS, generateCode } from './index'

const ALL: CodegenTarget[] = [
  'curl',
  'python-requests',
  'javascript-fetch',
  'node-fetch',
  'go',
  'ruby',
  'php',
  'httpie',
]

/** GET with headers and a ${VAR} in the URL. */
const getReq: RequestFile = {
  kind: 'curl',
  frontmatter: {},
  variables: [],
  comments: [],
  http: {
    method: 'GET',
    url: 'https://${BASE_URL}/users?active=true',
    headers: [
      { name: 'Accept', value: 'application/json' },
      { name: 'Authorization', value: 'Bearer ${TOKEN}' },
    ],
    options: {},
  },
}

/** POST with a JSON body. */
const postReq: RequestFile = {
  kind: 'curl',
  frontmatter: {},
  variables: [],
  comments: [],
  http: {
    method: 'POST',
    url: 'https://api.example.com/items',
    headers: [{ name: 'Content-Type', value: 'application/json' }],
    body: { kind: 'raw', value: '{"name":"widget","qty":3}' },
    options: {},
  },
}

const wsReq: RequestFile = {
  kind: 'websocat',
  frontmatter: {},
  variables: [],
  comments: [],
  ws: {
    url: 'wss://${WS_HOST}/socket',
    headers: [{ name: 'Origin', value: 'https://example.com' }],
    protocol: 'chat',
  },
}

describe('CODEGEN_TARGETS', () => {
  it('has 8 entries with the correct ids', () => {
    expect(CODEGEN_TARGETS).toHaveLength(8)
    expect(CODEGEN_TARGETS.map((t) => t.id).sort()).toEqual([...ALL].sort())
    for (const t of CODEGEN_TARGETS) {
      expect(t.label).toBeTruthy()
      expect(t.language).toBeTruthy()
    }
  })
})

describe('generateCode — GET with headers', () => {
  for (const target of ALL) {
    it(`${target}: contains url, headers, and preserves \${VAR}`, () => {
      const out = generateCode(getReq, target)
      expect(out.length).toBeGreaterThan(0)
      // url survives verbatim (with ${VAR})
      expect(out).toContain('https://${BASE_URL}/users?active=true')
      // header names present
      expect(out).toContain('Accept')
      expect(out).toContain('Authorization')
      // ${VAR} inside header value survives
      expect(out).toContain('Bearer ${TOKEN}')
    })
  }

  it('curl: has method GET implied and header flags', () => {
    const out = generateCode(getReq, 'curl')
    expect(out.startsWith('curl')).toBe(true)
    expect(out).toContain('-H')
    // GET is the default, no -X GET emitted
    expect(out).not.toContain('-X GET')
  })

  it('python-requests: uses requests.get', () => {
    const out = generateCode(getReq, 'python-requests')
    expect(out).toContain('import requests')
    expect(out).toContain('requests.get(')
  })

  it('httpie: includes GET verb and header colon syntax', () => {
    const out = generateCode(getReq, 'httpie')
    expect(out).toContain('http')
    expect(out).toContain('GET')
    expect(out).toContain('Accept:application/json')
  })
})

describe('generateCode — POST with JSON body', () => {
  for (const target of ALL) {
    it(`${target}: contains method, url, content-type, and body`, () => {
      const out = generateCode(postReq, target)
      expect(out.length).toBeGreaterThan(0)
      expect(out).toContain('https://api.example.com/items')
      expect(out).toContain('Content-Type')
      // body JSON present (quotes may be escaped, but the fragment survives)
      expect(out).toContain('widget')
      expect(out).toContain('qty')
    })
  }

  it('curl: emits -X POST and --data', () => {
    const out = generateCode(postReq, 'curl')
    expect(out).toContain('-X POST')
    expect(out).toContain('--data')
  })

  it('python-requests: uses requests.post with data=', () => {
    const out = generateCode(postReq, 'python-requests')
    expect(out).toContain('requests.post(')
    expect(out).toContain('data=')
  })

  it('go: builds a POST request with net/http', () => {
    const out = generateCode(postReq, 'go')
    expect(out).toContain('net/http')
    expect(out).toContain('"POST"')
    expect(out).toContain('http.NewRequest')
  })

  it('ruby: uses Net::HTTP::Post and sets body', () => {
    const out = generateCode(postReq, 'ruby')
    expect(out).toContain('Net::HTTP::Post')
    expect(out).toContain('request.body =')
  })

  it('php: uses curl_setopt POSTFIELDS', () => {
    const out = generateCode(postReq, 'php')
    expect(out).toContain('CURLOPT_POSTFIELDS')
    expect(out).toContain('CURLOPT_CUSTOMREQUEST')
  })

  it('node-fetch: imports node-fetch and sets body', () => {
    const out = generateCode(postReq, 'node-fetch')
    expect(out).toContain("from 'node-fetch'")
    expect(out).toContain('body:')
    expect(out).toContain('method: "POST"')
  })

  it('javascript-fetch: does NOT import node-fetch', () => {
    const out = generateCode(postReq, 'javascript-fetch')
    expect(out).not.toContain('node-fetch')
    expect(out).toContain('await fetch(')
  })
})

describe('basic auth', () => {
  const authReq: RequestFile = {
    ...getReq,
    http: { ...getReq.http!, options: { user: 'alice:${SECRET}' } },
  }

  it('curl: emits -u', () => {
    expect(generateCode(authReq, 'curl')).toContain("-u 'alice:${SECRET}'")
  })
  it('python: emits auth tuple', () => {
    const out = generateCode(authReq, 'python-requests')
    expect(out).toContain("auth=('alice', '${SECRET}')")
  })
  it('go: emits SetBasicAuth', () => {
    expect(generateCode(authReq, 'go')).toContain('req.SetBasicAuth("alice", "${SECRET}")')
  })
  it('ruby: emits basic_auth', () => {
    expect(generateCode(authReq, 'ruby')).toContain('request.basic_auth("alice", "${SECRET}")')
  })
  it('php: emits USERPWD', () => {
    expect(generateCode(authReq, 'php')).toContain('CURLOPT_USERPWD')
  })
  it('httpie: emits -a', () => {
    expect(generateCode(authReq, 'httpie')).toContain('-a')
  })
})

describe('insecure (skip TLS verify)', () => {
  const insecureReq: RequestFile = {
    ...getReq,
    http: { ...getReq.http!, options: { insecure: true } },
  }
  it('curl: -k', () => {
    expect(generateCode(insecureReq, 'curl')).toContain('-k')
  })
  it('python: verify=False', () => {
    expect(generateCode(insecureReq, 'python-requests')).toContain('verify=False')
  })
  it('go: InsecureSkipVerify', () => {
    expect(generateCode(insecureReq, 'go')).toContain('InsecureSkipVerify: true')
  })
  it('ruby: VERIFY_NONE', () => {
    expect(generateCode(insecureReq, 'ruby')).toContain('VERIFY_NONE')
  })
  it('php: SSL_VERIFYPEER false', () => {
    expect(generateCode(insecureReq, 'php')).toContain('CURLOPT_SSL_VERIFYPEER, false')
  })
  it('httpie: --verify=no', () => {
    expect(generateCode(insecureReq, 'httpie')).toContain('--verify=no')
  })
})

describe('followRedirects', () => {
  const redirReq: RequestFile = {
    ...getReq,
    http: { ...getReq.http!, options: { followRedirects: true } },
  }
  it('curl: -L', () => {
    expect(generateCode(redirReq, 'curl')).toContain('-L')
  })
  it('httpie: --follow', () => {
    expect(generateCode(redirReq, 'httpie')).toContain('--follow')
  })
  it('php: FOLLOWLOCATION', () => {
    expect(generateCode(redirReq, 'php')).toContain('CURLOPT_FOLLOWLOCATION')
  })
})

describe('file body', () => {
  const fileReq: RequestFile = {
    ...postReq,
    http: { ...postReq.http!, body: { kind: 'file', value: '/tmp/payload.json' } },
  }
  it('python: opens the file', () => {
    expect(generateCode(fileReq, 'python-requests')).toContain("open('/tmp/payload.json', 'rb')")
  })
  it('curl: --data @path', () => {
    expect(generateCode(fileReq, 'curl')).toContain("@/tmp/payload.json")
  })
  it('ruby: File.read', () => {
    expect(generateCode(fileReq, 'ruby')).toContain('File.read("/tmp/payload.json")')
  })
  it('php: file_get_contents', () => {
    expect(generateCode(fileReq, 'php')).toContain('file_get_contents("/tmp/payload.json")')
  })
})

describe('all targets produce non-empty output', () => {
  for (const target of ALL) {
    it(`${target} (GET)`, () => {
      expect(generateCode(getReq, target).trim().length).toBeGreaterThan(0)
    })
    it(`${target} (POST)`, () => {
      expect(generateCode(postReq, target).trim().length).toBeGreaterThan(0)
    })
  }
})

describe('websocat smoke test', () => {
  for (const target of ALL) {
    it(`${target}: non-empty ws output containing the url`, () => {
      const out = generateCode(wsReq, target)
      expect(out.trim().length).toBeGreaterThan(0)
      expect(out).toContain('wss://${WS_HOST}/socket')
    })
  }

  it('python: uses websockets.connect', () => {
    expect(generateCode(wsReq, 'python-requests')).toContain('websockets.connect(')
  })
  it('javascript: uses new WebSocket', () => {
    expect(generateCode(wsReq, 'javascript-fetch')).toContain('new WebSocket(')
  })
  it('node: imports ws and uses new WebSocket', () => {
    const out = generateCode(wsReq, 'node-fetch')
    expect(out).toContain("from 'ws'")
    expect(out).toContain('new WebSocket(')
  })
  it('other targets: reference websocat CLI', () => {
    expect(generateCode(wsReq, 'go')).toContain('websocat')
  })
})
