#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$ROOT/logs"

cd "$ROOT/web"
if [ "${1:-}" = "--background" ] || [ "${1:-}" = "-d" ]; then
    npm run dev > "$ROOT/logs/web.log" 2>&1 &
    PID=$!
    echo "$PID" > "$ROOT/web.pid"
    echo "Web UI started in background (PID $PID). Visit http://127.0.0.1:5173"
else
    echo "Starting Web UI on http://127.0.0.1:5173 (Ctrl+C to stop)..."
    echo "$$" > "$ROOT/web.pid"
    exec npm run dev
fi
