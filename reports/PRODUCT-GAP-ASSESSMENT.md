# GoMina 360 — Product & Architecture Gap Assessment

**Date:** 2026-09-26 · **Scope:** full code review of the live app (commit `120def7`,
134-table schema, 80+ API routes, all module components) · **Mode:** assessment only —
nothing implemented.

**Purpose:** an honest inventory of what GoMina 360 already does well, what is genuinely
missing, duplicated or underused, and a ranked recommendation for what to build next —
so that nothing we add duplicates what already exists.

---

## 1. What already exists (verified in code — do not duplicate)

GoMina 360 is far more complete than a typical SMB app. The following are **live,
working capabilities**; any recommendation in §3 explicitly builds *on top of* them.

### 1.1 Business modules (11 types)

| Module | Depth | What it has |
|---|---|---|
| **Poultry farm** | Deepest | Flocks with stage plans (brooding→growout→laying), daily feed/water/health/mortality/weight/production logs, growth analytics (FCR, weight vs benchmark), benchmark profiles, AI knowledge base, per-flock checklists, stage-transition notifications |
| **Aquaculture** | Deep | Ponds, batches (GROWING→HARVESTED/SOLD/CULLED), feed/water-quality/harvest/weight logs, fish benchmarks (FCR, growth), fish feed mill chain |
| **Block factory** | Deep | Orders + deliveries, mixing recipes→batches→QC (slump/curing), QC center with hold/release, block types |
| **Transport** | Deep | Vehicles, trips, bookings, fuel logs, maintenance schedules, vehicle checklists, geofences, GPS trackers + violations, live tracking |
| **Restaurant** | Medium | Orders, menu items, waste log, purchases, shift logs |
| **Hardware store** | Medium | Orders, purchases, deliveries, stock with min-stock thresholds |
| **Electronics** | Medium | Serial-number inventory, warranties, orders, purchases |
| **Car wash** | Medium | Services, bookings, washes, activities |
| **Telecom** | Medium | Lines, wifi packages, vouchers, transactions, activities |
| **Feed mills** (poultry + fish) | Deep | Formulas→batches→QC hold/release→raw-material stock, cost per kg |
| **Livestock** | **Thin** | Overview / herd logs / finance / checklist only — no herd inventory, breeding or weight tracking (§3.12) |

### 1.2 Cross-cutting capabilities

* **Sales & orders** — sales documents (QUOTATION→INVOICE→RECEIPT with PARTIAL/CONVERTED
  statuses), credit sales with installments→payments→receipts, customer tracking with
  pickup/delivery GPS + public tracking page, online storefront, preorders with
  **demand propagation into stock and procurement**, product share links, fulfillment
  methods/options.
* **Procurement** — full PO lifecycle (RAISED→SENT→PARTIAL→RECEIVED/CANCELLED),
  goods-receipt notes as the **only stock gate**, receipt-linked expenses, org-scoped
  suppliers, preorder-driven demand. This is a genuinely solid mini-ERP core.
* **Finance** — unified per-business report engine (revenue/expenses/investments/
  transfers, period-over-period trends, Q1-2026 baseline blend, branch scoping);
  enterprise finance pulse (consolidated profit/margin); command-center cash view
  (net operating cash flow, liquid surplus); expense categories; MoMo payment methods
  with manual verification status.
* **HR & payroll** — employees with documents (contracts incl. `expiresOn`), history,
  attendance (clock in/out with GPS), payroll runs with Ghana statutory config (SSNIT
  Tier-1 5.5% / Tier-2 5%), overtime/allowances.
* **Assets** — registry with QR codes + the app's **only full approval workflow**
  (REQUEST_EDIT/TRANSFER/DELETE → APPROVE/REJECT with audit log).
* **Audit & review** — record universe across all modules, review pipeline
  (FLAGGED→…→VERIFIED), assignable issues with priorities routed to worker
  dashboards, evidence photos, per-business/branch/module auditor grants, day-grouped
  Records + History, 250-record paging.
* **Checklists** — generic templates + daily entries + stage-plan templates + per-flock
  plans; overdue sweeps; **plus 4 legacy per-type checklist tables** (§4.1).
* **AI (deterministic)** — daily-notes analysis (issues/severity/trends), advisor notes
  with benchmark corroboration, per-section AI guides, `aiInsights` (opportunity/risk
  with projected gain), smart alerts (poultry analytics), rolling `businessInsights`.
  No LLM anywhere — fully rules-based, testable, offline-safe.
* **Scenario planning** — what-if engine with a **live baseline** (current-quarter
  revenue/expenses/profit/margin) and per-variable percentage impacts; saved sims.
* **Notifications** — bell + fan-out (owner + assigned staff + grantees, tenant-safe),
  25+ event types (orders, purchases, QC, audit, stage transitions, overdue checklists,
  advisor, tracking), **web push** (VAPID, subscriptions, per-user settings), backfill
  on duty hand-over.
* **Platform** — multi-org tenancy with org-scoped everything, roles
  (OWNER/GM/BM/WORKER/super-admin), granular worker permissions, branch scoping,
  session management, idle logout, PWA with offline transaction queue
  (`OFFLINE_QUEUED`), universal export (PDF/XLSX/CSV with QR verification), 80 E2E
  verification suites, recovery kit.

**Bottom line:** the transactional backbone — record sales, buy stock, run farms,
pay staff, audit records, notify people — is built and hardened. The gaps are almost
all in the **management layer on top**: converting data into obligations, foresight
and unit economics.

---

## 2. Architecture assessment

### 2.1 Strengths

* **Server-side scope enforcement everywhere** — org/branch/module filters live in the
  API layer, not the client; the A–Z audit and signed-in-staff audit hardened this.
* **Deterministic "AI" engines** — testable, no API cost, no hallucination, works in
  the field; the right foundation for an LLM layer *later* (§3.8).
* **Idempotent provisioning** (`checklistGen`) — templates + today's checklist always
  converge from three entry points.
* **Proven verification culture** — 80 E2E suites + recovery tooling + baseline seed
  (Q1-2026 `business_metrics`) make every new module safer to add.

### 2.2 Constraints and risks (affect the roadmap)

| # | Constraint | Impact |
|---|---|---|
| A1 | **No job scheduler.** All "scheduled" work (checklist generation, overdue sweeps) runs *when someone opens the app* via `/api/init`. `vercel.json` has no `crons` block. | Digests, SLA escalation, forecasts, low-stock sweeps would be invisible until someone logs in. Any P1/P2 involving time-based behaviour needs **Vercel Cron** first. |
| A2 | **In-memory cooldown/TTL caches** (AI insights cooldown, etc.) assume a single warm instance. | Fine today; blocks horizontal scaling and shared-rate features. Don't build on them. |
| A3 | **Images stored as base64 data-URLs in Postgres** (evidence photos, receipts, profiles). | DB bloat over time; fine short-term, plan object storage before document vault (§3.6). |
| A4 | **Component size debt** — `SharedEnterpriseModule` ~3.8k lines, `GoMinaApp` ~1.7k, `ManageBusinessesModal` ~2.3k. | New cross-cutting UIs (Action Center) should be their own component, not grown inside these. |
| A5 | **No usage telemetry/feature flags.** | "Underused" in this report is inferred from code, not measured. |
| A6 | **Q1-2026 baseline is static** by design (blended into finance report). | Will increasingly diverge from live data as the app ages; needs a "baseline expiry" or rolling-baseline decision eventually. |

---

## 3. Gap analysis — by the requested focus areas

Each gap states: what exists today → what is missing → severity.

### 3.1 Task / action management — **the biggest structural gap**

**Exists:** actions are scattered across five disconnected systems — checklist entries
(recurring daily routine, no cross-module view), audit issues (assigned + priority, but
**no due date**), advisor-note follow-ups (due date, but advisor-scoped only), block/
poultry order fulfilments, transport maintenance due dates. The Worker dashboard shows
*sales tools*, not "my work".

**Missing:**
- A unified **Action Center**: one list of "who owes what by when" across businesses,
  modules and people — with owner, due date, priority, source-link, status and
  completion audit trail.
- Due dates + escalation on **audit issues** (currently priority-only).
- Converting a **notification → task** ("turn this into an action") — today
  notifications are read-and-forgotten.
- Recurring **non-daily** tasks (weekly/monthly/one-off) outside checklist templates.
- A personal "Today" view per worker/GM across all businesses they serve.

**Severity: HIGH.** This is the single change that turns GoMina from a *recording
system* into a *management system*. Everything else in this list produces actions that
currently have nowhere to land.

### 3.2 Notifications — strong plumbing, weak orchestration

**Exists:** 25+ event types, correct tenant-scoped fan-out, web push, per-user push
settings, backfill on hand-over. Real-time coverage is good.

**Missing:**
- **Scheduled digest** ("your 7:00 recap: 4 overdue items, 2 orders, cash position")
  — blocked by A1 (no cron).
- **Escalation SLAs** — an overdue audit issue or checklist doesn't re-notify the
  owner after N days.
- Notification → action conversion (ties to §3.1).
- Bell management at scale (bulk mark-read, auto-archive old).

**Severity: MEDIUM-HIGH.** The infrastructure is done; the missing piece is time-based
behaviour (cron) plus the Action Center as the destination.

### 3.3 Approvals — one-off, not a framework

**Exists:** assets have the only complete request→approve/reject workflow with audit
log; feed/block batches have QC hold/release; audit has correction requests.

**Missing:**
- **Expense approvals** — workers with `canRecordExpenses` post directly to the P&L;
  there is no manager sign-off tier and no way for an owner to delegate a spending
  limit.
- **PO approval** before status moves past DRAFT/RAISED.
- **Payroll run approval** before payment.
- A generic approvals queue/table pattern (the asset workflow is bespoke).

**Severity: MEDIUM-HIGH** for expense approvals specifically (money leaves the
business un-reviewed); the others are nice-to-have.

### 3.4 Procurement — solid core, missing the money side

**Exists:** full PO lifecycle, GRN stock gate, preorder demand propagation, supplier
scoping. Genuinely good.

**Missing:**
- **Low-stock → reorder alerts** (and optionally auto-draft PO). `min_stock_threshold`
  already exists in inventory — the trigger simply isn't wired to notifications.
- **Supplier payables / statements** — what do we owe suppliers, aging by supplier
  (POs are booked as expenses on receipt only).
- Supplier performance (lead time, fill rate, price variance) and price lists.

**Severity:** low-stock alerts are a **quick win** (infra 90% exists); payables aging
is medium value.

### 3.5 CRM — transactional, not relational

**Exists:** customers with types + spend, orders, credit sales + installments,
tracking, quotations→invoices (CONVERTED status tracked).

**Missing:**
- **Customer 360 / statements** — lifetime value, order history, credit exposure and
  payment history in one view; printable customer statement.
- **Dunning** — overdue credit-sale alerts (data exists: due dates, installments;
  only advisor notes have overdue badges today).
- Follow-up reminders, segmentation, loyalty.

**Severity: MEDIUM.** The data is nearly all there; it's a presentation + alerting
gap more than a schema gap.

### 3.6 Documents — pockets, no vault

**Exists:** sales documents (quote/invoice/receipt PDFs), employee documents with
`expiresOn`, evidence/receipt/asset photos, universal export center.

**Missing:**
- A **central per-business document vault** (licenses, permits, insurance, leases,
  calibration certs) with categories and expiry **alerts** — the exact pattern already
  proven in `employeeDocuments.expiresOn`.
- Versioning / general attachments to arbitrary records.

**Severity: MEDIUM.** High practical value for a multi-business owner (renewals are a
real compliance risk), moderate effort. Depends on A3 (image storage) for scale.

### 3.7 Profitability, budgeting & cash flow

**Exists:** business/branch-level revenue − expenses, profit + margin trends, cash
flow *as history* (net operating cash flow, liquid surplus), scenario what-if with
live baseline, benchmarks (FCR, weight), feed-mill cost/kg.

**Missing (the heart of the "managing multiple businesses" ask):**
1. **Budgets** — no budget table, no budget-vs-actual variance per business/category/
   month. This is the most-requested missing control in the whole app.
2. **Cash-flow *forecast*** — projected inflows (receivables: credit sales +
   installments + preorder pipeline) and outflows (payables: open POs + payroll
   calendar + recurring expenses) → 4/13-week runway. All source data already exists;
   only the projection layer is missing.
3. **Unit economics** — product/service-level profitability (SKU sell price vs landed
   cost → COGS/margin per product); per-flock/batch economics (feed cost + mortality
   + revenue → profit per bird/kg); shared-cost allocation.
4. **Consolidated P&L with inter-company elimination** — transfers between own
   businesses exist as a transaction type but no elimination logic.

**Severity: HIGH** — this is the single biggest *analytical* gap. Natural sequencing:
budgets + cash forecast first (extends the existing financeReport + scenario engines,
both built to be extended), unit economics second (needs costing conventions first).

### 3.8 Production closeout — status flips, not economics

**Exists:** flocks (ACTIVE/SOLD/CULLED/CLOSED), aqua batches
(GROWING/HARVESTED/SOLD/CULLED), feed/block batches (MIXING→QC→RELEASED/REJECTED).

**Missing:**
- A **closeout wizard** that computes full-cycle economics (all costs + all revenue →
  profit per bird/kg/batch), reconciles remaining stock, archives actuals into
  benchmarks for future cycles, and produces a closeout report. Today "CLOSED" is a
  status with no computed P&L and no learning loop back into benchmarking.

**Severity: MEDIUM-HIGH** for farm businesses; depends on cost-allocation decisions
from §3.7.3.

### 3.9 Executive reporting — a pulse, not a board pack

**Exists:** command-center dashboard (combined net profit, ROI, risk score, cash,
out-of-stock rollup, growth), finance pulse, universal export.

**Missing:**
- **Scheduled board pack** (weekly/monthly PDF per business + consolidated, delivered
  by email/push) — blocked by A1.
- KPI **targets vs actuals** per business (needs budgets, §3.7.1).
- Exception-based exec view ("only what deviates").
- Cross-business scorecard ranking.

**Severity: MEDIUM.** Largely a *consequence* of budgets + scheduling existing first —
don't build standalone.

### 3.10 AI-assisted management — deterministic base, no conversational layer

**Exists:** strong rules engines — daily-notes analysis, advisor corroboration,
smart alerts, scenario simulation, insights with cooldown.

**Missing:**
- **LLLM layer on top** (optional, opt-in): natural-language Q&A over their own data
  ("why did poultry profit drop in August?"), narrative generation for board packs,
  demand forecasting for preorder/stock planning.
- Insight → one-click action (ties to §3.1).

**Severity: LOW-MEDIUM** and deliberately last: the deterministic engines are the
moat; an LLM should *narrate and query* them, not replace them. Also add value cheaply
first via anomaly detection (statistical z-scores on existing series — no LLM needed).

### 3.11 Integrations hub — presentation only

The integrations table is a status-flag display; MoMo "integration" is a manual
verification status, not an API. Not worth building real integrations until budgets/
actions land; keep the honest UI.

### 3.12 Other gaps noted for completeness

- **Livestock module** underbuilt vs siblings (§1.1) — no herd inventory, breeding,
  weights. Medium value if livestock businesses are active.
- **No scheduled exports** (manual only) — folds into §3.9.
- **No leave requests** for HR — minor.
- **No vendor lock risk** — everything is server-side and testable; good.

---

## 4. Duplication & underuse (consolidation debt)

| # | Item | Detail | Recommendation |
|---|---|---|---|
| 4.1 | **Five checklist systems** | Modern generic (templates/entries/plan-templates/flock-plans, audited) coexists with legacy `poultryChecklists`, `blockFactoryChecklists`, `aquacultureChecklists`, `transportVehicleChecklists` tables + separate UIs. | Migrate legacy tables onto the generic system; keep vehicle checklist as a template *category*. Do **after** higher-value work; tech debt, not user-visible. |
| 4.2 | **Five permission surfaces** | EnterpriseUserPanel, UserAccessConsole, staff-access, advisor assignments, auditor grants — one core (`permissions.ts`) but fragmented UX. | Document mapping; unify gradually. No new surface. |
| 4.3 | **Four alert-ish systems** | poultryAnalyticsAlerts vs aiInsights vs dailyNotes.aiIssues vs advisor-note severity — different surfaces, overlapping intent. | Route all into the Action Center (§3.1) as the single destination. |
| 4.4 | **Underused: aiInsights** | Generated with cooldown, ACTIONED/ARCHIVED statuses exist, but no path from insight → task/scenario. | Wire "insight → action" in Action Center. |
| 4.5 | **Underused: scenarioSimulations** | Full live engine; saved sims exist but no linkage to budgets (a budget *is* a scenario you commit to). | Reuse the engine for budget creation. |
| 4.6 | **Static Q1-2026 baseline** | Blended into finance report by design; will age. | Decide rolling vs frozen baseline when budgets land (budgets eventually replace the baseline). |

---

## 5. Ranked roadmap

Scores: Value (business impact), Urgency, Complexity (build effort), Dependencies.
All build **on** existing engines — no duplication.

| Rank | Initiative | Value | Urgency | Complexity | Depends on |
|---|---|---|---|---|---|
| **P1** | **Unified Action Center** — generic tasks table (owner, due date, priority, source link, status, completion audit); due dates on audit issues; notification→task conversion; per-person "Today" view; insights/alerts route in | ★★★★★ | ★★★★★ | Medium | None — pure addition; uses existing audit-log + notify patterns |
| **P2** | **Vercel Cron + daily digest + SLA escalation** — first scheduled jobs: 7:00 recap push/notification, overdue escalation, low-stock sweep | ★★★★☆ | ★★★★☆ | Low-Med | P1 (digest needs the action list to summarize) |
| **P3** | **Low-stock reorder alerts** — wire `min_stock_threshold` → notifyPurchase-style alert (+ optional auto-draft PO) | ★★★★☆ | ★★★☆☆ | **Low** | None — quickest win in the list |
| **P4** | **Budgets + cash-flow forecast** — budget table per business/category/month; variance view in financeReport; 4/13-week projection from credit sales + open POs + payroll; reuse scenario engine | ★★★★★ | ★★★★☆ | Medium | Nothing hard; conceptually after P1 |
| **P5** | **Expense approval workflow** — generalize the asset REQUEST→APPROVE pattern; spending limits by role | ★★★★☆ | ★★★☆☆ | Low-Med | None (pattern exists) |
| **P6** | **Production closeout costing** — closeout wizard for flocks/batches/batches-of-blocks: full-cycle P&L, stock reconciliation, actuals→benchmarks | ★★★★☆ | ★★★☆☆ | Med-High | Costing conventions (share with P7) |
| **P7** | **Product-level profitability + customer 360** — SKU margins via COGS; customer statement/360 + dunning alerts | ★★★☆☆ | ★★★☆☆ | Medium | P4 conventions; dunning needs P2 |
| **P8** | **Document vault with expiry alerts** — extend employeeDocuments pattern to business docs; alert via P2 | ★★★☆☆ | ★★☆☆☆ | Medium | P2 (alerts); A3 (storage) for scale |
| **P9** | **Scheduled board pack** — weekly/monthly exec PDF from financeReport + budgets + action stats | ★★★☆☆ | ★★☆☆☆ | Low-Med | P2 + P4 |
| **P10** | **LLM-assisted layer (opt-in)** — NL Q&A over deterministic engines; narrative board-pack text; forecasting | ★★☆☆☆ | ★☆☆☆☆ | Med-High | P1 + P4 (needs actions + budgets to talk about) |
| **P11** | **Livestock depth + checklist consolidation + integration APIs** | ★★☆☆☆ | ★☆☆☆☆ | Medium | Deliberately last |

### Recommended build order (what GoMina should build next)

**Build P1 + P3 together first, with P2 immediately after.**

1. **P1 Action Center** is the keystone: every other gap produces actions
   (overdue credit, expiring license, budget breach, QC issue) that today have
   nowhere to land. It is a pure addition — no schema migration risk, no duplication,
   and it immediately makes existing features (audit issues, advisor follow-ups,
   insights, notifications) *more* useful without touching them.
2. **P3 low-stock alerts** rides along because the infrastructure is 90% there —
   a fast, visible win that proves the notification→action loop.
3. **P2 cron + digest** then gives the whole system a heartbeat (and unblocks SLA
   escalation, dunning, expiry alerts, board packs).
4. **P4 budgets + cash forecast** is the highest-value analytical build and the
   owner's "am I actually making money across these businesses?" answer.
   Everything after it (closeout costing, profitability, board packs) compounds.

---

## 6. Explicit non-recommendations (avoid duplication)

Do **not** build: a new notification system (extend `notify.ts`), a new PO/stock flow
(extend procurement), a new finance calculator (extend `financeReport.ts` /
`scenarioEngine.ts`), a new checklist app (migrate onto the generic one), a bespoke
approvals UI per module (generalize the asset pattern once), or a separate "manager
dashboard" (the command center is that — feed it).

---

*Assessment produced from a full read of the live codebase at commit `120def7`.
No code was changed.*
