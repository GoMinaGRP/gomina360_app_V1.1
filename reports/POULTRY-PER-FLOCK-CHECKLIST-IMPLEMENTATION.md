# Poultry Per-Flock Continuous Lifecycle Checklist — Implementation Report

**Date:** 2026-09-24 · **Build:** post-`bba1d69` (branch `arena/01a0c754-gomina360-app-v1-1`)
**Scope:** 2nd-generation poultry checklist request — every flock/batch gets its own continuous, age-aware lifecycle checklist; Owner chooses/edits the plan per flock; nothing ever restarts; full multi-flock, permission, notification, audit and mobile verification.

---

## 1. What was requested vs. delivered

| Requirement | Delivered |
|---|---|
| Every flock gets its own continuous checklist covering the complete lifecycle | Each flock materializes its own dated entries every day from placement to closeout; the plan auto-advances with age/stage — no restarts, ever |
| Broilers organized by **Day** (Day 1 → market/closeout) | Broiler schedule = Day 1 → Day 56 (market + 14 closeout window); UI shows prominent `DAY N` badges, lifecycle timeline by day |
| Layers primarily by **Week** (through laying/closeout), retaining essential daily routine checks | Layer schedule = Week 1 → Week 86; `WEEK N` badges; DAILY routine tasks materialize every week (checks retained) while weekly/monthly/stage-once tasks slot by week |
| On flock create/start: choose **recommended system plan**, a **saved custom template**, or **customize the recommended** | New-flock form shows a "Lifecycle checklist plan" picker (Recommended / Saved template / Customize now); applied **atomically at creation** server-side; also switchable any time afterwards |
| Tasks/timing/frequency/priority/assignments modifiable per flock | `FlockPlanEditor` modal: edit label, category, frequency, priority, stage scope, assignee, pause/resume, add/remove per-flock items |
| Customized plans **savable as reusable templates** | "Save as reusable template" snapshots the flock's effective plan (bird-type filtered, farm-wide customs included) into `checklist_plan_templates`; applicable to any future flock |
| Once started: continues automatically, no restart; shows current Day/Week + stage, today's tasks, completed history, future scheduled tasks | Today view (current tasks + stage) + **Lifecycle view** (stage timeline bar with "now" marker, current slot, upcoming auto-scheduled slots, recorded-days count). Completed history is never rewritten |
| Filters for **Bird Type** and **Batch/Flock incl. All Flocks** | Checklist panel: Bird Type filter (All/Broilers/Layers) + Flock filter (All Flocks + every flock with live age); focused flock view hides farm-wide rows |
| Every entry/completion/notification/audit linked to the correct flock | Entries carry `flockId`/batch/stage/age (existing); overdue notifications now grouped **per flock** (`recordRef checklist-overdue:{biz}:{flockId|farm}:{date}`, `recordId` = flock id); audit rows carry `POULTRY_FLOCK` record ids |
| Reuse the unified engine, no duplicate systems | Same `/api/checklists` engine, same generator (`generateEntriesForDate`), same permission gate; the per-flock plan plugs in via the effective-plan resolver |
| One flock's customization cannot alter another flock or the original template | **Copy-on-write**: forking copies system rows into flock-private rows; farm-wide custom items still apply dynamically; taskKey collisions resolve in the flock row's favour; system plan and other flocks byte-identical (verified) |
| Restrict checklist management to Owner + authorized users; others view or complete assigned tasks | Manage ops (fork/apply/reset/save-template, item CRUD, assignment) gated to OWNER / GENERAL_MANAGER / BRANCH_MANAGER server-side; workers may complete only **unassigned or self-assigned** entries (new PATCH ENTRY rule) |
| Record important changes in Audit Trail | New audit actions: `POULTRY_FLOCK_PLAN_FORKED / _APPLIED / _RESET / _SAVED_TEMPLATE`, `POULTRY_PLAN_TEMPLATE_DELETED`, `CHECKLIST_ITEM_ADDED_FLOCK`, `CHECKLIST_ITEM_UPDATED`, `CHECKLIST_ASSIGNMENT_CHANGED`, `CHECKLIST_ITEM_DELETED`, `POULTRY_STAGE_PLAN_ENABLED / _DISABLED`, plus the existing `CHECKLIST_CRITICAL_DONE` |
| Fully test concurrent broiler + layer flocks across the lifecycle; notifications, audit, permissions, desktop + mobile | 95/95 API checks + 24 UI checks (incl. 375 px mobile) + 84/84 + 10/10 prior-suite regressions — see §8 |

---

## 2. Data model (`src/db/schema.ts`)

```
checklist_templates.flockId     → new nullable column: non-null rows are a FLOCK-PRIVATE plan row
checklist_plan_templates        → saved reusable plan snapshots
  (id, businessId, branchCode, name, birdType, items jsonb, createdByName/Role, timestamps)
checklist_flock_plans           → per-flock plan state (one row per flock, sparse — created on first plan action)
  (id, businessId, branchCode, flockId UNIQUE, batchNumber, source SYSTEM|TEMPLATE|CUSTOM,
   planTemplateId/Name, startedBy*/updatedBy* Name/Role, timestamps)
```

- Pushed to the live DB with `drizzle-kit push`; the additive production reconciler
  (`dev-tooling/migrate-production-schema.mjs`) covers the new tables automatically (schema.ts is its
  single source of truth) and now also creates `business_id` / `flock_id` performance indexes on the
  new tables.
- `businessBackup.ts` includes both new tables in business cloning with FK remapping
  (`flockId` → cloned flock, `planTemplateId` → cloned plan template).

## 3. Plan semantics — copy-on-write (`src/lib/poultryStages.ts` + `checklistGen.ts`)

The flock's **effective plan** (pure, client-shared helper `effectivePlanItemsForFlock` — the
generator delegates to it, so UI and engine can never disagree):

1. **Flock rows exist** (`checklist_templates.flockId = flock.id`, active) → they **replace** the
   system stage plan for that flock.
2. **No flock rows** → the recommended system stage plan applies (all pre-existing flocks keep
   working exactly as before — source SYSTEM by default).
3. **Farm-wide scoped custom items** (birdType/stage-scoped, `flockId` null) still apply **on top**;
   taskKey collisions resolve in the flock row's favour.
4. Bird-type filtering happens at materialization *and* at template-snapshot time (a layer flock's
   saved template never carries broiler-only tasks).

Lifecycle projection (`buildLifecycleSchedule`, pure): broilers → 56 day-slots (Day 1 → Day 56);
layers → 86 week-slots (Week 1 → Week 86). Cadence rules mirror the generator: DAILY every slot,
WEEKLY every 7 days (layers: every week), MONTHLY every 28 days, STAGE_ONCE at its stage's first
slot. Display helpers `displayDayOf`/`displayWeekOf` are 1-based (Day 1 = placement day; Week 1 =
first 7 days) and layer stage labels use 1-based display weeks (Wk 1–7, 8–13, …, 82+; age-day
windows unchanged, so all prior data stays valid).

## 4. API changes (`/api/checklists`, `/api/poultry`)

**GET `/api/checklists`** additions: `flockPlans[]`, `planTemplates[]`, `poultryFlocks[]` (minimal
list for the filters), `cutoffHour`.

**POST `FLOCK_PLAN`** (manage roles only, poultry businesses only, flock verified ∈ business):
- `fork` — copy the bird-type-matched system plan into flock-private rows (idempotent)
- `apply_template` — replace the flock's rows with a saved template's items
- `reset` — delete the flock's rows, return to the recommended system plan (history preserved)
- `save_as_template` — snapshot the flock's effective plan as a reusable template

**POST `TEMPLATE`** now accepts `flockId` (auto-forks first so a single added item can never wipe a
flock's system plan). **DELETE** accepts `?entity=PLAN_TEMPLATE`. **PATCH `TEMPLATE`** audits poultry
edits incl. assignment changes. **PATCH `ENTRY`** — new rule: non-managers may complete/re-open only
entries that are unassigned or assigned to **them**.

After every plan change, today's **incomplete** entries for that flock are dropped and re-materialized
from the new plan (same-day edits are WYSIWYG); completed history is never touched.

**POST `/api/poultry` FLOCK** accepts `checklistPlan: { mode: RECOMMENDED | TEMPLATE | CUSTOMIZE,
planTemplateId }` — applied atomically right after creation (manage roles only; ignored otherwise).

## 5. Notifications (`src/lib/notify.ts`, `checklistGen.ts`)

The overdue-critical sweep now groups **per (business, flock)**: one bell row set per flock+date,
`recordRef = checklist-overdue:{biz}:{flockId|farm}:{date}`, `recordId` = flock id, flock-named
title. Deduped per flock+date on re-runs (legacy refs also honoured to avoid double-notify on the
upgrade day). Fixed a latent default bug: a **missing** cutoff marker now falls back to the 18:00
default (`Number(null) === 0` previously moved the sweep to midnight on fresh installs).

## 6. UI (`DailyChecklistPanel`, `PoultryFarmModule`, new `FlockPlanEditor`)

- **Checklist panel:** Bird Type + Flock filters (incl. All Flocks), Today ↔ **Lifecycle** view
  toggle, prominent `DAY N` / `WEEK N` badges per flock section, plan-source chips
  (RECOMMENDED / TEMPLATE / CUSTOMIZED), per-flock **Plan…** button.
- **Lifecycle view:** per-flock stage timeline bar with a "now" marker, current slot with its
  planned tasks, upcoming auto-scheduled slots, recorded-days count and the no-restart note.
- **FlockPlanEditor modal** (Owner/managers): recommended-plan explainer with
  Customize/Apply-template actions, or the flock's private rows with full inline editing
  (label, category, frequency, priority, stage scope, assignee), pause/resume, add/remove,
  reset-to-recommended (two-step confirm), save-as-template, apply/delete saved templates.
- **PoultryFarmModule:** FLOCKS tab gains a **Checklist Plan** column (badge + Plan… button);
  the new-flock form gains the **Lifecycle checklist plan** picker; flock ages display 1-based
  Day/Week everywhere.

## 7. Verification

| Suite | Result |
|---|---|
| `dev-tooling/verify-flock-plans.mjs` (NEW — 95 checks: create-time plan selection, fork/apply/reset/save-template, per-flock item CRUD + audit, concurrent broiler+layer isolation, permission matrix incl. self-assignment rule, per-flock overdue notifications + dedupe, audit coverage, pure-lib lifecycle & cadence rules) | **95/95** |
| `dev-tooling/verify-flock-plans-ui.mjs` (NEW — 24 checks: plan column/badges, plan picker on create → CUSTOMIZED flock end-to-end, filters, age badges, lifecycle view, plan editor add/reset, 375 px mobile incl. no horizontal overflow) | **ALL PASS** |
| `dev-tooling/verify-poultry-stages.mjs` (regression, updated §6/§7 for the audit-record window + per-flock refs; self-healing cleanups) | **84/84** |
| `dev-tooling/verify-poultry-stages-ui.mjs` (regression) | **ALL PASS (10)** |
| `audit-notify-verify`, `phase0-authz-matrix`, `audit-security`, `audit-deadlinks` | **104/104 · 63/63 · 23/23 · clean** |
| `verify-poultry-analytics`, `verify-poultry-weights`, `verify-poultry-expense` | **32/32 · 23/23 · 26/26** |
| Fresh-bootstrap scratch DB (drizzle-kit push → migrate → seed → first-load) | **PASS** — 61 stage + 4 custom templates, 3/3 flocks staged, 38 today entries (32 flock-scoped, 3 critical), `cutoffHour` default 18 |

Notes: battery runs in multiple orders stay green; test suites are now **self-healing** (pattern-based
cleanup purges any leftovers from crashed runs — verified against real leftovers from an interrupted
run during development). All VFY/UI-VFY test rows purged; demo POULTRY-01 left with the stage plan
**ENABLED**, 61 active system items + 4 Owner customs, demo history intact.

## 8. Files changed

- `src/db/schema.ts` — `checklist_templates.flockId`, `checklistPlanTemplates`, `checklistFlockPlans`
- `src/lib/poultryStages.ts` — 1-based layer week labels, `displayDayOf`/`displayWeekOf`,
  `effectivePlanItemsForFlock` (pure), `buildLifecycleSchedule` (pure)
- `src/lib/checklistGen.ts` — per-flock effective plan in generation, flock-plan lifecycle ops
  (fork/apply/reset/save-as-template), per-flock overdue sweep, cutoff-default fix
- `src/lib/notify.ts` — per-flock overdue notification grouping
- `src/app/api/checklists/route.ts` — FLOCK_PLAN entity, PLAN_TEMPLATE delete, flock-scoped TEMPLATE,
  entry assignment rule, audit rows, GET additions
- `src/app/api/poultry/route.ts` — atomic checklist-plan selection at flock creation
- `src/components/FlockPlanEditor.tsx` (NEW), `DailyChecklistPanel.tsx`, `PoultryFarmModule.tsx`
- `src/lib/businessBackup.ts` — new tables + FK remaps
- `dev-tooling/migrate-production-schema.mjs` — perf indexes for the new tables
- `dev-tooling/verify-flock-plans.mjs` (NEW), `dev-tooling/verify-flock-plans-ui.mjs` (NEW),
  `verify-poultry-stages.mjs` (§6/§7 updates + self-healing cleanup)
