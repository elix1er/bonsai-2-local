#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RELEASE_TAG="prism-b10709-9a9394a"
ASSET="llama-${RELEASE_TAG}-bin-macos-arm64.tar.gz"
URL="https://github.com/PrismML-Eng/llama.cpp/releases/download/${RELEASE_TAG}/${ASSET}"
DEST="$ROOT/runtime/bin/mac"

echo "==> Setting up PrismML compatible llama.cpp runtime for Bonsai 2 ($RELEASE_TAG)..."

if [ -x "$DEST/llama-server" ]; then
    echo "Runtime binary already exists at $DEST/llama-server."
    exit 0
fi

TMP="$(mktemp -t bonsai_runtime.XXXXXX)"
trap 'rm -f "$TMP"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "Downloading $URL..."
curl -fL --progress-bar "$URL" -o "$TMP"

mkdir -p "$DEST"
echo "Extracting runtime to $DEST..."
tar -xzf "$TMP" -C "$DEST" --strip-components=1 2>/dev/null || tar -xzf "$TMP" -C "$DEST"
rm -f "$TMP"

echo "Clearing macOS quarantine & codesigning..."
xattr -cr "$DEST" 2>/dev/null || true
for bin in "$DEST"/llama-*; do
    [ -f "$bin" ] && codesign -s - --force --timestamp=none "$bin" 2>/dev/null || true
done

echo "Validating runtime binary..."
"$DEST/llama-server" --version || "$DEST/llama-server" --help >/dev/null

echo "Runtime successfully installed to $DEST."
