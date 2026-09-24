#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
if [ ! -f "$ROOT/tunnel.pid" ]; then echo "No recorded tunnel."; exit 0; fi
PID="$(cat "$ROOT/tunnel.pid")"
case "$PID" in ''|*[!0-9]*) echo "Invalid tunnel PID." >&2; exit 1;; esac
if ! kill -0 "$PID" 2>/dev/null; then echo "Tunnel is already stopped."; exit 0; fi
case "$(ps -p "$PID" -o command=)" in
    "$ROOT/bin/cloudflared tunnel "*) kill -TERM "$PID"; echo "Sharing stopped. Local chat stays running.";;
    *) echo "Recorded PID does not match this tunnel; refusing to stop it." >&2; exit 1;;
esac
