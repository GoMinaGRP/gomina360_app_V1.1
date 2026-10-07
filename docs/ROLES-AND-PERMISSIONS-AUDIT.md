# GoMina 360 — Roles & Permissions Audit

**Scope:** every place a user account is created or edited, every role token in the codebase,
and what each role can actually see and do once signed in.

**Status:** audit only — **nothing has been changed**. Section 7 lists the recommended
single source of truth and Section 9 the decisions I need from you before implementing.

**Evidence:** live UI captures (`docs/evidence/role-picker-users-access.png`,
`docs/evidence/role-picker-enterprise-users.png`), a computed nav-visibility matrix
(`dev-tooling/audit/role-nav.ts`), and a live API probe of the create endpoint.

---

## 1. Executive summary

There is **no single definition of "a role"** in GoMina 360. The role vocabulary is
re-declared in **53 arrays**, **244 literal comparisons** and **5 label maps** scattered
across 89 files. Two independent user-management screens sit on top of **one** API
endpoint, and they offer **different, overlapping but unequal** role lists.

The concrete symptom you reported — *Farm Advisor is offered when registering an Enterprise
User but missing from Users & Access* — is one instance of a general pattern:

| | Users & Access | Enterprise Users → Register |
|---|---|---|
| Offers | Co-Owner, General Manager, Branch Manager, **Accountant**, **Supervisor**, Worker | General Manager, Branch Manager, Worker, **Farm Advisor** |
| Missing | **Farm Advisor** | **Co-Owner, Accountant, Supervisor** |
| Permission toggles | all 14 capability flags | only 4 (sales / expenses / stock / export) |

Three further findings are more serious than the picker mismatch:

1. **The create API accepts any role string at all.** `POST /api/users` never validates
   `role` against a list. I proved it live: posting `role: "BANANA"` passed role handling
   and was only stopped by the duplicate-email check.
2. **Supervisor and Accountant are roles with no defined workspace.** They are offered in
   Users & Access, but they render **only** the generic Action Center — no unit dashboard,
   no attendance-review nav, no report nav. They are effectively Workers with more rights
   on the server and fewer screens in the UI.
3. **Four "roles" in the code are not roles at all** (`MANAGER`, `ADMIN`, `SUPER_ADMIN`,
   `AUDITOR`). They are phantoms — one is a boolean flag, one is an assignment level, two
   are legacy strings that match nothing the app can create.

---

## 2. The verified role pickers

### 2.1 Command Center → **Users & Access** (`UserAccessConsole.tsx`)

```
Role *  ▾
  • Co-Owner                 CO_OWNER
  • General Manager          GENERAL_MANAGER
  • Branch Manager           BRANCH_MANAGER
  • Accountant               ACCOUNTANT
  • Supervisor               SUPERVISOR
  • Worker                   WORKER
```
Declared at `UserAccessConsole.tsx:17`. A **delegated** manager (non-owner with the
`canManageUsers` grant) sees only `[BRANCH_MANAGER, WORKER]` (`:96`).

This surface exposes the **full** permission set — 14 toggles including the OWNER-only
"sensitive surface" grants (Manage & delete shared records, Delete inventory, Manage
expenses, CCTV, Online storefront, New Branch/Unit, **Finance & Reports**, Customer
Support, Manage auditor access, Enterprise Users delegation).

### 2.2 Enterprise Users → **Register User Account** (`EnterpriseUserPanel.tsx`)

```
Role *  ▾
  • General Manager          GENERAL_MANAGER
  • Branch Manager           BRANCH_MANAGER
  • Worker (Sales Person)    WORKER
  • Farm Advisor (external, read-only)   FARM_ADVISOR
```
Hard-coded `<option>` literals at `:907–912` (register) and `:1155–1158` (edit modal —
which omits General Manager's position but reorders to `GM, FARM_ADVISOR, BM, WORKER`).

This surface exposes **only 4 toggles**: Can Record Sales, Can Record Expenses,
Can Manage Stock, Can Export Data / Reports.

Its **"Filter by Role"** dropdown (`:576`) lists `ALL, OWNER, GENERAL_MANAGER,
FARM_ADVISOR, BRANCH_MANAGER, WORKER` — so a **Co-Owner, Accountant or Supervisor**
account can never be filtered for, and the role **badge** renders the raw enum
(`{user.role}` at `:645`) — e.g. `CO_OWNER` in capitals — while only Farm Advisor gets a
prettified label ("FARM ADVISOR"). The codebase has **three** competing label maps:
`UserAccessConsole.tsx:18`, `tracking.ts:257` (which labels WORKER as *"Branch staff"*)
and the inline ternaries in `EnterpriseUserPanel.tsx:635`.

### 2.3 A third creation path

`POST /api/users/workers` (`src/app/api/users/workers/route.ts:110`) inserts
`role: "WORKER"` unconditionally — reached from the Branch Manager's **Worker panel**
(`BranchManagerWorkerPanel.tsx`). So workers can be minted from three different screens.

---

## 3. Complete role inventory

Every role-like token found in `src/`, with what it actually is:

| Token | Real role? | Creatable today | Refs | Notes |
|---|---|---|---|---|
| `OWNER` | ✅ | seed / provisioning only | 213 | `organizationProvisioning.ts:52` hard-codes the first account's role |
| `CO_OWNER` | ✅ | **Users & Access only** | 13 | Rank 3; treated as executive in nav/budgets/exports but **absent** from `notify.ts` money-watcher lists |
| `GENERAL_MANAGER` | ✅ | both surfaces | 98 | Rank 3 |
| `BRANCH_MANAGER` | ✅ | both surfaces | 85 | Rank 2; the only role with a dedicated workspace |
| `SUPERVISOR` | ✅ | **Users & Access only** | 10 | Rank 2; **no UI workspace** (see §4.5) |
| `ACCOUNTANT` | ✅ | **Users & Access only** | 5 | Rank 2; **no UI workspace** |
| `WORKER` | ✅ | all three paths | 108 | Rank 1; only role with a self-contained dashboard |
| `FARM_ADVISOR` | ✅ | **Enterprise Users only** | 49 | Access flows exclusively through `advisor_assignments` |
| `MANAGER` | ❌ **phantom** | never | 5 | `transport/route.ts:804`, `TransportModule.tsx:275`, `notify.ts:349,362`, `notifyActivity.ts:52` — matches nothing creatable |
| `ADMIN` | ❌ **phantom** | never | 1 | `transport/route.ts:804` (also collides with the checklist *category* "ADMIN") |
| `SUPER_ADMIN` | ❌ not a role | — | 1 | `transport/route.ts:804` references it as a role string; the platform uses the **boolean** `users.isSuperAdmin` |
| `AUDITOR` | ❌ not a role | — | 2 | An *assignment level* returned by `/api/audit` (`scope.level`), not a `users.role` value |
| `CUSTOMER` | ❌ not a role | — | 1 | Label map in `tracking.ts` for public order activity |

**There is no server-side allowlist.** `POST /api/users` (`:46`) only checks that `role`
is truthy. Live probe against the running app:

```
role="BANANA"    → HTTP 409  "A user with this email already exists."
role="OWNER "    → HTTP 409  "A user with this email already exists."
role=""          → HTTP 400  "Name, email, and role are required"
```

The 409 proves `"BANANA"` cleared every role check — the duplicate-email test (line ~292)
runs *last*. A fresh email with `role: "BANANA"` would create a user whose role matches no
code path: no nav rows, no workspace, no gates — and whose capability columns fall back to
database defaults (`canRecordSales = true`).

`ROLE_LEVEL` in `users/route.ts:43` (a rank map) is **dead code** — declared and never read.

---

## 4. Per-role audit

### 4.0 Method

`dev-tooling/audit/role-nav.ts` builds the exact context `/api/users` would create for a
fresh account of each role (no OWNER grants, business assigned) and asks `navEntriesFor()`
which navigation rows that role receives. This is the same function the rail renders from,
so the numbers below are the app's own answer, not an approximation.

### 4.1 Navigation visibility (freshly created account)

| Role | Nav rows | What they get |
|---|---:|---|
| **OWNER** | 20 | everything incl. Finance, Audit, Enterprise Users, Command Center |
| **CO_OWNER** | 17 | full executive set **minus** Finance, Audit, Enterprise Users |
| **GENERAL_MANAGER** | 17 | **byte-identical to Co-Owner** |
| **BRANCH_MANAGER** | 5 | Branch Sales, Action Center, Branch Assets, Tracking, Workers |
| **SUPERVISOR** | **1** | Action Center only |
| **ACCOUNTANT** | **1** | Action Center only |
| **WORKER** | **1** | Action Center (but the dispatch replaces it with `WorkerDashboard`) |
| **FARM_ADVISOR** | **1** | Advisor Console (closed sandbox) |

### 4.2 Unit / business access (`accessibleBusinessIds`, `auth.ts:418`)

| Role | Derived scope |
|---|---|
| OWNER | every unit of their organization(s) — `businessIdsOfOrgs()` |
| CO_OWNER / GM / BM / SUPERVISOR / ACCOUNTANT / WORKER | `assignedBusinessId` ∪ `businessManageIds` ∪ `user_business_access` grants, intersected with their orgs |
| FARM_ADVISOR | **only** active, unexpired `advisor_assignments` rows — primary assignment and grants are deliberately ignored |

So the *data* scope for the five middle roles is identical in structure; only the *UI* differs.

### 4.3 Capability defaults at creation (`users/route.ts:195–250`)

| Capability | OWNER | GM | BM/SUP/ACCT | WORKER | FARM_ADVISOR |
|---|---|---|---|---|---|
| `canExportData` | true | **true** | from checkbox | from checkbox | **false (forced)** |
| `canRecordSales` | default true (DB) | default | default | **true** | default |
| `canRecordExpenses` | — | — | — | checkbox, default false | — |
| `canManageStock` | — | — | — | checkbox, default false | — |
| all 10 OWNER-granted flags | from checkbox | **false, even if sent** | false | false | false |
| `assignedBusinessId` | — | optional | optional | **required (400 without)** | **must be null (400 with)** |

Note the asymmetry: the server grants `canExportData = true` to **General Manager** by role,
but `/api/exports` gates on the **flag** (`if (!isExecutive(role))` where `isExecutive` is
`OWNER|CO_OWNER|GENERAL_MANAGER`). A **Co-Owner** is therefore an executive in `/api/exports`
but is *not* in the `["OWNER","GENERAL_MANAGER"]` list that sets `canExportData` at creation —
harmless today (the exec branch bypasses the flag) but exactly the kind of role/flag drift
this audit is about.

### 4.4 Enforcement surfaces per role

| Role | Server gates that name it |
|---|---|
| OWNER | everything |
| CO_OWNER | `budgets` EXEC, `exports` isExecutive, `users` isExec/delegated-manager, `notifyActivity` money-watcher |
| GENERAL_MANAGER | `approvals` POLICY, `tasks` EXEC, `budgets`, `exports`, `attendance` REVIEW, `checklists`/`daily-notes`/`documents`/`poultry`/`customer-interactions` MANAGE, `notify` checklist-manager, `notifyActivity` money-watcher **and** unit-lead |
| BRANCH_MANAGER | `attendance` REVIEW, `checklists` etc. MANAGE, `notify` checklist-manager, `notifyActivity` unit-lead, `users` legacy worker-creation |
| SUPERVISOR | `attendance` REVIEW_ROLES + clock-in set, `notifyActivity` UNIT_LEAD_ROLES |
| ACCOUNTANT | `attendance` REVIEW_ROLES + clock-in set — **nothing else** |
| WORKER | `attendance` clock-in set, `exports` (pending-request path) |
| FARM_ADVISOR | `advisor`, `advisor-notes`, read-only view props in 6 modules |

`ACCOUNTANT` appears in **two** arrays in the entire codebase and has no accounting-specific
capability anywhere — no payroll, no ledger, no finance nav.

### 4.5 The Supervisor / Accountant problem

Both are offered in Users & Access as rank-2 roles (same rank as Branch Manager), but the UI
dispatch in `GoMinaApp.tsx` intercepts only `FARM_ADVISOR` (`:865`), then `WORKER` (`:961`),
then `isBranchManager` (`:999`). **Supervisor and Accountant fall through every branch** and
reach the shared module dispatch — so they can open a unit's full module screens (sales,
inventory, employees …) but have **no navigation row** to reach them, while their only visible
row (Action Center) is generic.

Concretely: a Supervisor can see *more* module surface than a Worker, but sees *less* nav
guidance than a Branch Manager. That is not a designed role — it is a gap.

---

## 5. Findings

### F1 — Two user-management UIs, one API, two role vocabularies *(your report)*
`UserAccessConsole.tsx` (ROLES array) and `EnterpriseUserPanel.tsx` (hard-coded `<option>`s)
disagree. Farm Advisor exists only in the second; Co-Owner, Accountant and Supervisor exist
only in the first. **Severity: high (functional).**

### F2 — No server-side role validation
`POST /api/users` and `PATCH /api/users` validate role only by membership in *authorization*
arrays. An unknown role string creates an unlandable account. **Severity: high (security/
integrity).**

### F3 — Permission toggles are not role-scoped and not shared
The same account can be given Finance & Reports from Users & Access but has no way to receive
it from Enterprise Users (the toggle isn't rendered there) — while *both* write the same
`canViewFinance` column through the same endpoint. Neither picker applies any **role preset**:
choosing "Branch Manager" in Users & Access leaves `Manage stock = OFF` (correct for a worker,
wrong for a manager), and the toggles do not change when the role changes. Selecting a role
therefore tells you nothing about what the account will be able to do. **Severity: high.**

### F4 — Phantom roles in authorization arrays
`MANAGER`, `ADMIN`, `SUPER_ADMIN` are referenced as role strings in 5 places. No account can
ever hold them, so `transport`'s `canManageTemplates` gate is effectively
`["OWNER","GENERAL_MANAGER","BRANCH_MANAGER"]` — and `notify.ts`'s `CHECKLIST_MANAGER_ROLES`
silently never matches a `MANAGER`. A future rename would keep passing the type checker.
**Severity: medium (correctness debt).**

### F5 — Three inconsistent label maps + raw enum rendering
`UserAccessConsole.tsx:18`, `tracking.ts:257` (WORKER → "Branch staff"), inline ternaries in
`EnterpriseUserPanel.tsx:635`; the Users table additionally prints raw `CO_OWNER`-style enums.
The same person appears as "Worker", "Branch staff" or "WORKER" depending on the screen.
**Severity: medium (UX/consistency).**

### F6 — `ROLE_LEVEL` rank map is dead code
`users/route.ts:43` — 8 lines, never read. Nothing enforces "a manager may not edit a peer or
superior" by rank; that logic is hand-written per surface. **Severity: low (but it is the
missing piece the rank map was clearly written for).**

### F7 — Supervisor / Accountant have no workspace (§4.5)
**Severity: high (functional).**

### F8 — Nav eligibility is derived by string comparison, not by role
`navCtx()` (`navManifest.ts:185`) re-derives `isExecutive`, `isWorker`, `isBranchManager`,
`isFarmAdvisor` from `role ===` literals, and `GoMinaApp.tsx` holds **32** further role
comparisons. Adding a role today requires finding all of them. **Severity: high (the root
cause of F1/F7).**

### F9 — `canOpenBusiness` short-circuits for unlisted roles
`navManifest.ts:764` returns `true` for any role that isn't `BRANCH_MANAGER`/`WORKER`
(including `SUPERVISOR`, `ACCOUNTANT` and any unknown role). It is currently harmless because
the business list is server-scoped, but the guard reads as a permission check and is not one.
**Severity: low (defence in depth).**

### F10 — Create-surface validation order is inconsistent
Enterprise Users' register modal offers `None (HQ / Executive)` as the branch for a **Worker**,
which the API rejects with 400 (`WORKER must be assigned to a business branch`). A
`canManageUsers` GENERAL_MANAGER using that modal is offered all four options, but two
(`GENERAL_MANAGER`, `FARM_ADVISOR`) return 403 from the API. **Severity: medium (UX/dead ends).**

---

## 6. What is *missing* from the system

- A **role registry**: no `src/lib/roles.ts`; the vocabulary lives in 53 arrays.
- A **role → permission preset**: no defaults applied when a role is chosen.
- **Rank enforcement**: no "can this actor act on that target?" rank check.
- A **role × surface matrix test**: nothing asserts that the two pickers agree.
- **Finance/Audit** nav for Accountant (a role whose name promises exactly that).
- Any **Co-Owner** differentiation from General Manager in nav (identical 17 rows).

---

## 7. Recommended solution

### 7.1 One source of truth: `src/lib/roles.ts`

A single, pure, client-safe registry (same pattern as the existing `permissions.ts`, which
already proves the approach works for the two sensitive surfaces):

```ts
export type RoleKey =
  | "OWNER" | "CO_OWNER" | "GENERAL_MANAGER" | "BRANCH_MANAGER"
  | "SUPERVISOR" | "ACCOUNTANT" | "WORKER" | "FARM_ADVISOR";

export interface RoleDef {
  key: RoleKey;
  label: string;            // ONE label — "Worker (Sales Person)", "Branch staff" retired
  rank: 0 | 1 | 2 | 3 | 4;  // for rank enforcement (revives ROLE_LEVEL)
  category: "ORG_EXEC" | "UNIT_LEAD" | "SHOP_FLOOR" | "UNIT_SPECIALIST" | "EXTERNAL";
  scope: "ORG" | "ORG_OR_UNITS" | "UNIT" | "ADVISOR_GRANT";
  requiresUnit: boolean;    // WORKER/BM/SUP/ACCT true; exec + advisor false
  assignableBy: "NONE" | "OWNER" | "OWNER_OR_DELEGATE";
  grantsOnCreate: Partial<Record<CapabilityKey, boolean>>;  // the preset
  navRows: string[] | "*";  // or derived from category
}
```

Everything currently duplicated is derived from it:

| Today (duplicated) | After |
|---|---|
| 2 hard-coded `<option>` lists | `roleOptionsFor(actor)` |
| 3 label maps | `roleLabel(role)` |
| `navCtx()` 4 role checks | `category` + `isExecutiveRole()` |
| `ROLE_LEVEL` (dead) | `rank` + `canActOn(actor, target)` |
| 53 authorization arrays | `inRoleGroup("MONEY_WATCHER")` named groups |
| zero role validation | `isRoleKey()` at the top of every create/edit |

### 7.2 The reconciled role set (8 roles — no additions, no removals)

I recommend keeping all eight tokens and fixing the *surface* coverage rather than inventing
or deleting roles:

| Role | Assignable by | Unit required | Available in |
|---|---|---|---|
| Owner | — (never creatable) | — | (excluded from pickers, filterable) |
| Co-Owner | OWNER | optional | **both pickers** |
| General Manager | OWNER | optional | both |
| Branch Manager | OWNER **or** delegate | **yes** | both |
| Supervisor | OWNER | **yes** | **both pickers** |
| Accountant | OWNER | **yes** | **both pickers** |
| Worker | OWNER **or** delegate | **yes** | both |
| Farm Advisor | OWNER | **no** (grants instead) | **both pickers** |

So **every role becomes selectable in both places**, with the *actor's* authority — not the
screen — deciding which options appear (`OWNER` sees 7, a delegate sees BM/Worker, matching
today's server rules exactly).

`Farm Advisor` stays in both pickers; its special two-step onboarding (account → unit grants
with expiry) then works from either screen. *If you would rather make "external advisor" a
distinct account type rather than a role, that is decision D1 in §9.*

### 7.3 Role presets (fixes F3)

One `<RolePermissionsEditor>` component, used by **all three** creation surfaces, rendering
the same 14 capabilities, seeded from `grantsOnCreate`:

| Role | Preset on create |
|---|---|
| Co-Owner / General Manager | export ✔, records management ✔, expenses ✔, inventory ✔, online ✔, branch ✔, support ✔, auditors ✔, **finance ✔**, users ❌ (OWNER stays the only one who delegates user management by default) |
| Branch Manager | export ✔, stock ✔, expenses ✔, records ✔; finance ❌, CCTV ❌, branch ❌ |
| Supervisor | stock ✔, expenses ✔; export ❌ (request path) |
| Accountant | export ✔, expenses ✔, **finance ✔** (scoped) |
| Worker | sales ✔; everything else ❌ |
| Farm Advisor | everything ❌ (already forced by the API) |

Picking a role applies its preset; the OWNER can then override any single toggle (today's
behaviour, preserved). The OWNER-only sensitive grants remain OWNER-only — no change to the
security model you set in Task 2.

### 7.4 Server-side enforcement (fixes F2)

1. Reject unknown roles at the top of `POST`/`PATCH`: `if (!isRoleKey(role)) 400`.
2. Re-derive `assignableBy` server-side from the registry instead of the current
   per-branch `if` chains (behaviour preserved, one rule).
3. Revive `rank` for `canActOn(actor, target)` and use it to replace the hand-written
   "may not edit yourself / an executive" checks.
4. Keep every existing gate intact — this is a **refactor to one rule set, not a loosening**.
   Tenant isolation, the two sensitive surfaces and the OWNER-only grants are unchanged.

### 7.5 Navigation (fixes F7, F8)

Derive nav from `category`:

- **ORG_EXEC** (CO_OWNER, GM) — today's 17 rows.
- **UNIT_LEAD** (BRANCH_MANAGER) — today's 5 rows.
- **UNIT_SPECIALIST** (SUPERVISOR, ACCOUNTANT) — **new**, see D2.
- **SHOP_FLOOR** (WORKER) — Action Center + `WorkerDashboard`.
- **EXTERNAL** (FARM_ADVISOR) — Advisor Console sandbox (unchanged).

### 7.6 Housekeeping

- Retire the phantom strings (`MANAGER`, `ADMIN`, `SUPER_ADMIN`) → named role groups + the
  `isSuperAdmin` boolean (F4).
- Delete dead `ROLE_LEVEL` (F6).
- Generate the "Filter by Role" dropdown from the registry and render labels via
  `roleLabel()` (F5).
- Make the branch field required client-side for unit-scoped roles and hide options the actor
  cannot mint, so no picker offers a 403/400 (F10).
- Fix `canOpenBusiness` to consult the registry's `scope` rather than a role denylist (F9).

### 7.7 Tests

A new `dev-tooling/verify-roles-matrix.mjs` suite asserting, for each of the 8 roles × 3
creation surfaces: the options match `assignableBy`; the preset applied equals the registry;
the server accepts exactly the assignable set and 400s everything else (including `BANANA`);
and the nav row set equals §4.1. Plus a screenshot pair per surface as evidence.

---

## 8. Effort & risk

| Phase | Work | Risk |
|---|---|---|
| 1 | `src/lib/roles.ts` + role validation on POST/PATCH + matrix test | **low** — additive, no UI change |
| 2 | Both pickers + filter + labels from the registry | low |
| 3 | Shared `<RolePermissionsEditor>` + presets | medium — touches the two sensitive surfaces, covered by the existing 99/0 notification and 211 enterprise suites |
| 4 | Nav from `category`; define Supervisor/Accountant workspaces | medium — depends on D2 |
| 5 | Retire phantom roles; rank enforcement; housekeeping | low |

Nothing here changes tenant isolation or the OWNER-only grants; phase 1 alone removes the
`BANANA`-role hole and the picker mismatch.

---

## 9. Decisions I need before implementing

- **D1 — Farm Advisor: still a *role*, or promoted to a distinct *account type*** (external,
  non-staff)? My recommendation: **keep it a role** (fewer changes, the read-only sandbox is
  already enforced server-side), but list it in both pickers under an "External" heading so it
  is never mistaken for staff.
- **D2 — Supervisor / Accountant workspace.** Options: **(a)** give them a real unit workspace —
  the module tabs for their unit plus attendance review; **(b)** merge them into Worker with
  extra flags; **(c)** keep them as "assignment-only" like Auditor and remove them from the
  pickers. My recommendation: **(a)** — it matches their existing server rights and their names.
- **D3 — Accountant + Finance & Reports.** Should the Accountant preset include `canViewFinance`
  by default (scoped to their units)? My recommendation: **yes**, with the OWNER able to revoke.
- **D4 — Co-Owner differentiation.** Today Co-Owner and General Manager are indistinguishable
  in nav (both 17 rows) yet `users.role === "CO_OWNER"` unlocks delegated user management.
  Should Co-Owner also get Audit + Enterprise Users by default? My recommendation: **no change**
  — keep both behind explicit OWNER grants, as Task 2 established.
- **D5 — Delegate scope.** Should a `canManageUsers` delegate be able to create Supervisor and
  Accountant (not just Branch Manager/Worker)? My recommendation: **no** — keep delegates to
  BM/Worker, matching today's server rule.

Once you confirm D1–D5 (or tell me to use the recommended answers), I will implement in the
phase order above, benchmark and regression-test each phase, and report before/after.
