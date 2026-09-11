# GoMina 360 — Safe Production Deployment on Vercel (PostgreSQL)

This runbook fixes — permanently — the two production errors seen after deploying:

| Symptom | Where | Real meaning |
|---|---|---|
| `Sign-in service is temporarily unavailable (database connection).` | Login page | `POST /api/auth/login` caught **any** database failure (its generic 500). |
| `Could not load the menu.` | Order/storefront page | `GET /api/menu` caught **any** database failure (its generic 500). |

Both are the SAME root problem: **the deployed app cannot reach a real PostgreSQL database.**

---

## 1. Why it happens (the only 4 possible causes)

`/api/health` now tells you exactly which one you have — open
`https://<your-app>.vercel.app/api/health` and read `error` / `code` / `hint`:

| # | Cause | Health JSON shows | Fix |
|---|---|---|---|
| 1 | **No connection string** in Vercel (neither `DATABASE_URL` nor the `POSTGRES_*` integration vars) | `error: "…NOT configured…"`, hint mentions Environment Variables | Set the env var (step 3), redeploy |
| 2 | `DATABASE_URL` points at **127.0.0.1 / localhost** (the copied local sandbox URL) | `error: "…local/loopback host ("127.0.0.1")…"` | Use the MANAGED Postgres URL — loopback on Vercel means the serverless function itself, nothing listens there |
| 3 | **Wrong credentials / host / DB name** in the URL | `code: "28P01"` (bad password) · `ENOTFOUND` (bad host) · `3D000` (DB name missing) | Re-copy the full URL from your provider |
| 4 | **Schema never pushed** → tables don't exist | `code: "42P01"` (`relation "users" does not exist`) | Run `drizzle-kit push` against the managed DB (step 4), then `/api/init` (step 5) |
| 5 | (bonus) **Connection-slot exhaustion** on serverless | `53300` / "too many clients" | Use the provider's POOLED URL + keep `PG_POOL_MAX=2` |

> `/api/health` is an authentication-readiness check, not just a network ping:
> it validates the complete `users`, `user_sessions`, and
> `user_business_access` table shapes used during sign-in. Therefore
> `{"ok":true}` means the configured database is reachable **and** its auth
> schema matches this deployment. Wrong credentials and locked accounts still
> return their distinct login messages.

Add `DB_DEBUG=true` (Vercel env, temporary) and `/api/health` additionally returns
a sanitized `diag` block (host, port, database name, masked user — NEVER the
password). Remove it when done. Each cold start also logs one sanitized
`[db] pool created → host=… sslmode=… max=…` line in Vercel → Runtime Logs.

---

## 2. What was fixed in the code (the crosscheck)

- **`src/db/index.ts` — the single connection** (all 53 route/lib files import it;
  no second Pool exists anywhere):
  - Connection comes from `DATABASE_URL` or the supported Vercel integration
    variables (`POSTGRES_PRISMA_URL`, `POSTGRES_URL`,
    `POSTGRES_URL_NON_POOLING`). **Zero** fallback to
    `127.0.0.1:5432`/localhost in any environment.
  - Missing env → a **clear configuration error** (exact remediation text), not a
    raw driver stack.
  - On Vercel (`VERCEL`) or `REQUIRE_EXTERNAL_DB=true`, a loopback URL is a hard
    configuration error that names the offending host.
  - **Pool is created lazily on first query** → `next build` on Vercel can never
    crash from a missing env during page-data collection (verified: `VERCEL=1`
    with no `DATABASE_URL` builds all 54 pages successfully).
  - **One pool per process in every environment** (globalThis cache) → warm
    serverless invocations reuse it; no per-request pools.
  - Serverless sizing: `max = PG_POOL_MAX || 2 on Vercel / 10 otherwise`,
    `idleTimeout 20s`, `connectTimeout 10s`, `keepAlive`.
  - SSL: driven by the URL (`sslmode=require` from Neon/Vercel Postgres/Supabase
    works as-is); `PGSSLMODE=require|disable` is an explicit override.
- **`/api/health`** now reads the complete auth-table shapes used by login
  instead of running the false-positive `select 1` probe. It unwraps Drizzle's
  `Failed query` wrapper and reports `error` + `code` (SQLSTATE) + an actionable
  `hint`; optional `DB_DEBUG=true` adds the sanitized connection snapshot.
- **`drizzle.config.ts`** is env-driven and has no implicit local URL. Running
  `drizzle-kit push` without a configured target now stops with instructions
  instead of silently checking an unrelated localhost database.
- **Business backup import/export** are App Router Route Handlers on the Node.js
  runtime. Multipart uploads use the Web `Request.formData()` API; no legacy
  Pages Router `config.api.bodyParser` export is used.

Verified by automated suites (all green): failure-mode matrix 18/18
(missing env / loopback / wrong password `28P01` / DNS `ENOTFOUND` / DB_DEBUG /
reachable database with missing schema / healthy sign-in + menu), Vercel-simulated build with no env
✔, full E2E in real Chromium 27/27 + 34/34, deadlink crawl clean.

---

## 3. Deploy safely — step by step (≈15 minutes)

### A. Create the managed database
Use **Vercel Postgres** (Storage tab → Create Database) **or Neon / Supabase
/ Railway**. Copy the **pooled/serverless** connection string, e.g.:

```
postgresql://USER:PASSWORD@HOST-pooler.REGION.aws.neon.tech/DBNAME?sslmode=require
```

Rules: never `127.0.0.1`/`localhost`; keep `sslmode=require` (if TLS fails later,
`?sslmode=no-verify` is the escape hatch); URL-encode special chars in the
password (`@` → `%40`).

### B. Set environment variables
Vercel → Project → **Settings → Environment Variables**:

| Variable | Scope | Value |
|---|---|---|
| `DATABASE_URL` | **Production AND Preview** | the pooled URL from step A |
| `PG_POOL_MAX` | Production + Preview | `2` (raise only if your plan allows) |
| `DB_DEBUG` | Production (temporary) | `true` — remove after diagnosis |

Shortcut: if you attached the database via the **Storage tab**, Vercel
auto-created `POSTGRES_URL` / `POSTGRES_PRISMA_URL` / `POSTGRES_URL_NON_POOLING`
for you — the app accepts those automatically, so you may skip adding
`DATABASE_URL` manually. An explicit `DATABASE_URL` always wins when set.

### C. Redeploy
Deployments → ⋯ → **Redeploy** → uncheck *Use existing build cache*.

### D. Push the schema (one time, from your machine)
```bash
git clone <your repo> && cd gomina360_app_V1 && npm install
DATABASE_URL="<the managed URL>" npx drizzle-kit push
```

### E. Seed + first login
Open `https://<your-app>/api/init` once (it seeds the owner account; a 401 after
seeding is normal — the seed runs first, then it asks you to sign in).
Sign in on the login page, then **immediately change the seeded password**
 in Settings.

### F. Restore your real data (optional)
Point the repo's restore scripts at the managed URL (same pattern:
`DATABASE_URL="<managed url>" node dev-tooling/restore-*.mjs`) to bring over
businesses/branding/live data from `dev-tooling/backups/livedata-backup.json`.

### G. Verify
- [ ] `https://<your-app>/api/health` → `{"ok":true}`
- [ ] Owner login works; menu loads on `/order`
- [ ] Vercel → Runtime Logs shows `[db] pool created → host=<your managed host>`
- [ ] Remove `DB_DEBUG`

---

## 4. Branch / code-version warning

⚠️ **The fix above must be in the code Vercel deploys.** Deploy the branch that
contains this file (`docs/DEPLOY-VERCEL.md`) and the updated `src/db/index.ts` +
`src/app/api/health/route.ts`. Deploying an older commit reproduces the exact
symptoms in section 1 with NO diagnostics. The older code can still *work* if
steps 3A–3E are done perfectly (it reads `DATABASE_URL` first), but it has no
guardrails and no serverless pool protection — update as soon as possible.

## 5. Never do

- ❌ Never put `127.0.0.1`, `localhost`, `0.0.0.0` or `::1` in a production
  `DATABASE_URL` (the app now hard-refuses it on Vercel).
- ❌ Never commit `.env*` files or paste the connection string into code.
- ❌ Never run the app in production without TLS to the database
  (`sslmode=require` minimum).
- ❌ Don't raise `PG_POOL_MAX` on Vercel without a provider plan that allows it.
