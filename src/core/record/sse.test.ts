import { describe, expect, it } from 'vitest'
import { accumulateDeltas, parseSse } from './sse'
import type { SseStream } from './sse'

describe('parseSse', () => {
  const cases: { name: string; text: string; expected: SseStream }[] = [
    { name: 'the empty body', text: '', expected: { events: [] } },
    {
      name: 'a single event',
      text: 'data: hello\n\n',
      expected: { events: [{ data: 'hello' }] }
    },
    {
      name: 'multiple data lines joined with a newline',
      text: 'data: one\ndata: two\ndata: three\n\n',
      expected: { events: [{ data: 'one\ntwo\nthree' }] }
    },
    {
      name: 'a named event with id and retry',
      text: 'event: tick\nid: 7\nretry: 3000\ndata: {}\n\n',
      expected: { events: [{ event: 'tick', id: '7', retry: 3000, data: '{}' }] }
    },
    {
      name: 'comments (ignored) around real data',
      text: ': keep-alive\ndata: x\n: another\n\n',
      expected: { events: [{ data: 'x' }] }
    },
    {
      name: 'CRLF terminators',
      text: 'event: a\r\ndata: 1\r\n\r\n',
      expected: { events: [{ event: 'a', data: '1' }] }
    },
    {
      name: 'bare CR terminators',
      text: 'event: a\rdata: 1\r\r',
      expected: { events: [{ event: 'a', data: '1' }] }
    },
    {
      name: 'mixed terminators in one stream',
      text: 'data: a\r\n\ndata: b\r\r\ndata: c\n\n',
      expected: { events: [{ data: 'a' }, { data: 'b' }, { data: 'c' }] }
    },
    {
      name: 'only the first colon splitting the field',
      text: 'data: {"a":"b:c"}\n\n',
      expected: { events: [{ data: '{"a":"b:c"}' }] }
    },
    {
      name: 'exactly one leading space stripped',
      text: 'data:  two spaces\n\n',
      expected: { events: [{ data: ' two spaces' }] }
    },
    {
      name: 'a field with no colon as an empty value',
      text: 'data\ndata: x\n\n',
      expected: { events: [{ data: '\nx' }] }
    },
    {
      name: 'an empty data line preserved in the join',
      text: 'data: a\ndata:\ndata: b\n\n',
      expected: { events: [{ data: 'a\n\nb' }] }
    },
    {
      name: 'a blank block dispatching nothing',
      text: '\n\n\ndata: x\n\n',
      expected: { events: [{ data: 'x' }] }
    },
    {
      name: 'an id-only block updating state without dispatching',
      text: 'id: 1\n\ndata: x\n\n',
      expected: { events: [{ id: '1', data: 'x' }] }
    },
    {
      name: 'a sticky id carried to a later event',
      text: 'id: 1\ndata: a\n\ndata: b\n\n',
      expected: { events: [{ id: '1', data: 'a' }, { id: '1', data: 'b' }] }
    },
    {
      name: 'an event name NOT carried to a later event',
      text: 'event: tick\ndata: a\n\ndata: b\n\n',
      expected: { events: [{ event: 'tick', data: 'a' }, { data: 'b' }] }
    },
    {
      name: 'a non-numeric retry ignored',
      text: 'retry: soon\ndata: x\n\n',
      expected: { events: [{ data: 'x' }] }
    },
    {
      name: 'an id containing NUL ignored',
      text: 'id: a\u0000b\ndata: x\n\n',
      expected: { events: [{ data: 'x' }] }
    },
    {
      name: 'an unknown field ignored',
      text: 'foo: bar\ndata: x\n\n',
      expected: { events: [{ data: 'x' }] }
    },
    {
      name: 'a trailing partial event (capture cut mid-stream)',
      text: 'data: a\n\ndata: b',
      expected: { events: [{ data: 'a' }], trailing: 'data: b' }
    },
    {
      name: 'a trailing complete-but-undispatched event',
      text: 'data: a\n\ndata: b\n',
      expected: { events: [{ data: 'a' }], trailing: 'data: b\n' }
    },
    {
      name: 'a body cut mid-line',
      text: 'data: {"partial":tru',
      expected: { events: [], trailing: 'data: {"partial":tru' }
    },
    {
      name: 'no trailing when a comment block ends the body',
      text: 'data: a\n\n: bye\n\n',
      expected: { events: [{ data: 'a' }] }
    },
    {
      // Spec: one leading BOM is ignored. Kept from an IIS/Java writer it would
      // make the first field name U+FEFF+'data', silently dropping the event.
      name: 'a leading BOM ignored',
      text: '\uFEFFdata: hello\n\n',
      expected: { events: [{ data: 'hello' }] }
    },
    {
      // The second one lands in the field name, which no branch matches.
      name: 'only ONE BOM ignored — a second is a field-name character',
      text: '\uFEFF\uFEFFdata: hello\n\n',
      expected: { events: [] }
    },
    {
      name: 'a BOM elsewhere in the stream left alone',
      text: 'data: \uFEFFhello\n\n',
      expected: { events: [{ data: '\uFEFFhello' }] }
    }
  ]

  for (const c of cases) {
    it(`parses ${c.name}`, () => {
      expect(parseSse(c.text)).toEqual(c.expected)
    })
  }

  it('never throws on arbitrary input', () => {
    const chars = ['\r', '\n', ':', ' ', 'a', '\u0000', 'data', 'id', '{', '"']
    for (let seed = 0; seed < 300; seed++) {
      let text = ''
      for (let i = 0; i < 12; i++) text += chars[(seed * 7 + i * 13) % chars.length]
      expect(() => parseSse(text)).not.toThrow()
    }
  })
})

describe('accumulateDeltas', () => {
  /** One OpenAI-shaped chunk. */
  const openai = (content?: string, finish?: string): string =>
    JSON.stringify({
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      choices: [
        {
          index: 0,
          delta: content === undefined ? {} : { content },
          finish_reason: finish ?? null
        }
      ]
    })

  const cases: { name: string; datas: string[]; expected: string | null }[] = [
    {
      name: 'an OpenAI stream, envelope chunks and [DONE] included',
      datas: [openai(undefined), openai('Hello'), openai(' world'), openai(undefined, 'stop'), '[DONE]'],
      expected: 'Hello world'
    },
    {
      name: 'an Anthropic stream with its non-delta envelope events',
      datas: [
        JSON.stringify({ type: 'message_start', message: { id: 'msg_1' } }),
        JSON.stringify({ type: 'content_block_start', index: 0 }),
        JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } }),
        JSON.stringify({ type: 'ping' }),
        JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: ' there' } }),
        JSON.stringify({ type: 'content_block_stop', index: 0 }),
        JSON.stringify({ type: 'message_stop' })
      ],
      expected: 'Hi there'
    },
    {
      name: 'an empty-string delta contributing nothing but keeping availability',
      datas: [openai(''), openai('x')],
      expected: 'x'
    },
    {
      name: 'no events at all',
      datas: [],
      expected: null
    },
    // The negative cases: the toggle must not be offered for these.
    {
      name: 'a JSON stream with no deltas anywhere',
      datas: [JSON.stringify({ progress: 1 }), JSON.stringify({ progress: 2 })],
      expected: null
    },
    {
      name: 'a plain-text stream',
      datas: ['tick', 'tock'],
      expected: null
    },
    {
      name: 'a stream mixing deltas with non-JSON events',
      datas: [openai('Hello'), 'not json'],
      expected: null
    },
    {
      name: 'JSON scalars rather than objects',
      datas: ['1', '2'],
      expected: null
    },
    {
      name: 'a delta-shaped key holding the wrong type',
      datas: [JSON.stringify({ choices: [{ delta: { content: 42 } }] })],
      expected: null
    },
    {
      name: 'only the [DONE] sentinel',
      datas: ['[DONE]'],
      expected: null
    }
  ]

  for (const c of cases) {
    it(`handles ${c.name}`, () => {
      expect(accumulateDeltas(c.datas.map((data) => ({ data })))).toBe(c.expected)
    })
  }

  const hostile: unknown[] = [
    { choices: null },
    { choices: [] },
    { choices: [null] },
    { choices: [{ delta: null }] },
    { choices: [{}] },
    { choices: 'nope' },
    { delta: null },
    { delta: { text: null } },
    { delta: [] },
    {}
  ]

  it('never throws on delta-adjacent shapes that do not match', () => {
    for (const shape of hostile) {
      expect(() => accumulateDeltas([{ data: JSON.stringify(shape) }])).not.toThrow()
      expect(accumulateDeltas([{ data: JSON.stringify(shape) }])).toBeNull()
    }
  })

  it('accumulates a real captured stream end to end', () => {
    const body =
      'data: ' + openai(undefined) + '\n\n' + 'data: ' + openai('Ada') + '\n\n' + 'data: [DONE]\n\n'
    const stream = parseSse(body)
    expect(stream.trailing).toBeUndefined()
    expect(accumulateDeltas(stream.events)).toBe('Ada')
  })
})
