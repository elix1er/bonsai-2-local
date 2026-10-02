#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
# Keep web startup, PID publication, and shutdown from overlapping.
if ! mkdir "$ROOT/web-control.lock" 2>/dev/null; then
    echo "Another web control command is running; try again after it finishes." >&2
    exit 1
fi
trap 'rmdir "$ROOT/web-control.lock"' EXIT
if [ ! -f "$ROOT/web.pid" ]; then
    echo "No recorded web UI process."
    exit 0
fi
PID="$(cat "$ROOT/web.pid")"
case "$PID" in ''|*[!0-9]*|0*|1) echo "Invalid web UI PID." >&2; exit 1;; esac
# Return success only for a live process that has not become a zombie.
process_running() {
    local state
    state="$(ps -p "$PID" -o stat= 2>/dev/null)" || return 1
    case "$state" in *Z*) return 1;; esac
    kill -0 "$PID" 2>/dev/null
}
if ! process_running; then
    rm -f "$ROOT/web.pid"
    echo "Web UI is already stopped."
    exit 0
fi
case "$(ps -p "$PID" -o command=)" in
    *"node $ROOT/web/node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173 --strictPort") ;;
    *) echo "PID $PID belongs to another process; refusing to stop it." >&2; exit 1;;
esac
kill -TERM "$PID"
for ((i=0; i<10; i++)); do
    if ! process_running; then
        rm -f "$ROOT/web.pid"
        echo "Web UI stopped."
        exit 0
    fi
    sleep 1
done
echo "PID $PID has not exited; inspect it before taking further action." >&2
exit 1
