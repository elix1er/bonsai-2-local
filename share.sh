#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SERVICE=tunnel
# shellcheck source=scripts/process.sh
source "$ROOT/scripts/process.sh"
acquire_lock
read_pid
if [ -n "$PID" ]; then echo "Sharing is already running, PID $PID."; exit 0; fi
if [ ! -x "$ROOT/bin/cloudflared" ]; then
    echo "Place a cloudflared executable at bin/cloudflared first." >&2
    exit 1
fi
curl -fsS --max-time 4 http://127.0.0.1:5173/api/health >/dev/null
echo "This temporary URL exposes chat publicly without a password. Anyone with it can use your model."
echo "Remote replies arrive when complete. Keep this terminal open; Ctrl+C stops sharing."
"$ROOT/bin/cloudflared" tunnel --no-autoupdate --protocol http2 \
    --proxy-keepalive-timeout 30m --url http://127.0.0.1:5173 \
    --http-host-header 127.0.0.1:5173 &
PID=$!
publish_pid
wait_foreground
