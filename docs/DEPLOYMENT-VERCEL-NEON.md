# Deploying GoMina 360 to Vercel + Neon — the checked-in runbook

> Written during the **final production-readiness audit** (task 8). Every claim
> below was verified against this repository's code and against the live
> preview estate, not copied from a template.
>
> Verified 2026-10-06 on Node 22.22.3 · Next.js 16.3.8 · drizzle-orm 0.45.2.

---

## 1. The 10-minute path

| # | Step | Where | Value |
|---|------|-------|-------|
| 1 | Create the database | Neon console | Project region **must match the Vercel region** in `vercel.json` (`fra1` ⇒ Neon *Europe (Frankfurt)* `eu-central-1`). A mismatch adds ~120 ms to **every** query round trip. |
| 2 | Copy **two** connection strings | Neon → *Connection details* | **Pooled** (`...-pooler.eu-central-1.aws.neon.tech`, `?sslmode=require`) and **Direct** (no `-pooler`). |
| 3 | Import the repo | Vercel → *Add New → Project* | Framework auto-detected as Next.js; `vercel.json` supplies the build/install commands, region and the 06:00 UTC cron. |
| 4 | Set environment variables | Vercel → *Settings → Environment Variables* | See the table in §2. Tick **Production**, **Preview** *and* **Development** where offered. |
| 5 | Deploy | Vercel | The build runs `db:migrate && next build`: the checked-in reconciler adds any missing table/column, then Next builds. |
| 6 | Open `/api/init` **once** while signed out, then sign in | Browser | First authenticated request provisions the OWNER account when the database is empty. |
| 7 | Turn on push (optional) | In-app | Nothing to configure — see §2, *Browser push*. |
| 8 | Verify | `/api/health`, then the smoke list in §6 | `{"ok":true}`. |

**Region pairing is the single most common self-inflicted performance problem.**
`vercel.json` pins the functions to `fra1`; keep the Neon project in the same
continent (`eu-central-1`). If your users are mostly in West Africa and you
prefer a different Vercel region, change **both** together (e.g. `lhr1` +
Neon *Europe (London)*).

---

## 2. Environment variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | **yes** | The **pooled** Neon string. Also accepted (auto-created by the Vercel/Neon integration, first set one wins): `POSTGRES_PRISMA_URL`, `POSTGRES_URL`, `POSTGRES_URL_NON_POOLING`. A `127.0.0.1`/`localhost` URL is refused on Vercel (see §5). |
| `POSTGRES_URL_NON_POOLING` | recommended | The **direct** string. Keep it set: the build-time migration and `drizzle-kit` use a direct connection when one is available, which is the officially recommended posture for DDL. The runtime keeps using the pooled string. |
| `CRON_SECRET` | **strongly recommended** | `openssl rand -hex 32`. With it set, Vercel Cron authenticates itself (`Authorization: Bearer $CRON_SECRET`). **Without it `/api/cron/daily` now fails closed (401)** — the daily digest/escalation pipeline then only runs through the `/api/init` pull-based fallback on the first sign-in of the day. |
| `REQUIRE_EXTERNAL_DB` | optional | `true` also refuses loopback URLs on non-Vercel hosts (Vercel sets `VERCEL=1`, which already enables the check). |
| `PG_POOL_MAX` | optional | Client-pool ceiling per function instance. Defaults: **8** when the URL points at a pooler (`-pooler` host, port 6543, `?pgbouncer=true`), **2** on Vercel direct connections, 10 elsewhere. Keep *instances × PG_POOL_MAX* under the provider's connection limit (Neon Free: ~100). |
| `PGSSLMODE` | optional | `require` forces TLS with `rejectUnauthorized:false`; `disable` turns TLS off. Neon's `?sslmode=require` needs neither. |
| `IP_HASH_SALT` | recommended | Long random string; salts IPs in audit/log rows. Without it a built-in development salt is used. |
| `ENABLE_HSTS` | optional | `1` sends `Strict-Transport-Security`. Only meaningful on real TLS (Vercel yes, plain-HTTP sandboxes no). |
| `FRAME_ANCESTORS` | optional | Extra space-separated `frame-ancestors` hosts if another site legitimately embeds the app. `'self'` and `https://*.e2b.app` (the live preview) are always allowed. |
| `TRANSPORT_SPEED_LIMIT_KMH` + `NEXT_PUBLIC_TRANSPORT_SPEED_LIMIT` | optional | Server/client speed-alert threshold — set **the same number in both** or the alert is computed twice inconsistently. Default 110. |
| `GOMINA_SKIP_SEED` | optional | `1` skips demo-data seeding on a completely empty database (use when restoring a backup into a fresh schema). |
| `DB_DEBUG` | optional | Verbose DB logging; leave off in production. |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | **not used** | Browser push needs **no** env var in this codebase: the VAPID keypair is generated once and stored in the database (`push_config`), and the browser fetches the public key from `GET /api/push/vapid`. They are tolerated but ignored (see `.env.example`). |

---

## 3. What the build does

```
npm ci                 # vercel.json installCommand — lockfile-exact installs
npm run build          # = npm run db:migrate && next build
  └─ db:migrate        # dev-tooling/migrate-production-schema.mjs
```

* `db:migrate` reads `src/db/schema.ts` — the **one** source of truth — and is
  strictly **additive and non-destructive**: `CREATE TABLE IF NOT EXISTS`,
  `ADD COLUMN IF NOT EXISTS` (nullable first, defaults applied), plus curated
  backfills and `pg_advisory_xact_lock` (transaction-scoped, so it is safe
  behind Neon's transaction pooler). It never drops a column or table and never
  rewrites a row's data. Re-running it is a no-op — verified twice in a row:
  `[db:migrate] schema already in sync`.
* **No `DATABASE_URL` at build time is not fatal.** `/` is statically
  prerendered with a *fail-closed* support-info read, so `next build` succeeds
  even with the database unreachable — verified by building with all four
  database variables blanked. (The app then reports "not connected" on
  `/api/health` and on the sign-in screen instead of crashing the build.)
* Node runtime: `package.json` pins `engines.node = 22.x` so Vercel uses a
  Node 22 that can import the TypeScript schema directly. Should a runtime ever
  lack that, the migration re-executes itself once with
  `--experimental-strip-types` instead of failing the deployment.

---

## 4. Connection pooling: what the app assumes

Neon's pooled endpoint is **PgBouncer in transaction mode**. Consequences that
this codebase already honours — and that any future change must honour too:

| Rule | Where it is enforced today |
|---|---|
| No session-level advisory locks | `src/lib/checklistGen.ts` uses `pg_advisory_xact_lock` inside a transaction; `src/db/seed.ts` uses `pg_try_advisory_lock` on one pinned client. Session-scoped lock/unlock could land on two different backends and orphan the lock **forever**, hanging every later run. |
| No `SET`/`LISTEN`/`NOTIFY`, no session state | none used anywhere in `src/`. |
| One client pool per function instance | `src/db/index.ts` (global pool per process, `max` sized for pooled vs direct). |
| Migrations may use a direct connection | `POSTGRES_URL_NON_POOLING` is accepted; the reconciler's xact lock is pooler-safe either way. |
| Keep client pools small | `PG_POOL_MAX` (defaults in §2). |

---

## 5. Failure modes that are already handled (and what the user sees)

| Situation | Behaviour |
|---|---|
| No connection string at all | The pool is **lazy**: import/`next build` succeed; the first query throws a configuration error, `/api/health` answers `500 {"ok":false,"error":…,"hint":…}`, and the sign-in screen shows the deployment message instead of hanging. |
| `DATABASE_URL` points at `127.0.0.1`/`localhost` on Vercel | Refused with a dedicated message naming the variable and the fix — a laptop URL can never silently "work" against production. |
| Schema older than the deployment (`42703 column … does not exist`) | Sign-in explains: run `DATABASE_URL="<managed-url>" npm run db:migrate`, then redeploy. |
| Tables missing (`42P01 relation … does not exist`) | Sign-in explains: run `npx drizzle-kit push`, then open `/api/init` once to create + seed the OWNER. |
| Transient outage | Generic "temporarily unavailable" copy; details only in `/api/health`. |
| Request body > 4.5 MB | **Platform cap, not configurable.** The image pipeline caps one submission at 2.6 MB of decoded photos (`UPLOAD_BATCH_BYTES`) so the body (base64 ≈ ×1.33, plus thumbnails and JSON) stays near 4 MB. Measured bootstrap payloads are far below the cap: `/api/init` **255 KB**, `/api/audit` 156 KB, `/api/businesses` 82 KB for the 11-unit seed estate. |
| Cron called by an anonymous client | `401`. The old `x-vercel-cron` header path was **client-spoofable** and has been removed; only `Bearer $CRON_SECRET` or an OWNER/GM/super-admin session is accepted. |
| Response body > 4.5 MB | Not reachable today: list/bootstrap routes strip stored images (`src/lib/imagePayload.ts`) and keep at most one ≤400 px thumbnail per row. Re-measure if a screen starts returning blobs. |

---

## 6. Post-deploy smoke list

1. `GET /api/health` → `{"ok":true}`.
2. Open `/` → sign-in renders (the login page performs **no** database read on
   the request path; it is served from the prerendered shell).
3. Sign in as the OWNER → command centre loads (`/api/init`), sidebar shows the
   units, no "not connected to a database" banner.
4. Open the browser dev-tools Network tab on `/api/init` → confirm a `304`
   (or a ~250 KB `200`) — that is the init cache + ETag working.
5. Flip a real setting (e.g. Login Page registration invite) → refresh `/` and
   confirm the change is live (ISR + `revalidatePath`).
6. `curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/daily`
   → `{"success":true,…}`; without the header → `401`.
7. Enable push on one device (Settings → notifications) → use *Send test
   notification* → the OS notification arrives and deep-links into the app.

---

## 7. Outside-Arena checklist (account/hosting decisions)

* **Neon**: region matched to the Vercel region; `pgbouncer`-mode pooled URL for
  runtime; **direct** URL stored for migrations; autoscaling/limits checked
  against expected *instances × `PG_POOL_MAX`*.
* **Vercel**: env vars set for **Production and Preview** (a Preview deploy with
  no `DATABASE_URL` now still *builds*, but it cannot show data);
  `CRON_SECRET` set; the cron entry visible under *Settings → Cron Jobs*;
  `maxDuration` left at the platform default (Fluid Compute allows up to 300 s)
  — the heavy routes here finish far below it.
* **Domain/TLS**: custom domain + HTTPS; then set `ENABLE_HSTS=1`.
* **Backups**: Neon point-in-time restore is the primary safety net; the in-app
  Business Backup (`/api/business-backup`) is a *data* export, not a substitute.
* **Monitoring**: watch `/api/health`, the runtime logs (one sanitized
  `[db] pool created → host=… max=…` line per cold start) and Neon's connection
  graph after go-live.
