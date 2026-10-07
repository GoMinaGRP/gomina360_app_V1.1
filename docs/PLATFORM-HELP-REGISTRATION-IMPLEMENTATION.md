# Platform Help/Contact + Join/Register on the Platform — Implementation Report

**Status:** implemented, built, and verified against the running application.
**Branch:** `arena/d3c8cde7-gomina360-app-v1-1` · **Base commit:** `4b575f7`
**Preceded by:** `docs/PLATFORM-HELP-AND-REGISTRATION-AUDIT.md` (the audit this implements).
**Operator guide:** `docs/PLATFORM-INFORMATION-GUIDE.md`.

---

## 1. What was built

The audit's recommendation, implemented in full. A prospective business can now
register from the customer Order Page; the request goes **privately** to the
Platform Owner / Super Admin, who reviews, approves and provisions it; and the
Platform Owner can edit the platform Help/Contact **and** the registration
information shown on the Order Page — from one editor.

### Decisions resolved (the audit's open questions)

| # | Question | Decision & rationale |
|---|---|---|
| 1 | Auto-provision on approve, or two-step? | **Two-step.** *Approve* records a decision; *Provision workspace* creates the account. Creating a live login should never be a side effect of clicking a queue row, and the one-time password must reach a human. |
| 2 | Keep tenant HELP rows too? | **Keep both.** The storefront reads the PLATFORM row; tenant rows stay for future per-owner storefronts and keep `multiowner-verify`'s `?org=` contract green. |
| 3 | Applicant email confirmation? | **No email** (no provider exists). The applicant gets a **reference code** to quote by phone/WhatsApp. Adding a mail provider is separate work. |
| 4 | Turnstile or honeypot? | **Honeypot + two-layer IP throttle.** No new external dependency; the throttle is far tighter than the order endpoint's. |
| 5 | Standalone `/join` or inline in HELP? | **Both, deliberately:** an in-panel platform-branded CTA + footer + login-page link lead to a standalone, shareable **`/join`** page. The HELP modal stays small (its 9-step guide is asserted verbatim by E2E). |
| 6 | Platform edit gate? | **Super Admin for registration config; Super Admin / platform-org OWNER / granted staff for contact details.** Contact text is delegable; opening or closing public registration is not. |

---

## 2. Changes made — file by file

### 2.1 Schema (`src/db/schema.ts`)

**`customer_support_info` — 4 additive columns**
* `is_platform` (bool, default false) — **the scope fix**. Exactly one row is the platform row: what every shopper sees and what the Super Admin edits. Before this, "the platform row" was an accident of `organization_id = 1`.
* `registration_enabled` (bool, default true), `registration_headline` (text), `registration_note` (text) — the public registration CTA config.

**`platform_requests` — new table**
`reference` (unique, opaque `GMR-XXXXXX`) · `purpose` · `status` · business/contact/location/message fields · decision provenance (`decidedBy*`, `decidedAt`, `decisionReason`) · `createdOrganizationId` / `createdOwnerUserId` · non-PII `meta` · indexes on `(status, id)` and `contactEmail`.

> **It deliberately has no `ownerId` and no `businessId`.** Platform-level data has no tenant column to leak through, and no tenant-scoped query can match it. That absence *is* the privacy guarantee.

*Migration:* the repo's existing **schema reconciler** (`dev-tooling/migrate-production-schema.mjs`) picked both up automatically at build time. No hand-written DDL was added — that reconciler exists precisely so `schema.ts` stays the single source of truth. Build log:
```
[db:migrate] created missing tables: platform_requests
[db:migrate] added missing columns: customer_support_info.is_platform,
             customer_support_info.registration_enabled,
             customer_support_info.registration_headline,
             customer_support_info.registration_note
[db:migrate] created missing indexes: platform_requests_status_id_idx,
             platform_requests_email_idx
```

### 2.2 New libraries

| File | Purpose |
|---|---|
| `src/lib/supportInfo.ts` | Server-side scope resolution: `getPlatformSupportRow()` (flagged row, with a **legacy fallback** to org #1's row so an upgrade never orphans published helpdesk text), `supportScopeFor()`, `canEditSupport()`, `canEditRegistration()`. |
| `src/lib/platformRequests.ts` | Client-safe constants + pure validators: the **purpose allowlist** (6 purposes), status list, field caps, email regex, unambiguous reference generator (`GMR-` + no `0/O/1/I`), throttle policy, honeypot name, public copy. Shared by API and UI so they can never disagree. |
| `src/lib/organizationProvisioning.ts` | The **one** provisioning routine (`provisionOrganization`) + `writePlatformTrail` + cache invalidation. |

### 2.3 API routes

**`src/app/api/support-info/route.ts` — rewritten**
* `GET` is still public and still answers **exactly** the same shape (`info` + the 7 fields, `?org=` honoured) — **plus** a new `edit` block when a session is present: `{ scope, canEdit, canEditRegistration, row }`. `edit.row` is the row *this caller's Save will write*, which is the fix for the read/write asymmetry.
* `POST` writes the caller's own scoped row: **PLATFORM** for the Super Admin / platform-org OWNER / granted staff, **ORGANIZATION** otherwise. On first save the platform row is **promoted** (`is_platform = true`).
* The `registration` block is applied **only** for `canEditRegistration` (Super Admin). For everyone else the key is ignored and the published CTA is preserved untouched.
* Error contract preserved verbatim: `401` anonymous, `403` without rights (same wording the suite asserts), `400` bad email.

**`src/app/api/platform-requests/route.ts` — new**
* **`POST` (public)** — two-layer IP throttle (3/min burst, 5/hour sustained) → honeypot → purpose allowlist → name/email/phone validation (Ghana 10-digit via the existing `validatePhone`) → require a reply channel → drop unknown business-type keys → one-open-request-per-email dedupe → unique reference. **Returns only `{ success, reference, message }`.**
* **`GET` (Super Admin)** — the queue, `?status=` filter, per-status counts, `openCount`. Never scoped by `ownerId`.
* **`PATCH` (Super Admin)** — `START_REVIEW · NEEDS_INFO · APPROVE · REJECT · CLOSE · PROVISION`. Reject requires a reason; PROVISION requires a prior APPROVE and refuses to run twice. Every transition writes an audit row with `ownerId = null`.

**`src/app/api/admin/organizations/route.ts` — refactored**
The inline provisioning body was replaced by a call to the shared
`provisionOrganization()`, so the console form and an approved request create an
Owner **identically**. The route's observable contract is unchanged:
`400` invalid input, `409` duplicate email, one-time password returned once.

### 2.4 Notifications (`src/lib/notify.ts`, `src/lib/push.ts`)

* `platformOwnerRecipients()` — active `isSuperAdmin` users; **not** derived from any business or organisation.
* `notifyPlatformRequest()` — one bell row per Super Admin, deduped on `(userId, type, recordRef)`, then `pushAfterBell`. Rows carry **`businessId: null` and `ownerId: null`** and the body carries **no personal contact details** (a lock screen is not the place for an applicant's phone number). Errors are swallowed so a notification failure can never fail the applicant's submission.
* `push.ts`: `PLATFORM_REQUEST_NEW → "messages"` category (existing category, no schema change) and a `urlForNotification` mapping to `/?tab=PLATFORM_ADMIN`.

### 2.5 UI

| File | Change |
|---|---|
| `src/components/CustomerSupportModal.tsx` | Loads `edit.row` (the row Save will write). New **"Join GoMina 360 — registration"** section, rendered only for the Super Admin, with on/off, headline, note and a *Preview the public sign-up page* link. Save message now says which row was written. |
| `src/components/PlatformRequestsPanel.tsx` | **New** review queue: status filters with counts, expandable rows, full submission detail, the six actions, reason box, and the one-time-password banner. |
| `src/components/PlatformAdminPanel.tsx` | Mounts the requests panel **above** the provisioning form (an inbound request is the first thing a platform owner needs to see). |
| `src/app/join/page.tsx` | **New** public registration page: purpose selection (6 options), business/contact/type/location/message, honeypot, success screen with a copyable reference code, published contact channels, and a "registration is closed" state. |
| `src/app/order/page.tsx` | Platform-branded **"Join GoMina 360"** block inside HELP + a footer join line, both rendered only while registration is enabled. Wording is about the *platform*, never the browsed shop, and carries *"not to any shop on this page"*. |
| `src/components/LoginScreen.tsx` | "Want your business on GoMina 360? Register it" → `/join` — rendered only when the server-resolved `showRegistrationInvite` prop is true (the Super Admin's login-page switch, **off by default**; see `src/app/page.tsx`, ISR). |

### 2.6 Tooling

* `dev-tooling/verify-platform-registration.mjs` — **new** 66-assertion E2E suite (§5). Self-cleaning: a marker-based sweep in section Z removes every artifact it made regardless of how the run ended, including `company_settings` rows orphaned by a deleted organization.
* `dev-tooling/seed-platform-request-demo.mjs` — idempotent, clearly-marked **DEMO ·** request created through the real public API, so the console has something to show on a fresh deployment.
* `dev-tooling/seq-realign.mjs` — **new** shared, forward-only serial-sequence realignment used by both migrators (issue **9**).
* `dev-tooling/audit-notify-verify.mjs` — fixture hygiene: its pinned `TRK-TEST-9099` tracking row is cleared before re-creation, so a previously killed run can no longer poison every later run (issue **12**).

---

## 3. Issues found and resolved during implementation

| # | Issue | Resolution |
|---|---|---|
| **1** | **Platform audit rows were being attributed to a tenant.** `writePlatformTrail` kept a `?? actor.orgId` fallback, so platform events landed with `owner_id = 1` — the exact leak the design forbids. | Removed the fallback in `writePlatformTrail` (`ownerId ?? null`, with a comment explaining why). The tenant-scoped `writeAdminTrail` keeps its own fallback, so console behaviour is unchanged. Suite assertion **C5** now pins it. |
| **2** | **The editor loaded one row but saved another** (audit finding F3). | `GET /api/support-info` now returns `edit.row`, and the modal renders *that*. The platform editor's form is now provably the published row (assertion **D7**). |
| **3** | **A tenant-scoped grant could edit platform content** (audit finding F4). | Split the gate: `canEditSupport` (contact text, delegable) vs `canEditRegistration` (platform recruitment policy, Super Admin only) — `registration` survives a granted staffer's save untouched (**D11**), and the grant does **not** unlock the review queue (**B4**). |
| **4** | **A bot could tune around the honeypot** by receiving a distinguishable response. | The honeypot answers with the generic success text and **stores nothing** (**A9**). |
| **5** | **Duplicate submissions would flood the queue** and leak an existing reference code to a stranger. | One open request per email; the second submission gets a friendly "we already have your request" with **no reference** (**A10**). |
| **6** | **An unknown business type was implicitly accepted.** | The validator now drops any key not in `BUSINESS_TYPES` (**A4** pattern). Discovered live when the demo seeder used `PROVISION_SHOP`, which is not a real type — the row correctly stored `null`. Seeder corrected to `HARDWARE_STORE`. |
| **7** | **`/join` could not import the purpose list** from `lib/businessTypes` (that module imports the DB, so it is not client-safe). | Pointed the new lib at the pure `lib/businessTypeKeys` registry — the same split the codebase already uses. |
| **8** | Two *pre-existing* data-drift failures in `order-audit` / `comprehensive-order-audit`. | **Proven not mine** (§5.4): the same failures reproduce byte-for-byte on the stashed baseline build. |
| **9** | **Every build rewound serial sequences, so primary keys of deleted rows were handed out again.** `migrate-production-schema.mjs` realigned each sequence with `setval(seq, max(id), …)` — correct when the repair was written, but it also moves a sequence *backwards* whenever the highest rows were deleted (test cleanup, demo reset, deleted organization). Id reuse is unsafe in this schema: a leftover `company_settings` row for a deleted organization (unique `organization_id`) then made the next `insert into company_settings` fail. | New shared helper `dev-tooling/seq-realign.mjs`: `setval(seq, greatest(max(id), current_value), (count(*) > 0) or is_called)` — **forward-only**, so ids are never reused; an empty, never-used table still starts at 1. Both migrators (build-time reconciler and sandbox bootstrap) now use it, and the reconciler logs `[seq] … realigned forward-only (never rewound)`. |
| **10** | **Provisioning was not atomic** — the organization, Owner, membership, ownership link and settings row were six independent writes, so any failure left a half-built workspace (an orphan organization nobody can sign in to, and — when reached from a registration request — a request that could never be provisioned). The failure was real, not theoretical: it fired mid-suite as `duplicate key value violates unique constraint "company_settings_org_uq"` **after** the organization and Owner rows already existed. | All writes now run in **one `db.transaction`** (either the whole workspace lands or nothing does), the settings insert is `onConflictDoNothing` so a legacy stale row can never abort a provision, and a unique-violation race is mapped to the same clean `409` the pre-check gives instead of a raw `500`. `setUserPassword` gained an optional executor so it joins the caller's transaction. The **409-recovery** path (§2.3) stays as defence-in-depth for databases that already contain an orphan. |
| **11** | **A build-time backfill re-attributed platform bell rows to a tenant.** `update notifications set owner_id = 1 where owner_id is null` ran on **every build** and re-stamped the deliberately platform-scoped `PLATFORM_REQUEST_NEW` rows with `owner_id = 1` — undoing the privacy guarantee of §4.1 after the fact. It also ran *before* the recipient-org derivation, so tenant rows with no business could be mis-attributed to organization 1 as well. (The suite's **C2b** caught this; an earlier reading of the same symptom as a stale artifact was wrong.) | Tenant derivation is now ordered business → recipient organization, the recipient rule **skips platform-scope types**, the org-1 fallback applies only to rows that carry a business, and an idempotent repair clears the stamp the old backfill put on `PLATFORM_REQUEST_NEW` rows. Verified across two consecutive full builds: the demo bell row stays `business_id = null, owner_id = null`. |
| **12** | `audit-notify-verify` **self-poisoned**: it pins `TRK-TEST-9099`, which is unique, so a killed run left the row behind and every later run died on `customer_trackings_tracking_code_unique`. | The fixture is deleted (tracking + notification) before it is re-created. Suite back to **13/13** in isolation *and* inside the full battery. |

| **13** | **Clicking a platform-request notification did nothing useful.** The bell row's click handler in `GoMinaApp` had branches for audit, approval, task, advisor, order, pre-order, transport, stock, checklist, credit, purchase — and then a fallback to the Command Center. `PLATFORM_REQUEST_NEW` matched **none** of them, so the operator was dropped on the Command Center instead of the review queue. The bell's own destination tag was equally generic ("Open Record"). | A dedicated branch now runs **first** (before the type-prefix collisions), reads the reference out of `recordRef` (`platform-request:<REF>`) and opens the Platform Owners console with that request expanded. The bell tag says **"Platform Requests"**. Web-push deep links carry `&request=<REF>` and are parked/consumed like `?tab=` (so they survive the login wall). Suite **F7–F9** click the real bell row; **F15** drives the push deep link. |
| **14** | **A decision never synchronised the notification.** Approving or rejecting a request left its bell row **unread** with the title "New platform request" forever — the badge nagged about finished work and lied about the state. There was no code path that updated or retired it. | `syncPlatformRequestBells()` rewrites the row's title/body to the **current** state on every decision, and marks it read the moment nothing is left to do. It never *un*-reads a row. Titles now name the next action: "Platform request approved — provision the workspace" → "Platform request fulfilled — workspace created" / "Platform request rejected". The review panel nudges the bell over a `gomina:notifications-refresh` event so the badge updates instantly instead of within 30 s. **F11, F14, F17**. |
| **15** | **The request never reached the Action Center.** Platform requests were nowhere in `/api/tasks` or the Action Center UI — the platform owner's own "what do I owe" board could not see the queue it is responsible for. | New `linkedPlatformRequests()` source + `linked.platformRequests` in `/api/tasks` + a **"Platform registrations awaiting you"** section in the Action Center, each row carrying a **"Review request · <REF>"** deep link. Super-Admin gated (never derived from a business scope). **F4–F6**; the button was also clicked in a real browser. |
| **16** | **The queue badge disagreed with reality.** `openCount` ("Needs attention") counted only PENDING/IN_REVIEW/NEEDS_INFO, so an **APPROVED request awaiting its workspace** vanished from the badge while still being unfinished work — and the Action Center would have counted it. | One shared predicate — `isPlatformRequestActionable(status, createdOrganizationId)` — now drives the badge (SQL form), the linked list, the mirror sweep **and** the bell title. Four surfaces, one rule. **F12–F13**. |
| **17** | **"Track as task" was impossible and, once possible, forgeable.** The bell's convert-to-task button posted `sourceType: "NOTIFICATION"` for these rows, and `/api/tasks` requires the source notification to be *the caller's own* — always true here, so it worked by accident; but there was no way to distinguish a platform action, no auto-completion, and the Action Center row had no working track path. | A first-class `PLATFORM_REQUEST` source type: **Super-Admin only**, text and linkage **derived server-side from the request** (never trusted from the client), `businessId: null` so no tenant scope is invented, and the daily sweep closes the mirror automatically once the request is decided (`isPlatformRequestActionable` again). **F19–F23** — including a forced real `/api/cron/daily` sweep. |
| **18** | **A focused request could be hidden by the active filter.** A notification click for a decided request (e.g. just rejected) would try to expand a row that the default "Needs attention" filter does not render. | The panel falls back to the **unfiltered** view when the focused reference is not in the current filter, then expands, scrolls and ring-highlights the row. |
| **19** | **Sandbox-wipe resilience gap (process, not product).** A full sandbox wipe destroyed `node_modules`, `/tmp/al2023` (chromium) and the Postgres cluster; `dev-tooling/preview-up.sh` rebuilt everything in one command and the platform demo seed/CTA were re-published on top. Recorded here because it is now a known recovery path, not a surprise. | `bash dev-tooling/preview-up.sh` → live app; then `node dev-tooling/seed-platform-request-demo.mjs` + publish the platform Help row. |

---

## 4. Security & permission verification

### 4.1 The privacy chain

| Layer | Guarantee | Verified by |
|---|---|---|
| Table | `platform_requests` has **no `ownerId` / `businessId`** column at all | Schema; no tenant query can match it |
| Read | `GET` gated on `requireSuperAdmin()` | **B1** (anon 401), **B2** (GM 403), **B2** (BM 403) |
| Write | `PATCH` gated on `requireSuperAdmin()` | **B3** (non-SA 403) |
| **Grant boundaries** | the OWNER-granted `canManageSupport` — which unlocks the storefront editor — does **not** unlock the queue | **B4** |
| Bell | rows written `businessId: null`, `ownerId: null`; `/api/notifications` filters `userId = me` | **C1**, **C2**, **C3** |
| Payloads | no reference appears in a tenant's `/api/init` | **C4** |
| Audit | platform decisions written `ownerId: null`; invisible to tenant audit feeds | **C5**, **C6** |
| Provisioned account | normal org OWNER, `is_super_admin = false`, exactly one membership | **B13**, **C7**, **C8** |
| Token surface | the anonymous POST returns only an opaque reference — no id, row, count or status | **A2** |
| Middleware | `src/proxy.ts` default-denies `/api/*` for the FARM_ADVISOR role; the new endpoints were **not** added to its allowlist | design review |

### 4.2 Public-input hardening (the anonymous POST)

* Two-layer throttle: **3/min** burst + **5/hour** sustained per IP → `429` + `Retry-After` (**A11**), with a generic message that leaks nothing (**A12**).
* Honeypot (**A9**), purpose allowlist (**A4**), email format (**A5**), Ghana 10-digit phone (**A6**), reply-channel required (**A7**), 2-character minimum name (**A8**).
* All fields trimmed and length-capped; unknown business-type keys dropped.
* Raw IPs are **never persisted** — only the existing salted `hashClientIp` digest, plus a UA summary, in `meta`.
* `apiError()` sanitises DB/framework internals out of 5xx responses.

### 4.3 Lifecycle safety

* Approve is a **decision**; provisioning is a separate **action** (**B11**).
* Provisioning before approval → **409** (**B9**); a second provisioning of the same request → **409** (**B14**) — no duplicate accounts.
* Rejection requires a reason (**B8**); unknown action → **400** (**B7**); unknown request → **404** (**B15**).
* The one-time password is returned once to the Super Admin only — never persisted, never inside a notification body.
* Console lifecycle regression-checked live: `SUSPEND → ACTIVATE → DELETE_ORGANIZATION (typed confirm) → RESTORE`, with the wrong typed name correctly refused `400`.

### 4.4 Backward compatibility

| Contract | Status |
|---|---|
| Public `GET /api/support-info` shape and `?org=` param | **unchanged** (extra `edit` key added; `null` for anonymous — **D1–D3**) |
| Anonymous `POST` → 401; non-granted → 403 with the **same wording**; bad email → 400 | **unchanged** (base suite **A1–A10**) |
| Per-org read-back (`multiowner-verify`) | **passes** (org B read back per-org; org 1 unaffected) |
| `POST /api/admin/organizations` statuses & one-time password | **unchanged** (`multiowner-verify` 409-duplicate + `verify-staff-access-grouping` P4 pass) |
| Storefront HELP panel: 9-step guide, hidden-until-tapped, footer link | **unchanged** (base suite **C3–C3d, C11, C12**; new suite **E5**) |
| Notification fan-out for all existing types | **unchanged** (`audit-notify-verify` 13/13) |

---

## 5. Test results

### 5.1 New suite — `verify-platform-registration.mjs` → **89 passed, 0 failed**

```
— A · Public submission (anonymous) —                       12 assertions (A1–A12)
— B · Private review — permissions & lifecycle —            20 assertions (B1–B17b)
— C · Privacy — platform requests never reach a tenant —     9 assertions (C1–C8, C2b)
— D · Platform Help/Contact scope —                         11 assertions (D1–D11)
— E · Storefront & sign-up UI —                              9 assertions (E1–E9)
— F · Notification → Action Center → decision workflow —    23 assertions (F1–F23)
— Z · Cleanup & forensics —                                  5 assertions (Z1–Z5)
```

`B17a/B17/B17b` cover the recovery contract end-to-end: a workspace created
outside the request is **adopted** (never duplicated, never orphaned) when the
request is retried, and exactly one account exists for the applicant's email
afterwards.
Real headless Chromium + live Postgres, self-cleaning: **Z1–Z4** prove the
support row is restored byte-for-byte, no request/organisation/User is left
behind, and live data is byte-identical to suite start; **Z5** proves zero
console/page errors.

### 5.2 Regression suites — all green

| Suite | Result | What it protects |
|---|---|---|
| `verify-storefront-help.mjs` | **47 / 47** | the published support API, the grant lifecycle, the HELP panel, the 9-step guide |
| `multiowner-verify.mjs` | **118 / 118** | multi-tenancy, `?org=` support read-back, org lifecycle, provisioning + 409 duplicate |
| `verify-staff-access-grouping.mjs` | **27 / 27** | Super-Admin provisioning through the **refactored** route (P4) |
| `verify-permissions-storefront.mjs` | **48 / 48** | storefront permission boundaries |
| `audit-notify-verify.mjs` | **13 / 13** | the notification/push pipeline my changes extend |
| **Total** | **342 assertions, 0 failures** (final battery: 89 + 47 + 118 + 27 + 48 + 13) | |
| `order-audit.mjs` | 49 / 51 (pre-existing, §5.4) | storefront pre-order fixtures |

Plus: `tsc --noEmit` clean · ESLint **0 errors** on every changed file ·
production build clean · full `SUSPEND → ACTIVATE → DELETE → RESTORE` console
lifecycle re-verified by hand after the refactor.

### 5.3 Live demonstration on the running preview

* Seeded platform Help/Contact content + the registration CTA; the Help/Contact
  panel now serves real content instead of the "being set up" empty state.
* Demo request (`DEMO · Sunyani Hardware & Provisions`) created through the
  **real public API** — `node dev-tooling/seed-platform-request-demo.mjs`, which
  is idempotent and prints the reference it created (e.g. `GMR-GYWJD2` on the
  current build); the Super Admin's bell fired; the console shows
  **"Needs attention · 1"**.
* Screens verified: `/join` form, the HELP panel's Join block, and the Platform
  requests console with a fully expanded request.

### 5.4 Pre-existing failures (NOT regressions) — proven by baseline test

`order-audit` (2 failures) and `comprehensive-order-audit` (1 failure) fail
**identically on the un-modified baseline build**:

1. I stashed every change (`git stash push -u`), rebuilt, restarted, and re-ran both suites.
2. Both reproduced the **same** failures: `order-audit` → `preorder.offers-visible` / `preorder.in-cart`; `comprehensive-order-audit` → assertion **[23]**.
3. Restored the stash and confirmed the working tree matched the pre-stash file list exactly.

Root causes (test-fixture data drift, unrelated to this work):
* `order-audit`'s `preorderJourney()` hardcodes `/order?biz=9` and expects pre-order
  offers there, but `fixtures-e2e` places them on businesses **1** and **6**, and
  `biz=9` is `BOUTIQUE-01` (no offers). Re-running the fixture chain does **not**
  satisfy this hard-coded id.
* `comprehensive-order-audit` failed at **different** assertions on successive runs
  (#35 → #23 → different on baseline), the signature of timing flakiness in its
  map-pin/autocomplete steps.

### 5.5 Direct evidence for the three platform-level defects (issues 9–11)

Each fix was proved against the running application, not just re-tested:

| # | Experiment | Before the fix | After the fix |
|---|---|---|---|
| **9** | Compare a serial sequence with its table's `max(id)` immediately before and after a build, with the highest rows deleted (`max(organizations.id) = 2`, sequence at `9`). | The old statement (`setval(seq, max(id), …)`) rewinds: next organization id becomes **3** — an id whose rows were already deleted. | Build log: `[seq] 144 serial sequence(s) realigned forward-only (never rewound)`; the sequence **stayed at 9**. |
| **10** | Re-arm the exact production state that produced the `500`: plant a leftover `company_settings` row for the id the sequence is about to hand out, then provision through `POST /api/admin/organizations`. | `500 · Failed query: insert into "company_settings" … duplicate key value violates unique constraint "company_settings_org_uq"` — *after* the organization and Owner had been inserted (orphan workspace). | `200` with a complete workspace (`organization.id = 10`, Owner created, settings row absorbed) and no orphan. |
| **11** | Publish a demo request, then run two consecutive full builds and inspect the bell row. | The first build re-stamped the platform row: `business_id = null, owner_id = 1`. | Two builds in a row leave it at `business_id = null, owner_id = null`; suite **C2b** ("no `PLATFORM_REQUEST_NEW` row anywhere carries a tenant id") passes on every run. |

### 5.6 The workflow contract (what §F pins down)

```
  business submits /join
        │
        ├─► platform_requests row (PENDING)  ──────────────► review queue (badge counts it)
        │
        ├─► BELL: unread, businessId=null, ownerId=null,
        │         title "New platform request",
        │         click → console + that request EXPANDED
        │
        └─► ACTION CENTER: "Platform registrations awaiting you"
                  "Track as task" ─► mirror task (auto-closes on decision)
                  "Review request · REF" ─► console + that request EXPANDED

  APPROVE ──► bell title "…approved — provision the workspace" (still unread)
          └─► still in the Action Center + badge (provisioning is owed)

  PROVISION ─► bell "…fulfilled — workspace created" (READ)
            └─► gone from the Action Center + badge — request complete

  REJECT  ──► bell "Platform request rejected" (READ)
          └─► gone from the Action Center + badge — request complete
```

| Agreement | Guarantee | Verified by |
|---|---|---|
| Bell created, private | unread; `business_id`/`owner_id` NULL | **F1–F2** |
| Bell text | title names the *outstanding action* at every stage | **F3, F11, F17** |
| Bell click | lands on the console with that request expanded + actions visible | **F7–F9** |
| Push deep link | `/?tab=PLATFORM_ADMIN&request=<REF>` focuses the request (survives the login wall) | **F15** |
| Action Center | listed while actionable, with a reference-carrying deep link | **F4–F5** |
| Action Center click | "Review request · REF" focuses that request (clicked in a real browser) | manual browser check |
| Action Center privacy | not visible to GM/BM/any non-Super-Admin | **F6, F21** |
| Queue badge | counts approved-but-unprovisioned work too | **F13** |
| Terminal sync | rejected/provisioned requests leave the badge, the list and the unread bell | **F17–F18** |
| No re-nagging | an unopened row stays unread while work is owed | **F14** |
| Mirror task | server-derived, platform-scoped, auto-closed by the daily sweep | **F19–F23** |

---

## 6. Operator quick-start

Full detail in **`docs/PLATFORM-INFORMATION-GUIDE.md`**. The short version:

| Task | Path |
|---|---|
| Edit platform help/contact (phone, email, hours, notes) | Sidebar → **Settings & Storefront** → **Support — Storefront HELP** |
| Turn the Join invite on/off, change its headline | same editor → fuchsia **Join GoMina 360 — registration** block *(Super Admin only)* |
| Review registrations | Sidebar → **Platform Owners** → **Platform requests** |
| Approve → create the account | expand request → **Approve** → **Provision workspace** → copy the one-time password |
| Housekeeping | the build reports `company_settings` rows that reference a deleted organization (harmless — see the guide); serial sequences are now repaired forward-only and never reuse an id |
| Follow a request end-to-end | bell 🔔 → click the row → the request opens expanded → **Approve** → **Provision workspace**; the same request is also listed in the **Action Center** under *Platform registrations awaiting you* |

---

## 7. Deliberately out of scope (roadmap)

1. **Email notifications** — no provider exists in the project; the reference code covers the gap. Adding one (Resend/SES + a `mail.ts` helper) would let decisions and confirmations reach applicants automatically.
2. **Applicant status lookup** — intentionally omitted: any public read surface is an enumeration risk. A signed, single-use link per request would be the safe way to add it.
3. **Cloudflare Turnstile** — honeypot + strict throttle first; add if junk arrives.
4. **Per-owner storefronts** — `organizations.slug`, the tenant support rows and the `?org=` contract are all still in place for that work.
5. **Redis-backed rate limiting** — `rateLimit.ts` remains per-process, matching the documented single-node deployment assumption.
