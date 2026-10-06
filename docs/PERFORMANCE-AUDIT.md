# GoMina 360 — Full Performance Audit

**Date:** 2026-10-06 · **Scope:** whole platform (Next.js 16 App Router + Drizzle/PostgreSQL on Vercel + Neon)
**Type:** diagnosis + prioritised plan. **No code was changed to produce this report.**
**Measured against:** the running production build (`next start`) with the app's own database, owner + branch-manager sessions, real pages and APIs. Evidence scripts: `dev-tooling/perf-probe.mjs`, `dev-tooling/perf-db-audit.mjs` (re-runnable — see §9).

---

## 0. TL;DR — the ten sentences that matter

1. **The single biggest problem is unbounded data reads.** `/api/init` (the dashboard bootstrap) selects **every row of 28 tables with no `LIMIT`** — 227 KB today with tiny demo data. It grows forever with transaction/checklist history, and it is loaded on **every** dashboard open.
2. **The second is sequential database round trips.** Page-level routes issue **one query per await**: `/api/audit` fires **126 sequential queries**, `/api/transport` 74, `/api/businesses/[id]` 42, `/api/block-factory` 41, `/api/payroll` 30, `/api/procurement` 28. Every one of them is a network round trip once the database is not on the same machine.
3. **That is why the app feels fine locally and slow after deploying to Vercel + Neon.** Locally a round trip costs ~0.1 ms; to Neon in another region it costs 20–100 ms. 126 round trips = **2.5 s–12 s** for a page that takes 43 ms here.
4. **Some pages are slower than others for structural reasons:** the dashboard (1 batched round trip, but a growing payload), business/module pages (30–126 sequential round trips), and the Audit & Review centre (126 round trips **plus** it reads *every tenant's* rows and filters in JavaScript).
5. **Some businesses are slower than others** because the dashboard payload is a function of *your* data volume: 11 units ⇒ 227 KB vs 1 unit ⇒ 70 KB; the 63% share is daily-checklist data; a unit with more activity and more flocks/units makes everyone in that organisation heavier.
6. **The client bundle is the other half of the felt slowness:** 215 KB gzip of JavaScript before the login screen appears, +280 KB gzip after sign-in (including a 116 KB gzip `recharts` chunk), 27+ files. On a throttled 4G/slow-phone profile we measured **2.85 s to the login screen** and **1.2 s login → dashboard** — with the server on localhost, i.e. before any real network is added.
7. **Several endpoints ship whole tables**: `/api/transactions` returns the entire ledger of every tenant (no `LIMIT`, no paging) — the code even documents having removed receipts because "a 300-receipt workspace paid ~80–100 MB per open". The receipts were removed; the unbounded row count was not.
8. **Arena can fix most of this without touching the infrastructure**: caps + payload slicing, batched one-round-trip reads (the pattern already exists in this codebase for `/api/init`), SQL-side scoping instead of JS filtering, ETag/`Cache-Control`, lazy chart bundles, splitting the boot fan-out.
9. **Four things are outside Arena's control and must be checked on the accounts themselves:** (a) the **Neon region must match the Vercel region** (`vercel.json` pins functions to `fra1`) — a US Neon project with EU functions multiplies every round trip by ~50; (b) use the **Neon pooled (`-pooler`) connection string**; (c) **Vercel Fluid Compute** (keeps instances warm, makes the in-process caches real); (d) plan/quota and the geography of Ghana→nearest-region latency.
10. **Nothing here requires a rewrite.** Ranked, the P0 items are: cap and split `/api/init`, batch/scope `/api/audit`, add `LIMIT`+paging to the ledger endpoints, and get the icons/charts out of the sign-in path. Everything else is incremental.

---

## 1. How this was measured (and how to read the numbers)

| Aspect | Detail |
|---|---|
| Build | Production `next build` + `next start` (not dev mode) |
| Database | The app's own PostgreSQL, **on the same machine** as the app |
| Page timings | `curl`-equivalent HTTP timing, 5-run p50 |
| API sizes | raw bytes **and** bytes on the wire with `Accept-Encoding: gzip` |
| API work | wall time + `pg_stat_database.tup_returned` deltas (rows actually read) |
| Query counts | static census of `await db.`/`await tx.` per route (`dev-tooling/perf-db-audit.mjs`) |
| Client | headless Chromium + CDP `encodedDataLength` (true transferred bytes) |
| Slow device/network | CDP: 1.6 Mbps down / 750 kbps up / 150 ms RTT / 4× CPU throttle |

**Census of the whole API surface: 89 route files making 764 DB round trips in total**, 4 of them (audit, businesses/[id], payroll, procurement) doing ≥20 *sequential* round trips with no batching at all (`dev-tooling/perf-db-audit.mjs`).

**Read the absolute times as "work done per request", not as production latency.**
Because the database is local, a round trip costs ~0.1 ms here. In production, **production latency ≈ (work) + (round trips × RTT)**. A route with 126 sequential queries at 20 ms RTT adds 2.5 s that does not exist in the local number. That multiplication is the core of this audit.

---

## 2. What is already fast — do not "optimise" these

Being precise about what's good matters as much as what's bad:

| Already done | Evidence |
|---|---|
| Public pages are static/ISR on the CDN | `/` responds in **1.5–4 ms**, 8.2 KB, `x-nextjs-prerender: 1`, `Cache-Control: s-maxage=60, stale-while-revalidate=31535940`; `/order`, `/track`, `/join` the same |
| The bootstrap read is **one** DB round trip | `src/lib/initSnapshot.ts` concatenates 28 statements into a single simple-protocol query — 4,755 rows returned in **1 round trip**, 7–36 ms locally |
| The biggest payload is gzipped inside the function | `/api/init` 227.5 KB → **26.6 KB on the wire** |
| Heavy libraries are code-split | `exceljs` (909 KB raw), `jspdf` (408 KB), `xlsx` (423 KB), `leaflet` (151 KB) are **not** in the boot bundle; exports import them dynamically |
| Session resolution is memoised | per-token short TTL in `src/lib/auth.ts` (avoids a DB hit on every one of the ~10 boot calls) |
| Pool sizing is provider-aware | `src/db/index.ts` detects a `-pooler` host/6543/`pgbouncer=true` and raises `PG_POOL_MAX` 2 → 8 on Vercel; never falls back to localhost |
| The schema is indexed | 147 index declarations, incl. `business_id` on every log table |
| Compressible JSON is compressed **at the Vercel CDN** | Vercel compresses `application/json`, `text/javascript`, `text/css`, `svg+xml`… with gzip/brotli automatically when `Accept-Encoding` is present ([Vercel docs](https://vercel.com/docs/how-vercel-cdn-works/compression)) — so the uncompressed responses we see locally *are* compressed in production |

That last row matters for prioritisation: **"gzip every JSON route" is a nice-to-have (self-hosting portability), not a production emergency.**

---

## 3. The bottlenecks, ranked by impact

### B1 — `/api/init` reads 28 tables with **no row limit** (grows forever)

The bootstrap batch ends with `ORDER BY "id" DESC` and **no `LIMIT`** (`src/lib/initSnapshot.ts:103`, `NEWEST_FIRST`). It loads, unbounded: businesses, business_metrics, users, customers, suppliers, employees, assets, inventory_items, **transactions**, credit_sales, ai_insights, scenario_simulations, integrations, **checklist_templates**, checklist_entries (today only), and 8 operation-log tables — for every accessible business of the viewer, on every dashboard load.

Measured, owner with 11 units (demo-sized data):

| Payload part | Size | Rows | Note |
|---|---|---|---|
| **`checklists`** | **142.4 KB (63%)** | 192 templates + 88 entries | templates grow with units/flocks and are never trimmed |
| transactions | 19.3 KB | 40 | 544 B/row → the fastest-growing part in real use |
| inventory | 19.3 KB | 17 | 625 B/row (incl. thumbnail data) |
| users | 14.8 KB | 18 | |
| businesses | 8.2 KB | 11 | |
| **TOTAL** | **227.5 KB** | 4,755 rows read | 26.6 KB gzipped, `Cache-Control: no-store` |

Same code, **Branch Manager with one unit: 69.9 KB / 10.2 KB gzipped.** The difference is purely "how much data does this viewer's scope contain".

Why this is the #1 item:
- Growth is **linear and unbounded** in business activity, while the *dashboard* only needs summaries + the newest N rows.
- It re-reads everything on every dashboard open (the 10-second TTL cache is per serverless instance, so on Vercel it is hit only inside a warm instance).
- The client then JSON-parses and `.filter()`s these arrays repeatedly in module renders (e.g. `PoultryFarmModule`, `AquacultureModule` scan all checklists).
- There is a hard ceiling on the platform side: a Vercel Function's response body is capped at **4.5 MB** (413 `FUNCTION_PAYLOAD_TOO_LARGE`). `/api/init` gzips internally so it dodges that (its compressed body is what Vercel measures), but any large **uncompressed** sibling route does not — see B3.

### B2 — Sequential query fan-out on page routes (the Vercel/Neon killer)

| Route | DB round trips | `Promise.all` | Local time | Payload |
|---|---|---|---|---|
| `/api/audit` (Audit & Review centre) | **126** | **0** | 43–66 ms | 75.1 KB |
| `/api/transport` | 74 | 2 | — | — |
| `/api/businesses/[id]` (business page) | 42 | 0 | **99 ms** | 72.7 KB |
| `/api/block-factory` | 41 | 1 | — | — |
| `/api/payroll` | 30 | 0 | 35 ms | 10.3 KB |
| `/api/procurement` | 28 | 0 | 17 ms | 1.7 KB |
| `/api/telecom` / `/api/fulfillment` / `/api/aquaculture` / `/api/carwash` / `/api/restaurant` / `/api/hardware` / `/api/electronics` | 6–15 | — | 8–13 ms | — |
| `/api/init` (for contrast) | **1** | n/a (batched) | 7–36 ms | 227.5 KB |

Production arithmetic (same work, different round-trip cost):

| Route | same region (2 ms RTT) | typical (20 ms) | cross-region (95 ms) |
|---|---|---|---|
| `/api/audit` (126) | ~0.3 s | **~2.6 s** | **~12 s** |
| `/api/businesses/[id]` (42) | ~0.1 s | ~0.9 s | ~4 s |
| `/api/transport` (74) | ~0.2 s | ~1.5 s | ~7 s |
| `/api/init` (1) | ~0.05 s | ~0.05 s | ~0.1 s |

**The pattern that makes this a pure latency bug is that the fix already exists in this codebase**: `/api/init` shows the one-round-trip multi-statement batch (`getPool().query(stmts.join(";\n"))`), and it is used in only 3 files. The other 86 routes open a connection slot per `await`.

### B3 — Whole-table reads with JavaScript-side filtering (multi-tenant scan)

Two routes read **all tenants'** rows and then filter in JS:

```ts
// src/app/api/audit/route.ts
const txns = await db.select().from(transactions).orderBy(desc(transactions.id)).limit(240);
for (const t of txns) { push({...}) }            // push() filters with canSeeRecord(...)
for (const l of await db.select().from(livestockLogs).orderBy(desc(livestockLogs.id)).limit(120))
```

```ts
// src/app/api/transactions/route.ts — no LIMIT at all
const allTrx = await db.select().from(transactions).orderBy(desc(transactions.id));
if (session.user.isSuperAdmin) return …;
const allowed = await accessibleBusinessIds(session.user);
const scoped = allowed === null ? allTrx : allTrx.filter((t) => allowed.includes(t.businessId));
```

Consequences:
- **One busy tenant slows down every other tenant's pages**, because the scan is global before it is scoped.
- The Audit centre's cost is proportional to *platform-wide* data, not the viewer's — 25+ tables, caps of 120–600 rows each (~2,000–3,000 rows per request).
- `/api/transactions` is the clearest failure mode: it returns the full ledger. With ~350 B/row (receipts already stripped) the **4.5 MB response limit is reached around 13,000 transaction rows** → HTTP 413 for the whole screen, for every user.
- The audit route also carries salary columns into this payload (already on the security backlog from Task 2 — the perf fix and the security fix are the same edit).

### B4 — Boot fan-out: 8 serverless functions + 495 KB gzip of JS

A signed-in dashboard load makes **10 API calls across 8 distinct functions**:

`/api/init` · `/api/branding` · `/api/attendance` · `/api/notifications` · `/api/sales-documents` · `/api/currency/rates` · `/api/session/heartbeat` · `/api/audit?meta=1` (+ `/api/auth/login`)

Each one is its own cold-start candidate on Vercel. Client-side transfer for the whole boot (login screen + dashboard) measured by CDP:

| Phase | JS (gzip) | Files | Total transfer |
|---|---|---|---|
| Signed-out login page | **215 KB** | 10 chunks | ~0.7 MB incl. HTML/CSS |
| After sign-in (dashboard adds) | **+280 KB** | +18 chunks | (incl. `recharts` = **116 KB gzip**) |

Throttled 4G + 4× CPU: **2.85 s to the login screen, 1.2 s login → dashboard** — with the server on localhost and no DB latency. On a real deployment you can add cold starts and Neon latency on top.

Notable: **`recharts` (116 KB gzip) is on the post-login critical path** because the landing dashboard components import it statically (~20 module components import `recharts` directly; the heavy export libs are lazy, charts are not).

### B5 — Caches that don't survive serverless + no conditional requests

- `src/lib/ttlCache.ts` is a **per-process** Map. Locally it works (`X-Init-Cache: miss → hit → hit`); on Vercel it only helps while an instance stays warm. **Neon + Vercel Fluid Compute** (or `unstable_cache`) is what makes those caches real.
- Read-only endpoints ship no `ETag` and mostly no `Cache-Control`, so a reload re-downloads `/api/users` (15.5 KB), `/api/audit` (75.1 KB), `/api/businesses/[id]` (72.7 KB) in full. A 304 would send ~0 bytes.
- `/api/branding` = **90 KB** of base64 images (51.4 KB company logo + 71.9 KB of business logos) shipped as JSON. It is privately cached for 7 days, so a *cold* browser pays 90 KB of non-compressible image data as a JSON parse.
- `/api/currency/rates` calls the external `open.er-api.com` **on the dashboard boot path** (2.5 s timeout, 6 h in-process cache, static fallback on failure). On a cold instance that is a third-party round trip before the dashboard is complete.
- Periodic traffic per signed-in user: notification bell polls `/api/notifications` every 30 s while the tab is visible, the signed-in-staff panel every 15 s while open, presence heartbeats on visibility events. Each poll is a function invocation **plus** a session lookup. Fine at today's scale; it is the scaling cost driver (see §7).

---

## 4. Why some businesses and pages are slower than others — the five mechanisms

The user-visible question "why is *this* business/page slower?" has five distinct, measurable answers:

1. **Scope size.** `/api/init` is scoped to the viewer's accessible businesses. Owner/11 units = **227.5 KB**; Branch Manager/1 unit = **69.9 KB**. A General Manager over 3 units sits in between. Nothing about the *code path* differs — only how much data the same 28 unbounded reads return.
2. **Which business types exist in that unit.** Each type has its own module route with its own fan-out: feed-mill chains (`poultry/feed-mill` 39, `aquaculture/feed-mill` 34), `transport` **74**, `block-factory` **41**, `restaurant`/`carwash`/`hardware` ~11–12 each. A poultry+aquaculture+transport organisation pays those round trips on those screens; a boutique-only organisation never does.
3. **Checklist/flock structure.** `checklist_templates` materialise per business **and per bird type/flock/stage** and are never removed. Our demo tenant: 192 templates = 94.8 KB = the single largest slice of the dashboard payload. Add flocks → the dashboard gets heavier for everyone in that organisation, on every screen that filters checklists.
4. **Record volume in the ledger.** `transactions` at 544 B/row with no cap: 40 rows = 19 KB; 5,000 rows = ~2.7 MB of JSON parsed on every dashboard open; and `/api/transactions` (whole-table) reaches Vercel's 4.5 MB limit around ~13,000 rows. "The business that has been using GoMina longest is the slowest one" — literally.
5. **The Audit & Review centre scales with the platform, not the user.** It scans 25+ tables globally (caps 120–600 rows each) and filters in JS, then ships 75 KB uncompressed. Any growth anywhere makes every owner's audit page slower. In contrast, a Branch Manager sees a *smaller* view of the same global scan — so the *route* is equally slow for both, and the owner's payload is larger.

---

## 5. What Arena can fix (prioritised)

Estimates use the measured work (rows, round trips, bytes) — they are the *shape* of the win, not a benchmark of the fix.

### P0 — do first (biggest impact, contained risk)

| # | Change | Files | Why / expected effect |
|---|---|---|---|
| 1 | **Cap and split `/api/init`**: add `LIMIT` per table (e.g. newest 200 transactions, newest 200 log rows per module, 500 inventory), and move `checklist_templates`/`checklist_entries` out of the bootstrap into `/api/checklists?businessId=` (loaded by the panel/modules that need it). | `src/lib/initSnapshot.ts`, `src/app/api/init/route.ts`, `DailyChecklistPanel.tsx`, modules | Owner payload 227.5 KB → **target < 70 KB**; rows read 4,755 → < 1,500; removes the unbounded-growth failure mode. Single largest win for every dashboard open on every device. |
| 2 | **Batch and SQL-scope `/api/audit`**: filter with `WHERE business_id IN (…)` (the route already computes the viewer's scope), replace the 126 sequential awaits with **one multi-statement batch** (the `/api/init` pattern) + `Promise.all` for the 4–5 genuinely independent groups, paginate the derived feed, add `ETag` + `private, max-age=15`. Drop salary columns while in there (Task-2 backlog item). | `src/app/api/audit/route.ts` | 126 round trips → **1–3**. Locally 43 ms → ~8 ms; on Neon at 20 ms RTT **~2.6 s → ~0.1 s**. Also stops reading other tenants' rows. |
| 3 | **Add `LIMIT` + keyset pagination to whole-table reads**: `/api/transactions` (never load all tenants), `/api/businesses/[id]`, `/api/transport`, `/api/block-factory`, `/api/payroll`, `/api/procurement` — same batch/scope treatment as #2. | those `route.ts` files | Removes the 4.5 MB/413 cliff, cuts each screen from 28–74 round trips to 1–2, and "the oldest business" stops being the slowest. |
| 4 | **Get icons/charts out of the sign-in path**: lazy-load chart components (`next/dynamic`) so `recharts` (116 KB gzip) loads with the first *chart*, not with sign-in; keep module code-splitting. Add `experimental.optimizePackageImports: ["lucide-react", "recharts"]`. | `src/components/CommandCenterDashboard.tsx` + ~20 chart-importing modules, `next.config.ts` | Cuts ~116 KB gzip (≈25% of post-login JS) from the login→dashboard critical path. |

### P1 — high value, low risk

| # | Change | Files | Expected effect |
|---|---|---|---|
| 5 | **Conditional requests + short private caching** for read-only user-scoped endpoints (`ETag`/`If-None-Match` → 304; `Cache-Control: private, max-age=10, stale-while-revalidate=60`): `/api/init`, `/api/audit`, `/api/users`, `/api/businesses/[id]`, `/api/attendance`, `/api/notifications`. | shared helper in `src/lib/httpGzip.ts` or new `src/lib/httpCache.ts` | Reloads/back-navigation cost ~0 bytes and no DB work. Removes the "every screen re-downloads everything" behaviour. |
| 6 | **Serve branding as images, not JSON**: keep hashes in the boot payload, serve bytes from `/api/branding/logo/:id` (and company logo) with `ETag` + long `Cache-Control` (the `/api/menu/photo` pattern already exists). | `src/app/api/branding/*`, `GoMinaApp.tsx`, `brandingCache.ts` | Boot payload −90 KB of non-compressible base64; images then cache/parallelise like normal assets. |
| 7 | **Take the external FX call off the boot path**: fetch in the daily cron (`/api/cron/daily` already exists) and store the rates; serve the stored row with a long cache. | `src/app/api/currency/rates/route.ts`, `src/lib/currency.ts`, cron | Removes a third-party round trip (up to 2.5 s) from dashboard completion, and a failure mode. |
| 8 | **Consolidate the boot fan-out** into one authenticated `/api/bootstrap?parts=init,branding,attendance,notifications,sales-documents` call (or two), keeping per-part caching. | new route + `GoMinaApp.tsx` | 8 cold-start candidates → 1–2; one session resolution instead of many. Biggest single win on first load after deploy/idle. |

### P2 — worth doing, more surface

| # | Change | Expected effect |
|---|---|---|
| 9 | **Replace per-process `ttlCache` with `unstable_cache`/`revalidateTag`** for `/api/init`, `/api/menu`, `/api/branding` (keep the in-process Map as a second layer). | Makes caching correct on serverless regardless of Fluid Compute; tag-based invalidation already exists in the mutation routes. |
| 10 | **Trim response shapes** (`selectList(...)` projections): drop `photosThumb`/`logo`/`specifications` blobs from list payloads; they are only needed in detail drawers. | Inventory 19.3 KB → ~6 KB; similar for businesses/users. |
| 11 | **Add `maxDuration` + memory per heavy route in `vercel.json`** and set the audit/module routes explicitly; add Vercel Speed Insights for real-user monitoring. | Prevents 413/504-style surprises under load and gives production evidence to compare against this audit. |
| 12 | **DB indexes for the new access patterns**: composite `(business_id, id DESC)` on the big log tables and `checklist_templates (business_id, is_active)`; keep migrations additive via the existing reconciler. | Keeps the batched queries index-only as data grows (the tables have single-column `business_id` indexes today). |

**Explicitly not recommended:** rewriting the dashboard to client-side data fetching, adding a CDN in front of Vercel, or moving to a graphQL layer. The architecture is sound; the work is capping reads, batching round trips and trimming bytes.

---

## 6. What is *outside* Arena's control (production issues to check on the accounts)

These are the items where the application code cannot help — only project settings, plan choices or infrastructure changes will.

### 6.1 Region alignment — the #1 external fix

`vercel.json` pins serverless functions to **`fra1` (Frankfurt)**. The cost model above shows why the **Neon project's region** matters more than anything else:

- Neon in **eu-central-1** (Frankfurt) ↔ Vercel `fra1`: ~1–3 ms RTT. `/api/audit` ≈ 0.3–0.5 s.
- Neon in **us-east-1/us-west-2** ↔ Vercel `fra1`: **~90–100 ms RTT**. `/api/audit` ≈ **10–12 s**, `/api/transport` ≈ 7 s, `/api/businesses/[id]` ≈ 4 s.
- Verify it: Vercel → Runtime Logs, the app prints one line per instance — `[db] pool created → host=… max=… vercel=…` (`src/db/index.ts`). Compare the host's region with `vercel.json`.
- Fix: create/migrate the Neon project in `eu-central-1`, or (if the user base is US-centric) move the Vercel region to `iad1`. They must match; the app works either way, it is only latency.

### 6.2 Neon connection method and compute

- **Use the pooled (`-pooler`) connection string** for the app (`DATABASE_URL`). The code already detects it and raises the client pool 2 → 8; without it, Vercel keeps `PG_POOL_MAX=2`, which serialises every parallel read (the code comments even document the old 12-latency-wave problem at 2 sockets).
- **Keep the direct URL for migrations** (`POSTGRES_URL_NON_POOLING` / a separate var used by `npm run db:migrate`). Note: the seeder uses `pg_advisory_lock` (`src/db/seed.ts:455`) — a session-level lock that Neon's transaction-mode pooler does not guarantee. Seed against the direct URL.
- **Scale-to-zero / autosuspend:** Neon suspends an idle compute (default ~5 min). The first request after idle pays a wake-up (hundreds of ms to seconds). Mitigate with the daily cron, a keep-warm ping, or disabling suspend on a paid plan. This is exactly why "the first login in the morning takes longer".
- **Compute size** drives `max_connections` and scan/parallel throughput. The audit/module routes do many full-table reads; a 0.25 CU instance serialises them.

### 6.3 Vercel project settings

- **Fluid Compute**: enable/verify it. It keeps instances warm between requests, which (a) removes most cold starts from the 8-call boot fan-out and (b) makes the app's in-process TTL caches actually effective.
- **Function region**: `fra1` is a reasonable choice for Ghana (≈110 ms from Accra; Vercel has no African region). Test `lhr1`/`cdg1` only if measurements say so.
- **Plan limits**: function response/request body is **4.5 MB** (non-configurable) and max duration is 300 s (Hobby and Pro default); concurrency and bandwidth are plan-scoped. A 126-round-trip route plus per-user polling is also the **cost** driver: every poll is a billable invocation.
- **CDN compression is already on** for `application/json`/`text/javascript` — no action needed, and don't be alarmed by uncompressed local measurements.

### 6.4 Network, geography and devices (nobody can fix these in code)

- **Ghana → nearest Vercel region ≈ 110–150 ms RTT.** The only real mitigations are fewer round trips (Arena's job), smaller payloads (Arena's job), and CDN caching of static/asset traffic (already true).
- **4G + low-end Android is the real device profile.** 495 KB gzip of JS parses slowly on a 4× throttled CPU (§3 B4). Arena can cut bytes; it cannot change the handset.
- **Third-party dependencies**: the FX API and Google Maps (tracking page) are external availability/latency factors.
- **Self-managed Postgres / non-Vercel hosting** is a valid option later (a long-lived Node host + `pg` pool removes cold starts and per-invocation cost entirely, and can be placed in-region with the DB), but it is an infrastructure decision with operational trade-offs, not an Arena fix.

---

## 7. Infrastructure improvement plan (Vercel · Neon · caching · network · hosting · scaling)

**Phase 0 — verify (30 minutes, no code):**
1. Vercel → Runtime Logs: read the `[db] pool created` line; record host, region, `max=`.
2. Compare with `vercel.json` `regions: ["fra1"]`. **Match them.**
3. Confirm `DATABASE_URL` uses the `-pooler` host; note the direct URL for migrations.
4. Enable Fluid Compute; enable Speed Insights.
5. Open `/api/health` in production (it returns `{ ok: true }` / a precise configuration message) and the Neon dashboard's connection + latency graphs.

**Phase 1 — Arena code (P0/P1 above):** cap/split `/api/init`; batch+scope `/api/audit`; limit ledger reads; lazy charts; ETag/private caching; branding as images; FX off the boot path; consolidate boot calls.

**Phase 2 — platform tuning:**
- Neon: paid plan if needed for always-on compute; raise compute size if the audit/module scans dominate; watch `default_pool_size` vs concurrency.
- Vercel: `maxDuration` per heavy route; consider Pro for concurrency/observability if the Hobby plan's invocation pattern starts rate-limiting (per-user 30 s polling × users).
- Add composite indexes (§5 #12) as a migration; schedule `ANALYZE`/autovacuum defaults are fine at this size, revisit at 10⁵+ rows/table.

**Phase 3 — scale-out (only when the numbers demand it):**
- Read replicas / materialised summary tables for dashboards (the "Real-time Aggregation" pattern) instead of recomputing from raw rows.
- Range-partition the log/transaction tables by month once they pass millions of rows.
- If per-user polling grows (SSE/WebSocket notifications), move presence/notifications to a long-lived channel; keep the bell's 30 s poll as fallback.
- If invocation cost or cold starts dominate, move the DB access layer to a long-lived host or use Neon's serverless driver over HTTP for single-statement routes.

---

## 8. What "fixed" should look like (acceptance targets)

| Metric | Today (measured) | Target after P0/P1 |
|---|---|---|
| `/api/init` wire size (owner, 11 units) | 26.6 KB gzip (227 KB raw) | **< 8 KB gzip** |
| `/api/init` DB rows read | 4,755 | **< 1,500** |
| `/api/audit` DB round trips | 126 sequential | **≤ 3** |
| `/api/audit` server time on Neon (20 ms RTT) | ~2.6 s | **≤ 0.3 s** |
| Ledger/module routes round trips | 28–74 | **≤ 3** |
| Login-page JS (gzip) | 215 KB | **≤ 180 KB** |
| Post-login added JS (gzip) | 280 KB | **≤ 180 KB** |
| 4G+4×CPU login → dashboard | 1.2 s (localhost server) | **≤ 0.6 s** |
| Boot API calls / functions | 10 / 8 | **≤ 4 / 2** |
| Reload of an unchanged screen | full download | **304 / cache hit** |

---

## 9. Reproducing and re-verifying

```bash
# 1. Server + wire cost of the main pages/APIs (no dependencies)
node dev-tooling/perf-probe.mjs            # requires the app on :3000 and a seeded DB

# 2. Static census of DB round trips per route (the "why is production slow" number)
node dev-tooling/perf-db-audit.mjs

# 3. Browser boot cost incl. 4G + CPU throttling (needs puppeteer-core + a chromium path)
CHROME=/path/to/chromium node dev-tooling/perf-boot.mjs   # defaults to /tmp/al2023/chromium
```

Notes:
- Local absolute times exclude network and cold starts — always convert with `round trips × RTT` for a production estimate.
- `X-Init-Cache: hit|miss` on `/api/init` shows whether the in-process cache is doing anything on a given host.
- When comparing before/after, keep the same seed data; the payload is a function of data volume by design (see §4).

---

## Appendix A — measurement dump (2026-10-06, local production build)

**Pages (signed out)** — `/` 8.2 KB / 5 ms · `/order` 8 KB / 4 ms · `/track` 7.8 KB / 3 ms · `/join` 10.9 KB / 3 ms; `/` `x-nextjs-prerender: 1`, `s-maxage=60, stale-while-revalidate=31535940`, TTFB 1.5–4 ms.

**APIs** — `/api/init` owner 227.5 KB raw / 26.6 KB gzip / 7–36 ms / 4,755 rows / 1 round trip / `no-store`; BM 69.9 KB / 10.2 KB. `/api/audit` 75.1 KB / 43–66 ms / **126 round trips** / no gzip locally / global scan. `/api/branding` 90.0 KB (base64, 7-day private cache). `/api/transactions` 19.4 KB for 40 rows with **no LIMIT** (whole ledger). `/api/businesses/[id]` 72.7 KB / 99 ms / 42 round trips. `/api/payroll` 10.3 KB / 35 ms / 30. `/api/users` 15.5 KB uncompressed. `/api/menu` 24.0 KB raw / 4.1 KB gzip. `/api/notifications` 1.7 KB. `/api/attendance` 2.0 KB. `/api/sales-documents` 1.0 KB. `/api/currency/rates` 0.2 KB (external fetch, 6 h in-process cache). `/api/audit?meta=1` 0.1 KB.

**Client** — boot = 10 API calls over 8 functions, 39 requests overall; JS 499 KB transferred (27 chunks) for login+dashboard: 215 KB gzip for the login page (10 chunks) + 280 KB gzip added after sign-in (18 chunks, incl. `recharts` 116 KB gzip). 4G+4×CPU: 2.85 s to login, 1.2 s login → dashboard.

**Environment** — `next start` (production build), PostgreSQL local, owner `kwame.owner@gomina360.com` (11 units, super-admin) and BM `emmanuel@gomina360.com` (POULTRY-01). Demo data: 18 users, 11 businesses, 40 transactions, 17 inventory items, 192 checklist templates, 88 checklist entries, 4 audit_trail rows.

## Appendix B — raw evidence locations

| Artefact | Path |
|---|---|
| Server + wire probe (re-runnable) | `dev-tooling/perf-probe.mjs` |
| DB round-trip census (re-runnable) | `dev-tooling/perf-db-audit.mjs` |
| Round-trip batching pattern to copy | `src/lib/initSnapshot.ts` (28 statements, 1 round trip) |
| Batch helpers already in place | `src/lib/httpGzip.ts`, `src/lib/ttlCache.ts` |
| Unbounded reads to cap | `src/lib/initSnapshot.ts:103`, `src/app/api/transactions/route.ts:46,60`, `src/app/api/audit/route.ts` |
| Boot fan-out | `src/components/GoMinaApp.tsx` (init/branding/heartbeat), `NotificationBell.tsx` (30 s poll) |
| Platform config | `vercel.json` (`regions: ["fra1"]`, cron), `src/db/index.ts` (pool, `-pooler` detection) |
