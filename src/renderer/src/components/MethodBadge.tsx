import type { JSX } from 'react'
const CLASS_BY_METHOD: Record<string, string> = {
  GET: 'get',
  POST: 'post',
  PUT: 'put',
  PATCH: 'patch',
  DELETE: 'delete',
  HEAD: 'head',
  OPTIONS: 'options',
  WS: 'ws'
}

const SHORT: Record<string, string> = { DELETE: 'DEL', OPTIONS: 'OPT', PATCH: 'PATCH' }

/** Colored verb badge. `method` may be 'WS' for websocket files. */
export default function MethodBadge({ method }: { method?: string }): JSX.Element {
  const m = (method ?? '').toUpperCase()
  const cls = CLASS_BY_METHOD[m] ?? 'other'
  const label = m === '' ? 'REQ' : (SHORT[m] ?? m)
  return <span className={`badge badge-${cls}`}>{label}</span>
}
