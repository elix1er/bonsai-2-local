#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
curl -fsS http://127.0.0.1:5173/api/health >/dev/null
echo "Keep this terminal open. Ctrl+C stops sharing."
echo "The temporary public URL will appear below."
echo "$$" > "$ROOT/tunnel.pid"
exec "$ROOT/bin/cloudflared" tunnel --no-autoupdate --url http://127.0.0.1:5173 --http-host-header 127.0.0.1:5173
