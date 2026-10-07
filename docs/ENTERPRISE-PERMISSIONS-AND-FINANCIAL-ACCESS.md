# Enterprise Users, Financial Access & Tenant Isolation — GoMina 360

**Audience:** the OWNER (and the platform Super Admin acting on the OWNER's behalf).
**What this covers:** who may open **Enterprise Users**, who may see **money**, how
to authorise and revoke both, and the guarantees that stop one owner's people,
workers, businesses or accounts ever appearing in another owner's workspace.

Related reading: `docs/PLATFORM-INFORMATION-GUIDE.md` (Help/Contact + registration),
`docs/PLATFORM-HELP-REGISTRATION-IMPLEMENTATION.md` (the registration audit).

---

## 1. The two sensitive surfaces

Two things are **never implied by a role**, not even the General Manager role.
They open only through an explicit authorisation the OWNER issues:

| Sensitive surface | What it exposes | Who may open it |
|---|---|---|
| **Enterprise Users** | The staff directory and the access console: every colleague's profile, role, branch, permission switches and status | The **OWNER**, the platform **Super Admin**, and staff the OWNER authorised (`users.canManageUsers`) |
| **Financial figures** | The **Central Financial Report** (Finance & Reports), the Command Center P&L (revenue, expenses, net profit, ROI, cash flow, asset/inventory valuation), budgets & budget-vs-actual, the cash-flow forecast, payroll, **employee salaries** and **money exports** (Command Center, Sales & Payments, Financial Transactions, payroll/budget/cash-flow modules) | The **OWNER**, the platform **Super Admin**, and staff the OWNER authorised (`users.canViewFinance`) |

Everything else — sales recording, stock, customers, suppliers, assets, checklists,
attendance, audit, documents — stays role-scoped exactly as before.

> **Why:** a General Manager runs operations; they are not an owner. A brand-new
> manager account therefore starts with **neither** surface, and the OWNER decides
> whether to hand either one over.

---

## 2. Role × surface matrix

| Role | Enterprise Users | Financial figures | Notes |
|---|---|---|---|
| **OWNER** | ✅ always | ✅ always | Owns the workspace; can grant/revoke both |
| **Super Admin** | ✅ always | ✅ always | The platform operator account |
| **CO_OWNER** | ⛔ unless granted | ⛔ unless granted | Executive operational command, no money by default |
| **GENERAL_MANAGER** | ⛔ unless granted | ⛔ unless granted | Operational command of every unit |
| **BRANCH_MANAGER** | ⛔ unless granted | ⛔ unless granted | Own branch only when granted |
| **SUPERVISOR** | ⛔ | ⛔ | |
| **ACCOUNTANT** | ⛔ | ⛔ unless granted | Grant *Finance & Reports* to let them work |
| **WORKER** | ⛔ | ⛔ | Sees only their own branch workspace and their own transactions |
| **FARM_ADVISOR** | ⛔ | ⛔ | Read-only farm monitoring through advisor assignments |

A granted **non-executive** (a branch manager or accountant) reaches only the
surface they were granted — never the rest of the executive modules:

* *Enterprise Users* grant → the staff directory, scoped to the units they manage.
* *Finance & Reports* grant → the Finance & Reports console, scoped to their units.

Three further rules are worth remembering because they apply even to people the
OWNER has delegated unit management to:

1. **Exports follow the surface.** The Export Center's `canExportData` switch
   decides *whether* somebody may export; the module decides *what* may leave.
   Money modules need *Finance & Reports*; the *Enterprise Users* directory needs
   *Enterprise Users*. Without the finance grant, a delegated unit manager may
   still export **one** unit's books — that unit only, never the group report.
2. **Salaries are money, rosters are not.** Employees, attendance, schedules and
   documents stay operational for a branch manager or worker; the salary figure
   and the payroll net aggregate are withheld (`financialsRestricted`) and only a
   *Finance & Reports* holder can read or change them.
3. **Approvals are gated like the request.** Nobody can approve, reject or
   complete an export of a surface they cannot open themselves — a grant is
   required to sign off on money leaving the building.

---

## 3. How to authorise (and revoke) — step by step

1. Sign in as the **OWNER** (`kwame.owner@gomina360.com` by default).
2. Open the **Command Center** → **Users & Access** button (top right), or
   **Enterprise Users** in the sidebar → *Users & Access*.
3. Find the person and click **Permissions** (the edit pencil).
4. Flip the switch you want:

   | Switch | Grants |
   |---|---|
   | 🔒 **Finance & Reports — CENTRAL FINANCIAL REPORT** (revenue, profit, cash flow, ROI, budgets, forecasts & payroll) | the whole financial surface, scoped to that person's units |
   | 🔒 **Enterprise Users — open the staff directory & access console** | the staff directory, scoped to that person's units |

5. **Save.** The change takes effect on the person's **existing session**
   immediately — no re-login, and the sidebar row appears on their next refresh.
6. To **revoke**, flip the switch off and save. The row disappears and every gated
   endpoint answers `403` again at once.

Both switches are OWNER-only: a granted manager can manage workers and branch
managers inside their scope, but can never hand these two powers to anybody —
including themselves.

### What the authorised person experiences

* The sidebar gains **Finance & Reports** (money group) and/or **Enterprise Users**
  (administration group).
* The **Command Center** stops masking the KPI scorecards and shows live figures.
* The **Payroll Center** button appears in *Employees & Payroll*.

### What an unauthorised person sees

* No such sidebar rows; deep links render **Access Restricted**, not data.
* The **Command Center** keeps running but shows a locked placeholder (`•••••`)
  and an amber notice: *"Financial figures are restricted to the OWNER and users
  the OWNER has authorised…"*. Operational indicators (risk score, checklist
  compliance, stock counts, sales counts) stay live.
* The network payload itself contains no figures — the money is removed on the
  server, not merely hidden in the browser.

---

## 4. Tenant isolation — the rule that never bends

> A new account never sees another owner's users, workers, businesses,
> transactions or accounts unless explicitly authorised.

| Check | Guarantee |
|---|---|
| Staff directory (`GET /api/users`) | Only own-organisation members for an organisation OWNER; a granted manager sees only the units they manage; everyone else gets `403` |
| Bootstrap payload (`/api/init`) | Businesses, users, customers, transactions, ledgers and logs are filtered to the caller's organisation **and** business scope |
| Second organisation | Its OWNER sees only its own people and units; organisation-1 accounts are refused for them in both directions |
| Cross-tenant writes | `PATCH`/`DELETE /api/users` for a user in another organisation are refused before any field is touched, for every role |
| Self-escalation | No role can promote itself to OWNER, set its own grants, or flip `isSuperAdmin` |
| The OWNER account | Cannot be demoted, deactivated or deleted by anybody but the OWNER |
| The platform Super Admin | Untouchable from inside an organisation |

The platform Super Admin (the console operator) deliberately keeps a
platform-wide directory — that is the platform-owner capability. Every *other*
account is organisation-scoped, which the verification suite proves role by role.

---

## 5. What was wrong before this change

| # | Defect found | Fix |
|---|---|---|
| 1 | **Enterprise Users was role-gated only** — every General Manager automatically saw the whole organisation directory | The surface now requires `canManageUsers`; the GM role alone no longer opens it |
| 2 | **`canManageUsers` did not work** — the OWNER's grant was accepted by the API but the sidebar row and the tab guard still refused entrance | The grant is now the single source of truth on the sidebar, the tab gate and the API. Granted managers reach the directory; the button on the Command Center appears too |
| 3 | **Financial data shipped to everybody** — `/api/init` sent revenue, expenses, net profit, ROI, cash flow, asset/inventory valuation, salaries and asset prices to every role except the Farm Advisor | The payload is trimmed server-side: unauthorised viewers get zeroed metrics (flagged `financialsRestricted`), no salaries, no asset valuation |
| 4 | **Manage-Unit grant opened Finance** — a branch manager with "Manage Business / Unit" could open the Central Financial Report without the finance grant | Finance was removed from the Manage-Unit bundle; it needs its own authorisation |
| 5 | **The client rebuilt the P&L from the ledger** — the Command Center recomputed revenue from transactions even when metrics were withheld, and stamped the figure into a DOM attribute | The derivation is gated by the same authorisation; unauthorised viewers get zeros, masked cells and no DOM figure |
| 6 | **Money endpoints were coarse** — budgets and the cash-flow forecast blocked only `WORKER`, so any manager could read them; payroll was readable by any worker in the branch | All three now require the finance authorisation on top of business scope; payroll writes additionally require record-management (OWNER-granted) |
| 7 | **Worker ledger over-exposure** — `/api/transactions` returned the whole branch ledger to a worker (the UI filtered it client-side) | The server now returns a worker only their **own** recorded transactions |
| 8 | **`CO_OWNER` was not a recognised role** — absent from the role-level map, the delegated-manager list and the console's role picker | Added as an executive-level role (no money, no directory by default) with full grant support |
| 9 | **The Export Center authorised the act, not the module** — `canExportData` let a Branch Manager request the Command Center P&L, the enterprise ledger or the **Enterprise Users directory**; the audit row was written as COMPLETED | `/api/exports` now classifies the module: money modules need `canViewFinance` (or that one unit's delegated manager), the directory needs `canManageUsers`; approval / completion of such a record is gated the same way |
| 10 | **`canExportData` was read as `=== false`** — a NULL/absent toggle counted as a grant on the server while the UI treated it as a refusal | Only an explicit `true` opens an export; a claimed unit scope is also checked against real access |
| 11 | **`/api/employees` handed salaries back** — the roster, the payroll net aggregate and the salary figure were returned to any user with branch access, although `/api/init` deliberately strips salary for non-authorised viewers | The route now agrees with the model: the roster stays (name, role, schedule, contacts, documents), `salaryGhs` and `payrollNet` are withheld and flagged `financialsRestricted`; a record-manager without the finance grant may edit the roster but cannot read or change the salary |

Also fixed while verifying: an audit suite (`audit-notify-verify`) left an
APPROVED-not-COMPLETED expense behind, which drifted the budget-vs-actual
expectation; it now cleans up after itself, and the budget suite counts only
COMPLETED actuals exactly like the product does.

---

## 6. Verification

`dev-tooling/verify-enterprise-permissions.mjs` — run with the app on `:3000`:

```bash
bash dev-tooling/run-suite.sh dev-tooling/verify-enterprise-permissions.mjs
```

It provisions a real account for every relevant role (CO_OWNER, GENERAL_MANAGER,
BRANCH_MANAGER, SUPERVISOR, ACCOUNTANT, WORKER, FARM_ADVISOR), a second
organisation with its own owner, then proves — **211 assertions** across nine
sections:

* **A** Enterprise Users authorisation per role, plus the no-foreign-accounts rule
* **B** No financial figure, salary or asset valuation in any unauthorised payload
* **C** Budgets, cash-flow forecast and payroll gated per role, with denial payloads leaking nothing
* **C2** Employee salaries: the roster stays operational for every role while the figure and the payroll net aggregate are withheld from unauthorised viewers, and a non-finance manager cannot read or change a salary
* **D** Tenant isolation: a second organisation provisioned live; cross-tenant `PATCH`/`DELETE` refused for every role; the second owner sees only their own people
* **E** Authorisation lifecycle: locked → OWNER grants → access on the same session → OWNER revokes → locked again
* **F** Self-escalation and role-tampering refused for every role; the OWNER account untouchable
* **G** Command Center masking contract (prop, wrapper, notice, zeroed chart data) and the sidebar/tab gates
* **Z** Self-cleanup: every fixture removed, demo state byte-checked

The Export Center has its own suite — `dev-tooling/verify-export-center.mjs`
(**77 assertions**):

```bash
bash dev-tooling/run-suite.sh dev-tooling/verify-export-center.mjs
```

* **A** Module authorisation: owner/granted GM export money and directory; a
  freshly created GM or CO_OWNER is refused the money modules but keeps
  operational ones; a Branch Manager with `canExportData` gets branch modules
  and is refused Command Center, Sales Center, the ledger and the directory; a
  NULL toggle is not a grant; a delegated manager may export **one** unit's
  books but never the enterprise-wide report
* **B** Decisions: an unauthorised viewer cannot approve, reject or complete a
  sensitive export record
* **C** Real files: the UI really writes a PDF, CSV and XLSX to disk (signature
  checked, audit row COMPLETED)
* **D** Worker flow: request → PENDING (no file) → OWNER approval → **Download
  Approved** delivers the file and completes the record
* **E** An unauthorised viewer sees the restriction notice where the generate
  button would be
* **Z** Cleanup: fixtures, export rows and the export toggle returned to baseline

> A note for anyone debugging downloads: an incognito Chromium context
> (`browser.createBrowserContext()`) receives nothing unless
> `Browser.setDownloadBehavior` is called **with** its `browserContextId`. The
> earlier "the Export Center downloads nothing" report was that probe artifact,
> not a product defect — section C pins the real behaviour.

The suite is self-healing — it purges any residue from an interrupted run before
it starts, so it can never drift another suite's counts.

Regression battery re-run green after the change: `verify-platform-registration`
**89/89**, `multiowner-verify` **118/118**, `verify-storefront-help` **47/47**,
`verify-permissions-storefront` **48/48**, `verify-staff-access-grouping` **27/27**,
`audit-notify-verify` **13/13**, `phase0-authz-matrix` **63/63**,
`verify-nav` **71/71**, `verify-farm-advisor` **192/192**,
`verify-finance-allproducts-fresh` **49/49**, `verify-budgets-cashflow` **26/26**,
`verify-bm-dashboard-access` **19/19**, `verify-business-manage` **24/24**,
`verify-manage-unit` **24/24**, `verify-employees` **46/46**,
`verify-payroll2` **52/52**, `verify-expense-permissions` **42/42**.

Evidence: `/home/user/shot-perms-cc-restricted.png` (an unauthorised manager's
Command Center — masked KPI cards, amber notice, no Finance/Users rows),
`/home/user/shot-perms-cc-authorized.png` (the same account after the OWNER's
authorisation), `/home/user/shot-perms-ent-users.png` (the authorised manager's
Enterprise Users console).

---

## 7. Operations quick reference

| I want to… | Do this |
|---|---|
| Give a manager the staff directory | Enterprise Users → *Users & Access* → **Permissions** → 🔒 **Enterprise Users** → Save |
| Give an accountant/manager the money reports | same place → 🔒 **Finance & Reports — CENTRAL FINANCIAL REPORT** → Save |
| Take either away | same toggle → off → Save (effective immediately) |
| Check who currently holds either power | Enterprise Users → the **PERMS** column, or filter by role; the switches are visible on every account |
| See money myself as the OWNER | Command Center (always live) and **Finance & Reports** |
| Understand why a manager only sees `•••••` | that account lacks the finance authorisation — grant it, or leave it operational-only |
| Audit the grants | every grant/revoke writes an audit row through `/api/users` (`USER_UPDATE`) with the acting OWNER |
| Let a branch manager export their **own branch** records | Enterprise Users → **Permissions** → *Data export* (`canExportData`) → Save. Customers, branch sales, roster, stock and assets follow; money modules and the directory still refuse |
| Give somebody the group's financial exports | grant 🔒 **Finance & Reports** — it opens the export modules as well as the reports |
| Hide salaries from a manager while leaving the roster editable | no action needed: without 🔒 **Finance & Reports** the roster stays operational and the salary is `Restricted` |

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| A General Manager sees **no** *Enterprise Users* row | Working as designed — the surface needs an explicit grant | Grant 🔒 **Enterprise Users** |
| A manager sees `•••••` instead of revenue and a "restricted" notice | No finance authorisation | Grant 🔒 **Finance & Reports** |
| A granted user still sees the old view | Browser cache holding the previous bootstrap | Refresh once — the server sends the trimmed/complete payload per authorisation and the cache key includes the grants |
| A worker's ledger looks short | The worker now receives only their **own** transactions | Expected; managers see the whole branch |
| Payroll refuses a branch manager | Payroll needs the finance authorisation **and** the OWNER's record-management grant | Grant both |
| The "*Access Restricted*" panel appears after a deep link | The account lacks that surface | Grant it, or navigate back to Command Center |
| The Export Center shows a red *restricted* notice instead of a generate button | The current module is a money module (Command Center, Sales Center, ledger, payroll/budget) or the directory, and the account lacks that surface | Grant 🔒 **Finance & Reports** (or **Enterprise Users**), or export an operational module |
| A branch manager's export is refused with a money message | `canExportData` is about *whether*, the module is about *what*: Command Center / Sales Center / ledger exports need the finance grant, or a unit delegation for that one unit | Grant 🔒 **Finance & Reports**, or delegate the unit in *Manage Business / Unit* |
| Salary shows `Restricted` in an employee profile | The viewer has no 🔒 **Finance & Reports** grant — by design | Grant it if they should see payroll money |
