# Navigation Reassessment — Audit & Recommended Improvements

**Status: report only. Nothing in this document has been implemented.**
Scope: the shipped N1–N4 navigation (`8cf0e53` + follow-ups) across desktop, tablet and mobile.
Plan of record for what shipped: `docs/SIDEBAR-NAV-AUDIT.md`; results: `docs/SIDEBAR-NAV-REDESIGN-REPORT.md`.

---

## 1. How this was measured

Not by reading code alone — every number below comes from the running app (owner / GM / branch manager /
worker accounts, plus a temporary manage-grantee account that was created and purged for one check):

| Measurement | Result |
|---|---|
| Owner visible destinations | **33** (2 pinned + 31 rows) in **7** sections |
| Branch manager | **6** rows / 4 sections · Worker: **0** section rows (Action Center only) |
| Mobile (390 px) drawer | **41 controls**, content **1883 px** vs **844 px** viewport → **2.2 screens of scroll**; only **18** controls above the fold; first thing below the fold is *Customers & CRM* |
| Bottom bar (390 px) | **5 slots, 50 px tall, 78 px per slot** |
| Unit list inside the drawer | inner scroll box **256 / 428 px** inside a drawer that itself scrolls → **nested scroll** |
| Desktop sidebar (1440×900 / 1366×768) | aside is **8078 px tall**, `position: static`, document scrolls **8143 px**; last nav row sits at y=1730 → **below the fold on every laptop size**, and page-scrolling moves the whole nav out of view (measured: aside top → −635 after a 700 px scroll) |
| Command Center hero | **6 buttons**, of which **5 duplicate an existing destination** |
| Palette with an empty query | **24 rows** = the whole manifest + units (a second sidebar) |
| Worker, "Sell" bottom slot | pixel-identical to "Home" (verified by screenshot hash) — a **dead slot** |

Caveat stated up front: **there is no usage telemetry in this codebase**, so "rarely used" below is inferred
from role, cadence and duplication — not from measured traffic. Everything else is measured.

---

## 2. Verdict on the question asked: should Records, My Businesses and Finance & Reports join the bottom bar?

**No — not as permanent slots, and no arrangement should grow the bar past 5.** Recommended instead: keep
five slots, make them role-correct, and let the user pin 1–2 destinations of their own choice.

Why, concretely:

1. **Slot budget.** At 390 px, 5 slots = 78 px each (16 px icon + 10 px label). Adding the three would give
   **49 px per slot** for 8 items; labels ("Businesses", "Records", "Finance") clip at that width and the bar
   stops being scannable at a glance. Five is the ceiling.
2. **Two of the three are role-gated, so the bar would change shape per role.** Records is invisible to
   workers entirely (measured: 0 section rows); Finance is gated by `execOrUnitManager || canViewFinance`.
   A thumb bar whose positions move between users is worse than a stable bar — users learn positions.
3. **They are not the *frequent* actions.** A worker/branch day is *Actions → Record Sale → Order &
   Tracking*; an owner's is *Home → Actions → Sell*. Stock takes and month-end reports are periodic, which is
   exactly what the palette and the drawer are for.
4. **Better answers already exist for each of the three:**
   * *Records* → for workers and BMs it is already an **in-workspace tab** ("Inventory" in the worker
     workspace) — no nav slot needed. For owners it is periodic.
   * *My Businesses* → unit switching is a **context change**, not a destination. It belongs in the mobile
     **top bar as a unit chip/sheet** (mirroring the desktop Organization Lens), not in a bottom slot.
   * *Finance & Reports* → put it in the **palette's initial list** (recents/favourites + a role-aware top 5)
     so it is two taps without scrolling.
5. **The real mobile problem is scroll weight, not slot count.** A 2.2-screen drawer with 18 of 41 controls
   above the fold, plus a nested scroll box, costs more taps than a missing bottom slot.

### Recommended bottom-bar arrangement

| Slot | Default (owner/GM) | Branch manager | Worker | Farm advisor |
|---|---|---|---|---|
| 1 | Home | Home | Home | Home |
| 2 | Actions | Actions | Actions | Console |
| 3 | Sell (Sales & Payments) | Sell (Branch Sales) | **Record Sale** (today it is a dead duplicate of Home) | Actions |
| 4 | Search | Search | Search | Search |
| 5 | Menu | Menu | Menu | Menu |

Plus one addition that answers "My Businesses" without spending a slot: **a unit chip in the mobile top
bar** for multi-unit accounts (opens the same list + Organization Lens as the sidebar).

Optional (the scalable answer to "which 5?"): let the user **pin 1–2 of their own destinations** into slots
2–4 from the palette/drawer, persisted with the existing `gomina.nav.prefs.v1`. Home, Search and Menu stay
fixed; nothing is ever removed from the drawer.

---

## 3. Remaining duplication (measured, not theoretical)

| # | Destination | Surfaces it appears in today | Recommendation |
|---|---|---|---|
| 1 | **Manage Units** | sidebar section gear (`sidebar-manage-businesses`), Command Center hero button, **avatar menu** (`open-manage-units`) | Keep the sidebar gear + one entry point; drop the hero button (avatar menu is discoverable and always present) |
| 2 | **Online Ordering / Storefront** | sidebar *Settings & Storefront* row, **avatar menu** (`open-online-ordering`), Command Center hero ("Storefront HELP" = support copy, adjacent concept) | Keep the sidebar row; drop the avatar-menu duplicate or drop the sidebar row — one must go |
| 3 | **Sales & Payments — two rows, identical label** (verified with a real BM+manage account: 2 rows, `sidebar-tab-sales` "ALL" and `sidebar-item-BRANCH_SALES` "SALES") | *Sell & Fulfil* + *Branch Management* | Rename the branch one **"Branch Sales & Payments"** (the right rail already uses that name), or hide it when the enterprise variant is visible |
| 4 | **AI Strategic Advisor**, **Scenario Planning** | sidebar *Insights* + Command Center hero | Hero is the only place with no unique value here; drop from hero |
| 5 | **Users & Access** | sidebar *Enterprise Users* + Command Center hero | Keep one |
| 6 | **Audit & Review** vs **"Export / Audit"** (top bar) | different functions sharing one word | Informational — do not rename casually: two in-app copy strings refer to "the Export / Audit button (top-right)". If renamed, change all three together |
| 7 | **Palette empty state** | shows all 24 destinations on a fresh browser — a second sidebar rather than "recents + top 5" | Cap the empty state at ~8 rows (recents/favourites first, then role-aware top 5) |
| 8 | **Right-rail "QUICK NAVIGATION"** | duplicates the sidebar on desktop; on HQ pages it lists **1** entry (measured: "Command Center"), on shared-module pages up to 12 | Hide the block when it would list ≤1 other page; replace with "Recently used" on HQ pages. (Rail is genuinely useful on phone/tablet where the sidebar is a drawer) |

In all cases the *destination* stays; only the redundant shortcut goes.

---

## 4. Grouping, collapse and visibility

| Change | What it does | Why |
|---|---|---|
| **Split Governance into "Oversight" (Audit & Review, Document Vault) and "Administration"** (Farm Advisors, Enterprise Users, Platform Owners), the latter **collapsed by default** | 5 rows → 2 visible + 3 behind a disclosure | Governance currently mixes assurance with one-off admin; a BM sees only the assurance half (measured: 1 row) |
| **Default-collapse low-frequency sections per role** (Insights, Administration, Settings) | First screen shows ~**17** rows instead of 33; state persists as today | Cuts the drawer from 2.2 screens to roughly one without hiding anything |
| **Gate "Farm Advisors" on actually having advisors** | Currently `eligible: isExecutive` → every owner sees it even with **0 advisors** (demo has 0) | Pure clutter for the majority; one-line eligibility predicate |
| **Make the "Orders & Fulfilment" hub header tappable** | It is a plain `div` today; tapping it does nothing | 3 lines currently represent 2 destinations; the header should open the hub |
| **Keep `Platform Owners` super-admin-only** (already correct) | Demo owner has `is_super_admin = true`, so it shows in demos but not for normal owners | No change needed — noted so it is not mistaken for clutter |
| **Demo-data hygiene: remove the leftover unit "kkkkk" (`POULTRY-02`)** | It renders in the unit list for every owner account | It is test residue, not a seeded unit |
| **Palette synonyms for team vocabulary** (already good: momo/stock/payroll/pre order) | Add: *reports*, *stock take*, *payslips*, *orders*, *customers* | Reduces the temptation to add more bar slots |

---

## 5. Mobile improvements (ranked by what actually costs taps)

1. **Remove the nested scroll** — render the unit list inline inside the drawer on phones (single scroll
   container) and apply the **"5 units + Show all N"** cap promised in the N2 audit but shipped as a
   fixed-height scroll box (`max-h-64`, measured 256/428). This alone reclaims ~400 px of drawer depth.
2. **Fix the dead "Sell" slot for workers** (verified identical to Home) — send it to the worker's
   *Record Sale* tab, or label it honestly.
3. **Unit chip in the mobile top bar** for multi-unit accounts (replaces the "My Businesses" bar idea).
4. **Bottom bar active state** — verify/highlight the current slot (Home/Actions/Sell) so the bar also
   answers "where am I?" (the desktop sidebar does this via `aria-current`).

## 6. Desktop improvements

1. **Pin the sidebar**: `lg:sticky lg:top-0 lg:h-screen` + inner `overflow-y-auto` so it stops scrolling away
   with the page. Measured today: 1.9 screens of nav below the fold and the nav leaves the viewport when the
   content is scrolled. *(Pre-existing layout behaviour — verified against `549883d` — but N1–N4's growth
   makes it the biggest remaining desktop cost.)*
2. **Trim the Command Center hero** from 6 buttons to 3 (New Branch/Unit, Manage Units, Users & Access) —
   it currently duplicates 5 destinations. Note: this touches an existing executive shortcut surface, so it
   is a judgment call, not a defect.
3. **Right rail**: hide "QUICK NAVIGATION" when it has ≤1 entry (see §3 #8).

## 7. What should stay exactly as it is

* Five bottom-bar slots and the drawer as the full manifest (nothing removed, ever).
* Pinned **Command Center / Action Center** (+ Advisor Console for advisors) at the top.
* The **Orders & Fulfilment** hub merging Pre-Orders and Order & Tracking.
* The **command palette** and the three ways to reach it (⌘K, sidebar row, bottom slot).
* Per-section counts, saved collapse state, auto-reveal on navigation, the bounded/filterable unit list,
  business chips, and the Organization Lens.
* All existing test-ids and the business-chip label text (DOM contract).

**Explicitly not recommended:** adding Records / Finance / My Businesses as permanent bottom slots; growing
the bar beyond 5; removing any destination; hiding Governance from owners; a hover-only flyout for
collapsed sections.

---

## 8. Suggested order of work, if and when you approve it

| Priority | Item | Value | Complexity | Risk |
|---|---|---|---|---|
| 1 | Mobile: inline unit list + "5 + Show all N" (kills nested scroll) | High | Low | Low |
| 2 | Default-collapse per role + split Administration out of Governance | High | Low | Low |
| 3 | Desktop: pin the sidebar (`lg:sticky lg:h-screen`) | High | Low | Low–medium (layout) |
| 4 | Worker "Sell" slot → Record Sale; add bar active state | Medium | Low | Low |
| 5 | Duplication trims (§3: hero 6→3, Manage Units/Online Ordering single entry point) | Medium | Low | Medium (touches exec + avatar menu) |
| 6 | Rename `BRANCH_SALES` → "Branch Sales & Payments" | Medium | Trivial | Low (label only; test-id unchanged) |
| 7 | Palette empty state → recents/favourites + top 5; right rail hides ≤1-entry block | Medium | Low | Low |
| 8 | Mobile unit chip in the top bar | Medium | Medium | Low |
| 9 | Optional user-pinnable bottom bar (navPrefs) | Medium | Medium | Low |
| 10 | Gate "Farm Advisors" on having advisors | Low | Trivial | Low |

Items 1–4 are the ones that change how the navigation *feels*; 5–10 are polish. None of them require
changing a permission, a business workflow or an existing test-id.

---

### Honesty flags

* **No usage analytics exists**, so frequency claims are reasoned from role/cadence, not measured.
* The **desktop non-sticky sidebar** and the **uncapped unit list** are pre-existing behaviours (verified
  against the pre-N1 file `549883d:src/components/Sidebar.tsx`), not regressions from N1–N4.
* The **BM+manage double "Sales & Payments"** was verified by creating a temporary manage-grantee account
  (2 rows observed) and purging it afterwards.
* The **worker dead "Sell" slot** was verified by comparing rendered screenshots (identical hash to Home).
* The **demo super-admin owner** over-represents "Platform Owners" — it is correctly gated in production.
