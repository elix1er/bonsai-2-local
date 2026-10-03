#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "=========================================================="
echo "    Bonsai 2 (27B PQ2_0) Local Inference Stack Setup     "
echo "=========================================================="

if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
    echo "This setup requires macOS on Apple Silicon." >&2
    exit 1
fi
for tool in python3 node npm curl tar xattr codesign lsof; do
    if ! command -v "$tool" >/dev/null; then echo "Missing prerequisite: $tool" >&2; exit 1; fi
done
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (!((major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22)) { console.error("Use Node 20.19+ or 22.12+; Node 21 is unsupported."); process.exit(1); }'
python3 - "$ROOT" <<'PYTHON'
import pathlib
import shutil
import sys
root = pathlib.Path(sys.argv[1])
model = root / 'models/Ternary-Bonsai-2-27B-PQ2_0.gguf'
required = 1024**3 if model.is_file() and model.stat().st_size == 7206168928 else 12 * 1024**3
if shutil.disk_usage(root).free < required:
    sys.exit(f"Setup needs at least {required // 1024**3} GiB of free disk space.")
PYTHON

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
