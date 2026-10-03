#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SERVICE=web
# shellcheck source=scripts/process.sh
source "$ROOT/scripts/process.sh"
case "${1:-}" in
    ''|-d|--background) ;;
    *) echo "Usage: ./start-web.sh [-d|--background]" >&2; exit 1;;
esac
acquire_lock
read_pid
if [ -n "$PID" ]; then echo "Chat is already running: http://127.0.0.1:5173"; exit 0; fi
if lsof -nP -iTCP:5173 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port 5173 is already in use; leaving its process alone." >&2
    exit 1
fi
if [ ! -f "$ROOT/web/dist/index.html" ]; then
    echo "Build chat first: npm run build --prefix web" >&2
    exit 1
fi
mkdir -p "$ROOT/logs"
if [ -n "${1:-}" ]; then
    start_detached "$ROOT/logs/web.log" node "$ROOT/web/server.js" --port 5173
else
    node "$ROOT/web/server.js" --port 5173 &
    PID=$!
    trap 'kill -TERM "$PID" 2>/dev/null || true' INT TERM
fi
publish_pid
for ((i=0; i<10; i++)); do
    if ! process_running; then
        rm -f "$PID_FILE"
        if [ -n "${1:-}" ]; then tail -20 "$ROOT/logs/web.log" >&2; fi
        exit 1
    fi
    if curl -fsS --max-time 1 http://127.0.0.1:5173/ >/dev/null 2>&1; then
        echo "Chat ready: http://127.0.0.1:5173 (PID $PID)"
        release_lock
        if [ -z "${1:-}" ]; then wait_foreground; fi
        exit 0
    fi
    sleep 1
done
# Retain the child and its PID after a readiness timeout so stop-web.sh can stop it.
echo "Chat has not become ready; inspect logs/web.log and web.pid." >&2
exit 1
