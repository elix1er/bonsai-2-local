#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
VITE="$ROOT/web/node_modules/vite/bin/vite.js"
case "${1:-}" in
    ''|-d|--background) ;;
    *) echo "Usage: ./start-web.sh [-d|--background]" >&2; exit 1;;
esac
# Keep web startup, PID publication, and shutdown from overlapping.
if ! mkdir "$ROOT/web-control.lock" 2>/dev/null; then
    echo "Another web control command is running; try again after it finishes." >&2
    exit 1
fi
trap 'rmdir "$ROOT/web-control.lock"' EXIT
if [ -f "$ROOT/web.pid" ]; then
    PID="$(cat "$ROOT/web.pid")"
    case "$PID" in ''|*[!0-9]*|0*|1) echo "Invalid web UI PID." >&2; exit 1;; esac
    if kill -0 "$PID" 2>/dev/null && [[ "$(ps -p "$PID" -o stat= 2>/dev/null)" != *Z* ]]; then
        case "$(ps -p "$PID" -o command=)" in
            *"node $VITE --host 127.0.0.1 --port 5173 --strictPort") echo "Web UI is already running: http://127.0.0.1:5173"; exit 0;;
            *) echo "Recorded PID belongs to another process; inspect web.pid." >&2; exit 1;;
        esac
    fi
fi
if lsof -nP -iTCP:5173 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port 5173 is already in use; leaving its process alone." >&2
    exit 1
fi
test -f "$VITE"
mkdir -p "$ROOT/logs"
cd "$ROOT/web"
if [ -n "${1:-}" ]; then
    PID="$(python3 - "$ROOT" "$VITE" <<'PYTHON'
import pathlib, subprocess, sys
root = pathlib.Path(sys.argv[1])
with (root / 'logs/web.log').open('w') as log:
    process = subprocess.Popen(['node', sys.argv[2], '--host', '127.0.0.1',
                                '--port', '5173', '--strictPort'],
                               stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                               start_new_session=True)
print(process.pid)
PYTHON
)"
else
    echo "Starting web UI: http://127.0.0.1:5173 (Ctrl+C to stop)"
    node "$VITE" --host 127.0.0.1 --port 5173 --strictPort &
    PID=$!
    trap 'kill -TERM "$PID" 2>/dev/null || true' INT TERM
fi
echo "$PID" > "$ROOT/web.pid"
for ((i=0; i<10; i++)); do
    if ! kill -0 "$PID" 2>/dev/null; then
        rm -f "$ROOT/web.pid"
        if [ -n "${1:-}" ]; then tail -20 "$ROOT/logs/web.log" >&2; fi
        exit 1
    fi
    if curl -fsS --max-time 1 http://127.0.0.1:5173/ >/dev/null 2>&1; then
        echo "Web UI ready: http://127.0.0.1:5173 (PID $PID)"
        rmdir "$ROOT/web-control.lock"
        trap - EXIT
        if [ -z "${1:-}" ]; then
            wait "$PID"
        fi
        exit 0
    fi
    sleep 1
done
echo "Web UI has not become ready; inspect logs/web.log and web.pid." >&2
exit 1
