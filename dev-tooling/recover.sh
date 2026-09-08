#!/usr/bin/env bash
# GoMina 360 — one-command sandbox recovery.
# Rebuilds everything after a platform reset: deps, Postgres, schema, app
# build, seed data, and the owner's Payroll/Audit data replay.
#
#   bash dev-tooling/recover.sh
#
# Env knobs: GOMINA_OWNER_PW (default Owner@GoMina26), SKIP_BUILD=1,
# RESTORE=0 (skip the user-data replay).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS=/home/user/pgtooling
export DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:5432/app_db}"
export GOMINA_OWNER_PW="${GOMINA_OWNER_PW:-Owner@GoMina26}"

echo "── 1/7 repo deps"
cd "$REPO"; [ -d node_modules ] || npm ci

echo "── 2/7 tooling deps"
mkdir -p "$TOOLS"; cd "$TOOLS"
[ -f package.json ] || npm init -y > /dev/null
[ -d node_modules/embedded-postgres ] || npm install embedded-postgres@latest pg@8.20.0 puppeteer-core@latest @sparticuz/chromium@latest

echo "── 3/7 postgres"
cd "$REPO"
if ! node dev-tooling/q.mjs "SELECT 1" > /dev/null 2>&1; then
  (cd "$TOOLS" && nohup node "$REPO/dev-tooling/start-pg.mjs" > "$TOOLS/pg.log" 2>&1 & echo $! > "$TOOLS/pg.pid")
  for i in $(seq 1 30); do node dev-tooling/q.mjs "SELECT 1" > /dev/null 2>&1 && break; sleep 1; done
fi
node dev-tooling/q.mjs "SELECT 1" > /dev/null && echo "PG up"

echo "── 4/7 chromium (E2E)"
[ -x /tmp/al2023/chromium ] || node dev-tooling/extract-chromium.mjs

echo "── 5/7 schema + build"
printf 'y\n' | npx drizzle-kit push
if [ "${SKIP_BUILD:-0}" != "1" ]; then npm run build; fi

echo "── 6/7 app server"
pkill -f "next-server" 2>/dev/null || true
(nohup npx next start -H 0.0.0.0 -p 3000 > /tmp/gomina-app.log 2>&1 & echo $! > /tmp/gomina-app.pid)
for i in $(seq 1 40); do curl -s -o /dev/null http://localhost:3000/ && break; sleep 1; done
echo "app up on :3000"

echo "── 7/7 seed + owner data"
curl -s -o /dev/null http://localhost:3000/api/init || true   # seeds when empty
if [ "${RESTORE:-1}" = "1" ]; then node dev-tooling/restore-userdata.mjs; fi
# Replay the live-data safety net (UI-created units/orders/customers — the
# data no fixture knows about). Idempotent ON CONFLICT (id) DO NOTHING.
node dev-tooling/restore-livedata.mjs || true
# Heal the owner's REAL GoMina crest (business/branch/company logos) if the
# rebuild rolled the DB back to a snapshot taken before his upload.
node dev-tooling/restore-branding.mjs
echo "RECOVERY COMPLETE — verify: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-live.mjs"
