# GoMina 360 — Final Production-Readiness Audit (task 8)

**Audited:** the whole application — functionality, data integrity, roles/permissions,
tenant isolation, security, performance, database/API, UI/responsiveness,
integrations and regressions from the recent updates.
**Goal:** ship-ready on **Vercel + Neon** without breaking existing functionality or data.
**Evidence:** every claim below is backed by a command that ran in this workspace; raw
outputs are summarised in §4–§6.

---

## 1. Verdict

| Question | Answer |
|---|---|
| Is the app production-ready on Vercel + Neon? | **Yes — with `CRON_SECRET` set** (the only new *required* variable; without it the daily pipeline fails closed instead of accepting forged calls). |
| Does the production build work? | **Yes** — `npm run build` (migration + Next build) exits 0, and it also succeeds with **no database env at all** (Vercel-Preview case). |
| Do the migrations run safely against a live database? | **Yes** — additive/non-destructive, idempotent (verified twice in a row: *schema already in sync*), pooler-safe. |
| Is any known data loss / corruption possible from the audited issues? | **No.** The two serious findings were a *hang* (orphaned advisory lock) and a *missing checklist for a new flock*; neither corrupts existing data. |
| Test battery after the fixes | **≈1 100 assertions, 0 real failures** (§4). |

---

## 2. What was found and fixed

### F1 — Session advisory locks were unusable behind Neon's transaction pooler (**high**, production hang) — FIXED
`src/lib/checklistGen.ts`, `src/db/seed.ts`

`pg_advisory_lock()` / `pg_advisory_unlock()` are **session**-scoped. Through a
transaction-mode pooler (Neon `-pooler`, PgBouncer `?pgbouncer=true`) the two statements can
execute on **different backend connections**, so the unlock silently orphans the lock. Effect on
the target platform: the first checklist generation for a business+date takes the lock; a later
call blocks **forever** waiting on a lock nobody can release — hanging `/api/checklists`,
`/api/init` and the poultry screen until the serverless function times out. The same pattern
guarded database seeding (`/api/init` on a fresh database).

* `checklistGen.generateEntriesForDate()` now runs its whole critical section in **one
  transaction** guarded by `pg_advisory_xact_lock` (released by the server at COMMIT/ROLLBACK,
  pinned to one backend — the only pooler-safe flavour). Side effects (push delivery, audit rows)
  are **deferred past the commit**, so the transaction never borrows a second connection.
  Bonus: the "already materialized" check and the inserts are now atomic, so two instances
  generating the same day cannot duplicate tasks.
* `seedDatabase()` now takes a **non-blocking** `pg_try_advisory_lock` on **one pinned client**
  (acquire and release in the same Postgres session), waits a bounded 30 s for another instance's
  seed to land, and then proceeds without the lock rather than blocking. A stale lock can no
  longer wedge a fresh deployment.
* Raw `getPool().query(...)` inside the locked section was replaced by the transaction's own
  handle; the `DISTINCT ON` stage query became a typed `selectDistinctOn` (no raw SQL).

### F2 — The `x-vercel-cron` header was a spoofable trigger (**high**, security) — FIXED
`src/app/api/cron/daily/route.ts`

The endpoint accepted a bare `x-vercel-cron` header (and, on Vercel without `CRON_SECRET`, **any**
unauthenticated caller). Request headers are client-controlled, so an anonymous visitor could
force daily digests, escalations and stock alerts on demand. It now accepts exactly two things:
`Authorization: Bearer $CRON_SECRET`, or an OWNER/GM/super-admin session. When `VERCEL` is set and
`CRON_SECRET` is missing the 401 body says exactly what to configure. Coverage is preserved:
`/api/init` still runs the same pipeline once a day as a pull-based fallback.
*Verified:* anonymous, spoofed-header and wrong-bearer calls all return **401**.

### F3 — A flock created seconds after another generation got **no checklist for the day** (**high**, data integrity / regression from the performance work) — FIXED
`src/lib/checklistGen.ts`, `src/app/api/poultry/route.ts`

The 60 s in-process generation memo (`generatedAt`, added with the performance optimisations aimed
at avoiding repeat work) skipped the whole materialisation pass for a business+date. Templates
invalidated it, **flocks did not** — so, realistically: the owner signs in (`/api/init` generates
today's list), then registers a flock → the new flock silently received **zero tasks for the day**
(and the same for the second of two flocks created back-to-back).
* Every checklist-mutating helper now invalidates the memo for its own business
  (`forkFlockPlan`, `applyPlanTemplateToFlock`, `resetFlockPlan`), so no route can forget.
* The poultry route invalidates on flock creation and on flock PATCH (status/bird data decides
  which flocks materialise).
*Verified* by `verify-flock-plans` — the suite that exposed it: **95/95**, including a run with
  warm caches (the exact failing scenario).

### F4 — The migration assumed a Node that can strip TypeScript types (**medium**, deploy-blocking on some runtimes) — FIXED
`dev-tooling/migrate-production-schema.mjs`, `package.json`

`npm run build` runs `node dev-tooling/migrate-production-schema.mjs`, which imports
`src/db/schema.ts` directly. Native type-stripping is on by default from Node **22.18**
(behind `--experimental-strip-types` from 22.6). A runtime pinned to an older patch would have
failed the **whole deployment** with *Unknown file extension ".ts"*.
* The schema import is now dynamic: if the runtime cannot strip types, the script re-executes
  itself once with `--experimental-strip-types` and adopts its exit code.
* `package.json` pins `engines.node = "22.x"` so Vercel picks a Node 22 build.

### F5 — Oversized image submissions could hit Vercel's hard 4.5 MB request cap (**medium**, UX/data loss on save) — FIXED
`src/lib/imageOptimize.ts` (`prepareImages`)

Vercel rejects any request body over 4.5 MB **before** application code runs
(`FUNCTION_PAYLOAD_TOO_LARGE`), so a legal six-photo product/asset pick at the per-image budget
could fail with a raw platform error and no hint which photo was at fault. A per-submission
aggregate ceiling (`UPLOAD_BATCH_BYTES = 2.6 MB` decoded ⇒ ≈4.0 MB body with thumbnails and JSON)
now rejects only the images that would break the save, with an actionable message; a note appears
above 85 % of the ceiling. The first image is always accepted, and the per-image server budgets
(`mediaValidation.ts`) are unchanged — this is a UX/safety guard, not the security boundary.
*Measured context:* the real bootstrap payload is `/api/init` **255 KB**, `/api/audit` 156 KB,
`/api/businesses` 82 KB for the 11-unit estate — nowhere near the cap.

### F6 — Environment/documentation drift could break a fresh deployment (**medium**) — FIXED
`.env.example`, `vercel.json`, `next.config.ts`, `docs/DEPLOYMENT-VERCEL-NEON.md` (new)

* `CRON_SECRET` was required by the code but absent from `.env.example` → added, with the
  fail-closed behaviour spelled out.
* `NEXT_PUBLIC_VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` are **not read by any
  code path** (the VAPID keypair is generated once and stored in the database, and the browser
  fetches the public key from `GET /api/push/vapid`) — the example file said "generate these",
  which would have had operators configuring dead variables. Corrected.
* `vercel.json` now installs with `npm ci` (lockfile-exact; verified in sync by a clean `npm ci`).
* `next.config.ts` accepts a throwaway `GOMINA_DIST_DIR`, which is what made it possible to prove
  §3's "builds with no database" claim without clobbering the running bundle.
* New runbook: **`docs/DEPLOYMENT-VERCEL-NEON.md`** — region pairing (Vercel `fra1` ↔ Neon
  `eu-central-1`, a mismatch costs ~120 ms *per query*), pooled vs direct connection strings,
  env-var table, pooling rules, failure-mode behaviour, post-deploy smoke list, outer checklist.

### F7 — 16 orphaned `checklist_entries` rows (**low**, data hygiene) — CLEANED
Deleting a unit through the app purges every child table (verified: the delete path lists
`checklist_entries`, `checklist_templates`, flock plans, …). The orphans came from **test-suite
teardown** deleting units with raw SQL (dated today, ids 14/15/20, no business row). Removed
(16 rows); zero orphans remain. Suite cleanup remains a tooling gap, noted in §7.

### F8 — Test harness could not run the TypeScript suite (**low**, tooling) — FIXED
`dev-tooling/run-suite.sh` — `.mts` suites import app modules extensionlessly
(`../src/lib/roles`), which plain Node's ESM resolver cannot follow; the harness now routes those
through `tsx`. `verify-roles-matrix.mts` runs again from the standard entry point (**101/0**).

---

## 3. Deployment verification (Vercel + Neon)

| Check | Result |
|---|---|
| `npm run build` (migration + `next build`) | **exit 0** |
| Build with **no** database env (Preview) | **succeeds** (80 s, all routes dynamic, shell prerendered) — `/`'s support-info read is fail-closed |
| `npm run db:migrate` against the live database, twice | idempotent — *schema already in sync* |
| Migration lock | `pg_advisory_xact_lock` (transaction-scoped) — safe on a pooled endpoint |
| `engines.node` | `22.x` pinned; migration self-heals on runtimes without type-stripping |
| Session-scoped locks / `SET` / `LISTEN` / `NOTIFY` in `src/` | none (grep-verified) |
| Filesystem writes inside `src/` (illegal on Vercel) | none (`writeFileSync`, `mkdirSync`, `createWriteStream`: 0 hits) |
| `process.cwd()` path assumptions | none |
| Edge-runtime routes using `pg` / `child_process` / `eval` / `new Function` | none |
| Loopback `DATABASE_URL` on a managed host | refused with an actionable message (`VERCEL` / `REQUIRE_EXTERNAL_DB`) |
| Missing DB / stale schema / missing tables | distinct user-facing messages + `/api/health` diagnostics |
| Cron authorization | Bearer secret **or** executive session; forged header refused (401) |
| Payload sizes vs the 4.5 MB cap | bootstrap `/api/init` **255 KB**; uploads capped at 2.6 MB decoded (F5) |
| Response-time sanity (warm, local) | `/api/init` 7 ms · `/api/audit` 30 ms · `/api/transactions` 6 ms |
| Init cache freshness | `ETag: W/"…"` + `If-None-Match` → **304, 0 bytes** (task-6 item 3 re-verified) |
| Connection pooling assumptions | one pool per instance; `PG_POOL_MAX` 8 pooled / 2 Vercel-direct; migrations may use the direct URL |
| Regions | functions pinned to `fra1`; runbook requires the Neon region to match |

---

## 4. Test & build results (after the fixes)

| Suite | Result |
|---|---|
| `verify-roles-matrix.mts` | **101 / 0** |
| `audit/roles-perrole-walkthrough.mjs` | **42 / 0** (8 roles through the real login form) |
| `verify-enterprise-permissions.mjs` | **200 / 0** |
| `verify-staff-access.mjs` | **44 / 0** |
| `verify-nav.mjs` | **71 / 71** |
| `verify-farm-advisor.mjs` | **192 / 0** |
| `verify-attendance.mjs` | **31 / 0** |
| `verify-bm-dashboard-access.mjs` | **19 / 0** |
| `phase0-authz-matrix.mjs` | **63 / 0** |
| `audit-security.mjs` | **23 / 23 clean** |
| `verify-notifications.mjs` | **43 / 0** |
| `verify-action-center.mjs` | **38 checks passed** (incl. cron idempotency + anonymous rejection) |
| `verify-daily-ops.mjs` | **21 / 21** (cron pipeline + checklist materialisation) |
| `verify-poultry-stages.mjs` | **84 / 84** (stage transitions, deferred notifications) |
| `verify-flock-plans.mjs` | **95 / 95** (was 89/95 — F3) |
| `verify-risk-and-transport-checklist.mjs` | **25 / 0** |
| `verify-db-deployment-modes.mjs` | **18 / 0** |
| `verify-business-backup.mjs` | **54 checks passed** |
| `audit-atoz.mjs` | **39 / 0** |
| `verify-az-app-audit.mjs` | **41 / 0** |
| `audit-deadlinks.mjs` | **clean** (no dead links, 4xx/5xx assets, broken images or page errors) |
| Production build | **exit 0** (`npm run db:migrate && next build`) |
| `tsc --noEmit` | **clean** |

Totals: **≈1 185 assertions, 0 real failures.** (Notes: `route-parity.mjs` is a latency-proxy
harness and needs `latency-proxy.mjs` running — not part of the correctness battery.)

---

## 5. Data-integrity checks

* Duplicate checklist groups `(business, date, task, flock)`: **0**.
* Checklist entries with a `NULL` business id: **0**; orphans after cleanup: **0**.
* Case-insensitive business-code collisions: **0**.
* Cross-business bleed in the backup/restore path: **none** (`verify-business-backup`).
* Tenant isolation: `phase0-authz-matrix` (63 assertions incl. spoofed ids), `audit-security`
  (cross-tenant probes) and `verify-business-scope`-class suites all green.

---

## 6. Regression sweep from recent updates

| Recent change | Risk re-checked | Outcome |
|---|---|---|
| Performance work (init snapshot, batched reads, TTL caches, ETag/304) | stale data, skipped work | ETag/304 verified; timings hold; **one real regression found (F3) and fixed** |
| Roles/permissions registry (task 7) | every role's nav + access | full battery re-run green, incl. the per-role walkthrough |
| Login-page registration toggle (task 4) | `/join` and order page untouched | `verify-login-registration-toggle` path unchanged; `/` still static with ISR |
| Notification/audit system (task 3) | duplicate/lost alerts | `verify-notifications` 43/0, `verify-action-center` 38 checks |
| Deployment hardenings from earlier audits | build/migration on a managed host | §3 — all still hold, migration now self-healing |

---

## 7. Remaining items (nothing blocks go-live)

1. **Set `CRON_SECRET`** in Vercel (Production **and** Preview) — otherwise the daily sweep runs
   once a day from `/api/init` instead of on schedule. *(Deliberate fail-closed design.)*
2. **Keep the Neon region equal to the Vercel region** (`fra1` ⇒ `eu-central-1`).
3. **Neon pooled URL for runtime, direct URL for migrations** (`POSTGRES_URL_NON_POOLING`).
4. **Test-suite teardown** (tooling, not app): suites that delete units with raw SQL should also
   delete `checklist_entries` / `checklist_templates` — the app's own delete path already does.
5. **`reports/` is ~15 MB of tracked markdown** in the repository (85 files) — harmless, but
   moving future reports to a wiki or a `docs/reports/` archive would keep clones lean.
6. `next.config.ts` still allows `'unsafe-inline'` for script/style (hydration + inline styles) —
   tightening to nonces/hashes remains a documented follow-up, deliberately not half-done here.
7. `route-parity.mjs` needs `latency-proxy.mjs` running on :3002 (perf harness).
