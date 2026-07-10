# Freepost — Research Report & Implementation Plan

> **Status (M1–M5 complete, July 2026):** implemented and CI-verified on macOS +
> Windows (423 tests). Canonical curl/websocat format (parser/writer, round-trip-
> tested), three-tier variables + session, pm.* script sandbox (chai), workflows
> with expect-error + reference validation + rename auto-heal, search with labels,
> WebSocket client, GraphQL body generation + introspection, collection/folder
> config sidecars with inherited default headers and folder/collection scripts,
> CSV/JSON data-driven workflow runs, code generation (8 targets), OAuth2 token
> acquisition (client_credentials, password), mTLS client certs, Postman v2.1 +
> OpenAPI 3.x/Swagger 2.0 import, curl/websocat/wscat paste & file import, request
> history + saved response examples, zero-network fence in CI, examples collection,
> marketing site live at https://dlai0001.github.io/freepost/.
>
> **Post-1.0 (M6–M10, implemented & CI-verified):** OAuth2 authorization_code
> interactive flow (RFC 8252 system-browser + loopback listener, PKCE, token
> cache/refresh under `.freepost/`); headless CLI runner (`freepost run`, the
> Newman analog — HTTP, gRPC unary, MQTT publish; long-lived kinds skipped);
> gRPC (unary + server-streaming via grpcurl-style `.grpc` files on
> `@grpc/grpc-js`); mock server (replays saved examples over HTTP, `freepost
> mock`); MQTT (publish/subscribe via mosquitto-style `.mqtt` files on mqtt.js).
> **Still deferred:** plugin API. See TEST_PLAN.md for verification coverage.

An open-source Postman clone: offline-only, no registration, builds from source on
Windows and macOS, saves requests to disk anywhere as pretty-printed curl commands.

**License: MIT** (matches Bruno and curlconverter; frictionless corporate adoption).
**Network policy: absolute zero** — see §4; the only sockets ever opened are the
user's own requests.

> Fact-check provenance: findings below were produced by a multi-agent deep-research
> pass (23 sources fetched, 115 claims extracted, 25 adversarially verified with 3-vote
> panels, 24 confirmed / 1 refuted). Confidence labels reflect that process. Sections
> marked ⚠ were **not** verified by that pass and rely on general knowledge — re-verify
> before committing to them.

---

## 1. What "Postman minus team features" actually means

### Protocols
- **REST/HTTP** — methods, headers, query params, path params, body types (raw
  JSON/text/XML, form-urlencoded, multipart with file upload, binary, GraphQL).
- **GraphQL** — query/mutation editor, variables pane, schema introspection. ⚠
- **WebSocket** — connect, send/receive messages (text/binary), saved message
  presets, connection headers/subprotocols.
- **gRPC, MQTT, Socket.IO** — Postman has them; defer to post-1.0. ⚠

### Core machinery (all verified, high confidence)
- **Scripting = JavaScript, non-negotiable for compatibility.** Pre-request scripts and
  post-response test scripts run in the "Postman Sandbox," a JS execution environment.
  JS is the only supported language. Bruno (QuickJS/Node VM) and Insomnia both embed JS
  engines specifically for this. ([sandbox docs](https://learning.postman.com/docs/tests-and-scripts/write-scripts/postman-sandbox-reference/overview))
- **The `pm.*` API is the compatibility surface**: `pm.request`, `pm.response`
  (test-scripts only), `pm.cookies`, `pm.variables.get/set`, `pm.environment.set`,
  `pm.collectionVariables.set`, `pm.globals.set`, plus `pm.test`, `pm.expect`,
  `pm.info`, `pm.execution`, `pm.sendRequest`, `pm.require`.
- **Assertions are Chai.js BDD style** via `pm.test`/`pm.expect`; Postman's
  [chai-postman](https://github.com/postmanlabs/chai-postman) plugin is open source and reusable.
- **Five variable scopes**, narrowest wins: `local > data > environment > collection > global`.
  Data variables come from CSV/JSON files fed to the collection runner; local variables
  die when the run ends. (Postman's vault/secrets is a separate mechanism, not a sixth scope.)
- **`{{variable}}` templating** works anywhere in a request. Insomnia, Bruno, and
  Hoppscotch all implement it compatibly — keep this syntax.
- **Scripts attach at three levels** — request, folder, collection. Collection scripts
  wrap every request; folder scripts wrap every direct child. The on-disk format must
  therefore carry folder- and collection-level scripts, not just per-request ones
  (Bruno solves this with `folder.bru` / `collection.bru` sidecar files).
- **Collection Runner**: selective and user-ordered execution, data-driven iteration
  over CSV/JSON + selected environment, and script-driven flow control via
  `pm.execution.setNextRequest(nameOrId | null)` and `skipRequest` — which means the
  script engine must be wired into the runner loop, not bolted on.

### Supporting features
- Cookie jar with UI management; auth helpers (Basic, Bearer, API key, OAuth 1/2,
  AWS SigV4, NTLM/Digest); request history; code-generation to many languages;
  import from Postman collection v2.1 / OpenAPI / curl; environments UI;
  proxy + custom CA support (critical for corporate networks); mock servers (defer). ⚠

### Explicitly out of scope
Workspaces/team sync, cloud accounts, commenting, forking/merging in-app, private API
network, Postman-hosted mocks/monitors. Git *is* the collaboration story — plain-text
files on disk, reviewed via pull requests.

---

## 2. Prior art — what to learn and what to reuse

| Tool | Stack | Storage | Registration | License | Lesson |
|---|---|---|---|---|---|
| **Bruno** | Electron + React + Node | Plain-text `.bru` files in any folder | Never; "no plans to add cloud-sync, ever" | MIT | The existence proof for this whole project |
| **Insomnia** | Electron | Local DB, cloud-pushed | Account pushed since 2023 | Apache-2.0 | The backlash that created Bruno/Yaak |
| **Hoppscotch** | Web + Tauri desktop | Web-centric | Optional account | MIT | Tauri desktop data point |
| **Yaak** | Tauri (Rust + web UI) | Local files | None | MIT | Closest Tauri-based analog |
| **Hurl** | Rust CLI on libcurl | Own plain-text format | n/a | Apache-2.0 | Why curl syntax alone isn't enough (§3) |

Verified specifics worth stealing from **Bruno**:
- Collections live directly in a filesystem folder of the user's choosing; "use Git or
  any version control of your choice"; PR-reviewable because human-readable.
- MIT-licensed, ~74% JS / ~22% TS, builds from source with
  `npm i --legacy-peer-deps && npm run setup && npm run dev` on Node v22.x —
  demonstrating that an Electron/Node stack satisfies `git clone && build` on
  Windows + macOS. (Build is slightly finicky: pinned Node, legacy peer deps.)

**The central design warning (verified):** Bruno deliberately invented a custom DSL
(`.bru`) instead of JSON/YAML for readability
([discussion #360](https://github.com/usebruno/bruno/discussions/360)) — and then
**reversed course in v3.1**, making YAML ("OpenCollection") the default, citing missing
editor/lint/schema tooling, slower parsing, and poor AI-tool understanding of the custom
format. Any curl-flavored custom format must budget for tooling (parser lib published
separately, linter, editor highlighting, JSON-schema for sidecars) or expect the same
migration pressure. Freepost's mitigation: curl syntax is *not* an invented DSL — every
developer and every LLM already reads it, and `bash file.sh` executes it. That's a real
advantage Bru never had, but the tooling budget still applies to the annotation layer.

---

## 3. Storage format: pretty curl on disk

**Verdict from verification: feasible but partial — needs an augmentation layer.**

What's confirmed:
- **Parsing curl back into structured requests is proven** by
  [curlconverter](https://github.com/curlconverter/curlconverter) (MIT, ~8.2k stars,
  actively maintained): it transpiles curl commands into ~29 targets (HAR, JSON,
  Python, HTTPie, …). Reuse it (or its parser) as the import layer instead of writing
  a curl parser from scratch.
- **But curl exposes no CLI parser via libcurl** — argument parsing lives in the curl
  tool's own `src/tool_getparam.c`. curlconverter "knows about all 255 curl arguments
  but most are ignored." So define an explicit **supported flag subset** and round-trip
  only that; warn (don't destroy) on unknown flags.
- **A shell-syntax layer is required**: stored curl commands live inside Bash syntax —
  quoting, ANSI-C strings, heredocs, comments. curlconverter uses a full
  tree-sitter-bash grammar. A pragmatic v1 can support POSIX quoting + comments and
  reject heredocs; full Bash is the ceiling, not the floor.
- **Bare curl cannot express tests, captures, or lifecycle scripts.** Hurl — built on
  libcurl — states its two value-adds over curl are exactly (1) chaining requests with
  captures and (2) asserting on responses. Since curl 8.3.0, `--variable`/`--expand-*`
  and `--next` cover *static* variables and naive sequencing, but nothing populates a
  variable from a response, and there's no assert beyond `--fail`. Scripts and tests
  must live in an annotation layer around the curl command.
- `{{var}}` placeholders inside a curl command are not valid literal values — a
  format storing them must treat them as template tokens. (Superseded by the decision
  below to use real shell variables on disk; `{{var}}` now only appears transiently
  during Postman import, converted to `${VAR}`.)

### Proposed format: `.curl` files — annotated, executable shell

One request per file. **The filename is the request name** (`Get user by id.curl`) and
**the on-disk folder tree mirrors the app's folder tree one-to-one** — rename/move in
the app = rename/move on disk, and vice versa (the app watches the filesystem). Any
folder on disk can be opened as a collection. Since the name *is* the filename, the app
must enforce cross-platform filename rules at creation time (reject `<>:"/\|?*` for
Windows compatibility, treat names case-insensitively to avoid collisions on
macOS/Windows default filesystems).

All request metadata lives in a **YAML frontmatter block inside shell comments** at the
top of the file: a leading comment block delimited by `# ---` lines, parsed by
stripping the `# ` prefix and feeding the result to a standard YAML parser. This is the
**single extension point** — any metadata or configuration the app needs per request
(now or in the future) goes in the frontmatter, never in new ad-hoc annotation syntax.
Because it's all comments, the file remains a **valid, runnable shell script** — the
killer feature for copy-paste and firewall-constrained sharing.

Reserved frontmatter fields:

| Field | Purpose |
|---|---|
| `description` | Free-text description of the request, shown in the UI and searchable |
| `label` | List of user-defined labels; searchable/filterable from the requests panel |
| `variables` | Optional per-variable metadata (description, `secret: true`, …) for variables declared in the shell assignment block |
| `scripts.pre-request` / `scripts.test` | JS as YAML block scalars |
| `disabled` | Unchecked-but-kept headers/query params (`disabled.headers`, `disabled.query`), preserving name + value; rendered as unchecked rows in the UI, absent from the executable command, lossless on Postman import |
| `graphql` | GraphQL source of truth: `graphql.query` (block scalar, readable/diffable) + `graphql.variables`; the writer *generates* the JSON-escaped `--data` in the command from it, so the file stays executable — hand-edits to the generated `--data` are overwritten on app save |
| `seq` | Manual ordering within a folder (filesystems sort alphabetically) |

**Strict file grammar (decided):** a valid request-file body is a shell assignment
block followed by **exactly one** curl/websocat invocation. Pipes, command chains,
conditionals, and loops are parse errors — the file appears in the tree marked
invalid, remains editable as raw text, and is **never rewritten** by the app (parse
errors must never corrupt hand-written content). This strictness is what guarantees
the canonical pretty-printer can faithfully round-trip every file it accepts.
(Possible post-1.0 extension: recognize a trailing `| jq ...` as a response filter.)

**Rewrite contract (decided):** app-side saves rewrite valid files to canonical form
(long-form flags, one per line, normalized quoting, sorted assignment block) — the
gofmt model — with two preservation guarantees: **unknown frontmatter keys are kept
verbatim**, and **standalone `#` comment lines in the body are kept in place**
(parsed as trivia attached to the following statement and re-emitted by the writer).
Comments are content, not formatting; a PR-reviewable format must not eat notes
written for reviewers.

**Variables are plain shell variables (decided — option C of the format review).**
The file body is: shell assignment block, then exactly one command. Variables are
declared as real assignments using `${VAR:-default}` (optional, with default) or
`${VAR:?}` (required — bash aborts with a clear error if unset), and referenced as
`${VAR}` in the command. This makes every saved file **genuinely executable** —
`bash file.curl` runs as-is, `TOKEN=xyz bash file.curl` overrides from the
environment (CI-friendly), and the same mechanism works identically for websocat
since the shell expands variables before the command runs.

```bash
#!/usr/bin/env bash
# ---
# description: Fetches a single user record by id
# label:
#   - users
#   - smoke
# seq: 20
# variables:
#   token: { secret: true }
# scripts:
#   pre-request: |
#     pm.variables.set("ts", Date.now());
#   test: |
#     pm.test("status is 200", () => pm.response.to.have.status(200));
#     pm.test("has email", () => pm.expect(pm.response.json().email).to.be.a("string"));
# ---

BASE_URL="${BASE_URL:-https://api.example.com}"
USER_ID="${USER_ID:-42}"
TOKEN="${TOKEN:?}"

curl --request GET \
  --url "https://${BASE_URL}/api/users/${USER_ID}" \
  --header 'Accept: application/json' \
  --header "Authorization: Bearer ${TOKEN}"
```

The assignment block is the single source of truth for variable names and defaults
(frontmatter `variables` holds only optional metadata about them, e.g. marking
`token` secret so the UI masks it and the writer never persists a literal default
for it).

**Variable resolution (decided — three tiers, deliberately simpler than Postman's
five scopes):**

1. **Request parameters (Meta values)** — the file's own `${VAR:-value}` assignment
   block, edited on the Meta tab. A *non-empty* value is the **strongest** tier: it
   overrides session and environment, so a request can pin its own values. Values
   may reference other variables (`${env}-${id}`) and are expanded against the rest
   of the resolved set (session, environment, and each other), letting developers
   define derived, request-scoped values. A *blank* value is a fallback only — it
   never shadows a session/environment value of the same name — and a *required*
   (`${VAR:?}`) parameter contributes no value of its own (it must come from
   session or environment, else the send is blocked).
2. **Session** — the runtime store. Every request's scripts can write to it
   (`pm.variables.set(...)` and friends), whether the request runs standalone, in
   the collection runner, or in a workflow. Capture a token once, every subsequent
   request sees it. In-memory per app session, inspectable and clearable from a
   Session panel; never written to disk.
3. **Environment** — the selected `*.env.json`.

Note: because a non-empty Meta value wins over the session, a variable that is
driven from data files or captured into the session (e.g. a per-row `USER_ID` or a
script-set token) must be left blank / required on the Meta tab — a literal Meta
value would override the runtime value.

Postman-compat shim: `pm.environment.set`, `pm.collectionVariables.set`, and
`pm.globals.set` in scripts all write to the **session** at runtime (imported
scripts keep working); Postman collection/global *variables* map to environment
files or request parameters at import time. Runner data files load each CSV/JSON
row into the session at iteration start.

The UI uses `${VAR}` syntax throughout (one syntax, disk = UI);
Postman imports convert `{{var}}` → `${VAR}` on the way in. Trade-off accepted:
exporting back out to tools that only understand `{{var}}` requires the app's
export command rather than raw file copy-paste — in exchange, every file on disk
runs unmodified in any shell.

- **All non-request files are JSON** (decided): `collection.json` / `folder.json`
  sidecars carry folder- and collection-level metadata, default headers, and auth
  (mirrors Bruno's proven `folder.bru` pattern, but in standard JSON with a published
  schema). Multiline lifecycle scripts don't sit well inside JSON strings, so the JSON
  references sibling JS files, e.g. `"preRequestScript": "./collection.pre.js"`,
  `"testScript": "./collection.test.js"`.
- `environments/*.env.json` for environments; `.gitignore`'d `*.local.env.json` for
  secrets. App settings, cookie-jar persistence, and run reports: also JSON.
- Writer always emits canonical pretty form: long-form flags (`--request` not `-X`),
  one flag per line, single-quoted, `\` continuations — diff-friendly and
  copy-pasteable into any terminal or any tool that imports curl.
- Bodies: inline `--data` for small payloads; `--data @./payload.json` sidecar for
  large ones (stays valid curl).

**Design question resolved:** the research flagged "where do scripts/annotations live"
as open (comment blocks vs. fenced sections vs. sidecar files). Decision: everything
rides in the commented YAML frontmatter. One block, one parser, file stays executable
shell, and YAML block scalars handle multiline JS cleanly.

### Auth & secrets (decided: fully collection-contained)

The collection folder is the entire universe — portable to any location, machine, or
USB stick, per the project's "save anywhere" ethos:

- **Simple auth** (Basic, Bearer, API key) is just curl flags/headers + `${VAR}`
  variables — already covered by the format.
- **OAuth2 config** (client ID, auth/token URLs, scopes, grant type) lives in
  frontmatter (`auth:` field) and is inheritable via `folder.json` /
  `collection.json` — set once at collection level, every request under it uses it.
- **Acquired tokens, token caches, and client certificates/keys (mTLS)** live inside
  the collection under a `.freepost/` subfolder, so cloning/copying the folder
  carries everything with it.

Leak guardrails (the known risk of this choice — enforced, not hoped for):
- The app writes `.freepost/.gitignore` containing `*` and **regenerates it on every
  launch** — an ignore file *inside* the secrets folder can't be forgotten or lost to
  a repo-root refactor.
- Secret files are written with `0600` permissions.
- On open, if the collection is a git repo, the app runs a tracked-secrets check
  (`git ls-files .freepost/`) and shows a prominent warning if anything under
  `.freepost/` is tracked (e.g. someone forced it in with `git add -f`).
- Client cert *paths* referenced in `folder.json`/`collection.json` are
  collection-relative, so the folder stays relocatable.

### Saved examples & history (decided)

- **Saved response examples** are curated, shareable documentation: JSON sidecar next
  to the request (`Get user by id.examples.json`), renamed/moved in lockstep with the
  request file by the app. Committed to git, PR-reviewable, and the future data
  source for a post-1.0 mock server (the Postman model).
- **Request history** is automatic personal noise: JSON under `.freepost/history/`
  (git-ignored by the guardrails above, travels with the collection folder), with a
  configurable retention cap (default: last 500 entries per collection).

### Workflows

An ordered set of requests played **one at a time, strictly sequentially** — each
step waits for the previous request to fully finish (response received, test script
completed) before the next fires.

**Storage** — JSON files in the collection folder (per the non-request = JSON rule),
placeable anywhere in the collection tree; filename = workflow name
(`Signup smoke test.workflow.json`):

```json
{
  "description": "End-to-end signup happy path",
  "steps": [
    { "request": "auth/Create account.curl" },
    { "request": "auth/Create account.curl", "expectError": true },
    { "request": "users/Get profile.curl" }
  ]
}
```

Steps reference requests by **collection-relative path**.

**Execution semantics:**
- A step *errors* when the request fails at transport level, returns HTTP 4xx/5xx,
  or its test script has failing assertions.
- Default: an erroring step **halts the workflow**.
- `expectError: true` (a checkbox on each step in the UI): the step is *supposed* to
  error — e.g. the duplicate-signup step above asserting a 409 — and the workflow
  continues to the next step. If an expect-error step unexpectedly *succeeds*, the
  run continues but the step is flagged with a warning in the run report.
- **Workflows never override variables** (decided — kept simple). Steps carry no
  per-step values; every request resolves exactly as it would standalone:
  session > environment > its own parameters. Requests write to the session as they
  run — capture a token in step 1, step 3 reads it from the session. Run results
  append to `.freepost/history/`.

**Reference validation** — workflow references are paths, so deletes/moves/renames
outside the app can break them:
- **On open** (and on every filesystem-watcher event while a workflow is open), all
  step references are resolved. Broken steps are flagged inline and an alert lists
  every problematic step with fix actions: *relink* (file picker / search by name) or
  *remove step*. A workflow with broken steps cannot run until addressed.
- **In-app renames/moves auto-heal**: when a request is renamed or moved inside the
  app, the app rewrites all workflow references to it — so references only break via
  external edits, which the validator catches.

### Search

The requests panel gets a search box backed by an in-memory index built from the
frontmatter of every request file in the open collection(s):

- **Indexed fields**: request name (filename), `label`, `description`, URL, and method
  (the latter two parsed from the curl/websocat command). Workflow files are indexed
  too (name, description), so workflows surface in the same search.
- **Query syntax**: free text matches name/description/URL; `label:smoke` filters by
  label (clickable label chips in the panel do the same); terms combine with AND.
- **Freshness**: the filesystem watcher that already mirrors external edits into the
  app also invalidates/rebuilds index entries, so files edited outside the app (or
  pulled via git) are searchable immediately. Index is in-memory only — rebuilt on
  open, never persisted, so no cache-staleness class of bugs.

### WebSocket files: websocat format (decided)

**Decision: websocat.** ([vi/websocat](https://github.com/vi/websocat), Rust) — the
de-facto "curl for WebSockets" and the most-starred WS CLI; wscat (npm) is simpler but
less capable, and curl's own ws:// support is still experimental with awkward
message-oriented use. WebSocket requests persist as annotated **websocat** command
lines, same `# @` annotation scheme, with saved message presets in annotations:

```bash
#!/usr/bin/env bash
# ---
# description: Live ticker stream
# label:
#   - streaming
# variables:
#   token: { secret: true }
# messages:
#   subscribe: '{"op":"subscribe","channel":"ticker"}'
#   ping: '{"op":"ping"}'
# ---

BASE_URL="${BASE_URL:-api.example.com}"
TOKEN="${TOKEN:?}"

websocat "wss://${BASE_URL}/stream" \
  --header "Authorization: Bearer ${TOKEN}" \
  --protocol 'v1.ticker'
```

Same commented-YAML frontmatter scheme as `.curl` files (`messages` holds the saved
message presets), so labels, descriptions, variables, and search work identically for
WebSocket requests. File extension: `.ws` (the extension, not the content, tells the
app which engine and writer to use).

- Action item (M4): pin the supported websocat flag subset (as with curl) when
  implementing the writer; the annotation layer keeps the format cheap to evolve.

---

### Network policy (decided: absolute zero)

**The only sockets ever opened are ones the user explicitly initiates** — an
outbound request they send, or a mock server they start (post-1.0; a *listening*
socket, still user-initiated and loopback-bound by default). No telemetry, no
crash reporting, no auto-update, and no update check — not even a manual one.
Users track releases via GitHub. This is a hard, README-stated guarantee and a
code-review invariant: the request engine (`src/engine`) is the sole module
allowed to open a socket — inbound or outbound — making the promise mechanically
auditable (`grep` for network APIs finds one module) — exactly the audit that
locked-down corporate security teams perform. CI enforces it via
`scripts/check-network-fence.mjs` (fencing network imports/APIs to `src/engine`).

## 4. Tech stack

**Recommendation: Electron + React + TypeScript + Node.** Verified rationale:

- Bruno proves this exact stack meets every hard constraint: MIT, Windows/macOS/Linux,
  offline-only, `git clone && npm i && npm run dev`. No native toolchain needed beyond
  Node — the cheapest possible contribution story on Windows.
- The `pm.*` sandbox needs a JS engine; Electron/Node gives you one for free
  (`node:vm` or isolated-vm for untrusted-script hardening). Tauri/Wails would need an
  embedded QuickJS/deno_core plus a Rust/Go toolchain for every contributor.
- ⚠ The research pass validated Electron via Bruno but never adjudicated
  Tauri/Wails/Flutter comparatively. Yaak (Tauri) and Hoppscotch desktop (Tauri) exist
  as counter-examples if binary size matters more than build friction. Decision stands
  on build-friction + JS-engine grounds; revisit only if Electron size becomes a
  user complaint.

Key modules:

| Module | Choice |
|---|---|
| HTTP engine | Node `fetch`/undici (or libcurl via `node-libcurl` if exact curl semantics wanted) |
| curl parse/generate | curlconverter (parser) + own canonical pretty-printer |
| Shell layer | tree-sitter-bash (what curlconverter uses) |
| Script sandbox | `node:vm` → `isolated-vm` later; Chai + chai-postman for `pm.expect` |
| WebSocket engine | `ws` package in-app; websocat syntax on disk only |
| UI | React + CodeMirror 6 (JSON/GraphQL/JS editors) |
| GraphQL | graphql-js for introspection + codemirror-graphql |
| CLI runner (post-1.0) | Same core in a headless `freepost run ./collection` (Newman analog) |

---

## 5. Milestones

**M1 — Core request loop (the spike).** Send REST request, render response
(status/time/size/headers/pretty body). Read/write `.curl` files: commented-YAML
frontmatter parser/writer + curlconverter-based command parser + canonical
pretty-printer, round-trip tests over the supported flag subset. Open any folder as a
collection; app tree = folder tree, request name = filename (rename/move syncs both
ways via filesystem watcher). **CI from day one**: GitHub Actions matrix doing
`git clone && npm i && build` on `windows-latest` + `macos-latest` — the enforcement
mechanism for the core promise — plus the zero-network lint fence (§4).
*Deliverable: usable curl-file editor + HTTP client. The format design risk dies here.*

**M2 — Variables, environments & search.** `${VAR}` variables everywhere (shell
assignment block per file); three-tier resolution `session > environment > request
parameters` with a Session panel (inspect/clear); unresolved-required-variable
warnings before send; environments UI + `*.env.json`; secrets kept out of git (frontmatter
`secret: true` masking); **search panel** (frontmatter index:
name/label/description/URL/method, `label:` filter syntax, label chips); cookie jar;
auth helpers (Basic/Bearer/API key first); `.freepost/` secrets store with
gitignore/permissions/tracked-file guardrails; proxy + custom CA settings.

**M3 — Scripting & runner.** `pm.*` sandbox (request/response/variables/cookies/test/
expect via Chai); pre-request + test scripts per request; `collection.json`/
`folder.json` lifecycle scripts (via referenced `.js` files); collection runner with
ordering, CSV/JSON data files, and `pm.execution.setNextRequest()` wired into the
loop; `pm.sendRequest`; **workflows** (`.workflow.json`: sequential playback,
expect-error steps, reference validation with relink/remove fix flow, auto-heal on
in-app rename/move).

**M4 — GraphQL & WebSocket.** GraphQL editor + introspection; WebSocket client with
message log and presets; websocat on-disk format with a pinned supported-flag subset.

**M5 — Interop & polish (1.0).** OAuth2 flows (config in frontmatter/folder.json,
token cache in `.freepost/`) and mTLS client certificates; Postman collection v2.1
import (existing collections are the adoption funnel), curl paste-import, OpenAPI
import; code generation (via
curlconverter — the stored format is already its input, nearly free); request history;
signed builds optional, with `git clone && npm i && npm start` documented (CI-tested
since M1). Docs note the Windows executability caveat: `.curl`/`.ws` files run
directly only under Git Bash/WSL — the app itself is fully native on Windows.

**Post-1.0 (M6–M10, done):** OAuth2 authorization_code interactive flow, headless
CLI runner, gRPC, mock server, MQTT. **Still deferred:** plugin API.

---

## 6. Website

A static marketing page with a donation link lives at `docs/index.html` — served by
GitHub Pages (Settings → Pages → deploy from `main` / `docs/`). Single self-contained
HTML file: no build step, no external assets (fonts/CDNs), consistent with the
zero-network ethos. Repo: `git@github.com:dlai0001/freepost.git`; donations via
GitHub Sponsors only: https://github.com/sponsors/dlai0001 (page buttons +
`.github/FUNDING.yml`).

## 7. Risks

1. **Custom-format tooling debt** (Bruno's verified DSL→YAML reversal). Mitigate: curl
   syntax is pre-existing, executable, and LLM-native; publish the parser as a
   standalone npm package; keep annotations minimal and schema-documented.
2. **curl flag long tail** (255 args, most ignored even by curlconverter). Mitigate:
   explicit supported subset; preserve-and-warn on unknown flags rather than dropping.
3. **Postman script-API drift** — `pm.*` is theirs to change. Mitigate: target the
   documented stable core; publish a compatibility matrix.
4. **Unverified corners** — GraphQL/gRPC/mock-server details and Tauri-vs-Electron
   were *not* fact-checked by the research pass; each is gated behind a milestone task
   rather than assumed. (The WebSocket CLI question is closed by decision: websocat.)

---

## Sources (confirmed-claim sources)

Postman: [sandbox reference](https://learning.postman.com/docs/tests-and-scripts/write-scripts/postman-sandbox-reference/overview) ·
[test scripts](https://learning.postman.com/docs/tests-and-scripts/write-scripts/test-scripts) ·
[variables](https://learning.postman.com/docs/use/send-requests/variables/variables) ·
[collection runs](https://learning.postman.com/docs/collections/running-collections/intro-to-collection-runs) ·
[chai-postman](https://github.com/postmanlabs/chai-postman)
Prior art: [Bruno](https://github.com/usebruno/bruno) ·
[Bru lang](https://docs.usebruno.com/bru-lang/overview) ·
[Bruno DSL discussion #360](https://github.com/usebruno/bruno/discussions/360) ·
[Hurl FAQ](https://hurl.dev/docs/frequently-asked-questions.html)
Format: [curlconverter](https://github.com/curlconverter/curlconverter) ·
[websocat](https://github.com/vi/websocat)
