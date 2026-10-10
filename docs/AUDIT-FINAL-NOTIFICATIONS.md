# Final Notification Audit — GoMina 360

**Date:** 2026-10-09 · **Scope:** the completed bell/notification implementation (task 4, F‑01…F‑13) across the **entire app**
**Method:** black-box HTTP + live-database verification, independent of the implementation's own suites
**Verdict:** The task‑4 architecture is **sound and correctly delivered**. One real defect remains (F‑16), and the audit
surfaced a **separate, pre-existing critical security finding** (F‑15) that the bell work did not introduce and does not
contain. Neither blocks the notification work; both need owners.

---

## 1 · Headline

| | Result |
|---|---|
| Notification audit checks executed | **24** (23 pass / 1 fail) |
| The 1 failure | **F‑16 — a real product defect**, not a measurement artefact |
| Regression suites re-run | `owner-bell` **43/0** · `tenant-isolation` **15/0** · `money-notify-coverage` **43/0** · `charts-live-data` **20/0** |
| Critical security finding (outside notification scope) | **F‑15 — client-controlled actor identity, 4 confirmed write paths** |
| F‑14 (overdue escalation scheduling) | Audited separately, **not implemented** — see `docs/RECOMMENDATION-F14-OVERDUE-PROCESSING.md` |

The audit harness is `dev-tooling/audit-notification-final.mjs`. It deliberately does **not** reuse the task‑4
implementation's own helpers: it logs in as real principals, fires real producers, and reads the `notifications`
table directly, so a bug in the registry or the audience resolver cannot hide the result it is being judged on.

---

## 2 · What was verified, and the result

### 2.1 Bell registry — the new single source of truth ✅

| Check | Result |
|---|---|
| Every `type` present in the live `notifications` table is registered | ✅ **12 distinct types, 0 unregistered** |
| Every registered type resolves to a real destination (no dead link) | ✅ 0 misrouted |
| No type falls through to the old Customer-Tracking catch-all | ✅ `FALLBACK: COMMAND_CENTER`, never the catch-all |
| Bell label / category / severity sourced from the registry, not hard-coded in the component | ✅ `NotificationBell` + `GoMinaApp` both delegate |

### 2.2 Action Center transitions ✅

The transition table dispatches through `notifyTaskTransition` with a `task:<id>:<event>` reference, so each
transition is one event for every recipient. Escalation steps (`task:<id>:overdue:<step>`) carry the step *inside* the
event identity, which is what makes a recurring sweep safe to re-run (§4).

### 2.3 Recipients — per family, per role ✅

Each family was fired live and the recipient set read back from the database. "Outsider" = a user who is neither an
org member, nor the recorded org owner, nor a platform Super Admin of that tenant.

| Family | Owner | Delegated mgr | Super Admin | Performer self-echo | Outsiders |
|---|---|---|---|---|---|
| **Money** (sale → daily roll-up) | ✅ | ✅ | ✅ | ✅ none | ✅ **0** |
| **Stock** (threshold crossing) | ✅ | ✅ | ✅ | ✅ none | ✅ **0** |
| **Transport** (geofence violation) | ✅ | ✅ | ✅ | ✅ none | ✅ **0** |

Recipients observed for the STOCK family: `1, 2, 10, 11, <delegated>, <super-admin>` — the Owner, the GM, the
branch managers who manage the unit, plus the two minted fixtures. For TRANSPORT: `1, 2, 3, <delegated>, <super-admin>`.

### 2.4 Deduplication ✅

| Check | Result |
|---|---|
| Money roll-up: one row per person per day (update-in-place, not re-insert) | ✅ ids 118/119/103/104 held their original ids while the figure advanced to GH₵ 414.00 |
| Audit issue: two recipients never collapse into two rows for one person | ✅ `one row per person` |
| Duplicate `(user_id, type, record_ref)` in the live table | ✅ **0** |

The update-in-place behaviour is deliberate and is the reason a daily money roll-up does not spam the bell — it was
initially misread as a missing notification, and the audit distinguishes the two explicitly.

### 2.5 Transport notifications ✅

`workspaceAudience` resolves UNIT_LEADs and principals; the transport family reaches exactly the unit's principals plus
platform Super Admins, with **0 outsider rows**. The same probe run standalone (`probe-transport-audience.mts`) returned
`inserted=4, recipients [2,1,3,34], RESULT: PASS`.

### 2.6 My Workspace routing ✅

Owner/Super-Admin "My Workspace" activity reaches the performing user's own bell regardless of who performed the
authorised action. Re-verified end-to-end by `verify-owner-bell.mjs` (**43/0**), which also covers the
`task:<id>:<event>` reference scheme and the E3 transport section.

### 2.7 Permissions — who must NOT be reached ✅

| Check | Result |
|---|---|
| A WORKER on the unit is **not** a money recipient (money carries a GH₵ figure) | ✅ reached `1, 2, <delegated>, <super-admin>` only |
| The figure itself only goes to finance-authorised recipients | ✅ **4 figure-bearing rows**, all to authorised principals |

### 2.8 Tenant isolation ✅

0 outsider rows across every family probed; `verify-tenant-isolation.mjs` re-run clean at **15/0**. Every recipient is
an org member, the recorded org owner, or a platform Super Admin of that tenant.

### 2.9 Audit notifications ⚠️ **F‑16**

| Check | Result |
|---|---|
| Assignee's response is accepted | ✅ `200` |
| The **Owner** is told when the reviewer is **deactivated** | ✅ reached `1, 2, <super-admin>` |
| The **deactivated** reviewer is *not* chased | ❌ **FAIL — the deactivated reviewer (user 2) still received a row** |
| No person gets the same issue twice | ✅ |

**F‑16 · MEDIUM · A deactivated reviewer is still notified.**

`src/app/api/audit/issues/route.ts:168` (and the guard at `:178`):

```ts
const recipients = new Set<number>([Number(row.reviewerUserId)]);   // ← unconditional
let principals: { id: number }[] = [];
if (row.businessId != null) { … workspacePrincipals(...) }          // excludes inactive
const reviewer = await db.select({ isActive: users.isActive })…;
const reviewerInactive = reviewer[0]?.isActive === false;
if (severe || reviewerInactive) for (const p of principals) recipients.add(Number(p.id));
```

The code detects the inactive reviewer in order to **add** the principals, but never **removes** the reviewer from the
set. `workspacePrincipals` is documented as already excluding deactivated accounts — the explicit reviewer insert
bypasses exactly that rule. So the bell writes a row for an account that can never log in and can never clear it.

Reproduced deterministically: retarget an assigned review onto a deactivated non-Owner principal, have the assignee
respond → recipients `1, 2, <super-admin>`, where `2` is the deactivated reviewer.

**Fix (one line, same file):** delete the reviewer from the set when inactive, before adding principals —

```ts
if (reviewerInactive) recipients.delete(Number(row.reviewerUserId));
```

No other producer has this shape: this is the only route that seeds its audience from a single explicit addressee.

---

## 3 · F‑15 · CRITICAL · Client-controlled actor identity (outside notification scope, found by this audit)

This is **pre-existing**, not introduced by task 4, and not a notification bug — but it is the most severe thing in
this report and it undermines the audit trail the notification system reports on, so it cannot be left unrecorded.

Four write paths take the acting user's **id, name and role from the request body** and never override them from the
session. The session is read only as an authentication gate and, separately, for the *business access* check — never
for identity.

| Route | Line(s) | Persisted to | Reachable by |
|---|---|---|---|
| `src/app/api/sales/route.ts` | 48‑50 → 183, 216, 239, 260 | `transactions.recorded_by{,_role,_user_id}` | anyone who can sell |
| `src/app/api/sales-documents/route.ts` (POST) | 95‑97 → 198‑200 | `sales_documents.created_by_*` | any user with business access |
| `src/app/api/sales-documents/route.ts` (PATCH) | 246 → 302‑304 | `sales_documents.created_by_*` (**overwrites the original issuer**) | any user with business access |
| `src/app/api/users/workers/route.ts` | 86 → 131 | `users.created_by_user_id` | OWNER / GM / scope-managing BM |

**Proven live** (`dev-tooling/probe-actor-spoof.mjs`, self-cleaning). Signed in as **Emmanuel Osei, user 3,
BRANCH_MANAGER** — a legitimate low-privilege session — and sent the owner's identity in the body:

```
transactions   : [{"id":130,"recorded_by":"Kwame Mina","recorded_by_role":"OWNER","recorded_by_user_id":1}]
sales_documents: [{"document_number":"INV-2026-0001","created_by_user_id":1,"created_by_name":"Kwame Mina",
                   "created_by_role":"OWNER"}]                     ← after PATCH, status SENT
users          : [{"id":57,"email":"actor.spoof…","role":"WORKER","created_by_user_id":1}]
```

All three returned **HTTP 200**. Every row claims user 1 / "Kwame Mina" / OWNER while the session is user 3.

**Impact**
1. **The ledger lies.** `recorded_by` is the evidentiary field of the finance module.
2. **The sales document's issuer is rewritable after the fact** — PATCH overwrites the original creator, so provenance
   is not even preserved under later edits.
3. **Account-provisioning audit is forgeable** — a manager can mint a worker and attribute it to the Owner.
4. **Notification attribution is falsified** — the same `actor` object feeds `pushAfterBell`, so the bell records the
   wrong performer.
5. **`withoutSelf` self-exclusion is defeatable.** Because the actor is client-supplied, setting it to a victim's id
   removes that victim from the recipient set for the very event they are party to. This is the mechanism behind the
   STOCK R4 anomaly in the first probe run.

**Fix (root cause, not per-route):** derive identity once from the session and delete the body fields.

```ts
// src/lib/auth.ts (or a shared helper) — the only source of actor identity
export function actorFrom(session: SessionInfo) {
  return { id: session.user.id, name: session.user.name, role: session.user.role };
}
```

Then in each route: stop destructuring `createdBy*` / `currentUser*` / `actorUserId` from `body`, and pass
`actorFrom(__authSession)` to every producer. `src/app/api/stock.ts` already does exactly this — `applyStockChange`
threads `actor?.id` — which is why the STOCK family passed R4 once the client sent the real id. That is the pattern
the other three routes should follow.

**Cleared as a false positive:** `src/app/api/enterprise/route.ts` destructures `actorUserId` from the body at L182
and L591 but never uses it — every audit write uses the session actor (`actor?.id`, L560 / L734 / L752). It is dead
code, not an exploit. **Recommended:** delete the dead destructure so the next reader does not have to re-derive this,
and so a future edit that *does* use it is caught in review.

Routes that already do this correctly: `src/app/api/transactions/route.ts`, `src/app/api/users/route.ts`.

---

## 4 · Why a recurring sweep is safe (relevant to F‑14)

Established while assessing F‑14, and it underwrites the recommendation:

- `runDailyOps` is gated by a **database** marker `daily-ops:<date>` (`src/lib/dailyOps.ts:262`), checked before any
  work and set only after all 18 steps succeed. A timeout mid-run therefore leaves no marker, and the next attempt
  re-runs from the top.
- Re-running is safe because **every step is independently idempotent**: low-stock requisitions are marker-gated per
  item, dunning chases per sale+stage, escalation per `task:<id>:overdue:<step>` and `issue-overdue:<id>:<step>`. The
  same day produces the same refs, so the bell dedupes; crossing into the next step produces a new ref, which is the
  intended new notification.
- The `/api/init` pull-based fallback and a scheduled fire therefore **cannot double-run**: both call
  `runDailyOps` and the marker is global, not per-device.

---

## 5 · Reproducing this audit

```bash
bash dev-tooling/preview-up.sh                                     # DB + app
bash dev-tooling/run-suite.sh dev-tooling/audit-notification-final.mjs
DATABASE_URL=postgresql://… npx tsx dev-tooling/probe-bell-registry.mts
DATABASE_URL=postgresql://… node  dev-tooling/probe-actor-spoof.mjs # F‑15 proof, self-cleaning
```

`audit-notification-final.mjs` restores every fixture it mutates (audit-review row, reviewer `is_active`, fixture
users) and deletes its probe notifications on the way out.

---

## 6 · Recommended actions

| # | Action | Severity | Owner |
|---|---|---|---|
| 1 | Bind actor identity from the session in `sales`, `sales-documents` (POST **and** PATCH), `users/workers`; add `actorFrom()` to `@/lib/auth` | **CRITICAL** | Backend |
| 2 | Drop the dead `actorUserId` destructure in `api/enterprise/route.ts` | Low (hygiene) | Backend |
| 3 | `recipients.delete(reviewerUserId)` when `reviewerInactive` in `api/audit/issues/route.ts` | **MEDIUM** | Backend |
| 4 | Add a regression guard: a static check that no route persists an actor identity sourced from `request.body` | **MEDIUM** | Backend |
| 5 | Confirm `CRON_SECRET` is set on the Vercel project (see the F‑14 doc) | **MEDIUM** | Infra |

Actions 1, 3 and 4 are small and independently testable. **Not implemented in this task** — the request was an audit.