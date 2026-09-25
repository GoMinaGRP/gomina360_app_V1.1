# Farm Advisor / Resource Person — Implementation & Verification Report

Branch: `arena/01a0d67a-gomina360-app-v1-1` · Commit: `d5f8907`
Design reference: [`docs/FARM-ADVISOR-DESIGN.md`](./FARM-ADVISOR-DESIGN.md)

---

## 1. What was built

An external professional (veterinarian, extension officer, nutritionist,
consultant) can now be invited by the Owner, given **scoped, time-boxed,
read-only** access to specific farms, and can file professional observations
and recommendations that enter the **existing** audit/accountability pipeline.
Nothing was duplicated: advisory notes reuse the AI daily-notes engine, the
audit issue workflow, the notification bell + web push, and the poultry
analytics/benchmark stack.

### Roles & permissions
| Actor | Powers |
|---|---|
| OWNER | Invite advisors, grant/scope/pause/revoke access, set cost visibility, export and engagement window, work advisory notes |
| GM / Branch Manager | Same, **only** when the Owner enables *Manage Farm Advisor access* (`users.can_manage_advisors`) |
| ADVISOR | Read-only on granted farms within granted scopes; may write **only** advisory notes, visits and digests |
| Everyone else | Unchanged |

### Secure configurable defaults (open decisions resolved)
| Decision | Default | Owner can change? |
|---|---|---|
| Cost / revenue visibility | **hidden** | yes, per grant |
| Data export by advisor | **off** | yes, per grant |
| Photos / CCTV stills | **not granted** | yes, `PHOTOS_CCTV` scope |
| Multi-farm / multi-org | one grant per farm, always inside the Owner's organization; cross-org grants are rejected | — |
| Suggested corrections | advisor may *request* action; only staff can close | — |
| Billing / payroll view | never | — |
| Engagement window | open-ended unless an end date is set; expiry blocks instantly | yes |

---

## 2. Security model (Phase 0 first)

Enforcement is **central and fail-closed**, not per-route and not UI-only.

1. **Identity gate** — every authenticated route resolves its session through
   `getSessionInfo()`, which calls `assertRequestAllowedForActor()`:
   * **Read allowlist** (fail-closed): `/api/init`, `/api/advisor*`,
     `/api/auth/*`, `/api/session/*`, `/api/profile/*`, `/api/push/*`,
     `/api/notifications`, `/api/logos*`, `/api/health`, `/api/poultry`.
     Anything else → `403`, reads included. Finance, payroll, employees,
     customers, credit sales, sales, inventory, assets, procurement, CCTV,
     exports, audit, admin, businesses, integrations, scenarios, daily notes
     and module logs are all unreachable for an advisor.
   * **Write allowlist** (tiny): `/api/advisor/notes`, `/api/advisor/visits`,
     `/api/advisor/digest`, auth/session/profile/push self-service and
     marking own notifications read. `/api/advisor` (grant management) is
     deliberately **not** on it.
   * Fail-closed on unparsable URLs; `ReadOnlyActorError` carries `status=403`
     so `apiError()` renders a real 403 and unmapped throws still become 500.
2. **Scope gate** — `advisorGrantFor()` resolves the live grant (active +
   engagement window + organization) per business; `/api/poultry` GET and
   `/api/advisor/data` re-project their payloads through
   `scopeFarmDataToGrant()` (branch, flock ids, per-scope sections).
3. **Data minimisation** — `projectInitForAdvisor()` strips the bootstrap
   payload: no customers, credit sales, suppliers, employees, transactions,
   assets, scenarios, integrations, AI insights or organizations; only the
   advisor's own user row; money keys removed unless `showCosts` is on.
   The `/api/init` cache key now includes a **grant fingerprint**, so changing
   scopes, cost visibility or revoking can never be served from cache.
4. **Role clamping** — `ADVISOR_FORCED_FLAGS` forces every `can*` permission to
   false and `businessManageIds` to `[]` on create *and* update, so an advisor
   account cannot be quietly upgraded through the users API.
5. **Revocation** — deactivating the last live grant calls
   `endAllSessionsForUser(userId, "REVOKED")`; a re-login yields a session with
   zero accessible businesses.

### Pre-existing holes found and fixed along the way
* `GET /api/integrations` required **no session at all** — now authenticated.
* `GET /api/scenarios` resolved the session outside its `try`, so auth errors
  surfaced as `500` — now inside, returning proper 401/403.
* `GET /api/credit-sales` swallowed typed auth errors into a generic `500` —
  4xx statuses now pass through.

---

## 3. Feature surface

**Advisory notes** (`/api/advisor/notes`) — types OBSERVATION / RECOMMENDATION /
FOLLOW_UP / VISIT_REPORT / RISK, priorities LOW→CRITICAL, ≤4000 chars, up to 4
photos, optional flock link, due date, no future-dating, 30/min rate limit.
Each note is analysed by the existing GoMina AI notes engine (summary,
severity, issue tags) and folded into business insights. `requiresAction`
escalates into the **existing audit pipeline** (`audit_reviews` with
`origin='ADVISORY'`, `CORRECTION_REQUESTED`/`FLAGGED`) so somebody must close
it. Workflow: advisor EDIT (24 h) / WITHDRAW / REPLY; staff ACKNOWLEDGE →
START → DONE → CLOSE / REPLY. Every transition writes a reply row, syncs the
linked issue, notifies the other side and writes the immutable audit trail.

**Visits** (`/api/advisor/visits`) — ON_SITE / REMOTE, PLANNED / COMPLETED /
MISSED. Completing a visit auto-generates a 30-day AI digest, stores it on the
visit and notifies the farm (`ADVISOR_VISIT_SUMMARY`).

**AI Advisory Digest** (`/api/advisor/digest`, `lib/advisorAi.ts`) —
deterministic benchmark engine over six metrics (mortality, FCR, lay rate,
body weight, water:feed ratio, checklist compliance) with GOOD/WATCH/BAD
grading, concerns, prioritised recommendations, **adoption tracking** of past
recommendations, and corroboration of each advisor claim against the data
(CONFIRMED_BY_DATA / PARTIALLY_SUPPORTED / NOT_VISIBLE_IN_DATA). Publishing
writes an `ai_insights` row for the Owner and notifies
(`ADVISOR_DIGEST_READY`), with a 30 s per-user cooldown.

**Notifications** — `ADVISOR_ACCESS_GRANTED/REVOKED`, `ADVISOR_NOTE_NEW`,
`ADVISOR_NOTE_REPLY`, `ADVISOR_NOTE_STATUS`, `ADVISOR_VISIT_SUMMARY`,
`ADVISOR_DIGEST_READY`, mapped to push categories and deep-linking to
`/?tab=ADVISORY`.

**UI**
* `AdvisorWorkspace` — the advisor's entire app: farm picker, read-only chip,
  KPI strip and tabs OVERVIEW / FLOCKS / FEED_WATER / HEALTH / PRODUCTION /
  CHECKLIST / NOTES / VISITS, each gated by the granted scopes. No sidebar, no
  enterprise modules, no finance.
* `AdvisoryConsole` (Owner) — sidebar entry **Farm Advisory**: invite an
  advisor, grant per-farm scopes, cost/export toggles, end date, revoke or
  restore, read the digest, work the note thread.
* `AdvisoryNotesPanel` / `AdvisoryDigestCard` — shared by both sides.
* Users & Access: `ADVISOR` role option and the *Manage Farm Advisor access*
  delegation toggle.

**Migration** — `dev-tooling/migrate-production-schema.mjs` creates the four
advisor tables, the `users.can_manage_advisors` column, `audit_reviews.origin`
and the supporting indexes idempotently (already applied to the sandbox DB).

---

## 4. Verification

| Suite | Result |
|---|---|
| `dev-tooling/verify-farm-advisor.mjs` (API + security + workflow) | **118 / 118** |
| `dev-tooling/verify-farm-advisor-ui.mjs` (desktop + mobile browser) | **37 / 37** |
| `dev-tooling/phase0-authz-matrix.mjs` (regression) | 63 / 63 |
| `dev-tooling/audit-security.mjs` (regression) | 23 / 23 |
| `dev-tooling/verify-audit-access.mjs` | 28 / 28 |
| `dev-tooling/verify-bm-dashboard-access.mjs` | 19 / 19 |
| `dev-tooling/verify-order-page-regression.mjs` | 34 / 34 |
| `dev-tooling/verify-notifications.mjs` | 39 / 43 — the 4 failures are OS web-push *delivery* to external push endpoints, unreachable from the sandbox; unrelated to this change |
| `npx tsc --noEmit` / `eslint` / `npx next build` | clean |

What the advisor suites prove, specifically:
* advisor sees **only** granted businesses; ungranted farm → 403 (data,
  poultry and notes);
* `/api/init` contains no customers, credit sales, suppliers, employees,
  transactions, assets, scenarios, integrations, insights, organizations, no
  other user rows, no money fields, no secrets;
* 20 sensitive GET endpoints refused; 16 write attempts (poultry create/update/
  delete, transactions, inventory, users create/escalate, self-granting access,
  credit sales, audit, checklists, daily notes, CCTV, exports) all refused;
* note lifecycle with AI analysis, linked audit issue, replies both ways,
  advisor cannot close, owner closes, issue reaches a terminal state,
  notifications emitted, audit trail rows written;
* visit → auto digest; digest publish → `ai_insights` + rate limit;
* cost visibility toggles both ways; expiry blocks reads *and* note writing;
  revocation kills the session and survives re-login; reinstatement works;
* owner/GM/BM/worker flows unchanged;
* UI: owner invites + grants + acknowledges + revokes from the console; the
  advisor's workspace renders every tab, digest, metrics and composer on
  desktop **and** on a 390×844 phone with no horizontal overflow and zero page
  errors; a revoked advisor immediately loses the workspace.

All test rows are cleaned up by both suites; live data is left untouched.

---

## 5. How to try it

1. Sign in as the Owner (`kwame.owner@gomina360.com` / `Owner@GoMina26`).
2. Sidebar → **Farm Advisory** → *Advisor access* → invite an advisor
   (note the one-time password) → select the farm, tick scopes → *Grant
   advisory access*.
3. Sign in as that advisor in a separate browser profile: the read-only
   advisory workspace opens straight away.
4. File a recommendation with *Requires action*; back on the Owner side the
   note appears with its AI analysis and a linked audit issue to close.
5. Revoke the grant in the console — the advisor's session ends immediately.
