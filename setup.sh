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
for tool in python3 bun curl tar xattr codesign lsof; do
    if ! command -v "$tool" >/dev/null; then echo "Missing prerequisite: $tool" >&2; exit 1; fi
done
bun -e 'const [major, minor] = Bun.version.split(".").map(Number); if (major < 1 || (major === 1 && minor < 4)) { console.error("Use Bun 1.4 or newer."); process.exit(1); }'
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

SERVICE=setup
# shellcheck source=scripts/process.sh
source "$ROOT/scripts/process.sh"
acquire_lock

chmod +x "$ROOT/scripts/download_runtime.sh"
"$ROOT/scripts/download_runtime.sh"

python3 "$ROOT/scripts/download_model.py"

if [ -d "$ROOT/web" ]; then
    echo "==> Installing Vite Web UI dependencies..."
    bun install --cwd "$ROOT/web" --frozen-lockfile
    bun run --cwd "$ROOT/web" build
fi

chmod +x "$ROOT"/*.sh

echo ""
echo "Setup complete!"
echo "To start the model server:     ./start.sh"
echo "To start the chat frontend:    ./start-web.sh"
echo "To share via Cloudflare tunnel: ./share.sh"
echo "To stop services:              ./stop.sh / ./stop-web.sh / ./stop-share.sh"
