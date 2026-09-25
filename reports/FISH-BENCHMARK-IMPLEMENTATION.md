# Fish Farm Benchmark Performance — Implementation Report

**Date:** 2026-09-23
**Status:** Complete — 69/69 fish-benchmark checks, full regression battery green, fresh-bootstrap validated.
**Scope:** Adapt the Poultry Benchmark Performance system for aquaculture: fish growth (SGR), FCR, feed intake, survival/mortality, stocking, feed costs and production costs — current batches vs target benchmark profiles and vs the farm's own historical batches, with charts, trends, alerts, Feed Mill / finance / analytics integration, no duplication.

## 1. What was built

| Layer | File | What it does |
|---|---|---|
| Engine (pure) | `src/lib/fishBenchmarking.ts` (NEW, ~950 ln) | The aquatic mirror of `poultryBenchmarking.ts`: profile resolution (explicit pin → species → strain → default), age-matched per-batch actuals, comparable-history matching, KPI variance, weekly series with p25/p75 bands, A–D scorecard, harvest projection, alert generation, curve validation, species templates. No React, no DB — fully unit-testable. |
| Schema | `src/db/schema.ts` | `aquacultureBenchmarkProfiles` table (species + strain instead of birdType + breed; source MANUAL/TEMPLATE/FARM_HISTORY; status; isDefault; tolerance bands; jsonb curves; audit fields) + `aquacultureBatches.benchmarkProfileId` (explicit pin) and `.costPerFingerlingGhs` (stocking-cost basis). |
| API | `src/app/api/aquaculture/benchmarks/route.ts` (NEW) | GET profiles (with `usedByBatches`) + templates; POST (incl. `deriveFromBatchId` → FARM_HISTORY curves); PATCH; DELETE (409-blocked while batches pin). Mutations gated OWNER/GENERAL_MANAGER/canManageRecords; curves validated server-side; `AQUA_BENCHMARK_*` audit trail. |
| API | `src/app/api/aquaculture/route.ts` | GET now returns `benchmarkProfiles`; BATCH POST accepts `benchmarkProfileId` + `costPerFingerlingGhs` (business-scoped validation); new PATCH `BATCH` case (pin/unpin + fingerling cost, audited). |
| Dashboard panel | `src/components/FishBenchmarkPanel.tsx` (NEW) | `fib-*` testids: scorecard grade + headline tiles, KPI variance table with direction-aware chips (vs target + vs farm-history), **weekly trend chart with the farm-history band inside the panel** (actual + benchmark target + median + p25/p25), harvest close-out projection with editable live price, CSV scorecard export. |
| Manager drawer | `src/components/FishBenchmarkManager.tsx` (NEW) | `fibm-*` testids: profile list (default/star, archive, delete-with-confirm), curve grid editor with CSV paste, template picker (tilapia + catfish standards), derive-from-batch picker. |
| Module wiring | `src/components/AquacultureModule.tsx` | Panel mounted above Fish Growth Analytics on the DASHBOARD tab; benchmark alerts merge into the existing **AI Smart Alerts** grid (same alert surface, benchmark ids win); health score blends **85/15** with the batch scorecard compliance when a benchmark is active; batch form gains the benchmark-profile picker + cost/fingerling field. |
| Analytics overlay | `src/components/FishGrowthAnalytics.tsx` + `src/lib/fishPerformance.ts` | When a profile resolves for a batch, the growth charts' target line switches from the built-in species standard to the profile curve (via a `weightTargetG` callback — no circular import, no duplicated resolution logic). Fallback behaviour unchanged. |
| Demo seeder | `dev-tooling/seed-fish-benchmark-demo.mjs` (NEW) | 2 default profiles, 3 ponds, 4 batches through the real APIs: FB-DEMO-T01 (growing tilapia, behind target + overfed → grade D story), FB-DEMO-C01 (growing catfish, on target → grade A), FB-DEMO-T02/T03 (harvested cycles → history bands). Daily feed rows at template-implied rations, weekly weight samples, harvests (stock + INCOME side effects single-booked), water-quality rows. Idempotent. |
| Verify suite | `dev-tooling/verify-fish-benchmark.mjs` (NEW) | 69 checks: API lifecycle (A0–A14), engine math vs database (M0–M12), dashboard panel (U0–U17), growth-analytics overlay (G1–G5), manager drawer (D1–D14), purge + demo integrity (P1–P3), page errors (X0). Self-healing pre-cleanup. |

## 2. Metric set (as scoped)

`AVG_WEIGHT_G` · `SGR_PCT` · `ADG_G` · `FCR` · `FEED_RATE_PCT_BIOMASS` · `SURVIVAL_PCT` · `STOCKING_DENSITY_KG_M3` · `FEED_COST_PER_KG_GAIN` · `COST_PER_KG_FISH`

- **Stocking cost** via the new `costPerFingerlingGhs` column; **production cost** = fingerling + feed per kg produced (business-level ExpenseEntryForm stays untouched — no batch-linked expense attribution, per scope decision).
- **FCR** = feed ÷ production gain with every fish partitioned into *still-standing* (last-sample gain) or *harvested-in-window* (harvest kg − first-sample kg) — no double counting, exact for partial and full harvests.
- **SGR** = (ln W₁ − ln W₀) / days × 100; its **target is derived from the profile's weight curve over the batch's own sample window** (an explicit SGR curve is honoured if an owner defines one; templates deliberately ship none).
- **Feeding rate** = mean % biomass/day over the **last 14 logged feeding days** (one feed row = one day's ration) — matches the curve's rate-at-age semantics; the weekly trend chart carries the full age-matched comparison.
- **Historical KPI medians are age-matched** (each comparable batch contributes its weekly value at the current batch's age, nearest ±3 weeks, else its final value) — a 17-week grower is never compared against finished 28-week cycles.
- **Closed batches benchmark at their end-of-cycle age** (last logged activity), not today.
- **Harvest projection** compounds along the target curve's SGR path scaled by the batch's observed relative performance (clamped 0.6–1.4) — never the lifetime-average SGR (which would project a 25 kg tilapia).

## 3. Integration & anti-duplication

- One engine (`fishBenchmarking.ts`) feeds the panel, the alerts, the scorecard blend and the analytics overlay; the existing `fishPerformance.speciesTargetG` remains the fallback so charts look identical when no profile is configured (`hasAnyBenchmark=false` hides the panel behind a setup CTA).
- Alerts are `AquaAlert`-shaped and merge into the existing aquaculture alert grid — no second alert surface; the health score keeps its 0–100 contract (85% analytics + 15% benchmark compliance).
- Feed Mill linkage unchanged: own-mill consumption rows (sourceType OWN_MILL with derived cost) and purchased rows both feed the cost basis; harvests keep their existing stock-in/stock-out + INCOME single-booking.
- Poultry system untouched except two **test-robustness fixes** in `verify-poultry-stages.mjs` (see §5).

## 4. Verification

| Suite | Result |
|---|---|
| `verify-fish-benchmark.mjs` (NEW) | **69/69** — API lifecycle incl. permissions/pinning/409-blocks, engine math cross-checked against SQL (interpolation, SGR derivation, FCR incl. harvest term, survival, cost/kg, age-matched history median 237.5 g, end-of-cycle age 196 d, SGR-path projection 0.462 kg), panel/chips/grade D↔A switch, 5-line band chart, live-price recalc, manager CRUD + template copy + derive, purge |
| `verify-fish-analytics.mjs` (regression, pre-seeding) | **32/32** |
| `verify-fish-feed-mill.mjs` (regression, pre-seeding) | **ALL PASS** |
| `verify-benchmark.mjs` (poultry, post-demo-seed) | **58/58** |
| `verify-flock-plans.mjs` / `-ui.mjs` | **95/95 · ALL PASS** |
| `verify-poultry-stages.mjs` / `-ui.mjs` | **84/84 · ALL PASS** (after §5 fixes) |
| `audit-notify-verify` · `phase0-authz-matrix` · `audit-security` · `audit-deadlinks` | **104/104 · 63/63 · 23/23 · clean** |
| `verify-poultry-analytics` · `-weights` · `-expense` | **32/32 · 23/23 · 26/26** |
| Fresh-bootstrap scratch DB (push → migrate → seed → first-load) | **PASS** — login works, `benchmarkProfiles: []` on the aquaculture GET, benchmarks GET ships the 2 species templates, stage plan intact (65 templates) |

Run order note: `verify-fish-analytics` asserts exact scoped counts on AQUA-01, so it must run **before** `seed-fish-benchmark-demo.mjs` (same convention the poultry suites already follow around `seed-benchmark-demo.mjs`).

## 5. Issues found & fixed along the way

1. **FCR double counting for harvested batches** — fish harvested on/after the last sample were counted in both the survivors' term and the harvest term. Fixed with the standing/harvested partition (M10 proves 1.33, not ~9,000 kg gain).
2. **Feeding-rate aggregation bug** — Σkg ÷ Σ(kg×biomass) was dimensionally wrong (×1000 off) and mixed the 8%/day fry phase into a lifetime mean. Fixed to a last-14-feeding-days window (U17, G-section).
3. **Harvest projection compounded the lifetime-average SGR** — absurd projections (24.6 kg catfish). Fixed to the target-curve SGR path × relative performance (M12).
4. **Closed batches aged past harvest** — KPIs drifted off-target daily after harvest. Fixed with end-of-cycle `asOf` (M11).
4b. **Historical medians were end-of-cycle values** — a mid-cycle batch read a permanent −45% "vs history". Fixed with age-matched weekly medians (M9).
5. **`verify-poultry-stages.mjs` stale expectations (pre-existing, exposed by test-order)** — hardcoded flock ids (serial history drifts as suites create/purge flocks) and a `priority == null` BLOCK-01 expectation that can never hold on a fresh bootstrap (`checklist_templates.priority` defaults to "ROUTINE"). Fixed: dynamic id/status lookups, stale-entry self-healing purge for non-ACTIVE flocks, priority clause dropped. 84/84 restored.
6. **Template self-consistency** — the first template draft carried poultry-style feeding-rate and SGR curves that contradicted its own weight/FCR curves. Templates now ship weight + FCR + feeding rate (feed % = FCR × daily gain ÷ weight) + survival; SGR is derived.

## 6. Demo data (AQUA-01, business 3)

- **Profiles:** "Volta Tilapia — GoMina Farm Target" (default) + "African Catfish — GoMina Farm Target" (default), from the built-in templates.
- **FB-DEMO-T01** — growing tilapia, day ~120: 247 g vs 268.6 g target (−8.0 % WATCH), SGR 2.97 vs 3.14 (WATCH), FCR 1.59 vs 1.23 (OFF_TRACK), feeding 2.8 % vs 2.1 % (OFF_TRACK) → **grade D**, benchmark alerts on the dashboard, projection 0.46 kg vs 0.52 kg target.
- **FB-DEMO-C01** — growing catfish, day 84: on target across the board → **grade A**; projection 1.146 kg vs 1.15 kg target.
- **FB-DEMO-T02 / T03** — harvested 196/182-day tilapia cycles (91 % / 86 % survival, FCR 1.33 / 1.48) → the age-matched farm-history band + medians.

## 7. Files changed

**New:** `src/lib/fishBenchmarking.ts`, `src/app/api/aquaculture/benchmarks/route.ts`, `src/components/FishBenchmarkPanel.tsx`, `src/components/FishBenchmarkManager.tsx`, `dev-tooling/seed-fish-benchmark-demo.mjs`, `dev-tooling/verify-fish-benchmark.mjs`, `reports/screenshots/fish-benchmark-panel.png`.

**Modified:** `src/db/schema.ts` (profiles table + 2 batch columns), `src/app/api/aquaculture/route.ts` (GET/POST/PATCH), `src/components/AquacultureModule.tsx` (wiring + form), `src/components/FishGrowthAnalytics.tsx` + `src/lib/fishPerformance.ts` (target-curve callback), `dev-tooling/verify-poultry-stages.mjs` (bootstrap-robustness fixes).
