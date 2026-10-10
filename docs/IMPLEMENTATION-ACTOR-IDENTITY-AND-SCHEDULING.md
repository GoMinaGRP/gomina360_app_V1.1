# Implementation Report — F‑15, F‑16, F‑14

**Date:** 2026-10-09 · **Branch:** `arena/98f19b62-gomina360-app-v1-1`
**Scope:** resolve every remaining finding from `docs/AUDIT-FINAL-NOTIFICATIONS.md`
**Result:** **626 checks / 4 failures — all 4 pre-existing and unrelated** (proven by A/B against unmodified source, §6)
`tsc --noEmit` clean · ESLint **0 errors** (166 pre-existing warnings) · `npm run build` **exit 0**

---

## 1 · Headline

| Finding | Severity | Status |
|---|---|---|
| **F‑15** client-controlled actor identity | CRITICAL | ✅ **Fixed system-wide — 17 routes, not the 4 originally reported** |
| **F‑16** deactivated reviewer still notified | MEDIUM | ✅ Fixed |
| **F‑14** overdue processing needs a scheduler | INFO | ✅ Repository-side work done — **3 actions remain outside Arena** (§7) |

### The most important thing in this report

The final audit reported F‑15 as affecting **four** routes. Building a system-wide
detector instead of patching four files showed the real number is **seventeen** —
more than four times the reported scope — and the audit had missed the largest
group because it only looked for identifiers *destructured* from a body, while
most of the app reaches them through a renamed alias:

```ts
const { entity, data } = body;        // ← "data", not "body"
…
createdByName: data.createdByName || "Farm Staff",   // missed by the original sweep
```

**Every one of the 89 routes is now scanned, and the sweep includes property
reads through any body alias.** Details in §2.

---

## 2 · F‑15 · Client-controlled actor identity — CRITICAL, fixed system-wide

### 2.1 Root cause

The identity of the acting user was read from the **request body** in 17 routes
and written into:

| Sink | Routes |
|---|---|
| `transactions.recorded_by{,_role,_user_id}` — the finance ledger | sales, branch-unit |
| `sales_documents.created_by_*` — the invoice issuer (**rewritable via PATCH**) | sales-documents |
| `users.created_by_user_id` — account provisioning | users/workers |
| `audit_trail` / `logActivity` — the immutable trail | carwash, telecom, checklists, branch-unit, … |
| `pushAfterBell` `actorName` — the bell's own attribution | all of the above |
| `postOrGateExpenseTransaction` actor — expense approvals & permission gates | electronics, hardware, restaurant, logs |

The session was present in every one of these routes. It was used only as an
authentication gate and, separately, for the business-access check — never for
identity.

### 2.2 The exploit, before and after

Reproduced live by `dev-tooling/verify-actor-spoof-live.mjs`, signed in as
**Emmanuel Osei, user 3, `BRANCH_MANAGER`**, sending the Owner's identity in the
body (`createdByUserId: 1, createdByName: "Kwame Mina", createdByRole: "OWNER"`):

| Probe | Before | After |
|---|---|---|
| `POST /api/sales` | `recorded_by="Kwame Mina"`, role `OWNER`, id **1** | `recorded_by="Emmanuel Osei"`, role `BRANCH_MANAGER`, id **3** ✅ |
| `POST /api/sales-documents` | issuer `Kwame Mina` (1) | issuer `Emmanuel Osei` (3) ✅ |
| `PATCH /api/sales-documents` | issuer **rewritten** to `Kwame Mina` (1) | unchanged, `Emmanuel Osei` (3) ✅ |
| `POST /api/users/workers` | `created_by_user_id = 1` | `created_by_user_id = 3` ✅ |
| `audit_trail` row on a real audit write | attributable to user 1 | attributable to the responder ✅ |

All requests still return **HTTP 200** — the body fields are *ignored*, not
rejected, so older clients keep working. The request is accepted; the *identity
inside it* is simply never believed.

### 2.3 The fix — one rule, one helper

**Root cause, not per-route patches.** `src/lib/auth.ts` now exports the single
sanctioned way to obtain an actor:

```ts
export function actorFrom(session: SessionInfo | null): Actor | null
export function actorFromUser(user: any): Actor | null
export async function actorFromRequest(request: Request): Promise<Actor | null>
export const ACTOR_CLAIM_KEYS: readonly string[]      // 30 keys, the deny-list
export function stripActorClaims<T>(body: T): T
```

`actorFrom` returns the **session user row itself**, so every capability flag
(`canRecordExpenses`, `isSuperAdmin`, `businessManageIds`, …) travels with it and
every downstream permission gate keeps working unchanged. That is why the fix
could be applied across 17 routes without touching a single permission check.

```ts
// before — the caller decides who acted
const { businessId, createdByUserId, createdByName, createdByRole } = body;
await postSale({ businessId, lines, actor: { id: createdByUserId, name: createdByName, role: createdByRole } });

// after — the connection decides who acted
const { businessId, lines } = body;
const actor = actorFrom(__authSession);
await postSale({ businessId, lines, actor });
```

### 2.4 All 17 routes fixed

**Directly exploitable (proved live before the fix):**

| Route | Change |
|---|---|
| `api/sales` | `actorFrom`; ledger, stock movements, variant deductions, price-audit entries all take the session actor |
| `api/sales-documents` | POST and PATCH both bind the session; the converter becomes the issuer of a converted invoice |
| `api/users/workers` | `createdByUserId` is the session actor |
| `api/logs/[businessCode]` | **missed by the original audit** — car-wash revenue and hardware GRN expenses no longer prefer `body.recordedByUserId` |

**Found by the system-wide detector (never previously reported):**

| Route | What it leaked into |
|---|---|
| `api/aquaculture` | 11 sites — weigh samples, water logs, harvest sale actor, `publishedByName` |
| `api/aquaculture/benchmarks`, `api/poultry/benchmarks` | `createdByName`/`Role` |
| `api/poultry` | 18 sites — flock plans, weight logs, harvest sales |
| `api/block-factory` | 7 sites — production logs and sales |
| `api/branch-unit` | `recordedBy{,,UserId}` on branch transactions |
| `api/carwash` | `actor.a`/`actor.r` shorthand → `logActivity`, bookings, expenses |
| `api/telecom` | `actor.a`/`r`/`u` → `bookTransaction` (ledger) and lines |
| `api/checklists` | `actorName`, `createdByName` |
| `api/electronics` | 11 sites incl. `fulfillElectronicsOrder(…, createdByName, createdByRole, createdByUserId, …)` |
| `api/hardware` | 10 sites incl. the GRN expense posting |
| `api/restaurant` | 11 sites incl. `bookExpense` |

**Hygiene — dead bindings that could be silently re-wired by a future edit:**

| Route | Removed |
|---|---|
| `api/transactions` | `recordedBy`/`recordedByRole`/`actorUserId` destructures and the unreachable `\|\| recordedBy \|\| …` fallbacks (a one-character edit from a live vulnerability) |
| `api/enterprise` | `actorUserId` destructured twice and never used |

### 2.5 Module-level helpers

Three routes had helpers declared outside the request handler, where
`__authSession` is not in scope. Rather than pretend otherwise, the actor is now
an explicit parameter:

```ts
// api/hardware
async function applyPurchaseReceipt(purchase, data, biz, actor?: any)
// called from POST and PATCH with __authSession.user

// api/restaurant — the actor is REQUIRED, with an honest neutral fallback
const actor = actorObj || { id: null, name: "Kitchen Staff", role: null };
```

`api/restaurant`'s PATCH had also re-forwarded `createdByName`, `createdByRole`
and `createdByUserId` from the body into the expense posting; that is gone.

### 2.6 Client side

**20 components, 73 identity claims** were removed from `fetch()` request bodies.
Each receiving route was checked first to confirm it already recorded the actor
from the session, so the removal is functionally inert — it stops sending
personal data the server does not need, and stops the payloads from lying.

Verified safe before removing: `api/platform-requests` never stored
`requestedBy*` at all; `api/exports` uses `actor.id` from `requireSuperAdmin`;
`api/businesses/[id]` ignored it. `receivedBy` (the GRN's own "received by"
business field) was **kept** — it is data, not attribution.

### 2.7 The regression guard

`dev-tooling/verify-actor-attribution.mjs` — **12 checks / 0 failures.**

Its most important property is that it proves it can fail:

- **S1 self-test.** A synthetic vulnerable route is fed through the same
  classifier and must be rejected; the safe shape must not be flagged. A guard
  that cannot fail is worse than no guard.
- **S2z / S4z anti-vacuity.** The suite **fails loudly if the file walk ever
  matches zero routes**. This caught a real bug during development: an
  `endsWith("/route.ts")` that never matched, which made S2 and S4 pass against
  **0 files**. Before that fix the suite reported a clean "89 routes" while
  having examined none.
- **S2** — all **89** routes source no identity from a body, scanning both
  destructuring **and** property reads through any alias.
- **S3** — the helpers exist and `ACTOR_CLAIM_KEYS` covers what the scanner looks for.
- **S4** — no route writes attribution without resolving a session first.
- **S5** — no component sends an identity claim in a request body.

One documented exception is allow-listed: `api/order` (customer-facing intake,
below).

---

## 3 · F‑16 · Deactivated reviewer still notified — MEDIUM, fixed

`api/audit/issues/route.ts` seeded its audience with the reviewer unconditionally
and only ever **added** principals when the reviewer was inactive — it never
removed them, so `workspacePrincipals`' documented "excludes deactivated
accounts" rule was bypassed by the very insert it was meant to govern.

```ts
const recipients = new Set<number>([Number(row.reviewerUserId)]);   // always
…
if (reviewerInactive) recipients.delete(Number(row.reviewerUserId));  // ← added
if (severe || reviewerInactive) for (const p of principals) recipients.add(p.id);
```

**Live proof it is fixed** (`verify-actor-spoof-live.mjs` §9): with the reviewer
deactivated and a different, non-principal principal in the seat, the assignee
responds and the recipients are exactly `{1}` — the Owner is told, the
deactivated account is left alone. Before the fix the recipient set included the
deactivated user.

---

## 4 · F‑14 · Overdue processing without opening the app

The assessment is in `docs/RECOMMENDATION-F14-OVERDUE-PROCESSING.md`. Everything
that can be done inside the repository has been done.

### 4.1 Repository-side changes

| Change | Why |
|---|---|
| `export const maxDuration = 60` on `api/cron/daily` | The 18-step sweep was inheriting a plan default. A timeout is *safe* (the marker is written only on success, so it re-runs) but silently loses a day. Stated explicitly instead. |
| `lastDailyOps()` in `lib/dailyOps` + `latestMarkerWithPrefix()` in `lib/systemMarkers` | **Vercel does not retry a failed cron and does not alert on one.** "Overdue quietly stopped being processed" was invisible. The last successful sweep is now a readable fact. |
| `/api/health` reports `dailyOps: { ranAt, date, source, ageHours, stale }` | One request answers "is the scheduler alive?". A stale sweep is a *reportable condition*, never a red health endpoint. |
| `/api/init` uses `after()` instead of a floating `import().then()` | The pull-based fallback was the weakest link: on serverless a floating promise may be frozen once the response is sent, so the sweep "usually" appeared to work — which is exactly what makes a bad safety net dangerous, because the days it misses are the quiet days nobody opens the app. `after()` returns immediately but holds the function alive. |

Verified live: `ranAt=2026-10-09T04:51:21.338Z ageHours=0.2 stale=false`, and the
cron endpoint still returns **401** to an anonymous caller and to a wrong bearer
secret — the fail-closed behaviour was not weakened.

### 4.2 Already correct, left alone

The Vercel Cron entry (`0 6 * * *`) already existed; the route already
authenticate by `Bearer $CRON_SECRET`; the `daily-ops:<date>` marker already
makes cron and `/api/init` mutually exclusive; every step is already
individually idempotent. **No new scheduler was added** — an external one would
introduce a credential and a failure domain to replace a cron entry that works.

---

## 5 · Test suites added

| Suite | Checks | What it proves |
|---|---|---|
| `dev-tooling/verify-actor-attribution.mjs` | **12** | Static. Self-verifying detector; 89 routes carry no body-sourced identity. |
| `dev-tooling/verify-actor-spoof-live.mjs` | **26** | Live. Performs the real exploit as a `BRANCH_MANAGER` and reads the database to confirm ledger, invoice issuer, account provisioner, audit trail, self-exclusion, permissions and isolation. |

Both clean up after themselves, including restoring inventory levels — the first
version leaked decrements into the chart and stock suites, which is what surfaced
the chart-fixture failures discussed in §6.

---

## 6 · Full regression run — 626 pass / 4 fail

| Suite | Result |
|---|---|
| `verify-actor-attribution` | **12 / 0** |
| `verify-actor-spoof-live` | **26 / 0** |
| `audit-notification-final` | **24 / 0** |
| `verify-owner-bell` | **43 / 0** |
| `verify-tenant-isolation` | **15 / 0** |
| `verify-money-notify-coverage` | **43 / 0** |
| `verify-notify-activity` | **100 / 0** |
| `verify-revenue-notifications` | **77 / 0** |
| `verify-approvals` | **70 / 0** |
| `verify-expense-permissions` | **43 / 0** |
| `verify-audit-access` | **28 / 0** |
| `verify-payroll2` | **53 / 0** |
| `verify-credit-sales` | **39 / 0** |
| `verify-expense-ui` | **39 / 0** |
| `verify-audit-fixes` | **51 / 0** |
| `verify-charts-live-data` | 16 / **4** |

### The 4 failures are pre-existing, and A/B proven

All four are in `verify-charts-live-data` and all four assert that **AQUA‑01
starts empty** — which earlier suites have since populated. The suite's own
comment documents this as a known stale fixture assumption:

> *"This was an ASSERTION that the aquaculture unit starts empty. It stopped …
> series into AQUA‑01 — so the suite failed on a stale fixture assumption"*

**Evidence they are not caused by these changes:** `src/` was stashed, rebuilt
from unmodified source, and the same suite re-run in the same database state:

| Source | Result |
|---|---|
| Unmodified (stashed) `src/` | **15 pass / 5 fail** |
| With these fixes | **16 pass / 4 fail** |

Strictly better with the changes applied, and identical `barArea` numbers in
both runs. No product code was altered to chase them.

Two other suites that initially failed were **my own probe residue**, not
regressions: `verify-payroll2` ("no TEST data left") was counting two
`WMTEST` transactions left by an ad-hoc scratch probe — those rows also carried
`recorded_by: "Emmanuel Osei"`, incidentally demonstrating the F‑15 fix.
`verify-poultry-expense` fails on a missing `data-testid` and reproduces
identically on unmodified source.

---

## 7 · Actions that MUST be completed outside Arena

These cannot be done from here. **Item 1 is blocking.**

| # | Action | Where | Why it matters |
|---|---|---|---|
| **1** | **Set `CRON_SECRET`** — random string ≥16 chars, **Production** scope — then redeploy. | Vercel → Project → Settings → Environment Variables | ⚠️ **Until this exists, Vercel Cron sends no `Authorization` header, the 06:00 UTC fire returns 401, and nothing tells you.** The app keeps working only via the `/api/init` pull fallback, so the failure is invisible until escalations quietly stop. The route already returns an actionable hint naming this variable. |
| **2** | Confirm `maxDuration = 60` suits the plan. | `src/app/api/cron/daily/route.ts` | 60 s covers Pro. If the Vercel cron log ever shows a timeout, split the pipeline rather than raising it indefinitely. |
| **3** | After the first scheduled fire, check `GET /api/health` → `dailyOps.ranAt` is advancing daily and `source` is `"cron"` (not `"init"`). | any time after 06:00 UTC | `source: "init"` means the scheduler is still not authenticating — the fallback is carrying the load alone. |
| 4 | Consider `vercel cron list` / the Cron Jobs dashboard page for per-invocation logs. | Vercel dashboard | The only record of whether the 06:00 fire succeeded. |
| 5 | Optionally monitor `/api/health` `dailyOps.stale === true`. | wherever monitoring lives | The staleness signal now exists; nothing consumes it yet. |
| 6 | Re-run `npm run db:migrate` against the production database if the audit schema has drifted. | from a machine with the managed URL | Not triggered by these changes — no schema migration was added — but `/api/health` already reports `42703` with this exact remedy. |

---

## 8 · Files changed

**25 API routes · 20 components · 6 libs.** Notable:

| File | Change |
|---|---|
| `src/lib/auth.ts` | `actorFrom`, `actorFromUser`, `actorFromRequest`, `ACTOR_CLAIM_KEYS`, `stripActorClaims` |
| `src/lib/systemMarkers.ts` | `latestMarkerWithPrefix` |
| `src/lib/dailyOps.ts` | `lastDailyOps` |
| `src/app/api/health/route.ts` | reports the last sweep |
| `src/app/api/init/route.ts` | `after()` |
| `src/app/api/cron/daily/route.ts` | `maxDuration` |
| `src/app/api/audit/issues/route.ts` | F‑16 |
| `docs/NOTIFICATIONS-AND-ALERTS.md` | new §8 — the actor rule, with the exceptions and the guards |

---

## 9 · What is deliberately not done

- **No new scheduler.** The existing Vercel Cron covers F‑14; adding an external
  one would add a credential and a failure domain for no gain.
- **`api/order` left sessionless**, by design: a customer placing their own order
  has no staff identity to spoof. Documented and allow-listed in the guard.
- **The 4 chart-fixture assertions left alone.** They are stale test assumptions
  about an empty AQUA‑01, not product defects, and fixing them would mean editing
  a test to match polluted data.