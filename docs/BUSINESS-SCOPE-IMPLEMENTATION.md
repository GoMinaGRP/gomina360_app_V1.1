# Business Scope & Filtering — Implementation Report

Companion to `docs/BUSINESS-FILTERING-AUDIT.md` (the approved strategy). This
file tracks the phased rollout, what each phase changed, how it was verified,
and what remains.

Model: `src/lib/businessScope.ts` — **Owner → Unit → Type**, with
**My Workspace as the default for every role** and owner grouping/counts when a
view actually spans owners. Narrowing is presentation-only: the server scope
(accessible businesses, auditor grants, branch/module limits) is unchanged and
always the authority.

## Phase A — shared model + Audit & Review (`4612bf8`)

- `src/lib/businessScope.ts`, `src/components/BusinessScopeBar.tsx`.
- Audit & Review adopts the shared bar (owner → unit → type + search), defaults
  to My Workspace, and `/api/audit` accepts narrowing `?ownerId=` /
  `?businessIds=` (intersecting, never widening); `bizList` carries `ownerName`
  for Super Admins only.
- Verified: `verify-business-scope.mjs` 50 checks; audit suites 29/28/38;
  lens-verify 15; multiowner-verify 118.

## Phase B — Manage Units · Export Center · Command Center (`8aa53d1`)

- **Manage Units** opens on My Workspace (the `[isOpen]` effect had been
  overriding the default to ALL), owner options carry counts, unit search added.
- **Export Center** replaces the flat "All Businesses & Branches" select with
  the shared bar and states the export scope honestly ("Exports 9 units in
  GoMina Group"); units group by owner with counts when owners are in view.
- **Command Center** groups the unit grid by owner (own workspace first) only
  when more than one owner is in view.
- Verified: `verify-business-scope.mjs` 64 checks; business-manage, logos,
  online-mgmt, storefront-areas, shared-ui, nav, clean-state, business-backup,
  employees, bm, manager-ui, action-center-ui all green.

## Phase C — the flat unit selectors

- New shared pieces: `unitOptionGroups()` (pure, in `businessScope.ts`),
  `UnitScopeOptions` (option list with owner `optgroup`s) and
  `OrgDirectoryContext` (GoMinaApp publishes the Super Admin's org directory so
  panels can name owners without prop-threading).
- Adopted in: Action Center, Document Vault, Pre-Order catalogue, Procurement,
  Customer Order & Tracking, Finance & Reports (consolidated report + Budgets &
  Cashflow), Scenario Planning, AI Advisor, Sales & Payments (executive
  operating-branch picker), Payroll Command Center, Attendance review, CCTV
  rail, Enterprise Users pickers, Users & Access wording.
- Vocabulary is now one word — "**All units**" (with "(consolidated)" /
  "(enterprise)" where the surface needs it). "All businesses" / "All my
  businesses" / "All accessible" / "All Businesses & Branches" are gone from
  the dashboard surfaces. The two report titles read "… — All Units".
- A single-owner list renders exactly as before (plain options, no optgroups);
  groups appear only when a view spans owners, always My Workspace first, with
  counts. Left alone on purpose: per-business "All Branches" pickers inside a
  single unit's module (Block QC, Fish/Poultry growth) — those are branches of
  one unit, not owner scopes — and `SharedEnterpriseModule`'s data-licence
  filter, which compares its own sentinel strings.
- Verified: `verify-business-scope.mjs` 81 checks (new section G walks the
  Phase C surfaces under both lenses); regression batch action-center,
  action-center-ui, attendance, attendance-gps, payroll2, documents,
  procurement-chain, budgets-cashflow, customer-ui, customer-360, tracking,
  orders-maps, bm-dashboard-access, employees, manager-ui, shared-ui, nav,
  ai-guides-ui, clean-state, clean-state-ui, az-app-audit, credit-sales,
  finance-allproducts-fresh — all green.

## Phase D — server contract & isolation lock

Findings first (probed live, then codified in `verify-business-scope.mjs` §H):

- **No new widening parameter is needed.** `/api/audit` is the only payload that
  spans owners by design, and it already takes the intersecting `?ownerId=` /
  `?businessIds=` narrowing (Phase A). Every other list endpoint narrows by
  `businessId` and — crucially — filters rows through the caller's server-side
  scope rather than trusting the parameter, so a forged id can only ever return
  nothing. `/api/init` already carries `ownerId` on every unit.
- **What was missing was proof.** Section H now locks the contract:
  - the platform payload describes every owner (ownerId on 10 units, owners 1 & 2);
  - a scoped caller's payload contains only units they can access and publishes
    **no owner names/directory** (owner naming stays a Super Admin capability);
  - a forged `businessId` is refused with 403 on `/api/transactions`,
    `/api/tasks` and `/api/documents`, and returns zero foreign rows on
    `/api/employees` (scope-filtered, not parameter-trusted);
  - the caller's own unit still answers in full (25 transactions, tasks 200);
  - the **audit axis is a grant, not operational access**: this caller operates
    unit 1 but may audit unit 2 only, and asking for their operational unit
    returns 0 auditable units. Forging an id never widens it.

Deliberately NOT done: making `/api/init` lens-aware. The lens switches
instantly client-side over an already-scoped payload (Super Admin ⇒ platform
payload), which every surface now filters through `scopedBusinesses`; moving the
lens into the request would add a refetch/reload path for no correctness gain.

## Final state

| Phase | Commit | Scope | Verification |
| --- | --- | --- | --- |
| A | `4612bf8` | model + Audit & Review + `/api/audit` narrowing | 50 checks + audit 29/28/38, lens 15, multiowner 118 |
| B | `8aa53d1` | Manage Units · Export Center · Command Center | 64 checks + 12 suites |
| C | `edc99de` | 16 flat selectors → one shared list | 81 checks + 23 suites |
| D | this commit | payload/isolation contract lock | 94 checks (A–H) |

`dev-tooling/verify-business-scope.mjs` is the standing regression suite for the
whole feature (roles: Super Admin, scoped auditor; lenses: My Workspace, All
Organizations, a single owner).

## Test fragility fixed along the way

- `verify-clean-state-ui.mjs`: the sidebar previews only the first 5 units, so a
  unit created by the suite could sit behind the "Show all" cap. The suite now
  expands the list before clicking a business by name (was red for data
  reasons, not a product regression).
