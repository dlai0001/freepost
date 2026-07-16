/**
 * The request-file grammar, written for an LLM.
 *
 * `write_request` takes raw file text rather than a structured model, so the
 * caller has to know the grammar. Rather than encode five per-kind JSON schemas
 * into the tool list (which every client pays for on every turn), the format is
 * documented here and fetched on demand via `get_format_spec`.
 *
 * Kept deliberately terse: this text lands in a model's context window.
 */
import { writeRequestFile } from '../../core/format'
import { STARTERS } from '../starters'
import type { RequestFile, RequestKind } from '../../shared/model'

/** `graphql` is not a RequestKind — it's a `.curl` file with a graphql body. */
export type SpecKind = RequestKind | 'graphql'

export const SPEC_KINDS: SpecKind[] = ['curl', 'graphql', 'websocat', 'grpc', 'mqtt', 'mcp']

const OVERVIEW = `# Freepost request-file format

A Freepost collection is a folder of plain-text request files. Each file is a
runnable bash script with exactly ONE command. The app and the CLI parse these
files with a strict grammar — pipes, loops, conditionals, and multiple commands
are parse errors, not requests.

## Anatomy

    #!/usr/bin/env bash
    # ---
    # <YAML frontmatter, every line prefixed with "# ">
    # ---

    VAR="\${VAR:-default}"        # variable block: shell assignments only

    curl --request GET \\           # exactly one command, line-continued
      --url "\${VAR}/path"

## The extension picks the protocol

| ext    | command                                | protocol                |
|--------|----------------------------------------|-------------------------|
| .curl  | curl                                    | HTTP (incl. GraphQL)    |
| .ws    | websocat                                | WebSocket               |
| .grpc  | grpcurl                                 | gRPC                    |
| .mqtt  | mosquitto_pub / mosquitto_sub           | MQTT                    |
| .mcp   | npx @modelcontextprotocol/inspector     | MCP                     |

The filename (minus extension) is the request's display name, so spaces are
fine and encouraged: \`Get user by id.curl\`.

## Frontmatter keys

- \`description\`: one-line summary.
- \`label\`: list of tags.
- \`scripts.pre-request\` / \`scripts.test\`: JavaScript, as YAML block scalars
  (\`|-\`). See "Test scripts" below.
- \`variables\`: per-variable metadata, e.g. \`{ TOKEN: { secret: true } }\`.
  A secret variable never keeps a literal default on disk — Freepost strips it.
- \`graphql\`: marks an HTTP request as a GraphQL request (see the graphql kind).
- Unknown keys are preserved verbatim on rewrite, so it's safe to round-trip.

## Variables

Declare them in the assignment block, reference them as \`\${NAME}\` in the
command:

    BASE_URL="\${BASE_URL:-https://api.example.com}"   # optional, with default
    TOKEN="\${TOKEN:?}"                                # required, no default

Values resolve from (strongest first): request params, session, environment
file, then the default in the file. Environments live in
\`environments/<name>.env.json\` as a flat JSON object of string values.

## Test scripts

Postman-compatible \`pm.*\` API with Chai assertions, run in a sandbox with no
network access of its own:

    # scripts:
    #   test: |-
    #     pm.test("status is 200", () => pm.response.to.have.status(200));
    #     pm.test("has an id", () => {
    #       pm.expect(pm.response.json().id).to.be.a("string");
    #     });

Available: \`pm.test\`, \`pm.expect\` (chai), \`pm.response\` (\`.json()\`,
\`.text()\`, \`.code\`, \`.to.have.status(n)\`), \`pm.request\`,
\`pm.environment\` / \`pm.variables\` / \`pm.collectionVariables\` /
\`pm.globals\` (\`.get\`/\`.set\` — writes land in the session tier, so one
request can hand a token to the next), and \`pm.sendRequest\`.

## Writing files

Send the whole file text to \`write_request\`. It is parsed and rejected if it
doesn't fit the grammar — nothing is written on a parse error, and you get the
error back. On success the file is re-serialized to canonical form, so your
formatting is normalized and the canonical text is returned to you.
`

const KIND_NOTES: Record<SpecKind, string> = {
  curl: `## .curl — HTTP

Supported curl flags: \`--request\`, \`--url\`, \`--header\`, \`--data\`,
\`--data-raw\`, \`--data-binary\` (incl. \`@file\` — relative to the request's
folder), \`--form\` (multipart), \`--user\`, \`--insecure\`, \`--max-time\`,
\`--location\` / \`--no-location\`, \`--compressed\`, \`--cookie\`.

Keep one flag per line with \` \\\` continuations — that's the canonical form.`,

  graphql: `## GraphQL — a .curl file with a \`graphql:\` frontmatter block

GraphQL is not a separate extension. Write a \`.curl\` file that POSTs to the
endpoint, and add a \`graphql\` frontmatter block. The block is the source of
truth for the editor; the \`--data\` body must be the matching JSON payload
(\`{"query": "...", "variables": {...}}\`) because that is what actually gets
sent.

Frontmatter keys under \`graphql\`:
- \`query\`: the operation document (YAML block scalar).
- \`variableDefs\`: typed variable rows, e.g.
  \`- { name: id, type: 'ID!', value: '"42"' }\`. \`value\` is JSON text.
  Use \`[]\` when the operation takes none.
- \`schemaUrl\`: endpoint used for introspection (defaults to the request URL).
- \`subscriptionUrl\` / \`subscriptionTransport\` (\`ws\` | \`sse\`): only for
  subscription operations.

Use \`describe_graphql_schema\` first to learn the available queries and
mutations, then write one request per operation. Assert on \`data\` AND on the
absence of \`errors\` — a GraphQL error is still HTTP 200:

    #     pm.test("no graphql errors", () => {
    #       pm.expect(pm.response.json().errors).to.equal(undefined);
    #     });`,

  websocat: `## .ws — WebSocket

Long-lived connection, driven from the app's WebSocket tab. Preset messages go
in \`frontmatter.messages\` as a name → payload map. Not one-shot runnable, so
\`run_request\` will not execute a .ws file.`,

  grpc: `## .grpc — gRPC via grpcurl

Flags: \`-plaintext\`, \`-proto\` (repeatable; paths relative to the request's
folder), \`-import-path\`, \`-d\` (JSON request body), \`-H\` (metadata),
\`-rpc-header\`. The final two positional args are the target and the
fully-qualified method (\`package.Service/Method\`).

Unary calls run one-shot. Server-streaming needs the app's streaming client.`,

  mqtt: `## .mqtt — MQTT

\`mosquitto_pub\` publishes (one-shot, runnable); \`mosquitto_sub\` subscribes
(long-lived, not runnable via \`run_request\`).
Flags: \`-h\` host, \`-p\` port, \`-t\` topic, \`-m\` message, \`-q\` qos,
\`-u\`/\`-P\` credentials, \`-r\` retain.`,

  mcp: `## .mcp — Model Context Protocol

The command is a real MCP Inspector CLI invocation. The server (a URL for
http, or a command + args for stdio) comes immediately after \`--cli\`, before
any Inspector flag.

    npx @modelcontextprotocol/inspector --cli "\${MCP_URL}" \\
      --method tools/call \\
      --tool-name add \\
      --tool-arg a=20 --tool-arg b=22

Methods: \`tools/list\`, \`tools/call\`, \`resources/list\`, \`resources/read\`,
\`prompts/list\`, \`prompts/get\`.

Two distinct failures: a protocol error (bad transport, unknown method) and a
tool error (the tool ran and returned \`isError: true\` — e.g. an unknown tool
name). Assert \`isError\` when you care:

    #     pm.test("not a tool error", () => {
    #       pm.expect(pm.response.json().isError).to.not.equal(true);
    #     });

A stdio .mcp file names a program to SPAWN. Freepost gates that behind per-server
consent, so \`run_request\` on one may be refused.`
}

/** A GraphQL starter isn't in STARTERS (it's a .curl variant) — build it here. */
const GRAPHQL_STARTER: RequestFile = {
  kind: 'curl',
  frontmatter: {
    description: 'GraphQL query',
    graphql: {
      query: 'query Users {\n  users {\n    id\n    name\n  }\n}',
      variableDefs: []
    },
    scripts: {
      test: [
        'pm.test("status is 200", () => pm.response.to.have.status(200));',
        'pm.test("no graphql errors", () => {',
        '  pm.expect(pm.response.json().errors).to.equal(undefined);',
        '});'
      ].join('\n')
    }
  },
  variables: [
    { name: 'GQL_URL', defaultValue: 'http://localhost:3014/graphql', required: false }
  ],
  http: {
    method: 'POST',
    url: '${GQL_URL}',
    headers: [{ name: 'Content-Type', value: 'application/json' }],
    body: {
      kind: 'raw',
      value: JSON.stringify({ query: 'query Users {\n  users {\n    id\n    name\n  }\n}' })
    },
    options: {}
  },
  comments: []
}

function starterFor(kind: SpecKind): string {
  return writeRequestFile(kind === 'graphql' ? GRAPHQL_STARTER : STARTERS[kind])
}

/** Extension a given spec kind writes to (graphql piggybacks on .curl). */
export function extensionFor(kind: SpecKind): string {
  switch (kind) {
    case 'curl':
    case 'graphql':
      return '.curl'
    case 'websocat':
      return '.ws'
    case 'grpc':
      return '.grpc'
    case 'mqtt':
      return '.mqtt'
    case 'mcp':
      return '.mcp'
  }
}

/**
 * The spec text for `get_format_spec`. Without a kind: the overview plus a curl
 * example (the common case). With one: the overview, that kind's notes, and a
 * canonical starter file to copy.
 */
export function formatSpec(kind?: SpecKind): string {
  const k: SpecKind = kind ?? 'curl'
  return [
    OVERVIEW,
    KIND_NOTES[k],
    `\n## Canonical starter (${k} → \`${extensionFor(k)}\`)\n\n\`\`\`bash\n${starterFor(k)}\`\`\``,
    kind === undefined
      ? `\nOther kinds: ${SPEC_KINDS.filter((s) => s !== 'curl').join(', ')} — call get_format_spec with \`kind\` for a starter and notes.`
      : ''
  ].join('\n')
}
