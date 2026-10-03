#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
for tool in shellcheck ruff python3 node npm; do
    if ! command -v "$tool" >/dev/null; then echo "Missing check tool: $tool" >&2; exit 1; fi
done
shellcheck -x ./*.sh scripts/*.sh
ruff check scripts/ tests/
python3 -m unittest discover -s tests
npm run format:check --prefix web
npm run build --prefix web
npm test --prefix web
git diff --check
