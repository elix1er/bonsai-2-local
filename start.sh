#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
BIN="$ROOT/runtime/bin/mac/llama-server"
MODEL="$ROOT/models/Ternary-Bonsai-2-27B-PQ2_0.gguf"
mkdir -p "$ROOT/logs"
if [ -f "$ROOT/server.pid" ]; then
    PID="$(cat "$ROOT/server.pid")"
    case "$PID" in ''|*[!0-9]*) echo "Invalid PID file." >&2; exit 1;; esac
    if kill -0 "$PID" 2>/dev/null; then
        case "$(ps -p "$PID" -o command=)" in
            "$BIN "*) echo "Bonsai is already running. Check http://127.0.0.1:8080/health"; exit 0;;
            *) echo "Recorded PID belongs to another process; inspect server.pid." >&2; exit 1;;
        esac
    fi
fi
if lsof -nP -iTCP:8080 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port 8080 is already in use; leaving its process alone." >&2
    exit 1
fi
test -x "$BIN"
test -f "$MODEL"
PID="$(python3 - "$ROOT" "$BIN" \
    --model "$MODEL" --alias bonsai-2-27b \
    --host 127.0.0.1 --port 8080 \
    --ctx-size 32768 --parallel 1 \
    --n-gpu-layers 999 --flash-attn on \
    --cache-type-k f16 --cache-type-v f16 --cache-ram 0 \
    --batch-size 2048 --ubatch-size 512 \
    --jinja --temp 1.0 --top-p 0.95 --top-k 20 --min-p 0 \
    --no-webui <<'PY'
import pathlib, subprocess, sys
root = pathlib.Path(sys.argv[1])
with (root / 'logs/server.log').open('w') as log:
    process = subprocess.Popen(sys.argv[2:], stdin=subprocess.DEVNULL,
                               stdout=log, stderr=log, start_new_session=True)
print(process.pid)
PY
)"
echo "$PID" > "$ROOT/server.pid"
echo "Starting Bonsai, PID $PID. Log: $ROOT/logs/server.log"
for ((i=0; i<180; i++)); do
    if curl -fsS --max-time 1 http://127.0.0.1:8080/health >/dev/null 2>&1; then
        echo "Ready: http://127.0.0.1:8080/v1 (model: bonsai-2-27b)"
        exit 0
    fi
    if ! kill -0 "$PID" 2>/dev/null; then
        tail -40 "$ROOT/logs/server.log" >&2
        exit 1
    fi
    sleep 1
done
echo "Still loading; inspect $ROOT/logs/server.log and /health." >&2
exit 1
