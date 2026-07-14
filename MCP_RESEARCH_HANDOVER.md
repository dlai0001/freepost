# MCP Support — Research Handover (candidate M11)

> **Status: research only, nothing implemented.** This document hands over a deep-research
> pass on Model Context Protocol (MCP) server testing (run 2026-07-14: 5 search angles,
> 23 sources, 114 claims extracted, 25 adversarially verified — 23 confirmed, 2 refuted)
> and maps the findings onto Freepost's existing architecture. The research was originally
> run in an unrelated repo; this file is the portable summary so work can continue here.
>
> Read alongside [PLAN.md](PLAN.md) (M1–M10, shipped) and [TEST_PLAN.md](TEST_PLAN.md).

---

## 0. The one-paragraph thesis

MCP is the sixth protocol Freepost should speak, and Freepost is unusually well-positioned
to be the best MCP testing client in the ecosystem — *not* because MCP tooling is missing
(it isn't; the first-party tools are good), but because the two things the ecosystem is
verifiably missing are the two things Freepost already has: **assertion-based automation**
(pm.* + chai + `freepost run` in CI) and **an OAuth 2.1 authorization_code + PKCE + loopback
implementation** (`src/engine/oauth.ts`, shipped in the post-1.0 M6–M10 block — PLAN.md does
not number the post-1.0 milestones individually). Postman shipped MCP as a native
request type, but it is *interactive invocation only* — list, click, run, look at the
response. Nobody has shipped "write assertions against an MCP tool call and run it headlessly
in CI." That is a Newman-analog-shaped hole, and Freepost already has the Newman analog.

---

## 1. What MCP is, in Freepost's terms

An MCP server exposes three kinds of endpoint, all discovered by introspection (like GraphQL
introspection, which Freepost already implements, or gRPC reflection):

- **Tools** — callable functions with a JSON Schema `inputSchema` (and optional `outputSchema`).
  The closest analog to an HTTP request. `tools/list` → `tools/call`.
- **Resources** — readable content addressed by URI, optionally subscribable for change
  notifications. `resources/list` → `resources/read` (+ `resources/subscribe`).
- **Prompts** — parameterized prompt templates. `prompts/list` → `prompts/get`.

The wire protocol is JSON-RPC 2.0 over one of two live transports:

- **stdio** — the server is a *subprocess* (e.g. `npx some-mcp-server`); JSON-RPC frames go
  over its stdin/stdout. **stdout is the protocol channel**, which is the single most-reported
  footgun in the ecosystem (a stray `console.log` in a server corrupts the stream).
- **Streamable HTTP** — POST JSON-RPC to an endpoint (e.g. `http://host/mcp`), with session
  management and server→client streaming. Remote servers use OAuth 2.1.
- *(SSE is a third, deprecated transport. Do not build for it; see §5.)*

The protocol is also bidirectional in ways HTTP is not: a server can call *back* to the
client mid-request to ask for an LLM completion (**sampling**) or to ask the user a question
(**elicitation**), and can push **progress** and **log** notifications. A test client has to
be able to answer those.

---

## 2. Verified findings (state of the art, mid-2026)

Everything in this section survived 3-vote adversarial verification against live primary
sources. Confidence is high unless marked.

### 2.1 First-party tooling is real and good — integrate, don't rebuild

- **MCP Inspector** (`npx @modelcontextprotocol/inspector`) is the official test/debug tool:
  React UI + Node proxy. It covers all three endpoint kinds (tools with schema-generated
  input forms, resources with subscription testing, prompts with argument forms) across
  stdio/SSE/Streamable HTTP, plus a notifications pane. **This is the baseline UX any MCP
  client is judged against.** Freepost's tools/resources/prompts panes should meet it.
- **Inspector has a CLI mode** — and this matters enormously for Freepost's file format (§3.1):
  ```
  npx @modelcontextprotocol/inspector --cli node build/index.js \
      --method tools/call --tool-name mytool --tool-arg key=value
  ```
  JSON to stdout, meaningful exit codes, one method per invocation. *(A claim that the official
  docs prescribe manual-only testing was **refuted** — scripted/CI use is officially supported.)*
- **An official conformance suite exists**: `@modelcontextprotocol/conformance` (npm,
  Anthropic-maintained, ships a GitHub Action). Runs scenarios — `server-initialize`,
  `tools-list`, `tools-call-*`, `resources-*`, `prompts-*` — against a live server by URL:
  `npx @modelcontextprotocol/conformance server --url http://localhost:3000/mcp`.
  v0.1.16 stable (2026-03-27); a 0.2.0-alpha line is in flight.

### 2.2 The SDKs give us the engine for free

The official **TypeScript SDK** (`@modelcontextprotocol/sdk`) is the natural dependency for
`src/engine/mcp.ts` — exactly as `grpc.ts` wraps `@grpc/grpc-js` and `mqtt.ts` wraps `mqtt.js`.
It ships `StdioClientTransport` and `StreamableHTTPClientTransport`, and an `InMemoryTransport.
createLinkedPair()` explicitly intended for testing (useful for *our own* unit tests of the
engine — spin a fake MCP server in-process, no subprocess, no port).

One SDK semantic that will shape our result model **[verified 2-1]**: with the high-level
`McpServer`, a tool handler failure — *including an input-schema rejection* — comes back as an
ordinary result with **`isError: true`**, not a thrown protocol error. Protocol errors are
reserved for things like unknown/disabled tool names. So an MCP response in Freepost has
*two* distinct failure axes (protocol error vs. `isError` result), and both must be
assertable from `pm.*`. Do not collapse them into one.

Python's SDK and FastMCP mirror this (in-memory `Client(mcp)` testing). FastMCP's client
also exposes callbacks for **sampling, elicitation, progress, and logging** — proof that a
test client is expected to answer server-initiated calls, and a good model for our API.

### 2.3 What the competition actually shipped — and where it stops

**Postman** added MCP as a native request type (alongside HTTP/gRPC/GraphQL). On connect it
auto-introspects tools, resources, and prompts into tabs with unified search, and a
list→select→run→response workflow. It even mocks **client** capabilities **[verified 2-1]**:
you can hand-write the model's response to a sampling request, and answer elicitation prompts
(Accept/Deny/Cancel). Transports: **stdio and Streamable HTTP only** — a claim that it supports
SSE was **refuted 0-3**.

**The gap:** all of that is *interactive invocation*. There is no assertion layer, no
headless runner, no CI story. Third-party compliance suites exist (Janix-ai/mcp-validator)
but lag the spec (last release July 2025).

### 2.4 The gaps practitioners complain about

*(These came from practitioner sources that didn't make the adversarial-verification budget
cut — treat as directionally reliable, not verified. Firm them up before betting a milestone
on any single one.)*

| Pain point | Freepost's existing answer |
|---|---|
| **OAuth is the #1 debugging pain** on remote MCP servers — failures are config mismatches (redirect URI, PKCE exchange, scope delimiters), and first-party tooling doesn't show you *where* the handshake broke. A whole product (MCPJam) exists to fill this. | **`src/engine/oauth.ts` already does authorization_code + PKCE + RFC 8252 loopback + token cache/refresh.** This is the single biggest strategic opening. |
| **Silent schema drift** — servers rename tools / change signatures between versions and downstream agents break with no error. | **Freepost's entire thesis.** Snapshot `tools/list` into the collection as a file on disk; `git diff` reviews it. See F4 in §4. |
| **stdio stdout pollution** corrupts the JSON-RPC stream and is hard to diagnose. | A first-class, explicit diagnostic we can surface (§4, F7) — nobody else does this well. |
| **No CI/regression story** — testing is "vibe-testing": prompt an agent, eyeball the output. | `freepost run` + pm.* + chai. |
| **Ecosystem reliability is poor** — one audit of 2,181 remote MCP endpoints found **52% completely dead**. | A smoke-runner (F2) has obvious value. |
| Tools with >3–4 parameters measurably degrade LLM argument accuracy. | Schema linting (F5), nice-to-have. |

### 2.5 Design precedents worth stealing

- **grpcurl / buf curl (gRPC)** — reflection-first discovery, JSON in/JSON out, `list` /
  `describe` / `invoke` as the core verb set. MCP's `tools/list` is *better* positioned than
  gRPC reflection (always present, always schema-bearing). We already took this shape for
  `.grpc`; take it again.
- **Schemathesis (OpenAPI)** — property-based, schema-aware fuzzing generated *from the schema
  itself*, zero per-endpoint maintenance, failures shrunk to a minimal repro and emitted as a
  replayable command. Maps 1:1 onto MCP `inputSchema` (F5).
- **Dredd (OpenAPI)** — spec-driven contract testing against a live implementation, with hook
  files for stateful setup/teardown.
- **pytest-lsp (LSP)** — launches the real server as a subprocess, speaks the wire protocol as
  a genuine client, built on an existing protocol library rather than reimplementing it.
- **LSP's cautionary tale** — LSP *never* got a conformance suite ("outputs are
  implementation-dependent"); everyone integration-tested against real clients instead. MCP
  dodged this. The lesson still stands: conformance testing validates the *envelope*; behavior
  needs scenario tests (→ our workflows).

---

## 3. What this means for Freepost's architecture

### 3.1 The file format — `.mcp`, and the happy accident

Freepost's rule (from PLAN.md / README): **a request file is a pretty-printed, runnable CLI
command**; `.curl` → curl, `.ws` → websocat, `.grpc` → grpcurl-style, `.mqtt` → mosquitto-style.
Crucially, the app *parses* that text and executes it through a library engine — it does not
shell out. (`src/core/format/index.ts:27-33` — `requestKindForPath` — maps extension →
`RequestKind`; `src/shared/model.ts:7` is the discriminant. Note the kind for `.ws` is
spelled `'websocat'`, not `'ws'` — the kinds are named after the tool, so `'mcp'` fits
the convention only if the command *is* canonical, which the Inspector CLI is.)

MCP fits this beautifully, because **the Inspector CLI is the canonical runnable command form**
(§2.1). A `.mcp` file can be a real, copy-pasteable, bash-runnable Inspector CLI invocation:

```bash
#!/usr/bin/env bash
# ---
# description: List open PRs via the GitHub MCP server
# label: [mcp, github]
# transport: stdio
# ---

GITHUB_TOKEN="${GITHUB_TOKEN:?}"

npx @modelcontextprotocol/inspector --cli npx -y @github/mcp-server \
  --method tools/call \
  --tool-name list_pull_requests \
  --tool-arg owner=dlai0001 \
  --tool-arg repo=freepost
```

...while the app executes it via `@modelcontextprotocol/sdk` in `src/engine/mcp.ts`. The
promise holds: `bash` runs it, `git diff` reviews it, and it's a command an MCP developer
already recognizes. **This is the single most important design decision in the handover —
validate it early** (see §6, Q1).

New `RequestKind`: `'mcp'`. Sub-shape on the request model alongside `grpc?` / `mqtt?`
(`src/shared/model.ts:204-206`, inside `RequestFile` at line 194).

**Grammar check (verified in-repo 2026-07-14):** the sample body above is *already valid*
under the strict file grammar. `src/core/format/shell.ts` parses "an assignment block
followed by exactly ONE command invocation", and `GITHUB_TOKEN="${GITHUB_TOKEN:?}"` matches
its required-form assignment (`REQUIRED_FORM`) verbatim. Two wrinkles the parser work must
handle: (a) `allowedCommands()` in `src/core/format/index.ts` keys the head command per kind
(`curl`, `websocat`, `grpcurl`, `mosquitto_pub|sub`) — for `.mcp` the head is `npx`, which
identifies the *runner*, not the protocol, so the parser must look deeper into the argv;
(b) the Inspector CLI invocation nests a second command (the server command) inside its own
argv — the tokenizer handles it as one command (no pipes/chaining involved) but the mapper
must split "inspector flags" from "server command" correctly.

### 3.2 The engine — `src/engine/mcp.ts`

Mirror `grpc.ts`: one-shot call for `tools/call` / `resources/read` / `prompts/get` (like
`sendGrpcUnary`), plus a connection-oriented client for introspection and for long-lived
subscriptions/notifications (like `GrpcStreamClient` / `ws.ts`).

**Two constraints to respect, both non-obvious:**

1. **The zero-network fence.** CI enforces that only `src/engine` opens sockets
   (`scripts/check-network-fence.mjs`, run as the "Zero-network fence" CI step). Streamable
   HTTP MCP is a socket → fine, it lives in the engine. But **stdio MCP spawns a subprocess**,
   and — *confirmed by reading the script* — the fence does not model subprocesses at all: it
   scans for `fetch`/`WebSocket`/`XMLHttpRequest`/`EventSource`/`sendBeacon` usage and imports
   of `http(s)`/`net`/`dgram`/`tls`/`ws`/`undici`, nothing else. `child_process` is not on the
   list, and `src/main/security.ts` already calls `execFile('git', ...)` outside the engine —
   so a blanket "subprocesses only in engine" clause would need a carve-out for that. Two
   follow-ons: (a) decide whether the fence gets an explicit subprocess clause (with the git
   exception) or whether the policy doc just states that stdio-server spawning is engine-only
   by convention; (b) a `.mcp` file whose server command is `npx -y @some/server` **will hit
   the npm registry on first run**. That's user-initiated, so it's consistent with the README
   ("the only sockets ever opened are ones you explicitly initiate"), but it deserves an
   explicit line in the network-policy docs rather than being discovered by a suspicious user.

2. **Spawning a subprocess named in a collection file is arbitrary code execution.** A `.curl`
   file is inert data we parse; a `.mcp` stdio file names a *program to run*. If someone
   imports a shared collection, opening it must not silently execute anything. Inspector and
   Postman have the same property and mostly shrug at it — Freepost, whose entire pitch is
   trust and "never phones home," should not. Recommend: show the exact command and require an
   explicit per-server confirmation before the first spawn, remembered per collection.

### 3.3 Where the rest of the machinery already fits

| Freepost capability | MCP use |
|---|---|
| GraphQL introspection (`src/core/graphql`) | Direct precedent for `tools/list` → auto-populate the sidebar and generate arg forms from `inputSchema`. |
| pm.* sandbox + chai (`src/core/sandbox`) | **The differentiator.** Assert on tool results, `isError`, and `structuredContent`. Postman cannot do this. |
| Workflows (`src/core/workflow`) | Multi-step MCP scenarios (call tool A → feed output to tool B), with the existing expect-error steps mapping onto MCP's two failure axes. |
| `freepost run` (`src/cli`) | Headless MCP testing in CI — the Newman analog for MCP. Include one-shot kinds (`tools/call`, `resources/read`, `prompts/get`); skip long-lived subscriptions, exactly as websocket *and MQTT subscribe* are skipped today (`src/cli/index.ts:297-331` — the runner already has a per-kind "not one-shot runnable" skip mechanism to extend). |
| `freepost mock` (`src/core/mock`) | Serve saved examples *as an MCP server* — lets users develop an agent against a mock. Natural, and nobody has it. |
| OAuth2 authorization_code + PKCE (`src/engine/oauth.ts`) | Remote MCP auth (OAuth 2.1). Mostly built. Missing: metadata discovery + Dynamic Client Registration. |
| Importers (`src/core/importers`) | Import an existing `mcp.json` / `claude_desktop_config.json` server list → a collection. Cheap, high-delight. |
| Saved examples + history | Snapshot introspection output → schema-drift detection (F4). |

---

## 4. Proposed feature set

Sequenced by (value × confidence) ÷ effort.

> **Decisions locked 2026-07-14 (David):** M11 = **Phase 1 (F1–F4) + F5 drift detection**.
> stdio spawn consent = **per-server confirmation** — first spawn of each distinct server
> command shows the exact command and asks, remembered per collection. Q1 validation run
> same day; see §6b.

### Phase 1 — MCP as a first-class protocol (the actual M11)

- **F1 — `.mcp` format + engine.** New `RequestKind: 'mcp'`; parser/writer in `src/core/format/mcp.ts`
  (round-trip tested, per house style); `src/engine/mcp.ts` on `@modelcontextprotocol/sdk` with
  stdio + Streamable HTTP transports. Result model carries both failure axes (protocol error vs.
  `isError`) and `structuredContent`.
- **F2 — Introspection + the three panes.** `tools/list` / `resources/list` / `prompts/list` on
  connect; schema-generated argument forms; match the Inspector's baseline UX (§2.1) or don't
  bother shipping.
- **F3 — Assertions + headless run.** Expose the MCP result to `pm.*`; support `tools/call`,
  `resources/read`, `prompts/get` in `freepost run`. **This is the thing no competitor has.**
  Lead the release notes with it.
- **F4 — Server-initiated flows.** Answer sampling (canned/scripted response), elicitation
  (Accept/Deny/Cancel), and capture progress + log notifications. Postman does this
  interactively; doing it *scriptably* is again novel.

### Phase 2 — The regression story (highest gap-to-effort ratio)

- **F5 — Schema snapshot & drift detection.** Write the full introspection surface (tool names,
  input/output schemas, resource templates, prompt args, capability flags) to a file in the
  collection. CI (`freepost run`) diffs live vs. snapshot: fail on breaking changes (removed
  tool, renamed/retyped/newly-required param), warn on additive. *This is Freepost's thesis
  applied to the ecosystem's loudest complaint, and it is mostly file I/O + a differ.*
- **F6 — Conformance integration.** Shell out to / vendor `@modelcontextprotocol/conformance`
  as an opt-in workflow step, with an expected-failure baseline. Don't reimplement it.

### Phase 3 — The OAuth wedge

- **F7 — MCP OAuth debugger.** Extend `oauth.ts` with MCP's discovery + Dynamic Client
  Registration, and surface **step-by-step handshake observability**: metadata discovery →
  registration → PKCE exchange → scope handling, showing exactly which step failed and why.
  Plus negative tests (expired/malformed/wrong-audience token → 401 + correct
  `WWW-Authenticate`). This is a product in its own right today; Freepost is ~70% of the way
  there already.

### Phase 4 — Opportunistic

- **F8 — Property-based schema fuzzing** (Schemathesis-for-MCP): generate valid + boundary +
  invalid inputs from `inputSchema`; assert the server never crashes/hangs, invalid input
  yields a clean `isError` rather than a transport failure, and output conforms to
  `outputSchema`. Emit failures as a minimal, replayable `.mcp` file.
- **F9 — stdio hygiene diagnostics**: flag non-JSON-RPC bytes on stdout (the #1 footgun),
  report unclean shutdown.
- **F10 — Schema linting**: warn on >3–4 params, missing descriptions, unconstrained strings.
- **F11 — `freepost mock` as an MCP server**; **F12 — import `mcp.json` server lists**;
  **F13 — codegen targets** for MCP client calls.

**Explicitly out of scope:** LLM-in-the-loop evals (stochastic, costly, needs an API key — it
would violate the no-network-without-user-action posture and isn't Freepost's job), and load
testing (a different product).

---

## 5. Traps — things the research explicitly refuted or flagged

1. **Do not build SSE transport.** It is deprecated in the spec. The Inspector retains it for
   back-compat; Postman never shipped it (that claim was refuted 0-3). stdio + Streamable HTTP only.
2. **Do not assume tool failures throw.** `isError: true` on an ordinary result is the common
   path (§2.2). Getting this wrong makes every assertion API subtly wrong.
3. **Do not assume the Inspector is manual-only** — it has a scriptable CLI, which is precisely
   why our file format can be honest (§3.1).
4. **The ecosystem moves fast.** Python SDK v2 was pre-release as of 2026-07-14 (stable targeted
   2026-07-27); conformance 0.2.0-alpha is in flight. **Re-check the TS SDK's current transport
   API surface before writing `mcp.ts`** — do not trust this document's API details, only its shape.
   *(npm registry re-checked from this repo on 2026-07-14: `@modelcontextprotocol/conformance`
   latest `0.1.16` / alpha `0.2.0-alpha.9`; `@modelcontextprotocol/inspector` `0.22.0`;
   `@modelcontextprotocol/sdk` `1.29.0` — all consistent with §2.)*

---

## 6. Open questions for the next session

1. **Q1 — ANSWERED YES (validated live 2026-07-14, Inspector 0.22.0 + server-everything).**
   Two hand-written `.mcp` files (stdio + Streamable HTTP, in the exact house format: shebang,
   `# ---` frontmatter, assignment block, one command) both (a) ran successfully under plain
   `bash`, and (b) parsed cleanly through Freepost's real `extractFrontmatter` + `parseBody`
   (strict grammar), including a `MCP_TOKEN="${MCP_TOKEN:-test-token}"` variable declaration.
   Flag surface confirmed empirically:
   - `--method tools/list | tools/call | resources/list | resources/read | prompts/list |
     prompts/get`; `--tool-name` + repeatable `--tool-arg key=value`; `--uri`;
     `--prompt-name` + `--prompt-args key=value`.
   - **Schema-aware coercion works**: `--tool-arg a=3 b=4` arrived as numbers,
     `includeImage=true` as a boolean. Values with spaces survive shell quoting.
   - **Streamable HTTP**: the target URL is a *positional* argument
     (`--cli http://host:3001/mcp`), `--transport http` optional (inferred), `--header
     "Name: Value"` supported. `--server-url` alone does NOT satisfy the required positional.
   - **Exit-code semantics**: protocol-level failures (unknown resource, connect failure)
     exit 1; a tool result with `isError: true` (including input-schema rejections) exits
     **0** — so raw-bash runs don't gate CI on tool errors, which is precisely the gap F3's
     assertion layer fills, and further confirmation of the two-failure-axes model (§2.2).
   - Untested: deeply nested object/array tool args via `--tool-arg` (server-everything has
     none). Check before relying on it; worst case those args need the app-side form only. **Correction (verified in-repo):** the
   fallback framing in the original research was wrong — `.grpc` and `.mqtt` are *not*
   invented syntax. `src/core/format/grpc.ts` parses genuine `grpcurl` invocations (real
   single-dash flags, pinned strict subset, anything else is a `ParseError`), and `.mqtt`
   parses real `mosquitto_pub`/`mosquitto_sub`. The house precedent is "a real tool's real
   syntax, strictly subset" — so if the Inspector CLI can't express what we need, the fallback
   is NOT an invented command; it's either extending upstream, or accepting a reduced feature
   surface in the file format. This raised the stakes on Q1 — which then passed (see above),
   so the format question is settled: **`.mcp` = Inspector CLI invocation.**
2. Does conformance 0.2.0 add auth/OAuth scenarios? If yes, F7's scope shrinks.
3. How complete is conformance coverage of elicitation, structured output, and HTTP session
   resumability? (The README mentions draft scenarios + expected-failure baselines.)
4. Does the CI network fence need a subprocess clause (§3.2)?
5. The §2.4 pain points are single-source. Before committing to Phase 3 over Phase 2, skim the
   `modelcontextprotocol/inspector` and `/conformance` GitHub issues for what users actually
   file bugs about.

---

## 6b. In-repo verification pass (2026-07-14)

This document was written outside the repo; the following claims were re-verified against
the actual codebase after the fact (all corrections already folded into the sections above):

- **Confirmed:** `requestKindForPath` extension map (`src/core/format/index.ts:27-33`);
  `RequestKind` discriminant (`src/shared/model.ts:7`); `grpc?`/`mqtt?` sub-shapes
  (`src/shared/model.ts:204-206`); `src/engine/oauth.ts` implements authorization_code +
  PKCE (RFC 7636) + RFC 8252 loopback + token refresh, and has **no** metadata discovery or
  Dynamic Client Registration (F7's premise holds); PLAN.md records M1–M10 as shipped;
  workflows support `expectError` per step (`src/core/workflow/index.ts`); GraphQL
  introspection lives at `src/core/graphql/introspection.ts`; importers are
  command/openapi/postman only (no mcp.json yet); npm package versions in §2 match the live
  registry.
- **Corrected:** OAuth is "post-1.0 (M6–M10)", not specifically "M6"; `.grpc`/`.mqtt` are
  real-tool syntax (strict pinned subsets of `grpcurl` / `mosquitto_*`), not invented
  commands — see Q1; the network fence's lack of a subprocess clause is now confirmed fact,
  and `src/main/security.ts` already runs `execFile('git')` outside the engine.
- **New finding:** the sample `.mcp` body in §3.1 already parses under the strict body
  grammar (assignment block + one command), but the head-command check and the nested
  server-command argv need mapper work — see the grammar-check note in §3.1.

---

## 7. Sources

**Primary (verified):**
[modelcontextprotocol/inspector](https://github.com/modelcontextprotocol/inspector) ·
[Inspector docs](https://modelcontextprotocol.io/docs/tools/inspector) ·
[modelcontextprotocol/conformance](https://github.com/modelcontextprotocol/conformance) ·
[typescript-sdk (docs/testing.md, InMemoryTransport)](https://github.com/modelcontextprotocol/typescript-sdk) ·
[Python SDK v2](https://py.sdk.modelcontextprotocol.io/v2/get-started/) ·
[FastMCP client](https://gofastmcp.com/clients/client) ·
[Postman MCP docs](https://learning.postman.com/docs/use/send-requests/protocols/mcp-requests/interact) ·
[Postman MCP launch](https://blog.postman.com/postman-launches-full-support-for-model-context-protocol-mcp-build-better-ai-agents-faster/) ·
[Janix-ai/mcp-validator](https://github.com/Janix-ai/mcp-validator)

**Secondary (pain points & precedents — not adversarially verified):**
[Stop Vibe-Testing MCP Servers](https://jlowin.dev/blog/stop-vibe-testing-mcp-servers) ·
[Testing MCP Servers: The Five Gates](https://dev.to/aws-heroes/testing-mcp-servers-the-five-gates-between-demo-and-production-2inf) ·
[GitHub MCP Server offline evals](https://github.blog/ai-and-ml/generative-ai/measuring-what-matters-how-offline-evaluation-of-github-mcp-server-works/) ·
[MCPJam OAuth debugger](https://www.scalekit.com/blog/mcpjams-oauth-debugger) ·
[How to test an MCP server](https://apigene.ai/blog/how-to-test-mcp-server) ·
[Schemathesis](https://schemathesis.io/) ·
[grpcurl](https://github.com/fullstorydev/grpcurl) ·
[buf curl](https://buf.build/blog/buf-curl) ·
[pytest-lsp](https://pypi.org/project/pytest-lsp/) ·
[LSP conformance issue #353](https://github.com/Microsoft/language-server-protocol/issues/353)
