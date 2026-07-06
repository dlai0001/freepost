import { describe, expect, it } from 'vitest'
import type { Frontmatter, HttpRequestModel, SearchEntry, WsRequestModel } from '@shared/model'
import { buildSearchEntry, queryIndex } from './index'

const http = (method: string, url: string): HttpRequestModel => ({
  method,
  url,
  headers: [],
  options: {}
})

describe('buildSearchEntry', () => {
  it('builds a request entry: name from basename, labels/description from frontmatter, method/url from http', () => {
    const fm: Frontmatter = {
      description: 'Fetches a single user record by id',
      label: ['users', 'smoke']
    }
    const entry = buildSearchEntry(
      'users/Get user by id.curl',
      'request',
      fm,
      http('GET', 'https://${BASE_URL}/api/users/${USER_ID}')
    )
    expect(entry).toEqual({
      path: 'users/Get user by id.curl',
      name: 'Get user by id',
      type: 'request',
      labels: ['users', 'smoke'],
      description: 'Fetches a single user record by id',
      method: 'GET',
      url: 'https://${BASE_URL}/api/users/${USER_ID}'
    })
  })

  it('builds a websocat entry with url from ws and no method', () => {
    const ws: WsRequestModel = {
      url: 'wss://${BASE_URL}/stream',
      headers: []
    }
    const entry = buildSearchEntry('streams/Ticker.ws', 'request', { label: ['streaming'] }, undefined, ws)
    expect(entry.name).toBe('Ticker')
    expect(entry.url).toBe('wss://${BASE_URL}/stream')
    expect(entry.method).toBeUndefined()
    expect(entry.labels).toEqual(['streaming'])
  })

  it('builds a workflow entry stripping .workflow.json and using wfDescription', () => {
    const entry = buildSearchEntry(
      'auth/Signup smoke test.workflow.json',
      'workflow',
      undefined,
      undefined,
      undefined,
      'End-to-end signup happy path'
    )
    expect(entry).toEqual({
      path: 'auth/Signup smoke test.workflow.json',
      name: 'Signup smoke test',
      type: 'workflow',
      labels: [],
      description: 'End-to-end signup happy path',
      method: undefined,
      url: undefined
    })
  })

  it('defaults labels to empty and description to undefined without frontmatter', () => {
    const entry = buildSearchEntry('Ping.curl', 'request', undefined, http('GET', 'https://x.test'))
    expect(entry.labels).toEqual([])
    expect(entry.description).toBeUndefined()
  })
})

describe('queryIndex', () => {
  const entries: SearchEntry[] = [
    {
      path: 'users/Get user by id.curl',
      name: 'Get user by id',
      type: 'request',
      labels: ['users', 'smoke'],
      description: 'Fetches a single user record',
      method: 'GET',
      url: 'https://api.example.com/api/users/42'
    },
    {
      path: 'users/Create user.curl',
      name: 'Create user',
      type: 'request',
      labels: ['users'],
      description: 'Creates a user account',
      method: 'POST',
      url: 'https://api.example.com/api/users'
    },
    {
      path: 'streams/Ticker.ws',
      name: 'Ticker',
      type: 'request',
      labels: ['streaming'],
      description: 'Live ticker stream',
      url: 'wss://api.example.com/stream'
    },
    {
      path: 'auth/Signup smoke test.workflow.json',
      name: 'Signup smoke test',
      type: 'workflow',
      labels: [],
      description: 'End-to-end signup happy path'
    }
  ]

  it('returns all entries, sorted by name, for an empty or whitespace query', () => {
    const names = (q: string) => queryIndex(entries, q).map((e) => e.name)
    expect(names('')).toEqual(['Create user', 'Get user by id', 'Signup smoke test', 'Ticker'])
    expect(names('   ')).toEqual(['Create user', 'Get user by id', 'Signup smoke test', 'Ticker'])
  })

  it('matches free text against name, description, url, and method', () => {
    expect(queryIndex(entries, 'ticker').map((e) => e.name)).toEqual(['Ticker']) // name
    expect(queryIndex(entries, 'happy path').map((e) => e.name)).toEqual(['Signup smoke test']) // description
    expect(queryIndex(entries, 'wss://').map((e) => e.name)).toEqual(['Ticker']) // url
    expect(queryIndex(entries, 'POST').map((e) => e.name)).toEqual(['Create user']) // method
  })

  it('is case-insensitive for free text and label filters', () => {
    expect(queryIndex(entries, 'TICKER').map((e) => e.name)).toEqual(['Ticker'])
    expect(queryIndex(entries, 'label:SMOKE').map((e) => e.name)).toEqual(['Get user by id'])
    expect(queryIndex(entries, 'LABEL:smoke').map((e) => e.name)).toEqual(['Get user by id'])
  })

  it('label: filters by exact label match, not substring', () => {
    expect(queryIndex(entries, 'label:users').map((e) => e.name)).toEqual([
      'Create user',
      'Get user by id'
    ])
    expect(queryIndex(entries, 'label:user')).toEqual([]) // no partial label match
    expect(queryIndex(entries, 'label:stream')).toEqual([]) // 'streaming' is not 'stream'
  })

  it('combines terms with AND, mixing label filters and free text', () => {
    expect(queryIndex(entries, 'label:users create').map((e) => e.name)).toEqual(['Create user'])
    expect(queryIndex(entries, 'label:users GET').map((e) => e.name)).toEqual(['Get user by id'])
    expect(queryIndex(entries, 'label:users label:smoke').map((e) => e.name)).toEqual([
      'Get user by id'
    ])
    expect(queryIndex(entries, 'label:users nonexistent')).toEqual([])
    expect(queryIndex(entries, 'user account').map((e) => e.name)).toEqual(['Create user'])
  })

  it('finds workflow entries via free text', () => {
    expect(queryIndex(entries, 'signup').map((e) => e.type)).toEqual(['workflow'])
  })

  it('sorts multi-result queries by name', () => {
    expect(queryIndex(entries, 'user').map((e) => e.name)).toEqual(['Create user', 'Get user by id'])
  })
})
