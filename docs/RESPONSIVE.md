# GoMina 360 — Responsive / overflow hardening

_Last verified: 2026-10-02 · branch `arena/01a0fecd-gomina360-app-v1-1`_

Every page of GoMina 360 must fit the device it is opened on — desktop (1440+),
tablet (820) and phone (390, and down to 320). Wide data was always meant to
scroll **inside** its own card (tables, charts), never to push the page or clip
a value silently.

## 1. Global safety net — `src/app/globals.css`

A small "fit layer" sits under the per-module responsive classes. It fixes
whole classes of overflow at once instead of per page:

| Rule | Why |
| --- | --- |
| `main, main > div, .gm-fit { min-width: 0 }` | Flex children default to `min-width:auto`; without this a wide table/chart forces the whole column wider than the screen. |
| `main img/svg/canvas/video { max-width: 100% }` + `.recharts-responsive-container { min-width: 0 !important; max-width: 100% }` | Charts are measured by recharts from their parent; images (logos, QR labels, photos) never spill. |
| `@media (max-width:1279px) main .flex:has(> button + button)` → `flex-wrap: wrap` | Action/toolbar rows (headers, card toolbars, filter bars) with two or more controls wrap instead of leaving their trailing buttons off-screen. Deliberately narrow (`button + button`, `a + a`, mixed) so icon+label pairs keep their layout. |
| `main select, main input, main textarea { max-width:100%; min-width:0 }` + `label:has(> select)`, `.flex:has(> select)` shrink rules | A native `<select>` sizes itself to its **longest option** (e.g. "All Businesses (Consolidated) — Mina Akuafo Poultry Farm — POULTRY-02") and was dragging filter rows past the edge. |
| `main [data-testid$="-tabs"], [data-testid$="-tabbar"], [data-tabbar="1"] { flex-wrap: wrap !important }` | Switch-style tab bars fold onto several lines on phones/tablets instead of clipping the last tab. |
| `.gm-scroll-x` (utility) / `.gm-wrap-anywhere` (utility) | Opt-in horizontal scroller and long-token wrapping for components that need them. |
| `@media (max-width:640px) main { font-size: 13px }` | Slightly denser text on phones. |

## 2. Component fixes

| Area | Change |
| --- | --- |
| `Sidebar.tsx` | On phones/tablets (< 1024 px) the nav starts **collapsed to the icon rail** (48–56 px instead of 160 px, i.e. a third of a 390 px screen) until the user makes an explicit choice, which is then remembered. Chips now carry `data-biz-code` / `data-testid="sidebar-biz-…"` for tooling. |
| `SharedEnterpriseModule.tsx` (Inventory, Sales, Assets, Customers, Suppliers, Employees) | Header banner stacks at `lg`, icon/title shrink, title wraps; the action toolbar (`Scan QR`, `How to Use`, `Manage Access`, `Filters/Excel/PDF/CSV`, `Log New Transaction`, `Add …`, `Payroll Center`, `Register Asset`) wraps instead of pushing buttons off-screen; the search & filter bar wraps and the search box keeps a 160 px minimum; Assets branch summary cards wrap the business name instead of truncating it. |
| `FinancialReportSection.tsx` (Command Center + Finance & Reports KPIs) | KPI grid is 1 column below 360 px, 2 up to `sm`, then 3/4; tile padding and value size step down on phones; the sub-line (e.g. "16 item(s) • 0 low/out • retail GH₵ 521.88k") now wraps to 2 lines with a `title` tooltip instead of being cut off. |
| `CommandCenterDashboard.tsx` | Header stacks at `lg`, badge row wraps, title wraps on phones. |
| `PoultryFarmModule.tsx` | "Flock Composition" pie labels are drawn outside the pie and cannot wrap; they are now only rendered when the card is ≥ 520 px wide, with a legend as the phone fallback (recharts `Legend`). |
| `GoMinaApp.tsx` | Super-admin organisation banner wraps; the "YOUR BUSINESS · GoMina Group" line wraps instead of clipping. |
| `BoutiqueModule.tsx` | Low-stock variant rows wrap (`Ankara Print Dress (Ladies) · Size XL · Red`) instead of truncating the size/colour. |
| `PreordersHubView.tsx` (Customer Orders) | Tab bar (`Setup / Procurement / Guide`) wraps on phones instead of scrolling the last tab out of view. |
| `PreorderSetupView.tsx` | Long product names in pre-order offers wrap (they were `truncate`d inside a nested flex). |

## 3. Audit harness — `dev-tooling/verify-responsive.mjs`

```
# full sweep: shared pages + every business unit + module tabs
bash dev-tooling/run-suite.sh dev-tooling/verify-responsive.mjs

# one viewport / a subset of pages
VIEWPORTS=mobile  bash dev-tooling/run-suite.sh dev-tooling/verify-responsive.mjs
PAGES=inventory,orders  bash dev-tooling/run-suite.sh dev-tooling/verify-responsive.mjs

# also open every "New / Add / Open / Register / Log" form dialog and check it
MODALS=1 bash dev-tooling/run-suite.sh dev-tooling/verify-responsive.mjs
```

What it checks for every page, tab and (with `MODALS=1`) dialog:

1. **pushed-off** — a visible element whose right edge exceeds the content
   column without a `overflow-x: auto|scroll` ancestor (content unreachable).
   Fixed overlays are measured against the window, not the column.
2. **clipped** — an `overflow: hidden/clip` box whose `scrollWidth` exceeds its
   `clientWidth` (content silently cut off).
3. **pageOverflows** — `document.scrollWidth > clientWidth` (the page itself
   scrolls sideways — must never happen).
4. **wideTablesWithoutScroller** — positive assertion: every `<table>` wider
   than its box sits inside a horizontal scroller.

It writes `dev-tooling/.verify-out/responsive-report.json` (results + coverage +
page errors) and screenshots `resp-<viewport>-<page>.png` /
`resp-<viewport>-modal-<testid>.png`.

## 4. Results (2026-10-02)

| Viewport | Page views | Module tabs clicked | Offenders |
| --- | --- | --- | --- |
| desktop 1440 | 20 | (all tabs, 0 flagged) | **0** |
| tablet 820 | 20 | (all tabs, 0 flagged) | **0** |
| mobile 390 | 20 + 72 modal checks | (all tabs, 0 flagged) | **0** |
| narrow 320 | 20 + 68 modal checks | (all tabs, 0 flagged) | **0** |

Final sweep (`REPORT=dev-tooling/.verify-out/responsive-final.json`): **80 page
views, 164 module tabs opened, 68 tables checked, 0 offenders, 0 page-level
horizontal scroll, 0 tables without a scroller, 0 console errors.**

Separately, the modal pass opened and measured **110 form dialogs** across
tablet + desktop (`verify-responsive-modals.mjs`) and **140 dialogs** across
mobile + narrow 320 (`MODALS=1 verify-responsive.mjs`) — all clean.

Before the fix the same harness reported 8 pages with issues on desktop/tablet
(105 clipped KPI/stat lines, toolbar buttons pushed off, clipped Assets branch
names) and 22 page views on mobile (header text cut off, all action toolbars
overflowing, "Fulfilment methods" panel, pie-chart labels).

## 5. Regression suites run after the change

* `verify-boutique.mjs` — 74/74 ✅
* `verify-boutique-ui.mjs` — 40/40 ✅
* `verify-navbar.mjs` — 48/48 ✅ (sidebar behaviour incl. mobile clock panel)
* `verify-contextnav.mjs` — 29/29 ✅
* `verify-responsive-deep.mjs`, `verify-responsive-modals.mjs`,
  `verify-audit-responsive.mjs`, `verify-inventory-ui.mjs` — see CI/suite output.

## 6. Remaining known items

* `.flex:has(> button + button)` only wraps rows whose buttons are **direct**
  children; a toolbar that nests each button in its own wrapper is not caught
  (none failing today — the harness would flag it as `pushed-off`).
* The harness ignores text truncated *inside* a fixed-width element (e.g.
  `truncate` on a 120 px label) when that is intentional; those keep a `title`
  tooltip where they matter.
* Tooltip/hover-only affordances (recharts tooltips, `title` attributes) are
  not exercised at touch widths — they have mobile equivalents (legends, tap).
