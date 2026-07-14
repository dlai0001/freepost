# Fixtures — local mock servers for manual verification

Runnable mock servers for every protocol Freepost speaks, plus a ready-made
collection that points at them. Use this to click around the app and see real
requests hit real servers, without depending on anything on the internet.

## Start everything

```bash
npm run fixtures        # all servers, Ctrl-C to stop
```

| Server | Address | For |
|---|---|---|
| REST | `http://localhost:3010` | `.curl` |
| **MCP (Streamable HTTP)** | `http://localhost:3011/mcp` | `.mcp` |
| WebSocket | `ws://localhost:3013` | `.ws` |
| GraphQL (+ subscriptions) | `http://localhost:3014/graphql` | `.curl` in GraphQL mode |
| gRPC | `localhost:50051` (plaintext) | `.grpc` |
| MQTT | `mqtt://localhost:1883` | `.mqtt` |

Individual servers: `npm run fixtures:mcp`, `fixtures:http`, `fixtures:ws`,
`fixtures:graphql`, `fixtures:grpc`, `fixtures:mqtt`.

**The stdio MCP server is not in that list on purpose.** It is a *subprocess* —
the app spawns it for you when you run `MCP stdio - sum.mcp`, after asking your
approval and showing you the exact command.

## Open the collection

In the app: **Open Collection** → `fixtures/collection`. Then click any request
and hit Send.

Headless:

```bash
npm run build:cli
node out/cli/index.mjs run fixtures/collection
```

## What each MCP server exposes

**HTTP fixture** (`servers/mcp-http.mjs`)

| | |
|---|---|
| tools | `get-sum(a,b)` · `echo(v: string)` · `boom` (tool-level failure) · `slow(steps)` (progress notifications) · `weather(city)` (structured output) |
| resources | `demo://greeting` · `demo://config` |
| prompts | `greet(who)` |

**stdio fixture** (`servers/mcp-stdio.mjs`): `get-sum`, `boom`, `whoami` (proves
`-e KEY=value` reaches the subprocess environment), `demo://greeting`, `greet`.

`echo` exists to prove **schema-aware coercion**: `--tool-arg v=20` reaches a
`string` parameter as the text `"20"`, not the number `20`.

## Things worth trying

**Assertions in CI — the thing no other MCP client does.**
`node out/cli/index.mjs run fixtures/collection` runs every MCP request headlessly
and gates on its `pm.*` assertions.

**The two failure axes.** `MCP http - tool error (isError).mcp` **is expected to
show a red ✗**, and that is the point: the tool *ran* and reported failure
(`isError: true` → `500 TOOL_ERROR`), so the request is marked errored — while its
assertion (`isError === true`) passes. A protocol failure is a different thing
(`502 PROTOCOL_ERROR`): point a request at `http://localhost:9/mcp` to see one.

**Schema drift detection (F5).**

```bash
node out/cli/index.mjs mcp snapshot fixtures/collection   # record the schema
node out/cli/index.mjs mcp check    fixtures/collection   # no drift -> exit 0
```

Now break the server on purpose — in `servers/mcp-stdio.mjs`, change `get-sum`'s
`a: z.number()` to `a: z.string()`, or delete the `whoami` tool — restart nothing
(stdio servers are spawned per run) and re-run `mcp check`:

```
✗ MCP stdio - sum.mcp
    BREAKING: tool "get-sum": param "a" changed type number -> string
    BREAKING: tool "whoami" was removed
```

...and the exit code is 1. That is the CI gate. Adding an *optional* parameter,
by contrast, is reported as `additive` and passes.

**Spawn consent.** Open `MCP stdio - sum.mcp` and hit Send. The app shows the
exact command it is about to run and asks for approval, remembering the answer
per (collection, command). Changing the command's arguments requires a fresh
approval. `freepost run` does not prompt — running it *is* the authorisation —
and `--no-mcp-spawn` skips stdio MCP requests entirely.

**Introspection panes.** Hit **Connect** on any `.mcp` request to browse the
server's tools, resources and prompts; clicking one loads it into the request.

## These servers also back the CLI smoke test

```bash
npm run build:cli && npm run smoke:cli
```

That starts the HTTP, gRPC and MQTT fixtures and runs the **built** CLI
(`out/cli/index.mjs`) against them. The unit suite imports the TypeScript source,
so it cannot see bundling faults — and a browser-vs-node resolution slip once
left `.grpc` and `.mqtt` silently broken in the shipped CLI while every test
stayed green. Anything that only breaks *after* bundling has to be caught there.
