#!/usr/bin/env bash
# run-suite.sh — launch any dev-tooling suite with the headless-chromium env
# wired (LD_LIBRARY_PATH is required for the @sparticuz/chromium binary that
# dev-tooling/extract-chromium.mjs places in /tmp/al2023).
# Usage: bash dev-tooling/run-suite.sh dev-tooling/<suite>.mjs [args…]
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -x /tmp/al2023/chromium ]; then
  echo "· chromium missing — re-extracting…"
  node dev-tooling/extract-chromium.mjs >/dev/null
fi
export LD_LIBRARY_PATH=/tmp/al2023/lib
exec node "$@"
