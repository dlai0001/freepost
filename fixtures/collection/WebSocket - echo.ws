#!/usr/bin/env bash
# ---
# description: 'WebSocket fixture: echo server + a tick every 2s (long-lived — connect from the app).'
# label:
#   - websocket
#   - streaming
# messages:
#   ping: '{"op":"ping"}'
#   hello: hello fixture
# ---

WS_URL="${WS_URL:-ws://localhost:3013}"

websocat "${WS_URL}"
