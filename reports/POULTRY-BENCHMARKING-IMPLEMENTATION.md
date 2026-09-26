# Poultry Flock Performance Benchmarking — Implementation Report

**Status: LIVE on the POULTRY-01 flagship farm (demo data seeded) · Date: 2026-09-22**
**Design: `reports/POULTRY-BENCHMARKING-DESIGN.md` (approved) · Verification: 58/58 benchmark checks + full regression battery green**

---

## 1. What was built

Age-matched flock performance benchmarking for the Poultry module, exactly per the approved design — maximum reuse, zero duplicated functionality:

| Piece | Where | Notes |
|---|---|---|
| Benchmark profiles (data) | `poultry_benchmark_profiles` table + `benchmark_profile_id` column on `poultry_flocks` | One JSONB `curves` payload per profile (metric → age/value points + `_meta` market age / live price) |
| Comparison engine | `src/lib/poultryBenchmarking.ts` (pure, data-in/data-out) | Age-matched actuals, profile-target interpolation, comparable-history matching (p25/median/p75), variance with direction semantics, A–D scorecard, close-out projection, alerts, curve validation, derive-from-flock |
| API | `src/app/api/poultry/benchmarks/route.ts` (GET/POST/PATCH/DELETE) + extensions in `src/app/api/poultry/route.ts` | GET returns profiles + copyable templates; server-side curve validation; permission-gated mutations; flock pin/unpin |
| Dashboard panel | `src/components/PoultryBenchmarkPanel.tsx` | KPI table with variance chips (vs target + vs farm median), scorecard, close-out projection with editable live price, economics strip, CSV scorecard export |
| Profile manager | `src/components/PoultryBenchmarkManager.tsx` | Drawer: list, curve-grid editor, CSV paste, copy-from-template, derive-from-flock, defaults, archive, delete |
| Chart overlays | `PoultryGrowthAnalytics.tsx` upgraded | Weight-by-age, FCR, mortality, lay % and egg-weight charts gain the profile target line + farm-history band (p25/p75/median) with a "vs history" toggle — only when a benchmark resolves for the scoped flock |
| Alert integration | `computeBenchmarkAlerts()` merged into the existing `PoultryAnalyticsAlerts` panel | New "Benchmark" alert category; health score blends 85/15 with benchmark compliance |
| Flock form | Optional "Benchmark profile" selector | Auto-match (by bird type/breed) remains the default |
| Demo data | `dev-tooling/seed-benchmark-demo.mjs` | 2 profiles from templates, 1 active + 3 historical broiler flocks, 1 historical layer flock, enriched canonical layer flocks — all via the real APIs |
| Verification | `dev-tooling/verify-benchmark.mjs` | 58 checks: API lifecycle, engine math vs DB, UI rendering, overlays, manager, fallback, permissions, purge |

**Preserved exactly as before:** `poultryPerformance.ts` engine (untouched), all existing chart behaviour when no benchmark resolves (built-in Cobb/Isa-Brown/Lohmann/Hy-Line curves remain the fallback), existing data, existing testids.

## 2. How to access it

1. Sign in (owner demo account: `kwame.owner@gomina360.com` / `Owner@GoMina26`).
2. Open **Mina Akuafo Poultry Farm (POULTRY-01)** from the sidebar.
3. The **Dashboard** tab now shows, in order: KPI strip → Smart Analytics & Alerts (with Benchmark alerts) → **Benchmark Performance panel** → Production & Growth Analytics (with overlays).
4. On a farm with no profiles yet, the panel shows a one-card **"Benchmark this farm's performance"** setup CTA instead.

## 3. How to configure it

Open **Manage Benchmarks** (panel header → *Manage*, or the setup CTA). Only OWNER / General Manager / records-authorized managers can edit; everyone else sees a read-only drawer.

- **New Profile** — name, bird type, optional breed, WATCH/OFF-TRACK tolerances (defaults 5% / 10%), market age + default live price (for the close-out projection), then add target curves per metric: age/value rows in the curve grid, or paste CSV (`age,value` per line) via the ⛶ button. Metrics: body weight, daily gain, FCR, cumulative mortality, feed intake, lay %, egg weight, feed cost/kg gain, cost/bird, cost/egg.
- **Copy Breed Template** — one click from the built-in *Broiler Standard (Cobb 500 / Ross 308)* or *Layer Standard (Isa Brown / Lohmann)* templates, then adjust.
- **Derive from Flock** — turns a real (usually finished) flock's logged performance into a `FARM_HISTORY` profile ("what our own batch achieved at each age").
- **Default ★** — one default per bird type; auto-matches every flock of that type (exact breed match wins). **Archive** takes a profile out of auto-matching without deleting it. **Delete** is blocked while flocks still pin the profile.
- **Per-flock override** — the Flock form's "Benchmark profile" selector pins a flock to a specific profile; leave on *Auto* to follow the default.

## 4. How to read it

- **KPI table** — each row: actual, target, ▲/▼ variance chip vs target (green/amber/red = ON_TRACK / WATCH / OFF_TRACK with your tolerances), farm-history median and a second chip vs that history. Direction-aware: for FCR, mortality and costs *lower is better*.
- **Scorecard A–D** — weighted compliance across the scored metrics (weight/FCR/mortality/lay weighted 3×, ADG/egg-weight/feed-cost 2×, intake/cost 1×).
- **Close-out projection** (broilers) — projected weight, FCR, all-in cost, revenue and margin per bird at the profile's market age, from the flock's own ADG/FCR/cost basis; edit the live price to re-run instantly. Assumptions listed inline.
- **Charts** — select a single flock (Flock/Batch filter) in Production & Growth Analytics: the weight-by-age chart shows actual bars, the benchmark target line and the shaded history band (p25–p75 dotted, median dashed). FCR, mortality, lay % and egg-weight charts gain their benchmark lines too. Toggle **"vs history"** off to de-clutter.
- **Alerts** — Benchmark findings appear in the existing alerts panel (e.g. *"Weight Below Benchmark — BATCH… 9.6% behind target"* with recommendations), and benchmark compliance now contributes 15% of the health score.
- **CSV** — *Scorecard CSV* downloads the full scorecard (KPIs, economics, projection, comparable flocks) for records or sharing.

## 5. Benchmarking rules (the methodology)

- **Age-matched:** every comparison happens at the flock's age in days from `arrivalDate`. Curves are interpolated piecewise-linearly at the exact age.
- **Comparable history:** past flocks of the same bird type that are SOLD/CULLED/CLOSED, or older ACTIVE flocks that already lived through this age. Breed/season differences are shown as notes, not exclusions. ≥1 flock → median line; ≥2 → p25–p75 band.
- **ADG target is derived** from the body-weight curve over the same sample window the actual covers (an average-gain actual must not be compared to a marginal-gain curve).
- **FCR:** broilers = feed ÷ live-weight gain (alive-bird estimate counts same-day harvests); layers = feed per kg egg mass (matches the Feed Mill's FCR-egg). Recorded FCR charts unchanged.
- **Economics:** per-flock only (chick cost + flock-linked feed cost + health costs); own-mill feed carries its derived batch cost automatically.
- **Fallback:** no profile and no history → the panel hides/enables setup, charts keep the built-in breed curves, nothing else changes.

## 6. Demo data currently on POULTRY-01

`node dev-tooling/seed-benchmark-demo.mjs` (idempotent — safe to re-run after any DB restore):

- **BENCH-DEMO-B01** — active Cobb 500 cycle, day 30, slightly behind weight target (WATCH), mortality above standard (OFF_TRACK) → scorecard D with actionable alerts. The "problem flock" story.
- **BENCH-DEMO-B02 / B03** + the canonical **BATCH-2026-B02** (closed) — three full historical 42-day cycles (one good, one difficult/different-breed) → the history band.
- **BENCH-DEMO-L01** — a sold layer cycle (late-lay window) → layer band; canonical layer flocks L01/L03 enriched with egg production, egg weights and feed.
- Profiles: *Cobb 500 / Ross 308 — GoMina Farm Target* (default), *Isa Brown / Lohmann — Layer Farm Target* (default), and *BENCH-DEMO-B02 performance* (derived from the good cycle via the manager's Derive-from-Flock).
- Finance side-effects are real: harvest sales post POULTRY_BROILER_SALE income, health costs post POULTRY_HEALTH/VACCINATION expenses (txn count rises from 15 to ~23 on the demo farm).

## 7. Test results (all green, 2026-09-22)

| Suite | Result |
|---|---|
| **verify-benchmark.mjs** (new) | **58/58** — API lifecycle (create/validate/patch/default-uniqueness/pin/unpin/404 cross-business/403 worker/delete-in-use), engine math vs DB (target 1.493 kg @d30, drift −9.6%, FCR 1.64, 3 comparable flocks), panel rendering (grade, chips, history meta, projection, live-price recompute), chart overlays (4-line band, toggle), manager (editor, template copy, derive-from-flock), fallback, purge |
| verify-poultry-weights.mjs | 23/23 (2 assertions updated for the intentional band/target overlays) |
| verify-poultry-analytics.mjs | 32/32 |
| verify-poultry-expense.mjs | 26/26 |
| verify-clean-state.mjs | 109/109 |
| phase0-authz-matrix.mjs | 63/63 |
| verify-az-app-audit.mjs | 41/41 |
| perf-verify.mjs | 20/20 |
| verify-org-scoped-codes.mjs | 24/24 |
| verify-customer-data.mjs | 33/33 |

Run the benchmark suite: `LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-benchmark.mjs`

## 8. Files changed / added

**Added:** `src/lib/poultryBenchmarking.ts` · `src/app/api/poultry/benchmarks/route.ts` · `src/components/PoultryBenchmarkPanel.tsx` · `src/components/PoultryBenchmarkManager.tsx` · `dev-tooling/seed-benchmark-demo.mjs` · `dev-tooling/verify-benchmark.mjs` · `dev-tooling/api-bench-smoke.mjs` · `reports/screenshots/bench-{1-panel,2-chart,3-manager}.png`
**Modified:** `src/db/schema.ts` (table + column) · `src/app/api/poultry/route.ts` (profiles in GET, flock pin) · `src/components/PoultryFarmModule.tsx` (panel + drawer + alert merge + flock-form selector) · `src/components/PoultryGrowthAnalytics.tsx` (overlays) · `dev-tooling/verify-poultry-weights.mjs` (2 assertions) · `reports/POULTRY-BENCHMARKING-DESIGN.md` (status)

## 9. Open items / next ideas

- Per-metric tolerance overrides are supported in the curves JSON (`warnPct`/`critPct` per curve) and validated server-side, but the manager UI exposes profile-level tolerances only — a fine-grained UI can follow if needed.
- AI-insight feed of benchmark variances (24h-dedupe pattern in `/api/ai`) and scorecard export through `UniversalExportCenter` are natural follow-ups; the CSV export covers sharing today.
- After a sandbox/DB restore, re-run `node dev-tooling/seed-benchmark-demo.mjs` to rebuild the demo benchmark data.
