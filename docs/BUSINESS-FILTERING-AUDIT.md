# Business Filtering & Organisation — Audit and Recommended Approach

**Status: audit only — nothing implemented.** Scope: Audit & Review and every other GoMina 360 surface
that asks the user to pick a business, plus the Super Owner/Admin sections that list units across owners.

**The problem in one line:** the platform already has an Owner/Organization concept (`businesses.ownerId` +
`organizations` directory) and a Super Admin "Organization Lens", but individual screens each re-invent a
flat business list — so the defaul is often *every* unit on the platform, with no owner grouping, no type
grouping and no search, and at least one screen (Audit & Review) bypasses the lens entirely.

---

## 1. What already exists (and should be reused, not rebuilt)

| Piece | Where | What it gives us |
| --- | --- | --- |
| Owner/Org stamp on every unit | `businesses.ownerId` (+ `organizations` table, `organizationMembers`) | The Owner dimension is already in the data; `lens-verify.mjs` asserts every business carries `ownerId`. |
| Org directory | `/api/init` → `organizations` (**Super Admin only**), `organization` (own org, always) | Grouping source for the Super Admin; deliberately empty for normal owners (verified in `lens-verify`, contract §6). |
| Organization Lens | `GoMinaApp.tsx:199-235` (`orgLens`, `lensOrgId`, `lensScope`, `scopedBusinesses`), `Sidebar.tsx:780-820` (`data-testid="org-lens-select"`) | The intended "whose data am I looking at" context: `MY` (default) · `ALL` · one owner. **Most screens already consume `scopedBusinesses`.** |
| Grouping helpers | `src/lib/orgGrouping.ts` — `groupBusinessesByOrg()`, `rollupsByOrg()` | Main-workspace-first owner grouping; used by Sidebar + Command Center oversight. |
| Business-type vocabulary | `src/lib/businessTypes.ts`, `businessTypeKeys.ts` (`businessTypeKeyOf`, `businessTypeLabelOf`, `BUSINESS_TYPES`) | Type dimension, already used by Command Center and Manage Units. |
| Scope helpers (server) | `src/lib/auth.ts` (`accessibleBusinessIds`, `canAccessBusiness`), `user_business_access`, `businessManageIdsOf`, `src/app/api/audit/route.ts` `scopeFor()` | The authoritative permission layer: OWNER / SUPERVISOR / AUDITOR levels, per-business modules, per-branch limits, grants. |
| The closest existing pattern | `ManageBusinessesModal.tsx:195-230` (Owner filter + Type filter, Super Admin only, with live-derived type options) and `Sidebar.tsx:826-833` (unit search over N units) | The exact control trio minus search — good to generalise into a shared component. |

**Conclusion:** no schema change and no new permission model is needed. The Owner → Unit → Type data is
already on the client for every role that is allowed to see it.

---

## 2. Findings — Audit & Review (the reported pain)

| # | Finding | Evidence |
| --- | --- | --- |
| A1 | **The screen ignores the Organization Lens.** The business list comes from the API payload (`bizList`), not the lens-scoped `businesses` prop, so a Super Admin in "My Workspace" still sees and filters every owner's units. | `AuditCommandCenter.tsx:189` — `const bizSource = data?.bizList?.length ? data.bizList : businesses;` |
| A2 | **The API has no owner dimension.** `/api/audit` accepts `businessId, module, recordType, branchCode, worker, status, q, from, to` — and for a Super Admin the scope is `businessIds: null` (everything), so `bizList` is the platform-wide list. | `route.ts:723-731` (params), `route.ts:160-161` (scope), `route.ts:795-796` (`bizAll` → `bizList`) |
| A3 | **The business picker is a flat native `<select>`** — no owner grouping, no type grouping, no search, no counts. Live today: **11 units** across 2 owners in one flat list; production N-owner scale makes it unusable. | `AuditCommandCenter.tsx:640-644` |
| A4 | **Reports/Charts merge owners.** "Open vs resolved issues per business" plots every owner's units in one chart; the KPI strip says "N business(es)" without saying whose. | `AuditCommandCenter.tsx:1051`, `:579` |
| A5 | **Auditor Access tab lists every unit platform-wide** for the granting owner (super admin), flat — the same owner/type grouping gap in a *write* surface. (Not a leak: the server re-checks `grantBusinessIds` on save — `route.ts:1308`.) | `AuditCommandCenter.tsx:1157-1180` |
| A6 | **Live consequence:** in lens = "My Workspace", the Audit record set is identical to lens = "All" — currently **132 records, 1 of them from Org 2 (`WM Demo Unit`)**. The sidebar says "My Businesses (10)" while Audit silently counts 11. | Measured against the running app (`/api/init` + `/api/audit`, super-admin session) |

Everything else on the screen (module, record type, branch, worker, review status, date range, free-text
search) is orthogonal and fine — the gap is precisely the *business/owner* axis.

---

## 3. Findings — the rest of the platform (same class of issue)

Legend — **Default**: what a Super Admin sees on first open. **Dims**: which axes the control offers.
**Group**: owner/type grouping. **Search**: filter within the control.

| Surface | Business control | Default | Dims | Group | Search |
| --- | --- | --- | --- | --- | --- |
| **Audit & Review** (`AuditCommandCenter`) | flat select of `bizList` | All in scope (**every owner**) | business | ✗ | ✗ |
| **Command Center** (`CommandCenterDashboard`) | type filter + per-unit multi-select grid | lens-scoped ✔ | type, business, groupBy Business/Branch | type only | ✗ |
| **Manage Units** (`ManageBusinessesModal`) | owner filter + type filter (super admin) | **All owners** (`orgFilter="ALL"`) | owner, type | owner ✔ (list) | ✗ |
| **Export Center** (`UniversalExportCenter`) | flat scope select | **"All Businesses & Branches"** | business | ✗ | ✗ |
| **Users & Access** (`UserAccessConsole`) | "Primary business / branch" select | unset → first unit | business | ✗ | ✗ |
| **Action Center** (`ActionCenter`) | flat select | "All businesses" | business | ✗ | ✗ |
| **Attendance / Payroll / CCTV** | flat select | "ALL" | business | ✗ | ✗ |
| **Budgets & Cashflow** | flat select ×2 | "all" (consolidated) | business | ✗ | ✗ |
| **Document Vault / Procurement / Pre-Orders** | flat select | "All units" | business | ✗ | ✗ |
| **Tracking, Finance/Reports, AI Advisor, Scenario Planner, Employee Center, Enterprise Users, Advisor Console, Branch Manager sales, Integrations** | flat select or first-unit default | "All" / first unit | business | ✗ | ✗ |
| **Platform Owners** (`PlatformAdminPanel`) | — (lists *organizations*) | n/a | owner | n/a | ✗ |
| **Sidebar "My Businesses"** | lens select + unit filter | lens (`MY`) ✔ | owner, business | owner ✔ | ✔ (`Filter N units…`) |
| **Command Palette** (`nav/CommandPalette`) | search over accessible units | accessible set | business | ✗ | ✔ |

Two structural observations:

- **S1 — The lens is the right idea, applied unevenly.** Most panels inherit it because they render
  `scopedBusinesses`; Audit & Review overrides it (A1), and a handful of management surfaces open on an
  explicit "ALL" default (Manage Units, Export Center) that fuses owners.
- **S2 — No shared control.** Roughly twenty screens each hand-roll a `<select>` over `businesses` with a
  different label ("All businesses" / "All units" / "All my businesses" / "All in scope"), a different
  default, and none of them offers owner grouping + type grouping + search together. That is the reason the
  experience is inconsistent — and why the same fix has to be repeated twenty times unless it is shared.

---

## 4. Recommended approach

### 4.1 One scope model, one resolution rule

```ts
// src/lib/businessScope.ts (new, small, pure — mirrors orgGrouping.ts style)
type Scope = { ownerId: "MY" | "ALL" | number; businessId: number | "ALL"; typeKey: string | "ALL" };

resolveScope(user, businesses, organizations, lens) → Scope          // default for this caller
scopeBusinesses(scope, businesses) → any[]                            // filter (never widens)
scopeOptions(businesses, organizations, user) → { owners[], units[], types[] } // grouped + counts
scopeLabel(scope, …) → "My Workspace · 10 units" | "Owner: AU WM Demo Org" | "All owners · 11 units"
```

**Default rule ("My Workspace first")** — the same precedence everywhere:

| Caller | Default scope |
| --- | --- |
| Normal OWNER / GM | own organization (today's behaviour) |
| Branch manager / supervisor / worker | their assigned or managed units (today's behaviour) |
| Auditor / delegated manager | exactly their granted units & branches (today's behaviour) |
| **Super Admin** | **`ownerId: "MY"` — the Main Owner's workspace**, regardless of surface |
| Super Admin, explicitly | "All owners" or one named owner — only as a deliberate, visible choice |

### 4.2 One shared control

`BusinessScopeBar` (new, `src/components/`): **Owner → Unit → Type**, each a compact select with counts,
plus a search box that filters units by name/code/type/owner, plus a chip showing the active scope
("My Workspace · 10 units · 4 types"). Behaviour:

- Owner select is **hidden** when the caller can only see one owner (normal owners, auditors) — no new
  cognitive load, identical rendering for them.
- Unit select uses `<optgroup>` per owner when more than one owner is visible; the search box covers the
  long-list case without needing a custom tree widget.
- Type select is derived from the *currently visible* units (the `ManageBusinessesModal` pattern — never a
  stale global list).
- Small panels (a header row) get the same component in a compact variant; nothing about the existing
  testids is removed — the shared control keeps each surface's current `data-testid` via a prop, and adds
  `scope-owner` / `scope-unit` / `scope-type` / `scope-search` for tests.

### 4.3 Server support (narrowing only)

Add an optional `ownerId` (or `organizationId`) parameter to the list APIs that a super admin can call
platform-wide — `/api/audit` first, then `/api/tasks`, attendance, payroll, cctv, budgets, export audit.
Rules:

- The parameter can only **narrow**: `businessIds ∩ ownerScope ∩ row-level scope`. For non-super-admins it is
  ignored (or refused) — their scope is already authoritative.
- `bizList` and comparable payloads gain `ownerId` (+ `ownerName` when the caller is a Super Admin) so the
  client can group without a second request; no extra query, the rows already carry `owner_id`.
- The Organization directory stays Super-Admin-only (`initSnapshot.ts:243-246`) — unchanged.

### 4.4 What this preserves

- **Tenant isolation:** the server-side scope (`scopeFor`, `accessibleBusinessIds`, `canAccessBusiness`,
  `grantBusinessIds`, branch/module limits) remains the only authority. The client scope is presentation
  only — a forged `ownerId` cannot widen it (that is why §4.3 is "narrowing only").
- **Auditor grants across owners** (a legitimately granted business inside another owner's org) keep working:
  such callers see the owner control **hidden**, exactly like today.
- **Permissions, workflows, destinations and testids** are untouched; the lens stays the sidebar-controlled
  global context, and Audit & Review simply starts *obeying* it (with "All owners" one click away).
- **Nav contract** (5 bottom-bar items) is unaffected.

### 4.5 Rollout (phased, each phase tested + reported)

| Phase | Content | Why this order |
| --- | --- | --- |
| **A** | `businessScope.ts` + `BusinessScopeBar`; adopt in **Audit & Review** (Records, Issues, Log business filter; Reports scoped to the active scope; Access tab unit list) and make the screen respect the lens by default | Fixes the reported pain first; the lens already exists, so the change is small and visible |
| **B** | **Manage Units** (owner filter → "My Workspace" default + search), **Export Center** (default "My Workspace"; owner/unit/type + search; export metadata records the scope), **Command Center** (add owner group to the unit grid; type filter already there) | Highest cross-owner consequence: creation, export and reporting are the places where "default = everyone" is most costly |
| **C** | Mechanical adoption in the remaining ≈16 filter panels (Action Center, Attendance, Payroll, CCTV, Budgets, Vault, Procurement, Pre-Orders, Tracking, Finance, AI Advisor, Scenario, Employees, Users & Access), replacing "All businesses/All units" with the shared control and the same default | Consistency; each swap is small because the component is shared |
| **D** | Server `ownerId` narrowing param + `ownerId` on `bizList`-style payloads; extend `lens-verify.mjs`; add `verify-business-scope.mjs` (defaults per role, owner grouping counts, search, no-widening probe with a forged `ownerId`) | Keeps the client and server contracts aligned, and makes the rule regression-proof |

### 4.6 Acceptance criteria for the implementation (when approved)

1. For every role, the first render of every filtered surface is the caller's own workspace — verified by a
   test that logs in as Super Admin, Owner, GM, Branch Manager and Auditor.
2. Super Admin can reach any owner's units in at most two interactions from any surface, and the active
   owner is always visible on screen (no invisible context).
3. Owner/Type grouping counts always reconcile with the units actually listed; a filter never yields a
   stale/empty option set.
4. No API returns a broader set because of a client-supplied owner/type parameter.
5. Existing suites stay green (`lens-verify`, `verify-audit-records`, `verify-audit-access`, `verify-nav`,
   `verify-shared-ui`, `verify-storefront-areas`, `multiowner-verify`, `verify-clean-state`, …).

### 4.7 Risks / watch-outs

- **Double-scoping:** the lens-scoped `businesses` prop and the surface's own filter must not be applied
  twice (Audit is the live example). The shared resolver must be the single place that composes them.
- **Empty-owner edge case:** rows with `ownerId = null` (legacy/seed) bucket to the Main workspace, as
  `groupBusinessesByOrg` already does.
- **Auditor UX:** a granted unit inside another owner's org must not expose the owner's name or other units.
- **Demo/legacy noise** (e.g. the "kkkkk" unit) still appears inside "My Workspace" — that is data cleanup,
  not a filtering problem.

---

## 5. Effort estimate

| Phase | Size |
| --- | --- |
| A — shared lib + control + Audit & Review | ~1 focused change set + tests |
| B — Manage Units, Export Center, Command Center | ~1 change set (three screens, one of them a write surface) |
| C — ≈16 mechanical adoptions | ~1–2 change sets, mostly replacements |
| D — server params + suite additions | ~1 change set |

No database changes, no new tables, no migration; the work is UI composition plus optional read-parameter
narrowing.
