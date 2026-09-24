#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
if [ ! -f "$ROOT/server.pid" ]; then
    echo "No recorded Bonsai server."
    exit 0
fi
PID="$(cat "$ROOT/server.pid")"
case "$PID" in ''|*[!0-9]*) echo "Invalid PID file." >&2; exit 1;; esac
if ! kill -0 "$PID" 2>/dev/null; then
    rm "$ROOT/server.pid"
    echo "Bonsai is already stopped."
    exit 0
fi
COMMAND="$(ps -p "$PID" -o command=)"
case "$COMMAND" in
    "$ROOT/runtime/bin/mac/llama-server "*) ;;
    *) echo "PID $PID belongs to another process; refusing to stop it." >&2; exit 1;;
esac
kill -TERM "$PID"
for ((i=0; i<30; i++)); do
    if ! kill -0 "$PID" 2>/dev/null; then
        rm "$ROOT/server.pid"
        echo "Bonsai stopped."
        exit 0
    fi
    sleep 1
done
echo "PID $PID has not exited; inspect it before taking further action." >&2
exit 1
