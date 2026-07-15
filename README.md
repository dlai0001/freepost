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
