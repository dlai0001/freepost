/**
 * Server-sent event stream parser (the record proxy's SSE view). Pure and
 * dependency-free so the renderer can parse a captured body without a
 * round-trip to main, and nothing here throws — the proxy caps response bodies
 * at 64 KiB and tees them while they stream, so a body cut mid-event is the
 * normal case, not a bug.
 *
 * Field handling follows the WHATWG event-stream spec (HTML §9.2.6):
 *   - one leading U+FEFF BOM is ignored (a second one is not: it is part of the
 *     first field's name). Real UTF-8 writers emit it — ASP.NET/IIS and Java
 *     ones do — and keeping it would silently drop the stream's first event;
 *   - lines end with CRLF, CR or LF, any mix;
 *   - a line starting with ':' is a comment and is ignored;
 *   - `field: value` splits on the FIRST colon and one leading space of the
 *     value is stripped; a line with no colon is a field with an empty value;
 *   - `data` lines accumulate and are joined with \n; a blank line dispatches
 *     the buffered event, and a block with no data dispatches nothing;
 *   - `id` and `retry` are stream state, not per-event fields: both persist
 *     until changed, so they are reported on every event they were in effect
 *     for (this is what an EventSource would have seen);
 *   - a `retry` that isn't all ASCII digits, and an `id` containing NUL, are
 *     ignored per spec.
 *
 * The text after the last block boundary is returned as `trailing` rather than
 * dropped: on a truncated capture that text is a real event the server sent
 * whose terminator never arrived, and hiding it would misreport the stream.
 */

/** One dispatched event. `event` absent means the default type ("message"). */
export interface SseEvent {
  event?: string
  id?: string
  retry?: number
  /** Joined `data:` lines, without the trailing newline the spec strips. */
  data: string
}

export interface SseStream {
  events: SseEvent[]
  /** Un-dispatched text after the last blank line — a partial final event. */
  trailing?: string
}

/** Offsets of the next line terminator at or after `from`, or null. */
function nextNewline(text: string, from: number): { start: number; end: number } | null {
  for (let i = from; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\n') return { start: i, end: i + 1 }
    if (ch === '\r') return { start: i, end: text[i + 1] === '\n' ? i + 2 : i + 1 }
  }
  return null
}

/** Parse an event-stream body. Never throws; any input is a valid stream. */
export function parseSse(body: string): SseStream {
  // Spec: strip ONE leading BOM before parsing. Offsets (and so `trailing`) are
  // the stripped stream's, which is the stream an EventSource would have seen.
  const text = body.startsWith('\uFEFF') ? body.slice(1) : body
  const events: SseEvent[] = []
  let data: string[] = []
  let eventType: string | undefined
  // Sticky per spec: the last-event-ID and reconnection-time buffers are not
  // reset by a dispatch, only by a new field.
  let id: string | undefined
  let retry: number | undefined

  const dispatch = (): void => {
    // No data means no event — a block of bare `id:`/`retry:`/comments only
    // updates stream state.
    if (data.length > 0) {
      events.push({
        ...(eventType !== undefined ? { event: eventType } : {}),
        ...(id !== undefined ? { id } : {}),
        ...(retry !== undefined ? { retry } : {}),
        data: data.join('\n')
      })
    }
    data = []
    eventType = undefined
  }

  let pos = 0
  let boundary = 0
  while (pos < text.length) {
    const nl = nextNewline(text, pos)
    // An unterminated last line is incomplete input — it stays in `trailing`.
    if (nl === null) break
    const line = text.slice(pos, nl.start)
    pos = nl.end
    if (line === '') {
      dispatch()
      boundary = pos
      continue
    }
    if (line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') data.push(value)
    else if (field === 'event') eventType = value
    else if (field === 'id') {
      // Spec: an id containing NUL is ignored outright, not truncated.
      if (!value.includes('\u0000')) id = value
    } else if (field === 'retry') {
      if (/^\d+$/.test(value)) retry = Number(value)
    }
    // Any other field name is ignored per spec.
  }

  const trailing = text.slice(boundary)
  return { events, ...(trailing !== '' ? { trailing } : {}) }
}

/** OpenAI's end-of-stream sentinel: the one `data:` that isn't JSON. */
const DONE_SENTINEL = '[DONE]'

/** The event's text contribution, or null when it carries no delta. */
function deltaText(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>

  // OpenAI chat completions: choices[0].delta.content.
  const choices = obj.choices
  if (Array.isArray(choices)) {
    const first: unknown = choices[0]
    if (first !== null && typeof first === 'object') {
      const delta: unknown = (first as Record<string, unknown>).delta
      if (delta !== null && typeof delta === 'object') {
        const content: unknown = (delta as Record<string, unknown>).content
        return typeof content === 'string' ? content : null
      }
    }
  }

  // Anthropic messages: content_block_delta carries delta.text.
  const delta = obj.delta
  if (delta !== null && typeof delta === 'object') {
    const t: unknown = (delta as Record<string, unknown>).text
    if (typeof t === 'string') return t
  }

  return null
}

/**
 * The accumulated message text for a token-streaming response, or null when
 * this isn't one — which is what gates the renderer's "concatenate deltas"
 * toggle.
 *
 * Availability is deliberately shape-driven, not vendor-sniffed: every event
 * must be JSON (bar the [DONE] sentinel) and at least one must carry a delta.
 * That accepts the envelope events a real stream interleaves (OpenAI's
 * role-only and finish_reason chunks, Anthropic's message_start / ping /
 * content_block_stop) while rejecting a stream that merely happens to be JSON.
 */
export function accumulateDeltas(events: SseEvent[]): string | null {
  let out = ''
  let found = false
  for (const e of events) {
    if (e.data === DONE_SENTINEL) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(e.data)
    } catch {
      return null // not a JSON stream — nothing to accumulate
    }
    if (parsed === null || typeof parsed !== 'object') return null
    const text = deltaText(parsed)
    if (text !== null) {
      out += text
      found = true
    }
  }
  return found ? out : null
}
