# Performance & Deployment Audit — GoMina 360

**Date:** 2026-10-10 · **Branch:** `arena/98f19b62-gomina360-app-v1-1`
**Scope:** frontend bundle, API hot path, PostgreSQL/Neon, Vercel runtime,
migrations, caching, and deployment correctness.

---

## 1 · The headline: why the app is slow *after deployment* but not locally

Local development puts the app, the proxy and the database in one process on
loopback. Deployment splits them across invocations and puts the database on
another continent. Three of the four findings below exist **only** in that
split, which is exactly why they were invisible until deployment.

| # | Finding | Where it hurts |
|---|---|---|
| **P1** | The API proxy resolved the session before consulting its own allowlist | Every `/api/*` call |
| **P2** | `record_deletion_logs` had **no index at all** and is append-only | Every audit panel |
| **P3** | `users.assigned_business_id` was unindexed — a full scan of the whole user table | Every `/api/init` and every access check |
| **P4** | Preview builds ran the production migration | Every preview deploy |

A fifth item (**P5**) is not a speed problem but a correctness one that the
audit surfaced while measuring, and it is covered here because it affected
whether the measurements could be trusted.

---

## 2 · P1 — the proxy resolved a session it did not need

`src/proxy.ts` enforces the Farm Advisor default-deny policy on **every**
`/api/*` request. It resolved the session first and only then asked its own
allowlist whether the path was permitted:

```ts
const info = await getSessionInfo(request);          // ← database round trip
if (!info || !isFarmAdvisor(info.user)) return next();
for (const rule of ADVISOR_API_ALLOWLIST) { /* ... */ }
```

So every request paid a database round trip to learn a role that the
**path + method already decided**. Worse: on Vercel the proxy and the route
handler are separate invocations, so `getSessionInfo()`'s 5-second micro-cache
is **not shared between them** — the token was resolved from Postgres **twice
per authenticated request**. The module's own comment had already noted that
this "fixed ~2×RTT tax on EVERY request on a remote (deployed) database"; the
proxy re-introduced it.

**Fix — reorder, which is provably equivalent rather than a relaxation:**

```ts
if (advisorAllows(pathname, method)) return NextResponse.next();  // cheap, no DB
const info = await getSessionInfo(request);                       // only if needed
```

* An **allowlisted** (path, method) was already passed for advisors, so
  everyone passed — the role could not have changed the outcome. The lookup was
  pure waste.
* A **non-allowlisted** path still resolves the session, because that is the
  only case where "is this an advisor?" actually decides the answer.

The 403 body, the fail-open catch, and the per-route authorization backstop are
untouched. `advisorAllows()` is a pure string comparison, exported so
`dev-tooling/verify-proxy-fast-path.mjs` can assert its classification directly.

### How this is measured — and an honest limitation

A timing-based measurement is **not** possible locally, and the suite says so.
Locally both live in one process, so the shared cache makes the "before" case
look identical to the "after" case. An unreachable-database timing harness was
built and abandoned: the sandbox returns `EHOSTUNREACH` immediately rather than
dropping the SYN, so both paths answer in ~13 ms and the number is meaningless.

So the suite is **structural**: it lifts the real allowlist and predicate out of
the shipped source, asserts all 24 (path, method) classifications — including
near-miss prefixes like `/api/authentic` that a naive `startsWith` would wrongly
allow — and asserts that the decision strictly precedes session resolution.

**Expected production effect:** one fewer database round trip on every
allowlisted API request. At a 40–80 ms cross-region RTT (see §6), that is
**40–80 ms removed from the latency of `/api/init`, `/api/notifications`, the
bell, `/api/menu`, `/api/branding`, `/api/currency`, `/api/health`, `/api/auth/*`
and `/api/poultry` reads.** It is not measurable here; it is arithmetic.

---

## 3 · P2 / P3 — two missing indexes on the hottest reads

`src/db/schema.ts` declares 162 indexes and the migration reconciles them, so
this was not a "the deploy forgot to build indexes" story. These were simply
absent from the schema, so they were absent from production too.

### P2 · `record_deletion_logs` — no index whatsoever

An append-only table that is never pruned, read by **every module's audit
panel** (`WHERE module = ?`, scoped to the viewer's organizations) and folded
into `/api/audit's DELETION records`.

Measured on 30 000 rows, one tenant, one module, 50-row page:

| Plan | Time |
|---|---|
| before (`owner_id` single-column index only) | **3.538 ms** |
| after `record_deletion_logs(owner_id, module, created_at)` | **0.051 ms** |

**99 % faster**, and — the important part — the old plan's cost grew linearly
with the table, which only ever grows. Added as
`record_deletion_logs_owner_module_created_idx`, with the column order mirroring
the route's own access pattern.

### P3 · `users.assigned_business_id` — full scan of the entire user table

`users` was indexed only by `email` (unique). But access scoping filters on the
assigned unit constantly:

* `/api/init` narrows the directory with `WHERE id = $1 OR assigned_business_id IN (…)`
* `accessibleBusinessIds()` drives the same column for **every role-checked route**

Measured on 5 000 users:

| Plan | Time | Shape |
|---|---|---|
| before | 0.621 ms | **Seq Scan**, 4 500 rows discarded |
| after | **0.257 ms** | Bitmap Index Scan |

This is the one scan that never stops getting worse as the platform is adopted,
because the table grows with the *platform*, not with any one business. Added
`users_assigned_business_id_idx` and `users_primary_org_id_idx`.

### Also added, and honestly reported as marginal

`notifications(user_id, is_read)`. The bell badge counts unread notifications on
every page load, and the only user-facing index was `(user_id, id)`. Measured:
**0.217 ms → 0.215 ms** — the planner was already choosing a bitmap heap scan
that discarded only the read rows, so the real-world win is small here. It is
kept because it removes a filter step that otherwise grows with every
notification the user has ever received, but it is **not** presented as the win
that P2 and P3 are.

All four indexes are declared in `schema.ts` (the single source of truth) **and**
in the migration's curated list, and were verified to be created on a **fresh**
database — the case a brand-new Neon project would hit.

---

## 4 · P4 — preview builds were migrating the production schema

`npm run build` runs `db:migrate`, and the script had **no `VERCEL_ENV` gate**.
Vercel Preview builds share the Production `DATABASE_URL`, so:

* a throwaway branch had the authority to add columns, backfill rows and create
  indexes on the **live** database;
* every preview build paid for a full migration before it could finish.

**Fix.** Preview builds skip the migration; Production builds still run it, which
is the whole point of the step and how schema drift gets closed. A preview
shares the production database, so production's most recent deploy has already
applied the schema it needs.

```
VERCEL_ENV=preview                              → skipped
VERCEL_ENV=preview  GOMINA_MIGRATE_ON_PREVIEW=1  → migrates (opt-in escape hatch)
VERCEL_ENV=production                           → migrates
local                                          → migrates
```

All four paths verified.

---

## 5 · P5 — a data-integrity bug the audit surfaced

While verifying the migration on a rebuilt database, `business-scope` failed a
partition assertion: three `GRANT_ACCESS` audit rows appeared in the Super
Admin's "everything" view and in **no** owner's view.

**Cause.** Records that name no business (organization-level access grants and
delegations) were narrowed by business id only, so `business_id = 0` matched no
organization's unit list and the row silently vanished from every owner-scoped
query — even though `audit_trail.owner_id` correctly identified its tenant, the
same column `scopedTrail()` already trusted for these very rows.

**Fix.** Such records now carry their own `ownerId`, and the narrowing falls
back to it, **intersected** with the caller's own organizations so the fallback
can never widen access. Before: `372 + 1 = 376`. After: `375 + 1 = 376`.

That fix then exposed a second instance of the same shape, found by a
**reproduced** probe rather than by chance. A deletion-trail row whose unit had
since been deleted was published with a **dangling `businessId`** pointing at a
business that no longer exists. That is actively harmful in two ways: the client
cannot look the id up, and any consumer that resolves ownership from the business
table reads "unknown business" as "belongs to nobody" — which the tenant suite
correctly flagged as a leak. Such records are now reported as **unattached
(`businessId` 0) carrying their own `ownerId`**, so the tenant that owns the
trail stays explicit and the trail outlives its unit cleanly.

Verified against a deliberately planted row naming a deleted unit:

| Check | Result |
|---|---|
| Reported `businessId` / `ownerId` | `0` / `1` — no dangling id |
| Reachable in its owner's view | ✅ yes |
| Reachable in another org's view | ✅ **no** |
| Reachable via an explicit `businessIds=1,2` list | ✅ **no** |

The last row is the important one and the fix needed two passes to get right: an
explicit unit list must be honoured *literally*, so the owner-fallback is now
applied **only** to owner-wide views. Without that guard the first version
smuggled unattached records into an explicit unit selection — a real scope
widening, caught by `verify-tenant-isolation` before it could ship.

Separately, `business_insights.notes_analyzed` was an **accumulated counter**
(`prev + 1`) maintained independently of the notes themselves. It was observed
reporting **2 for a unit with zero notes**, and the two writers disagreed: the
POST path incremented while the PATCH path rebuilt from the rows. The counter is
now **derived** from the actual note rows on every write, so it is self-healing
and can no longer drift from the data it counts.

---

## 6 · Region pairing — now visible instead of mysterious

`vercel.json` pins the functions to `fra1`, which requires a Neon project in
Europe (Frankfurt). **A mismatch adds a full network crossing to every single
query**, and nothing in the app said so. The documentation already warned about
it, but documentation is not a diagnostic.

Neon encodes its region in the hostname, so the pairing is now checked for real:

* `/api/health` reports `dbRegion`, `vercelRegion`, `regionMatched` and a
  plain-English `regionNote` explaining exactly what to change. A hostname that
  does not advertise a region reports `unknown` — never a false alarm.
* Every cold start logs the pairing, and flags `(CHECK PAIRING)` on a mismatch.

---

## 7 · What was checked and found healthy

Deliberately **not** changed, because measurement said they were already right:

| Area | Finding |
|---|---|
| **Client bundle** | 739 KB raw / **225 KB gzip** initial. All nine business modules and the heavy post-login views are already code-split via `next/dynamic`; the 909 KB `exceljs`/`xlsx`/`jszip` chunk is lazy, not on the critical path. |
| **`/api/init`** | Batches 24 statements into a **single** round trip via `pool.query()`, not 24 sequential ones. |
| **Images** | `photos[]` / `photosThumb[]` are excluded from bootstrap and `photo` is swapped for `photoThumb`; branding crosses the wire as an md5, with blobs served separately under browser caching. |
| **API caching** | ETag / `304` and gzip are already in place on the routes that warrant it (`init`, `menu`, `track`, `assistant`, `branding`, `currency`, exports). |
| **Connection pool** | Lazy, process-wide, pooled-aware sizing (8 through a pooler, 2 on a direct Vercel connection), `keepAlive`, and one sanitized startup line. |
| **Migration** | Additive and idempotent, guarded by an advisory lock that is pooler-safe. |

Also found and fixed: **`preview-up.sh` reused a stale server after a rebuild.**
It saw the old process still listening, skipped the restart, and served the
*previous* bundle — so every check passed and every suite silently measured old
code. This cost two debugging cycles during this audit; a rebuild now always
forces a restart and the old process is actually killed. A verification tool
that can quietly test stale code is worse than one that fails.

---

## 8 · Test results

Every suite re-run against a rebuilt, restarted preview.

| Suite | Result |
|---|---|
| **proxy-fast-path** (new) | **6 / 0** |
| farm-advisor | **192 / 0** (was 191/1, then 8 cascading failures) |
| financial-permissions | **110 / 0** |
| tenant-isolation | **15 / 0** |
| enterprise-permissions | **200 / 0** |
| audit-access · audit-records | **28 / 28** · **29 / 0** |
| business-scope | **94 / 94** |
| notify-activity | **100 / 0** |
| export-center | **77 / 0** |
| employees · payroll2 · boutique | 46/46 · 53/53 · 74 |
| budgets-cashflow · business-backup | 26 · 54 |
| credit-sales · expense-permissions | 39/0 · 42/0 |
| inventory-permissions · staff-access | 34/0 · 44/0 |
| p4-writers · single-writer | 23/0 · 35/0 |
| finance-allproducts-fresh · permissions-storefront | 49/0 · 48/0 |
| expense-ui-manage · charts-live-data | 22/0 · 20/0 |
| telecom | **63 / 63** |
| actor-spoof-live | **PASS** |
| `tsc --noEmit` | **0 errors** |
| `eslint .` | **0 errors** (166 pre-existing warnings, none from this work) |
| `npm run build` | **✓ Compiled successfully** · 88 static pages |
| Migration on a **fresh** database | ✓ full schema + all 4 new indexes |
| Migration idempotency | ✓ `schema already in sync` on re-run |

`verify-farm-advisor` was run **five consecutive times at 192/0** to confirm the
insights fix is not order-dependent — the derived counter and the suite's
cleanup now agree.

All 27 suites above were re-run against a preview rebuilt from scratch
(`rm -rf .next`) with the server confirmed to be serving the build that was just
produced, so no result above was measured against a stale bundle.

---

## 9 · Deployment status

**Ready to deploy.** TypeScript, lint, and the production build are clean; the
migration is additive, idempotent and verified on a fresh database; every
regression, permission, financial, security and tenant-isolation suite passes.

No change was made to authorization, tenant scoping, financial gating or data
integrity beyond the two correctness fixes in §5, and each is covered by a
suite that was failing before and passes now.

### Manual configuration still required in Vercel / Neon

These cannot be done from the repository:

1. **Confirm the region pairing.** Open `/api/health` on the deployed URL. If
   `regionMatched` is `false`, either move the Neon project to the region named
   in `regionNote`, or change `regions` in `vercel.json` to match the database.
   A mismatch costs a network crossing on **every query** and is the single
   largest remaining latency factor.
2. **`DATABASE_URL`** — set for **both** Production and Preview, using the
   **pooled** Neon endpoint (`…-pooler.<region>.aws.neon.tech`, `sslmode=require`).
3. **`CRON_SECRET`** — required by the 06:00 UTC daily-ops cron; without it the
   cron fails closed.
4. **Preview builds no longer migrate.** If a preview ever needs a schema
   change, deploy to Production first, or set `GOMINA_MIGRATE_ON_PREVIEW=1`
   for that build only.
5. **Optional tuning:** `PG_POOL_MAX` (default 8 through a pooler). Keep
   `instances × PG_POOL_MAX` under the provider's connection limit — Neon Free
   allows roughly 100.
6. **Optional:** `ENABLE_HSTS=1` once real TLS is serving, and `FRAME_ANCESTORS`
   if the app is embedded somewhere other than the preview host.