# Freepost

**The API client that never phones home.**

An open-source Postman alternative for REST, GraphQL, and WebSocket testing —
built for developers behind corporate firewalls.

- **No account. No cloud. No registration.** Ever.
- **No unsolicited network calls.** The only sockets ever opened are ones you
  explicitly initiate — a request you send, or a mock server you start. No
  telemetry, no crash reporting, no update checks. The request engine is the
  only module in the codebase allowed to open a socket, and CI enforces it.
- **Your requests are curl.** Collections are folders on disk you choose; every
  request is a pretty-printed, *runnable* curl command (websocat for WebSocket)
  with YAML-in-comments frontmatter. `bash` runs it, `git diff` reviews it, any
  tool that imports curl understands it.
- **Postman-compatible scripting.** Pre-request and test scripts with the `pm.*`
  API and Chai assertions.
- **Workflows.** Ordered request runs with expect-error steps and reference
  validation.
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
