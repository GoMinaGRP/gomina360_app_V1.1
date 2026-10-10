# Final audit — charts, visual analytics, and event-driven notifications

_Scope: the Owner's request to (1) find and fix why charts/graphs/figures were
not displaying **globally** rather than page by page, and (2) audit why newly
recorded revenue/sales did not reliably reach the right people's bell
notifications — including the Owner's workspace — plus the wider blast radius of
similar event-driven notifications. Permissions and tenant isolation had to be
preserved._

---

## 1 · Summary

Three genuine product defects, one of them global:

| # | Area | Root cause | Fix | Where |
|---|---|---|---|---|
| **1** | **Every chart in the app** | One global CSS rule clamped `.recharts-wrapper` against Recharts 3's deliberate 0×0 auto-sizer → **every chart rendered 0 px wide** | Removed the clamp; kept the container-level anti-spill clamp | `src/app/globals.css` (one stylesheet, no page patched) |
| **2** | **Credit money received** | `postInstallment()` wrote a real INCOME ledger row directly — **bypassing the shared poster**, so the Owner's daily figure never moved | Calls `notifyCreditPayment()`, fire-and-forget | `src/app/api/credit-sales/route.ts` |
| **3** | **Payroll paid** | `postPayrollTransaction()` wrote the staff-cost EXPENSE row directly — **bypassing the shared poster** | Emits `notifyMoneyActivity({ kind: "EXPENSE" })`, still fire-and-forget | `src/app/api/payroll/route.ts` |
| **4** | **Every bell fan-out, including the Owner's** | Audiences were derived **only** from `organization_members`, a table that only organization provisioning fills. An OWNER account with no membership row was **unreachable by every notification in the app** | One `orgRecipientUserIds()` resolver unions `organizations.owner_user_id`; all five audience owners route through it | `src/lib/notify.ts`, `notifyActivity.ts`, `approvals.ts`, `transport.ts` |

Defect 4 is the one that matches "including the Owner's workspace" most
directly, and it was invisible: no error, no log — the fan-out simply resolved
to an **empty audience**, so money, orders, purchases, transport alerts and audit
events all posted while the Owner was told nothing.

**Nothing about permissions or tenant isolation changed.** No role gate, no
`canViewFinance` rule, no organization boundary was touched; the union can only
ever *add that organization's own recorded OWNER*, never a stranger. See §5.

---

## 2 · Charts — the global root cause

Recharts 3 measures the **outer** box and renders:

```html
<div class="recharts-responsive-container" style="width:100%;height:260px">
  <div style="width:0;height:0;overflow:visible">   <!-- deliberate 0×0 -->
    <div class="recharts-wrapper" style="width:866px">
      <svg style="width:100%;height:100%"> … </svg>
```

That 0×0 `overflow:visible` div is the `AutoSizer` trick — it stops the chart
feeding its own size back into the observer measuring it, and the chart paints by
**overflowing** it.

A global rule — `.recharts-wrapper { max-width: 100% }` — resolved that `100%`
against the **0-wide** parent and **collapsed every chart in GoMina 360 to zero
width**.

**Why it hid for so long:** the DOM stayed completely healthy. Bars, axes,
gridlines, legend and tooltips all still existed and
`.recharts-bar-rectangle` still returned real counts. Only the painted pixels
were gone — which is exactly why it presented as "charts aren't loading" or
"there's no data" rather than as a layout bug.

The fix keeps the clamp where it is correct (the outer container, whose
containing block is a real box) and leaves the inner wrapper at the pixel width
Recharts measured. Full reasoning, the four plausible-but-wrong "fixes", and the
change rules are in **`docs/CHARTS-VISUAL-ANALYTICS.md`**.

---

## 3 · Notifications — the two writer bypasses

GoMina posts money through several engines (`postSale`, `postServiceSale`,
`postOrGateExpenseTransaction`), each of which notifies. Two routes wrote
`transactions` rows **by hand**, skipping the engines entirely:

- **Credit sales** — an opening deposit and every later installment are real
  money received. `postInstallment()` inserted the ledger row itself.
- **Payroll** — a run an officer approved and paid is a real expense.
  `postPayrollTransaction()` inserted the row itself.

The failure mode was uniquely deceptive: the **ledger was right**, every
dashboard and report was right, and only the **bell** under-counted — so the
Owner's daily revenue/expense figure silently disagreed with the bank.

Both fixes are **fire-and-forget** (`.catch()` swallowed, no `await` in the write
path), so a notification failure can never roll back a payment. Self-exclusion
is preserved: the officer who pays the run is still not notified about their own
action — which is why the payroll test uses a *delegated* ACCOUNTANT rather than
the Owner.

ON_CREDIT invoice payments were checked too: `/api/procurement` `PAYMENT_RECORD`
already delegates to `postOrGateExpenseTransaction()`, so they were covered.

---

## 4 · Notifications — the unreachable Owner

Every audience resolver projected user ids straight off `organization_members`:

```ts
const memberIds = new Set(
  (await db.select({ userId: organizationMembers.userId })
     .from(organizationMembers)
     .where(eq(organizationMembers.organizationId, orgId))).map(m => Number(m.userId)),
);
if (!memberIds.size) return [];     // ← silent, total blackout
```

`organization_members` is filled **only** by organization provisioning. An OWNER
account that predates multi-tenancy, or an organization whose membership backfill
was never run, has **no row there at all** — so the whole fan-out resolved to
empty. This affected money, unit heads-ups, stock, orders, purchases, transport
alerts, approval escalation and audit events.

The fix is a single resolver, `orgRecipientUserIds(orgId)`, that unions the
membership rows with `organizations.owner_user_id` — the tenant's **own record**
of who owns it. Callers still select from `users`, so a stale id simply drops
out, and the `isActive === false` filter still applies.

---

## 5 · Tenant isolation — verified, not assumed

The union above is the only place a new user id can enter an audience, so it was
verified directly rather than reasoned about. A new data-driven suite
(`verify-tenant-isolation.mjs`) derives every expectation **from the database**
instead of hard-coding unit counts — older suites that assert "org 2 owns exactly
one unit" go red whenever another fixture legitimately adds a unit, which says
nothing about leaking.

Confirmed live against the running app:

- `?ownerId=1` → **only** GoMina Group's 10 units; `?ownerId=2` → **only** the
  rival org's units. No overlap, no leakage.
- Every business-scoped audit row is attributed to **exactly one** owner scope
  (101 = 101); platform rows carry no business and belong to no unit.
- A forged `ownerId`+`businessIds` pair returns **0 rows** — never a fallback to
  everything.
- **0** bell rows about a business were delivered outside that business's
  organization.
- The bell endpoint is user-scoped: two users' rows are disjoint, every returned
  row is addressed to the caller, and an unauthenticated request gets **401**.

---

## 6 · Collateral damage found and repaired

An honest note on something this audit **introduced** and then caught.

The new payroll test initially swept cleanup by time window
(`created_at > now() - interval '6 hours'`). The demo seeder writes its payroll
run with `created_at = now`, so the **first run of my own suite deleted seeded
payroll history**, which then broke `verify-payroll2`'s legacy-entry regression.

- Cleanup now targets **the suite's own actors** (`created_by_user_id IN (fixture
  users)`) — an exact discriminator that can never touch seeded or production
  data. Confirmed by the suite's own forensics: `runs restored 1/1`,
  `entries restored 1/1`.
- The seeded August payroll run and entry were **restored** to their exact
  `seed.ts` values (net 4,697.36).
- `verify-payroll2`'s legacy check no longer hard-codes `e.id = 1`; it resolves
  the baseline entry by **identity** (business 1, Doris Ansah, period 2026-08),
  so it cannot fail again just because a row id moved.

Two suites were also leaving debris behind (`TEST …` customers from the car-wash
and online-order sections were never id-tracked). `verify-revenue-notifications`
now performs a name-stamped sweep in addition to its id lists, which took
`verify-credit-sales` from 38/39 back to **39/39**.

---

## 7 · Test results

**474 checks, 0 failures.**

| Suite | Result | What it proves |
|---|---|---|
| `verify-charts` | **13 / 0** · 606 chart surfaces · 160 page loads · **0 broken** | Every chart on 21 surfaces × all sub-tabs × 4 roles × desktop+mobile has real pixels |
| `verify-charts-live-data` | **22 / 0** | Charts *reflect* new data (empty→full: 0→29 marks; new sale: 27,707→30,811 px² of bars, GH₵ 543.21 rendered) |
| `verify-money-notify-coverage` | **14 / 0** (static) | Every money writer reaches a notifier; every engine still notifies; no audience bypasses `orgRecipientUserIds`; no rule re-clamps `.recharts-wrapper` |
| `verify-revenue-notifications` | **77 / 0** | Sales Center, ledger, credit deposit+installment, car wash, online order and delegated payroll all move the Owner's roll-up; **synthetic unmigrated Owner gets the bell; a second org's Owner gets nothing** |
| `verify-notify-activity` | **99 / 0** | Full notification contract: roll-ups, audiences, stock crossings/escalation, approvals, deletions, caps, links |
| `verify-tenant-isolation` | **15 / 0** | §5 — data-driven, cannot go stale |
| `verify-approvals` | **70 / 0** | Approver resolution unchanged by the audience refactor |
| `verify-payroll2` | **53 / 53** | Payroll writes, statutory, legacy regression, and seeded-baseline forensics |
| `verify-credit-sales` | **39 / 39** | Credit lifecycle including the new notification |
| `verify-expense-permissions` | **44 / 0** | Expense permission gates unchanged |
| `verify-audit-access` | **28 / 28** | Audit scoping/delegation unchanged |

Plus `verify-procurement-chain` and `verify-transport` (**120 / 0**).
`tsc --noEmit` clean; `eslint` **0 errors** (166 pre-existing warnings).

### Chart matrix detail

| Role | Chart surfaces | Broken | Page loads |
|---|---|---|---|
| OWNER | 252 | 0 | 40 |
| GENERAL_MANAGER | 252 | 0 | 40 |
| BRANCH_MANAGER | 102 | 0 | 40 |
| WORKER | 0 *(by design — single-branch tool workspace, no Recharts)* | 0 | 40 |

Business types covered: poultry, block, aqua, livestock, food, tech, car wash,
hardware, boutique + all cross-cutting workspaces (Command Center, Finance,
Audit, Payroll, Transactions, Tracking, Pre-orders, Procurement, Action Center,
Employees, Inventory).

---

## 8 · Reproducing

```bash
bash dev-tooling/setup-runtime.sh        # Postgres + schema + seed + build + app

# charts
LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-charts.mjs
LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-charts-live-data.mjs

# notifications
bash dev-tooling/run-suite.sh dev-tooling/verify-revenue-notifications.mjs
bash dev-tooling/run-suite.sh dev-tooling/verify-notify-activity.mjs
bash dev-tooling/run-suite.sh dev-tooling/verify-tenant-isolation.mjs

# static guard (no server needed)
node dev-tooling/verify-money-notify-coverage.mjs
```

Evidence: `reports/screenshots/charts/` (geometry) and
`reports/screenshots/charts-live/` (empty→full, and the Finance chart before/after
a GH₵ 543.21 sale).

---

## 9 · Guardrails added

1. **Any new money writer must notify.** The static guard fails if a module writes
   an INCOME/EXPENSE `transactions` row and reaches neither a shared posting
   engine nor a notifier — closing the *class* of bug, not the two instances.
2. **Any new bell audience must go through `orgRecipientUserIds`.** Reading
   `organization_members` directly now fails the guard.
3. **No rule may re-clamp `.recharts-wrapper`.** Comments are stripped first, so
   a `max-width` inside a selector *group* is caught too — which is how this bug
   came back the first time.
4. **A navigation timeout is a failure, not a skip**, and a role measuring zero
   charts reports its page-load count — so "no charts here" can never be confused
   with "nothing rendered".

---

## 10 · Pre-existing issues found but **not** changed

Reported rather than silently fixed, because each is outside this audit's remit
and changing it would alter behaviour the Owner did not ask about:

- **`verify-business-scope.mjs` is calibrated to a different fixture set.** It
  hard-codes unit counts (`"org 2 owns exactly one unit"`, `"My Workspace has 3
  units"`) that no longer match the seeded database (10 + 2 units), so 8 of its
  94 checks fail. Direct API probing confirmed the **product behaviour is
  correct** — no cross-tenant leakage, every business row attributed once, forged
  scopes return empty. `verify-tenant-isolation.mjs` covers the same invariants
  without the brittleness.
- **Platform-level audit rows (`business_id IS NULL`)** — permission changes,
  delegations, approval-policy edits — appear in the Super Admin's audit view but
  not in a per-tenant unit lens. `scopedTrail` in `src/app/api/audit/route.ts`
  explicitly scopes them by `ownerId`, so this is a deliberate unit-view choice,
  not a leak. The Owner is still notified about them via the bell
  (`AUDIT_EVENT`). Changing the Audit Trail screen is a product decision.
- **The audit screen's Audit Trail is not the notification surface.** Every gap
  fixed here was a fan-out/geometry problem, not a notification-UI problem — the
  bell, its chips and click-through were already correct throughout.