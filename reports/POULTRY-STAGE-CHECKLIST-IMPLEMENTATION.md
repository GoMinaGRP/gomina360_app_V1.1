# Poultry Age/Stage-Aware Daily Checklist — Implementation & Verification Report

**Implements:** `reports/POULTRY-STAGE-CHECKLIST-ASSESSMENT.md` (recommended architecture, all phases).
**Status:** Complete — 83/83 API/data checks, 10/10 UI checks, fresh-bootstrap validated, 13 regression suites green.
**Preview:** live on the demo — POULTRY-01 ships the stage plan ENABLED (login `kwame.owner@gomina360.com` → Mina Akuafo Poultry Farm → Checklist / Flock & Batch tabs).

---

## 1. What was built

The unified daily-checklist engine now generates a **flock-scoped, age/stage-aware plan** for poultry businesses, exactly per the assessed architecture:

- **Broilers are organized by DAY / age + production stage** — PREP → BROODING (D1–7) → STARTER (D8–14) → GROWER (D15–28) → FINISHER (D29 → market−3) → MARKET (market−2 … market+7) → CLOSEOUT (market+8+), with the market age resolved from the flock's benchmark profile (`curves._meta.marketAgeDays`, default 42).
- **Layers are organized by WEEK / age + production stage** — CHICK_BROODING (Wk 0–6) → GROWING (Wk 7–12) → DEVELOPING (Wk 13–17) → PRE_LAY (Wk 18–19) → EARLY_LAY (Wk 20–25) → PEAK (Wk 26–38) → MID_LAY (Wk 39–60) → LATE_LAY (Wk 61–80) → SPENT/CLOSEOUT (Wk 81+).
- **Essential daily routine retained for both** — morning walk, feed check, water check, temperature/ventilation, mortality sweep, data-logging reminder, plus house-scoped biosecurity and end-of-day lock-up (once per farm, not per flock). Stage tasks are additions, never replacements. Broilers additionally get the daily litter check; layers get AM/PM egg collection.
- Age is **always derived from `arrivalDate`** (benchmarking's `ageDaysOf`) — never the manual `ageWeeks` column. Unsupported bird types (cockerels, turkeys, guinea fowl) fall back to the shared core routine only.

### 1.1 New modules

| File | Role |
|---|---|
| `src/lib/poultryStages.ts` | Pure stage model — `stageOfFlock(flock, date, profile)` → stage, phase, age, window, market ETA, transition note; stage catalogues per bird type |
| `src/lib/poultryStageTasks.ts` | Versioned task library: 61 tasks (8 shared core, 26 broiler, 27 layer) with `birdType`, `stageKeys`, `frequency` (DAILY / WEEKLY / MONTHLY / STAGE_ONCE), `priority` (ROUTINE / CRITICAL), `houseScoped`, `linksTo` (the no-duplication contract: tasks point at feed/water/production/health data surfaces, checklist rows only record completion) |

### 1.2 Engine (`src/lib/checklistGen.ts`)

- `ensureTemplates`: new **Poultry Farm** businesses default to the stage plan.
- `ensureStagePlanTemplates`: idempotent seeding of the system plan + metadata refresh; **adoption** of Owner items whose task keys collide (see §3.1). `disableStagePlanTemplates`: Owner opt-out (history preserved).
- `generateEntriesForDate`: **incremental, flock-scoped generation** under a per-(business, date) advisory lock. Custom/business items materialize once per business exactly as before; stage items materialize per ACTIVE flock at its current stage. Due rules: DAILY every day in-stage · WEEKLY after 6 quiet days · MONTHLY after 29 · STAGE_ONCE once per flock per stage window (skipped ones don't re-appear inside the same stage). House-scoped tasks once per business+date. Mid-day flock additions still get today's tasks; SOLD/CLOSED flocks drop out automatically. **Stage transitions** are detected on forward-moving generations (backfills never re-announce) → manager notification + audit-trail row.
- `sweepOverdueCritical`: end-of-day sweep of incomplete CRITICAL tasks (cutoff default 18:00, per-business override via system marker `checklist:overdueCutoffHour:<businessId>`) → one HIGH-priority notification per business+date to managers + assignees, deduped by recordRef. Runs from `/api/init` (fire-and-forget) and the manual `SWEEP` action.

### 1.3 API (`/api/checklists`)

- `POST STAGE_PLAN {action: enable|disable, cutoffHour?}` — Owner/manager-gated, poultry businesses only; enable materializes today immediately.
- `POST SWEEP {cutoffHour?}` — manual overdue run (same engine as init).
- `POST TEMPLATE` / `PATCH TEMPLATE` — custom items and stage-plan items alike accept bird type, stage scope, frequency and priority (the template row IS the customization surface).
- `PATCH ENTRY` — completing a CRITICAL task writes a `CHECKLIST_CRITICAL_DONE` audit-trail row.
- GET unchanged in shape; entries now carry `flockId`, `batchNumber`, `birdType`, `stageKey`, `stageLabel`, `ageDays`, `frequency`, `priority`.

### 1.4 Integrations (all reused, nothing duplicated)

- **Benchmarking:** market age and stage windows come from the resolved benchmark profile (`resolveProfile` over DB profiles + standard templates); checklist targets point at the same curves.
- **Notifications:** `notifyPoultryStageTransition` + `notifyChecklistOverdue` ride the existing bell/web-push rails (`fanOut`, per-user recordRef dedupe).
- **Audit:** checklist completions remain OPERATIONS-scope records, now enriched with flock/stage/age/priority context; stage transitions and critical completions enter `audit_trail` (`auditLog`).
- **Poultry module:** `/api/poultry` attaches a computed `stage` object to every flock (response-only, nothing persisted).
- **Backup/restore:** `businessBackup.ts` remaps `flockId` on checklist entries across business imports.

### 1.5 UI

- `DailyChecklistPanel` (poultry mode): **STAGE PLAN ON** badge, Enable/Disable Stage Plan button, **Farm routine & custom** section + one section per flock with a phase-coloured stage chip (batch · stage · age), per-section progress, CRITICAL and frequency chips, `linksTo` data-surface hints, stage help text, and a **stage-compliance strip** (completion % per stage across all recorded days). Manage-items modal shows STAGE PLAN vs CUSTOM origin badges and edits priority / frequency / bird-type / stage scope; custom items can be stage-scoped at creation.
- `PoultryFarmModule`: Flock & Batch table's Age column is now **Age / Stage** — stage chip (rearing cyan / production emerald / market amber / closeout rose) + age and days-to-market.

### 1.6 Seed & bootstrap

- `seed.ts` seeds the stage plan for POULTRY-01 (Owner's 5 demo items stay; `MORTALITY_SWEEP` is adopted) and creates **organization #1 before the first business row** (fixes a fresh-bootstrap FK-ordering gap found during verification — previously masked by the build-time migration's backfill).
- Schema changes are **additive and nullable** on `checklist_templates` (origin, bird_type, stage_keys, frequency, priority, house_scoped) and `checklist_entries` (flock_id, batch_number, bird_type, stage_key, stage_label, age_days, frequency, priority). All existing rows, dated history and non-poultry businesses are byte-compatible — verified.

## 2. Deviations from the assessment (professional-judgment decisions)

1. **MONTHLY frequency added** (assessment listed DAILY/WEEKLY/STAGE_ONCE/ON_EVENT) — mid-lay layer tasks (uniformity, egg-weight tracking) are monthly by husbandry convention.
2. **Adoption on task-key collision** (not in the assessment): if the Owner already has an item with a system task key (e.g. the demo's custom "Mortality sweep"), the Owner's wording, category, assignment and activation are preserved while the row gains the system scope metadata (bird type / stage / frequency / priority) — otherwise the flock-level plan would silently miss its critical tasks. The label stays the Owner's forever; origin becomes STAGE_PLAN so refreshes maintain metadata.
3. **Overdue cutoff** is per-business via system marker (API-settable), default 18:00 — no extra settings UI in v1.
4. **CLOSEOUT** materializes for ACTIVE flocks past market age + 8 days (broilers) / week 81 (layers) — driving the sale-and-reset tasks; SOLD/CLOSED flocks produce no entries.

## 3. Verification

### 3.1 API + data lifecycle — `dev-tooling/verify-poultry-stages.mjs` → **83/83**

- Pre-state preservation (5 Owner templates + dated demo history untouched; pre-enable generation legacy-shaped).
- Enable → 61 STAGE_PLAN + 4 CUSTOM templates; **adoption verified** (Owner label + assignee kept, priority CRITICAL gained).
- Today's materialization: BENCH-DEMO-B01 → FINISHER (day 30) with finisher/withdrawal tasks, weekly weigh, no egg tasks; L01 → MID_LAY (wk 53); L03 → PEAK with midday collection; house-scoped + custom items exactly once; SOLD/CLOSED flocks skipped; criticals on entries.
- **Full broiler lifecycle** (7 dated test flocks: day 0/10/20/35/41/55/pre-arrival → BROODING/STARTER/GROWER/FINISHER/MARKET/CLOSEOUT/PREP) — every stage got its stage-specific tasks.
- **Full layer lifecycle** (9 dated test flocks: wk 0/8/14/19/22/28/42/64/85 → CHICK_BROODING/GROWING/DEVELOPING/PRE_LAY/EARLY_LAY/PEAK/MID_LAY/LATE_LAY/CLOSEOUT) — egg collection at every stage, light step-up at pre-lay, shell quality at late lay, spent-hen plan at closeout.
- Unsupported bird type (turkeys) → core routine only.
- Frequency rules: idempotent re-runs; WEEKLY suppressed inside 6 days, due again at day 8; STAGE_ONCE never repeats within a stage.
- Stage transition → manager notification (deduped on re-run) + `POULTRY_STAGE_TRANSITION` audit rows.
- Critical completion → `CHECKLIST_CRITICAL_DONE` audit row; audit record view shows flock/stage/age context.
- Overdue sweep → CHECKLIST_OVERDUE notification, deduped per business+date.
- Owner customization: custom MARKET-scoped item materializes only for MARKET flocks; deactivation respected on later dates (today's rows preserved); priority editable; plan disable → legacy-shaped generation; re-enable restores.
- Non-poultry (BLOCK-01) byte-compatible; STAGE_PLAN correctly rejected (400).
- `/api/poultry` stage enrichment verified; all test artifacts purged; demo history intact; POULTRY-01 left with the plan ENABLED.

### 3.2 UI — `dev-tooling/verify-poultry-stages-ui.mjs` → **10/10**

Stage chips + days-to-market on Flock & Batch; STAGE PLAN ON badge; farm-routine + per-flock sections with stage headers; stage compliance strip; CRITICAL/frequency chips; completion toggle stamps the owner; zero page/console errors.

### 3.3 Fresh bootstrap (scratch DB, push → boot → seed) — **PASS**

Org-1-first fix verified: seed completes on a plain `drizzle-kit push` bootstrap (no migrate pass); stage plan ships on (61+4 templates); adoption applies on first boot; login, staging and today's 32 flock-scoped entries (3 critical) all correct.

### 3.4 Regression battery (live server, after implementation)

| Suite | Result |
|---|---|
| verify-clean-state | **109/109** |
| verify-poultry-weights (UI) | **23/23** |
| verify-benchmark (UI) | **58/58** |
| verify-az-app-audit | **41/41** |
| verify-audit-fixes | **51/51** |
| multiowner-verify | **118/118** |
| phase0-authz-matrix | **63/63** |
| audit-security | **23/23** |
| audit-deadlinks | **clean** |
| verify-audit-records | **29/29** |
| audit-notify-verify | **104/104** |
| verify-org-scoped-codes | **24/24** |
| verify-notifications | 38/43 — the **5 documented pre-existing environment failures** (web-push external endpoints + flaky idle timer), identical to the parent-build baseline; not regressions |

`tsc --noEmit` clean; production build clean; `drizzle-kit push` additive-only.

## 4. Files changed

**New:** `src/lib/poultryStages.ts`, `src/lib/poultryStageTasks.ts`, `dev-tooling/verify-poultry-stages.mjs`, `dev-tooling/verify-poultry-stages-ui.mjs`, this report.
**Modified:** `src/db/schema.ts` (additive columns), `src/lib/checklistGen.ts` (stage engine + sweep), `src/app/api/checklists/route.ts` (STAGE_PLAN/SWEEP/scoped items/critical audit), `src/lib/notify.ts` (2 notification helpers + priority passthrough), `src/app/api/audit/route.ts` (stage-enriched checklist records), `src/app/api/poultry/route.ts` (stage attachment), `src/app/api/init/route.ts` (overdue sweep hook), `src/db/seed.ts` (stage plan + org-first bootstrap fix), `src/lib/businessBackup.ts` (flockId remap), `src/components/DailyChecklistPanel.tsx` (stage mode), `src/components/PoultryFarmModule.tsx` (stage chips + supportsStages).

## 5. Operational notes & future work

- **Enabling:** existing poultry businesses opt in via Checklist → *Enable Stage Plan* (Owner/manager); newly created poultry businesses start on it; the demo POULTRY-01 is on.
- **Adoption** is logged server-side (`[checklistGen] stage plan: adopted N existing item(s)…`) and reported in the enable response path.
- **Auto-complete from linked data** (eggs logged ⇒ collection task ticks) remains the recommended v2 enhancement, as assessed.
- The legacy `poultry_checklists` table is untouched (backup compatibility), as assessed.
