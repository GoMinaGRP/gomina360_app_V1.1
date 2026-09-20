#!/usr/bin/env bash
# bootstrap-install.sh — first half of sandbox-reset recovery.
# The sandbox periodically wipes everything untracked (node_modules, .next,
# .env, /home/user/pgtooling incl. the Postgres data dir). This script restores
# the *install-time* artifacts; bootstrap-sandbox.sh then rebuilds services +
# data. Idempotent — safe to re-run. Usage: bash dev-tooling/bootstrap-install.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# 1) dependencies
if [ ! -x node_modules/.bin/next ]; then
  echo "· installing dependencies…"
  npm ci --no-audit --no-fund
else
  echo "✔ dependencies already installed"
fi

# 2) environment (untracked, wiped on reset)
if [ ! -f .env ]; then
  echo "· writing .env"
  printf '%s\n' \
    "DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db" \
    "NEXT_TELEMETRY_DISABLED=1" > .env
else
  echo "✔ .env present"
fi

echo "✅ bootstrap-install complete. Next: bash dev-tooling/bootstrap-sandbox.sh"
