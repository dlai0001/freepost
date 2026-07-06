#!/usr/bin/env bash
# ---
# description: Echo WebSocket demo (run a local echo server to try it)
# label:
#   - demo
#   - ws
# messages:
#   hello: '{"op":"hello","from":"freepost"}'
#   ping: '{"op":"ping"}'
# ---

WS_URL="${WS_URL:-ws://localhost:9090}"

websocat "${WS_URL}"
