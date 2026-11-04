#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SERVICE=web
# shellcheck source=scripts/process.sh
source "$ROOT/scripts/process.sh"
stop_service 10
