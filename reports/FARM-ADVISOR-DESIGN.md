# Farm Advisor / Resource Person — Architecture Assessment & Recommended Design

**Date:** 2026-09-25 · **Status:** RECOMMENDATION ONLY (no implementation yet)
**Request:** Support an external Farm Advisor who occasionally visits but must remotely monitor daily operations (read-only) and add notes / observations / recommendations / follow-ups linked to farm, flock/batch, date and records. Notes must feed the existing AI system (with farm data) to summarize findings and surface insights to the Owner and authorized staff. Owner controls access; sensitive management, deletion, finance and user-permission functions restricted by default. Reuse existing permissions, Notifications, AI and Audit systems.

---

## 1. Executive summary

GoMina 360 already contains every building block this needs — the recommendation is to **introduce a first-class `FARM_ADVISOR` role with an Owner-controlled, per-farm-unit grant (with optional expiry), a dedicated `advisor_notes` + follow-up thread modeled on the proven `audit_reviews` / `audit_issue_updates` pattern, and AI analysis that reuses the existing `dailyNotesAi` / `business_insights` pipeline** — not a parallel system.

The single most important security finding from the assessment: **business access today equals data access.** `readInitSnapshot()` + `/api/init` ship transactions, employees, credit sales and the user directory to *any* user with `canAccessBusiness`. So "give the advisor read access to the poultry dashboard" via the existing extra-access grant would silently expose finance/HR data in the API payload even with the tabs hidden. The design therefore adds a **server-side payload slimming + route guards for the advisor role** — read-only must be enforced in the API, never only in the UI.

| Area | Recommendation |
|---|---|
| Identity | New `FARM_ADVISOR` role value (external professional, not staff) |
| Access | New `advisor_assignments` grant (per business unit, optional scope + expiry), written by the OWNER only; grants the read scope, revocable instantly |
| Read scope | Farm dashboards, flocks/batches, daily checklists (view), production, feed/water, growth, FCR, mortality, health, water quality, Benchmark Performance, alerts, AI daily insights — **read-only** |
| Blocked by default | All mutations except advisor notes; finance, payroll, employees, suppliers, assets, CCTV, users console, inventory management, feed-mill formulation costs, deletions, exports |
| Write scope | Advisor notes / observations / recommendations / follow-ups (with photos) linked to farm + flock/batch + date + optional record |
| AI | Reuse `dailyNotesAi` (advisor-aware categories) + `business_insights` folding; cross-reference notes with flock KPIs (weight vs target, FCR, mortality, feed rate); surface in existing AI surfaces |
| Notifications | New types through the existing bell + web-push machinery, escalation pattern copied from audit issues |
| Audit | `auditLog` rows for grants and every note lifecycle step; immutable note-update thread |
| UI | Same farm modules in read-only mode (write controls hidden) + "Advisor Notes & Guidance" panel on the farm dashboard + Advisor tab for the advisor's cross-farm console |

---

## 2. Assessment of the existing architecture (what we build on)

### 2.1 Identity, roles and permissions — `src/lib/auth.ts`, `src/db/schema.ts` (users)

- Roles today: `OWNER`, `GENERAL_MANAGER`, `BRANCH_MANAGER`, `WORKER` (free-text column — **a new role value is additive, no migration of existing data**).
- Business visibility = primary assignment ∪ `user_business_access` ("extra access" grants the OWNER already manages in the UI) ∪ managed units, always intersected with the user's organizations (`accessibleBusinessIds` / `canAccessBusiness`).
- A mature set of OWNER-granted capability flags already exists (`canManageRecords`, `canDeleteInventory`, `canManageUsers`, `canManageAuditors`, `canViewFinance`, `canManageOnline`, …) — all default **false**, OWNER-controlled. The Advisor needs none of them; the pattern proves the governance model the Owner expects.
- Sessions: 24-hour idle retirement, per-token cache, org-scoped. Works unchanged for an advisor.

### 2.2 Audit & Review — the closest existing analog (`audit_assignments`, `audit_reviews`, `audit_issue_updates`, `/api/audit`, `AuditCommandCenter`, `MyAuditIssues`)

This system already solves 80% of the Advisor problem and is the pattern to copy (not extend):

- **Assignment-only access**: no role gets audit rights by default; the OWNER grants per-business, per-branch, per-module assignments; a `scopeFor()` resolver enforces it server-side (`src/app/api/audit/route.ts`).
- **Record-linked issues**: any record can be referenced via `recordType + recordSource + recordId` with a `resolveRecord()` switch that snapshots title/ref — the exact linking model advisor notes need (extend it with `POULTRY_FLOCK`, `AQUA_BATCH`, `CHECKLIST_ENTRY`, `FEED_LOG`, `WEIGHT_SAMPLE`).
- **Lifecycle + conversation**: FLAGGED → UNDER_REVIEW → CORRECTION_REQUIRED → RESOLVED → VERIFIED with an immutable per-issue update thread, evidence photos, and assignment routing.
- **Escalation**: branch managers always notified; OWNER pulled in on HIGH/CRITICAL (`auditEscalationRecipients` in `src/lib/notify.ts`) — the right fan-out model for advisor recommendations.
- **Why not reuse it directly?** Semantics differ: audit issues are compliance flags with correction workflow owned by the audit center UX and its suites; advisor notes are professional guidance with a softer follow-up lifecycle. Overloading `audit_reviews` would entangle the Advisor with audit permissions, confuse the Audit Command Center, and couple two test batteries. A sibling table modeled on it is cheap and keeps both clean.

### 2.3 Daily Notes + AI — the analysis engine already exists (`daily_notes`, `business_insights`, `/api/daily-notes`, `src/lib/dailyNotesAi.ts`)

- Staff already file end-of-day notes; `analyzeNote()` produces summary, categorized issues (`[{category,label,severity,matches}]`), severity `INFO|WATCH|URGENT`, flags; `foldNoteIntoInsights()` maintains a rolling narrative, issue register with recurrence counts, category trends and a capped history in `business_insights` — "the AI's continuously-updated memory of a business".
- The AI Advisor console (`/api/ai`, `AiAdvisorView`) is OWNER/GM-only, org-scoped, and generates insight rows from real baselines. Daily-note summaries already surface on the module dashboards.
- **This is precisely the "analyze notes together with farm data → summarize findings, identify concerns, generate insights" machinery the request asks for.** The design feeds advisor notes into the same pipeline with advisor-aware categories, and cross-references the flock's benchmark KPIs.

### 2.4 Farm data surfaces the Advisor needs (already read-capable)

- **Poultry**: `PoultryFarmModule` (flocks, egg/meat production, feed & water logs, mortality, growth analytics `PoultryGrowthAnalytics`, Benchmark Performance panel + per-flock plans, stage-aware daily checklist with completion status, alerts grid, health score).
- **Aquaculture**: `AquacultureModule` (batches, ponds, feed logs, water quality, growth analytics, fish Benchmark Performance panel with scorecard/trends/projection, AI Smart Alerts grid).
- Write actions in these modules are already gated by `MANAGE_ROLES` (OWNER/GM/BRANCH_MANAGER) or `canManageRecords` in the UI (e.g. `benchCanManage` in `PoultryFarmModule`), and the benchmark manager drawers are gated — but several APIs still trust `canAccessBusiness` alone, which the read-only guard must close (§3.4).

### 2.5 The gap (the one real security issue)

`/api/init` returns the full snapshot — transactions, employees, user directory, credit sales, suppliers — for every accessible business (`readInitSnapshot()` §2 statement lists; scoping code at `src/app/api/init/route.ts:137+`). Likewise `/api/transactions`, `/api/employees`, `/api/payroll` etc. authorize on `canAccessBusiness` only. **An advisor granted business read access would receive financial and personal data in payloads even with tabs hidden.** Any advisor design must slim payloads and guard routes server-side.

---

## 3. Recommended design

### 3.1 Identity: a new `FARM_ADVISOR` role

- Add `FARM_ADVISOR` as a role value (users.role is text; additive). Only the OWNER (or a GM with `canManageUsers`) may create/ deactivate advisor accounts — extend the existing role allow-list in `/api/users` (OWNER-only for this role).
- The advisor is a real user (same login, same 24h session policy, same password reset flows) — no magic links, no shared accounts.
- Rationale vs "any user can be an advisor": a dedicated role gives one-check server enforcement (`isFarmAdvisor(user)`), a dedicated workspace, and keeps staff roles' semantics untouched. `WORKER` would trap the advisor in `WorkerDashboard`; `BRANCH_MANAGER` implies management power.

### 3.2 Access: `advisor_assignments` (Owner-controlled, scoped, expirable)

New table, modeled on `audit_assignments`:

```
advisor_assignments (
  id, user_id, user_name, business_id, branch_code (null = all branches),
  scope_note           -- free text: "Growth & health review only"
  valid_until          -- optional DATE: occasional visitors shouldn't keep
                         -- standing access forever; expired = revoked
  is_active, granted_by_user_id/name/role, created_at, updated_at
)
```

- The grant action (new `POST /api/users` action or a small `/api/advisor` route) writes the assignment **and** the `user_business_access` row in one transaction, and revocation removes both — keeping `accessibleBusinessIds` (and thus the whole app) consistent.
- The Owner manages grants in **Users & Access** (a "Farm Advisor" section reusing the existing grant/checkbox console UX used for extra business access and auditor grants). Every grant/revoke writes an `auditLog` row (`ADVISOR_ACCESS_GRANTED` / `ADVISOR_ACCESS_REVOKED` with scope + expiry).
- Optional: allow one advisor to be scoped per business type — practically the Owner just grants the farm units (POULTRY-01, AQUA-01, LIVESTOCK-01) and nothing else.

### 3.3 Permission matrix

| Surface | Advisor |
|---|---|
| Farm dashboard KPIs, health score, alerts grid | ✅ read |
| Flocks / batches (incl. benchmarks, projections) | ✅ read |
| Daily checklist plan + completion status | ✅ read |
| Daily activities: feed/water, production, mortality, weight samples, water quality, harvests | ✅ read |
| Growth analytics + Benchmark Performance (scorecards, trends, history bands, alerts) | ✅ read (manager drawers hidden) |
| AI daily summary / business insights | ✅ read |
| Advisor notes: create, edit-own-within-window, respond, close own follow-ups | ✅ write (the **only** write) |
| Completing/editing checklist entries, recording any farm data | ❌ 403 |
| Feed Mill / Block Mixing (formulations, costs) | ❌ hidden (business-sensitive cost data) |
| Finance, transactions, payroll, employees, suppliers, assets, CCTV, inventory management | ❌ 403 / not in payload |
| Users & Access, permissions, grants (other than viewing own) | ❌ |
| Any DELETE anywhere; exports | ❌ |
| Notifications (own bell), push subscription | ✅ (existing machinery) |

### 3.4 Read-only enforcement — server-side first

1. **Init payload slimming**: in `/api/init`, when `me.role === "FARM_ADVISOR"`, drop `transactions`, `creditSales`, `employees`, `users` (except self), `suppliers`, `assets`, `customers`, `scenarios`, `integrations`; keep `businesses` (granted units), `businessMetrics`, `specializedLogs` (farm production), `checklistTemplates/Entries`, `inventory` (stock levels only — useful for feed availability; no costs column exposure is a UI concern, costs live on items — **recommend dropping `costPrice` fields for advisors** or excluding inventory if simpler), `aiInsights`. This is a post-filter on the already-scoped snapshot — one place, no query rewrites.
2. **Route guards**: a tiny shared helper `assertFarmAdvisorNotMutating(user)` (or role check inside each domain route's POST/PATCH/DELETE) returns 403 for `FARM_ADVISOR` on `/api/poultry`, `/api/aquaculture`, `/api/checklists`, `/api/transactions`, `/api/employees`, `/api/payroll`, `/api/sales`, `/api/inventory` mutations. Reads stay allowed. The `recordedByRole` fields in those routes make it obvious where mutations enter.
3. **UI hiding (defense-in-depth, not the security boundary)**: one `isAdvisor` boolean from `currentUser` flows into `PoultryFarmModule` / `AquacultureModule` / `DailyChecklistPanel` / benchmark panels to hide record buttons, forms, manager drawers, CSV export; mount the read-only "Advisor Notes" panel instead. The modules already take `currentUser` and gate similarly on role/flags.

### 3.5 Advisor notes & follow-ups — data model

```
advisor_notes (
  id, business_id, branch_code,
  note_date               -- the farm day the observation is about
  flock_id / batch_id     -- optional: poultry_flocks.id or aquaculture_batches.id
  record_type, record_source, record_id, record_ref   -- optional link to any
                         -- record (checklist entry, feed log, weight sample,
                         -- harvest…) — resolveRecord() pattern
  category               -- GROWTH | FEED_NUTRITION | HEALTH_DISEASE | MORTALITY |
                         -- WATER_QUALITY | BIOSECURITY | STOCKING | ENVIRONMENT |
                         -- MANAGEMENT | MARKET_TIMING | GENERAL
  priority               -- LOW | MEDIUM | HIGH | CRITICAL (audit-style)
  title, body            -- observation / recommendation detail
  photo                  -- optional data-URL (pattern exists: audit evidence,
                         -- employee photos)
  follow_up_status       -- OPEN | IN_PROGRESS | ADDRESSED | CLOSED
  follow_up_due_date     -- optional
  ai_summary, ai_issues, ai_severity, ai_flags      -- analysis snapshot
  author_user_id/name/role,
  created_at, updated_at
)
advisor_note_updates (   -- immutable thread, modeled on audit_issue_updates
  id, note_id, actor_user_id/name/role,
  action        -- ADD | EDIT | RESPOND | STATUS_CHANGE | CLOSE
  status_from, status_to, note, photo, created_at
)
```

Lifecycle is intentionally lighter than audit issues: the *advisor* (or staff) marks a follow-up ADDRESSED/CLOSED; staff respond in the thread. Nothing is ever hard-deleted (withdraw = status + update row), preserving history for the AI.

### 3.6 Workflow

1. **Onboard** (once): Owner creates the advisor user (role `FARM_ADVISOR`) → grants farm units with optional expiry + scope note. Advisor receives credentials out-of-band (same as staff onboarding today).
2. **Remote monitoring** (any time): advisor logs in → sidebar shows exactly the granted farm units → opens a unit → sees the real farm dashboard in read-only mode: KPIs, flocks/batches, checklist compliance for today, feed/water, growth, benchmark scorecards vs targets/history, alert grid, and the AI daily summary.
3. **Note** (visit or remote): from the Advisor Notes panel — or contextually from a flock row / benchmark variance / a checklist day ("Add advisor note on this") — compose: date, flock/batch, optional record link, category, priority, observation, recommendation, follow-up + due date, photo.
4. **AI analysis (automatic)**: the note is analyzed (§3.7), stored with its AI snapshot, and folded into the business insights. If severity is WATCH/URGENT — or the AI finds data corroboration (e.g. note says "growth slowing" *and* the flock's weight variance is off-track) — the insight is highlighted.
5. **Routing**: OWNER + managers of the unit get a bell/push notification (`ADVISOR_NOTE_ADDED`, escalation on HIGH/CRITICAL mirrors `auditEscalationRecipients`); if the note is linked to an assigned record/worker, that staff member is notified too.
6. **Response & closure**: staff respond in the thread (notification back to the advisor: `ADVISOR_NOTE_RESPONSE`); follow-up status changes notify both sides; every step writes `auditLog` + an immutable `advisor_note_updates` row.
7. **Digest**: the Owner/GM AI Advisor console gains an "Advisor findings" section; the existing daily-insights panel on the farm dashboard shows the advisor's rolling summary next to staff notes.

### 3.7 AI integration (reuse `dailyNotesAi` + `business_insights`)

- Add advisor-aware categories to the existing `IssueCategory` union and analysis dictionaries (disease suspects, water quality, feed conversion, stocking density, biosecurity, market timing…).
- `analyzeNote()` runs on advisor notes with the advisor's category + priority as priors; results are stored on the note (`ai_summary`, `ai_issues`, `ai_severity`, `ai_flags` — same shape as daily notes) **and** folded into `business_insights` via the existing `foldNoteIntoInsights()` (recurrence counting means "advisor has flagged feed quality 3×" accumulates automatically).
- **Notes + farm data together** (the request's key ask): a deterministic cross-reference step at note time pulls the linked flock's benchmark KPIs (current vs target weight/SGR/FCR/feed-rate/survival from `poultryBenchmarking` / `fishBenchmarking`) and recent mortality/water-quality readings, and appends a data-grounded addendum to the note's AI snapshot ("Note mentions slow growth; data shows −8% weight vs target, FCR 1.59 vs 1.23 — corroborated"). No LLM dependency, same honesty guarantees as the rest of the system.
- The AI Advisor console (`/api/ai` GET, `AiAdvisorView`) includes advisor-note digests in its generated analyses (data already org-scoped); OWNER/GM only, unchanged.

### 3.8 Dashboard integration

- **Advisor side**: same module components, read-only mode; a dedicated **Advisor Console tab** (visible only for `FARM_ADVISOR`) listing, across their granted units: open follow-ups (with due dates), their recent notes, recent HIGH/CRITICAL alerts — the "one screen before a farm visit" view. Deep-links into flocks/records reuse the existing focus patterns.
- **Owner/staff side**: an **"Advisor Notes & Guidance" panel** mounted on the farm Dashboard tab (above/beside the AI daily summary — same mounting pattern as the Benchmark Performance panels): latest notes with severity chips, follow-up status, respond button; OPEN follow-ups also appear in the existing alert grid (merged exactly like benchmark alerts — no second alert system).

### 3.9 Notifications (existing machinery)

New types only (text column — additive): `ADVISOR_NOTE_ADDED`, `ADVISOR_NOTE_RESPONSE`, `ADVISOR_FOLLOWUP_STATUS`, `ADVISOR_FOLLOWUP_DUE` (optional, via the existing daily-sweep pattern used by `sweepOverdueCritical`). Insert + `pushAfterBell` + bell deep-links (`recordType: "ADVISOR_NOTE"`) — all existing infrastructure. Fan-out: OWNER + unit managers (+ linked record's assignee); HIGH/CRITICAL additionally to the OWNER per the audit escalation rule.

### 3.10 Audit trail (existing `auditLog`)

`ADVISOR_ACCESS_GRANTED / REVOKED`, `ADVISOR_NOTE_ADDED / UPDATED / WITHDRAWN`, `ADVISOR_FOLLOWUP_STATUS_CHANGED`, `ADVISOR_NOTE_RESPONSE` — business-scoped, actor-stamped, visible in the existing Audit Command Center by adding `ADVISOR_NOTE` to `resolveRecord()` so advisors' actions are reviewable like every other record. Reads are not logged (consistent with the rest of the app).

### 3.11 Security & privacy

- **Data minimization**: the init slimming (§3.4.1) is the boundary; no finance/HR/personal data reaches the advisor's browser. Advisor sees operational farm data only.
- **Expiry + revocation**: optional `valid_until` auto-revokes; the Owner can revoke instantly; both sync `user_business_access`.
- **No standing management power**: advisor starts with every capability flag false; role check blocks mutation routes even if a flag were ever granted by mistake.
- **Integrity**: notes are never hard-deleted; immutable update thread; audit trail rows for every action.
- **Same session policy** (24h idle) and login hardening as everyone else.

### 3.12 Additional features worth including (practical value, low cost)

1. **Visit report export** — one click: the advisor's notes for a date range + the flocks' benchmark scorecards, printable (CSV like the benchmark export, or a print stylesheet) — the "consultant deliverable".
2. **Photos on notes** — data-URL pattern already used (audit evidence, employee photos).
3. **Quick-add from variance chips** — "Ask advisor about this" affordance on benchmark variance rows pre-fills flock + record context.
4. **Advisor-visible checklist compliance streak** — the stage-plan compliance already computed; surface read-only.
5. **Onboarding note per grant** — the `scope_note` shows in the advisor's console ("You are engaged for growth & health review").

---

## 4. What we deliberately do NOT build (anti-duplication)

- **No second alert system** — advisor notes surface through the existing alert grids and bell.
- **No new AI engine** — extend `dailyNotesAi` + `/api/ai` consumption; same deterministic, data-grounded approach.
- **No new permission framework** — role + assignment + existing flags + `canAccessBusiness`.
- **No forked dashboards** — the same farm modules render read-only for the advisor.
- **No reuse of `audit_reviews` for advisor notes** — sibling tables, shared *patterns* (record linking, immutable thread, escalation) instead of shared rows.

---

## 5. Implementation plan (when approved)

**Phase 1 — identity, access & read-only enforcement (security core)**
- `schema.ts`: `advisor_assignments`, `advisor_notes`, `advisor_note_updates`; `FARM_ADVISOR` role support in `/api/users` (OWNER-only), grant/revoke action syncing `user_business_access`.
- `/api/init` advisor payload slimming; `assertAdvisorReadOnly` guards on domain mutation routes; `isAdvisor` UI read-only mode in farm modules + sidebar.
- Audit rows for grants; `resolveRecord` extension.
- *Tests:* new `verify-farm-advisor.mjs` section A (authz matrix: every mutation route → 403, reads → 200, payload slimming, grant/revoke/expiry), `phase0-authz-matrix.mjs` extension, `audit-atoz` walk with an advisor fixture.

**Phase 2 — notes, follow-ups & notifications**
- `/api/advisor-notes` (GET scoped list, POST create, PATCH respond/status) with flock/batch/date/record links, photos, immutable updates, notification fan-out (new types), bell deep-links, alert-grid merge, Advisor Notes panel on farm dashboards + Advisor Console tab.
- *Tests:* suite sections M (CRUD + links + thread + status), N (notifications + escalation), U (browser walk desktop + phone, read-only assertions, zero page errors), T (audit rows).

**Phase 3 — AI integration & polish**
- `dailyNotesAi` advisor categories; fold advisor notes into `business_insights`; benchmark-KPI corroboration addendum; AI console "Advisor findings"; visit-report export; quick-add from variance chips.
- *Tests:* suite sections AI (analysis snapshots, insight folding, corroboration) + regressions of daily-notes, benchmark, poultry/fish suites; docs (`reports/FARM-ADVISOR-IMPLEMENTATION.md`).

Estimated footprint: ~6 new/edited API route files, 3 tables, 2 new panels + 1 tab, one lib extension — well within the established patterns; every phase independently shippable and testable.

---

## 6. Open questions for the Owner (decide before Phase 1)

1. Should the advisor see **feed formulation costs** (Feed Mill) or is the feed *usage* history enough? (Recommendation: usage only.)
2. Follow-up due-date reminders in the bell — wanted, or noise? (Recommendation: yes, weekly digest style.)
3. Should more than one advisor be supported simultaneously? (Design supports N advisors already.)
4. Any need for the advisor to see **livestock** (LIVESTOCK-01) and future units too, or poultry + aquaculture only for now? (Grant model is per-unit — no code difference.)
