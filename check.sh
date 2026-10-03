#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
for tool in shellcheck bun; do
    if ! command -v "$tool" >/dev/null; then echo "Missing check tool: $tool" >&2; exit 1; fi
done
shellcheck -x ./*.sh scripts/*.sh
bun run --cwd web format:check
bun run --cwd web build
bun run --cwd web test
git diff --check
