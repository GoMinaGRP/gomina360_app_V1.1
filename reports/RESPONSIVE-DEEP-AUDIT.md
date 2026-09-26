# GoMina 360 — Deep mobile & tablet responsiveness audit

**Date:** 2026-09-26 · **Suites:** `dev-tooling/verify-responsive-deep.mjs`,
`dev-tooling/verify-responsive-modals.mjs` (both green against the production
build), plus the full regression battery below.

## What was audited

Two new suites drive the real app in headless Chromium and go far beyond the
existing page-level `verify-responsive.mjs` (29 checks, still green):

### 1. Surface × tab sweep — `verify-responsive-deep.mjs`

For **every navigation surface** the signed-in role can reach (27 for the
OWNER — all 8 business modules + Command Center, Sales, Finance, Customers,
Order & Tracking, Pre-Orders, Suppliers, Employees, Assets, Inventory,
Transactions, Audit & Review, Support, AI Advisor, Scenario Planning, Farm
Advisors, Integrations, Enterprise Users, Platform — and the worker's Sales
Workspace) and **every in-page tab inside it** (module tab bars are detected
and clicked through automatically, two levels deep), at **phone 375px** and
**tablet 768px**:

* no horizontal document overflow;
* **every interactive element** (button, link, input, select, textarea) sits
  fully inside the viewport — elements inside a legitimate horizontal scroll
  container (`overflow-x: auto` tables) are correctly exempted;
* zero page errors.

**Result: 242 views (56 surfaces + 186 tab views) — ZERO issues**, owner and
worker, phone and tablet, production build. The detector itself was validated
by injecting a synthetic out-of-viewport button (caught) and enumerating the
exempted scrollers (only 7, all intentional table wrappers).

### 2. Modal & drawer sweep — `verify-responsive-modals.mjs`

On every surface, every "opener" control (`cw-open-wash`, `hw-new-delivery`,
`fm-btn-new-formula`, `emp-payroll-open`, `ctx-open-btn`, `aud-open-*`,
`scen-new`, …) is clicked and the modal group (backdrop + panel/drawer) that
appears is audited at 375px / 768px:

* the panel fits the viewport; no clipped controls inside; no document
  overflow while open;
* the modal actually **closes** again (Escape → close/cancel/X button →
  backdrop click).

**Result: 126 modals opened & audited (130 openers tried) — ZERO issues.**

## Fixes made during the audit

The audit surfaces themselves needed no layout fixes — the static-sidebar +
card-below-`lg` architecture already holds at element level everywhere. Two
small gaps were closed to make full coverage possible:

1. **Missing tab testids** — the Worker workspace, Restaurant, Electronics
   Shop and generic business-dashboard tab buttons had no `data-testid`s
   (every other module already used `<prefix>-tab-<key>`). Added
   `wk-tab-*`, `rst-tab-*`, `elex-tab-*`, `bdm-tab-*`
   (`WorkerDashboard.tsx`, `RestaurantKitchenModule.tsx`,
   `ElectronicsShopModule.tsx`, `BusinessDashboardModule.tsx`). Purely
   additive; no behavior change.
2. **Suite tooling** — the two new suites above, registered in
   `dev-tooling/README.md`, with `VIEWPORTS` / `ROLES` env selectors.

## Regression battery (all green, production build)

| Suite | Result |
|---|---|
| verify-audit-history (new) | 21/21 |
| verify-audit-records | 29/29 |
| verify-audit-responsive | 38/38 |
| verify-audit-access | 28/28 |
| verify-audit-fixes | 51/51 |
| verify-responsive (incl. 1280/1500 desktop) | 29/29 |
| verify-product-share | 34/34 |
| verify-online-ordering | 34/34 |
| verify-order-page-regression | 34/34 |
| verify-storefront-areas | 53/53 |
| verify-storefront-help | 47/47 |
| verify-order-logo-login | 23/23 |
| verify-clean-state | 109/109 |
| verify-demo-page | 25/25 |
| verify-responsive-deep (new) | 242 views, 0 issues |
| verify-responsive-modals (new) | 126 modals, 0 issues |
