# GoMina 360 — UI/UX & Structural Audit

**Date:** 2026-09-27 · **App commit:** `df581d7` (live at :3000, canonical seed + restored live data) · **Auditor:** agent walkthrough of the running app (OWNER, GM, BM, WORKER roles + public pages) plus source-level analysis. **No code was changed for this audit.**

---

## 1. Executive summary

GoMina 360 is functionally deep, unusually well-tested (90 verification suites), and visually consistent — **zero console/page errors across all 38 desktop views, mobile views and public pages walked, and zero horizontal overflow anywhere**. The dominant problems are *structural*, not cosmetic:

1. **Duplication at scale** — 93 components / 62.7k LOC with 10 hand-built vertical modules that re-implement the same patterns: **11 components implement sale entry, 11 expense entry, 53 build their own modal overlays, and the two feed-mill modules are ~76 % identical code**. Every new vertical (and every fix) pays a 10× tax.
2. **Everything-on-one-page density** — the owner's Command Center is a **7,500 px (desktop) / 12,051 px (mobile) scroll wall**; the Audit Command Center renders **535 visible buttons in 10,101 px**; module tab rows mix *view* tabs with *action* tabs (Sale/Order/GRN/Expense…).
3. **Navigation redundancy** — three parallel navigation systems (left sidebar, right ContextNavigator rail, sticky header) plus per-role sections render the **same destinations up to 3×** on one screen, decorated with ~14 different badge-chip types.
4. **One live defect found** — the Action Center shows ~24 orphaned “Business #NNN open” chips (185 checklist rows pointing at deleted businesses) that click through to nothing.

The highest-leverage moves: one shared transaction-entry primitive, one feed-mill engine, a modal/tab/panel primitive set, a standardized module shell, and splitting the two command centers. Full prioritization in §5.

---

## 2. Method

- **Live walkthrough** (headless Chromium against the running production build): logged in as OWNER, GENERAL_MANAGER, BRANCH_MANAGER and WORKER; walked all 28 sidebar destinations, module sub-tabs, Audit and Finance sub-tabs; mobile pass at 430×932 (touch); public `/order` and `/track`. Captured 47 screenshots (`reports/screenshots/uiux-audit/`) and per-view DOM metrics (visible buttons, tab labels, tables, inputs, page height, overflow).
- **Structural analysis**: component inventory and sizes, module-routing map (`GoMinaApp`), sidebar/ContextNavigator source, duplication probes (feed-mill diff, modal count, entry-form greps), DB checks for the data-hygiene findings.

### Measured view density (desktop 1500×950, OWNER)

| View | Visible buttons | Doc height | Tables | Notes |
|---|---|---|---|---|
| Command Center (landing) | 88 | 7,500 px | 3 | + 12,051 px on mobile |
| Audit & Review | **535** | **10,101 px** | 1 | 7 sections in one page |
| Enterprise Users | 124 | 2,163 px | 1 | |
| Transactions & MoMo | 103 | 4,055 px | 1 | |
| Poultry module | 66 | 5,226 px | 1 | 12 sub-tabs |
| Finance & Reports | 69 | 4,764 px | 2 | 9 date-range chips + 3 granularity chips + budget/cashflow toggles |
| Action Center | 93 | 1,976 px | 0 | incl. ~24 orphaned chips |

---

## 3. Current information architecture (as built)

**Left sidebar (pinned, collapsible, 160 px on phones):** Executive group (Command Center, Action Center) → business list (9 units) → *Shared Enterprise Modules* (Sales & Payments, Finance & Reports, Customers & CRM, Customer Order & Tracking, Pre-Orders, BI Assistant, Document Vault, Suppliers, Employees & Payroll, Assets, Inventory, Transactions & MoMo) → *Oversight & Assurance* (Audit & Review) → *Support* (Storefront HELP) → *AI/Decision Support* (AI Strategic Advisor, Scenario Planning, Farm Advisors, Integrations Hub, Enterprise Users, Platform Owners).

**Parallel systems:** a sticky ContextBar (< xl) and a persistent right-hand ContextNavigator rail (≥ xl) that mirrors the whole sidebar grouping again; the sticky header additionally carries **AI Strategic Advisor, Scenario Planner, How to Use** on *every* view — duplicating sidebar destinations.

**Modules (by business category):** POULTRY, BLOCK, AQUA, LIVESTOCK, FOOD, TECH, WASH, HARDWARE, TELECOM, TRANSPORT → 10 bespoke components (835–1,892 lines each) + generic fallbacks (`BusinessDashboardModule`, `SpecializedBusinessView`, `SharedEnterpriseModule` 3,823 lines).

---

## 4. Findings

Severity: 🟥 defect · 🟧 major UX/structure · 🟨 consistency/polish · 🟩 strength.

### 4.1 Defects (fix regardless of redesign)

- **🟥 F1 — Orphaned action chips in the Action Center.** “Today’s incomplete checklists” renders one chip per business with open checklist entries. 185 `checklist_entries` rows point at **deleted** businesses (unit deletion does not cascade or block on dependents), producing ~24 `Business #426 open`-style chips (fallback label at `ActionCenter.tsx:531`). Clicking one calls `onSelectTab(String(businessId))` — **a destination that does not exist (dead click)**. The same `Business #${id}` fallback pattern exists in `ApprovalInbox` (×2) and `AuditCommandCenter`.
- **🟥 F2 — BM navigation shows the same destinations 3×.** Emmanuel’s screen renders the “Branch Management” sidebar group (Sales & Payments / Branch Assets / Manage Sales Persons), the “Shared Enterprise Modules” Sales & Payments entry, *and* the right-rail ContextNavigator “Branch Workspace” group with the same three links. Three nav systems, no dedupe rule.

### 4.2 Duplication (consolidation targets)

- **🟧 F3 — Sale/expense entry re-implemented everywhere.** 11 components build sale forms, 11 build expense forms, 14 POST to `/api/transactions`, 10 to `/api/enterprise`. Recording one sale is possible from: a module quick-tab, the global *Sales & Payments* view (New Sale / Credit / Invoices / Quotations / Receipts / Returns), and *Transactions & MoMo* (Log New Transaction). Expenses: module quick-tab, module Finance tab, Finance & Reports, Transactions & MoMo. Each copy has its own validation and its own drift risk.
- **🟧 F4 — The two feed mills are ~76 % identical** (`PoultryFeedMill` 1,195 lines vs `AquaFeedMill` 1,221; only 282 diff lines after renaming poultry/aqua/fish terms). Same for large parts of the module shells (tab bar + dashboard KPI grid + alerts + trend charts pattern repeated in all 10 modules).
- **🟧 F5 — 53 bespoke modal overlays** (`fixed inset-0` hand-rolled 53 times): no shared Modal primitive → inconsistent sizes, escape/backdrop behavior and focus handling.
- **🟧 F6 — Five reporting surfaces**: per-module *Finance* tabs, central *Finance & Reports*, *Analytics* inside Sales & Payments, *Reports & Charts* inside Audit, and the UniversalExportCenter. (`FinancialReportSection` itself is properly shared — mounted 14× — but it is framed by five different hosts.)
- **🟧 F7 — AI surface sprawl**: AI Strategic Advisor, Scenario Planner, BI Assistant, Farm Advisors console, per-module “AI Knowledge” tab (poultry), “AI Smart Alerts” (aqua), “AI Business Insights” (tech/hardware), advisor notes, plus a 3,523-line guide library. Eight-plus AI-ish surfaces with overlapping jobs and no single entry point.
- **🟨 F8 — Customers/Inventory embedded where they don’t belong**: the Sales & Payments view carries its own *Customers*, *Manage Customers*, *Inventory*, *View Full Inventory* tabs — duplicates of the CRM and Inventory modules.

### 4.3 Layout & density

- **🟧 F9 — Command Center scroll wall.** The owner’s landing page stacks enterprise overview, checklist compliance, comparison scope selector, performance matrix, full financial report, AI recommendations, scenario planner and how-to — 7,500 px desktop, **12,051 px on a phone**. Nothing above the fold tells you where to start.
- **🟧 F10 — Audit Command Center overload**: 535 visible buttons, 10,101 px, seven sub-views (Records / Issues / Reports & Charts / Auditor Access / Audit Log / Deletions …) in one page with no sub-navigation.
- **🟧 F11 — Module tab rows mix views with actions.** Poultry: `Dashboard | Flock & Batch | Feed | Feed Mill | Water | Health & Vaccination | Production | Inventory | Finance | Daily Checklist | AI Knowledge` (views) — while blocks/food/tech/hardware/wash mix in `Sale | Order | Purchase | Delivery | GRN | Expense | New Wash | Dish | Serial | Claim` (actions). Two interaction types, one visual row; the quick-action placement differs per module.
- **🟨 F12 — Finance view control overload**: 9 date-range chips + 3 granularity chips + budget-vs-actual / 13-week cash-flow / set-budget-line toggles + refresh — 20 controls before content.
- **🟨 F13 — Enterprise Users view**: 124 visible buttons on one page.

### 4.4 Consistency & naming

- **🟨 F14 — Tab vocabulary drifts by module**: “Finance” (poultry/blocks/aqua/livestock) vs “Finance & Reports” (food/tech/wash/hardware); “Daily Checklist” vs “Staff & Checklist” (food) vs “Staff & Ops” (tech); aqua renames stock to “Fish Stock & Batches”. Same job, three names.
- **🟨 F15 — Badge-chip taxonomy overload**: sidebar chips observed: `ALL`(×2) `LIVE` `SETUP` `ASK` `NEW` `QA` `HQ` `PLATFORM` `SALES` `GRANTED` `MONITOR` `360° HQ` `CCTV/MoMo` `ACCESS` — ~14 types. Several are permanent marketing (`NEW` on Document Vault, `ASK` on BI Assistant) that never clear and train users to ignore chips.
- **🟨 F16 — Header duplicates sidebar**: “AI Strategic Advisor” and “Scenario Planner” render in the sticky header of every view *and* in the sidebar *and* in the right rail.

### 4.5 Mobile

- **🟧 F17 — Pinned 160 px rail on 430 px phones.** The sidebar never becomes a drawer (deliberate: “never covers the page”) — on a 430 px phone it consumes **37 % of the width**, with 8–11 px labels. Collapsing to the 48–56 px icon rail helps but is not the default. Combined with F9, mobile owner journeys are 12k-px scrolls in a 270 px column.
- **🟩 F18 — Otherwise mobile is solid**: zero horizontal overflow on every view, responsive suites green, worker mobile UI is appropriately minimal (nav = Action Center only; everything else in tabs).

### 4.6 Data hygiene surfaced in UI

- **🟨 F19 — Test/noise units in executive views.** The owner’s comparison matrix and sidebar include “E2E Transport Fleet” (a verification-suite unit). There is no archive/hide concept, so every business ever created stays in every executive view forever.

### 4.7 Public storefront & tracking

- **🟩 F20 — `/order` is genuinely good**: grouped catalog, focus per shop, details/lightbox, pre-order options, GPS-sorted branches, 9-step help guide, service areas. Long single page (6,431 px on mobile) but well-structured for shopping.
- **🟨 F21 — The admin *Customer Order & Tracking* view mixes jobs**: public storefront links (`/order`, `/track`), order ops, live tracking, **and procurement** (“Pre-order setup | Procurement”) in one place. `/track` public page is clean and focused.

### 4.8 Strengths to preserve (do not break in any redesign)

- 🟩 Zero console/page errors across the entire walkthrough; no layout overflow.
- 🟩 One dark, dense, professional visual language; `data-testid` discipline everywhere (testability is exceptional).
- 🟩 Permissions-aware IA (role-grant driven sections), single-booking data model, audit trail on deletes.
- 🟩 Shared `FinancialReportSection`, `UniversalExportCenter`, `LocationPinPicker`, daily-checklist panel — the *right* pattern already exists in places; it needs to become the rule.
- 🟩 Worker experience is simple and task-shaped; BM lands directly in their unit’s sales workspace.

---

## 5. Prioritized recommendations

> “Do not implement yet” — this is the proposed order of work. Effort: S ≤ 1 day · M ≤ 1 week · L multi-week.

### P0 — Defects & quick wins (do first, independent of redesign)

| # | Action | Where | Effort |
|---|--------|-------|--------|
| P0.1 | Fix orphaned Action Center chips: filter checklist aggregation to live businesses; global helper replaces all four `Business #${id}` fallbacks with “(deleted unit)” + disabled state; deletion flow cascades or warns on dependents (checklist entries at minimum) | `ActionCenter.tsx`, `ApprovalInbox.tsx`, `AuditCommandCenter.tsx`, business delete route | S–M |
| P0.2 | Dedupe BM navigation: one “Branch Workspace” group wins; ContextNavigator right rail stops re-listing sidebar destinations (becomes location/breadcrumb only) | `Sidebar.tsx`, `ContextNavigator.tsx` | S |
| P0.3 | Hide test units from executive defaults: `is_active/archived` flag on businesses, excluded from Command Center matrix + comparison scope (keep auditable) | schema + `CommandCenterDashboard` | S |

### P1 — Highest-leverage consolidation (the 10× tax)

| # | Action | Rationale | Effort |
|---|--------|-----------|--------|
| P1.1 | **One transaction-entry primitive** (`SaleEntryForm` / `ExpenseEntryForm` with module slots) replacing the 11+11 hand-rolled forms; module quick-actions become thin wrappers | Removes drift risk, ~3–5k LOC, one place to add validation/payment methods | L |
| P1.2 | **Merge the feed mills** into one `FeedMillEngine` (species-parameterized) — 76 % identical today | Halves maintenance of a core money path | M |
| P1.3 | **Shared UI primitives**: `Modal`, `Tabs`, `Panel`, `StatCard`, `DateRangeChips` — retire 53 bespoke modals and per-module tab bars | Consistency + a11y in one move | M |
| P1.4 | **Module shell contract**: standard tab vocabulary (`Dashboard · Operations · Stock · Orders · Finance & Reports · Checklist · Records`) and a single “+ New record” split-button in the module header for all entry actions (kills the view/action tab mixing of F11 and the vocabulary drift of F14) | New verticals become configuration, not 1,000-line components | M–L |
| P1.5 | **Split the two command centers**: Command Center → segmented sub-views (Overview / Compliance / Compare / Financials / AI) with a density budget (~2 screens each); Audit → sub-navigation for its seven sections | Turns the two 7.5–12k px walls into navigable spaces | M |

### P2 — IA, consistency, AI rationalization

| # | Action | Effort |
|---|--------|--------|
| P2.1 | **Single primary navigation**: sidebar is the IA; ContextNavigator becomes a compact location indicator (no duplicate links); remove header AI/Scenario duplicates (keep Export + How to Use) | M |
| P2.2 | **Badge diet**: keep ≤ 4 semantic chips (count-badges for real workload, `LIVE`, scope, granted) — retire permanent marketing chips (`NEW`, `ASK`, `SETUP`, `HQ`…) | S |
| P2.3 | **Reports hub**: one “Reports” destination (FinancialReportSection + budgets/cash-flow + per-module report tabs deep-linked from modules); Sales “Analytics” and Audit “Reports & Charts” fold in or link in | M |
| P2.4 | **AI rationalization**: BI Assistant = the single Q&A/feed entry (it already grounds across modules); AI Strategic Advisor = recommendations only; per-module “AI Knowledge” tabs move into the guide system; group renamed “Decision Support” | M |
| P2.5 | **Customers/Inventory dedupe in Sales view**: replace embedded Manage Customers / View Full Inventory with links to CRM / Inventory modules | S |
| P2.6 | **Mobile navigation**: default to drawer or bottom-tab on phones (keep the pinned rail as an option); auto-collapse to icon rail | M |
| P2.7 | Finance view: collapse the 9+3 chip rows into one date-range picker + one granularity select (advanced ranges behind “Custom”) | S |

### P3 — Polish & deeper redesign (later)

- P3.1 Unify the customer concept: CRM registry + 360° profile as the single home; every other surface links to it (removes F8 permanently).
- P3.2 Split the admin tracking view: storefront management (links, HELP editor) vs order operations vs procurement setup.
- P3.3 Empty-state & stub-view pass (e.g. Livestock renders a 1.7k-px shell), keyboard navigation, focus trapping in the new shared Modal.
- P3.4 Progressive disclosure in Enterprise Users (124 buttons) and Transactions views (search/filter-first).
- P3.5 Long term: retire `SharedEnterpriseModule` (3,823 lines) in favor of the module shell + primitives from P1.3/P1.4.

### Suggested sequencing

1. **Week 1:** P0.1–P0.3 (defects + hygiene) — visible trust win, no design risk.
2. **Weeks 2–4:** P1.3 primitives → P1.1 entry forms → P1.2 feed mill (each lands independently, each shrinks the codebase).
3. **Weeks 5–6:** P1.4 module shell + P1.5 command-center splits (user-visible restructure).
4. **Week 7+:** P2 IA/AI/reports, then P3.

---

## 6. Appendix

- **Screenshots:** `reports/screenshots/uiux-audit/` (00-login … 46-gm-landing; desktop, mobile, per-role, public pages).
- **Evidence queries:** orphaned checklist rows (`select count(*) … where not exists (select 1 from businesses …)` → 185); feed-mill diff (282 changed lines after term normalization); modal count (53 files matching `fixed inset-0`); entry-form greps (§4.2).
- **Component inventory:** 93 components, 62,716 LOC total; largest: SharedEnterpriseModule 3,823 · BranchManagerSalesView 2,778 · ManageBusinessesModal 2,347 · PoultryFarmModule 1,892 · GoMinaApp 1,761.
- **Sidebar IA dump and per-view metrics:** captured in this report’s working notes (session log); screenshots mirror each state.
