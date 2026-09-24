#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "=========================================================="
echo "    Bonsai 2 (27B PQ2_0) Local Inference Stack Setup     "
echo "=========================================================="

# Check architecture
ARCH="$(uname -m)"
OS="$(uname -s)"

if [ "$OS" != "Darwin" ] || [ "$ARCH" != "arm64" ]; then
    echo "Warning: This setup is optimized for Apple Silicon (macOS arm64)."
fi

# Step 1: Download PrismML compatible runtime
chmod +x "$ROOT/scripts/download_runtime.sh"
"$ROOT/scripts/download_runtime.sh"

# Step 2: Download Bonsai 2 27B PQ2_0 Model
python3 "$ROOT/scripts/download_model.py"

# Step 3: Install Web UI Dependencies
if [ -d "$ROOT/web" ]; then
    echo "==> Installing Vite Web UI dependencies..."
    npm install --prefix "$ROOT/web" --no-audit --no-fund
    npm run build --prefix "$ROOT/web"
fi

# Step 4: Ensure helper scripts are executable
chmod +x "$ROOT"/*.sh

echo ""
echo "Setup complete!"
echo "To start the model server:     ./start.sh"
echo "To start the chat frontend:    ./start-web.sh"
echo "To share via Cloudflare tunnel: ./share.sh"
echo "To stop services:              ./stop.sh / ./stop-web.sh / ./stop-share.sh"
