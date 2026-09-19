# GoMina 360 — Complete Performance Audit & Optimization Report
**Date:** 2026-09-17 · **Branch:** `arena/01a0a375-gomina360-app-v1-1` · **Commit:** `a25ca39`
**Scope:** frontend rendering, APIs, DB queries/indexes, dashboards, auth/session, images/files, caching, data loading, notifications, maps/GPS, AI features, mobile.

---

## 1. Measured results (before → after)

All numbers measured against the same embedded Postgres (same seed data), warm dev-server
routes, medians of repeated calls:

| Endpoint / flow | Before | After | Δ |
|---|---|---|---|
| `GET /api/init` (dashboard bootstrap) payload | **239.6 KB** | **209.9 KB** | **−12.4 %** |
| — inventory section inside init | 45.6 KB (photos[] arrays included) | 15.9 KB | **−65 %** |
| `GET /api/init` warm latency (uncached) | 45–77 ms | **12–15 ms** | **~4× faster** |
| `GET /api/init` repeat inside 2.5 s (cache hit) | n/a (always full recompute) | **10–13 ms** | new fast path |
| `GET /api/menu` warm (server TTL hit) | ~3.5 ms, 47.4 KB re-sent to browser | ~6 ms, **304 / 0 bytes** on unconditional repeat | payload → 0 |
| `GET /api/menu` browser cache headers | `Cache-Control: no-store` | `public, max-age=5, stale-while-revalidate=30` + ETag | revalidation now possible |
| Session resolution (every authed API call) | 2–3 queries incl. unindexed `user_sessions.token_hash` lookup | **indexed** token_hash + membership (1 ms class) | full-index scan removed |
| `POST /api/auth/login` warm | 52–91 ms | ~52 ms | unchanged by design (scrypt) |
| Storefront re-render on form typing | **entire product grid re-renders each keystroke** | **0 cards re-render** (memoized; only affected card re-renders on its own qty change) | eliminated |
| Notification bell polling | 1 request / 20 s **even in hidden tabs** | **0 requests while hidden**, 30 s while visible + instant refresh on return | background load → 0 |

> Dev-server compile noise aside, the durable wins are: byte-weight reduction (photos never
> leave the server on bootstrap), full-index coverage on tenant auth/board paths, zero-byte
> catalog revalidation, and render-isolation on the store grid.

## 2. What was changed

### Database (additive indexes only, mirrored in drizzle schema)
`dev-tooling/migrate-perf-indexes.mjs` (idempotent) + `src/db/schema.ts`:
- `user_sessions_token_hash_idx` — **the most-hit query in the system** (session guard on every
  API call) had no index on `token_hash`.
- `customer_trackings_business_id_idx` — per-branch order boards.
- `fulfillment_options_inventory_id_idx` — menu pre-order join.
- `service_areas_business_id_active_idx`, `pickup_locations_business_id_active_idx` — storefront
  service gates.
- `inventory_items_business_id_idx` — the hot tenant-scope column (was only covered via
  composite uniques).

### `/api/init` (dashboard + every module's data load)
- `photos[]` byte arrays **no longer leave the server** — each inventory row ships its single
  `photo` (what the UI renders) plus `photoCount` (what the UI displays in the "N photos" tooltip;
  `SharedEnterpriseModule` tooltip falls back `photoCount ?? photos.length`).
- `seedDatabase()` "empty DB" check now runs **once per process** instead of on every request
  (it was a SELECT + advisory-lock candidate before even the auth gate).
- **2.5 s per-viewer snapshot cache:** key = hash of freshly-resolved `user id + role + orgs +
  accessible business ids`. Session resolution always runs first; a role/scope change instantly
  changes the key (no stale-tenant risk window). Any catalog/business/org/inventory/order
  mutation also calls `ttlInvalidate("init")` (piggybacked on the existing menu invalidation
  sites), so stale views last ≤ 2.5 s at worst.
- `X-Init-Cache: hit|miss` header for observability (asserted in perf gates).

### `/api/menu` (public storefront catalog)
- Server TTL cache entry now stores the **serialized body + ETag** (sha1 of body).
- Conditional `If-None-Match` requests return **304 with 0 bytes** (catalog revalidation is now
  free). `Cache-Control: public, max-age=5, stale-while-revalidate=30` lets browsers/CDNs serve
  instant loads while staying seconds-fresh; **checkout revalidates stock server-side on every
  order**, so this can never oversell.
- `X-Menu-Cache` semantics preserved for probes; menu shape unchanged (photos kept — needed by
  the detail lightbox).

### Storefront rendering (`src/app/order/page.tsx`)
- The 230-line product-card JSX is now a module-level **`ProductCard` wrapped in `React.memo`**
  with a field-wise comparator (`p`/`fromBiz`/`wmBiz` identity + `stockQty` + per-option depths).
- `add`/`setQty` became **identity-stable `useCallback([])`** reading live state via refs
  (`cartRef`, `bizRef`, `bizIdRef`) — memo is real, not cosmetic. Typing name/phone/address,
  cart-badge updates, pin drags, tab toggles… none of them re-render the grid anymore; only the
  card whose own quantity changed re-renders.
- Pure helpers (`productPhotos`, `wmSpecOf`) lifted to module scope.
- Full cart semantics preserved (cross-shop switch confirm, clamping, pre-order option lines),
  verified end-to-end with real orders placed by the probe suite.

### Notifications (`src/components/NotificationBell.tsx`)
- Polling is now **visibility-aware**: no interval while `document.hidden`; on `visibilitychange`
  to visible it fetches immediately and resumes a 30 s cadence (was: unconditional 20 s interval
  even when the tab was backgrounded — a constant fleet-wide server load with zero user value).

### Verified, deliberately untouched
- **Maps/GPS:** `LeafletPinMap`/`MiniLeafletMap`/`TerritoryMap` were already `next/dynamic`
  lazy-loaded; the order page renders map blocks once per business; map suites (26/26) and
  geocode (114+35) all green — no change needed. Reverse-geocode debounce (400 ms) retained.
- **AI features:** insights/scenario endpoints are event-driven (computed on data change), not
  polled; dashboard reads them through `/api/init` (now cached) — no extra cost added.
- **Dashboards/modules:** client already dedupes concurrent `/api/init` calls in flight;
  combined with the server snapshot cache, slow-network dashboard/flash-of-content is now ~10 ms
  class for repeat loads.

### Probe/verification infrastructure upgraded
- `dev-tooling/perf-verify.mjs` — extended **13 → 20 gates**: hot-path index presence, menu
  Cache-Control/ETag/304 contract, init photos-slimming + photoCount, init snapshot-cache hit.
  The previously failing gate ("menu cache: first call miss") is now green.
- `dev-tooling/checkout-product-details.mjs` — boot diagnostics on grid-absence (screenshot +
  DOM dump) to make cold-compile flakes self-explanatory.
- `dev-tooling/watermarks-audit.mjs` — org-2 NAME-mode target repointed to the restored fixture
  business; render-wait + menu-scope diagnostics added.

## 3. Regression evidence (all run after the changes)

| Suite | Result |
|---|---|
| perf-verify (latency + scoping + cache + index gates) | **20/20** |
| order-audit (storefront E2E: catalog, cart, geo, maps, checkout) | **51/51** |
| checkout-product-details (desktop+mobile, real orders: GM-POULTRY-BBE3MR, GM-POULTRY-TG4DAP) | **38/38** |
| inventory-details-ui (stock-in → storefront details round-trip) | **10/10** |
| geocode-audit / geocode-ui | **114/114 · 35/35** |
| google-maps-probe | **26/26** |
| watermarks-ui / watermarks-audit | **11/11 · 21/21** |
| audit-notify-verify | 102/104 — **2 failures are pre-existing fixture decay** (notification-content assertions tied to audit fixtures lost in the last full DB reseed; the relevant plumbing commit `f047760` predates this task and no code touched `/api/audit*` or notification bodies) |

Zero console errors in all suites. Tenant isolation, scoped-payload SQL↔JS parity, auth-gating
and INACTIVE-marketplace exclusion gates all green (they are part of perf-verify).

## 4. Remaining limitations (explicit)

1. **Product photos are still base64 inside JSON.** The menu still ships full photos inline
   (needed by the gallery/lightbox), and init ships one `photo` per row. In this environment
   photos are ~1.3 KB SVG fixtures; **in a real deployment with 200 KB–2 MB JPEGs, menu payload
   will be large** — the ETag/304 + max-age caching mitigates repeat loads, but the structural
   fix is a thumbnail/derivative pipeline (resize at upload, serve from object storage/CDN) —
   **not implemented here** (would be a storage-architecture change).
2. **No payload pagination.** `/api/init` still returns whole scoped tables (users, checklists,
   transactions…). It is fast at this scale (12 inventory rows, ~210 KB), but at thousands of
   rows per tenant the right fix is cursor pagination + per-module lazy fetching. Deliberately
   not changed in this pass (API-shape change, no removal allowed).
3. **Company logo (~52 KB data URL) still ships in init** — same derivative-pipeline answer.
4. **TTL caches are per-process in-memory.** Correct for the single-node dev/embedded setup; on a
   multi-instance deployment each node invalidates only its own cache (staleness bound = TTL:
   10 s menu / 2.5 s init). A shared invalidation bus (Redis) is future work, not introduced here.
5. **Session cache was evaluated and NOT shipped.** Snapshot caching of `getSessionInfo` was
   planned but rejected after the token-hash index landed: post-index resolution is ~1 ms, and
   even a 1.5 s cache trades immediate revocation/deactivation semantics for no measurable gain.
6. **Login is scrypt-bound (~50 ms)** — intentional security cost; not optimizable without
   weakening password hashing.
7. **Dev-server numbers ≠ production.** All timings measured on `next dev` (webpack, compiling
   on demand); production builds (`next start`) are typically several× faster; relative
   before/after deltas carry over, absolute numbers won't.
8. **Pre-existing suite gaps (not caused by this task):** audit-notify-verify 2/104 content
   failures (fixture decay, see §3) remain open; `oo-prod-1` first-hit timeouts observed twice
   were dev-server cold-compile races (probe now prints diagnostics; never reproduced warm).
9. **Virtualization not applied.** The all-businesses grid still renders all cards in the DOM
   (now cheap because memoized); at >500 products react-window class virtualization should be
   considered.
10. **DB connection pooling limits** (embedded PG, single instance) were decent at this load;
    no pooling change made. High-concurrency production should set an explicit pool max.

## 5. Tenancy / security / integrity statement
- No features were removed; all changes are additive or transport-layer.
- Session auth runs **fresh on every request** including cache hits; snapshot cache keys embed
  the freshly computed org/role/business scope, so cached bytes can never cross tenants.
- Mutations invalidate both `menu` and `init` prefixes; TTL bounds worst-case staleness to 2.5 s.
- Indexes, headers, memoization and visibility polling change nothing about data integrity —
  confirmed by the full isolation-scoping + E2E suites (§3).
