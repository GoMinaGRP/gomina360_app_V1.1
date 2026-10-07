# Roles & Permissions Reconciliation — Implementation Report

**Task:** implement the recommendations in `docs/ROLES-AND-PERMISSIONS-AUDIT.md` (including decisions
D1–D5) so that user creation, role selection, access, navigation, capabilities and workspaces are
reconciled against **one source of truth** across the whole platform — without weakening tenant
isolation or removing any legitimate access.

**Status:** implemented, built, deployed to the live preview and verified. **~1,000 automated
assertions across 13 suites pass; 0 fail.** Every role now has at least one real account and every
creation path was exercised end to end.

---

## 1. What was built — the one source of truth

### 1.1 `src/lib/roles.ts` (NEW — 556 lines)

The single registry the whole app asks about roles and capabilities. Client-safe (no DB/server
imports), so the sidebar, the pickers, the editors and the API routes all read the same table.

| Export | What it answers |
|---|---|
| `ROLES` / `RoleDef` | the 8 real roles — `key`, `label`, `shortLabel`, `blurb`, `rank` (0–4), `category`, `scope`, `requiresUnit`, `forbidsUnit`, `assignableBy`, `section`, `preset` |
| `CAPABILITIES` | the 14 capability columns with `label`, `hint`, `ownerOnly`, `sensitive`, `roles`, and the canonical `perm-*` test id |
| `ROLE_GROUPS` | `EXECUTIVE`, `MONEY_WATCHER`, `UNIT_LEAD`, `UNIT_ADMIN`, `CHECKLIST_MANAGER`, `POLICY`, `ATTENDANCE_REVIEW`, `CLOCK_IN`, `DELEGATE_ELIGIBLE` |
| `ROLE_LEVEL` (**deleted**) | dead map, replaced by `roleRank()` + `canActOnRole()` |
| `normaliseRole()` | case-insensitive role token handling (`"worker"` → `WORKER`) |
| `canAssignRole(actor, role)` | who may mint which role (OWNER / OWNER-or-delegate / never) |
| `canActOnRole(actorRole, targetRole)` | the rank guard — nobody administers a superior |
| `roleOptionsFor(actor)` | the exact role list **this** actor may offer, for every picker |
| `rolePreset(role)` / `isPresetModified()` | what a role means by default, and whether a form diverged from it |
| `roleCategory` · `roleShortLabel` · `roleLabel` · `isOrgexecRole` · `isExternalRole` · `inRoleGroup` · `isDelegateUserManager` | the small predicates that replaced hand-written role literals |

**The final role table:**

| Role | Category | Scope | Needs a unit | Assignable by | Default preset |
|---|---|---|---|---|---|
| **Owner** | ORG_EXEC | ORG | no | *never* (provisioning only) | all (owner holds everything) |
| **Co-Owner** | ORG_EXEC | ORG_OR_UNITS | no | OWNER | record expenses, export, storefront, units, support info, auditor delegation |
| **General Manager** | ORG_EXEC | ORG_OR_UNITS | no | OWNER | same as Co-Owner |
| **Branch Manager** | UNIT_LEAD | UNIT | **yes** | OWNER or delegate | record expenses, manage stock, export |
| **Supervisor** | UNIT_SPECIALIST | UNIT | **yes** | OWNER | record expenses, manage stock |
| **Accountant** | UNIT_SPECIALIST | UNIT | **yes** | OWNER | record expenses, export, **Finance & Reports** (revocable) |
| **Worker (Sales Person)** | SHOP_FLOOR | UNIT | **yes** | OWNER or delegate | record sales |
| **Farm Advisor (external, read-only)** | EXTERNAL | ADVISOR_GRANT | **forbidden** | OWNER | *none — read-only by construction* |

Presets never carry a destructive record power (`canManageRecords`, `canDeleteInventory`,
`canManageExpenses`, `canManageUsers`, `canManageCctv`) and never carry the staff directory: those
remain explicit OWNER grants the OWNER sees as toggles on the same screen. The two approved
exceptions are recorded in the audit's D-list: **D3** (Accountant ⇒ Finance) and the executive
surfaces (storefront, units, support info, auditor delegation).

### 1.2 `src/components/RolePermissionsEditor.tsx` (NEW)

The **one** capability editor used by every create/edit surface. It renders the role blurb, the
role's applicable capability toggles (same canonical `perm-*` test ids everywhere), an
"edited from the *&lt;role&gt;* preset" hint, the read-only note for external advisors, and hides
OWNER-only capabilities from delegates. `isOwner` is optional and defaults to the safe value.

### 1.3 Surfaces migrated onto it (the F1/F3 fix)

| Surface | Before | After |
|---|---|---|
| Enterprise Users → **Register New Account** | 4 hand-written checkboxes | registry picker (staff + **External** group) + shared editor |
| Enterprise Users → **Edit** | 4 hand-written checkboxes, role select with 4 fixed options | registry picker (always lists the row's current role) + shared editor |
| Enterprise Users → **role filter** | 6 options (Co-Owner/Accountant/Supervisor unfilterable) | every registry role |
| Users & Access console → create / edit | 14 booleans, local `ROLES` + label map | one `caps` record seeded by `rolePreset`, shared editor |
| Branch Manager → **Manage Sales Persons** → create / edit | 3 bespoke checkboxes ("Initial Permissions") | shared editor (same presets, same test ids) |

### 1.4 Server-side enforcement (`/api/users`, `/api/users/workers`)

* **Role validation** — an unknown token is a **400** (`Unknown role "BANANA". Pick a role from the list.`), not a silent passthrough that fell through to the duplicate-email check.
* **Normalisation** — `"worker"`, `" Worker "` are accepted and stored canonically.
* **Assignment authority** — `canAssignRole`; the delegate path now uses the registry's `OWNER_OR_DELEGATE` flag instead of a literal pair.
* **Rank guard** — `canActOnRole`; nobody may administer a peer or superior.
* **OWNER-only capabilities** — derived from `CAPABILITIES.filter(c => c.ownerOnly)`, so a new capability can never be smuggled past a delegate by forgetting a hand-written comparison.
* **Unit rules** — `requiresUnit` roles are a 400 without a unit (this now also covers Supervisor/Accountant, and a role *change* onto such a role); `forbidsUnit` (Farm Advisor) is a 400 *with* one. An assigned unit must reference a real business (400 otherwise).
* **Preset on role change** — moving an account onto a role applies that role's preset to any capability the caller did not send explicitly, and an OWNER-only capability can only ride a preset when the OWNER is the one saving.
* **The last unvalidated writer** — `/api/users/workers` now inserts `role: WORKER_ROLE_KEY` (typed `RoleKey`) and takes its defaults from `rolePreset("WORKER")`.

### 1.5 Navigation, workspaces and landing (findings F4, F7, F8, F9)

* `navCtx()` is derived from the registry (`roleCategory`, `isOrgexecRole`, `inRoleGroup`) instead of hand-written role lists; `NavCtx` gained `roleCategory`, `isUnitLead`, `isUnitSpecialist`, `isShopFloor`, `isUnitScoped`, `canReviewAttendance`.
* **New workspace for Supervisor & Accountant (D2):** their rail now carries the unit register (**Branch Sales & Payments**), **Branch Assets**, **Manage Sales Persons** (attendance review), **Customer Order & Tracking** and the Action Center — 5 rows, up from 1. With the Finance grant (the Accountant preset) the rail adds **Transactions & MoMo** and **Finance & Reports**, and the module guard now admits a unit-scoped finance holder to the unit ledger.
* **Landing tab is registry-owned** (`defaultTabFor`): executives → Command Center, unit bench → their unit register, advisor → Advisor Console, shop floor → its own dashboard. A Supervisor no longer signs in on executive HQ to read "Access Restricted".
* `canOpenBusiness()` — the old **deny-list** ("anything that is not BM/Worker sees everything") is now an **allow-list** driven by the registry `scope`: unknown role ⇒ only explicitly granted units (finding F9 closed).
* The action-center/orders rows are role-aware; the Sales Center chip now names the caller's real role ("SUPERVISOR • SALES CENTER").
* **Sidebar** derives its executive/worker/advisor/BM flags from the registry (a Co-Owner's rail previously treated them as a non-executive).

### 1.6 Phantom roles retired (finding F4) and labels unified (F5)

`MANAGER` / `ADMIN` / `SUPER_ADMIN` were never database roles and matched nobody. All of them are
gone from authorisation logic, replaced by groups:

| Site | Was | Now |
|---|---|---|
| `api/transport`, `TransportModule` | `["OWNER","GENERAL_MANAGER","BRANCH_MANAGER","MANAGER","SUPER_ADMIN","ADMIN"]` | `EXECUTIVE ∪ UNIT_LEAD` |
| `lib/notify` | `…,"MANAGER"` manager bench | `UNIT_LEAD` |
| `lib/notifyActivity` | `MONEY_WATCHER` / `UNIT_LEAD` literal lists ("MANAGER") | `ROLE_GROUPS` |
| `api/tasks` | `["OWNER","GENERAL_MANAGER"]` (a Co-Owner's board silently omitted org rows) | `EXECUTIVE` |
| `api/approvals` | two literal `["OWNER","GENERAL_MANAGER"]` gates | `POLICY` |
| `api/attendance` | `role === "OWNER" \|\| …` + a 4-role list | `ATTENDANCE_REVIEW` |
| `api/budgets`, `users`, `advisor-notes`, `documents`, `daily-notes`, `checklists`, `assistant`, `poultry`, `customer-interactions`, `staff-access`, `advisor`, `users/workers` | competing literal lists | `ROLE_GROUPS` / `inRoleGroup` |

**Labels:** three competing maps and raw enums are gone. The registry's single label source now
feeds the Enterprise Users badge (uppercase `FARM ADVISOR`, previously "Farm Advisor (external,
read-only)" inside a chips row), the Users & Access list badge (previously the raw enum
`BRANCH_MANAGER`), and the customer tracking timeline — which keeps its deliberate customer-facing
wording ("Branch staff") through `customerFacingRoleName()`.

### 1.7 User creation surfaces reconciled (finding F10)

Both pickers now come from `roleOptionsFor(actor)` and therefore **cannot disagree**: the
Enterprise register offers CO_OWNER, GENERAL_MANAGER, BRANCH_MANAGER, SUPERVISOR, ACCOUNTANT,
WORKER + an **External** group for FARM_ADVISOR. Dead ends removed:
* a unit-required role preselects the first unit and shows "must be assigned to a branch" instead of offering "None (HQ / Executive)";
* switching to Farm Advisor clears any preselected unit (and the payload never sends one);
* the roster's **Users & Access** button uses the same `canSeeEnterpriseUsers` gate as the destination (the raw delegate flag previously kept the OWNER out of their own staff directory).

### 1.8 Adjacent defects fixed while in the area

* **Invalid image ⇒ 400, oversized ⇒ 413.** `mediaValidation` now returns a `reason` and the profile route answers with the honest status (a non-image reported as "413 Payload Too Large" told the client the wrong story).
* **`verify-enterprise-permissions` fixture** created unit-scoped roles without a unit (blind spot that would have masked the new rule).

---

## 2. Permissions verification per role

### 2.1 Navigation — what each role can actually open (computed by the app's own `navCtx`+`navEntriesFor`)

| Role | Rows | Destinations |
|---|---|---|
| **Owner** | 22 | Command Center · Action Center · Sales & Payments · Orders & Fulfilment · Tracking · Pre-Orders · Customers · Finance · Transactions · Inventory · Suppliers · Employees · Assets · BI Assistant · AI Advisor · Scenario Planning · Audit · Documents · Farm Advisors · **Users & Access** · Support · Integrations · *(Platform Owners — Super Admin flag)* |
| **Co-Owner** | 18 | as Owner minus Support, Users & Access, Platform Owners, Audit |
| **General Manager** | 18 | same bench (Support / Users & Access / Audit only with the OWNER's grant) |
| **Branch Manager** | 5 | Branch Sales & Payments · Action Center · Branch Assets · Tracking · Manage Sales Persons |
| **Supervisor** *(was 1)* | 5 | same unit bench as the Branch Manager |
| **Accountant** *(was 1)* | 5 → **7** with the Finance grant | unit bench **+ Transactions & MoMo + Finance & Reports** |
| **Worker** | 1 | Action Center (the self-contained sales workspace) |
| **Farm Advisor** | 1 | Advisor Console (read-only) |

### 2.2 Live API matrix (each role signs in and is probed — suite section E)

| Role | `/api/init` | staff directory | audit trail | approvals | transactions |
|---|---|---|---|---|---|
| Owner | 200 | 200 | 200 | 200 | 200 |
| Owner-authorised GM | 200 | 200 | 200 | 200 | 200 |
| Co-Owner (ungranted) | 200 | **403** | 200 | 200 | 200 |
| Branch Manager | 200 | **403** | 200 | 200 | 200 |
| Supervisor | 200 | **403** | **403** | 200 | 200 |
| Accountant | 200 | **403** | **403** | 200 | 200 |
| Worker | 200 | **403** | **403** | **403** | **403** |
| Farm Advisor | 200 | **403** | **403** | **403** | **403** |
| Anonymous | 401 | 401 | 401 | 401 | 401 |

Financial figures: only the Owner, an explicitly-authorised GM and the Accountant (D3, unit-scoped)
receive live money/salary/asset numbers; every other staff role and an ungranted executive receive
none — proven by the `verify-enterprise-permissions` payload sweep (200 assertions).

### 2.3 Creation & escalation rules proven live

| Probe | Result |
|---|---|
| `POST /api/users` role=`BANANA` | **400** (pre-fix: fell through to the duplicate-email 409) |
| `POST /api/users` role=`MANAGER` (phantom) | 400 |
| `POST /api/users` role=`""` | 400 |
| `POST /api/users` role=`OWNER` | 403 (an organisation has one Owner) |
| `POST /api/users` role=`worker` | 200, stored as `WORKER` |
| Worker / Supervisor / Accountant / Branch Manager without a unit | 400 each |
| Farm Advisor **with** a unit | 400 |
| Unknown business id | 400 |
| Delegate BM → Supervisor / Co-Owner | 403 / 403 |
| Delegate BM → Worker in its own unit | 200, without any OWNER-only flag attached |
| Delegate BM granting Finance to anyone | 403 |
| Role change onto a unit role with the unit cleared | 400 |
| Role change WORKER → SUPERVISOR with a unit | 200, supervisor preset applied (stock + expenses on, sales off) |
| Role change out of / back to Farm Advisor | 200 / 200, unit cleared |
| Self-escalation (every role trying to become Owner / Super Admin / finance-holder) | refused for every role, no row changed |
| Cross-tenant PATCH/DELETE by org-A roles | refused for every victim id |
| Staff directory for any non-authorised role | empty **and** 403 |

**Live accounts by role after the run:** ACCOUNTANT 1 · BRANCH_MANAGER 7 · CO_OWNER 1 ·
FARM_ADVISOR 1 · GENERAL_MANAGER 1 · OWNER 1 · SUPERVISOR 1 · WORKER 9 — one or more per role, and
**no unknown role value exists in the `users` table**.

### 2.4 Per-role UI walkthrough (real login form, fresh browser context per role)

Every role signs in through the actual login screen, lands on a reachable surface, renders with
**zero page/console errors**, never sees the "Access Restricted" wall on landing, and never reaches
the Platform Owners console (that surface follows the Super Admin *flag* — in this estate the Owner
holds it, and every other role is refused). Evidence: `docs/evidence/roles-walkthrough-<role>.png`.

---

## 3. Test results — all suites, final run

| Suite | Result | What it covers |
|---|---|---|
| **`dev-tooling/verify-roles-matrix.mts`** (NEW) | **101 / 101** | registry invariants · per-role navigation · live API matrix · account per role · role-change presets · tenant isolation |
| **`dev-tooling/audit/roles-perrole-walkthrough.mjs`** (NEW) | **42 / 42** | every role through the real login form + screenshots |
| `dev-tooling/verify-enterprise-permissions.mjs` | **200 / 200** | enterprise-users / money surfaces, escalation, cross-tenant |
| `dev-tooling/verify-nav.mjs` | **71 / 71** | sidebar, palette, no duplicate destinations/test ids, grantee behaviour |
| `dev-tooling/verify-staff-access.mjs` | **44 / 44** | staff console authorisation + photo security |
| `dev-tooling/verify-farm-advisor.mjs` | **192 / 192** | advisor sandbox + one-flow onboarding through the UI |
| `dev-tooling/phase0-authz-matrix.mjs` | **63 / 63** | route-by-route authorisation |
| `dev-tooling/verify-attendance.mjs` | **31 / 31** | clock-in / review / GPS integrity |
| `dev-tooling/verify-notifications.mjs` | **43 / 43** | bell + audit notifications, OS push |
| `dev-tooling/verify-bm-dashboard-access.mjs` | **19 / 19** | branch dashboard scoping |
| `dev-tooling/audit-atoz.mjs` | **39 / 39** | full A→Z business + staff lifecycle |
| `dev-tooling/verify-az-app-audit.mjs` | **41 / 41** | order lifecycle & app audit |
| `dev-tooling/audit-security.mjs` | **23 / 23 clean** | injection / XSS / secret-leak sweep |
| `dev-tooling/audit-deadlinks.mjs` | **clean** | dead links, 4xx/5xx assets, page errors |

**Suites repaired as part of the change** (they encoded the pre-reconciliation model or had real
blind spots): `verify-enterprise-permissions` (unitless unit-role fixtures; D3 finance model;
grant-baselined escalation), `verify-nav` (manage-grantee fixture was an Accountant — now a Branch
Manager so "money needs its own grant" is actually tested), `verify-staff-access` (profile-photo
status codes), `audit-atoz` (F3 must expand "Show all N units" before looking).

---

## 4. Findings from the audit — closure status

| # | Finding | Status |
|---|---|---|
| **F1** | Two creation pickers diverge | **closed** — both read `roleOptionsFor()`; verified side by side (`roles-picker-*.png`) |
| **F2** | No server-side role validation | **closed** — 400 for unknown/phantom/empty role, proven live |
| **F3** | No presets; toggles not role-scoped | **closed** — presets everywhere; same editor on 5 surfaces |
| **F4** | Phantom `MANAGER`/`ADMIN`/`SUPER_ADMIN` gates | **closed** — 14 sites moved to `ROLE_GROUPS` |
| **F5** | Three label maps + raw enums | **closed** — one label source, badges render registry labels |
| **F6** | Dead `ROLE_LEVEL` map | **closed** — deleted; `roleRank`/`canActOnRole` |
| **F7** | Supervisor/Accountant have no workspace | **closed (D2)** — real unit workspace + ledger |
| **F8** | Navigation by string compare | **closed** — `navCtx` is registry-derived |
| **F9** | `canOpenBusiness` true for any unlisted role | **closed** — fail-closed allow-list |
| **F10** | Pickers offer 400/403 dead ends | **closed** — unit preselection, hints, External grouping |

---

## 5. Evidence files

* `docs/evidence/roles-picker-enterprise-create.png` — Enterprise register: registry role list (External group) + shared capability editor
* `docs/evidence/roles-picker-console-create.png` — Users & Access: the identical list and editor for the same actor
* `docs/evidence/roles-picker-enterprise-edit.png` — edit modal on the same registry
* `docs/evidence/roles-walkthrough-<role>.png` — the landing surface for each of the 8 roles (OWNER, CO_OWNER, GENERAL_MANAGER, BRANCH_MANAGER, SUPERVISOR, ACCOUNTANT, WORKER, FARM_ADVISOR)
* `/home/user/roles-walkthrough.json` — the raw per-role walkthrough capture

## 6. Notes for operating the new model

* **To add a role:** add one `RoleDef` to `ROLES` in `src/lib/roles.ts`. Pickers, navigation, editors, presets and validation follow automatically; no other file needs editing.
* **To add a capability:** add one `CapabilityDef` (with its `perm-*` test id) — every editor surface picks it up, and OWNER-only enforcement, delegate limits and the audit comparisons follow.
* **Test accounts** created for the walkthrough (`co-owner.e2e@`, `supervisor.e2e@`, `accountant.e2e@`, `farm-advisor.e2e@gomina360.com`, password `Role@GoMina26`) are left in place deliberately so each role stays testable; delete them from Users & Access when the demo estate should be cleaned.
