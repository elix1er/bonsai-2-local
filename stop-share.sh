#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
if [ ! -f "$ROOT/tunnel.pid" ]; then echo "No recorded tunnel."; exit 0; fi
PID="$(cat "$ROOT/tunnel.pid")"
case "$PID" in ''|*[!0-9]*|0*|1) echo "Invalid tunnel PID." >&2; exit 1;; esac
process_running() {
    local state
    state="$(ps -p "$PID" -o stat= 2>/dev/null)" || return 1
    case "$state" in *Z*) return 1;; esac
    kill -0 "$PID" 2>/dev/null
}
if ! process_running; then rm -f "$ROOT/tunnel.pid"; echo "Tunnel is already stopped."; exit 0; fi
case "$(ps -p "$PID" -o command=)" in
    "$ROOT/bin/cloudflared tunnel "*) ;;
    *) echo "Recorded PID does not match this tunnel; refusing to stop it." >&2; exit 1;;
esac
kill -TERM "$PID"
for ((i=0; i<10; i++)); do
    if ! process_running; then
        rm -f "$ROOT/tunnel.pid"
        echo "Sharing stopped. Local chat stays running."
        exit 0
    fi
    sleep 1
done
echo "PID $PID has not exited; inspect it before taking further action." >&2
exit 1
