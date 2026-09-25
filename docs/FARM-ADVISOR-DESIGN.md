# External Farm Advisor / Resource Person — Architecture Assessment & Recommended Design

**Status:** proposal for approval — *nothing implemented yet*
**Author:** Arena agent · 2026-09-24
**Scope:** GoMina 360 (`gomina360_app_V1.1`), primary target = Poultry farms, designed to
generalise to Aquaculture / Livestock without a second build.

---

## 1. Executive summary

GoMina 360 already contains **every building block** the Advisor function needs. The
right answer is therefore *not* a new sub-system but a thin, well-guarded composition of
four existing ones:

| Need | Existing system to reuse |
|---|---|
| Owner-controlled, scoped, revocable access for an outsider | **Auditor grant model** (`audit_assignments`, `canManageAuditors`, assignment-only tab in `Sidebar`/`GoMinaApp`) |
| Notes that the AI reads and folds into a living business memory | **Daily Notes + `dailyNotesAi.ts` + `business_insights`** (deterministic taxonomy, severity, rolling narrative) |
| Getting findings in front of the Owner & staff | **`notifications` + `pushAfterBell`** (bell + web push + deep links) |
| Accountability / follow-ups that someone must close | **Audit issue pipeline** (`audit_reviews` → `audit_issue_updates`, FLAGGED → … → VERIFIED) |
| Immutable record of who did what | **`auditLog()` → `audit_trail`** |
| Benchmarks, FCR, growth, alerts to advise against | **`poultryPerformance.ts`** (Cobb/Ross/Isa-Brown target curves, lay %, FCR) and **`poultryAnalytics.ts`** (`analyzePoultry` → alerts, health score, metrics) |

**Recommended shape (one line):** a new **`ADVISOR` user role** (zero implicit access) +
an **`advisor_assignments` grant** (farm/branch/flock/module scope + engagement window +
cost-visibility switch), whose *only* write capability is **`advisor_notes`** — analysed by
the existing `dailyNotesAi` engine, correlated with live flock data by a new small
`advisorAi.ts`, published as `ai_insights` + bell/push notifications, with optional
escalation into the **existing** audit-issue pipeline when staff action is required.

**Most important finding (must be fixed as part of this work):** ~25 mutating API routes
gate writes **only** on `canAccessBusiness()` — e.g. `POST /api/poultry`, `/api/checklists`,
`/api/sales`, `/api/daily-notes`, `/api/assets`, `/api/transport`. Granting an Advisor
business access with today's code would silently grant them **write** access to flocks,
feed, health and production records. Read-only must therefore be enforced by a **central
server-side choke point keyed on identity**, not by hiding buttons.

---

## 2. What the architecture actually gives us (assessment)

### 2.1 Identity, tenancy and access (`src/lib/auth.ts`, `src/lib/permissions.ts`)
* Sessions: scrypt passwords, SHA-256-hashed bearer tokens, 7-day TTL, **10-minute idle
  expiry**, soft-close with `endReason`, `endAllSessionsForUser()` for instant cut-off,
  `accessRevokedAt` for full revocation. Excellent fit for an external consultant.
* `accessibleBusinessIds(user)` = primary assignment ∪ `user_business_access` grants ∪
  `businessManageIds`, **always intersected with the user's organisation(s)**. An advisor
  must therefore be an `organization_members` row of each Owner's org they serve
  (many-to-many is already supported). A single advisor person serving two Owners works,
  but **notification `ownerId` scoping and the org lens must be respected** — see §8.4.
* Permission model is a flat set of OWNER-granted boolean flags on `users`
  (`canManageRecords`, `canDeleteInventory`, `canManageExpenses`, `canManageUsers`,
  `canViewFinance`, `canManageOnline`, `canCreateBusiness`, `canManageCctv`,
  `canManageAuditors`, `canManageSupport`) + `businessManageIds`. All are **default-false**,
  OWNER-only to grant. Exactly the "restricted by default" posture the Advisor needs —
  we add **no new flags for the advisor's own powers**, only one optional delegation flag.

### 2.2 The Auditor precedent — the closest analogue that already exists
`audit_assignments` grants an *existing user* (any role) access to specific
`businessId` + `branchCode` + `modules[]`, is `isActive`-toggleable, records who granted it,
and drives:
* `auditEligible` → an assignment-only **AUDIT** tab in `Sidebar.tsx` (line 681) and an
  interception in `GoMinaApp.renderActiveView()` (line 643) that takes precedence over
  the WORKER/BRANCH_MANAGER workspaces — *the exact hook an Advisor workspace needs*;
* server-side scoping of every read and write in `/api/audit`;
* a full issue pipeline with notifications, escalation (`auditEscalationRecipients`) and
  an immutable `audit_trail`.

**Judgement:** copy the *shape*, not the code. An auditor polices compliance; an advisor
gives professional guidance. Conflating them would pollute the audit KPIs ("open findings",
"verification rate") with advice, and would give the advisor the auditor's write surface
(flag/verify/resolve on staff records). Keep them separate, and let the advisor *escalate*
into the audit pipeline when — and only when — an action must be tracked to closure.

### 2.3 The AI system (`dailyNotesAi.ts`, `/api/ai`, `aiInsights`, `businessInsights`)
* `analyzeNote()` is a deterministic 14-category operations taxonomy
  (HEALTH, WATER, FEED, STOCK, MACHINE, STAFF, SECURITY, FINANCE, SALES, QUALITY, HYGIENE,
  WEATHER, DELIVERY, CUSTOMER) with severity INFO/WATCH/URGENT, recurrence detection and
  summary composition; `foldNoteIntoInsights()` maintains a per-business rolling narrative,
  issue register and capped day history. **Deterministic = E2E-testable**, which is why the
  existing suites can assert AI behaviour exactly. Advisor notes should ride this engine.
* `/api/ai` (strategic advisor) is OWNER/GENERAL_MANAGER-only with a 60 s per-user cooldown
  and writes `ai_insights` rows scoped by `ownerId`. That is the correct publication channel
  for advisory digests the Owner reads.
* `poultry/knowledge` + `aiGuides.ts` provide in-app guidance content — a natural place to
  let the advisor contribute standing best-practice notes (phase 3, optional).

### 2.4 Farm data available to read (poultry)
`poultry_flocks`, `poultry_feed_logs`, `poultry_water_logs`, `poultry_health_records`,
`poultry_production` (incl. `fcr`, `layPercentage`, `revenueGhs`), `poultry_weight_logs`,
`poultry_feed_batches` / `_qc_checks`, `poultry_checklists`, `checklist_entries`,
`daily_notes`, `inventory_items`, plus computed layers:
`computePoultryPerformance()`, `broilerTargetKg()`, `layerTargetKg()`, `layerTargetLayPct()`,
`eggWeightTargetG()` (**this *is* the Benchmark Performance surface**) and
`analyzePoultry()` (alerts + health score 0-100). UI: `PoultryFarmModule` (11 tabs),
`PoultryGrowthAnalytics`, `PoultryAnalyticsAlerts`, `DailyChecklistPanel`, `DailyNotesPanel`.

### 2.5 Gaps / risks found
1. **Write gating by business access only** (~25 routes) — see §1. Blocking issue.
2. **`/api/init` is a broad bootstrap payload**: for every accessible business it returns
   transactions, customers, suppliers, employees, assets, inventory, credit sales, metrics.
   An advisor with plain business access would receive **financial and HR data over the wire
   even if the UI hid it**. Needs an advisor projection at the server.
3. **No `src/middleware.ts`** — no global request choke point exists today.
4. **No scheduler** (no Vercel crons in `vercel.json`) — digests must be event-driven or
   on-demand, not cron-based.
5. Money is embedded in operational rows (`costPerKgGhs`, `revenueGhs`, `costPerBirdGhs`),
   so "advisor without finance" requires **server-side field stripping**, not UI hiding.
6. UI read-only conventions are inconsistent (only `TransportModule` has a `canEdit` prop).
   A single shared `readOnly` context is worth introducing with this feature.

---

## 3. Recommended design

### 3.1 Identity: a real `ADVISOR` role, with grants on top
Add `"ADVISOR"` to the role vocabulary (`users.role` is free text + validated lists in
`/api/users` and `UserAccessConsole.ROLES`).

*Why a role and not just a grant on an existing role?* Because read-only must be decidable
from the **identity alone** at a single server choke point. A grant-only advisor would have
to be, say, a SUPERVISOR — and every one of the 25 permissive mutation routes would then
need bespoke logic. With a role, one predicate (`isReadOnlyActor(user)`) protects everything,
including routes written in the future. The grant then answers *what* they may see, not *whether*
they may write.

Server-side clamp (mirrors the existing `role === "WORKER" ? … : undefined` pattern in
`/api/users`): for `role === "ADVISOR"` force **all** management flags false and
`businessManageIds = []`, regardless of request body. Advisors can never be created by a
delegated manager — OWNER only (optionally a new `canManageAdvisors` flag mirroring
`canManageAuditors`, default false).

### 3.2 Scope: `advisor_assignments` (new table, shaped after `audit_assignments`)

```
advisor_assignments
  id, userId, userName, userRole            -- snapshot, like audit_assignments
  businessId, branchCode (null = all branches)
  scopes            jsonb   -- ADVISOR_SCOPES subset (see 3.3)
  flockIds          jsonb   -- optional narrowing: [] / null = all flocks of the unit
  showCosts         boolean default false   -- money visibility (server-enforced)
  canExport         boolean default false   -- PDF/Excel of what they may already see
  startsOn, endsOn  text    -- engagement window; expired ⇒ no access, no deletion needed
  isActive          boolean default true
  note              text
  grantedByUserId/Name/Role, createdAt, updatedAt
```

Resolver `resolveAdvisorGrants(user)` in a new `src/lib/advisorAccess.ts` returns the active,
in-window grants; `accessibleBusinessIds()` gains an ADVISOR branch that unions them (so no
`user_business_access` rows are needed and revocation is a single toggle).

### 3.3 Read-only surface (`ADVISOR_SCOPES`, all default-ON except the last three)

| Scope | Contents (read-only) |
|---|---|
| `DASHBOARD` | Farm dashboard KPI strip, health score, flock summary |
| `FLOCKS` | Flock/batch register: breed, genetics, arrival, age, counts, status, house |
| `DAILY_OPS` | Daily checklist entries + completion compliance, daily activity logs |
| `DAILY_NOTES` | Staff daily notes + their AI analysis (context for advice) |
| `FEED_WATER` | Feed logs (types, kg, intake/bird), water volumes, pH, treatment; feed-mill batches & QC |
| `GROWTH_FCR` | Weight logs vs target curves, ADG, uniformity, FCR vs benchmark |
| `MORTALITY_HEALTH` | Mortality series & cumulative %, vaccinations, treatments, withdrawal/next-due dates, biosecurity records |
| `PRODUCTION` | Eggs/trays, grades, cracked %, lay % vs standard, harvest weights |
| `BENCHMARK` | `computePoultryPerformance()` actual-vs-target panels, cross-flock comparison inside granted farms |
| `ALERTS` | `analyzePoultry()` alerts & recommendations feed |
| `INVENTORY_LEVELS` | Feed/vaccine/consumable **quantities only** (no unit costs unless `showCosts`) |
| `PHOTOS_CCTV` *(off)* | Flock photos / camera stills, if the Owner wants remote visual checks |
| `COSTS` *(off, = `showCosts`)* | Unit costs, feed cost/kg, revenue, cost per bird |
| `FINANCE` | **Not offered.** Finance, payroll, employees' personal data, customers, suppliers, pricing, users & access, business settings, exports, deletions are out of scope by design |

Server enforcement: a shared **advisor projection** (`projectForAdvisor(payload, grant)`)
applied in `/api/init` and in the advisor-facing read endpoints — strips money fields when
`!showCosts`, strips employee/customer/supplier/transaction collections entirely, narrows
rows to granted businesses/branches/flocks. The UI never receives what it must not show.

### 3.4 Write surface: exactly one thing — advisor notes

```
advisor_notes
  id, businessId, branchCode, flockId, batchNumber
  visitId                -- optional group header (see 3.5)
  noteType               -- OBSERVATION | RECOMMENDATION | FOLLOW_UP | VISIT_REPORT | RISK
  title, body(<=4000)
  observationDate        -- YYYY-MM-DD, the farm day the note is about (may be back-dated
                            within the engagement window; createdAt stays immutable)
  priority               -- LOW | MEDIUM | HIGH | CRITICAL  (reuses audit vocabulary)
  category               -- optional advisor-chosen taxonomy hint (HEALTH/FEED/WATER/…)
  -- record linkage: identical convention to audit_reviews
  recordType, recordSource, recordId, recordRef, recordTitle
  photos                 jsonb (data URLs, capped & size-limited like audit evidence)
  dueDate, assignedUserId/Name/Role      -- for FOLLOW_UP
  status                 -- DRAFT | SUBMITTED | ACKNOWLEDGED | IN_PROGRESS | DONE | CLOSED
  linkedIssueId          -- audit_reviews.id when escalated (see 3.6)
  -- AI snapshot: same column shape as daily_notes
  aiSummary, aiIssues jsonb, aiSeverity, aiFlags jsonb
  authorUserId/Name, createdAt, updatedAt, withdrawnAt
advisor_note_replies      -- Owner/BM/staff response thread (author, body, photo, createdAt)
```

Rules: an advisor may **create** notes and **edit their own note for 24 h** (after that,
append-only replies — advice must not be silently rewritten after staff acted on it);
**never hard-delete** (withdraw = `withdrawnAt`, insights rebuilt, mirroring the daily-notes
`rebuildInsights()` behaviour). Owner/GM/BM may reply, acknowledge and close.

### 3.5 `advisor_visits` (recommended, small)
`id, businessId, advisorUserId, visitType (ON_SITE | REMOTE), plannedDate, actualDate,
durationMins, summary, aiDigest, status (PLANNED|COMPLETED|MISSED), createdAt`.
Groups notes into a **visit report**, gives the Owner a "last visited / next visit" fact,
and enables a reminder notification the day before. Low cost, high practical value for a
person who "occasionally visits the farm".

### 3.6 Follow-ups reuse the existing pipeline (no duplicate workflow engine)
When the advisor ticks *"Requires action by staff"*, the API creates a **real
`audit_reviews` row** (`action: "CORRECTION_REQUESTED"`, `module: "OPERATIONS"`,
`recordType/recordId` = the linked farm record, `reviewerUserId` = advisor,
`assignedUserId` = chosen manager) and stores its id in `advisor_notes.linkedIssueId`.
Consequences — all free:
* it lands on the assignee's bell and in **`MyAuditIssues`** with the standard
  FLAGGED → UNDER_REVIEW → CORRECTION_REQUIRED → RESOLVED → VERIFIED pipeline;
* HIGH/CRITICAL escalates to the Owner via `auditEscalationRecipients()`;
* every transition is mirrored into `audit_issue_updates` and `audit_trail`;
* the advisor sees status changes on their own dashboard without any new code.

The advisor's *verify* power is deliberately **not** granted: they may comment and mark
"advice satisfied"; formal verification stays with Owner/manager/auditor.
*(Add `audit_reviews.origin = 'ADVISORY' | 'AUDIT'` so audit KPIs can exclude advisory items.)*

### 3.7 AI integration — reuse, then correlate
Two layers:

1. **Note analysis (reuse as-is).** On submit, run `analyzeNote()` and store
   `aiSummary/aiIssues/aiSeverity/aiFlags` on the note; call `foldNoteIntoInsights()` with a
   `source: "ADVISOR"` tag so the Owner's existing rolling business narrative and issue
   register absorb professional observations alongside staff notes. Deterministic ⇒ testable.
2. **New `src/lib/advisorAi.ts` — "Advisory Digest" (pure, data-in/data-out).** Joins the
   note corpus with the farm's own numbers for the same flock/date window and emits
   findings the Owner can act on:
   * mortality rate & 7-day trend vs the flock's cumulative benchmark;
   * FCR actual vs `broilerTargetKg`-derived expectation; feed intake per bird vs standard;
   * lay % vs `layerTargetLayPct(ageWeeks)`; egg weight vs `eggWeightTargetG`;
   * body weight vs target curve + uniformity; water:feed ratio anomalies;
   * checklist compliance %, open `analyzePoultry()` alerts, vaccination due/overdue;
   * **corroboration scoring**: does the data confirm the advisor's observation?
     ("Advisor flagged respiratory signs 12 Sep · mortality 0.6 %→1.4 % over the following
     5 days · feed intake −8 % · no vaccination recorded → CONCERN, confirmed by data.")
   * **advice-adoption tracking**: % of follow-ups closed, median days to close,
     before/after movement of the metric the advice targeted — the single most useful
     number for an Owner paying a consultant.

   Output: a digest object rendered in-app **and** published as an `ai_insights` row
   (`category: RISK|EFFICIENCY|COMPLIANCE`, `businessId`, `ownerId`) so it appears in the
   existing AI Advisor view. Generation is **event-driven** (on visit completion / on
   URGENT note) plus an on-demand "Generate advisory digest" button reusing the existing
   60 s cooldown pattern — no cron infrastructure exists or is needed.

   Keep it deterministic and rule-based like `dailyNotesAi`; if an LLM is added later it
   should sit behind the same interface so the E2E suites keep passing.

### 3.8 Notifications (reuse `notifications` + `pushAfterBell`)
New `type` values only: `ADVISOR_NOTE_ADDED`, `ADVISOR_URGENT`, `ADVISOR_FOLLOWUP_ASSIGNED`,
`ADVISOR_NOTE_REPLY`, `ADVISOR_VISIT_DUE`, `ADVISOR_DIGEST_READY`.
Routing: Owner + managers of the farm (`auditEscalationRecipients`-style, URGENT/CRITICAL
always reaches the Owner); replies and status changes route back to the advisor.
Deep link `"/?tab=ADVISORY&note=<id>"` — the existing `?tab=` deep-link handler in
`GoMinaApp` already parks and consumes this after sign-in.

### 3.9 Audit trail (reuse `auditLog()`)
Log: grant created/edited/revoked/expired, scope or cost-visibility change, advisor sign-in
provenance (already in `user_sessions`), note created/edited/withdrawn, escalation to issue,
digest generated, export produced. Add an **Advisor Access report** in the Owner console:
last login, notes filed, open follow-ups, engagement window, next expiry.

---

## 4. Dashboard & workflow integration

### 4.1 Advisor workspace (the advisor's own login)
Intercept in `GoMinaApp.renderActiveView()` **exactly like the AUDIT tab** (assignment-only,
takes precedence over other workspaces), and render an `AdvisorWorkspace` composed of
existing read-only components:

```
┌ Farm selector (granted farms only) · engagement window chip · next visit ┐
│ KPI strip      : birds alive · mortality % · FCR vs target · lay % vs std │
│ Alerts feed    : PoultryAnalyticsAlerts (read-only)                      │
│ Benchmarks     : PoultryGrowthAnalytics + computePoultryPerformance      │
│ Records tabs   : Flocks · Feed/Water · Health · Production · Checklist   │
│                  (PoultryFarmModule in readOnly mode — no add/edit UI)   │
│ Notes composer : type · flock · date · linked record · priority · photos │
│ My notes & follow-ups : status, replies, adoption tracker                │
│ Visits         : log a visit, write the visit report, schedule next      │
└──────────────────────────────────────────────────────────────────────────┘
```
Implementation note: add a `readOnly` prop (or a small `ReadOnlyContext`) to
`PoultryFarmModule` and its panels, following the `TransportModule.canEdit` precedent —
cosmetic only; the server is the real gate.

### 4.2 Owner / manager side
* **New "Advisory" tab inside the poultry module** (and a Command Center card): latest
  advisor notes with AI severity chips, the current Advisory Digest, open follow-ups,
  adoption metrics, visit history.
* **Per-flock context**: advisor notes attached to a flock appear on that flock's detail
  panel and next to the relevant record (same linkage convention as audit reviews).
* **Bell + push** as in §3.8; **AI Advisor view** shows the published digests.
* **Users & Access → "Advisors"**: create the advisor login, grant farms/branches/flocks,
  toggle scopes, cost visibility, export, engagement window; one-tap
  *Pause* (`isActive=false`), *Revoke* (`endAllSessionsForUser` + `accessRevokedAt`).

### 4.3 End-to-end workflow
1. Owner creates the advisor login and grants *Nsawam Poultry · all branches · standard
   scopes · costs OFF · 1 Oct 2026 → 31 Mar 2027*.
2. Advisor signs in remotely, reviews yesterday's checklist, mortality trend, FCR vs target,
   and the staff daily notes.
3. Advisor files a RECOMMENDATION linked to flock `BATCH-2026-A`, priority HIGH, ticks
   "requires action" and assigns the branch manager.
4. Bell + push to manager and Owner; the item enters the standard issue pipeline.
5. AI analyses the note, correlates it with feed/mortality/production data, updates
   `business_insights` and publishes an `ai_insights` digest for the Owner.
6. Manager responds inside the pipeline; the advisor sees the closure and the adoption
   tracker records whether the targeted metric improved.
7. On the next on-site visit the advisor logs the visit and files a VISIT_REPORT; the digest
   for the visit is generated and sent to the Owner.
8. Engagement window ends → access stops automatically; all notes and history remain.

---

## 5. Security posture (non-negotiables)

1. **Central write guard.** New `assertWritable(session, businessId)` /
   `canMutateBusiness()` in `src/lib/advisorAccess.ts`, returning 403 for any read-only
   actor. Mechanically replace `canAccessBusiness()` in every POST/PATCH/PUT/DELETE handler
   (25 routes identified) — greppable, reviewable, and covered by a dedicated test that
   walks every mutating route with an advisor session and asserts 403.
2. **Defence in depth:** add `src/middleware.ts` (Node runtime) rejecting non-GET `/api/*`
   from an ADVISOR session except an allowlist (`/api/advisor/*`, `/api/auth/*`,
   `/api/session/*`, `/api/profile`, `/api/push/*`). Route-level guard stays authoritative
   (verify the Node-runtime middleware behaviour on Vercel before relying on it).
3. **Advisor projection on `/api/init`** — no finance/HR/customer/supplier payload ever
   reaches an advisor session; money fields stripped unless `showCosts`.
4. **Engagement window** enforced on every read (grant resolution), not just in the UI.
5. **Default-deny flags:** every `canManage*` / `canView*` / `businessManageIds` clamped to
   false/empty for ADVISOR server-side; only the OWNER (or `canManageAdvisors` delegate)
   may create or scope advisors.
6. **Exports off by default**; when enabled, reuse `watermark.ts` + `universalExport.ts` and
   log every download (`assetDownloads`/`auditLog` precedent).
7. **Rate-limit** note submission and digest generation via the existing `rateLimit.ts`.
8. **No deletion anywhere**, including their own notes (withdraw only).
9. Advisor accounts inherit the 10-minute idle logout and lockout policy automatically.

---

## 6. Recommended extras that make the role genuinely useful

| # | Feature | Why |
|---|---|---|
| 1 | **Visit scheduling + reminder** (`advisor_visits` + `ADVISOR_VISIT_DUE`) | Turns "occasional visits" into a managed cadence the Owner can see |
| 2 | **Structured advisory templates** (biosecurity audit, brooding review, pre-lay readiness, post-mortem findings) | Consistent, comparable advice; renders to PDF with existing `jspdf`/`salesDocument` stack |
| 3 | **Advice-adoption analytics** | Proves ROI of the advisor; drives Owner decisions |
| 4 | **Cross-flock / cross-farm benchmark view (granted farms only)** | Advisor's core value: comparing house A vs B, batch vs batch, vs breed standard |
| 5 | **Photo & voice-note attachments** (photos already a solved pattern in audit evidence) | Field reality in Ghana: pictures of litter, birds, lesions |
| 6 | **Offline note drafts** via existing `offlineSync.ts` queue | Farm connectivity |
| 7 | **QR jump** (`qrRegistry.ts`): scan a flock/house card on site → that flock's notes | Fast on-site capture |
| 8 | **WhatsApp share of the digest** (`wa.me` pattern already used in the storefront) | How Ghanaian owners actually read reports |
| 9 | **"Ask the farm data" prompt for the advisor** (scoped, read-only, reuses `/api/ai`) | Lets the advisor interrogate trends without exports |
| 10 | **Second opinion / multi-advisor** (vet + nutritionist, different scopes) | The grant model supports it for free |
| 11 | **Generalise to Aquaculture/Livestock** by keeping scopes module-keyed (`fishPerformance.ts`, `aquacultureAnalytics.ts` already mirror the poultry helpers) | One build, all farm types |

---

## 7. Data-model summary (3 new tables, 0 rewritten)

| Table | Purpose | Modelled on |
|---|---|---|
| `advisor_assignments` | Owner-controlled scope & engagement window | `audit_assignments` |
| `advisor_notes` (+ `advisor_note_replies`) | Observations, recommendations, follow-ups, visit reports + AI snapshot | `daily_notes` + `audit_reviews` linkage |
| `advisor_visits` | Visit/engagement header & report | new, minimal |

Reused unchanged: `users`, `user_sessions`, `organization_members`, `notifications`,
`push_subscriptions`, `audit_reviews`, `audit_issue_updates`, `audit_trail`,
`business_insights`, `ai_insights`, every poultry table.
Migrations follow the existing additive `dev-tooling/migrate-*.mjs` + `drizzle-kit push`
convention (all new columns nullable / defaulted; no backfill required).

---

## 8. Decisions taken, and the alternatives rejected

**8.1 New `ADVISOR` role vs grant-only on an existing role.** Chosen: role + grant.
Grant-only cannot make read-only enforceable at one point given the current permissive
mutation routes; a role can, and it also makes "what is this account?" obvious in every
console, audit row and notification.

**8.2 Separate `advisor_notes` vs extending `daily_notes`.** Chosen: separate table.
`daily_notes` is a staff end-of-day artefact keyed by (business, date, author) with a
2000-char body and no record/flock linkage, priority, assignment, due date or reply thread.
Extending it would force ~8 nullable columns and two behaviours into one table and would
distort the existing insights counters. The **AI engine is still shared**, which is where the
duplication would actually have hurt.

**8.3 Separate advisory pipeline vs reusing `audit_reviews` for follow-ups.** Chosen: reuse
the audit pipeline for anything requiring staff action, tagged `origin = 'ADVISORY'`.
Zero new workflow code, existing bell/escalation/audit-trail, one inbox for staff.

**8.4 Multi-tenant advisors.** An advisor serving several Owners needs an
`organization_members` row per org; `resolveUserOrgIds()` already supports it, but
`primaryOrgId`, the `ownerId` stamped on notifications/insights, and the Sidebar org lens
must be exercised in tests. If cross-org advising is not an immediate requirement, ship
**one advisor account per organisation** (simplest, zero tenancy risk) and revisit later.

**8.5 Cost visibility.** Default OFF with server-side stripping. Many farm advisors are paid
per visit and should not see payroll or margins; Owners who want cost advice flip one switch.

---

## 9. Suggested delivery phases (each independently shippable & testable)

| Phase | Content | Rough size |
|---|---|---|
| **0 — Hardening (prerequisite)** | `canMutateBusiness()` across the 25 mutation routes, advisor projection in `/api/init`, Node middleware, regression suite proving nothing else changed | 1–2 days |
| **1 — Access** | `ADVISOR` role + `advisor_assignments` + resolver + Owner grant UI (Users & Access) + revoke/expiry + audit logging | 2 days |
| **2 — Read-only workspace** | `AdvisorWorkspace`, `readOnly` mode for poultry panels, benchmarks/alerts/checklists/notes surfaced, deep links | 2–3 days |
| **3 — Notes & follow-ups** | `advisor_notes` + replies + escalation into `audit_reviews`, notifications & push, Owner "Advisory" tab | 2–3 days |
| **4 — AI** | `advisorAi.ts` digest, `dailyNotesAi` integration, `ai_insights` publication, adoption analytics | 2 days |
| **5 — Extras** | Visits + reminders, templates, PDF report, QR/offline/WhatsApp, cross-farm benchmarks, other farm modules | as prioritised |

**Test strategy:** one new `dev-tooling/verify-farm-advisor.mjs` in the house style
(puppeteer + `run-suite.sh`, TEST-prefixed fixtures, live-data byte-check at the end) covering:
grant/scope/expiry/revoke; advisor sees exactly the granted records and **no money/HR data**
(assert on the API payload, not the DOM); every mutating route returns 403 for an advisor
session; note → AI analysis → insights → notification → escalation → closure; Owner view;
mobile layout; zero page errors.

---

## 10. Open questions for the Owner/product decision

1. Should one advisor account be able to serve **multiple organisations** (§8.4), or one per org?
2. Default cost visibility — confirm **OFF**?
3. Should advisors see **CCTV stills / photos** (remote visual inspection) — off by default?
4. May advisors **export** (watermarked PDF of their own reports only, or wider)?
5. Should an advisor be able to **propose** a record correction (e.g. a mis-typed mortality
   count) as a pre-filled suggestion for a manager to accept, rather than only describing it?
6. Is a **paid-engagement/billing** view needed (visits per month, fee tracking), or out of scope?
