# Notifications & alerts — who gets told what, and why

_Owner's brief, task 3: “make sure the relevant people are told about important new
activity — sales, transactions, expenses, stock, approvals, audit events, supervisor
notes — without duplicating or spamming the bell.” This is the map of that system:
the rules, the audiences, the guards against noise, and how to change any of it._

---

## 1 · The one rule behind the bell

Everything lands in **one** table (`notifications`) and rings the bell through **one**
path (`pushAfterBell`, which also fans out phone/laptop push after the notification
row exists — push never arrives without a bell row to open).

Every activity notification therefore has to answer four questions:

| Question | Where it is answered |
|---|---|
| **Who cares?** | the *recipient* rule of the producer (see the matrix) |
| **What exactly happened?** | `title` + `body`, plain language, with the actor named |
| **How do I stop it repeating?** | a `record-ref` dedupe key + the producer's own rules |
| **Where do I click to fix it?** | `recordType` / `recordId` / `recordRef` → `urlForNotification` + `onOpenRecord` |

### The audience is resolved once, never re-derived

The bell answers *"who is this business for?"* through exactly one function —
**`workspaceAudience(businessId)`** in `src/lib/bellAudience.ts`. That is the **same**
question the sidebar, the dashboards, the export button and every API scope gate ask, and
it is answered by the same function they use: `accessibleBusinessIds()`.

A user reaches business **B** when they hold any of:

| Route | Meaning |
|---|---|
| `assigned_business_id` | the unit they were given |
| **`business_manage_ids`** | **a unit the Owner delegated to them** |
| `user_business_access` grants | a per-branch grant |
| platform **Super Admin** | *every* business — their workspace is platform-wide |

intersected with the tenant rule: you reach **B** only if **B** is in your organization
**and** you are entitled to it. `FARM_ADVISOR` is admitted **only** through a live,
unexpired `advisor_assignments` row — never by organization membership.

> **Why the change.** Until this module existed, five producers each hand-rolled their own
> copy of this rule — `orderNotificationRecipients`, `auditEscalationRecipients`,
> `moneyActivityRecipients`, `unitActivityRecipients` and `notifyAuditEvent`. All five
> omitted `business_manage_ids`, so a manager the Owner had delegated a unit could **open**
> that unit in the sidebar and get **no** bell for it. All five required
> `organization_members` membership, so a platform **Super Admin** — whose workspace is
> every business by definition — had a platform-wide scope and a structurally empty bell.
> Full diagnosis and evidence: `docs/FINAL-AUDIT-BELL-NOTIFICATIONS.md`.

`orgRecipientUserIds(orgId)` — the projection of user ids off `organization_members` —
**now lives in `bellAudience.ts` too**, so exactly one module in the app reads that
table. It unions two sources:

1. the `organization_members` rows — the authoritative membership, written by
   organization provisioning; and
2. **`organizations.owner_user_id`** — the tenant's own record of who owns it.

Source 2 exists because source 1 is a *table that only provisioning fills*. An OWNER
account that predates multi-tenancy, or an organization whose membership backfill was
never run, has **no row in `organization_members` at all**. Unioning the recorded owner
can only ever *add that organization's OWNER*; it can never add a stranger, and a stale
id simply drops out because callers select from `users`.

`dev-tooling/verify-money-notify-coverage.mjs` fails the build if any new module starts
reading `organization_members` on its own.

### Self-execution: the bell is a ledger for owners, not an echo for everyone

Producers drop the actor so people are not pinged for their own keystrokes. They use
**`withoutSelf(list, actorUserId)`**, which is *owner-aware*: it drops the actor **except**
when the actor is an OWNER, CO_OWNER or Super Admin.

An Owner's bell is the complete record of their workspace. Telling the Owner "you didn't
see this because you were the one who did it" is the gap this fixes — and it also means an
Owner reading their audit trail sees their own actions in it. Every other role keeps the
quiet: a branch manager who records a sale still gets no self-notification.

## 2 · The activity matrix

| Activity | Notification | Recipients | Dedupe key | Click lands on |
|---|---|---|---|---|
| Sale recorded (Sales Center, direct ledger income, module sales) | `SALE_RECORDED` — “Today's sales: N · GH₵ total” | **finance-authorized** watchers: OWNER · CO_OWNER/GM **with** `canViewFinance` who can reach the unit | `money-day:<biz>:SALE:<day>` — **one row per unit per day**, updated in place | the unit's dashboard tab (else Command Center) |
| Sale recorded — *amount-free notice* | `SALE_RECORDED` — “Sales recorded — POULTRY-01 — N today” | **unit leads without the finance grant** (BRANCH_MANAGER / MANAGER / SUPERVISOR assigned to, delegated for, or granted the unit) | `ops-money-day:<biz>:SALE:<day>` — one row per unit per day | the unit's dashboard tab (else Transactions) |
| Expense recorded (expense writer, approval-gated or not) | `EXPENSE_RECORDED` — same two audiences and rules | as above | `money-day:<biz>:EXPENSE:<day>` · `ops-money-day:…` | the unit's dashboard tab |
| **Credit money received** — opening deposit *or* a later installment | `SALE_RECORDED` — same two audiences | as above | same day roll-up key | the unit's dashboard tab |
| **Payroll paid** — a run an officer approved and paid | `EXPENSE_RECORDED` — same two audiences | as above | same day roll-up key | the unit's dashboard tab |
| Credit money received **through the approval gate** | — | the approver is told by `APPROVAL_REQUESTED`; the OWNER's roll-up moves when the gate clears | — | — |
| Stock crosses into low / out | `STOCK_LOW` / `STOCK_OUT` | the unit's operational staff (`orderNotificationRecipients`) | `stock-alert:<item>[:v<variant>]:<day>`; **crossings only** — a lingering low state is silent | Inventory (unit tab when known) |
| Low stock → stock-out escalation | the same row is **upgraded** to `STOCK_OUT`, HIGH, unread again | as above | same ref — no duplicate row | Inventory |
| Stock digest sweep (end of day) | existing `LOW_STOCK` digest | unit + owner recipients | `low-stock:<unit>:<day>` | Inventory |
| Record deleted (transactions, suppliers, customers, inventory, approved deletions) | `AUDIT_EVENT` — “Record deleted: …” HIGH | OWNER · CO_OWNER (never the deleter) | `audit-event:DELETE:<type>:<id-or-label>` | Audit Trail |
| Permission / credential change (export, finance, users, records, expenses, CCTV, auditor delegation, password reset) | `AUDIT_EVENT` — “Permission change: …” | OWNER · CO_OWNER | `audit-event:PERMISSION_CHANGE…` | Audit Trail |
| Money / staff record **edited** (e.g. an employee's salary) | `AUDIT_EVENT` — “Record edited: …” | OWNER · CO_OWNER | `audit-event:UPDATE:<type>:<id>` | Audit Trail |
| Approval requested (expense, PO, requisition, discount, inventory adjustment, customer deletion) | `APPROVAL_REQUESTED` HIGH | the entitled approvers for that policy | `approval:<id>` | Action Center |
| Approval decided | `APPROVAL_DECIDED` | the requester | `approval:<id>:<decision>` | Action Center |
| Supervisor / daily note read as WATCH or URGENT | `OPS_NOTE_FLAGGED` — HIGH when URGENT | unit managers; the OWNER too on URGENT | `ops-note:<id>` | the unit's dashboard (Daily Notes) |
| Routine (INFO) daily note | — | nobody: it stays a log | — | — |

Everything else that already existed (online orders, purchases, tasks, checklists,
audit issues, advisor notes, tracking, dunning, poultry stage transitions, platform
requests) keeps its own producer and is unchanged.

## 3 · The guards against noise

1. **Daily roll-up, not a stream.** Money never notifies per transaction. The day's
   row is *updated* — count and total grow — and only the first event pushes.
2. **Crossings, not states.** Stock alerts fire when an item *falls* through its
   reorder point (or to zero), never on every movement of an already-low item.
   Escalation LOW → OUT updates the same row (HIGH, unread) instead of adding one.
3. **The sweep defers.** If a crossing already alerted an item today, the end-of-day
   low-stock sweep skips it (`stockAlertedToday`).
4. **The actor is never notified about their own action** — every producer filters
   `actorUserId`.
5. **Caps.** `AUDIT_EVENT` is capped at 12 per recipient per 24 h, so a bulk
   operation cannot bury the bell; the trail still records every row.
6. **Two audiences, no double money.** Finance-authorized users get the figures;
   unit leads get an amount-free notice. Nobody gets both (the second audience
   excludes anyone carrying the finance grant).
7. **Per-person switch.** The six categories in *Notification settings*
   (Orders · Approvals · Alerts · Tasks · Messages · Reports) gate **push**;
   `SALE_RECORDED`/`EXPENSE_RECORDED` → Reports, stock & notes → Alerts,
   `AUDIT_EVENT` → Approvals.

## 4 · What was silently broken (and is fixed)

| Gap found | Fix |
|---|---|
| Sales/expenses recorded through the ledger, Sales Center, modules or the expense writer notified **nobody** | `notifyMoneyActivity` wired into `postSale`, `servicePosting`, `expensePosting` and `POST /api/transactions` |
| Stock movements notified **nobody** | `notifyStockThresholdCrossing` wired into `applyStockChange` and `applyVariantDelta` |
| `auditLog()` wrote the trail and notified **nobody** | `auditEvent()` is now the single audit writer (trail + high-signal bell); deletes, permission changes and money/staff edits ring |
| Money-record deletions wrote only the deletion log | `notifyRecordDeletion` on the transaction, enterprise and approved-customer delete paths |
| Permission flips (export, finance, users, records…) were **not on the trail at all** | `/api/users` PATCH now writes one `PERMISSION_CHANGE` row naming each flipped power |
| The universal record editor (`/api/enterprise` PATCH) changed values with **no trail and no notice** | one `UPDATE` audit row naming the changed fields |
| Flagged daily notes reached **nobody** | `notifyOpsNoteFlagged` on WATCH/URGENT |
| An item that went low in the morning and sold out at night was **never escalated** | the day's row is upgraded to `STOCK_OUT` |
| Bell rows carried no click-through target | every new row sets `recordType`/`recordId`/`recordRef`; the bell resolves them to the right workspace |
| **Credit receipts** (opening deposits *and* later installments) wrote a real INCOME row straight to the ledger, telling nobody | `postInstallment()` calls `notifyCreditPayment()` — fire-and-forget, so a notification failure can never roll back the receipt |
| **Payroll runs** wrote the staff-cost EXPENSE row to the ledger, telling nobody — and the officer who paid it could not be the recipient | `postPayrollTransaction()` emits `notifyMoneyActivity({ kind: "EXPENSE" })`, still fire-and-forget and still self-excluding |
| **An OWNER with no `organization_members` row** was unreachable by *every* fan-out — money, orders, purchases, transport, audit — because each one derived its audience from that table alone | one `orgRecipientUserIds()` resolver unions `organizations.owner_user_id`; money, unit, audit, approver and transport audiences all route through it |
| ON_CREDIT invoice payments looked like an expense bypass | `/api/procurement` `PAYMENT_RECORD` already delegates to `postOrGateExpenseTransaction()`, so the shared notifier covers it — and the static guard now proves it by inspection |
| **Five producers each re-derived "who is this business for?"** — and every copy omitted `business_manage_ids` and platform Super Admins, so a manage-delegated manager could *open* a unit and get no bell for it, and a platform Super Admin had an empty bell | one canonical resolver, `workspaceAudience()` in `src/lib/bellAudience.ts`, mirroring `accessibleBusinessIds()`; all five producers rebuilt on it |
| **Every producer subtracted the actor**, so the OWNER who recorded a sale themselves never got a row for it | `withoutSelf()` — owner-aware: the actor is dropped *unless* they are an OWNER, CO_OWNER or Super Admin. Other roles keep their quiet |
| **The Action Center told only the assignee**, so the Owner who raised the work saw nothing until they opened the task itself | `createTask()` notifies the assignee *and* every workspace principal (`Action raised: …`); completion does the same (`TASK_COMPLETED`) |
| **An Owner's own audit trail omitted their own actions** | `notifyAuditEvent()` resolves principals via `workspacePrincipals()` and no longer self-excludes the Owner; `auditEscalationRecipients()` gives principals precedence over `excludeIds` |
| **The audit bell's rate cap silently discarded rows** — at 12 AUDIT_EVENT rows per recipient per 24 h, everything beyond was dropped without a trace, so an Owner whose budget was full could never learn a record had been deleted | `notifyAuditEvent` now counts what it held back and writes **one** running summary row per recipient per day (`audit-event:cap:<day>`), so a capped recipient always knows there is more to read in the trail |
| **The tenant-isolation check flagged legitimate Super Admin delivery** as a leak — a false positive that would have masked a real one | the predicate now states the entitlement explicitly (org member ∪ recorded org owner ∪ platform Super Admin), and a companion check covers the unmigrated-tenant recovery |

## 5 · How to change it

- **Add a notification for a new activity** — call the matching producer from
  `src/lib/notifyActivity.ts` (`notifyMoneyActivity`, `notifyStockThresholdCrossing`,
  `notifyAuditEvent` / `notifyRecordDeletion`, `notifyOpsNoteFlagged`) at the point
  the record is written. If the activity is a brand-new **type**, declare it ONCE in
  **`src/lib/bellTypes.ts`** (label, push category, destination tab, whether the unit
  dashboard wins, severity) — the push URL, the bell's chip and the click destination
  all derive from that one row. Add the type to `ACTIVITY_NOTIFICATION_TYPES` so the
  UI's activity counters pick it up. The build fails if a type is emitted but not
  registered.
- **Change what the Action Center tells people** — `TASK_EVENTS` in
  `src/lib/actionCenter.ts` is the single transition table: each event declares its
  type, its recipients (assignee / creator / workspace principals) and its copy. Every
  Action Center notification — raised, started, done, cancelled, reopened, overdue —
  goes through `notifyTaskTransition()`. Do not add an ad-hoc fan-out beside it.
- **Never build a second routing table.** `bellTypes.ts` is the only place a type is
  mapped to a label, a category or a destination.
- **Never build a second audience rule.** `bellAudience.ts` answers "whose workspace is
  this business"; producers layer only *policy* (role group, finance visibility) on top.
- **Change who hears about money** — `moneyActivityRecipients` (figures, gated by
  `canSeeFinancials`) and `unitActivityRecipients` (amount-free leads) in
  `src/lib/notifyActivity.ts`. Audience is always resolved from the database, never
  from a request body.
- **Never derive an audience directly.** Call `workspaceAudience(businessId)`
  (or `workspacePrincipals`) from `src/lib/bellAudience.ts`, then filter. Reading
  `organization_members` yourself is what made an unmigrated OWNER invisible, and
  hand-rolling the reachability test is what made delegated managers and platform
  Super Admins invisible; `verify-money-notify-coverage.mjs` fails if a new module
  does either.
- **Adding a money writer** — it must call `postSale` / `postServiceSale` /
  `postOrGateExpenseTransaction`, or notify itself. The same guard fails if it
  writes an INCOME/EXPENSE row and reaches none of them.
- **Change the high-signal audit list** — `AUDIT_EVENT_ACTIONS` (verbs),
  `AUDIT_EVENT_EDIT_TARGETS` (records whose edits alert) and `AUDIT_EVENT_SKIP`
  (login/view/export/print noise), plus `AUDIT_EVENT_DAILY_CAP`, all at the foot of
  `src/lib/notifyActivity.ts`.
- **Change stock sensitivity** — the crossing rule reads `min_stock_threshold` on the
  item; there is nothing else to tune.

## 6 · Verifying it

```bash
bash dev-tooling/run-suite.sh dev-tooling/verify-notify-activity.mjs
```

100 checks, 0 failures, self-cleaning (it creates its own units/staff and removes
every fixture, ledger row, receipt, tracking, note and notification it wrote).
It covers, live: money roll-up counting and totals, actor exclusion, the two money
audiences, stock crossing / no-repeat / escalation, flagged vs routine notes,
approvals requested and decided, deletion and salary-edit alerts reaching a
*different* user, the audit cap, link fields, unread counts, mark-all scoping,
account-deletion hygiene and duplicate-free rows.

### The Owner-bell guard

The Owner's requirement — *activity in my My Workspace must reach my bell, whoever
performed it* — gets its own suite, because it is the one behaviour every other suite
takes for granted:

```bash
bash dev-tooling/run-suite.sh dev-tooling/verify-owner-bell.mjs
```

**27 checks, 0 failures**, driving the real HTTP API and reading real bell rows:
the Owner's own sale and expense; a control that other users' activity still arrives; a
**manage-delegated** manager receiving both the money *and* the stock families; a platform
**Super Admin** outside the tenant's membership; the **Action Center** reaching the Owner
both when an action is raised and when it closes; the boundary — a non-principal is
*still* spared their own action while the Owner, who did not do it, still hears about it;
and **tenant isolation** plus one roll-up row per `(user, type, day, unit)`. Full
diagnosis in `docs/FINAL-AUDIT-BELL-NOTIFICATIONS.md`.

### The two money guards

A **behavioural** suite proves the contract end to end, live, across the writers
that matter (Sales Center, the ledger, credit deposits + installments, car wash,
online-order payment, and a delegated payroll officer), asserting that the money
reaches the ledger *and* that the Owner's daily figure actually moves:

```bash
bash dev-tooling/run-suite.sh dev-tooling/verify-revenue-notifications.mjs
```

It also builds a **synthetic tenant whose OWNER deliberately has no
`organization_members` row** and proves that Owner still gets the roll-up — while
a *second* organization's Owner gets nothing at all, which is the tenant-isolation
half of that same fix. **77 checks, 0 failures**, self-cleaning: sections D and E
let the app create its own customer rows, so the cleanup is a name-stamped sweep
(`TEST %` / `TEST-`) as well as an id list — otherwise the suite leaves
customers behind and poisons the next suite's census check.

Tenant isolation gets its own **data-driven** suite. It derives every
expectation from the database instead of hard-coding unit counts (older suites
that assert "org 2 owns exactly one unit" go red the moment another fixture
legitimately adds a unit, which says nothing about leaking data):

```bash
bash dev-tooling/run-suite.sh dev-tooling/verify-tenant-isolation.mjs
```

**16 checks, 0 failures**: every business belongs to exactly one organization;
no owner lens returns another organization's units; every business-scoped audit
row is attributed to exactly one scope; a forged owner+unit pair answers empty;
no bell row about a business was delivered outside that business's organization
(entitlement = organization member ∪ the organization owner recorded for that
business ∪ a platform Super Admin, whose workspace is every business by
definition); an organization OWNER still missing its membership row is recovered
by the recorded owner; and the bell endpoint is user-scoped (disjoint rows, 401
without a session).

A **static** guard needs no server and closes the whole class of defect rather
than the instances it happens to know about — any module that writes an
INCOME/EXPENSE ledger row must reach a notifier, every shared posting engine must
still notify, every bell audience must go through `orgRecipientUserIds`, and no
rule may re-clamp `.recharts-wrapper`:

```bash
node dev-tooling/verify-money-notify-coverage.mjs
```

**14 checks, 0 failures** — including the bell-audience contract: it fails if any
module that computes an audience (`…Recipients`, `resolveApprovers`) reads
`organization_members` itself instead of going through `orgRecipientUserIds`.

For the visual side — the bell row, its chip, and where a click actually lands —
run the small evidence tool (it records one probe sale, screenshots the bell and
the landing view, then removes everything it wrote):

```bash
bash dev-tooling/run-suite.sh dev-tooling/notify-ui-evidence.mjs
```

Last verified: the OWNER's bell showed **“Today's sales: 1 · GH₵ 480.00”** with the
**Sales Activity** chip and the actor (“Emmanuel Osei · just now”), and clicking it
marked the row read and opened the **Mina Akuafo Poultry Farm** unit workspace —
the unit the sale was recorded in. Screenshots: `/home/user/shot-notif-bell.png`,
`/home/user/shot-notif-clicked.png`.

---

## 7 · The registry and the transition table

Two declarations now govern how a notification behaves, and everything else derives
from them.

### `src/lib/bellTypes.ts` — what a notification IS

| Field | Drives |
|---|---|
| `label` | the chip shown on the bell row |
| `category` | which user-facing push toggle governs it |
| `tab` | where a tap lands when no unit branch is known |
| `unitScoped` | whether a known `branchCode` wins over `tab` |
| `severity` | the triage chip |

This replaced four parallel lookup tables (push URL, bell chip, in-app click, push
toggle) plus hardcoded `url:` overrides inside producers. Before it: **18 of 42** types
opened Customer Order & Tracking from a push, and **12** rendered as a generic
"Open Record". An unregistered type now falls back to the Command Center, never to an
unrelated console.

### `src/lib/actionCenter.ts` — who an Action Center event reaches

| Event | Recipients |
|---|---|
| raised | assignee + workspace principals |
| started | assignee + creator + principals |
| done | assignee + creator + principals |
| cancelled | assignee + creator + principals |
| reopened | assignee + creator + principals |
| overdue | assignee + principals |

Workspace principals are **added, never subtracted** — including when they are the actor
or the assignee. That single decision is what closes the case where an action raised
without an assignee (the assignee defaults to the creator) reached nobody at all.

Every row's `recordRef` names the **event** (`task:<id>:<event>`), identically for every
recipient, so a recipient can never receive two rows for one event.

`dev-tooling/verify-money-notify-coverage.mjs` (43 checks) fails the build if a type is
unregistered, if a producer hardcodes a destination, if a second audience rule appears,
or if a transition is added without a declaration.

---

## 8 · The actor is the session, never the payload

**The rule: the identity of whoever performed a request is a property of the
connection, not of the request body.** Any field named `createdBy*`, `actor*`,
`currentUser*`, `recordedBy*`, `approvedBy*`, `grantedBy*`, `deletedBy*`,
`submittedBy*`, `handledBy*` or `publishedBy*` that arrives in a request body is
**ignored**.

This is not stylistic. Before the rule existed, 17 routes read the acting user
from the body and wrote it straight into the ledger, the invoice issuer, the
account-provisioning record, the audit trail and the bell's own `actorName`. A
branch manager could post a sale attributed to the Owner — and, worse, *delete a
required field* and the record would still say the Owner did it, so the forgery
was not even visible as an omission.

### How to write a route that persists attribution

```ts
import { actorFrom } from "@/lib/auth";

export async function POST(request: NextRequest) {
  const __authSession = await getSessionInfo(request);
  if (!__authSession) return UNAUTHENTICATED();

  const actor = actorFrom(__authSession);   // ← the ONLY source of identity
  if (!actor) return UNAUTHENTICATED();

  const body = await request.json();       // ← note: NOT destructured of identity
  const { businessId, cartItems } = body;

  await postSale({ businessId, lines: cartItems, actor });
}
```

`actorFrom()` returns the session user row itself, so every capability flag
(`canRecordExpenses`, `isSuperAdmin`, …) travels with it and downstream
permission gates are unaffected.

### Module-level helpers have no session

A helper declared outside the request handler cannot reach `__authSession`. Take
the actor as an explicit argument instead of reading it from the payload — see
`applyPurchaseReceipt(purchase, data, biz, actor)` in `api/hardware` and
`bookExpense(…, actor)` in `api/restaurant`.

### The two exceptions

| Route | Why it may be sessionless |
|---|---|
| `api/order` | Customer-facing order intake. Writes `createdByName: customerName`, `createdByUserId: null`, `createdByRole: "CUSTOMER"` — the customer placing their own order. There is no staff identity on the request to spoof. |

### Guards

| Suite | Checks |
|---|---|
| `dev-tooling/verify-actor-attribution.mjs` | Static. Self-tests its own detector against a synthetic vulnerable route, then proves all **89** routes source no identity from a body, every attribution writer resolves a session first, and no component sends an identity claim. |
| `dev-tooling/verify-actor-spoof-live.mjs` | Live. Performs the real exploit as a `BRANCH_MANAGER` claiming to be the `OWNER`, then reads the database to confirm the ledger, the invoice issuer, the account provisioner and the audit trail all record the session user. |

**Run both before shipping any change that touches attribution.**
