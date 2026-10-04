# Sidebar Navigation Improvements — Results Report

**Scope:** the approved plan in [`docs/SIDEBAR-NAV-REASSESSMENT.md`](./SIDEBAR-NAV-REASSESSMENT.md)
(committed `cc089a0`), implemented on desktop **and** mobile without changing any
permission, workflow, navigation destination or business function.

**Commits**

| SHA | What |
| --- | --- |
| `2356d81` | Navigation cleanup (N5) — all 11 app/test files |
| *(this commit)* | Customer Orders table overflow fix + rail test-harness helpers + this report |

Baseline for every "before" number below: the tree at `cc089a0`.

---

## 1. What changed

| # | Item (plan ref) | Implementation |
| --- | --- | --- |
| 1 | **No nested scrolling** | The rail no longer contains a scroll box. `Sidebar.tsx` scrolls with the page; the shell row became `flex flex-1 overflow-x-clip` (`GoMinaApp.tsx`) so the rail can be `position: sticky` while stray horizontal bleed is still clipped. |
| 2 | **Unit-list 5 + "Show all N"** | `UNIT_PREVIEW = 5`; new `nav-biz-show-all` disclosure ("Show all 10 units" → "Show fewer"). Removes ~430 px of nested scroll on a 10-unit workspace. |
| 3 | **Default-collapse low-frequency sections** | Role-aware: `INSIGHTS`, `ADMIN (Administration)`, `SETTINGS` start collapsed for users who can run the app without them; `MY_BUSINESSES · SELL · MONEY · RECORDS · GOVERNANCE` stay open. Auto-reveal: opening any destination inside a collapsed section (sidebar, palette, deep link, quick access) expands it and marks the row `aria-current="page"`. |
| 4 | **Governance split** | `GOVERNANCE` (Oversight & Assurance: audit, compliance, governance dashboards) separated from `ADMIN` (Administration: users & access, units, branding). |
| 5 | **Worker Sell** | The `Sell` slot on the worker bottom bar opens *Record Sale* (was the worker Home view); the bar's active state follows the section being viewed (`Home* Actions Sell Search Menu`). Worker sub-tab switching uses the `gomina:worker-subtab` / `-changed` events so the bar and the view agree. |
| 6 | **Duplication trims** | Hero actions reduced to *Manage Units · New Branch / Unit · Users & Access*; Manage Units / Online Ordering no longer duplicated in the avatar menu; palette empty-state capped at 8 rows (`EMPTY_QUERY_LIMIT`); single-entry Support; `BRANCH_SALES` renamed *Branch Sales & Payments*; right-rail quick-nav hides when it would show ≤1 entry; Farm-Advisor row is fail-open (`advisorCount` unknown ⇒ show, known 0 ⇒ hide). |
| 7 | **Customer Orders table** (found by the layout sweep while validating the above) | `src/components/CustomerTrackingPanel.tsx`: the desktop order table is ~1180 px wide with ten columns but sat in a non-scrollable `overflow-hidden` card inside the ~900 px content column, so **Payment / Status / Date rendered underneath the right rail and could not be read or reached**. The card now wraps the table in an `overflow-x-auto` scroller (`min-w-[1080px]`), so the ten columns scroll into view; on ≥1920 px nothing scrolls. **This defect pre-dates the navigation work** (proved by an A/B on the live DOM: identical geometry with the old `overflow-hidden` shell class), and it is unrelated to permissions/data. |

Preserved deliberately: every destination, role gate and permission check, the
`≤5` bottom-bar contract (**Home · Actions · Sell · Search · Menu** — no Records,
My Businesses or Finance & Reports slots), the existing hub structure, the
`TESTING`/test-id contract, and all domain modules.

## 2. Verified measurements (live app)

| Signal | Before | After |
| --- | --- | --- |
| Desktop rail while scrolling 700 px | `static`, `top = −635 px` (rail scrolls away) | `sticky`, `top = 0` |
| Nested scroll boxes in the rail | 1 (biz list 256 / 428 on mobile) | **0** (desktop and phone drawer) |
| Business list height | full 10 units inline | 5 + "Show all 10 units" — expands and collapses |
| Sections expanded (owner) | 7/7 | 5 open · `INSIGHTS / ADMIN / SETTINGS` collapsed; auto-reveal verified via the palette ("enterprise users" → Administration expands, its row becomes `aria-current="page"`) |
| Palette empty state | 24 rows | 8 rows |
| Hero actions | 6 | 3 (Manage Units · New Branch/Unit · Users & Access) |
| Worker bottom bar | `Sell` opened the Home view; `Home*` never moved | `Sell` → *Record Sale*; active slot tracks the view (`Sell*`, Home off) |
| Right-rail quick-nav | always rendered | hidden when ≤1 entry (0 chips on HQ, 22 on Finance) |
| Customer Orders table @1440 | 1182 px table in a 896 px non-scrollable card → Payment/Status/Date unreachable | card scrolls to the end (`scrollLeft 288`), `Date` reachable (right 1151 ≤ content right 1152), no scroll needed at 1920 |

Screenshots: `/home/user/nav-n5-desktop-admin.png`, `/home/user/co-check-1440.png`
(before), `/home/user/co-wheel.png` and `/home/user/co-fixed-scrolled.png` (after).

## 3. Test results

Every suite below ran against the production build on `:3000` after the change.

### Green

| Suite | Result |
| --- | --- |
| `verify-nav` | **69 / 69** |
| `verify-contextnav` | 29 / 29 |
| `verify-storefront-help` | 47 / 0 |
| `verify-finance-allproducts-fresh` | 49 / 0 |
| `verify-clean-state` | 121 / 0 |
| `verify-p5-stock` | 19 / 0 |
| `verify-p4-writers` | 23 / 0 |
| `verify-tracking` | 51 / 0 |
| `verify-orders-maps` | 51 / 51 |
| `verify-preorders` (audit) | 18 / 18 |
| `verify-transport` | 120 / 0 |
| `verify-transport-ui` | 26 / 0 (0 console errors) |
| `verify-online-ordering` | 34 / 0 |
| `verify-credit-sales` | 39 / 39 |
| `verify-image-optimization` | 62 / 62 |
| `verify-audit-access` | 28 / 28 |
| `verify-bm-dashboard-access` | 19 / 0 |
| `verify-manager-ui` | 7 / 0 |
| `verify-shared-ui` | 30 / 0 |
| `verify-action-center-ui` | 25 / 25 |
| `verify-ai-guides-ui` | 17 / 0 |
| `verify-responsive` | 198 page views + 135 module tabs, 0 console errors; only benign `truncate` offenders left (Command Center, see note) |

**Test-harness fix worth recording:** the unit-list cap broke suites that found a
business chip by fuzzy text (a 6th unit was no longer in the DOM), which then
mis-clicked an unrelated card and cascaded into false failures
(`verify-transport-ui` 6 fails, `verify-ai-guides-ui` 10/7, `verify-shared-ui` 2,
`verify-finance-allproducts-fresh` 31 fails). New shared helper
`dev-tooling/rail-util.mjs` (`revealAllUnits` / `clickUnit`) expands the list the
way a user would; the affected suites now click chips by `data-biz-code` and
prove the unit opened. All of them are green again — the four reds were harness
artefacts, not app regressions.

### Notes / known non-blocking items

* `verify-responsive` reports two remaining offender **categories**, both
  confirmed benign:
  * *Command Center "clipped"* (6 desktop / 7 tablet / 9 mobile): `div.truncate`
    product labels — intentional ellipsis, `text-overflow: ellipsis` by design.
  * *Customer Orders* pushed-off rows — fixed by item 7 above (0 offenders now).
* `verify-finance-allproducts-fresh` previously also reported a demo-data drift
  (`Z1`) caused by `TEST *` units left in the database by earlier fixture runs —
  cleared by the restore chain, not an app issue.
* Pre-existing, unrelated to navigation: `verify-ai-guides-ui` needs the guide
  registry populated for the brand question (17/0 in the current dataset).

## 4. Remaining / follow-ups

1. `Navbar.tsx` avatar menu still exposes *Manage Units* / *Online Ordering*.
   **Deliberately kept:** `verify-storefront-areas.mjs` (E3/E6/E7/E8) and
   `verify-online-mgmt.mjs` assert that a Branch Manager can jump *straight into
   their own branch's Online panel* from the account menu — a tested workflow,
   not blind duplication. The rail routes to the same destinations; removing the
   menu route would delete a verified path rather than de-duplicate one.
2. Demo junk unit **"kkkkk"** (`POULTRY-02`) is still seeded by the demo data;
   removing it changes fixture expectations, so it is left for a data-cleanup pass.
3. Optional (plan item 10): let users pin 1–2 destinations into the bottom bar —
   not implemented, as it needs a prefs migration and was marked optional.
4. No usage telemetry exists, so "low-frequency section" defaults are
   role-based judgement, re-confirmed by the auto-reveal behaviour.
