import type { JSX } from 'react'
import { useEffect, useRef } from 'react'

export type StreamDir = 'sent' | 'recv' | 'info' | 'error'

export interface StreamEntry {
  id: number
  dir: StreamDir
  text: string
  at: string
}

let streamEntryId = 1

/** Build a StreamEntry with a unique id + local timestamp. */
export function streamEntry(dir: StreamDir, text: string): StreamEntry {
  return { id: streamEntryId++, dir, text, at: new Date().toLocaleTimeString() }
}

function label(dir: StreamDir): string {
  if (dir === 'sent') return '↑ sent'
  if (dir === 'recv') return '↓ received'
  return dir
}

/**
 * Scrolling log of streamed messages — shared by the WebSocket tab and GraphQL
 * subscriptions. Auto-scrolls to the newest entry.
 */
export default function StreamLog({
  entries,
  empty
}: {
  entries: StreamEntry[]
  empty?: string
}): JSX.Element {
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [entries])

  return (
    <div className="ws-log">
      {entries.length === 0 && <div className="dim-note">{empty ?? 'No messages yet.'}</div>}
      {entries.map((e) => (
        <div key={e.id} className={`ws-msg ws-msg-${e.dir}`}>
          <div className="ws-msg-meta">
            {label(e.dir)} · {e.at}
          </div>
          <pre className="mono">{e.text}</pre>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  )
}
