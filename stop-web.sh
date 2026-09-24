#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
if [ ! -f "$ROOT/web.pid" ]; then echo "No recorded background frontend."; exit 0; fi
PID="$(cat "$ROOT/web.pid")"
case "$PID" in ''|*[!0-9]*) echo "Invalid frontend PID." >&2; exit 1;; esac
if ! kill -0 "$PID" 2>/dev/null; then echo "Frontend is already stopped."; exit 0; fi
case "$(ps -p "$PID" -o command=)" in
  *"$ROOT/web/node_modules/vite/bin/vite.js "*) kill -TERM "$PID"; echo "Frontend stopped.";;
  *) echo "PID does not match this frontend; refusing to stop it." >&2; exit 1;;
esac
