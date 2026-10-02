#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "=========================================================="
echo "    Bonsai 2 (27B PQ2_0) Local Inference Stack Setup     "
echo "=========================================================="

ARCH="$(uname -m)"
OS="$(uname -s)"

if [ "$OS" != "Darwin" ] || [ "$ARCH" != "arm64" ]; then
    echo "Warning: This setup is optimized for Apple Silicon (macOS arm64)."
fi

chmod +x "$ROOT/scripts/download_runtime.sh"
"$ROOT/scripts/download_runtime.sh"

python3 "$ROOT/scripts/download_model.py"

if [ -d "$ROOT/web" ]; then
    echo "==> Installing Vite Web UI dependencies..."
    npm ci --prefix "$ROOT/web" --no-audit --no-fund
    npm run build --prefix "$ROOT/web"
fi

chmod +x "$ROOT"/*.sh

echo ""
echo "Setup complete!"
echo "To start the model server:     ./start.sh"
echo "To start the chat frontend:    ./start-web.sh"
echo "To share via Cloudflare tunnel: ./share.sh"
echo "To stop services:              ./stop.sh / ./stop-web.sh / ./stop-share.sh"
