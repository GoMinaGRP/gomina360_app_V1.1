# Poultry Daily Checklist — Stage-Based System Assessment & Recommendation

**Status:** Assessment / design recommendation — **not implemented** (per instruction).
**Scope:** Poultry Farm Daily Checklist for broilers (day/age + production stage) and layers (week/age + production stage), from placement to market / closeout, with essential daily routine retained for both, Owner customization, and Audit + Notifications integration.
**Verdict up front:** extend the existing unified checklist engine with a **flock-scoped, stage-aware layer** driven by a pure stage-model library keyed off `arrivalDate` and the already-shipped benchmark profiles. Do **not** build a separate poultry-specific checklist system, and do **not** fork new data capture — the checklist should *orchestrate* the data surfaces that already exist (feed, water, health, production, weights, benchmarks, alerts).

---

## 1. What exists today (verified in code and live data)

### 1.1 The unified checklist engine (shared by all business types)

| Piece | Where | What it does |
|---|---|---|
| Templates | `checklist_templates` (`src/db/schema.ts:2713`) | Business-scoped master list: `taskKey`, `taskLabel`, `category`, `sortOrder`, `isActive`, optional `assignedToUser*` fields |
| Daily entries | `checklist_entries` (`:2733`) | One row per task per business+branch+date; completion stamps `completedByName/Role/At`, `notes` |
| Default task sets | `src/lib/checklistDefaults.ts` | `POULTRY_TASKS` = **8 fixed tasks, identical for broilers and layers** (morning/evening feed, drinkers, AM/PM egg collection, mortality, house clean, biosecurity) |
| Generation | `src/lib/checklistGen.ts` | `ensureTemplates` (seed once), `generateEntriesForDate` (idempotent daily materialization from ACTIVE templates), `ensureTodayFor` (`/api/init` hook — business always has today's plan) |
| API | `src/app/api/checklists/route.ts` | GET (auto-provisions today), POST `TEMPLATE`/`GENERATE`, PATCH `ENTRY` (toggle completion) / `TEMPLATE` (edit), DELETE — **Owner/manager-gated** (`MANAGE_ROLES`), business-scope-gated (`canAccessBusiness`) |
| UI | `src/components/DailyChecklistPanel.tsx` | Progress bar, 16 categories, add/edit/assign/deactivate tasks, notes |
| Daily notes | `daily_notes` + `DailyNotesPanel` | Free-form end-of-day notes, AI-analyzed on submission |
| Legacy | `poultry_checklists` (`schema.ts:1419`) | Old module-specific table — **dead** except for counts in `businesses/[id]` (backup/export). Must not be broken. |

Live state (POULTRY-01, demo DB): templates were customized to 5 tasks (feed silo, water lines, egg collection, mortality sweep, footbath) — evidence the Owner-customization path is already used.

### 1.2 Poultry data model — stage-relevant data already captured

| Table | Stage-relevant content |
|---|---|
| `poultry_flocks` | `birdType` (LAYERS/BROILERS/…), `breed`, `genetics`, `supplier`, `sourceHatchery`, **`arrivalDate`** (day-0 anchor), `ageWeeks` (manually maintained — stale risk), counts, `mortalityTotal`, `status` (ACTIVE/SOLD/CULLED/CLOSED), `houseName`, `benchmarkProfileId` |
| `poultry_feed_logs` | `feedType` **STARTER / GROWER / FINISHER / LAYER_MASH / CONCENTRATE**, kg, cost |
| `poultry_water_logs` | litres, source, pH, treatment |
| `poultry_health_records` | VACCINATION / TREATMENT / INSPECTION / MORTALITY / BIOSECURITY, **`nextDueDate`**, dosage, outcome |
| `poultry_production` | EGGS (trays, cracked, Grade A/B) and BROILER_WEIGHT (birds, total/avg kg) |
| `poultry_logs` | Legacy daily activity (trays, feed, mortality, health status) |

### 1.3 The stage engine already exists — in benchmarking (`src/lib/poultryBenchmarking.ts`)

- **`ageDaysOf(flock, date)`** — exact flock age in days from `arrivalDate`.
- **Age-keyed target curves**: broiler profile (Cobb 500/Ross 308) keyed by `ageDays` — body weight, ADG, FCR, cumulative mortality, feed intake/bird, `marketAgeDays: 42`; layer profile (Isa Brown/Lohmann) — body weight by `ageDays`, **lay % and egg weight by `ageWeeks`** (first egg curve starts wk 19, peak ~92% wk 30–38, decline to 71% by wk 80).
- `resolveProfile()` auto-matches by bird type (+breed), with per-flock override and own-history-derived custom profiles.
- `computeBenchmarks()` + `computeBenchmarkAlerts()` → `PoultryAlert[]` (weight behind target, FCR drift, mortality, lay %, egg size…).

### 1.4 Analytics, notifications, audit

- `src/lib/poultryAnalytics.ts` — `analyzePoultry()` produces alert families: Mortality, Feed Intake, Water, Egg Production, Broiler Weight (critical/warning/normal, age-aware thresholds). `PoultryAlert` shape: `{level, category, title, message, recommendation, value, threshold}`.
- `notifications` table (user-scoped, priority, `record_type/ref`, read state) + `pushToUsers()` web-push + `notify.ts` recipient helpers (`orderNotificationRecipients`, `auditEscalationRecipients`). **No checklist-driven notifications today.**
- `audit_trail` (actor, action, `record_type` incl. `OPERATION_LOG`, `record_id`, reason, detail) — the poultry API already writes `OPERATION_LOG` entries; `audit_assignments` grant per user × business × module (OPERATIONS, FINANCE, …). **Checklist events are not in the audit trail today.**

---

## 2. Gap analysis

### 2.1 Structural gaps

1. **One flat list for both bird types** — broiler flocks are asked to do "Morning/Afternoon egg collection"; layers never get brooding, light-program, or pre-peak calcium tasks.
2. **Business-level, not flock-level** — entries have no `flock_id`; with the demo's mixed farm (LAYERS `BATCH-2026-L01` at wk ~53, BROILERS `BENCH-DEMO-B01` at day ~29) the checklist cannot express "weigh B01 today" vs "collect L01 eggs 3×".
3. **No stage/age metadata** — templates and entries carry no bird type, stage, frequency (daily/weekly/once), or priority; everything is implicitly daily and permanent.
4. **`ageWeeks` is manual** — stage math must derive from `arrivalDate` (as `ageDaysOf` already does), never trust the column.
5. **No stage transitions, no stage compliance** — nothing notices "flock entered Finisher today" or "brooding-week tasks missed 3 days running".
6. **No notifications/audit hooks** — missed critical tasks and stage changes are invisible outside the module panel.

### 2.2 Husbandry-content gaps (what a stage system must cover)

- **Broilers (day-based):** pre-placement house prep; D1–7 brooding (33→30 °C step-down, crop-fill check, paper feed, 24-h mortality review); D8–14 starter→grower transition, first sample weighing (D7/D14); D15–28 grower (density, feeder/drinker heights, ventilation); D29–market finisher (feed change, daily weight-vs-curve check, medication withdrawal awareness); market week (withdrawal compliance, catch crew & crate prep, load-out, closeout: final FCR/mortality/economics vs benchmark).
- **Layers (week-based):** W0–6 chick brooding/rearing; W7–12 growing with **feed restraint to body-weight curve**; W13–17 developing (uniformity sampling ~W16, transfer to lay house ~W17–18); W18–19 pre-lay (**light stimulation step-up**, calcium transition to layer mash, first eggs); W20–25 early lay ramp; W26–38 **peak** (2–3× collection, daily lay-% vs curve, water/feed vigilance); W39–60 mid (routine + monthly uniformity, egg weight tracking); W61–80+ late (egg size/quality grading, shell quality, molting decision, spent-hen closeout).

---

## 3. Recommended system

### 3.1 Architecture in one line

> A **pure stage-model library** (`poultryStages.ts`) + a **stage-keyed task library**, materialized per **active flock** through the **existing** template/entry engine, with additive columns for scope metadata — orchestrated against the existing data surfaces, and wired into notifications and audit.

### 3.2 Stage model — `src/lib/poultryStages.ts` (new, pure functions, no DB)

`stageOfFlock(flock, date, profile)` → `{ stageKey, label, birdType, ageDays, ageWeeks, phase, windowStart, windowEnd?, daysToNext, marketEta? | pointOfLayWk }`

**Broilers — organized by DAY / age + production stage** (market age from resolved benchmark profile `_meta.marketAgeDays`, default 42):

| Stage | Age window | Focus |
|---|---|---|
| `PREP` | day −7…−1 | House wash/disinfect, litter, brooder test, feed/water arrival, pre-placement audit |
| `BROODING` | day 1–7 | Temperature 33→30 °C, crop-fill (≥95% by 24 h), paper feed, round-the-clock checks |
| `STARTER` | day 8–14 | Temp step-down, grower transition planning, D7/D14 sample weigh |
| `GROWER` | day 15–28 | Density, equipment heights, ventilation, weigh vs curve weekly |
| `FINISHER` | day 29 → market−2 | Finisher feed, daily weight vs curve, withdrawal awareness |
| `MARKET` | market−2 → market | Feed withdrawal, withdrawal compliance, catch/crate prep, load-out |
| `CLOSEOUT` | post-sale | Final FCR/mortality/economics vs benchmark, house prep handover |

**Layers — organized by WEEK / age + production stage** (anchors from the layer benchmark curves: lay % starts wk 19; peak plateau wk 30–38):

| Stage | Age window | Focus |
|---|---|---|
| `CHICK_BROODING` | wk 0–6 | Brooding, temp step-down, beak condition, starter feed |
| `GROWING` | wk 7–12 | Grower feed **restraint to body-weight curve**, uniformity |
| `DEVELOPING` | wk 13–17 | Frame development, uniformity sampling (~wk 16), transfer prep |
| `PRE_LAY` | wk 18–19 | **Light stimulation step-up**, layer-mash/calcium transition, transfer, first eggs |
| `EARLY_LAY` | wk 20–25 | Ramp to peak, collection 2–3×, lay % vs curve daily |
| `PEAK` | wk 26–38 | Peak management, water/feed vigilance, minimal stress |
| `MID_LAY` | wk 39–60 | Routine + monthly uniformity/egg-weight tracking |
| `LATE_LAY` | wk 61–80+ | Shell quality/grading, egg size, molting decision |
| `SPENT/CLOSEOUT` | post-decision | Spent-hen sale, closeout economics vs benchmark |

Stage boundaries are constants (overridable per benchmark profile where a profile carries its own `marketAgeDays`). **Age is always derived from `arrivalDate` via `ageDaysOf`** — never from `ageWeeks`. Dates use the app's existing `en-CA` local-date convention.

### 3.3 Essential daily routine (kept for BOTH bird types, every stage)

Morning walk & behavior observation · feed availability/check (per stage feed type) · water check & line flush · temperature/ventilation check · mortality sweep & record · biosecurity (footbath/gate) · egg collection (layers; or bird count/weight tasks for broilers as applicable) · feed & data logging reminder · end-of-day secure. Stage tasks are **additions on top**, never replacements.

### 3.4 Task library — `src/lib/poultryStageTasks.ts` (new)

Extended `TaskSeed`: `{ taskKey, taskLabel, category, birdType, stageKeys[], frequency: DAILY|WEEKLY|STAGE_ONCE|ON_EVENT, priority: ROUTINE|CRITICAL, houseScoped?: boolean, linksTo?: FEED_LOG|WATER_LOG|PRODUCTION_EGGS|WEIGHT|HEALTH_RECORD|MORTALITY }`.

**`linksTo` is the no-duplication contract:** a task *points at* the existing logging surface (and deep-links to that form in the module UI); it never stores values itself. The only new fact a checklist row records is *completion*. (Optional v2: auto-tick tasks whose linked data landed today — e.g., eggs logged ⇒ collection task completes — but ship v1 with a "logged ✓" hint only, to keep completion semantics honest.)

### 3.5 Schema evolution — additive only

- `checklist_templates` += nullable `bird_type`, `stage_keys` (jsonb), `frequency`, `priority`, `origin` (`STAGE_PLAN` | `CUSTOM`).
- `checklist_entries` += nullable `flock_id`, `batch_number`, `stage_key`, `age_days`, `priority` (self-describing history for audit/compliance analytics).
- **No new tables** — templates remain the single Owner-customization surface. Legacy `poultry_checklists` is left untouched (deprecated in docs) so `businesses/[id]` backup/export/import stays compatible; extend `businessBackup.ts` field maps for the new nullable columns.

### 3.6 Generation — evolve `checklistGen.ts`

`ensureTodayFor` keeps its cheap single-probe path for non-poultry. For poultry businesses: load active flocks (one query) → `stageOfFlock` per flock → materialize per flock: core daily routine + stage-applicable tasks (DAILY always; WEEKLY when due in-window; STAGE_ONCE when not yet recorded in that stage window). House-scoped tasks (`footbath`, `generator`) materialize **once per business+branch**, not per flock. Idempotency and the "past dates are never fabricated" rule are preserved. SOLD/CLOSED flocks drop out automatically. Existing static templates migrate as `origin=CUSTOM` and keep working unchanged.

### 3.7 UI — `PoultryFarmModule` + `DailyChecklistPanel`

Stage chip on flock cards ("BROILERS · Day 23 · Grower — 19 d to market · target 1.33 kg"), checklist grouped **Daily routine → stage tasks → custom tasks** with per-flock tabs, and a stage-compliance trend (completion % by stage over the flock's life — computed from existing entry stamps, no new data).

### 3.8 Owner customization (layered, non-destructive)

System stage plan (versioned code) → per-business enable toggle (**opt-in**, so current demo/production checklists don't change by surprise) → per-task activate/deactivate, edit label, assign person (all existing PATCH/DELETE surfaces, now stage-aware) → custom additions with optional bird-type/stage scoping. Upserts update only `origin=STAGE_PLAN` rows; `CUSTOM` rows are never clobbered.

### 3.9 Notifications integration (reuse the existing rails)

- **Overdue-critical sweep:** after a cutoff (e.g. 18:00 local), incomplete `CRITICAL` tasks generate `notifications` (type `CHECKLIST_OVERDUE`, priority high, `record_ref` = flock+date) to the assigned user + managers via a recipient helper modeled on `orderNotificationRecipients`; web-push via `pushToUsers`. Dedupe on (user, record_ref, date).
- **Stage transitions:** on the first generation where a flock's stage changes, notify Owner/managers ("BATCH-2026-B02 entered Finisher (D29) — 13 days to market; target 2.05 kg"). Layer equivalents for pre-lay light start, peak entry, late-lay review.

### 3.10 Audit integration

- Write `audit_trail` rows for stage transitions and critical-task completions (`record_type: CHECKLIST`, `record_id: entry/template id`, reason/detail) — same pattern the poultry route already uses for `OPERATION_LOG`.
- Auditors: checklist compliance joins the **OPERATIONS** module scope in the Audit Command Center (auditors with an OPERATIONS grant can pull compliance by business/date range/flock), and stage-transition events become auditable records with actor + reason.

---

## 4. Rollout plan (when implementation is approved)

1. **Phase 0 — foundations:** `poultryStages.ts` + stage boundary unit tests; additive schema columns; `tsc` + build green.
2. **Phase 1 — engine:** stage-keyed task library; flock-scoped generation in `checklistGen.ts`; `/api/checklists` accepts/returns new fields; existing behavior byte-compatible for non-poultry and non-opted-in businesses.
3. **Phase 2 — UI:** stage chips, grouped checklist, per-flock tabs, stage compliance trend, customization modal extensions.
4. **Phase 3 — integrations:** notification sweep + stage-transition notices; audit-trail hooks + OPERATIONS-scope compliance view.
5. **Phase 4 — verification:** new `verify-poultry-stages.mjs` (stage math on the demo flocks — layer wk ~53 → `MID_LAY`, broiler day ~29 → `FINISHER`), plus regression runs of the existing suites (clean-state, poultry, audit, notifications).

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| `ageWeeks` drifts from reality | Stage math derives from `arrivalDate` only; optionally auto-refresh `ageWeeks` on read |
| Mixed broiler + layer farms double-count house tasks | `houseScoped` dedupe at business+branch level |
| Entry volume grows per flock | Modest in practice (1–5 active flocks × ~10–25 tasks); weekly/once tasks keep it flat |
| Breaking current customized checklists | Opt-in enable; existing templates become `origin=CUSTOM` untouched |
| Backup/export divergence | Extend `businessBackup.ts` maps; leave legacy table alone |
| `/api/init` latency | Stage path runs only for poultry-category businesses that opted in; reuses the benchmark bundle `/api/poultry` already fetches |

## 6. Decisions for Owner sign-off

1. Opt-in per business vs default-on for new poultry businesses (recommend: **opt-in toggle, default-on for newly created poultry businesses**).
2. Auto-complete of tasks from linked data (recommend: **v2**, after completion semantics settle).
3. Overdue-critical cutoff time (recommend 18:00 local, configurable per business).
4. Whether layer stage boundaries should follow breed-specific profiles when available (recommend: yes via `resolveProfile`, falling back to the standard template).
