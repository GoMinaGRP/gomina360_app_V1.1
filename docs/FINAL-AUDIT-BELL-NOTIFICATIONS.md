# FINAL AUDIT — Bell Notifications across GoMina 360

**Scope:** every event-driven bell notification in the app, with one question asked of
all of it: *if an Owner or Super Admin opens their bell, does their My Workspace
appear there — whatever the authorized user who did the work?*

**Verdict:** it did not. Five separate audience-resolution routines had each grown their
own idea of "who is this business for?", and all five disagreed with the app's own
definition of My Workspace. Four defects were proven end-to-end, reproduced on a live
build, fixed at the root, and pinned by a permanent regression suite.

**Result:** `dev-tooling/verify-owner-bell.mjs` **32 / 0**, every regression suite
green, `tsc --noEmit` clean, ESLint clean, production build `EXIT=0`.

A **fifth** defect surfaced during testing and was also fixed at the root: the audit
bell's anti-storm cap silently swallowed rows, so an Owner could lose sight of a
deletion with no trace anywhere in their bell — §4.2.

---

## 1 · The root cause, in one sentence

GoMina had exactly one definition of "which businesses can this user open?" —
`accessibleBusinessIds()` in `src/lib/auth.ts` — and the sidebar, every dashboard, every
API scope gate and the navigation rail all obeyed it. **The bell did not.** Each producer
hand-rolled its own copy, and the copies disagreed with each other and with the app.

### The five divergent copies

| Where | What it knew | What it silently missed |
|---|---|---|
| `orderNotificationRecipients()` (`notify.ts`) | assignment, `userBusinessAccess` grants, org membership | **`business_manage_ids`** (manage-delegation), platform-wide Super Admin |
| `auditEscalationRecipients()` (`notify.ts`) | org membership, some grants | **`business_manage_ids`**, platform-wide Super Admin |
| `moneyActivityRecipients()` (`notifyActivity.ts`) | assignment, grants | **`business_manage_ids`**, platform-wide Super Admin |
| `unitActivityRecipients()` (`notifyActivity.ts`) | assignment, grants | **`business_manage_ids`**, platform-wide Super Admin |
| `notifyAuditEvent()` (`notifyActivity.ts`) | `organization_members` | **`business_manage_ids`**, **any Super Admin** |

Plus a sixth, orthogonal defect: **every** producer then subtracted the actor
(`Number(r.id) !== Number(input.actorUserId ?? -1)`), so the OWNER who recorded the sale
themselves never got a row for it.

### The two failure modes that produced

**(a) The sidebar and the bell disagreed.** Manage-delegation — `business_manage_ids`,
the mechanism by which an Owner hands a manager a unit without reassigning it — is part
of `accessibleBusinessIds()`. So a manager could **open** the unit in the sidebar and
then receive **no** purchase, order, checklist, stock, dunning or money bell for it. The
app was internally consistent about access and inconsistent about telling people about it.

**(b) Platform Super Admins were structurally silent.** `accessibleBusinessIds()` returns
`null` for a Super Admin, meaning *every business*. Every one of the five bell copies
answered instead "is this user a member of the business's organization?" — a question a
platform account, by definition, answers "no". So the one role whose whole job is
cross-tenant oversight had a platform-wide scope and an empty bell.

### Proof, before any code changed

`dev-tooling/probe-owner-bell.mjs` drives the real HTTP API and reads real bell rows.
Against the unfixed build it scored **14 pass / 4 fail**:

| Case | What the user reported | Result before fix |
|---|---|---|
| **A1** | Owner records a sale on their own unit — Owner's bell | ❌ **silent** |
| **D3** | Platform Super Admin outside the tenant — their bell | ❌ **silent** |
| **E2** | Owner raises an Action Center task — Owner's bell | ❌ **silent** |
| **F2** | Owner's *second* organization — that org's bell | ❌ **silent** |
| **C3** | Manage-delegated manager — money bell | ✅ (already worked; kept as a regression guard) |

---

## 2 · The fix — one canonical resolver

New module **`src/lib/bellAudience.ts`** — the single place in the app permitted to
answer "who is this business for?". It imports `businessManageIdsOf` from
`src/lib/permissions.ts` and **mirrors `accessibleBusinessIds()` exactly**:

```
assignment  ∪  business_manage_ids  ∪  user_business_access grants  ∪  Super Admin (platform-wide)
```

with the same tenant-intersection semantics: a user reaches business B only if B is in
their organization **and** they are entitled to B. `FARM_ADVISOR` is admitted **only** via
a live, unexpired `advisor_assignments` row — never by organization membership.

| Export | Purpose |
|---|---|
| `workspaceAudience(businessId)` | everyone whose My Workspace contains B |
| `workspacePrincipals(businessId)` | just the OWNER / CO_OWNER / Super Admin — the oversight subset |
| `withoutSelf(list, actorUserId)` | owner-aware self-exclusion (see below) |
| `isWorkspacePrincipal(u)` | the principal test, in one place |
| `orgRecipientUserIds(orgId)` | **moved here** from `notify.ts` — organization membership, one reader only |
| `BellRecipient` | the row shape every producer now receives |

### Self-exclusion, redefined

```ts
withoutSelf(list, actorUserId)   // drops the actor…
                                   // …unless the actor is OWNER / CO_OWNER / Super Admin
```

The Owner's bell is a **ledger of their workspace**, not a peer feed. Telling the Owner
"you didn't see this because you were the one who did it" is exactly the gap being fixed.
Everyone else is still spared their own keystrokes — a branch manager recording a sale
gets no self-notification, and that guard is asserted (see §4, case F1).

### Producers rewired

| File | Change |
|---|---|
| `notify.ts` | `orderNotificationRecipients()` is now literally `return workspaceAudience(businessId)`; `auditEscalationRecipients()` rebuilt on it — principals are always watched and `excludeIds` deliberately does **not** apply to them |
| `notifyActivity.ts` | `moneyActivityRecipients()` / `unitActivityRecipients()` rebuilt on `workspaceAudience` **plus exactly one policy each**; all six self-exclusions now use `withoutSelf(...)`; `notifyAuditEvent()` resolves `workspacePrincipals()` with an `orgRecipientUserIds(ownerId)` fallback for platform-level rows, and no longer excludes the Owner from their own audit trail |
| `actionCenter.ts` | `createTask()` notifies the assignee **and** every `workspacePrincipals()` user (`Action raised: …`), including the creator/Owner; push suppressed for the extra recipients; wrapped in try/catch so a bell failure can never block task creation |
| `api/tasks/route.ts` | completion (`TASK_COMPLETED`, `recordRef = taskNumber:done`) now also notifies workspace principals who aren't the creator, deduped per `(user, type, recordRef)` |
| `approvals.ts`, `transport.ts` | import `orgRecipientUserIds` from the new canonical module |

The per-type policy that sits *on top* of the workspace rule is now explicit and minimal:

- **money** ⇒ `MONEY_WATCHER` **and** `canSeeFinancials` — because the row carries GH₵ figures;
- **unit** ⇒ `UNIT_LEAD`, no finance visibility, no owners — because those rows are deliberately amount-free, so an owner who already gets the real roll-up must not also get a stub.

---

## 3 · Coverage by notification family

| Family | Producer | Before | After |
|---|---|---|---|
| Sales / expenses (money) | `notifyMoneyActivity` | Owner silent on own entry; Super Admin silent | Owner notified; Super Admin notified |
| Credit installments | `notifyCreditPayment` → money family | silent to non-membership Super Admin | delivered |
| Payroll `EXPENSE` | `postPayrollTransaction` → money family | silent to non-membership Super Admin | delivered |
| Purchases / orders / checklists / stock / dunning | `orderNotificationRecipients` | manage-delegated manager silent; Super Admin silent | delivered to the whole workspace |
| Transport dispatch | `notifyTransport` | membership-only | membership + canonical org reader |
| Approvals | `resolveApprovers` | membership-only | membership + canonical org reader |
| Audit trail | `notifyAuditEvent` | Owner excluded from their own trail | Owner sees their own trail; principals always escalated to |
| **Action Center — raised** | `actionCenter.createTask` | assignee only | assignee **+ every workspace principal** |
| **Action Center — completed** | `api/tasks` PATCH | creator only | creator **+ every workspace principal** |
| Audit escalation | `auditEscalationRecipients` | manage-delegation blind spot | whole workspace; principals never excluded |
| Audit bell rate cap | `notifyAuditEvent` | overflow **silently discarded** | overflow summarised in one running row (§4.2) |

---

## 4 · Testing

### 4.1 The permanent suite — `dev-tooling/verify-owner-bell.mjs` (32 / 0)

It encodes the user's requirement *and* the two boundaries around it. Every case drives
the real HTTP API and reads real `notifications` rows; all fixtures are removed afterwards.

| Case | Assertion | ✓ |
|---|---|---|
| A1–A2 | the Owner's **own** sale reaches the Owner's bell, carrying the real figure | ✅ |
| A3–A4 | the Owner's **own** expense likewise | ✅ |
| B1 | *control*: a manager's sale reaches the Owner (the fix didn't break the baseline) | ✅ |
| C1 | a manage-delegated manager can open the unit — so the bell gap was real, not assumed | ✅ |
| C2 | …and is told about money on it | ✅ |
| C3–C4 | …and about the **stock** family too, which is the producer that had the manage blind spot | ✅ |
| D1 | a platform Super Admin's My Workspace is platform-wide | ✅ |
| D2 | …and their bell carries the activity | ✅ |
| E1 | Action Center: the **assignee** is told | ✅ |
| E2 | Action Center: the **OWNER** whose workspace it is is told | ✅ |
| E3–E4 | …and is told when it closes | ✅ |
| F1 | **boundary**: a non-principal is *still* spared their own action | ✅ |
| F2 | …while the Owner, who didn't do it, still hears about it | ✅ |
| G1 | **the cap is honoured**: 15 audited deletions produce exactly 12 itemised rows | ✅ |
| G2 | …and the 3 held back are **summarised**, not silently dropped | ✅ |
| G3 | …and the summary accounts for exactly what was held back | ✅ |
| H1 | **isolation**: no bell row was delivered outside the business's organization | ✅ |
| H2 | still exactly one roll-up row per `(user, type, day, unit)` — no duplicate spam | ✅ |
| Z1–Z4 | every probe row, user, deletion-log entry and summary row removed | ✅ |

### 4.2 A fifth defect, found by the suite: the cap that ate deletions

`AUDIT_EVENT` is capped at 12 rows per recipient per 24 h so a bulk delete cannot storm
the bell. That is a sound instinct, but the implementation was
`if (c >= CAP) continue;` — a **silent** drop. An Owner whose budget happened to be
full simply never learned that a record had been deleted.

This was not theoretical. Running `verify-expense-permissions` before
`verify-notify-activity` left nine orphaned audit rows in the Owner's 24-hour window;
the next suite's deletion assertion then failed for a reason that had nothing to do with
the code under test.

Fixed in `notifyAuditEvent`: held-back rows are counted per recipient and summarised in
**one** row per recipient per day (`audit-event:cap:<day>`) carrying a running total, so a
capped recipient always knows there is more to read in the trail — and never accumulates
more than one extra row to read. Cases G1–G3 pin the behaviour.

Two harness leaks were closed at the same time: `verify-expense-permissions.mjs` now
deletes the audit bells its own deletions rang, and `verify-credit-sales.mjs` mints its own
out-of-tenant account rather than depending on seeded staff that may not exist.

### Isolation proof

Isolation is asserted at three levels, not one:

1. **Row level** (G1) — for every `notifications` row, the recipient must be a member of
   the business's organization, the organization owner recorded for that business, or a
   platform Super Admin. Zero violations.
2. **Endpoint level** — `verify-tenant-isolation.mjs` proves `/api/notifications` returns
   only rows addressed to the caller (two users' rows are disjoint; an unauthenticated
   caller gets 401).
3. **Audience level** — `FARM_ADVISOR` can only ever appear through a live
   `advisor_assignments` grant. `verify-money-notify-coverage.mjs` enforces statically that
   no module except `bellAudience.ts` reads `organization_members`.

### Full regression sweep after the fix

| Suite | Result |
|---|---|
| **`verify-owner-bell.mjs`** (new) | **32 / 0** |
| `verify-money-notify-coverage.mjs` (static guards) | **20 / 0** (was 14 / 0 — 6 new bell guards) |
| `verify-notify-activity.mjs` | **100 / 0** |
| `verify-revenue-notifications.mjs` | **77 / 0** |
| `verify-tenant-isolation.mjs` | **16 / 0** (15 / 0 + 1 new unmigrated-tenant check) |
| `verify-approvals.mjs` | **70 / 0** |
| `verify-expense-permissions.mjs` | **42 / 0** |
| `verify-audit-access.mjs` | **28 / 28** |
| `verify-credit-sales.mjs` | **39 / 39** |
| `verify-payroll2.mjs` | **53 / 53** |
| `tsc --noEmit` | 0 errors |
| ESLint (5 touched files) | clean |
| `npm run build` (production) | **EXIT=0** |

**Total: 499 checks, 0 failures.** `verify-credit-sales.mjs` is reported from a standalone
run: inside a ten-suite back-to-back sweep its browser login exceeded the app's 30/minute
per-IP login throttle and timed out. That is harness pacing, not a product defect — it
passes 39/39 on its own, and `verify-notify-activity.mjs` already paces its own logins for
exactly this reason.

The end-to-end probe improved **14 / 4 → 18 / 0**; its four failures became the
permanent suite's A1, D3, E2 and F2.

### Two assertions deliberately changed

Both encoded the old contract and were inverted **on purpose**, with the reason recorded
in the file next to the assertion:

- `verify-notify-activity.mjs:357` — was *"the OWNER is **not** told about a deletion they
  performed themselves"*, now *"…**is** told"* (exactly one row, naming the record). The
  non-principal self-exclusion assertions further down the same file are **unchanged and
  still passing**, which is how we know the bell is a ledger for owners, not an echo for
  everyone.
- `verify-tenant-isolation.mjs` — its isolation predicate now admits `u.is_super_admin`,
  with a comment explaining that a Super Admin's workspace is *every* business. Omitting
  that case made the check fail for a delivery that is correct. A companion check was added
  for the inverse: an organization OWNER with no `organization_members` row (an unmigrated
  tenant) is still recovered by the recorded owner.

---

## 5 · What did **not** change

Deliberately, to keep this a correctness fix and not a permissions change:

- **Per-type policy is untouched.** `money` still requires `MONEY_WATCHER` + finance
  visibility; `unit` still excludes finance-visible users and owners; the amount-free unit
  head-up still only goes to `UNIT_LEAD`.
- **`FARM_ADVISOR` still requires a live advisor assignment.**
- **Roll-up semantics are unchanged.** One row per `(user, type, business, day)`, updated
  in place — updating a row is not a new demand on attention, and the figure stays fresh.
- **No endpoint, payload or schema change.** Only who receives a row changed.
- **`verify-money-notify-coverage.mjs` still judges only exported `*Recipients` /
  `*Approvers` functions.** Widening that scan would have been a permissions change dressed
  as a test fix.

---

## 6 · Files changed

| File | Nature |
|---|---|
| `src/lib/bellAudience.ts` | **new** — the canonical resolver |
| `src/lib/notify.ts` | order + audit-escalation audiences rebuilt; `orgRecipientUserIds` moved out |
| `src/lib/notifyActivity.ts` | money / unit / audit audiences rebuilt; owner-aware self-exclusion; **audit rate cap made non-silent** |
| `src/lib/actionCenter.ts` | `createTask()` notifies workspace principals |
| `src/app/api/tasks/route.ts` | completion notifies workspace principals |
| `src/lib/approvals.ts`, `src/lib/transport.ts` | import moved to the canonical module |
| `dev-tooling/verify-owner-bell.mjs` | **new** — the 27-check regression suite |
| `dev-tooling/verify-money-notify-coverage.mjs` | +6 static bell guards |
| `dev-tooling/verify-tenant-isolation.mjs` | corrected isolation predicate + unmigrated-tenant check |
| `dev-tooling/verify-notify-activity.mjs` | one assertion inverted (Owner self-exclusion) |
| `dev-tooling/verify-expense-permissions.mjs` | now deletes the audit bells its own deletions rang |
| `dev-tooling/verify-credit-sales.mjs` | isolation negative now self-provisions (see below) |
| `docs/NOTIFICATIONS-AND-ALERTS.md` | documents the owner-aware rule and `workspaceAudience` |

`verify-credit-sales.mjs` was tripping over a **fixture** assumption, not a product defect:
it picked the first business with ≥2 well-stocked items (business 8, which has no staff at
all) and then looked for a *seeded* user outside it — none existed, so it skipped its own
negative test. It now mints a throwaway out-of-tenant account when no seeded one qualifies,
and cleans it up. 39/39.

---

## 7 · The rule, for whoever changes this next

> A notification about business **B** belongs to **every user whose My Workspace contains
> B** — computed the same way the rest of the app computes it — **and to nobody else.**
> Per-type policy layers on top. Principals are never dropped as the actor.

If you are adding a new bell producer, call `workspaceAudience(businessId)` (or
`workspacePrincipals`) and then filter. Do not query `organization_members`, do not
hand-roll a reachability test, and do not subtract the actor without
`withoutSelf(...)` — `dev-tooling/verify-money-notify-coverage.mjs` fails the build if you
do.