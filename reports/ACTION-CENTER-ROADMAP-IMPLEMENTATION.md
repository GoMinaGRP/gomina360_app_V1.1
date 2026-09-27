# GoMina 360 — Roadmap Implementation: P1–P4

**Date:** 2026-09-26 · **Scope:** the four top-ranked roadmap items from
`reports/PRODUCT-GAP-ASSESSMENT.md`, implemented end-to-end on top of the
existing systems (no duplication): **P1 Unified Action Center**, **P3
Low-Stock Reorder Alerts**, **P2 Daily Ops Heartbeat (Cron / Digest / SLA
Escalation)**, **P4 Budgets & Cash-Flow Forecast**.

Every phase reuses the platform's established rails — session-scoped APIs,
tenant isolation via `accessibleBusinessIds` + organization membership, the
`notifications` bell + web-push fan-out, system-marker idempotency, and the
seeded demo database. All existing data, permissions and scoping are
preserved; nothing was migrated or rewritten.

---

## 1. P1 — Unified Action Center

**The gap:** actions were scattered across five disconnected systems (audit
issues with no due dates, advisor follow-ups, checklists, fulfilments,
maintenance) with no cross-module "who owes what by when".

### What was built

| Piece | Where | What it does |
|---|---|---|
| `action_tasks` table | `src/db/schema.ts` | One cross-module action register: title, detail, business (nullable = org-wide), **assignee, priority, due date, status** (OPEN → IN_PROGRESS → DONE/CANCELLED), **provenance** (sourceType/sourceId/sourceRef/sourceLabel), completion audit (who/when/note), tenant `ownerId`. |
| Engine | `src/lib/actionCenter.ts` | Task numbering (`TASK-2026-XXXXXX`), create/notify, **auto-completion of linked tasks when their source resolves**, SLA escalation (first overdue day, then weekly), linked open-item queries (audit issues, advisor follow-ups, checklist load). |
| API | `src/app/api/tasks/route.ts` | GET (role-scoped list + stats + linked items + assignable-staff picker), POST (create / convert a notification / mirror a linked item — with tenant guards: same-org assignee, business attachment, own-notification-only conversion), PATCH (assignee progresses; creator & unit managers edit anything; completion notifies the creator). |
| Full view | `src/components/ActionCenter.tsx` | Stats strip (my open / overdue / due today / done-7d), My-vs-All views, status/priority/business filters, create panel, card list with lifecycle buttons (Start / Mark done + note / Cancel / Reopen / +3 days), and the **"Also on the plate"** linked zone: live audit issues & advisor follow-ups with due badges and **"Track as task"** mirroring, plus per-business checklist load chips that deep-link into the owning module. |
| Sidebar entry | `src/components/Sidebar.tsx` | "Action Center" in the top rail for **every staff role** (owner, GM, branch manager, worker) — farm advisors keep their closed sandbox. |
| Worker slice | `src/components/MyTasksCard.tsx` | Mounted at the top of the Sales Workspace: the worker's open actions with one-tap Done, overdue/today chips, deep link to the full center. |
| Notification → task | `src/components/NotificationBell.tsx` | Every bell row gains a **→ Task** button: converts the notification into a tracked action (due in 2 days, assigned to you) in one tap. |
| Audit deadlines | `audit_reviews.due_date` + audit API/UI | Auditors can set a **corrective-action deadline** when flagging (+3d/+1w shortcuts); it shows as a due/overdue badge in the Audit Center and My Audit Issues, feeds the Action Center's linked zone, and drives the SLA sweep. |

**No duplication:** linked items are read live from their own tables; the
mirror task carries `sourceType/sourceId`, and when the source resolves
(issue verified, follow-up closed) the daily sweep auto-completes the mirror
— the source remains the single source of truth.

## 2. P3 — Low-Stock Reorder Alerts

**The gap:** `inventory_items.min_stock_threshold` existed but nothing
watched it.

| Piece | Where | What it does |
|---|---|---|
| Engine | `src/lib/lowStock.ts` | Per business: detects items at/below their reorder point (qty ≤ 0 ⇒ OUT, else LOW), **normalizes the display `status` column to reality** in one statement, and drops one deduped team alert per business per day (`low-stock:{biz}:{date}`) on the same fan-out as purchase events (owner + assigned staff + grantees), with OS push. |
| API | `src/app/api/low-stock/route.ts` | GET = the radar for one business (any staff in scope); POST = managers trigger the sweep now (per-business or `all=1`). |
| Runs | daily ops pipeline + manual | Daily at the heartbeat, plus on-demand. |

## 3. P2 — Daily Ops Heartbeat (Cron / Digest / SLA)

**The gap:** no scheduler — every "scheduled" behaviour only ran when
someone opened the app.

| Piece | Where | What it does |
|---|---|---|
| Pipeline | `src/lib/dailyOps.ts` | One idempotent, failure-isolated daily pipeline: **a)** ensure today's checklists → **b)** low-stock sweep (all businesses) → **c)** auto-complete resolved linked tasks → **d)** SLA escalation of overdue **tasks** and dated **audit issues** (assignee always; escalation watchers weekly) → **e)** per-user **daily digest** (open actions, overdue, due today, audit issues awaiting response, low-stock businesses, unread bell — only sent when there is something to say). |
| Scheduler | `vercel.json` + `src/app/api/cron/daily/route.ts` | Vercel Cron `0 6 * * *` (06:00 UTC = 06:00 Ghana). Auth: `CRON_SECRET` bearer, the platform's `x-vercel-cron` header, or an executive session (manual "run now"); the public response carries counts only — never user ids. |
| Pull-based fallback | `/api/init` | The first session of each day runs the same pipeline via a global `daily-ops:<date>` system marker — deployments without any scheduler still get digests, escalations and stock alerts. |
| Deep links | `src/lib/push.ts` | TASK_* / DAILY_DIGEST push clicks open `/?tab=ACTION_CENTER`; LOW_STOCK opens `/?tab=INVENTORY`. |

## 4. P4 — Budgets & Cash-Flow Forecast

**The gap:** no budget-vs-actual anywhere; cash flow was historical only.

| Piece | Where | What it does |
|---|---|---|
| `budgets` table | `src/db/schema.ts` | Monthly envelopes: one row per (business, period `YYYY-MM`, branch, kind EXPENSE/REVENUE, category or `TOTAL`), tenant `ownerId`, unique-line upsert. |
| API | `src/app/api/budgets/route.ts` | GET returns budget lines with **live actuals computed from transactions** (seeded Q1-2026 baseline excluded — budgets are forward-looking controls), variance, %-used and OK/WATCH/OVER status, plus category picker and headline totals (revenue target vs actual, expense envelope vs actual). POST upserts (owner/GM/unit-manager); DELETE removes. Workers are barred. |
| Forecast API | `src/app/api/cashflow/forecast/route.ts` | 8/13/26-week projection starting from **the Command Center's liquid-surplus figure** (Σ `business_metrics.cash_flow_ghs`): committed inflows = outstanding **credit-sale balances on their due dates** (undated ride at the horizon end); committed outflows = **open POs** at supplier ETA + **next month-end payroll** (latest run's net); run-rate estimates = live last-30-day income/expense averages (payroll excluded from the expense run-rate to avoid double counting). Weekly buckets with pesewa-exact cumulative arithmetic, `firstNegativeWeek`, and disclosed assumptions. |
| UI | `src/components/BudgetsAndCashflowSection.tsx` | Embedded under Finance & Reports below the central report: **Budget vs actual** tab (period + business pickers, headline cards, variance table with usage bars, add-line form with category picker) and **13-week cash flow** tab (headline cards, cash-squeeze warning, cumulative-cash bar chart, weekly committed/estimated table, expandable assumptions). |

---

## Verification (all green)

| Suite | Checks | Covers |
|---|---|---|
| `dev-tooling/verify-action-center.mjs` | 33 | task lifecycle, scoping (worker sees only own; cross-tenant 403s), TASK_ASSIGNED/COMPLETED notifications, notification→task conversion (own-only), audit dueDate end-to-end, linked zone, **mirror auto-completion via issue verify**, cron force + marker skip + anonymous 401, overdue escalation |
| `dev-tooling/verify-low-stock.mjs` | 15 | detection vs threshold, severity LOW/OUT, status normalization (both directions), team notification content, **same-day dedupe**, manager-only trigger, business scoping, healthy-stock no-alert |
| `dev-tooling/verify-daily-ops.mjs` | 21 | all 6 pipeline steps, digest content + deep link, per-user digest dedupe across forced runs, marker skip, **audit-issue SLA escalation**, checklist materialization, worker 401 |
| `dev-tooling/verify-budgets-cashflow.mjs` | 26 | TOTAL + category lines with exact live actuals (baseline excluded), OVER/WATCH flags, upsert-no-duplicate, revenue targets, role gates + per-business scoping + invalid period, DELETE, forecast: starting cash = Σ metrics, credit balance lands in its due week, arithmetic consistency, firstNegativeWeek, open-PO parity, assumptions, worker 401 |
| `dev-tooling/verify-action-center-ui.mjs` | 25 | real Chromium: sidebar entry + render (owner), create-task form, Finance budgets panel + add/save line + variance table, cash-flow chart + table, **notification → Task button**, audit center load, worker phone viewport (My Tasks card, one-tap Done, full Action Center), zero page errors |

Every suite is **self-cleaning** (creates precise rows, deletes them by id,
restores touched stock) and re-runnable. The full 85-suite regression
battery (80 pre-existing + 5 new) was run against the production build:
**see the final section for the recorded results.**

### Issues found & fixed during verification

1. Category budget lines read 0 actual for branch-coded transactions —
   actuals are now computed by filtering the live month rows (business-wide
   lines sum every branch; branch-scoped lines their own register).
2. Forecast cumulative cash drifted by rounding cents vs the weekly nets —
   nets are now rounded to pesewas **before** accumulating, so the table is
   exactly self-consistent.
3. Notification→task conversion required a title even when the source row
   supplied one — the route now accepts NOTIFICATION-source conversions
   without a body title.
4. Parallel file edits raced the workspace persistence layer (duplicated
   file tails); affected files were restored and edits re-applied
   sequentially — final tree typechecks, lints (0 errors) and builds clean.

## Deployment notes

- **Schema:** 2 new tables (`action_tasks`, `budgets`) + 1 new column
  (`audit_reviews.due_date`) — applied via `drizzle-kit push` /
  `npm run db:migrate`; purely additive, no data migration.
- **Vercel:** `vercel.json` now schedules `/api/cron/daily` at 06:00 UTC.
  Set `CRON_SECRET` in the project's environment variables (Production +
  Preview) so the platform signs its cron calls; without it the endpoint
  still accepts the platform header and executive sessions.
- **Self-hosted:** point any scheduler (cron/systemd timer) at
  `GET /api/cron/daily` with `Authorization: Bearer $CRON_SECRET`, or rely
  on the first-login-of-the-day fallback built into `/api/init`.

## How the team uses it

- **Owner / GM** — open **Action Center** (sidebar, top): everything owed
  across every unit in one list; press **New action** to assign work with a
  deadline; the assignee's bell and phone light up instantly. The linked
  zone shows live audit issues and advisor follow-ups — press **Track as
  task** to give yourself a mirror deadline that auto-completes when the
  source is resolved.
- **Branch manager** — same view, scoped to your units; overdue items
  re-escalate to you automatically (first day, then weekly).
- **Worker** — your Sales Workspace opens with **My actions**: your open
  tasks with one-tap Done; the full Action Center is one sidebar tap away.
- **Auditor** — set a **corrective-action deadline** when flagging; the
  assignee sees it in My Audit Issues and the Action Center, and the daily
  sweep chases it if it slips.
- **Everyone** — any bell notification converts to a tracked action with
  the **→ Task** button; every morning each user with something on their
  plate gets a **Daily recap** digest.
- **Owner / GM (money)** — **Finance & Reports** now ends with **Budgets &
  Cash-Flow Forecast**: set monthly envelopes per business/category (or one
  all-in TOTAL envelope) and watch live variance; switch to the cash-flow
  tab for the 13-week projection — committed receivables, open POs, payroll
  and run-rates, with a cash-squeeze warning the moment a week goes
  negative.

---

## Final regression-battery status (recorded 2026-09-26)

**Battery 1 — full 85-suite sequential run (19:05–19:47): 62 PASS / 23 FAIL.**
All 23 failures were triaged to root cause; **none was a P1–P4 code regression**:

| Failure class | Suites | Root cause | Resolution |
|---|---|---|---|
| Fresh-recovery demo fixtures absent (not run by `recover.sh`) | benchmark, fish-benchmark, poultry-stages, poultry-stages-ui, flock-plans-ui, farm-advisor (K30), business-manage (multi-photo product) | `seed-benchmark-demo.mjs`, `seed-fish-benchmark-demo.mjs`, `seedphotos.ts` were not part of recovery | Seeders re-run and data verified (274 feed logs, 32 weight logs, 3 benchmark profiles, multi-photo product) |
| Missing local fixtures after `/tmp` reset | audit-responsive, photo-formats, logos, notifications | `test-photo.png` absent; push mock cert not trusted by the app process | `test-photo.png` recreated; **root cause for notifications: app must start with `NODE_EXTRA_CA_CERTS=/tmp/pushsrv.pem`** — now wired into `dev-tooling/recover.sh` (notifications re-verified 43/43) |
| Two-phase suite run one-phase | storefront-help, storefront-areas, order-inventory-fixes, customer-data (downstream) | `verify-hardware-audit` phase 1 ends by deleting the HARDWARE-01 flagship; the battery runner never ran phase 2 or restored the flagship | Flagship restored (markers cleared + reseed); battery runner updated to run phase1 → restart → phase2 → restore-flagship automatically |
| Suite staleness — hardcoded demo values (AZ-AUDIT-REPORT M5) | category-notes, order-inventory-fixes, permissions-storefront (eggs 873.63), storefront-areas + order-inventory-fixes + bm-dashboard-access (hardware biz id 8), org-scoped-codes (unit count 8), photo-formats (backup-zip input) | suites calibrated against an old snapshot | All made dynamic (start-of-suite snapshots, runtime id resolution, backup-zip accept exception); each re-verified green standalone |
| Real product bug found & fixed | logos (C5/D3/E1/F2/F3) | `/api/branding` is served with 7-day `max-age`, so a `brandingVersion` change triggered a refetch that returned the **stale browser-cached copy** — payslips/invoices kept showing removed logos | `fetchBranding()` now uses `cache: "no-store"` (`src/lib/brandingCache.ts`); suite updated to the versioned-branding contract; **verified 34/34 twice** |
| Battery-load flakes | transport, transport-ui, transport-input-focus, input-focus-appwide (timeout) | sequential full-load contention | transport ×3 re-verified green standalone (119/119, 26/26, 21/21); per-suite battery timeout raised 420 s → 600 s |

**Post-fix standalone re-runs (all green):** notifications 43/43 · org-scoped-codes
24/24 · customer-data 33/33 · bm-dashboard-access 19/19 · transport 119/119 ·
transport-ui 26/26 · transport-input-focus 21/21 · logos 34/34 (×2).

**Battery 2 (re-run for final numbers) was interrupted at ~suite 35/85 by a platform
sandbox reset (all `/tmp` state and processes wiped mid-run).** Its partial run
surfaced a further, pre-existing class worth recording honestly: **date- and
demo-state-calibrated suites** (fish-benchmark M11 age off-by-one vs the seeder's
day-rounding, fish-analytics bar/KPI counts, farm-advisor K20 exact-batch count,
finance-allproducts-fresh, employees history count, clean-state checklist-entry
timing) plus genuine **deletion-cascade gaps** (business DELETE leaves
`notifications` rows orphaned; direct-SQL fixture purges leave
`checklist_entries`/`customer_trackings` orphans). These are queued as the next
wrap-up step together with a fresh recovery + full battery re-run; they do **not**
affect the P1–P4 feature suites, which are green.

**Status: P1–P4 feature verification complete (all 5 new suites green, fixes
re-verified). Full-battery green remains pending a recovery + re-run after the
sandbox reset.**
