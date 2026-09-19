#!/usr/bin/env bash
# setup-runtime.sh — one-command bring-up after a sandbox restart/wipe.
# Idempotent: safe to re-run any time. Order matters (see comments):
# restore-userdata drives the APP's own APIs, so the build+server start must
# precede the restore chain; seedDatabase requires org #1 and an empty
# businesses table, so the org backfill must precede the seed on fresh DBs.
set -euo pipefail
cd "$(dirname "$0")/.."
export DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:5432/app_db}"

echo "══ 1) node deps"
[ -d node_modules/pg ] || npm ci --no-audit --no-fund
mkdir -p /home/user/pgtooling
[ -f /home/user/pgtooling/package.json ] || (cd /home/user/pgtooling && npm init -y >/dev/null)
[ -d /home/user/pgtooling/node_modules/embedded-postgres ] || \
  (cd /home/user/pgtooling && npm install pg puppeteer-core puppeteer @sparticuz/chromium fs embedded-postgres)

echo "══ 2) Postgres (embedded binaries)"
if ! node -e "const pg=require('pg');new pg.Client('$DATABASE_URL').connect().then(c=>process.exit(c.end())).catch(()=>process.exit(1))" 2>/dev/null; then
  nohup node dev-tooling/start-pg.mjs >/tmp/start-pg.log 2>&1 &
  for i in $(seq 1 90); do
    node -e "const pg=require('pg');new pg.Client('$DATABASE_URL').connect().then(c=>process.exit(c.end())).catch(()=>process.exit(1))" 2>/dev/null && break
    sleep 2
  done
fi
node -e "const pg=require('pg');new pg.Client('$DATABASE_URL').connect().then(c=>process.exit(c.end()))" >/dev/null && echo "  ✔ app_db reachable"

echo "══ 3) schema"
npx drizzle-kit push --force >/dev/null
USERS=$(node -e "const pg=require('pg');(async()=>{const c=new pg.Client('$DATABASE_URL');await c.connect();const r=await c.query('SELECT count(*) c FROM users').catch(()=>({rows:[{c:0}]}));console.log(r.rows[0].c);await c.end()})()" 2>/dev/null || echo 0)
if [ "${USERS:-0}" = "0" ]; then
  echo "══ 4) fresh DB: org #1 → full seed → re-backfill org links"
  node dev-tooling/migrate-multiowner.mjs | tail -1
  npx tsx dev-tooling/run-seed.mts 2>&1 | tail -1
  node dev-tooling/migrate-multiowner.mjs | tail -1
else
  echo "✔ database already seeded ($USERS users)"
  node dev-tooling/migrate-multiowner.mjs | tail -1
fi

echo "══ 5) build"
if [ ! -f .next/BUILD_ID ]; then
  NEXT_TELEMETRY_DISABLED=1 npm run build
else
  echo "  ✔ build already present"
fi

echo "══ 6) push cert + app (restore chain drives its APIs, so it starts now)"
[ -s /tmp/pushsrv.pem ] || openssl req -x509 -newkey rsa:2048 -keyout /tmp/pushsrv-key.pem \
  -out /tmp/pushsrv.pem -days 2 -nodes -subj "/CN=localhost" \
  -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" >/dev/null 2>&1 || true
if ! ss -lptn 2>/dev/null | grep -q ':3000 '; then
  nohup env NEXT_TELEMETRY_DISABLED=1 DATABASE_URL="$DATABASE_URL" \
    NODE_EXTRA_CA_CERTS=${NODE_EXTRA_CA_CERTS:-/tmp/pushsrv.pem} \
    npm start -- -p 3000 >/tmp/app.log 2>&1 &
  for i in $(seq 1 60); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/ 2>/dev/null || echo 000)" = "200" ] && { echo "  ✔ app up after ~${i}s"; break; }
    sleep 1
  done
else
  echo "  ✔ app already listening on :3000"
fi

echo "══ 7) canonical restore chain (idempotent)"
node dev-tooling/restore-livedata.mjs | tail -1
node dev-tooling/restore-branding.mjs | tail -1
node dev-tooling/restore-userdata.mjs ${GOMINA_OWNER_PW:-Owner@GoMina26} | tail -1
node dev-tooling/fixtures-e2e.mjs | tail -1
node dev-tooling/fixtures-watermarks-demo.mjs | tail -1
bash dev-tooling/run-suite.sh dev-tooling/purge-test-rows.mjs | tail -1

echo "══ 8) health check"
node - <<'EOF'
const B = "http://127.0.0.1:3000";
(async () => {
  const login = await fetch(B + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "kwame.owner@gomina360.com", password: process.env.GOMINA_OWNER_PW || "Owner@GoMina26" }) }).then((r) => r.json());
  if (!login.sessionToken) throw new Error("owner login failed");
  const d = await fetch(B + "/api/init", { headers: { "x-gomina-session": login.sessionToken } }).then((r) => r.json());
  console.log(`✔ health: ${d.businesses?.length} businesses · ${d.users?.length} users`);
  const m = await fetch(B + "/api/menu").then((r) => r.json());
  console.log(`✔ menu: ${m.businesses?.length} storefront businesses`);
})().catch((e) => { console.error("✗", e.message); process.exit(1); });
EOF
echo "✅ setup-runtime complete — app live on :3000"
