# Final Performance & Deployment Audit — GoMina 360 (2026-10-10)

**Branch:** `arena/a7e21dce-gomina360-app-v1-1`
**Builds on:** `docs/PERFORMANCE-AND-DEPLOYMENT-AUDIT.md` (earlier pass: proxy fast path, pooled
connection sizing, region visibility, preview-migration gating, bootstrap batching). This pass
re-verifies those and closes the remaining gaps found by measurement.

Scope: frontend bundle and polling, API hot paths, PostgreSQL schema and indexes, dependencies,
build and migration path, environment configuration, production behaviour, and the test suites.

---

## 1 · Summary

| Area | Before this pass | After this pass |
|---|---|---|
| Foreign keys without a supporting index | **7** (`block_mix_*`, `fish_feed_*`, `poultry_feed_*`, `fulfillment_options.supplier_id`) | **0** — 7 indexes added, reconciled by the migration |
| Production dependency vulnerabilities (`npm audit --omit=dev`) | **4** (2 high, 2 moderate) — `xlsx` (no fix), `exceljs→uuid`, `source-map-js` | **0** |
| Vulnerable client code shipped | `xlsx` / SheetJS in the export bundle | **removed**; exports use `exceljs` (already a dependency) |
| Background polling in hidden tabs | Staff presence (15 s) and transport GPS (30 s) polled while hidden | Skip while hidden (visibility-aware, like the notification bell) |
| VAPID keypair first-run race | Two concurrent first callers → unique-key error; the loser could sign with keys that differ from the database | `ON CONFLICT DO NOTHING` + re-read; all instances converge on the stored keypair |
| Lint | 166 warnings, 0 errors | 159 warnings, **0 errors** |
| TypeScript | 0 errors | 0 errors |
| Production build | passes | passes |

---

## 2 · What was measured (and what was not)

- **Local stack:** production build (`next build` + `next start`) against a local PostgreSQL 18
  seeded with the demo organisation and recovered demo data, sized like the repo's own test
  fixtures. Warm API latency on this data: `/api/init` ≈ 12 ms, `/api/auth/me` ≈ 8 ms,
  `/api/notifications` ≈ 15 ms, `/api/audit?meta=1` ≈ 6–14 ms.
- **Initial JavaScript on the home page:** ≈ **219 KB gzipped**. The large export libraries
  (`exceljs`, ~910 KB raw) are lazy-loaded and are not on the critical path.
- **`/api/init` is gzipped** (`content-encoding: gzip`, `Vary: Accept-Encoding`) and marked
  `private, no-cache` with an ETag. This is correct for per-user data.
- **Not measurable here:** real production latency. The local database is in the same process
  tree as the app, so network round trips to Neon, cross-region placement, and cold starts are
  not represented. The findings below that concern those factors are therefore stated as
  configuration requirements, not as measured numbers.

### Index audit (measured on the live schema)

Single-column foreign keys with no index on the referencing column were found with a `pg_constraint`
/ `pg_index` anti-join. After the change, the same query returns **0 rows**, and the migration
reconciler reports `schema already in sync` on a second run. The tenant-scope columns used by the
hot reads (`business_id`, `owner_id`, `user_id`, `assigned_business_id`, `target_business_id`) were
already indexed; no change was needed for them.

### Why the new indexes are safe to create on deploy

They are on small child tables (formulation items, batch inputs, fulfillment options). The
reconciler uses plain `CREATE INDEX IF NOT EXISTS`, which takes a brief write lock on each table
while it builds. On tables of this size that lock is negligible. If a deployment ever targets a
large child table, create the index manually with `CREATE INDEX CONCURRENTLY` first; the reconciler
will then skip it.

---

## 3 · Changes made

| # | Change | Files | Why |
|---|---|---|---|
| 1 | Seven missing FK indexes declared in the schema | `src/db/schema.ts` | Joins and FK checks on these child tables were scanning. |
| 2 | Export libraries switched from `xlsx` (SheetJS) to `exceljs` | `src/lib/assetDownload.ts`, `src/lib/inventoryDownload.ts`, `package.json`, lockfile | Removes the high-severity SheetJS advisories with no upstream fix from the shipped bundle. `exceljs` was already in use. Verified: a generated workbook round-trips with the expected sheet name and values. |
| 3 | `overrides` for `uuid` (≥ 11.1.1) and `source-map-js` (≥ 1.2.2) | `package.json` | Patches the two production advisories without a breaking upgrade of `exceljs` or `next`. |
| 4 | Visibility-aware polling | `SignedInStaffPanel.tsx`, `TransportModule.tsx` | Hidden tabs no longer issue presence or GPS requests. |
| 5 | VAPID keypair insert is race-safe | `src/lib/push.ts` | A parallel first-use race could leave an instance signing with keys that do not match the stored public key. |
| 6 | Dev-tooling pin: `postcss` 8.5.8 → 8.5.29 | `package.json` | Patched release; no API change. |
| 7 | Removed unused `eslint-disable` directives (and stray blank lines they left) | 5 files | Cleanup; lint warnings 166 → 159, no logic change. |

No change was made to authorisation, tenant scoping, financial gating, or data-integrity logic.

---

## 4 · Test results

Every suite below was run against a **production build of this branch** on a **clean** database
(recreated from the schema, seeded, and given the recovery data and the second-tenant fixture),
with the server confirmed to be serving that build.

| Suite | Result |
|---|---|
| `tsc --noEmit` | **0 errors** |
| `eslint .` | **0 errors** · 159 warnings (all pre-existing: `<img>`, unescaped entities, hook deps) |
| `next build` (production) | **✓ passes** |
| Migration on a **fresh** database (`drizzle-kit push` + reconciler) | ✓ full schema; 406 indexes; 0 unindexed single-column FKs |
| Migration **idempotency** (second run) | ✓ `schema already in sync` |
| `verify-business-scope` | **94 / 94** |
| `verify-tenant-isolation` | **15 / 0** |
| `multiowner-verify` (two independent organisations) | **118 / 0** |
| `phase0-authz-matrix` | **63 / 0** |
| `verify-roles-matrix` | **109 / 0** |
| `verify-enterprise-permissions` | **200 / 0** |
| `verify-financial-permissions` | **110 / 0** |
| `verify-export-center` | **77 / 0** |
| `verify-inventory-permissions` | **34 / 0** |
| `verify-staff-access` | **44 / 0** |
| `verify-single-writer` | **35 / 0** |
| `verify-session-timeout` | **15 / 0** |
| `verify-proxy-fast-path` | **6 / 0** |
| `verify-actor-attribution` / `verify-actor-spoof-live` | **PASS** |
| `audit-security` | **23 / 23 clean** |
| Browser login (headless Chromium, real form) | ✓ dashboard loads; session survives reload |
| `/api/health`, `/api/cron/daily` (no/wrong secret → 401) | ✓ |

### Known failing checks (pre-existing test-suite drift, not product regressions)

These three suites fail on this branch. The product code they exercise is **unchanged from the
previous commit**, so these are test expectations that no longer match the implementation. They
should be reconciled by a product owner, not silently edited:

| Suite | Failing checks | Cause |
|---|---|---|
| `verify-owner-bell` (40/3) | "cap holds the Owner to **12** itemised rows" | The suite expects `12`. `AUDIT_EVENT_DAILY_CAP` in `src/lib/notifyActivity.ts` is `40`, documented as intentional. |
| `verify-action-center` (4 failing) | `TASK_ASSIGNED` row looked up by `record_ref = taskNumber` | The code stores `task:<id>:<event>` as `record_ref`, a deliberate per-event dedupe key. The suite assumes the task number. |
| `verify-notify-activity` (99/1) | "workspace census restored (18 demo users)" | Four `*.e2e@gomina360.com` accounts left by the role-walkthrough suite on this database. Test-data pollution, not a code defect. |

`verify-tenant-isolation` and `verify-business-scope` depend on a second-organisation fixture
(`fixtures-watermarks-demo.mjs`) and fixed IDs (organisation 2, business 12). They pass when run
in the order the recovery kit defines. Run the fixture on a database that has not yet had other
fixtures applied, or the IDs shift.

---

## 5 · Dependency status

- **Production (`npm audit --omit=dev`): 0 vulnerabilities.**
- **Full tree (`npm audit`): 9 findings, all in development tooling, none in the runtime bundle.**
  - `drizzle-kit` → `@esbuild-kit/*` → `esbuild ≤ 0.24.2` (moderate). The only fix is a
    semver-major downgrade of `drizzle-kit` to 0.18; not applied. `tsx` needs `esbuild` 0.28, so an
    override is not possible without breaking it.
  - `eslint-config-next` → `@next/eslint-plugin-next` → `fast-glob` → `micromatch` → `braces`
    (high). `braces` ≤ 3.0.3 has no patched release; the only offered fix is a major downgrade of
    `eslint-config-next`. Lint-time only.
- **Recommendation:** upgrade `drizzle-kit` and `eslint-config-next` to their next major versions
  in a dedicated change with the full test pass, when those releases are stable.

---

## 6 · Deployment readiness

**Ready to deploy** once the manual Vercel / Neon items in §7 are configured. The code, schema,
migration, and build are verified.

- The build no longer requires a database. `npm run build` skips the migration when no connection
  string is set, and skips it on Vercel Preview builds unless `GOMINA_MIGRATE_ON_PREVIEW=1`.
- `/api/health` reports database region pairing and the daily-ops status.
- `/api/cron/daily` fails closed (401) without `CRON_SECRET`.

---

## 7 · Manual configuration still required in Vercel and Neon

These cannot be set from the repository.

1. **Region pairing (largest latency factor).** `vercel.json` pins functions to `fra1`. Confirm
   the Neon project is in the same region (e.g. `eu-central-1` for Frankfurt). Open `/api/health`
   on the deployed URL; `regionMatched` must be `true`. A mismatch adds a network crossing to
   every query.
2. **`DATABASE_URL`** — set for **Production and Preview**, using the **pooled** Neon endpoint
   (`…-pooler.<region>.aws.neon.tech`) with `sslmode=require`. Do not use a `127.0.0.1` or
   `localhost` URL; the server refuses to start a pool on one when `VERCEL=1`.
3. **`CRON_SECRET`** — a long random value (`openssl rand -hex 32`). Vercel Cron sends it as a
   Bearer token to the 06:00 UTC daily-ops job. Without it the job fails closed by design.
4. **Connection budget.** The app sizes its pool to 8 per function instance through a pooler and
   2 on a direct connection. Keep `instances × PG_POOL_MAX` under your Neon plan's connection
   limit. Set `PG_POOL_MAX` explicitly if you run many concurrent instances.
5. **First production deploy runs the migration.** It creates the seven new indexes (brief
   per-table lock on small tables) and any other missing schema objects. Run it during a quiet
   window if your Production database is large.
6. **Optional:** `ENABLE_HSTS=1` once you serve real TLS, and `FRAME_ANCESTORS` if the preview
   host must be added to the frame allow-list.

### Open product decision (scale, not a defect)

`/api/init` returns the complete transaction, customer, employee, inventory and credit-sale
history for the user's scope. The client computes totals from those arrays, so the payload grows
with company history. Only the activity feed is capped (500 rows). Today the payload is small. As
history accumulates, the right fix is a windowed bootstrap (for example, the last 12 months of
ledger rows) with on-demand history endpoints, plus client changes to request older data. That is
a contract change across many screens, so it needs a product decision and its own test pass; it
was deliberately not made in this audit.

---

## 8 · Commands to reproduce

```bash
npm ci
npx tsc --noEmit
npx eslint .
npm audit --omit=dev            # expect: found 0 vulnerabilities
npm run build                   # DATABASE_URL unset is fine (migration skips)

# Fresh-database migration check
DATABASE_URL=postgres://… npx drizzle-kit push
DATABASE_URL=postgres://… node dev-tooling/migrate-production-schema.mjs
DATABASE_URL=postgres://… node dev-tooling/migrate-production-schema.mjs   # idempotent
```
