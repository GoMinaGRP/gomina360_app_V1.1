# AUDIT — Bell Notification System, GoMina 360

**Date:** 2026-10-09 · **Type:** audit only — **no product code was changed**
**Scope:** every event-driven bell notification, with two questions asked of all of it:

1. Do important business activities — including Action Center items and actions requiring
   attention — reach the appropriate authorized users?
2. Does activity inside an Owner/Super Admin's **My Workspace** reach *that* person's bell,
   regardless of which authorized user performed it — without leaking across owners?

**Method:** static enumeration of all 18 notification write sites and all routing maps,
plus live probes against the running app (`dev-tooling/audit-bell-surface.mjs`, read-only
apart from the fixtures it creates and removes).

---

## Headline

The **audience** half of the brief is solved and holding: isolation is clean, there are no
cross-organization leaks, no orphan rows and no duplicates in the live table, and an
Owner's workspace activity reaches their bell whoever performed it.

The **delivery contract** half is not. Fourteen defects remain, concentrated in three
places nobody has audited as a system: the Action Center's state machine, the routing maps,
and one producer that was never migrated to the canonical audience resolver.

| Severity | Count | IDs |
|---|---|---|
| **High** | 3 | F‑01, F‑02, F‑03 |
| **Medium** | 6 | F‑04 … F‑09 |
| **Low** | 5 | F‑10 … F‑14 |

---

## Findings

### F‑01 · HIGH · Transport events bypass the canonical audience resolver

`notifyTransport()` (`src/lib/transport.ts:209`) is the **only remaining producer** that
still derives its audience from `orgRecipientUserIds(orgId)` — organization membership —
instead of `workspaceAudience(businessId)`. Its filter is a hand-written role list
(`OWNER || GENERAL_MANAGER || (BRANCH_MANAGER && assignedBusinessId === businessId)`).

**Proven.** A platform Super Admin with no `organization_members` row, calling
`notifyTransport(1, { type: "TRANSPORT_UNAUTHORIZED_MOVEMENT", … })`:

```
notifyTransport inserted = { inserted: 3 } → recipients [2, 1, 3]
probe super admin notified? NO  ← platform Super Admin is blind to transport events
```

The same run shows the unit's own workers are dropped too:
`notifyTransport audience [1,2,3]` vs `workspaceAudience [1,2,3,10,11]` → **missed [10,11]**.

**Impact.** This is the user's headline requirement, failing in one producer: the one role
whose My Workspace is *every* business is blind to geofence violations, tracker-offline
and unauthorized-movement events. `CO_OWNER` and `SUPERVISOR` are also excluded, and a
manage-delegated manager whose `assignedBusinessId` points elsewhere is excluded.

**Root cause.** It was written before the canonical resolver existed and was never migrated.
`verify-money-notify-coverage.mjs` catches hand-rolled audiences only for the *money*
producers, so this one passed under the guard's blind spot.

---

### F‑02 · HIGH · An action raised with no explicit assignee notifies nobody

`POST /api/tasks` defaults `assignedUserId` to the caller (`route.ts:216`). `createTask()`
then suppresses the assignee notification when assignee == creator
(`actionCenter.ts:196`), and the principals loop skips any principal who *is* the assignee
(`actionCenter.ts:218`). The two subtractions cancel out.

**Proven.** `POST /api/tasks { title, businessId, priority, dueDate }` with no assignee →
**0 bell rows for any user**, including the Owner.

**Impact.** A task requiring attention exists, appears in the Action Center, and no one is
ever told. Because the default path is the "create a task for yourself" button, this is the
common case, not an edge case.

**Root cause.** Self-exclusion applied as a subtraction at two layers instead of one
audience decision.

---

### F‑03 · HIGH · Cancelling an action notifies nobody

The completion-notification block in `PATCH /api/tasks` fires only on `nextStatus === "DONE"`.
`CANCELLED` is an accepted terminal status (`normTaskStatus`, `route.ts:365`) and falls
through to a silent update.

**Proven.** Assignee holds an action → a manager cancels it → the assignee's bell is
unchanged.

**Impact.** Someone can be actively working on an action that has been cancelled. They keep
the work up, and the Action Center keeps showing it as open to them.

**Root cause.** Notification logic is attached to one status transition instead of to the
state machine.

---

### F‑04 · MEDIUM‑HIGH · Reopening a completed action notifies nobody

Same block: `DONE → OPEN` produces no row. The Owner who commissioned the work, and the
assignee, learn nothing.

**Root cause.** Identical to F‑03.

---

### F‑05 · MEDIUM · Overdue escalation double-notifies when the assignee is a principal

`escalateOverdueTasks()` notifies the assignee under `task-overdue:<id>:<step>` and then
notifies watchers under `task-overdue:<id>:<step>:watch`, excluding the assignee via
`excludeIds`. Since principals are deliberately exempt from `excludeIds` (so an Owner is
always escalated to), an Owner who assigns an overdue action **to themselves** receives
both.

**Proven.**
```
❌ …but not twice — 2 rows: task-overdue:4:w1396 | task-overdue:4:w1396:watch
```

**Impact.** Two unread badge counts, two lines, one event. The `:watch` suffix exists only
to defeat the dedupe key, which means the dedupe key identifies the *recipient's role*
rather than the *event*.

**Root cause.** The record-ref is not event-identity. Same class as F‑11.

---

### F‑06 · MEDIUM · 18 of 42 notification types open the wrong screen from a push

`urlForNotification()` (`src/lib/push.ts:65`) ends in `return "/?tab=TRACKING"` as its
catch-all. Enumerating every type the app emits:

| Lands on the catch-all | Should open |
|---|---|
| `CREDIT_OVERDUE` | Credit / Dunning |
| `DOCUMENT_EXPIRY` | Compliance / Documents |
| `CHECKLIST_OVERDUE`, `POULTRY_STAGE` | Checklists |
| `PURCHASE_RECORDED`, `PURCHASE_RECEIVED` | Procurement |
| `FEED_*`, `FISH_FEED_*`, `BLOCK_MIX_*` | Feed mill / Block factory |
| `OPS_NOTE_FLAGGED`, `PREORDER_MILESTONE`, `TRANSPORT_*` | their own modules |

(20 of 42 hit the catch-all string; `ONLINE_ORDER_RECEIVED` and `ORDER_TRACKING_STATUS` do
so legitimately.)

**Impact.** The **in-app bell click is correct** — `onOpenRecord` in `GoMinaApp.tsx:1816`
is a far more complete router and handles all of these. The **push** URL does not. So the
same event takes the user to two different screens depending on whether they tap the
banner or the bell row.

---

### F‑07 · MEDIUM · Transport pushes deep-link to the Audit tab

`notifyTransport` overrides the push payload with a hardcoded `url: "/?tab=AUDIT"`
(`transport.ts:266`). A `TRANSPORT_UNAUTHORIZED_MOVEMENT` or `TRANSPORT_TRACKER_OFFLINE`
push opens the Audit console — neither the Transport Log nor Tracking.

**Impact.** The highest-severity transport events (possible theft) land the user on a page
that has nothing to do with them.

---

### F‑08 · MEDIUM · Audit-issue responses notify only the reviewer

`PATCH /api/audit/issues` inserts exactly one row, addressed to `row.reviewerUserId`
(`issues/route.ts:154`). There is no principal fallback.

**Impact.** When the reviewer is a non-principal, is deactivated, or simply does not act,
a HIGH/CRITICAL issue awaiting verification never reaches the Owner — even though the Owner's
bell is meant to be the accountable record. The sibling route `api/audit/route.ts` does
escalate; the issue-workflow route does not.

---

### F‑09 · MEDIUM · 12 types render as a generic "Open Record" chip

`targetTag()` (`NotificationBell.tsx:175`) has no entry for `DOCUMENT_EXPIRY`,
`PURCHASE_RECORDED`, `PURCHASE_RECEIVED`, `FEED_BATCH_*`, `FEED_QC_FAIL`, `FEED_RAW_OUT`,
`FISH_FEED_*` or `BLOCK_MIX_*`, so they fall through to `branchCode` or **"Open Record"**.

**Impact.** In a bell with hundreds of rows, the user cannot triage which subsystem is
demanding attention.

---

### F‑10 · LOW (latent) · The whole completion block is gated on a non-null creator

`PATCH /api/tasks`'s notification block opens with `task.createdByUserId != null`, and the
workspace-principals loop is **nested inside** it (`route.ts:401` → `:437`). Today the only
creator is the POST route, which always sets it, so this is dormant — but the first
automated task producer (e.g. raising an action from a failed checklist) would produce a
task that, when completed, notifies **nobody**.

### F‑11 · LOW · The creator's completion row omits `recordId`

The creator's `TASK_COMPLETED` row sets no `recordId`; the principals' rows set
`recordId: task.id`. Same event, different deep-link quality.

### F‑12 · LOW · Transport's dedupe key ignores `recordRef`

`notifyTransport` dedupes on `(user, type, recordType, recordId, isRead=false)`, unlike
every other producer's `(user, type, recordRef)`. Two distinct transport events sharing a
record id collapse to one.

### F‑13 · LOW · Several producers cannot deep-link to the record

`recordId: null` in `lowStock.ts`, `notifyDunning`, `preorder.ts`, `trackingServer.ts`. The
user must rely entirely on tab routing — which is exactly what F‑06 breaks for pushes.

### F‑14 · INFO · Overdue escalation only runs when someone opens the app

`escalateOverdueTasks` is reached only through `runDailyOps`, triggered by `/api/init`'s
daily TTL or `/api/cron/daily`. No one opens the app → no escalation. Reasonable for this
architecture, but it means "overdue" is a function of app traffic, not of the calendar.

---

## What is **not** wrong

Stated explicitly, because these were the highest-risk areas:

| Check | Result |
|---|---|
| Cross-organization leaks in the live table | **0** — every row's recipient is an org member, the recorded org owner, or a platform Super Admin |
| Orphan rows (recipient deleted / missing) | **0** |
| Duplicate `(user, type, recordRef)` in the live table | **0** |
| Rows with neither `record_ref` nor `record_id` | **0** |
| Owner covered by the money / purchase / dunning / document / stock / preorder / order / feed-mill / block-factory / advisor / approval producers | **Yes** — all resolve via `workspaceAudience`, and `MONEY_WATCHER` and `CHECKLIST_MANAGER` both contain `OWNER` |
| Push category toggles | All 42 types resolve — `categoryFor()` has a sound fallback chain |
| `resolveApprovers` cross-unit routing | Correct — org-wide policy returns org-wide approvers; business-scoped policy filters on assignment/manage |
| Canonical resolver regression suite | `verify-owner-bell.mjs` **32/0** on a freshly reseeded database |

---

## Root causes

**RC‑1 · Four parallel routing maps, none enforced.**
`urlForNotification()` (push URL), `targetTag()` (bell chip), `onOpenRecord()` (in-app
click) and the push `TYPE_CATEGORY` map (user toggles) are four independent lookup tables
that must agree, plus ad-hoc `url:` overrides inside producers. Nothing checks that they do.
F‑06, F‑07 and F‑09 are all direct consequences. This is why the defects recur: adding a
type means editing four files and getting all four right, and nothing tells you if you don't.

**RC‑2 · The Action Center state machine has no transition→audience contract.**
`normTaskStatus` defines `{OPEN, IN_PROGRESS, DONE, CANCELLED}`; the notification logic
lives as `if (nextStatus === "DONE")` blocks scattered across a route handler and a lib.
Every transition without an explicit branch is silent. F‑03 and F‑04 are the missing cells.

**RC‑3 · One producer was never migrated to the canonical resolver** (F‑01), and the static
guard's coverage stops at the money writers, so nothing flagged it.

**RC‑4 · Recipient subtraction is used where an audience decision is needed.** F‑02 and
F‑05 both come from `continue`/`skip` statements that were correct in isolation and wrong in
combination.

---

## Recommended system-wide strategy

The goal is that these defects **cannot recur**, not that today's are patched.

### 1 · One declarative notification registry — `src/lib/bellTypes.ts`

A single entry per type:

```ts
BELL_TYPES = {
  DOCUMENT_EXPIRY: { label: "Document Expiring", category: "alerts",
                     url: (c) => "/?tab=DOCUMENTS", severity: "…" },
  TRANSPORT_UNAUTHORIZED_MOVEMENT: { label: "Transport — Unauthorized Movement", … },
  // …
} satisfies Record<string, BellTypeDef>
```

`urlForNotification()`, `targetTag()`, `onOpenRecord()` and `TYPE_CATEGORY` all become
**lookups into it**; the three parallel `if` chains and the ad-hoc `url:` overrides are
deleted. A static guard fails the build when a `type:` literal is not a key — the same
mechanism already used by `verify-money-notify-coverage.mjs`. *Fixes F‑06, F‑07, F‑09,
F‑13, and RC‑1 permanently.*

### 2 · An Action Center transition table

Declare every `(from → to)` with its audience, and drive notifications from the table:

| Transition | Audience |
|---|---|
| create | assignee + workspace principals (principals **not** subtracted — the event happened in their workspace) |
| `→ DONE` | creator + workspace principals |
| `→ CANCELLED` | assignee + creator + workspace principals |
| `→ OPEN` (reopen) | assignee + creator + workspace principals |
| past due | assignee + workspace principals, deduped per event |

The "principals are not subtracted" rule is applied **once**, in the table, instead of at
two call sites. *Fixes F‑02, F‑03, F‑04, F‑10, RC‑2, RC‑4.*

### 3 · Event-identity dedupe keys

Every `recordRef` names the **event**; no `:watch`-style per-recipient suffix variants.
Overdue escalation then yields one row per recipient for the same event. *Fixes F‑05,
F‑11, F‑12.*

### 4 · Finish the migration: `notifyTransport` → `workspaceAudience`

One-line audience change plus its role policy, and widen the static guard so **every**
exported `*Recipients`/`notify*` producer — not only the money ones — is checked against
`bellAudience.ts`. *Fixes F‑01, RC‑3.*

### 5 · A principal fallback for audit issues

Mirror what `api/audit/route.ts` already does: when the reviewer is missing, inactive, or
the issue is HIGH/CRITICAL, add `workspacePrincipals(businessId)` (deduped per user).
*Fixes F‑08.*

### Sequencing

1 → 3 → 2 → 5 → 4. The registry first (it is the largest mechanical win and unblocks the
others); then dedupe; then the transition table; then the audit-issue fallback; then the
transport migration, which becomes a two-line change once the guard is widened.

### Verification to accompany it

Extend the static guard from "is this audience canonical?" to "is every emitted type
registered, routed and labelled?" — that single check would have caught F‑06, F‑07 and
F‑09 on the day they were written — and add Action Center transition cases (cancel, reopen,
self-assigned) to `verify-owner-bell.mjs`, which already covers raise, complete, overdue and
the workspace-principal audience.

---

## Evidence

| Artifact | Purpose |
|---|---|
| `dev-tooling/audit-bell-surface.mjs` | read-only probe; reproduces F‑02, F‑03, F‑04, F‑05 and cleans up after itself |
| `dev-tooling/verify-owner-bell.mjs` | existing permanent suite, **32/0** on a fresh database |
| `dev-tooling/verify-money-notify-coverage.mjs` | existing static guard, **20/0**; scope is what needs widening |

**Confirmation of no product changes:** this audit modified no file under `src/`. The only
addition is the read-only probe listed above.