#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
MODEL_KIND="${1:-bonsai}"
case "$MODEL_KIND" in
    bonsai|abliterated) ;;
    *) echo "Usage: ./setup.sh [bonsai|abliterated]" >&2; exit 2 ;;
esac

if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
    echo "This setup requires macOS on Apple Silicon." >&2
    exit 1
fi
for tool in bun curl tar xattr codesign lsof; do
    if ! command -v "$tool" >/dev/null; then echo "Missing prerequisite: $tool" >&2; exit 1; fi
done
bun -e 'const [major, minor] = Bun.version.split(".").map(Number); if (major < 1 || (major === 1 && minor < 4)) { console.error("Use Bun 1.4 or newer."); process.exit(1); }'
bun "$ROOT/scripts/preflight.ts" "$ROOT" "$MODEL_KIND"

SERVICE=setup
# shellcheck source=scripts/process.sh
source "$ROOT/scripts/process.sh"
acquire_lock

chmod +x "$ROOT/scripts/download_runtime.sh"
"$ROOT/scripts/download_runtime.sh"

bun "$ROOT/scripts/download_model.ts" "$MODEL_KIND"

if [ -d "$ROOT/web" ]; then
    echo "==> Installing Vite Web UI dependencies..."
    bun install --cwd "$ROOT/web" --frozen-lockfile --ignore-scripts
    bun run --cwd "$ROOT/web" build
fi

chmod +x "$ROOT"/*.sh

echo "Start the model with ./start.sh $MODEL_KIND, then run ./start-web.sh -d."
