#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SERVICE=server
# shellcheck source=scripts/process.sh
source "$ROOT/scripts/process.sh"
BIN="$ROOT/runtime/bin/mac/llama-server"
MODEL_KIND="${1:-bonsai}"
case "$MODEL_KIND" in
    bonsai) MODEL="$ROOT/models/Ternary-Bonsai-2-27B-PQ2_0.gguf" ;;
    abliterated) MODEL="$ROOT/models/Huihui-Qwen3.8-27B-abliterated-Ternary-Bonsai-PQ2_0.gguf" ;;
    *) echo "Usage: ./start.sh [bonsai|abliterated]" >&2; exit 2 ;;
esac
acquire_lock
read_pid
if [ -n "$PID" ]; then echo "Bonsai is already running. Check http://127.0.0.1:8080/health"; exit 0; fi
if lsof -nP -iTCP:8080 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port 8080 is already in use; leaving its process alone." >&2
    exit 1
fi
test -x "$BIN"
if [ ! -f "$MODEL" ]; then
    echo "Model missing: run ./setup.sh $MODEL_KIND first." >&2
    exit 1
fi
mkdir -p "$ROOT/logs"
start_detached "$ROOT/logs/server.log" "$BIN" \
    --model "$MODEL" --alias bonsai-2-27b \
    --host 127.0.0.1 --port 8080 \
    --ctx-size 32768 --parallel 1 \
    --n-gpu-layers 999 --flash-attn on \
    --cache-type-k f16 --cache-type-v f16 --cache-ram 0 \
    --batch-size 2048 --ubatch-size 512 \
    --jinja --temp 1.0 --top-p 0.95 --top-k 20 --min-p 0 \
    --no-webui
publish_pid
echo "Starting $MODEL_KIND, PID $PID. Log: $ROOT/logs/server.log"
for ((i=0; i<180; i++)); do
    if ! process_running; then
        rm -f "$PID_FILE"
        tail -40 "$ROOT/logs/server.log" >&2
        exit 1
    fi
    if curl -fsS --max-time 1 http://127.0.0.1:8080/health >/dev/null 2>&1; then
        echo "Ready: http://127.0.0.1:8080/v1 (variant: $MODEL_KIND, API alias: bonsai-2-27b)"
        exit 0
    fi
    sleep 1
done
echo "Still loading; inspect logs/server.log and /health. PID retained for ./stop.sh." >&2
exit 1
