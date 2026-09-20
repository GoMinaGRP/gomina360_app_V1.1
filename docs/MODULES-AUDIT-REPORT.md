# Module Audit Report — Poultry Farm, Aquaculture & Block Factory

**Date:** 2026-09-19 · **Branch:** `arena/01a0a375-gomina360-app-v1-1` · **Scope:** dashboards, data entry, calculations, production, Feed Mill / Mixing, inventory, finance, QC, reports, audit trail, notifications, permissions, integrations, desktop & mobile UI.

**Verdict:** 22 findings processed — 16 code fixes shipped, 6 documented design decisions. Full regression battery green: **11 suites · 530 checks · 0 failures**.

---

## 1. Findings & fixes

### 1.1 Poultry Farm — `src/app/api/poultry/route.ts`

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| P1 | **HIGH (tenant security)** | `GET /api/poultry` with no `businessId` returned **every tenant's** flocks, feed logs, health records, production and checklists; with one it skipped the access gate entirely. | `businessId` now required (400) and `canAccessBusiness` enforced (403) before any data leaves — same contract as block-factory/aquaculture GET. |
| P2 | **HIGH (tenant security)** | `PATCH FLOCK` and `PATCH CHECKLIST` had **zero business-access checks** — any authenticated user could rewrite any farm's flock head-count/status or toggle any checklist. | Both handlers resolve the row first, 404 if unknown, 403 via `canAccessBusiness(row.businessId)`. FLOCK PATCH also validates non-negative counts and writes an audit row (`POULTRY_FLOCK_UPDATE` with before→after detail). |
| P3 | **HIGH (inventory calc)** | Egg stock-in precedence bug: `Number(data.traysProduced) \|\| eggs > 0 ? … : 0` parses as `(a \|\| b) ? x : 0`, so an **explicit tray count was silently discarded** whenever cracked eggs were logged; stock was always keyed off computed goodEggs/30. | Explicit `traysProduced` wins; otherwise derived from good eggs. Stored row's auto default also corrected to exclude cracked eggs (was `eggs/30` incl. cracked, stock credited goodEggs/30 — a permanent row-vs-stock mismatch). |
| P4 | Medium (finance) | All auto transactions (feed-purchase expense, health expense, egg/broiler sale income) booked on **today** instead of the entry's `recordedDate` — back-dated entries landed on the wrong ledger day. | All four inserts now use `data.recordedDate \|\| today` (aquaculture already did for feed). |
| P5 | Medium (tenant integrity) | HEALTH mortality deducted `currentCount` from a flock resolved with **no business filter** — a crafted call could drain another tenant's flock. | Flock resolved with `and(eq(id), eq(businessId))`; foreign flock → 404 before mutation. Feed `flockId` gets the same ownership validation. |
| P6 | Medium (data entry) | Zero/negative quantities accepted everywhere: flocks with 0 birds set up, feed logs with 0/−3 kg, negative mortality, negative costs. | 400-class validations on FLOCK (`initialCount > 0`), FEED (`quantityKg > 0`, costs ≥ 0), HEALTH (counts/costs ≥ 0), PRODUCTION (counts/revenue ≥ 0, `eggsSold ≤ eggsCollected`, `crackedEggs ≤ eggsCollected`). |
| P7 | Low (records) | Checklist regeneration duplicated the day's tasks on every click. | Daily idempotence (`alreadyExists: true` + existing rows returned) — the contract Block Factory already used. |
| P8 | Low (audit) | Core lifecycle writes left no audit trail (only the feed mill did). | `auditLog` on flock create/update and feed purchases; actor/org resolved from the session (never request body). |

### 1.2 Aquaculture — `src/app/api/aquaculture/route.ts`

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| A1 | **HIGH (tenant integrity)** | WATER and HARVEST hardcoded `pondId: Number(data.pondId) \|\| 1` — an omitted pond silently wrote samples/harvests against **pond id 1**, which lives in a different business: cross-tenant contamination by default. | WATER stores `NULL` (column nullable) or a business-validated pond; HARVEST requires an explicit valid pond (column NOT NULL) — 400 with a clear message. The HARVEST form's pond picker is now marked required with an inline hint. |
| A2 | **HIGH (production calc)** | Every HARVEST unconditionally set the batch `status=HARVESTED, currentCount=0` — **partial harvests** (the norm for tilapia cropping) destroyed live batch accounting. | Harvest subtracts only the cropped amount; batch closes to `HARVESTED` solely when the remaining count reaches 0. Batch-resolution is business-scoped (was unscoped), foreign batch → 404. |
| A3 | Medium (analytics integrity) | WATER defaults fabricated measurements: blank pH became 7.0, blank DO 6.0 — silently poisoning water-quality analytics and OK/alert thresholds. | pH and DO are required inputs (validated 0–14 / 0–30 mg/L) — the UI form already required them, now the API refuses to invent them. |
| A4 | Medium (data entry) | Same validation family as poultry: negative pond capacity/biomass, 0-fish batch stocking, 0/−kg feed logs, negative costs, 0-fish harvests. | 400 validations on POND, BATCH (incl. pond ownership), FEED (incl. pond/batch ownership), HARVEST. |
| A5 | Low (records) | Checklist regeneration duplicated the fixed 6-task daily list per click. | Same `alreadyExists` daily idempotence as Block Factory. |
| A6 | Low (audit) | No audit trail on pond creation, batch stocking, feed purchases, harvests. | `auditLog` on all four (`AQUA_POND_CREATE`, `AQUA_BATCH_STOCKED`, `AQUA_FEED_PURCHASE`, `AQUA_HARVEST` with counts/kg/revenue/stock detail). |
| A7 | Low (dead code) | `aquacultureAnalytics.ts` had an unreachable duplicate `else if` DO-warning branch and a typo'd field (`dissolvedOxygenMgrL`). | Dead branch removed; DO value formatted `toFixed(1)`. |

### 1.3 Feed Mill demo console — `public/demo/index.html`

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| D1 | Medium (demo feature broken) | CP-target **solver produced nonsense**: protein-balance formula missed ×100 scaling, so the slider always clamped soya to 0% and reported "CP 9.23%" regardless of target — including on the seeded default solve. | Equation scaled correctly (`soya = (target·100 − cpB·5 − cpM·95)/(cpS − cpM)`); target 18% → 23.6% soya, 20% → 29.0%, both achieving the target CP. |
| D2 | Medium (probe wrong + demo inconsistency) | Probe battery shipped 13 probes but the header suite expected 12; two probes collided on the label "P4"; the threshold probe used draw-math that could mathematically never fire the three alert levels (120 kg started **below** the <50 % line; draw(60) skipped <20 % straight into stock-out) — and its detail string hardcoded "✓" marks regardless of actual results. | Probes renumbered P1–P13; threshold probe re-seeds a 300/500 kg bin and draws 100/120/90 to cross each threshold exactly once; detail strings built from real booleans. Suite expectation updated to 13. |
| D3 | Low (probe fragility) | P10 cost-edit probe edited `ledger[0]` inside the last-6 window, but the S2 probes push the released batch into the savings ledger first → the edited row fell out of window, giving savings delta 0.00. Reset button zeroed the probe counter instead of restoring green. | P10 scopes "All" before its before/after read; Reset now re-runs the full probe battery (byte-identical seeds + 13 green probes). |

### 1.4 Test harness hardening (suites themselves)

| # | Finding | Fix |
|---|---------|-----|
| T1 | `verify-block-qc` assumed an exclusive business: demo-seeded QC rows shifted its absolute KPI assertions (pass-rate 66.7 %, chip counts) red. | Delta-parametrized: baseline aggregate read at suite start; assertions computed as baseline + suite-planted (same rounding as `computeBlockQc`). Chip text parsed via `innerText` per-line (textContent glues `12` + `8 pass` → unparseable `128 pass`). |
| T2 | `verify-fish-feed-mill` E4 demanded an absolute-zero QC-FAIL bell count; demo data legitimately holds such bells. | Asserts a **new** HIGH-priority bell appears after the FAIL (max-id delta), independent of pre-existing rows. |
| T3 | `verify-block-mixing`'s `blkPatch` helper never passed `businessId` in PATCH data (the API contract requires it), cascading 8 failures (B9→B12→D5/D6/D9→G3: BOM never updated, so draws/costs were computed for the patched BOM while the server drew the original 80/15/5 mix). A4 assumed a mixing tab with zero recipes (conflicts with permanent demo recipe). | Suite PATCH now mirrors the real contract (`{ businessId: BIZ, …data }` inside the helper — one place). A4 re-scoped to recipes-panel render integrity (empty-state path is unchanged and still renders on demo-free/reset units). |
| T4 | No regression coverage existed for the findings in §1.1–§1.2. | New suite **`dev-tooling/verify-audit-fixes.mjs`** — 51 API-level checks (tenant matrices incl. 401/400/403/404, validation families, EGGS trays math, ledger dates, partial harvest, phantom-pond, checklist idempotence, audit-trail writes) with idempotent TEST-AUD purge + byte-exact inventory restoration. |

### 1.5 Documented design decisions (no change)

- **Write permissions:** routine data-entry writes require *business access*, not OWNER — matching the established project standard (only sensitive transitions are OWNER/`canManageRecords`-gated: QC overrides, mix rejections, recipe deactivation). No change; verified intact by the gates inside `verify-audit-fixes` (B-series) and `verify-block-mixing` (G-series).
- **Notifications for core farm entries:** not added — the analytics alert engines (`poultryAnalytics`, `aquacultureAnalytics`) already raise low-DO/pH/mortality/lay-rate alerts on read; duplicating them as server bells would double-notify. Mill/QC FAIL bells verified working (E4-type checks in both mill suites).
- **`kW` UI surfaces:** none of the fixes alter visible layout — the HARVEST pond picker gaining a required mark is the only UI delta.

---

## 2. Test results — full regression battery (sequential run)

| Suite | Checks | Result |
|-------|-------:|--------|
| `verify-audit-fixes` (new) | 51 | ✅ 51/51 |
| `verify-feed-mill` (poultry mill E2E) | 100 | ✅ 100/100 |
| `verify-block-qc` | 51 | ✅ 51/51 |
| `verify-poultry-analytics` | 32 | ✅ 32/32 |
| `verify-fish-analytics` | 32 | ✅ 32/32 |
| `verify-feed-mill-demo` (demo console battery) | 13 | ✅ 13/13 |
| `verify-fish-feed-mill` | 85 | ✅ 85/85 |
| `verify-block-mixing` | 75 | ✅ 75/75 |
| `verify-responsive` (mobile/desktop UI) | 29 | ✅ 29/29 |
| `audit-security` | 23 | ✅ 23/23 |
| `audit-atoz` (records↔report integrity) | 39 | ✅ 39/39 |
| **Total** | **530** | **0 failures** |

Notes: suites run **sequentially** (shared forensics baselines), each plants its own `TEST`-marked rows and purges byte-exact; the new audit suite also restores inventory quantities after mixing/stock writes.

---

## 3. How to see it in action

Point the browser at the live preview (server on :3000). Log in as **owner** `kwame.owner@gomina360.com` / `Owner@GoMina26`, pick a business:

- **Poultry Farm** (`Mina Akuafo Poultry Farm`) — tabs: Dashboard · Flocks · Feed · **Feed Mill** · Water · Health · Production · Inventory · Finance · Checklist · AI Knowledge. Try: *Production → Log Production → EGGS* with 330 collected / 30 cracked / trays left on *Auto* → stocks exactly 10 crates (cracked excluded) and books any revenue on your chosen record date.
- **Aquaculture** (`Mina Volta Tilapia & Catfish`) — tabs: Dashboard · Stock · Ponds · Feed · **Feed Mill** · Water · Health · Harvest · Finance. Try: *Harvest* a stocked batch twice (e.g. 400 then the rest) — the batch stays GROWING on the partial crop and only flips HARVESTED when the pond is emptied; pond is a required field now.
- **Block Factory** (`Mina Concrete & Blocks`) — tabs; **Mixing** (recipes/runs) and **QC Centre** both carry live demo walkthrough data.

### Demo data (permanent, clearly marked `DEMO ·`)
- 2 poultry feed formulations + batches incl. one full QC-pass release and one moisture-FAIL hold (`verify-feed-mill-demo` plants its probe rows live).
- 2 fish formulations + 2 batches — one released through the aquatic 5-stage gate (96 % float test), one held on a floating-FAIL.
- 1 block mix recipe (`DEMO · Lab 8in Sandcrete 1:9`), a released mix run and a QC_HOLD mix batch with a FAIL.

### Cleanup
Delete the DEMO rows from the UI (formulations/batches are deletable by owner), or re-run `dev-tooling/seed-feed-mill-demo.mjs` / `seed-fish-mixing-demo.mjs` (idempotent — they skip when DEMO rows exist).

### Audit trail verification
*Audit Center → Operations log*: filter actions `POULTRY_*` / `AQUA_*` / `BLOCK_MIX_*` to see lifecycle entries with actor, business and before→after detail.

---

## 4. Delivery status

- All fixes committed on `arena/01a0a375-gomina360-app-v1-1` (latest `d010ccb` … plus demo/test-harness commits `96dbec9`).
- ⚠️ **Push blocked:** the sandbox GitHub token expired mid-session (`gh` API: *Bad credentials*). Everything through `64c9d1f` is on origin; `96dbec9` + `d010ccb` are committed locally and will push as soon as GitHub is reconnected in Arena (`git push origin arena/01a0a375-gomina360-app-v1-1` is the only step needed — please reconnect GitHub in Arena).
