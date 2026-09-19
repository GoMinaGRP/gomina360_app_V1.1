#!/usr/bin/env bash
# bootstrap-sandbox.sh — second half of sandbox-reset recovery. Self-contained:
# brings up Postgres + the production build + the canonical seeded/fixture data.
# Assumes bootstrap-install.sh has run. Idempotent — safe to re-run any time.
# Usage: bash dev-tooling/bootstrap-sandbox.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:5432/app_db}"
APP="${BASE_URL:-http://localhost:3000}"

# ── 1) Postgres ─────────────────────────────────────────────────────────────
if ss -lptn 2>/dev/null | grep -q ':5432 '; then
  echo "✔ Postgres already listening"
else
  echo "· starting embedded Postgres (self-heals pgtooling deps)…"
  nohup node dev-tooling/start-pg.mjs >/tmp/bootstrap-pg.log 2>&1 &
  for i in $(seq 1 90); do
    if ss -lptn 2>/dev/null | grep -q ':5432 '; then echo "  ✔ PG up after ${i}s"; break; fi
    [ "$i" = 90 ] && { echo "✗ Postgres never came up"; tail -10 /tmp/bootstrap-pg.log; exit 1; }
    sleep 1
  done
  sleep 2 # accept connections fully (app_db creation happens right after listen)
fi

pg_ok() { node -e "const pg=require('./node_modules/pg');new pg.Client('$DATABASE_URL').connect().then(c=>{c.end();process.exit(0)}).catch(()=>process.exit(1))"; }
for i in $(seq 1 30); do pg_ok 2>/dev/null && break; sleep 1; done
pg_ok 2>/dev/null || { echo "✗ app_db not reachable"; exit 1; }
echo "✔ app_db reachable"

# ── 2) Schema (drizzle push is idempotent; the build's own db:migrate also runs) ─
echo "· pushing schema…"
npx drizzle-kit push --force >/tmp/bootstrap-push.log 2>&1 || { tail -15 /tmp/bootstrap-push.log; exit 1; }
echo "  ✔ schema applied"

# ── 3) Organization #1 — the boot seeder hardcodes ownerId 1 into businesses ──
node - <<EOF
const pg = require("./node_modules/pg");
(async () => {
  const c = new pg.Client("$DATABASE_URL");
  await c.connect();
  await c.query(\`INSERT INTO organizations (id, name, slug, status, contact_email, owner_user_id, created_by_user_id)
    SELECT 1, 'GoMina Group', 'gomina-group', 'ACTIVE', 'kwame.owner@gomina360.com', 1, 1
    WHERE NOT EXISTS (SELECT 1 FROM organizations WHERE id = 1)\`);
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
EOF
echo "✔ organization #1 present"

# ── 4) Production build (dev mode OOMs this sandbox — suites + preview run prod) ─
if [ ! -f .next/BUILD_ID ]; then
  echo "· building production bundle…"
  NEXT_TELEMETRY_DISABLED=1 npm run build >/tmp/bootstrap-build.log 2>&1 || { tail -15 /tmp/bootstrap-build.log; exit 1; }
  echo "  ✔ build complete"
else
  echo "✔ build already present"
fi

# ── 5) App server (fresh process REQUIRED before seeding: the boot seeder runs once per process) ─
if ss -lptn 2>/dev/null | grep -q ':3000 '; then
  echo "✔ app already listening on :3000"
else
  echo "· starting the app (prod)…"
  # Push-suite trust: mint the local mock-push keypair and make the app trust
  # it (NODE_EXTRA_CA_CERTS is read at process start; the verify-notifications
  # harness reuses the same /tmp/pushsrv files for its TLS endpoint).
  if [ ! -s /tmp/pushsrv.pem ]; then
    openssl req -x509 -newkey rsa:2048 -keyout /tmp/pushsrv-key.pem -out /tmp/pushsrv.pem -days 2 -nodes -subj "/CN=localhost" -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" >/dev/null 2>&1 || true
  fi
  nohup env NEXT_TELEMETRY_DISABLED=1 DATABASE_URL="$DATABASE_URL" NODE_EXTRA_CA_CERTS=${NODE_EXTRA_CA_CERTS:-/tmp/pushsrv.pem} npm start -- -p 3000 >/tmp/bootstrap-app.log 2>&1 &
  for i in $(seq 1 90); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$APP/" 2>/dev/null || echo 000)" = "200" ] && { echo "  ✔ app up after ~${i}s"; break; }
    [ "$i" = 90 ] && { echo "✗ app never came up"; tail -10 /tmp/bootstrap-app.log; exit 1; }
    sleep 1
  done
fi

USERS=$(node -e "const pg=require('./node_modules/pg');(async()=>{const c=new pg.Client('$DATABASE_URL');await c.connect();const r=await c.query('SELECT count(*) c FROM users').catch(()=>({rows:[{c:0}]}));console.log(r.rows[0].c);await c.end();})()")
if [ "${USERS:-0}" = "0" ]; then
  echo "· database empty — triggering boot seed via /api/init…"
  curl -s -o /dev/null -w "  init:%{http_code}\n" "$APP/api/init" || true
  sleep 3
else
  echo "✔ database already seeded ($USERS users)"
fi

# ── 6) Canonical data restore chain (each step idempotent) ──────────────────
echo "· multi-owner backfill…";     node dev-tooling/migrate-multiowner.mjs | tail -1
echo "· live data backup…";          node dev-tooling/restore-livedata.mjs | tail -1
echo "· branding…";                  node dev-tooling/restore-branding.mjs | tail -1
echo "· user data…";                 node dev-tooling/restore-userdata.mjs "Owner@GoMina26" | tail -1
echo "· E2E fixtures…";              node dev-tooling/fixtures-e2e.mjs | tail -1
echo "· watermark demo fixture…";    node dev-tooling/fixtures-watermarks-demo.mjs | tail -1
# H3 (A–Z audit): auto-purge leftover suite fixtures (TEST/MW-*/Unrelated/…)
# so the demo tenant never accumulates crashed-suite debris. Pattern-narrow,
# never touches real data; suites also self-clean, this is the safety net.
echo "· test-fixture purge…";        bash dev-tooling/run-suite.sh dev-tooling/purge-test-rows.mjs | sed 's/^/   /'

# ── 7) Health check ─────────────────────────────────────────────────────────
node - <<EOF
const B = "$APP";
(async () => {
  const login = await fetch(B + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "kwame.owner@gomina360.com", password: "Owner@GoMina26" }) }).then((r) => r.json());
  if (!login.sessionToken) { console.error("✗ owner login failed"); process.exit(1); }
  const init = await fetch(B + "/api/init", { headers: { "x-gomina-session": login.sessionToken } });
  const d = await init.json();
  console.log(\`✔ health: owner login OK — \${d.businesses?.length} businesses · \${d.users?.length} users · \${d.employees?.length} employees\`);
})().catch((e) => { console.error("✗", e.message); process.exit(1); });
EOF
echo "✅ bootstrap-sandbox complete — app live on :3000"
