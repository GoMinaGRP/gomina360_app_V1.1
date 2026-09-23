# Poultry Flock Performance Benchmarking — Design & Integration Recommendation

**Status: IMPLEMENTED (2026-09-22) — see `reports/POULTRY-BENCHMARKING-IMPLEMENTATION.md` for the delivered system, usage instructions and test results. This document is the approved design.**
**Date: 2026-09-22 · Scope: Poultry module (`POULTRY-*` businesses) · Author: Arena agent**

---

## 1. Executive summary

The app already has ~70% of the machinery benchmarking needs: an age-aware performance engine with weekly weight buckets (`src/lib/poultryPerformance.ts`), four hard-coded breed-standard curves (Cobb 500 / Ross 308 / Isa Brown / Lohmann / Hy-Line), an alerts engine with severity levels (`src/lib/poultryAnalytics.ts`), ten recharts-based analytics charts (`PoultryGrowthAnalytics.tsx`), a fully-costed feed pipeline including own-mill batches (`PoultryFeedMill.tsx`), and per-category finance transactions (`POULTRY_FEED_PURCHASE`, `POULTRY_HEALTH`, `POULTRY_EGG_SALE`, …).

**Recommendation in one paragraph:** Generalize the four hard-coded target curves into owner-managed **Benchmark Profiles** (2 new tables, JSONB curve payloads), add a pure, testable **benchmark comparison engine** (`src/lib/poultryBenchmarking.ts`, same pattern as `poultryPerformance.ts`) that aligns every metric by flock age and produces *actual vs target vs historical band* series, and surface results by **enriching the existing Dashboard and Growth Analytics surfaces** — a single new "Benchmark Performance" KPI panel on the Dashboard, upgraded 3-series overlays on the existing charts, and a "Manage Benchmarks" drawer (not an 11th tab). Alerts flow through the existing `analyzePoultry()` categories so `PoultryAnalyticsAlerts` renders them with zero new alert UI.

| Aspect | Decision |
|---|---|
| New tables | 2 (`poultry_benchmark_profiles`, + 1 optional column on `poultry_flocks`) |
| New lib module | 1 pure engine (`poultryBenchmarking.ts`) |
| New top-level tab | **None** — dashboard panel + analytics enrichment + management drawer |
| Charting | Reuse recharts + existing `ChartCard`/testid pattern |
| Alerts | Extend existing `analyzePoultry()` categories |
| API | New nested route `/api/poultry/benchmarks` (mirrors `/api/poultry/feed-mill`) |
| Phasing | 3 phases; Phase 1 is self-contained value |

---

## 2. Current-state audit (what exists and is reusable)

### 2.1 Data foundation — every metric the user asked for is already computable

| Requested metric | Existing source | Computed today? |
|---|---|---|
| Body weight / growth | `poultry_weight_logs` (BIRD kind, `avgWeightG`, `sampleSize`) | ✅ `weightByAge`, `growthTrend` |
| ADG | consecutive weight samples | ✅ KPI `avgDailyGainG` |
| Feed intake | `poultry_feed_logs` (CONSUMPTION) | ✅ `feedDaily`, `feedPerBirdG` |
| FCR | recorded `poultry_production.fcr` **and** derived `calcFcr` (weight × feed) | ✅ dual (`fcrTrend` + `calcFcr`) |
| Mortality | `poultry_flocks.mortalityTotal` + `poultry_health_records.mortalityCount` | ✅ `mortalityDaily` cum% |
| Lay %, egg weight | `poultry_production`, weight logs (EGG kind) | ✅ `layTrend`, `eggWeightDaily` |
| Feed cost / kg gain | feed logs (`totalCostGhs`, PURCHASE) **+ own-mill batches** (`costPerKgGhs`, linked via `feedBatchId`) | ⚠️ cost fields exist; ratio not computed |
| Production cost / bird / egg / kg | `transactions` categories (`POULTRY_FEED_PURCHASE`, `POULTRY_VACCINATION`, `POULTRY_HEALTH`, `POULTRY_FEED_MILL_OPS`, …) + feed-mill batch costs | ⚠️ data exists (Finance tab sums it); per-output ratio not computed |
| Feed efficiency (PPEF/EEF) | derivable: `(livability% × weight kg) ÷ FCR` | ❌ new derived metric |

**Key structural win:** age alignment already exists. `poultryPerformance.ts` computes `ageDaysBetween(arrivalDate, date)` and buckets weights by week (`weightByAge` → `W1…Wn`). Benchmarking is the same alignment applied to comparisons.

### 2.2 Hard-coded targets to generalize (the 4 curves)

`poultryPerformance.ts`:
- `broilerTargetKg(ageDays)` — Cobb 500 / Ross 308 blended
- `layerTargetKg(ageDays)` — Isa Brown / Lohmann Brown
- `eggWeightTargetG(ageWeeks)` — Hy-Line standard
- `layerTargetLayPct(ageWeeks)` — Hy-Line standard

These are the seed content for Benchmark Profiles. The functions remain as **built-in fallback defaults** so existing charts never break for farms that never configure a profile.

### 2.3 Surfaces

- **Dashboard tab** — KPI `Stat` strip, then `PoultryAnalyticsAlerts` (alerts + metrics + healthScore, `hasData` empty-state), then `PoultryGrowthAnalytics` (10 charts, batch/flock/branch scoping). ← the two integration points.
- **Flocks tab** — table with `initialCount/currentCount/mortalityTotal/ageWeeks/status`; `status` (ACTIVE/SOLD/CULLED/CLOSED) is the **historical-flock selector**.
- **Feed Mill** — own-mill batches carry `ingredientCostGhs/labourCostGhs/overheadCostGhs → totalCostGhs → costPerKgGhs`, and `commercialRefPriceGhs` per formulation (own-mill vs commercial comparison already exists — reuse for feed-cost benchmarking).
- **Finance tab** — `FinancialReportSection` + cost-breakdown chart from categorized transactions.
- **Exports** — `UniversalExportCenter` already pulls `/api/poultry` for POULTRY module exports.
- **AI** — `ai_insights` table with 24h-refresh dedupe pattern; `/api/poultry/knowledge` KB. Benchmark variances are a natural AI-insight feed.

### 2.4 Live-data reality check (matters for rollout UX)

Current demo DB: 3 flocks (2 LAYER, 1 BROILER, all ACTIVE), **0 weight logs, 0 feed logs, 0 production, 0 health records**. Design must therefore: (a) degrade gracefully to profile-only comparison (no historical band) — `PoultryAnalyticsAlerts.hasData` pattern; (b) treat "no comparable historical flock" as a first-class state, not an error.

---

## 3. Design principles

1. **Enrich, don't duplicate.** No second analytics page, no second chart library, no second alert panel. Existing charts gain a third series; existing alert list gains categories.
2. **Pure engines, dumb components.** All math in `src/lib/` pure functions (the `poultryPerformance.ts` pattern) — trivially unit-testable, no DB coupling.
3. **Owner-managed data, tenant-scoped.** Profiles follow the poultry-table convention (`businessId`, `branchCode`, `ownerId`) and API permission gates (`canManageRecords`-style: OWNER/GM edit, others read).
4. **Never break the fallback.** No profile configured → today's hard-coded curves keep rendering exactly as now.
5. **Age-matched everything.** All comparisons are at equal `ageDays`; never compare a day-21 flock to a day-42 flock on raw values.

---

## 4. Data model

### 4.1 `poultry_benchmark_profiles` (new table)

```
id, businessId, branchCode, ownerId            — tenant pattern (as poultry_feed_batches)
name             text NOT NULL                  — "Cobb 500 — Nsawam 2026 target"
birdType         text NOT NULL                  — LAYERS|BROILERS|COCKERELS|TURKEYS|GUINEA_FOWL
breed            text                           — optional narrowing ("Cobb 500")
source           text NOT NULL DEFAULT 'MANUAL' — MANUAL | TEMPLATE | FARM_HISTORY
status           text NOT NULL DEFAULT 'ACTIVE' — ACTIVE | ARCHIVED
isDefault        boolean DEFAULT false          — default for birdType (+breed if set)
toleranceWarnPct double precision DEFAULT 5     — WATCH band
toleranceCritPct double precision DEFAULT 10    — OFF_TRACK band
notes, createdByName, createdByRole, createdByUserId, createdAt, updatedAt
```

### 4.2 Curves: JSONB on the profile row (no second table)

```
curves jsonb NOT NULL   — map of METRIC → age/value points
```

```jsonc
{
  "BODY_WEIGHT_KG":   { "unit": "kg",    "by": "ageDays",  "points": [[0,0.042],[7,0.185],[14,0.46], …[42,2.8]] },
  "ADG_G":            { "unit": "g/day", "by": "ageDays",  "points": [[7,17],[14,33],[21,58],[35,88]] },
  "FCR":              { "unit": "",      "by": "ageDays",  "points": [[7,0.9],[14,1.15],[21,1.35],[42,1.65]] },
  "MORTALITY_CUM_PCT":{ "unit": "%",     "by": "ageDays",  "points": [[7,0.5],[21,1.5],[42,3.0]] },
  "FEED_INTAKE_G_BIRD":{ "unit": "g/d",  "by": "ageDays",  "points": [[7,25],[14,53],[21,88],[42,167]] },
  "LAY_PCT":          { "unit": "%",     "by": "ageWeeks", "points": [[18,10],[20,50],[24,90],[30,95]] },   // layers
  "EGG_WEIGHT_G":     { "unit": "g",     "by": "ageWeeks", "points": [[20,48],[30,58],[50,64]] },          // layers
  "FEED_COST_PER_KG_GAIN": { "unit": "GHS/kg", "by": "ageDays", "points": [[42,7.2]] },                    // optional
  "COST_PER_BIRD":    { "unit": "GHS",   "by": "ageDays",  "points": [[42,18.5]] }                          // optional
}
```

**Why JSONB, not a curve-points table:** profiles are always read as a whole; nobody queries "all curve points at age 42" across profiles; the feed-mill already uses the JSONB-snapshot pattern (`formulationSnapshot`). One row per profile = one fetch, no joins, trivial versioning later. Metric keys are a validated enum in the engine (unknown keys are ignored, so future curve types never break old readers).

### 4.3 `poultry_flocks.benchmarkProfileId` (one new nullable column)

- **NULL (default) → auto-match**: profile where `birdType` matches and (`breed` is null or matches flock breed), preferring `isDefault`, newest.
- Explicit override always wins. Optional — Phase 1 can ship without it (auto-match only) and add the column with the Flock-form selector in Phase 2.

### 4.4 Seed templates

On first Poultry-module load with zero profiles, lazily insert **TEMPLATE** profiles (marked read-only-ish; "Use as base" copies them to MANUAL): "Broiler Standard (Cobb 500/Ross 308)", "Layer Standard (Isa Brown/Lohmann)", "Layer Egg Weight (Hy-Line)", "Layer Lay % (Hy-Line)" — content taken verbatim from the existing four functions so behavior is identical to today's charts.

---

## 5. Benchmarking methodology (the engine)

New pure module **`src/lib/poultryBenchmarking.ts`** — data-in/data-out, no fetches, no DB (mirrors `poultryPerformance.ts`):

```
computeBenchmarks({
  flock, feedLogs, healthRecords, production, weightLogs, transactions,   // existing payloads
  profile,                                  // resolved Benchmark Profile (or null → built-ins)
  historicalFlocks: { flock, …logs }[],     // comparable past flocks w/ their data
}) → {
  series:  { [metric]: { age, actual, target, histMedian, histP25, histP75 }[] },
  kpis:    BenchmarkKpi[],                  // value/target/variance/status per metric
  scorecard: { grade, compliancePct, breakdown[] },
  bandMeta: { flockCount, batchNumbers[], comparabilityNotes[] }
}
```

### 5.1 Age-matched alignment

- **Anchor:** `arrivalDate` → `ageDays` (reuse `ageDaysBetween`). Weekly buckets for weight/ADG/FCR curves (existing `weightByAge` logic), exact-age interpolation for point-in-time KPIs.
- **Target lookup:** piecewise-linear interpolation between curve points (the hard-coded functions are already piecewise tables — same math, now data-driven).
- **Historical band:** for each matched past flock, compute the same metric series, then per age bucket take **p25 / median / p75** (min/max shown as tooltip range). ≥3 flocks → shaded band; 2 → median only; 1 → single dashed reference line labeled `BATCH-2025-B01`; 0 → band silently omitted (profile-only view).

### 5.2 Comparable-flock matching (`matchComparableFlocks`)

A past flock is comparable when:
- `status ∈ {SOLD, CULLED, CLOSED}` **or** an ACTIVE flock of the same birdType that has already passed the current flock's age (older flock used up to the current age only);
- `birdType` identical (hard rule);
- `breed`/`genetics` match scores higher (soft rule — mismatch shows a "different breed" chip, doesn't exclude);
- same `branchCode` if the farm is multi-branch and the dashboard is branch-scoped (existing filter convention).

Comparability notes are surfaced ("Compared with 2 past broiler flocks — one different breed, one placed in harmattan") rather than silently hidden, because placement **seasonality** matters in Ghana but isn't worth a hard filter at ≤5 historical flocks.

### 5.3 Variance semantics per metric

| Metric | Better direction | Compare |
|---|---|---|
| Body weight, ADG, lay %, egg weight | higher | target & hist median |
| FCR, mortality cum%, feed cost/kg gain, cost/bird, feed intake* | lower | target & hist median |
| PPEF (broiler EEF) | higher | target only (rarely in farm history) |

*feed intake is "lower better" only at equal weight; the engine compares it at matched age (which is exactly why age-matching matters) — flagged WATCH, never OFF_TRACK, since intake below target usually *predicts* a weight shortfall (the weight chart is the arbiter).

Status per KPI: **ON_TRACK** (within `toleranceWarnPct`), **WATCH** (within `toleranceCritPct`), **OFF_TRACK** (beyond). Tolerances are per-profile columns, overridable per metric inside `curves` (`"FCR": { "warnPct": 4, "critPct": 8, … }`).

### 5.4 Flock scorecard

`compliancePct` = weighted share of evaluated metrics ON_TRACK (weights: weight/FCR/mortality heavy; cost metrics medium). Grade: **A** ≥95, **B** ≥85, **C** ≥70, **D** <70 — one-glance per-flock summary, exportable, and the input to AI insights.

---

## 6. API design

New nested route **`/api/poultry/benchmarks`** (mirrors `/api/poultry/feed-mill` conventions: `{ entity, data }` POST, `{ entity, id, data }` PATCH, DELETE):

| Op | Entity | Gate |
|---|---|---|
| GET | profiles + curves + usage count (flocks using each) | business member |
| POST | `PROFILE` (create/copy-from-template/import) | OWNER / canManageRecords |
| PATCH | `PROFILE` (edit curves in a curve-grid editor, archive, set default) | OWNER / canManageRecords |
| DELETE | `PROFILE` (blocked if `isDefault` in use — must reassign first) | OWNER |

Mutations call `ttlInvalidate("init")` per the app's cache convention. Curve validation server-side: points sorted by age, ≥2 points per curve, known metric keys, `birdType`/`breed` present.

Flock comparison itself needs **no new GET**: the existing `/api/poultry` response already returns all logs (the client already has every flock's full data in memory — the Poultry module fetches once per business), so historical-band computation happens client-side in the engine. If payload size ever becomes a problem (50+ flocks), add `?include=benchmark&flockId=X` server-side computation as a later optimization — not now.

---

## 7. UI integration (no new top-level tab)

The tab bar already has 11 entries. Benchmarking ships as **one dashboard panel + chart enrichment + one drawer**:

### 7.1 Dashboard — "Benchmark Performance" panel (new Card, after the KPI strip)

```
┌─ Benchmark Performance ────────────────────── [Manage Benchmarks] ─┐
│ Flock: [BATCH-2026-B02 ▾]   Profile: Cobb 500 — Nsawam   Age: d112 │
│                                                                     │
│  Weight 2.31kg   ▲ target 2.45kg (−5.7% WATCH)   vs farm median +3% │
│  FCR 1.72        ▼ target 1.65  (+4.2% WATCH)    vs farm median −2% │
│  Mortality 6.7%  ▲ target 3.0%  (OFF_TRACK)      vs farm median 5%  │
│  ADG 48g/d       ▼ target 51g/d (−5.9% WATCH)    …                  │
│  Feed cost/kg gain ₵8.10  ▲ own-mill ref ₵6.90 (OFF_TRACK)          │
│  Scorecard: B (84% compliance)                                      │
└─────────────────────────────────────────────────────────────────────┘
```

- Variance chips: green ▲/▼ when favorable, amber (WATCH), red (OFF_TRACK) — colored per §5.3 direction, not raw sign.
- Hidden entirely when no profile resolves **and** no comparable flock exists (new-farm empty state unchanged).
- `data-testid` convention: `poa-bench-*` (extends the existing `poa-chart-*` family).

### 7.2 Growth Analytics — upgrade existing charts to 3-series overlays

The weight, lay-%, and egg-weight charts already draw a hard-coded dashed target line. Each becomes **actual (solid) vs profile target (dashed emerald) vs farm-history band (slate shaded area, p25–p75)** using recharts `Area` + `Line` in the existing `ComposedChart`s — no new chart components, existing testids keep working, plus optional overlays for FCR & mortality charts. A "vs History" legend toggle (default on when ≥2 comparable flocks).

### 7.3 "Manage Benchmarks" drawer

Launched from the panel header (and the Analytics header). Profile list → curve-grid editor (spreadsheet-style rows: age / value, add/remove points, paste-from-CSV), "Copy from template", "Derive from flock…" (see §9.2), per-metric tolerance overrides, set-default, archive. Uses the app's existing modal/drawer + form patterns; ~1 component (`PoultryBenchmarkManager.tsx`) + one panel component (`PoultryBenchmarkPanel.tsx`).

### 7.4 Flocks tab

One addition to the flock table: a small scorecard badge (A–D dot) per flock once profiles exist. Flock form gains an optional "Benchmark profile" selector (Phase 2, with the `benchmarkProfileId` column).

---

## 8. Alerts & notifications integration

Extend `analyzePoultry()` (or a `poultryBenchmarking` sub-analyzer whose alerts are merged in `PoultryFarmModule` before rendering) — **no new alert surface**:

| Alert id (level) | Trigger | Recommendation text anchor |
|---|---|---|
| `bench-weight-off` (critical) | weight vs target beyond `critPct` for 2+ consecutive samples | feed program / disease check |
| `bench-fcr-watch` (warning) | FCR above target beyond `warnPct` | feed wastage, temperature, density |
| `bench-mortality-off` (critical) | cum mortality > target curve `critPct` | the existing mortality playbooks |
| `bench-lay-off` (warning) | lay% below profile at age | lighting/feed/lighting program |
| `bench-feedcost-watch` (warning) | feed cost/kg gain > profile & > own-mill baseline | own-mill vs commercial switch hint |
| `bench-good` (normal) | all key metrics ON_TRACK | "Flock tracking profile within tolerance" |

Health score gains a benchmark-compliance component (capped influence so a farm with a strict custom profile can't tank the score without real deviations). Because alerts ride the existing `PoultryAlert[]` shape, `PoultryAnalyticsAlerts.tsx` renders them with zero changes, and any notification-bell wiring benefits automatically.

---

## 9. Additional high-value features (ranked)

1. **Close-out projection (broilers).** From current ADG + FCR + feed cost, project weight/feed/cost at target market age → projected margin per bird vs live-price entry. This is the #1 question farmers ask at week 4–5; reuses engine outputs only.
2. **"Derive benchmark from flock".** One click turns a finished good flock into a `FARM_HISTORY` profile ("what our best 2025 batch achieved at each age") — makes farm-specific targets effortless and drives adoption.
3. **Cost-per-unit economics row** (₵/egg, ₵/kg live weight, ₵/bird to date) benchmarked vs profile & history — ties performance directly to the Finance tab categories that already exist.
4. **PPEF/EEF** (broiler feed-efficiency index combining weight, livability, FCR) — one derived number that ranks flocks fairly across cycles; great for the scorecard.
5. **AI insights feed.** POST benchmark variances into the existing `ai_insights` (24h dedupe pattern) so the AI advisor can narrate deviations; later, KB answers ("why is my FCR high at week 4?").
6. **Seasonality grouping** — bucket past flocks by placement season (major dry/minor wet/harmattan) in the band legend; pure client-side once matched-flock metadata exists.
7. **Scorecard export** (CSV/PDF) through the existing `UniversalExportCenter` — it already fetches `/api/poultry` data.
8. **Own-mill vs commercial feed switch advisor** — extends the existing `commercialRefPriceGhs` comparison to "what would FCR/cost-per-kg-gain look like if…".

Items 1–3 are recommended for Phase 3; 4 with the scorecard (Phase 2); 5–8 are post-MVP nice-to-haves.

---

## 10. Reuse vs build vs do-NOT-duplicate

| | Item | Action |
|---|---|---|
| **Reuse as-is** | `poultryPerformance.ts` aggregation (weights, FCR, mortality, lay, feed), `ageDaysBetween`, weekly bucketing, `ChartCard`, recharts, `PoultryAlert` shape + `ALERT_STYLES`, `hasData` empty-state, feed-mill `costPerKgGhs` + `commercialRefPriceGhs`, transaction categories, `formatMoney`, tenant/permission conventions, `/api/poultry` payload |
| **Build new** | 2 tables (+1 column), `poultryBenchmarking.ts` engine, `/api/poultry/benchmarks` route, `PoultryBenchmarkPanel.tsx`, `PoultryBenchmarkManager.tsx`, curve-grid editor, template seeding, 6 alert rules, scorecard |
| **Modify lightly** | `PoultryGrowthAnalytics.tsx` (add band/target overlay props), `poultryAnalytics.ts` (merge benchmark alerts), `PoultryFarmModule.tsx` (mount panel + drawer), `poultryPerformance.ts` (accept optional profile curve in place of built-ins — keep built-ins as fallback), Flock form (profile selector, Phase 2) |
| **Do NOT duplicate** | No second analytics page/tab, no new chart library, no parallel alert center, no re-fetching of data the module already holds, no second age-alignment implementation (engine imports from `poultryPerformance.ts`) |

---

## 11. Implementation phasing (for approval, not started)

| Phase | Contents | Rough effort | Ships value |
|---|---|---|---|
| **1 — Profiles & targets** | Tables + JSONB curves, API route, template seeding, manager drawer, Dashboard benchmark panel (actual vs **target** only, variance chips, scorecard), engine with profile mode | ~1.5–2 sessions | Owner-defined benchmarks live |
| **2 — History & charts** | `matchComparableFlocks`, p25/p50/p75 bands, 3-series chart overlays in Growth Analytics, "vs farm median" chips, "Derive from flock", PPEF, flock-form selector + `benchmarkProfileId` | ~1–2 sessions | Full actual vs target vs history |
| **3 — Alerts & extras** | 6 alert rules + health-score weighting, close-out projection, cost-per-unit row, AI-insight feed, scorecard export | ~1 session | Proactive guidance |

Testing follows the established `dev-tooling/` suite pattern (new `verify-benchmark.mjs`: seed profile → seed weight/feed logs → assert variance chips & band presence; testids `poa-bench-*`).

**Risks & mitigations:** sparse logging (current demo data!) → every comparison degrades to whatever data exists, empty-states everywhere; profile curve misuse (typos) → server validation + tolerance preview in the editor; comparing across feed regimes (own-mill vs purchased) → regime shown as a chip on the band legend, matched-flock note.

---

## 12. Open questions before implementation

1. **Profile scope** — per business only (recommended, matches every other poultry table), or org-shareable so multi-farm owners reuse one profile across businesses?
2. **Layer feed-efficiency preference** — FCR-egg (kg feed per kg egg mass, matches feed-mill's `fcrEgg`) or feed per 100 eggs as the headline layer metric?
3. **Default tolerances** — 5% WATCH / 10% OFF_TRACK sane for Ghana smallholder-to-commercial range, or stricter?
4. **Historical band percentile floor** — compare against *best past flock* instead of median anywhere in the UI (e.g., a "vs farm best" chip)? Cheap to add, adds a fourth number per KPI.

---

*Design only — nothing above has been implemented. On approval, Phase 1 begins with the schema migration and engine module.*
