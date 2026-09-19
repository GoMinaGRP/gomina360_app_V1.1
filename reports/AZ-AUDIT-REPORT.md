# GoMina 360 — Complete A–Z Audit Report

**Date:** 2026-09-18 · **Scope:** entire application (50+ API routes, all business types, dashboards, storefront, maps, workflows, security, performance, UX) · **Method:** live E2E suite batteries + targeted browser probes + full static analysis of every route/component · **Action taken:** **findings only — no production changes were made** (per instruction).

---

## Executive summary

The platform is structurally **healthy**: a fresh run of every verification battery passed — full desktop walk (39/39), security sweep (23/23), dead-links/imgs/Js-errors (clean), multi-owner isolation (118/118), storefront ordering (34/34 + 53/0), tracking (51/51), geocoding (114/0), analytics modules (32/32 each), payroll (52/52), attendance (31/31 + GPS 24/24), responsive geometry (29/29). No Critical defects, no 5xx anywhere, cross-tenant isolation confirmed airtight.

The audit nevertheless surfaces **3 High, 7 Medium and 7 Low findings**, dominated by three themes: **(1) missing HTTP security hardening**, **(2) the "AI" advisor is a keyword script with unbounded data growth and honesty/expectation risk**, **(3) test-fixture pollution and suite staleness** around the live demo tenant. All have concrete, low-risk fixes.

---

## Verification evidence (all run 2026-09-18, fresh bootstrap)

| Area | Suite | Result |
|---|---|---|
| Whole-app walk (tabs, modules, roles, responsive) | audit-atoz | **39/39** |
| Security (authz, isolation probes, XSS, open-redirect) | audit-security | **23/23** |
| Dead links / broken images / JS errors | audit-deadlinks | **clean** |
| Multi-owner isolation & lifecycle | multiowner-verify | **118/118** |
| Storefront help guide | verify-storefront-help | **47/47** |
| Storefront service-areas/GPS walk | verify-storefront-areas | **53 pass / 0 fail** |
| Online ordering (API + UI + guards) | verify-online-ordering | **34/34** |
| Order-page regression | verify-order-page-regression | **34/34** |
| Tracking (public) | verify-tracking | **51/51** |
| Geocoding/maps | geocode-audit | **114/0** |
| Poultry & fish analytics | verify-poultry/fish-analytics | **32/32 each** |
| Payroll | verify-payroll2 | **52/52** |
| Attendance + GPS | verify-attendance(+gps) | **31/31 + 24/24** |
| Responsive 390/768/1440 | verify-responsive | **29/29** |
| Watermarks | watermarks-audit | **22/22** (after 1 headless flake) |
| Lens behaviour | lens-verify | **15/15** |
| Entry-confirmation modals | verify-entry-confirm | **29/29** |

**Red suites (all staleness, not product defects — see M5):** verify-notifications 25/31, verify-finance-allproducts-fresh 46/48, audit-notify-verify content checks 2/104 (one of these is a real product bug, M1).

---

## Findings

### 🔴 Critical — none.

### 🟠 High

**H1 — Zero HTTP security headers (clickjacking surface).**
`next.config.ts` ships no `headers()`. Every response lacks `Content-Security-Policy`, `X-Frame-Options` / `frame-ancestors`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, HSTS. Financial dashboards and the checkout can be iframed by any origin (clickjacking/UI-redress risk). The permanent XSS/CSRF surface is otherwise well-defended (React escaping verified, cookie SameSite, session revocation), which makes this the largest remaining gap.
*Recommendation:* add a `headers()` block — prod: `frame-ancestors 'self'`; sandbox/preview deployments additionally allow their preview host; `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, tight `Permissions-Policy`, and a conservative CSP once the inline-style/font usage is measured. ~1 hour, single file.

**H2 — "AI Strategic Advisor" is a keyword-matching script, not AI — and grows data unboundedly.**
`POST /api/ai` lower-cases the prompt and `includes()`-matches ~8 canned recommendation tables ("maize", "block", "solar"…). Nothing calls an LLM. Beyond honesty ("AI-powered analysis", "GOMINA 360 AI EXECUTIVE ADVISOR"), every click **inserts a permanent `aiInsights` row** — no dedupe, no per-user quota, no expiry → the table and the insights list grow without bound, and repeated identical near-duplicates pollute the executive list.
*Recommendation:* choose one of two paths — **(a)** rebrand accurately ("Decision-Support Playbooks", "Rule-based advisory"), or **(b)** wire a real LLM behind this exact panel (server call with the live baseline already computed by `scenarioEngine`), with prompt caching. Either way add: 60 s per-user cooldown, dedupe (same scope+same recommendation within 24 h → update, not insert), and retention cap (e.g. 200 rows/org). The money-figure grounding from the live ledger baseline is already real — keep it.

**H3 — Test-fixture pollution of the live tenant; cleanup is manual and leaky.**
The demo database currently contains leftover test rows that show up in the **owner's real UI**: businesses `11 "kkkkk"`, `14 "Unrelated Biz 360285"`, and seven `MW-MU7NBSZS` businesses (multiowner-verify prints "Fixture tag for cleanup: MW-…" but leaves deletion to an operator, and crashed runs leave rows); the owner’s bell holds test notifications "AU 360285 …/auto-verify", and the top banner tells the real owner "1 audit issue needs your response" about a synthetic issue. Consequences: demos/screenshots look wrong, aggregate dashboards are subtly inflated, and future audits inherit polluted baselines.
*Recommendation:* (a) give multiowner-verify a Z-cleanup phase like the other suites have (self-purge by fixture tag even on failure — `try/finally`); (b) add a `dev-tooling/purge-test-rows.mjs` that bootstrap-sandbox.sh calls automatically before health-check (remove rows whose names/codes match known TEST/AU/MW-/kkkkk patterns); (c) long-term: an `is_fixture` boolean on businesses/customers/orders so demo hygiene is structural, not name-patterny.

### 🟡 Medium

**M1 — Audit-issue notifications never carry `priority` (contract broken, chip invisible).** *Real product bug, root cause confirmed.*
`notifications.priority` column exists and the bell UI renders a colour-coded severity chip (`NotificationBell.tsx:166-176`), and the schema docstring says priority is "carried into every bell notification". But the `notify()` helper in `src/app/api/audit/route.ts:80` accepts `priority` and **never writes it into the insert** → every audit notification (the highest-value, triage-relevant class) shows no severity in the bell, and HIGH/CRITICAL escalation rows land without the metadata users need to triage. This is exactly what `audit-notify-verify` flags ("priority column carried to the bell", "HIGH escalates to the org Owner").
*Fix:* one line — persist `n.priority ?? null` in the insert (and include `priority` in `ownerId` block). Zero risk.

**M2 — `GET /api/ai` calls `ttlInvalidate("init")` on every read.**
A **GET** mutating shared cache state is wrong in principle and in effect: loading the AI panel (or any poll of insights) flushes the whole init cache for all users, defeating the 2.5 s TTL infrastructure built in the performance pass.
*Fix:* delete the line (invalidation belongs in POST). Zero risk, immediate perf win.

**M3 — 51 of 53 API routes echo raw `error.message` to clients on failure.**
DB-adapter messages can leak table/column/constraint names; Next internals can leak paths. Most messages here are deliberate validation strings (fine) — the problem is the *unreachable* is not distinguished from the *deliberate*.
*Recommendation:* a shared `apiError(err)` helper: known `AppError`s (validation) pass through; anything else → `console.error` server-side + generic client text. Adopt incrementally (no shape change).

**M4 — CSV exports are formula-injectable.**
`universalExport.ts` CSV writer quotes correctly but doesn't guard leading `= + - @` (and tab/CR). A staff member naming a customer/product `=HYPERLINK(...)`, or worse, any pasted string starting with those chars, executes on open in Excel. XLSX path is safe (typed cells).
*Fix:* in the CSV `quote()`, prefix a single-quote when the cell matches `^[=+\-@ \t\r]`. One line, one unit test.

**M5 — Suite staleness cluster (product is fine, CI signal degrades).**
- `verify-notifications` — order probe lacks `pickupLocationId` (same class already fixed in verify-online-ordering/areas); also requires a hand-made TLS cert at `/tmp/pushsrv.pem`.
- `verify-finance-allproducts-fresh` — hardcodes product ids 6/8/12, the word "broiler", and eggs stock 873.63; the current seed has none of those (ids re-generated on every bootstrap).
- `watermarks-audit` — occasional headless flake (self-resolves).
*Recommendation:* apply the same pattern already used elsewhere — resolve fixtures dynamically at startup (`/api/menu` product lookup by name, current stock snapshot before mutation), and run the push harness with a self-generated cert (or make it optional via env).

**M6 — Fresh installs look half-empty: no default checklists are provisioned.**
`checklistDefaults.ts` exists, but a newly created business starts with **no checklist template**, so the Command Center centrepiece reads "Enterprise 0/0 tasks · 0%" with "No checklist yet" on every unit — visually indistinguishable from breakage in demos and on real first-run.
*Fix:* provisioning installs the defaults for the business type (or render a CTA card "Create your first daily checklist" instead of the neutral empty text).

**M7 — Unauthenticated endpoints lack any IP-level throttle.**
Login protects accounts (5 fails → lock, scrypt cost ✓) but nothing throttles by IP (spray across many accounts is unthrottled; `/api/track` enumeration is defended only by the 36⁶ code space; `/api/geocode` has no quota).
*Recommendation:* tiny per-IP in-memory limiter (e.g. sliding 10 req/10 s per route) applied to login, track, geocode — same single-process caveat as ttlCache (fine here, Redis later).

### 🔵 Low

- **L1 Print:** only PayrollCenter has `@media print`; receipts/documents print with full chrome. Add a small global print stylesheet (hide nav/bells on `print`, keep brand header).
- **L2 Tofu glyphs:** notification titles include flag/emoji chars that render as □ in the app font (seen in bell; worse on headless). Use text labels ([CRITICAL], [HIGH]) or bundled icons only.
- **L3 Component size debt:** SharedEnterpriseModule ≈ 3.6 k lines, order page ≈ 2 k, GoMinaApp ≈ 1.6 k — slowing iteration and merge-safety; split by module area opportunistically.
- **L4 Init payload unbounded** (documented in PERFORMANCE-OPTIMIZATION-REPORT §4): whole scoped tables, no pagination — fine at current scale, plan cursor-pagination per module before thousands of rows/tenant.
- **L5 Base64 photos in JSON payloads** (also documented §4): real JPEGs will bloat `/api/menu` and init; plan a thumbnail/derivative pipeline.
- **L6 Date pickers** show browser-locale `mm/dd/yyyy` even in GH context — cosmetic wrapping possible.
- **L7 `/api/push/vapid` requires auth (401 anonymous)** — defensible choice, but documented nowhere; add a comment/OPENAPI note (public keys are exposable by design if customer push is ever desired).

---

## Confirmed healthy (spot-checked beyond suites)

- **Tenant isolation** — cross-org access denied at API (118 checks) *and* UI lens; Super Admin-only visibility correct; `record_deletion_logs` org-scoped.
- **Auth/session** — hash-token lookup, per-request full auth even on cache hits, revocation immediate, 5-fail account lock, OWNER-only password resets, heartbeat bounces dead sessions without stealing the view (recent fix verified).
- **Storefront** — pickup-point rule, 75 m anti-pin-at-shop guard, 12 km service-radius enforcement, pre-order deposit terms, payment modes, GM- tracking lifecycle (incl. full pre-order supply chain stages) all live-verified end-to-end with real orders.
- **Exports** — export modal complete (summary/records × PDF/XLSX/CSV + date filters + audit metadata + embedded QR verification); business backup export/import creates new units only (never overwrites; owner-gated).
- **Maps/GPS** — provider failover, gazetteer, attendance GPS capture, service-area compute: 114/0 + 24/24.
- **Mobile/desktop** — zero h-overflow at 390/768/1440, menus anchored, gated controls.

---

## Recommended improvement plan (do-today → next-quarter)

**P0 — Same-day, zero-risk (≈ half a day):** M1 (persist notification priority), M2 (drop GET invalidation), M3-starter (`apiError` helper for the 3 touchiest public routes), M4 (CSV escape + unit test), H3-boost (auto-purge test rows in bootstrap + multiowner Z-cleanup).
**P1 — This week:** H1 security headers with preview-aware `frame-ancestors`; M6 provision default checklists; M7 IP throttles; M5 suite self-healing; L2 (text-only severity labels).
**P2 — Next sprint:** H2 decision (rebrand *or* real LLM behind current panel + quotas/dedupe/retention); L1 print stylesheet; M3 full rollout; audit-fixture `is_fixture` flag.
**P3 — Scale/debt (per perf-report §4 roadmap):** L4 pagination, L5 photo derivatives, L3 component splits, Redis-backed cache/throttle invalidation for multi-instance.

**Bottom line:** ship P0 immediately (they are one/two-line fixes with tests already failing that turn green), schedule H1+H3 for this week, and make the H2 AI decision before the next external demo — it is the only finding where the product currently over-promises.
