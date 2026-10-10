#!/usr/bin/env bash
# preview-up.sh — one-command recovery for the sandbox preview.
#
# The sandbox periodically wipes everything untracked: node_modules, .next,
# /tmp (chromium, push-test cert) and /home/user/pgtooling (incl. the Postgres
# data dir). When that happens the preview server dies and the next request to
# "run the server" needs the whole environment rebuilt. This script does that
# idempotently — safe to re-run any time, including when everything is already
# up (it then only re-checks health).
#
# Usage:  bash dev-tooling/preview-up.sh          # bring the preview up
#         bash dev-tooling/preview-up.sh --status # report state, change nothing
set -euo pipefail
cd "$(dirname "$0")/.."
export DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:5432/app_db}"
export NEXT_TELEMETRY_DISABLED=1
OWNER_EMAIL="kwame.owner@gomina360.com"
OWNER_PW="${GOMINA_OWNER_PW:-Owner@GoMina26}"
STATUS_ONLY=0
[ "${1:-}" = "--status" ] && STATUS_ONLY=1

say() { echo "· $*"; }
ok()  { echo "  ✔ $*"; }

app_up() { [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3000/ 2>/dev/null || echo 000)" = "200" ]; }

if [ "$STATUS_ONLY" = 1 ]; then
  echo "repo:     $(git rev-parse --short HEAD 2>/dev/null || echo 'not a repo') ($(git status --porcelain | wc -l) dirty)"
  echo "deps:     $([ -x node_modules/.bin/next ] && echo present || echo MISSING)"
  echo "build:    $([ -f .next/BUILD_ID ] && echo present || echo MISSING)"
  echo "postgres: $(ss -lptn 2>/dev/null | grep -q ':5432 ' && echo listening || echo DOWN)"
  echo "app:      $(app_up && echo 'up on :3000' || echo DOWN)"
  exit 0
fi

# ── 1) dependencies ────────────────────────────────────────────────────────
if [ ! -x node_modules/.bin/next ]; then
  say "installing dependencies (npm ci)…"
  npm ci --no-audit --no-fund >/tmp/preview-npm.log 2>&1 || { tail -15 /tmp/preview-npm.log; exit 1; }
  ok "dependencies installed"
else
  ok "dependencies present"
fi
[ -f .env ] || { printf '%s\n' "DATABASE_URL=$DATABASE_URL" "NEXT_TELEMETRY_DISABLED=1" > .env; }

# ── 2) Postgres ────────────────────────────────────────────────────────────
if ss -lptn 2>/dev/null | grep -q ':5432 '; then
  ok "Postgres already listening"
else
  say "starting embedded Postgres…"
  setsid nohup node dev-tooling/start-pg.mjs </dev/null >/tmp/preview-pg.log 2>&1 & disown
  for _ in $(seq 1 90); do node dev-tooling/q.mjs "select 1" >/dev/null 2>&1 && break; sleep 1; done
  node dev-tooling/q.mjs "select 1" >/dev/null 2>&1 || { echo "✗ Postgres never came up"; tail -10 /tmp/preview-pg.log; exit 1; }
  ok "Postgres up"
fi

# ── 3) schema + canonical seed (only when the database is empty) ────────────
# The old test was `[ -z "$SEEDED" ]` — an EMPTY result means "could not query",
# but a database that came back with 0 users (a partial reset: organizations and
# businesses survived, users did not) produced "0", which is non-empty and was
# therefore read as "already seeded". Every downstream step then ran against an
# empty user table and the owner login failed. Seed when the count is 0.
SEEDED=$(node dev-tooling/q.mjs "select count(*) c from users" 2>/dev/null | grep -oE '"[0-9]+"' | head -1 | tr -d '"' || echo "")
if [ -z "${SEEDED:-}" ] || [ "$SEEDED" = "0" ]; then
  say "applying schema (drizzle-kit push)…"
  printf 'y\n' | npx drizzle-kit push >/tmp/preview-push.log 2>&1 || true
  node dev-tooling/q.mjs "select count(*) from users" >/dev/null 2>&1 || { echo "✗ schema push failed"; tail -15 /tmp/preview-push.log; exit 1; }
  ok "schema applied"
  say "seeding the canonical dataset…"
  npx tsx dev-tooling/run-seed.ts >/tmp/preview-seed.log 2>&1 || { tail -15 /tmp/preview-seed.log; exit 1; }
  ok "seed done ($(node dev-tooling/q.mjs 'select count(*) c from users' | grep -oE '[0-9]+' | head -1) users)"
else
  ok "database already seeded ($SEEDED users)"
fi

# ── 4) restore chain + demo seeders (idempotent) ───────────────────────────
say "restore chain…"
for s in restore-livedata migrate-multiowner seed-recent-demo restore-branding fixtures-e2e fixtures-watermarks-demo; do
  node dev-tooling/$s.mjs >/tmp/preview-$s.log 2>&1 && ok "$s" || { echo "  ✗ $s"; tail -5 /tmp/preview-$s.log; }
done
# NOTE: the demo seeders are HTTP clients — they POST to the running app, so
# they run AFTER the server starts (step 6b below). Running them here failed
# with ECONNREFUSED on every cold start and silently left the feed-mill / fish /
# benchmark demo modules empty.

# Sweep leftover suite fixtures so a suite that aborted before its cleanup
# cannot poison every later run. A single stray test business is enough to make
# the owner-grouping and record-count assertions in verify-business-scope fail
# with an off-by-one that looks like an application bug. This runs AFTER the
# restore chain on purpose — the restore replays the backup, so purging first
# would simply be undone.
if node dev-tooling/purge-test-rows.mjs >/tmp/preview-purge.log 2>&1; then
  ok "fixture purge"
else
  echo "  – fixture purge skipped (see /tmp/preview-purge.log)"
fi

# ── 5) production build (dev mode OOMs this sandbox) ───────────────────────
if [ ! -f .next/BUILD_ID ]; then
  say "building production bundle…"
  npm run build >/tmp/preview-build.log 2>&1 || { tail -15 /tmp/preview-build.log; exit 1; }
  ok "build complete"
else
  ok "build present"
fi

# ── 6) app server on 0.0.0.0:3000 ──────────────────────────────────────────
# The push-test cert (NODE_EXTRA_CA_CERTS) must exist BEFORE the server starts —
# it is read once at process start; verify-notifications depends on it.
if [ ! -s /tmp/pushsrv.pem ]; then
  openssl req -x509 -newkey rsa:2048 -keyout /tmp/pushsrv-key.pem -out /tmp/pushsrv.pem \
    -days 2 -nodes -subj "/CN=localhost" -addext "subjectAltName=IP:127.0.0.1" >/dev/null 2>&1 || true
fi
if app_up; then
  ok "app already listening on :3000"
else
  say "starting the app…"
  setsid nohup env DATABASE_URL="$DATABASE_URL" NEXT_TELEMETRY_DISABLED=1 \
    NODE_EXTRA_CA_CERTS=/tmp/pushsrv.pem \
    npx next start -H 0.0.0.0 -p 3000 >/tmp/preview-app.log 2>&1 & disown
  for _ in $(seq 1 90); do app_up && break; sleep 1; done
  app_up || { echo "✗ app never came up"; tail -15 /tmp/preview-app.log; exit 1; }
  ok "app up"
fi

# ── 7) user data + health probe ────────────────────────────────────────────
if [ ! -x /tmp/al2023/chromium ]; then node dev-tooling/extract-chromium.mjs >/dev/null 2>&1 || true; fi
TOKEN=$(curl -s -X POST http://127.0.0.1:3000/api/auth/login -H 'Content-Type: application/json' \
  -d "{\"email\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PW\"}" | grep -oE '"sessionToken":"[^"]+' | cut -d'"' -f4 || true)
if [ -z "${TOKEN:-}" ]; then echo "✗ owner login failed — is the seed current?"; exit 1; fi
node dev-tooling/restore-userdata.mjs "$OWNER_PW" >/tmp/preview-userdata.log 2>&1 && ok "user data restored" || { echo "  ✗ restore-userdata"; tail -5 /tmp/preview-userdata.log; }

# ── 6b) HTTP-based demo seeders (need the server listening) ─────────────────
say "demo seeders…"
for s in seed-benchmark-demo seed-feed-mill-demo seed-fish-benchmark-demo seed-fish-mixing-demo; do
  npx tsx dev-tooling/$s.mjs >/tmp/preview-$s.log 2>&1 && ok "$s" || { echo "  ✗ $s"; tail -5 /tmp/preview-$s.log; }
done

curl -s http://127.0.0.1:3000/api/init -H "x-gomina-session: $TOKEN" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(\`✅ preview live on :3000 — \${j.businesses?.length} units · \${j.users?.length} users · \${j.employees?.length} employees\`)})"
