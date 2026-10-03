#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RELEASE_TAG="prism-b10709-9a9394a"
ASSET="llama-${RELEASE_TAG}-bin-macos-arm64.tar.gz"
SHA256="f9cdf245fb7b832f1996dd776b321d4ae1f23b6d88c380100f636742c3a980ff"
URL="https://github.com/PrismML-Eng/llama.cpp/releases/download/${RELEASE_TAG}/${ASSET}"
DEST="$ROOT/runtime/bin/mac"

if [ -x "$DEST/llama-server" ]; then
    if "$DEST/llama-server" --version 2>&1 | grep -F -- 'build 10709, commit 9a9394a' >/dev/null; then
        echo "Pinned Prism runtime is already installed."
        exit 0
    fi
    echo "Existing runtime does not match $RELEASE_TAG. Move runtime/ aside before setup." >&2
    exit 1
fi
mkdir -p "$(dirname "$DEST")"
TMP="$(mktemp -t bonsai_runtime.XXXXXX)"
STAGE="$(mktemp -d "$ROOT/runtime/bin/.mac.XXXXXX")"
trap 'rm -f "$TMP"; rm -rf "$STAGE"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
curl -fL --progress-bar "$URL" -o "$TMP"
python3 - "$TMP" "$SHA256" <<'PYTHON'
import hashlib
import pathlib
import sys
if hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest() != sys.argv[2]:
    sys.exit('Runtime archive checksum mismatch; refusing to extract it.')
PYTHON
tar -xzf "$TMP" -C "$STAGE" --strip-components=1
xattr -cr "$STAGE"
for binary in "$STAGE"/llama-*; do
    if [ -f "$binary" ]; then codesign -s - --force --timestamp=none "$binary"; fi
done
"$STAGE/llama-server" --version 2>&1 | grep -F -- 'build 10709, commit 9a9394a'
if [ -d "$DEST" ]; then
    if ! rmdir "$DEST" 2>/dev/null; then
        echo "Incomplete runtime directory is not empty. Move runtime/ aside before setup." >&2
        exit 1
    fi
fi
python3 - "$STAGE" "$DEST" <<'PYTHON'
import os
import sys
os.rename(sys.argv[1], sys.argv[2])
PYTHON
echo "Runtime installed and verified: $DEST."
