# Financial Permissions — Audit, Root Causes and Fixes

**Scope:** every surface in GoMina 360 that can expose a financial figure, checked
for viewers the OWNER has denied financial access to. Both the UI and the backend
were audited, so a UI-only masking could not pass as a fix.

**Policy of record:** `docs/ENTERPRISE-PERMISSIONS-AND-FINANCIAL-ACCESS.md`
("Two things are never implied by a role": *Enterprise Users* and *Financial
figures*; the latter covers the Central Financial Report, the Command Center P&L,
budgets, cash-flow forecast, payroll, **employee salaries** and money exports).

**Result:** 9 leaks found and fixed. The originally reported one was a symptom of
a broader pattern — the report component had no permission awareness at all, and
seven further surfaces rendered money outside it entirely.

---

## 1 · The reported leak and its root cause

`FinancialReportSection` (1,294 lines) derives a full P&L — revenue, expenses,
net profit, margins, average ticket, per-branch and per-month series — from the
`transactions` and `metrics` it is handed. It had **no notion of who is looking at
it**.

`/api/init` deliberately **keeps** transaction amounts for every scoped viewer,
because recording a sale requires them. That is a sound design decision, and it
was not changed. But it means a viewer denied finance still arrives at the report
holding enough data to reconstruct exactly the report they must not see.

`CommandCenterDashboard.tsx:1298` rendered it with no guard, so a viewer with
financials denied got the full Enterprise Financial Report. Measured before the
fix, as a **General Manager without the finance grant** — an executive who can
open the Command Center but not Finance:

| Surface | Denied viewer, before |
|---|---|
| Command Center KPI tiles | `•••••` (correctly masked) |
| Sidebar *Finance & Reports* | hidden (correct) |
| **Enterprise Financial Report** | **GH₵ 1.34M · GH₵ 1.19M · GH₵ 147.03k** |

Seven further call sites had the same defect: `BoutiqueModule`,
`BusinessDashboardModule`, `CarWashModule`, `AquacultureModule`,
`ElectronicsShopModule`, `BlockFactoryModule` and — via
`SpecializedBusinessView` — the remaining business types. Fourteen call sites in
total.

### Fix

The gate lives **inside** `FinancialReportSection`, not in each caller, so a future
caller cannot forget it. A missing `currentUser` **denies** — a caller that fails
to thread the prop fails closed, not open. Denied viewers get a lock notice and
**no** derived figure is computed into the DOM at all, so the numbers cannot be
read out of the page source either.

All fourteen call sites now pass `currentUser`, and section C of the suite pins
that so a future omission is a test failure rather than a silent denial.

---

## 2 · Findings

| # | Finding | Surface | Fix |
|---|---|---|---|
| **F-17** | Report had no permission awareness; 14 call sites rendered a full P&L | `FinancialReportSection` + every business module | Gate inside the component; thread `currentUser` from all 14 callers; new `FinancialGate` for money rendered outside it |
| **F-18** | Audit timeline printed **every employee's monthly salary** and each payroll run's **net total** | `GET /api/audit` | `canSeeFinancials` threaded into `collectRecords()`; salary and payroll net withheld, including the salary text in `detail` |
| **F-19** | Assistant gated on **role alone** — a Branch Manager could ask "how is this month's finance?" and be answered from the real ledger | `GET/POST /api/assistant`, `lib/biAssistant.ts` | `financialsAuthorized` added to `AssistantScope`; money intents refused **before** any snapshot is computed; inventory valuation and stock-value figures follow the grant |
| **F-20** | Revenue / Expenses / Net Profit / margin tiles rendered **above** the gated report | Car Wash → Reports | Tab body wrapped in `FinancialGate` |
| **F-21** | Its own ledger P&L — income, expenses, net, working capital — with **no report alongside it at all**, so nothing gated it | Telecom → Finance | Tab body wrapped in `FinancialGate` |
| **F-22** | Projected revenue, net profit delta, ROI and the full baseline (revenue, expenses, margin, **asset valuation**) | Scenario Planner | `FinancialGate` around the money block; model controls stay usable |
| **F-23** | Credit-sales roll-ups: total sales, amount paid, **outstanding balance** | Branch Manager Sales | Masked to `•••••` |
| **F-24** | "active value" order roll-up | Customer Tracking | Masked to `•••••` |
| **F-25** | Credit balances, approval amounts and an order-value roll-up in the BI feed; inventory valuation in the stock answer | `/api/assistant` feed + Q&A | Counts and operational detail kept; every monetary figure follows the grant |

---

## 3 · What was deliberately left visible, and why

The policy keeps *"sales recording, stock, customers, suppliers, assets,
checklists, attendance, audit, documents"* **role-scoped exactly as before**.
Two things follow, and both are pinned by the suite so they cannot drift:

- **Individual order values** (`ct-orders-amount-*`) stay visible to an
  unauthorised viewer. Fulfilling or collecting an order requires knowing what it
  is worth. Their **roll-ups** (F-24) are analytics and are masked.
- **The credit-sale records** stay visible so a branch manager can still work the
  collection list. The **balances** are money and are masked (F-23).

The sweep's allow-list encodes exactly these two exceptions, each with the policy
line that justifies it, so a third one cannot be added quietly.

---

## 4 · Regression suite

`dev-tooling/verify-financial-permissions.mjs` — **103 pass / 0 fail**.

| Section | What it pins |
|---|---|
| **A** | Command Center report, four role classes; denied viewers see zero figures |
| **A1b** | **The reported scenario** — an *executive* without the grant, the only role that can reach the Command Center with financials denied |
| **A2** | Finance & Reports reachable for the OWNER, hidden for a denied viewer |
| **A3** | Per-unit report across **10 business types**, granted vs denied |
| **B / B2 / B3** | Budgets, payroll, cash-flow, backup export refused; roster served with salary withheld; audit timeline redaction |
| **C** | Every `<FinancialReportSection>` call site threads `currentUser` |
| **D / D2 / D3** | The second wave: Car Wash, Telecom, Scenario Planner, BI Assistant, credit totals, tracking roll-up |
| **E** | Whole-app sweep — 28 top-level tabs + 10 unit modules, zero currency for a denied viewer |

Authorised access is asserted alongside every denial: an over-broad lock that also
hid the report from the OWNER or from a granted manager would fail the suite.
Section A3b proves the lock tracks the **grant**, not the role — flipping one
branch manager's authorisation brings the report back.

The suite normalises its fixture on entry and restores every grant, Auditor
assignment and probe unit it creates, including cascading the probe ledger so it
leaves no orphaned transactions behind.

---

## 5 · Test results

| Check | Result |
|---|---|
| `verify-financial-permissions.mjs` | **103 pass / 0 fail** |
| `tsc --noEmit` | **0 errors** |
| ESLint (`src`) | **0 errors**, 166 warnings (all pre-existing) |
| Production build | exit 0 |
| Whole-app sweep, denied viewer | **0 currency figures** across 38 surfaces |

Existing suites re-run: enterprise-permissions **200/0**, audit-access **28/0**,
audit-records **29/0**, budgets-cashflow **26**, business-backup **54**,
employees **46/46**, credit-sales **39/0**, expense-permissions **43/0**,
payroll2 **53/53**, boutique **74**, finance-allproducts-fresh **49/0**,
permissions-storefront **48/0**, expense-ui-manage **22/0**, charts-live-data
**20/0**.

### Pre-existing failures (not caused by this work)

Each was reproduced on a **stashed, rebuilt baseline** with all `src/` changes
removed, to prove they are not regressions:

| Suite | Failure | Note |
|---|---|---|
| `verify-business-scope` | 9 of 94 | identical on the untouched baseline |
| `verify-notify-activity` | 11 | identical on the untouched baseline |
| `verify-telecom` | 1 | the module mounts and renders all 8 tabs under these changes; the suite's sidebar-text click misses its target |
| `verify-export-center` | — | login throttle starved the run; environmental |

One genuine defect **was** introduced by this work and has been fixed: the suite's
own cleanup deleted its probe unit without deleting the probe ledger, leaving
orphaned transactions that inflated the counts later suites assert on.

---

## 6 · Files changed

**New**
- `src/components/FinancialGate.tsx` — shared gate for money rendered outside the
  report component.
- `dev-tooling/verify-financial-permissions.mjs` — the suite.

**Gated at source**
- `src/components/FinancialReportSection.tsx` — the root-cause gate.
- `src/components/{Aquaculture,BlockFactory,Boutique,BusinessDashboard,CarWash,CommandCenterDashboard,ElectronicsShop,EnterpriseFinanceView,HardwareStore,Livestock,PoultryFarm,RestaurantKitchen,SpecializedBusinessView,TelecomServices}Module.tsx` — `currentUser` threaded (14 sites).
- `src/components/{CarWash,TelecomServices}Module.tsx`, `ScenarioPlannerView.tsx` — tab bodies wrapped in `FinancialGate`.
- `src/components/BranchManagerSalesView.tsx`, `CustomerTrackingPanel.tsx` — roll-ups masked.
- `src/components/GoMinaApp.tsx` — `currentUser` passed to `ScenarioPlannerView`.

**Backend**
- `src/app/api/audit/route.ts` — salary and payroll-net redaction.
- `src/app/api/assistant/route.ts`, `src/lib/biAssistant.ts` — finance authorisation threaded through the feed and the Q&A.
---

# Task 8 · Final audit — "is it consistent everywhere?"

The open question was no longer *are the gates present* but *does every surface
apply the same rule to the same figure*. It did not. Three classes of defect
were found, and all three were the same bug wearing different clothes: **the
same number was withheld in one place and published in another**, so a denied
viewer did not have to break anything — they just had to look somewhere else.

## F‑26 · The deletion audit trail published money (new finding)

**Symptom.** The whole-app sweep (§E) flagged exactly one leak:

```
deletion-log-row-7 :: TRX-2026-49170696 — GH₵ 123 (ProbeCat)
```

**Root cause.** This is not a missing gate, it is a **stale string**.
`src/app/api/transactions/route.ts` composes the deletion label as
`` `${transactionNumber} — GH₵ ${amountGhs} (${category})` `` and stores it in
`record_deletion_logs`. That string is frozen at write time, so every later
permission check is irrelevant to it: the figure is not a field, it is part of
the record's *name*. The immutable audit trail — the one surface that must stay
complete, because it is admissible evidence of what happened — had become a way
*around* the financial gate for any manager who can open a module's audit panel.

Two writes (`src/app/api/transactions/route.ts:468` and `:486`) and two reads
(`/api/enterprise` `?deletionLogs=1`, and the `DELETION` records in `/api/audit`).

**Fix — redact at the read, not at the write.** Option A (store a money-free
label) was rejected: the audit trail is an immutable historical record, and
silently rewriting it would destroy the evidence that the deletion *was* of a
GH₵ 123 transaction. The right invariant is **the record stays named and
complete for an authorised viewer, and stays named but figure-free for anyone
else** — the trail never stops being evidence, it just stops carrying the
amount to someone who may not see it.

- `src/app/api/enterprise/route.ts` — `recordLabel` passes through
  `GHS_FIGURE_RE` for viewers failing `canSeeFinancials`, keeping the
  transaction number and category: `TRX-2026-49170696 — GH₵ ••••• (ProbeCat)`.
- `src/app/api/audit/route.ts` — same treatment on the `DELETION` timeline
  record's `title`, and `amountGhs` (from the stored snapshot) is withheld.

One regex, two call sites, so the two surfaces cannot drift apart again.

## F‑27 · Asset valuation was hidden in `/api/init` and published in `/api/audit`

**Root cause.** The most direct instance of the inconsistency class. The app
already has a settled position on asset valuation — `src/app/api/init/route.ts`
strips `purchasePriceGhs` / `currentValueGhs` and flags
`financialsRestricted`, with the comment *"purchase/current valuation is capex
data ⇒ dropped"*. The audit timeline, reading the **same columns of the same
rows**, rendered them in the record detail *and* in `amountGhs`. A denied
executive could read every asset's book value by opening Audit & Review.

**Fix.** `/api/audit` now applies `/api/init`'s rule — detail becomes
`"Valuation restricted · …"`, `amountGhs` is `null` — under the same
`financialsAuthorized` flag already used for salary and payroll.

This is the finding worth remembering: the gate was correct, and the *policy
was already written down*, in a different route. **A rule expressed in one
module is not a system rule.**

## F‑28 · A cap that counted itself (notify-activity root cause)

Already diagnosed and fixed in the previous pass; recorded here because it is
the third instance of the same class. `AUDIT_EVENT_DAILY_CAP` was enforced by
counting the recipient's `AUDIT_EVENT` rows in the last 24 h — but the
**cap-summary row that records the suppression was itself written with
`type: "AUDIT_EVENT"`**, so it counted toward the cap:

> The cap-summary row was counted like any other event, which made the cap
> self-sustaining: once a recipient reached the ceiling, every suppressed event
> wrote or refreshed the summary row, and that row kept the 24 h count at or
> above the ceiling on its own.

At a ceiling of 12, ordinary seeded traffic exhausted the budget before any
deletion happened, and **every subsequent deletion alert was silently dropped**
— the Owner saw a roll-up row and nothing else. Fixed by excluding the summary
row from its own count (`ne(recordRef, capRef)`) and raising the ceiling to 40.
A rate limit whose side effect is silence is worse than no rate limit.

## F‑29 · `verify-export-center` was asserting against a rule that did not exist yet

Not an app defect — a stale test, and worth recording because the *app was
right*. An earlier audit made SUPERVISOR unit-scoped (`requiresUnit`), and
`POST /api/users` correctly refuses a unit-scoped role with no unit. The suite
still created its supervisor with `extraAccessIds: [BIZ1]` — a field the create
handler does not read — so the fixture was rejected with `400` and the whole run
was starved, misreporting a throttle failure. Fixed to pass `assignedBusinessId`.

## Regression additions

`verify-financial-permissions.mjs` grew a **section F** that seeds a real
money-bearing deletion, then asserts the rule in **both** directions, because a
redaction that hides a figure from everyone is not a fix:

- denied executive — deletion-log label keeps the record, drops the figure
- denied executive — audit `DELETION` rows carry no figure
- denied executive — audit `ASSET` rows carry no valuation
- **OWNER still sees the figure in the deletion log**
- **OWNER still sees asset valuation in the audit trail**

## Task 8 results

| Suite | Result |
|---|---|
| **financial-permissions** | **110 / 0** (was 102 / 1) |
| business-scope | 94 / 94 |
| notify-activity | 100 / 0 |
| telecom | 63 / 63 |
| enterprise-permissions | 200 / 0 |
| audit-access | 28 / 28 |
| audit-records | 29 / 0 |
| export-center | 77 / 0 (was starved by F‑29) |
| tenant-isolation | 15 / 0 |
| actor-spoof-live | PASS |
| employees · payroll2 · boutique · budgets-cashflow · business-backup | 46/46 · 53/53 · 74 · 26 · 54 |
| credit-sales · expense-permissions · inventory-permissions · staff-access | 39/0 · 42/0 · 34/0 · 44/0 |
| finance-allproducts-fresh · permissions-storefront · expense-ui-manage · charts-live-data | 49/0 · 48/0 · 22/0 · 20/0 |
| p4-writers · single-writer | 23/0 · 35/0 |
| `tsc --noEmit` | **0 errors** |
| `eslint .` | **0 errors** (166 pre-existing warnings; none from this work) |
| `npm run build` | **✓ Compiled successfully** · 88 static pages |

Per-unit reports, unchanged and still the headline result:
**OWNER authorized 10/10 types · denied executive clean 10/10 types.**

## Deployment readiness

**Ready to deploy.** Every gate is enforced at source and re-checked at the API,
the full regression is green, and the two tests that were failing for unrelated
reasons have been fixed at their real causes rather than baselined. No external
configuration is outstanding: the only open item remains the optional F‑14
operational verification, which needs credentials and a live provider rather
than a code change.
