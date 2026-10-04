# Left Sidebar Navigation — Audit & Recommended Structure

**Scope:** the left navigation rail (`src/components/Sidebar.tsx`, 1 044 lines) across every role, plus the two
surfaces that must stay in sync with it — the top Navbar and the right **Navigation & Location** rail
(`ContextNavigator.tsx`). **Report only: no code changed, nothing committed.** Decision requested before
implementation.

**Method:** read-only trace of every section, guard, chip and destination in `Sidebar.tsx`; cross-checked
against the destination registry in `GoMinaApp.tsx` (`sharedModules`, `renderActiveView`), the right rail's
`PAGE_INFO`, and the 22 dev-tooling suites that drive the sidebar by test-id.

---

## 1. What exists today

### 1.1 Sections and items (as rendered)

| Section | Items | Guard | Notes |
|---|---|---|---|
| *(toggle row)* | collapse/expand | always | persists in `localStorage` |
| Advisor Console | 1 | `FARM_ADVISOR` | pinned top for advisors |
| Command Center | 1 | OWNER / GM | pinned top |
| Action Center | 1 | all except FARM_ADVISOR | chip `MY TASKS` / `ALL ACTIONS` — no count badge |
| **My Businesses** | 1 header + **N unit chips** | all except WORKER | flat; SA gets Organization Lens + per-org groups |
| Order & Tracking | 1 | BRANCH_MANAGER | duplicate destination (see §2.1) |
| **Shared Enterprise Modules** | **12** | exec, or OWNER-granted unit manager | Sales&Payments · Finance&Reports · Customers&CRM · **Customer Order & Tracking** · **Pre-Orders** · **BI Assistant** · **Document Vault** · Suppliers&Vendors · Employees&Payroll · Assets&Equipment · Inventory&Stock · Transactions&MoMo (+ Manage Units for unit managers) |
| My Sales Workspace | 1 note box | WORKER | not navigation |
| Branch Management | 3 | BRANCH_MANAGER | Sales&Payments · Branch Assets · Manage Sales Persons |
| Oversight & Assurance | 1 | OWNER / `canManageAuditors` / auditor | Audit & Review |
| *(granted finance)* | 1 | non-exec + `canViewFinance` | Finance & Reports — **duplicate test-id** (see §2.1) |
| Customer Storefront | 1 | OWNER / `canManageSupport` | Support — Storefront HELP |
| **Decision Support & Hub** | **5–6** | exec, or `canManageCctv` | AI Strategic Advisor · Scenario Planning · **Farm Advisors** · **Integrations Hub** · Enterprise Users · Platform Owners (SA) |
| Footer | status strip | always | "Command Center Active" |

### 1.2 Row counts per role (expanded, demo data = 11 units)

| Role | Static destinations | + unit chips | Total rows |
|---|---|---|---|
| OWNER / GM | **21** (+1 SA) | 11 | ~32 → needs ~1 400 px of vertical scroll |
| Super Admin | 22 | 11 (+ per-org headers) | ~35 |
| BRANCH_MANAGER | 5 | 1 | 6 |
| BRANCH_MANAGER with Manage grants | **21** (+ duplicates) | 1 | ~23 |
| WORKER | 1 | 0 | 1 |

The asymmetry is stark: OWNER/Manager-of-units gets a 30-row wall; a worker gets one item and a paragraph.

### 1.3 Existing strengths (keep, don't rebuild)

- The **icon-rail collapse** with `localStorage` persistence, auto-collapsed on <1 024 px.
- **Role-aware sections** — nothing leaks to a role that must not see it; access is re-checked server-side (`/api/init` scoping, `canAccessBusiness`).
- **Unit chips carry their identity**: logo/type icon, `GRANTED` / `MANAGE` / `MONITOR` / `INACTIVE` badges, tooltips, per-org grouping for the Super Admin.
- The **right rail** already provides breadcrumbs + "where am I" + sibling-unit jumps + drawer behaviour under `xl`.
- 22 suites assert sidebar behaviour, so the structure is at least test-covered.

---

## 2. Problems found

### 2.1 Duplicate destinations (correctness, not just tidiness)

| # | Issue | Evidence |
|---|---|---|
| D1 | **"Customer Order & Tracking" renders twice** for a branch manager who is also a Manage-grantee — the BM block (`:554`) and the shared-modules block (`:639`) both mount the same destination with the **same `data-testid="sidebar-tab-tracking"`** | `Sidebar.tsx:554`, `:639`; 13 suites query that test-id |
| D2 | **"Finance & Reports" renders twice** for a non-executive unit manager with `canViewFinance` — shared-modules block (`:611`) + granted block (`:868`), same `data-testid="sidebar-tab-finance"` | `Sidebar.tsx:611`, `:868` |
| D3 | **Right rail drift**: `ContextNavigator.PAGE_INFO` claims it "mirrors the left Sidebar grouping exactly" but is missing **7 destinations** — `ACTION_CENTER`, `ADVISOR`, `TRACKING`, `PREORDERS`, `DOCUMENTS`, `BI_ASSISTANT`, `PLATFORM_ADMIN`. Sitting on those shows a breadcrumb like `GoMina 360 › Workspace › TRACKING` (raw tab key) and Business: "—" | `ContextNavigator.tsx:48–66`, fallback `:194` |
| D4 | The right rail's "shared modules" quick-jump list has **8 entries**; the left sidebar puts **12** under the same heading — two different definitions of the same section | `ContextNavigator.tsx:275` vs `Sidebar.tsx:577–760` |
| D5 | The **same destination has two different names** in different surfaces: "Order & Tracking" (BM block) vs "Customer Order & Tracking" (exec block) vs "Sales & Payments" (shared) vs "Branch Sales & Payments" (right rail `PAGE_INFO`), "Enterprise Users" vs "Users & Access" | `Sidebar.tsx:554/:639`, `ContextNavigator.tsx:60–62` |

Root cause of D1–D5: **there is no navigation manifest.** Eligibility, label, group, icon and order are
re-derived inline in two components, so they drift. Every fix below is cheap once that exists.

### 2.2 Grouping problems

1. **"Shared Enterprise Modules" is a 12-item grab-bag** mixing four unrelated families in one list: money (Sales, Finance, Transactions), master records (Customers, Suppliers, Employees, Assets, Inventory), workflows (Orders, Pre-Orders) and tools (BI Assistant, Document Vault). It is the single biggest source of "crowding".
2. **"BI Assistant" and "Document Vault" are not enterprise records** — they are a tool and a document library; they belong with Insights and Compliance respectively.
3. **"Farm Advisors" (an ACCESS/permissions console) sits under "Decision Support & Hub"** next to an AI advisor and a scenario planner. It is administration.
4. **"Integrations Hub" (CCTV/MoMo configuration) sits in Decision Support** rather than with configuration/storefront.
5. **"Customer Storefront / Support — Storefront HELP"** is a storefront setting in its own one-item section.
6. **Pre-Orders and Customer Order & Tracking are two front doors to one object graph** (both mount `ProcurementPanel`/`PreorderSetupView` — see the P6 audit RA-11). They should be tabs of one hub, not two sidebar rows.
7. **"Transactions & MoMo"** is the ledger list — a sibling of Finance & Reports rather than part of it; today they sit in one long list with no visual relationship.
8. **Oversight & Assurance is one row in its own section** — a section per item is header overhead, not grouping.

### 2.3 Discoverability & compactness

- **No search or quick-jump anywhere in the shell.** The Navbar has currency, notifications, attendance clock, avatar; the sidebar has none. With 21+ destinations the only way to reach "Scenario Planning" is visual scanning.
- **No recents / favourites / frequency ordering.** Owners visit the same 3–4 screens daily; the rail treats all 21 identically.
- **"My Businesses" renders every unit straight into the rail** (11 today). With 25 units it is a 25-row wall with no filter, no "show more", no pinning — even though `ManageBusinessesModal` already has filters, archiving and a fuller list.
- **Sections are not collapsible** and there is no per-section count/badge; the rail is one continuous scroll.
- **Action Center carries no number** even though it is a to-do queue — a count badge is the single highest-value affordance.

### 2.4 Responsive & accessibility

- **There is no mobile drawer and no hamburger.** On phones/tablets the rail auto-collapses to a 48–56 px strip. In that state item labels are simply clipped by `overflow-x-hidden` — and **no static nav item has `title` or `aria-label`** (only 2 tooltips exist, both badges). So the collapsed rail is a column of unlabeled icons on touch, where hover tooltips don't exist anyway.
- The rail is **always pinned**; expanding it on a 390 px phone consumes 160 px (~41 % of the viewport) with no overlay/drawer alternative.
- Group headers are plain `<div>`s — no `aria-expanded`, no landmark `role="navigation"` label, no keyboard affordance for future collapse; no skip-to-content link.
- The bottom of the rail (footer) duplicates the top (status) — low-value chrome occupying prime space.

---

## 3. Recommended structure

Principle: **same destinations, fewer rows, clear families, one entry per destination, search on top of it.**
Nothing is removed; 4 items change home, 2 pairs become tabs of one hub, and every existing test-id is kept.

### 3.1 Target information architecture

```
┌───────────────────────────────────────────────┐
│ [⌘K]  Search or jump to…            ← NEW      │  palette trigger (also Ctrl/⌘-K, "/")
├───────────────────────────────────────────────┤
│ ▸ Command Center               360° HQ  (exec) │  pinned — never collapses
│ ▸ Action Center                    ③    (staff)│  pinned + live pending count
│ ▸ Advisor Console              MONITOR (adv)   │  pinned for FARM_ADVISOR
├───────────────────────────────────────────────┤
│ MY BUSINESSES (11)                    ⌄        │  collapsible, default OPEN
│   ★ Poultry Farm (POULTRY-01)              ← favourites first (max 5 visible)
│   • Block Factory (BLOCK-01)
│   • …  (up to 5 rows)                          │
│   Show all 11 ▸        ＋ New   Manage ▸      │  → expands inline / opens modal
├───────────────────────────────────────────────┤
│ SELL & FULFIL                             ⌄   │
│   Sales & Payments                             │
│   Orders & Fulfilment  (Live Orders ·          │  ← MERGED: Customer Order &
│                         Pre-Orders ·           │    Tracking + Pre-Orders +
│                         Procurement)           │    Procurement as tabs
│   Customers & CRM                              │
├───────────────────────────────────────────────┤
│ MONEY                                     ⌄   │
│   Finance & Reports                            │
│   Transactions & MoMo                          │
├───────────────────────────────────────────────┤
│ RECORDS                                   ⌄   │  collapsible, default COLLAPSED
│   Inventory & Stock                            │  (auto-opens when active)
│   Suppliers & Vendors                          │
│   Employees & Payroll                          │
│   Assets & Equipment                           │
├───────────────────────────────────────────────┤
│ INSIGHTS & DECISIONS                      ⌄   │
│   BI Assistant                                 │  ← moved from Shared Modules
│   AI Strategic Advisor                         │
│   Scenario Planning                            │
├───────────────────────────────────────────────┤
│ GOVERNANCE & COMPLIANCE                   ⌄   │  role-gated; default COLLAPSED
│   Audit & Review                               │
│   Document Vault                               │  ← moved from Shared Modules
│   Enterprise Users                             │
│   Farm Advisors                                │  ← moved from Decision Support
│   Platform Owners                     (SA)     │
├───────────────────────────────────────────────┤
│ SETTINGS & STOREFRONT                     ⌄   │  exec (+ support grantees)
│   Storefront HELP                              │
│   Online Ordering                              │  ← promoted from avatar menu
│   Integrations Hub                             │  ← moved from Decision Support
│   Manage Units              (grant holder)     │  ← moved out of Shared Modules
├───────────────────────────────────────────────┤
│ footer: collapse toggle · status · currency    │
└───────────────────────────────────────────────┘
```

**Rows visible at rest for an OWNER: ~13** (2 pinned + My Businesses header + 5 unit rows + 6 section
headers) instead of ~32; every destination is one click away (headers) and 2 clicks for collapsed groups.
Super Admin keeps the Organization Lens above "My Businesses", with per-owner groups **collapsed except the
current lens** — that alone removes the largest SA wall.

### 3.2 Section rules (consistent, predictable)

1. **Pinned** (never collapse): Command Center / Advisor Console, Action Center (with pending-count badge), search trigger.
2. **My Businesses**: default open; show **max 5** units (favourites first, then most-recent, then alphabetical); `Show all (N)` expands inline and remembers; `＋ New` and `Manage ▸` live in the header (they are unit *actions*, not modules); when N > 8 a small type-to-filter appears.
3. **Every other section is collapsible** with a chevron, an item count and a **remembered state per user** (`localStorage`, keyed by section + role). Defaults: **open** when it contains the active destination or is a "daily driver" (Sell & Fulfil, Money); **collapsed** for Records, Governance, Settings; the active section always auto-reveals on navigation (deep-links/back-button land in the right place).
4. **Cap a section at 6 items**; 7+ requires promoting a sub-group or moving items to a hub page. This is the governance rule that stops the wall from coming back.
5. Group headers are real buttons: `aria-expanded`, `aria-controls`, keyboard-operable, chevron rotates.

### 3.3 Search / quick access (the main de-crowder)

- A **single command palette** opened from the sidebar's top "Search or jump to…" row, `⌘K` / `Ctrl-K`, or `/` (when not typing in a field).
- Index: **destinations** (from the manifest), **businesses/units**, and later **records** (customers, orders, SKUs). v1 = destinations + units.
- Behaviour: fuzzy match over label + **synonyms/keywords** ("momo" → Transactions, "stock" → Inventory, "payroll" → Employees), **recents first**, then a section badge, role chips, and disabled/unavailable items hidden entirely (never a teaser the role can't open).
- Keyboard: ↑/↓, Enter, Esc; focus trapped; returns focus on close. Mobile: full-screen sheet.
- Distinct from the Navbar (business switcher ≠ navigation search) and from the right rail (location, not lookup).

### 3.4 Recents & favourites

- **Recents**: last 5 destinations per user (localStorage v1; a `user_preferences` row later if cross-device is wanted) → shown as a 3-item "Recent" strip under the pinned block *only* when it has ≥2 entries, and used to rank palette results.
- **Favourites**: star (☆) on hover in the rail and in the palette, max 5, pinned to the top of My Businesses for units and to the top of their section for destinations. Owner-only, off by default — no behaviour change until used.

### 3.5 Responsive behaviour

| Breakpoint | Left rail | Right rail |
|---|---|---|
| ≥ 1 280 px | expanded 256 px, sections per saved state; icon-rail mode still available | persistent rail (as today) |
| 1 024–1 279 px | 224 px; sections default collapsed except the active one | compact `ContextBar` + slide-in drawer (as today) |
| < 1 024 px | **off-canvas drawer** opened by a Navbar hamburger (focus-trapped, Esc, scroll-locked) **+ a bottom bar**: Home · Action Center · Sell · Menu (last opens the drawer) | compact bar + drawer (as today) |

Rationale: on a phone the current 48 px unlabeled rail costs width, hides labels and offers no hover tooltips;
a drawer + 4-slot bottom bar gives back the full viewport and puts the everyday actions under the thumb. The
icon rail stays as a *desktop* user preference, not the phone default.

### 3.6 Accessibility (fixed regardless of layout)

Every nav item gets an accessible name (`aria-label` or visible text, plus `title` for the rail), `role="navigation" aria-label="Primary"` on the aside, a visible focus ring, ≥44 px touch targets in the drawer/bottom bar, and section headers with `aria-expanded`. Re-run at 200 % zoom and with keyboard-only reach to all 21 destinations.

---

## 4. Item-by-item dispositions

| Today | Where | Disposition | Destination |
|---|---|---|---|
| Command Center, Action Center, Advisor Console | top | **Keep** (pinned) | unchanged |
| My Businesses (flat, unbounded) | own section | **Restructure** — cap 5 + Show all/filter/favourites/recents; header actions | unchanged destination; `sidebar-biz-<CODE>` test-ids preserved |
| Sales & Payments | Shared (1) | **Keep** — Sell & Fulfil | unchanged |
| Customer Order & Tracking | Shared (4) | **Merge** → "Orders & Fulfilment" tab | `TRACKING` id preserved |
| Pre-Orders | Shared (5) | **Merge** → same hub, second tab | `PREORDERS` id preserved |
| Customers & CRM | Shared (3) | **Keep** — Sell & Fulfil | unchanged |
| Finance & Reports | Shared (2) | **Keep** — Money | unchanged |
| Transactions & MoMo | Shared (12) | **Keep** — Money (decision: also fold in as a Finance tab?) | unchanged |
| Suppliers, Employees, Assets, Inventory | Shared (8,10,9,11) | **Keep** — grouped under "Records" | unchanged |
| BI Assistant | Shared (6) | **Move** → Insights & Decisions | unchanged |
| Document Vault | Shared (7) | **Move** → Governance & Compliance | unchanged |
| Farm Advisors | Decision Support | **Move** → Governance & Compliance (it is access admin) | unchanged |
| Integrations Hub | Decision Support | **Move** → Settings & Storefront | unchanged |
| Support — Storefront HELP | own section | **Move** → Settings & Storefront | `sidebar-support-info` preserved |
| Enterprise Users | Decision Support | **Move** → Governance & Compliance | unchanged |
| Platform Owners (SA) | Decision Support | **Keep** — Governance & Compliance | unchanged |
| AI Strategic Advisor, Scenario Planning | Decision Support | **Keep** — Insights & Decisions | unchanged |
| Manage Units (unit manager) | Shared modules | **Move** → My Businesses header action (`sidebar-manage-units` preserved) | unchanged |
| Online Ordering (avatar menu only) | Navbar | **Promote** → Settings & Storefront + palette (keep the avatar entry) | unchanged |
| Attendance clock, notifications, currency, profile/logout | Navbar | **Keep** (correct home) | unchanged |
| Footer status strip | bottom | **Trim** to one line (or fold into the collapse row) | — |

Nothing is deleted; the two merges keep both views as tabs, so "Pre-Orders" and "Live orders" are still one
click from the rail.

---

## 5. Foundation: one navigation manifest

Before touching layout, introduce `src/lib/navManifest.ts` — a typed list of destinations:

```ts
{ id: "TRACKING", label: "Orders & Fulfilment", short: "Orders", icon: Truck,
  group: "SELL", order: 20, chips: ["LIVE"],
  eligible: (u, ctx) => ctx.isExecutive || ctx.isBranchManager || …,
  keywords: ["orders", "tracking", "delivery", "fulfilment"],
  badge?: "openOrders" }
```

**Sidebar, right rail (`PAGE_INFO`), the palette and the tests all read it.** This kills D1–D5 structurally:
one destination can only render once per role, names can't diverge, and the right rail can't be missing a
destination. Existing test-ids are attached to the manifest entry so 22 suites keep passing.

---

## 6. Proposed implementation phases (after approval)

| Phase | Content | Risk | Verification |
|---|---|---|---|
| **N1 — Foundation (invisible)** | nav manifest; fix D1/D2 duplicates; align right rail (D3/D4); unify names (D5); `title`/`aria-label` on every item; footer trim | Low | new `verify-nav.mjs` + `verify-contextnav`, plus the 22 sidebar-touching suites (test-ids unchanged) |
| **N2 — Collapsible sections + My Businesses** | section headers with saved state, auto-reveal on navigation, counts; unit cap 5 + Show all + filter + favourites/recents | Medium | `verify-nav`, `verify-responsive`, `verify-manager-ui`, `verify-bm-dashboard-access` |
| **N3 — Command palette** | ⌘K/Ctrl-K + "/" trigger, sidebar search row, fuzzy + synonyms + recents, keyboard/a11y | Medium | new palette checks in `verify-nav`, `verify-focus-ui`, `verify-input-focus-appwide` |
| **N4 — Responsive drawer + bottom bar** | Navbar hamburger, off-canvas drawer (focus trap, Esc, scroll lock), 4-slot bottom bar on phones; rail becomes a desktop preference | Medium | `verify-responsive`, `verify-contextnav`, `verify-audit-responsive`, manual phone/tablet pass |

Each phase: implement → run the suites → per-phase results report → commit **and** push → continue when
green, exactly like P1–P5.

---

## 7. Decisions requested

1. **Transactions & MoMo**: keep as its own item under **Money** (recommended, preserves the module's own permission scope), or fold it into **Finance & Reports** as a tab?
2. **Orders merge**: approval to merge *Pre-Orders* + *Customer Order & Tracking* into one **Orders & Fulfilment** hub with tabs (both destinations stay one click deeper)? This also implements P6/RA-11.
3. **Recents storage**: per-browser (`localStorage`, no schema change, ships in N2) or per-user in the database (cross-device, needs a small table)?
4. **Phone layout**: drawer + 4-slot bottom bar (recommended) or keep the auto-collapsed icon rail with tooltips only?

**Explicitly not recommended:** removing any destination; merging business dashboards into one entry; a
hover-only flyout for collapsed groups (unusable on touch); hiding Governance items from Owners; moving the
attendance clock or notification bell out of the Navbar.
