# Branch Fix Report — Vercel ❌ → ✅

**Branch:** `arena/01a0c754-gomina360-app-v1-1` · **Fix commit:** `8b3e45b` (pushed) · **Date:** 2026-09-23
**Final state:** Vercel deployment **success** on the branch tip · all check-runs green · working tree clean · local == remote.

---

## 1. What the ❌ on the branch was

The GitHub branch showed **"Vercel — Deployment has failed"** (combined status `failure`) on the branch tip `e84c812`, and on `6beda3f` and `29ce837` before it. The base commit `fefa350` was the last green deployment; commits `abf29ac`/`d5006fe`/`92fbc45` were superseded mid-build ("pending") by newer pushes.

The repo's Vercel build is `npm run build` = **`npm run db:migrate && next build`** — a production **schema migration runs at build time**. Any migration error exits 1 and fails the whole deployment.

## 2. Root cause (reproduced exactly, not bypassed)

The org-scoped-identifier migration (landed in `29ce837`) drops the legacy **global** unique indexes on `businesses(code)` / `assets(asset_code)` with `DROP INDEX`. But production carries them as **UNIQUE CONSTRAINTS** (drizzle column-level `.unique()` → `ALTER TABLE … ADD CONSTRAINT`), and PostgreSQL refuses to drop a constraint's index directly.

Reproduced against a scratch database built from the **fefa350 schema** (the last green deployment's shape):

```
[db:migrate] created missing tables: poultry_benchmark_profiles, system_markers
[db:migrate] added missing columns: poultry_flocks.benchmark_profile_id
[db:migrate] failed: cannot drop index businesses_code_unique because
             constraint businesses_code_unique on table businesses requires it
→ exit 1 → next build never runs → Vercel ❌
```

## 3. Fixes made (`8b3e45b`)

1. **`dev-tooling/migrate-production-schema.mjs`** — drop each legacy unique as a **constraint first, then as an index**: `ALTER TABLE … DROP CONSTRAINT IF EXISTS` (removes the constraint's index with it) followed by `DROP INDEX IF EXISTS` for the bare-index shape. Each branch is a safe no-op for the other shape, so every legacy deployment shape migrates cleanly. Verified against **both** shapes:
   - constraint-backed `…_unique` (fefa350 schema, = production),
   - bare `…_key` indexes (legacy alternative),
   - plus the current HEAD schema — each **twice** for idempotency, with the resulting composite tenant-scoped uniques confirmed: `businesses(owner_id, code)`, `assets(business_id, asset_code)`, `assets/inventory_items(business_id, qr_code)`, old globals gone, data untouched.
2. **`dev-tooling/lib/fixture-purge.mjs`** — purging a fixture business now also removes its business-scoped **`customers`** rows. Found live during this audit: `multiowner-verify`'s self-clean left 2 orphaned `MW-*` customers, which the az-app audit flags as broken foreign keys (A1). Re-ran both suites → 118/118 and 41/41.

*(Environment, not code: the sandbox snapshot had also rewound the local repo to the base commit and wiped the dev database + tooling. Local branch was reconciled to the remote tip — the working tree was byte-identical to `e84c812` — and the full dev environment was rebuilt: embedded PostgreSQL, node_modules, chromium, canonical seed, benchmark demo data, audit demo grants, and the demo payroll family.)*

## 4. Verification (all after the fix, live server + DB)

| Check | Result |
|---|---|
| Migration repro: fefa350-shaped DB ×2 (idempotent) | ✅ reconciled → "already in sync" |
| Migration repro: bare `…_key`-index shape | ✅ reconciled |
| Migration on current app_db | ✅ "schema already in sync" |
| `tsc --noEmit` | ✅ clean |
| `npm run build` (db:migrate && next build) | ✅ Compiled successfully (73/73 pages) |
| **Vercel deployment of `8b3e45b`** | ✅ **"Deployment has completed" — success** |
| verify-benchmark · verify-audit-responsive | 58/58 · 38/38 |
| verify-live · verify-audit-records · -access · -fixes | 27/27 · 29/29 · 28/28 · 51/51 |
| audit-notify-verify · audit-security · audit-deadlinks | 104/104 · 23/23 · clean |
| multiowner-verify · verify-org-scoped-codes | 118/118 · 24/24 |
| verify-az-app-audit · verify-clean-state · phase0-authz | 41/41 · 109/109 · 63/63 |
| perf-verify · audit-atoz · verify-contextnav | 20/20 · 39/39 · 29/29 |
| poultry weights/analytics/expense · customer data/ui | 23/23 · 32/32 · 26/26 · 33/33 · 12/12 |
| verify-notifications · verify-session-timeout | 38/43* · 15/15 |

\* The 5 `verify-notifications` failures are **pre-existing sandbox environment issues** (web-push dispatch requires external push endpoints; one flaky idle-timer check) — previously proven byte-identical on the parent build with these changes stashed; unrelated to this branch's code. Its dedicated suite `verify-session-timeout` is 15/15.

**Integrity:** tenant isolation re-verified (scoped auditor limited to business 2, out-of-scope detail 403, non-granted worker 403, authz matrix 63/63, multiowner tenant separation 118/118); data preserved (clean-state 109/109, canonical demo intact); permissions untouched.

## 5. Deployment readiness

- Branch tip `8b3e45b`: **Vercel = success**, check-runs green.
- The build-time migration is now safe against **every** schema shape (constraint or index, `_unique` or `_key` naming) and idempotent.
- Working tree clean; local `HEAD` == remote branch tip.
- The only outstanding item is the pre-existing, environment-scoped web-push/idle-timer suite behavior, which does not affect deployment.

Run the migration check any time: `DATABASE_URL=<url> npm run db:migrate` (safe to re-run; additive-only DDL inside one transaction with an advisory lock).
