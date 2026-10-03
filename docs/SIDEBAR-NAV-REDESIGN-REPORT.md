# Left Sidebar & Navigation Redesign — Implementation Report (N1–N4)

**Scope:** the whole left-hand navigation — sidebar, right-hand context rail, mobile navigation,
search/command palette, and the Orders & Fulfilment hub.
**Plan of record:** `docs/SIDEBAR-NAV-AUDIT.md` (report-only audit, commit `549883d`, approved by the
operator with the four parked decisions delegated to professional judgment).
**Result:** all four phases (N1–N4) shipped. Every destination, permission gate, test-id and business
workflow that existed before still exists; nothing was removed.

| | |
|---|---|
| Main implementation commit | **`8cf0e53`** (N1–N4 + dev-tooling + chip-text restore) |
| Follow-up fix | **`b1ee089`** (Transport phone overflow) |
| Follow-up fix | **`2b2b3ee`** (`verify-clean-state` checklist-scaffold assertion) |
| Branch | `arena/01a0fecd-gomina360-app-v1-1` (pushed) |
| New module | `src/lib/navManifest.ts` — 716 lines, 28 destinations, 8 groups |
| Nav suites | `verify-nav` (63 checks), `verify-contextnav` (29), `verify-responsive` (5 viewports) |

---

## 0. The root problem this fixes

Before N1, navigation eligibility, label, group, icon and order were **re-derived inline in two
components** (`Sidebar.tsx` and `ContextNavigator.tsx`). The audit found the copies had already drifted
(`docs/SIDEBAR-NAV-AUDIT.md` §2.1):

| # | Symptom (audit) | Status after N1–N4 |
|---|---|---|
| D1 | "Customer Order & Tracking" rendered **twice** for a branch manager who is also a Manage-grantee — two DOM nodes with the **same** `data-testid="sidebar-tab-tracking"` | fixed — one manifest entry, one row |
| D2 | "Finance & Reports" rendered **twice** for a non-executive unit manager with `canViewFinance` | fixed — one row |
| D3 | Right rail missing **7 destinations** (`ACTION_CENTER`, `ADVISOR`, `TRACKING`, `PREORDERS`, `DOCUMENTS`, `BI_ASSISTANT`, `PLATFORM_ADMIN`) → raw tab keys in breadcrumbs | fixed — rail derives from the manifest |
| D4 | Rail's "shared modules" quick list had **8** entries, sidebar had **12** under the same heading | fixed — one definition |
| D5 | Same destination named 4 different ways across surfaces ("Order & Tracking" / "Customer Order & Tracking" / "Sales & Payments" / "Branch Sales & Payments") | fixed — one `label` per entry |

Root cause: **there was no navigation manifest.** It now exists.

```ts
// src/lib/navManifest.ts — the single source of truth
export const NAV_GROUPS: NavGroup[] = [
  { key: "PINNED",         label: "",                       rail: "Workspace" },
  { key: "MY_BUSINESSES",  label: "My Businesses",          rail: "Ghana Businesses" },
  { key: "SELL",           label: "Sell & Fulfil",          rail: "Shared Enterprise Modules", hint: "Sales, orders, pre-orders, customers", cap: 6 },
  { key: "MONEY",          label: "Money",                  rail: "Shared Enterprise Modules", hint: "Finance, reports, ledger",             cap: 6 },
  { key: "RECORDS",        label: "Records",                rail: "Shared Enterprise Modules", hint: "Inventory, suppliers, people, assets", cap: 6 },
  { key: "BRANCH",         label: "Branch Management",      rail: "Branch Workspace",          cap: 6 },
  { key: "INSIGHTS",       label: "Insights & Decisions",   rail: "Decision Support & Hub",    cap: 6 },
  { key: "GOVERNANCE",     label: "Governance & Compliance", rail: "Oversight & Assurance",    cap: 6 },
  { key: "SETTINGS",       label: "Settings & Storefront",  rail: "Settings & Storefront",     cap: 6 },
];
```

Adding a destination is now **one entry**; no other file needs to know about it, and a destination
physically cannot render twice or be named differently in two surfaces.

---

## 1. The four delegated decisions — how they were resolved

| # | Decision (audit §7) | Resolution | Why |
|---|---|---|---|
| 1 | Transactions & MoMo: own item or folded into Finance? | **Own item** under **Money** | Preserves the module's own permission scope (`canViewFinance` is not the same grant as MoMo); folding it would silently widen access — a permissions regression is not worth one saved row. |
| 2 | Merge Pre-Orders + Customer Order & Tracking? | **Yes — one "Orders & Fulfilment" hub** (`OrdersFulfilmentHub.tsx`), both destinations one click deeper as tabs (`ofs-hub`, `ofs-tab-*`) | Two rows were describing one business process (order → pre-order → fulfilment → tracking). Also closes RA-11 from `docs/RE-AUDIT-DASHBOARDS-SHARED-MODULES.md`. Both original test-ids still work. |
| 3 | Recents storage: browser or database? | **Per-browser `localStorage`** (`gomina.nav.prefs.v1`, event `gomina:nav-prefs`) | No schema change, no new write path, no tenant-isolation surface. Cross-device recents are a nice-to-have; a new table for it would violate "one writer per data family" discipline for zero functional gain. |
| 4 | Phone layout: drawer + bottom bar, or icon rail? | **Drawer + 5-slot bottom bar** (`nav-bottom-bar`: Home · Actions · Console · Sell · Search · Menu) | A hover/flyout rail is unusable on touch. The bottom bar puts the five highest-frequency destinations within thumb reach; everything else stays in the drawer. |

---

## 2. What shipped, phase by phase

### N1 — Foundation (invisible, lowest risk)
* `src/lib/navManifest.ts` — destinations, groups, eligibility (`navEntriesFor`, `navSectionsFor`,
  `pinnedFor`, `entryById`, `pageInfoFor`, `railSectionOf`, `sectionSiblingsFor`, `businessIcon`,
  `canOpenBusiness`, `navCtx`, `scoreEntry`).
* D1/D2 duplicate rows eliminated; D3/D4 rail drift eliminated; D5 naming unified.
* Every row now carries `title` / `aria-label` / `aria-current` / `aria-expanded`; footer trimmed.
* **No visual change was intended in N1** — and the 22 sidebar-touching suites were the guard.

### N2 — Collapsible sections + bounded business list
* Section headers with **saved state**, **auto-reveal on navigation**, and counts
  (`nav-section-<KEY>`, `nav-body-<KEY>`).
* Business list is bounded (`nav-biz-list`): cap 5 + **Show all** + filter (`sidebar-biz-filter`) with
  11 demo units, so the sidebar no longer grows without limit as units are added.
* Quick-access strip (`nav-quick-access`, `nav-quick-<id>`) and favourites/recents from `navPrefs.ts`.
* Trap found and handled: default-collapsing a section must never hide a destination the user is
  currently on — real clicks on `sidebar-tab-tracking|sales|preorders`, `sidebar-support-info`,
  `sidebar-advisor-manage` and `audit-tab` all auto-reveal their section (verified by `verify-nav`).

### N3 — Command palette (the main de-crowder)
* `src/components/nav/CommandPalette.tsx` — ⌘K / Ctrl-K, `/` trigger, sidebar search row
  (`sidebar-search-trigger`), fuzzy match + **synonyms** + recents/favourites.
* Verified queries: `momo` → TRANSACTIONS, `payroll` → EMPLOYEES, `stock` → INVENTORY,
  `pre order` → PREORDERS, `akuafo` → `cmd-item-BIZ:*` (business search reuses `scoreEntry`).
* Full keyboard/a11y: listbox semantics, `cmd-empty` empty state, Esc to close, focus return.
* On phones the palette is full-screen (`cmd-palette`), which is what makes the drawer viable.

### N4 — Responsive drawer, bottom bar, icon rail
* Navbar hamburger (`nav-mobile-menu-btn`) → off-canvas drawer (`nav-sidebar` + `nav-sidebar-backdrop`)
  with focus trap, Esc, scroll lock, and a dedicated `sidebar-drawer-close`.
* Phones get the 5-slot bottom bar (`nav-bottom-bar`, `nb-home|nb-actions|nb-console|nb-sell|nb-search|nb-menu`).
* Tablet gets a 56 px icon rail; desktop keeps the full sidebar with a collapse toggle
  (`sidebar-collapse-toggle`) whose state persists across reloads.
* At `≥xl` both the rail and the drawer stay mounted — this is deliberate (CSS-hidden, not unmounted) so
  that any surface can query a test-id at any viewport. Documented so nobody "fixes" it later.

---

## 3. The navigation contract (what other code may rely on)

All pre-existing test-ids are **preserved**: `sidebar-tab-*`, `sidebar-biz-<CODE>` /
`sidebar-biz-logo-<CODE>`, `sidebar-chip-granted|manage|advisor-*`, `sidebar-manage-businesses`,
`sidebar-manage-units`, `org-lens-select`, `sidebar-org-group-*`, `audit-tab`, `ctx-*`,
`nav-mobile-menu-btn`, `data-biz-code`, plus `aria-label` / `aria-current` / `aria-expanded`.

New: `nav-sidebar`, `nav-sidebar-backdrop`, `sidebar-collapse-toggle`, `sidebar-drawer-close`,
`sidebar-search-trigger`, `nav-section-*`, `nav-body-*`, `nav-quick-access`, `nav-quick-*`,
`nav-hub-*`, `nav-biz-list`, `sidebar-biz-filter`, `nav-bottom-bar`, `nb-*`, `ofs-hub`, `ofs-tab-*`,
`cmd-palette`, `cmd-palette-input`, `cmd-palette-list`, `cmd-item-<id>`, `cmd-fav-<id>`,
`cmd-palette-close`, `cmd-empty`.

**One DOM contract that must never be "cleaned up": the business-chip label text.** Removing it broke
`verify-transport-ui` (its tab-opener falls back to matching chip text → 0 tabs → `TypeError:
Illegal invocation`) and `verify-finance-allproducts-fresh` (38/23). The chip text is part of the
contract; it was restored and both suites went back to 26/0 and 49/0.

---

## 4. Issues found during implementation, and how each was fixed

| Issue | Root cause | Fix |
|---|---|---|
| Transport module overflowed a 390 px phone (`scrollW 390` vs card `right 464`) | grid children default to `min-width:auto` | `TransportModule.tsx`: `rowCls` gained `min-w-0`, active-trip row got `min-w-0` + `truncate` + `title`, Complete button `shrink-0` → **`b1ee089`** |
| `verify-transport-ui` "0 tabs found" | chip label text stripped during the redesign (DOM contract) | restore `navManifest.chip` + `Sidebar.chipFor` |
| `verify-bm-dashboard-access` 15/4 | suite queried the old chip DOM instead of `[data-testid="nav-sidebar"] [data-biz-code]` | suite updated to the documented contract → 19/0 |
| `verify-audit-responsive` crash | missing fixture `/home/user/pgtooling/test-photo.png` | fixture recreated (79-byte 4×4 PNG) → 38/38 |
| `preorders-audit` 17/18 | leftover `fulfillment_options` row from an earlier run | in-suite DATABASE_URL-gated preamble delete (same pattern as the pre-orders suite) → 18/18 |
| `verify-clean-state` 100/9 "74 business tables empty" | **not app dirt**: a concurrent `/api/init` (owner dashboard load → `ensureTodayFor`) legitimately mints *today's zero-state* checklist rows for a business created milliseconds earlier | suite fix **`2b2b3ee`**: `checklist_entries` joins the scaffold set and gains a positive assertion — every row must be today-dated, unticked, unassigned, unannotated and generated from that unit's own template. Reverting the suite file and re-running under the same concurrency reproduced **106/3**; the fixed suite gives **121/0** |

The `verify-clean-state` fix is deliberately **not** a loosening: run against a unit with real usage the
new counters come back `off_date=22 touched=22`, i.e. the assertion fails loudly on real data. It only
tolerates genuine zero-state scaffold.

---

## 5. Test results (final build)

Everything below was run against the frozen build at `2b2b3ee` (app served by
`next start -H 0.0.0.0 -p 3000`, Postgres local), suites executed **sequentially** to avoid the
cross-suite interference documented in §4.

<!-- SWEEP-TABLE -->

---

## 6. Value / complexity of what was shipped

| Change | Value | Complexity | Note |
|---|---|---|---|
| Navigation manifest (`navManifest.ts`) | **Very high** | Medium | Removes the entire class of duplicate/drift bugs (D1–D5) permanently |
| Command palette (⌘K) | **Very high** | Medium | The single biggest de-crowder; keeps 28 destinations reachable without a long sidebar |
| Collapsible sections + auto-reveal | High | Medium | Sidebar height no longer scales with the feature count |
| Bounded business list (cap + filter) | High | Low | Required for accounts with many units (11 demo units already) |
| Orders & Fulfilment hub | High | Low | Two rows → one hub, 0 destinations lost; closes RA-11 |
| Mobile drawer + bottom bar | High | Medium | Phone navigation was previously a scroll hunt |
| Manifest-driven right rail | Medium | Low | Fixed 7 missing destinations and 4-way naming drift |
| Icon rail (tablet) / collapse persistence | Medium | Low | Pure ergonomics |

---

## 7. Screenshots (captured during verification)

`nav-desktop.png`, `nav-desktop-final.png` (owner, desktop) · `nav-bm-desktop.png` (branch manager) ·
`nav-worker.png` (worker — gated items hidden, "MY TASKS" chip) · `nav-phone.png`,
`nav-phone-drawer.png`, `nav-transport-phone.png` (390 px: bottom bar, drawer, fixed overflow) ·
`nav-preorders.png`, `nav-po-edit.png`, `nav-preorders-proc.png` (Orders & Fulfilment hub) — all in
`/home/user`.

---

## 8. Remaining issues / not verified

* **Demo data.** All UI checks ran against the seeded demo tenant (11 units, including HARDWARE-01).
  Permission gating was verified for owner / branch-manager / worker / advisor roles; other role
  combinations are covered by `verify-audit-access` and `verify-bm-dashboard-access` but not every
  cell of the role × destination matrix is asserted.
* **`verify-audit-responsive` needs `/home/user/pgtooling/test-photo.png`** (outside the repo). If it is
  missing the suite times out on the photo preview; recreate the 79-byte PNG.
* **`nav-transport-phone.png`** documents a fixed overflow — keep it as the regression reference.
* **One non-reproducible observation:** a single `verify-p5-stock` run reported `16/3`
  ("purchase logged exactly ONE movement — rows=2"). It has not recurred in 21 subsequent runs
  (including runs under a deliberate concurrent `/api/init` load). The suite's `call()` has no retry,
  and each run mints a fresh SKU, so no in-suite mechanism explains it; treated as transient state, not
  a code defect. If it ever reappears, capture the movement rows for the fresh item id before cleanup.
* **Not started (unchanged):** the residual raw `insert(transactions)` writers listed for P6
  (`branch-unit/route.ts:131`, `credit-sales/route.ts:224`, `payroll/route.ts:466`,
  `transactions/route.ts:144`) and RA-04/05 (Transport CHECKLIST vs `DailyChecklistPanel`), RA-08,
  RA-09…13, RA-15…20. RA-06 stays withdrawn.

## 9. Next

P6 (transaction-writer unification) resumes now that navigation is closed, under the standing rules:
one writer per data family, preserve domain cores, test each phase, fix what breaks, commit + push with
a per-phase report.
