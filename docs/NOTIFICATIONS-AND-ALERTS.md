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

## 2 · The activity matrix

| Activity | Notification | Recipients | Dedupe key | Click lands on |
|---|---|---|---|---|
| Sale recorded (Sales Center, direct ledger income, module sales) | `SALE_RECORDED` — “Today's sales: N · GH₵ total” | **finance-authorized** watchers: OWNER · CO_OWNER/GM **with** `canViewFinance` who can reach the unit | `money-day:<biz>:SALE:<day>` — **one row per unit per day**, updated in place | the unit's dashboard tab (else Command Center) |
| Sale recorded — *amount-free notice* | `SALE_RECORDED` — “Sales recorded — POULTRY-01 — N today” | **unit leads without the finance grant** (BRANCH_MANAGER / MANAGER / SUPERVISOR assigned to, delegated for, or granted the unit) | `ops-money-day:<biz>:SALE:<day>` — one row per unit per day | the unit's dashboard tab (else Transactions) |
| Expense recorded (expense writer, approval-gated or not) | `EXPENSE_RECORDED` — same two audiences and rules | as above | `money-day:<biz>:EXPENSE:<day>` · `ops-money-day:…` | the unit's dashboard tab |
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

## 5 · How to change it

- **Add a notification for a new activity** — call the matching producer from
  `src/lib/notifyActivity.ts` (`notifyMoneyActivity`, `notifyStockThresholdCrossing`,
  `notifyAuditEvent` / `notifyRecordDeletion`, `notifyOpsNoteFlagged`) at the point
  the record is written. If the activity is a brand-new family, add its type to
  `ACTIVITY_NOTIFICATION_TYPES`, to `TYPE_CATEGORY` and `urlForNotification` in
  `src/lib/push.ts`, and to the bell's label map in `src/components/NotificationBell.tsx`.
- **Change who hears about money** — `moneyActivityRecipients` (figures, gated by
  `canSeeFinancials`) and `unitActivityRecipients` (amount-free leads) in
  `src/lib/notifyActivity.ts`. Audience is always resolved from the database, never
  from a request body.
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

94 checks, 0 failures, self-cleaning (it creates its own units/staff and removes
every fixture, ledger row, receipt, tracking, note and notification it wrote).
It covers, live: money roll-up counting and totals, actor exclusion, the two money
audiences, stock crossing / no-repeat / escalation, flagged vs routine notes,
approvals requested and decided, deletion and salary-edit alerts reaching a
*different* user, the audit cap, link fields, unread counts, mark-all scoping,
account-deletion hygiene and duplicate-free rows.

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
