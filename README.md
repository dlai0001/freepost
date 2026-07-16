# Freepost

**The API client that never phones home.**

An open-source Postman alternative for REST, GraphQL, WebSocket, gRPC, MQTT, and
MCP testing — built for developers behind corporate firewalls.

- **No account. No cloud. No registration.** Ever.
- **No unsolicited network calls.** The only sockets ever opened are ones you
  explicitly initiate — a request you send, or a mock server you start. No
  telemetry, no crash reporting, no update checks. The request engine is the
  only module in the codebase allowed to open a socket, and CI enforces it.
- **Your requests are curl.** Collections are folders on disk you choose; every
  request is a pretty-printed, *runnable* command — curl, websocat for
  WebSocket, grpcurl for gRPC, mosquitto for MQTT, the MCP Inspector CLI for
  MCP — with YAML-in-comments frontmatter. `bash` runs it, `git diff` reviews
  it, any tool that imports curl understands it.
- **MCP servers are testable, not just clickable.** Freepost speaks Model
  Context Protocol over stdio and Streamable HTTP: introspect a server's tools,
  resources and prompts, then **write `pm.*` assertions against a tool call and
  run them headlessly in CI** — which no other MCP client does. `freepost mcp
  check` turns silent tool-signature drift into a failing build. And because a
  stdio server is a *program on your machine*, Freepost shows you the exact
  command and asks before it ever spawns one.
- **Let an AI write your tests.** Freepost is *also* an MCP **server**: point
  Claude Desktop (or any MCP client) at a collection and ask it to "write tests
  for this OpenAPI spec" or "cover every query in this GraphQL schema". It
  creates the request files, runs them, reads the assertion results, and
  iterates — with your secrets never leaving your machine. Off by default; you
  turn it on. See [Use Freepost from an AI app](#use-freepost-from-an-ai-app-mcp-server).
- **Postman-compatible scripting.** Pre-request and test scripts with the `pm.*`
  API and Chai assertions.
- **A browser-like cookie jar, per collection.** Set-Cookie capture and replay
  just work — login flows included — with a Cookie Manager for editing every
  attribute (SameSite and all) and curl-compatible `cookies.txt` import/export.
  The jar is a git-ignored local file; it's never sent anywhere.
- **Workflows.** Ordered request runs with expect-error steps and reference
  validation.
- **Run headlessly in CI.** `freepost run ./collection` executes the same files
  with the same engine — the Newman analog. `freepost mock ./collection` serves
  your saved examples as a local server. See [the CLI guide](https://dlai0001.github.io/freepost/help/cli.html).
- **Builds from source on Windows and macOS.** Node is the only prerequisite.

## An example request file

```bash
#!/usr/bin/env bash
# ---
# description: Fetches a single user record by id
# label: [users, smoke]
# ---

BASE_URL="${BASE_URL:-https://api.example.com}"
TOKEN="${TOKEN:?}"

curl --request GET \
  --url "https://${BASE_URL}/api/users/42" \
  --header 'Accept: application/json' \
  --header "Authorization: Bearer ${TOKEN}"
```

## …and an MCP request file

A `.mcp` file is a real MCP Inspector CLI invocation — `bash` runs it, and the
app executes it through the official SDK. The test script is the part nobody
else has:

```bash
#!/usr/bin/env bash
# ---
# description: Add two numbers via an MCP server
# label: [mcp]
# scripts:
#   test: |-
#     pm.test("sums 20 + 22", () => {
#       pm.expect(pm.response.json().content[0].text).to.contain("42");
#     });
#     pm.test("is not a tool error", () => {
#       pm.expect(pm.response.json().isError).to.not.equal(true);
#     });
# ---

MCP_URL="${MCP_URL:-http://localhost:3011/mcp}"

npx @modelcontextprotocol/inspector \
  --cli \
  "${MCP_URL}" \
  --transport http \
  --method 'tools/call' \
  --tool-name 'get-sum' \
  --tool-arg 'a=20' \
  --tool-arg 'b=22'
```

MCP has **two distinct failure axes** and Freepost keeps them apart, because
collapsing them makes every assertion subtly wrong: a *protocol* error
(transport/spawn failure — `502 PROTOCOL_ERROR`) is not the same as a tool that
ran and reported failure (`isError: true` — `500 TOOL_ERROR`). Both are
assertable.

## Use Freepost from an AI app (MCP server)

Everything above makes Freepost an MCP *client*. It is also an MCP **server**:
your collection, exposed to Claude Desktop or any other MCP app, so you can say

> *Create test cases for the endpoints in this OpenAPI spec, then run them.*

and watch the request files appear in the app — written, executed, and fixed
until the assertions pass. Because collections are just files, everything the AI
does is a `git diff` you review like any other.

**Two ways to connect.** Both expose the same tools.

*From the CLI* — the AI app launches Freepost itself, no GUI needed. Add this to
your Claude Desktop config:

```json
{
  "mcpServers": {
    "freepost": {
      "command": "freepost",
      "args": ["mcp", "serve", "/path/to/your/collection"]
    }
  }
}
```

Flags: `--readonly` (never write), `--no-run` (never make a network call),
`--no-mcp-spawn` (never spawn a stdio MCP subprocess), `--env <file>`.

*From the app* — **Tools ▸ MCP Server** starts a listener on
`http://127.0.0.1:7599/mcp` for the collection you have open; "Copy AI app
config snippet" puts the config on your clipboard. It is **off by default and
per-session**, deliberately: an always-on server means every AI conversation
carries Freepost's tools whether you want them or not. Files the AI writes show
up in the app immediately.

**The tools.** `get_format_spec`, `list_collection`, `read_request`,
`write_request`, `move_path`, `delete_path`, `run_request`, `import_openapi`,
`read_environment`, `write_environment`, `describe_graphql_schema`.

**What it can't do.**

- **Never leaves the collection.** Every path is collection-relative; traversal,
  absolute paths, `.git/` and `.freepost/` (secrets, tokens, request history)
  are refused.
- **Never reads your secrets.** `*.local.env.json` — the git-ignored file where
  secrets belong — is neither listed nor readable, and a secret-marked variable
  never gets a literal default written to disk. The AI can *use* a secret by
  running a request; it can't *read* one.
- **Never silently spawns a program.** A stdio `.mcp` request names an
  executable. Over HTTP, the AI can only run servers you already approved by
  hand; from the CLI, typing `mcp serve` is the authorisation and
  `--no-mcp-spawn` opts out.
- **The HTTP listener is loopback-only** (`127.0.0.1`) and carries no auth token
   — while it's on, anything running as you on this machine can reach it. That's
  the tradeoff for it being one menu click; leave it off when you're not using it.

## Try it without touching the internet

`fixtures/` ships mock servers for every protocol and a collection wired to
them:

```bash
npm run fixtures              # REST, MCP, WebSocket, GraphQL, gRPC, MQTT
npm run build:cli && node out/cli/index.mjs run fixtures/collection
```

See [fixtures/README.md](fixtures/README.md).

## Build from source

```bash
git clone https://github.com/dlai0001/freepost
cd freepost
npm install
npm start
```

## Documentation

- [Project plan & format specification](PLAN.md)
- [Website](https://dlai0001.github.io/freepost/)

## Support

Freepost is free, open source, and funded by donations — not by selling a cloud
tier, because there will never be one.

[**♥ Sponsor on GitHub**](https://github.com/sponsors/dlai0001)

## License

[MIT](LICENSE)
