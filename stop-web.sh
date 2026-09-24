#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
if [ ! -f "$ROOT/web.pid" ]; then
    echo "No recorded web UI process."
    exit 0
fi
PID="$(cat "$ROOT/web.pid")"
case "$PID" in ''|*[!0-9]*) echo "Invalid web UI PID." >&2; exit 1;; esac
if ! kill -0 "$PID" 2>/dev/null; then
    rm -f "$ROOT/web.pid"
    echo "Web UI is already stopped."
    exit 0
fi
kill -TERM "$PID" 2>/dev/null || true
rm -f "$ROOT/web.pid"
echo "Web UI stopped."
