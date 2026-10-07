# Customer Order Page — Help/Contact Section, Platform Help & Contact, and Join/Register on the Platform

**Status:** audit + recommendation only. **No application code was changed.**
**Scope:** what the Order Page HELP/Contact section is today; whether it can carry (a) *Platform Help/Contact* and (b) a *Join/Register on the Platform* request form with a purpose-of-contact selection; how such requests should be routed **privately to the Platform Owner / Super Admin** for review, approval/rejection and management; and how the Platform Owner should edit the platform Help/Contact and registration information shown on the Order Page.
**Branch:** `arena/d3c8cde7-gomina360-app-v1-1` · **Base commit:** `4b575f7` (tree clean)

---

## 1. Executive summary

**Yes — the Help/Contact section is the right place, and roughly 70 % of the machinery already exists.** But the existing pieces are wired for *tenants*, not for *the platform*, and three things are missing outright:

1. **There is no acquisition path at all.** A repo-wide search for any join / register / sign-up / onboard / lead / enquiry-request concept returns **zero** matches in `src/`. A business that wants to use GoMina 360 has no way to ask for it — not on the Order Page, not on the login page (`/`), nowhere. The `Platform Owners` console (`PlatformAdminPanel`) only supports the Super Admin *typing in* a new Owner's details himself; there is no inbound channel.

2. **The storefront HELP panel is tenant support, not platform support** — and the two are conflated in one table (`customer_support_info`) with an implicit, hard-coded org-1 default on read and a *different* organisation on write. That asymmetry is the single most important structural flaw to fix before adding anything to this panel.

3. **The notification machinery cannot address "the Platform Owner".** Every notification path is tenant-scoped: `fanOut()` requires a `businessId`, and `orderNotificationRecipients()` only ever returns members of the business's own organisation. There is no platform-scope recipient resolver, and no email delivery capability exists in the project at all (no provider in `package.json`) — so "privately notify the Super Admin" must mean **bell + web push** unless email is added.

Conversely, the security foundation needed for the private half is **already in place and battle-tested**: `users.isSuperAdmin` (`src/db/schema.ts:113`), `requireSuperAdmin()` (`src/lib/auth.ts:509`), a Super-Admin-only `/api/admin/organizations` lifecycle route, a bell that only ever returns the caller's own rows (`/api/notifications` filters `userId = me`), an immutable `audit_trail`, a public-write pattern already proven by `/api/order` (IP throttle → validate → kill-switch checks), and an approval-inbox UI precedent (`approval_requests` + `ApprovalInbox.tsx`).

**Recommendation in one line:** keep the HELP panel as the *surface*, introduce an explicit **platform scope** for its Help/Contact content, and add a **platform-level request pipeline** (`platform_requests` table + anonymous POST + `requireSuperAdmin`-only review + approve→provision reusing the existing org-creation logic) — never tenant-scoped, never listed to anyone but the Super Admin.

---

## 2. What actually exists today

### 2.1 The Order Page HELP/Contact section

`src/app/order/page.tsx` (2 453 lines) is the public storefront — **no sign-in needed**, and by design a *centralized marketplace*: `/api/menu` serves sellable stock from **every ACTIVE organisation** (`src/app/api/menu/route.ts:100-109`, comment: *"Shared centralized marketplace across ALL participating organizations"*).

The HELP surface is a modal, opened from three places:

| Entry point | Location |
|---|---|
| Header `HELP` button | `src/app/order/page.tsx:1327-1336` (`data-testid="oo-help"`) |
| Footer link | `:2184-2190` (`oo-help-footer`) |
| Two close buttons | `:2213-2221`, `:2323-2328` |

The modal (`:2192-2330`) contains exactly **two** sections:

1. **`oo-help-info` — "Customer support"** (`:2226-2300`): renders up to seven fields from `GET /api/support-info` — `contactName`, `phone` (tel:), `whatsapp` (wa.me), `email` (mailto:), `address`, `openingHours`, `extraInfo`. Empty state (`:2296-2299`) reads *"Our support contacts are being set up — please check back soon."*
2. **`oo-howto` — "How to use this order page — 9 quick steps"** (`:2302-2320`): derived from module-scope `HOWTO_STEPS` (9 entries, `:235-245`), whose count is re-used in the intro blurb (`:1378-1381`), the section heading and the footer so the copy can never drift.

There is **no** registration, enquiry, contact form, or platform CTA in the panel. The only customer-writable public endpoint on this page is `POST /api/order`.

Two separate contact concepts already coexist and are already kept apart deliberately:

- **Platform/org helpdesk** → `customer_support_info` (the HELP panel).
- **The selling shop's own line** → `businesses.customerHelpPhone` → `businesses.contactPhone`, resolved by `src/lib/shopContact.ts`, which states explicitly at the top: *"Organisation-level support info is deliberately NOT used here — it is the platform/tenant helpdesk (per-organisation), not the selling shop."* It powers the product-card Call/WhatsApp/Directions chips (`order/page.tsx:416-420`) and the `/track` seller block.

So the page already distinguishes "the platform's helpdesk" from "this shop's line" — but only for *shop* contact. The platform side has no such explicit model.

### 2.2 The support-info store and API

`customer_support_info` (`src/db/schema.ts:413-427`) — **one row per organisation**:

```
id · contactName · phone · whatsapp · email · address · openingHours · extraInfo
updatedByUserId · updatedByName · updatedByRole · organizationId · updatedAt
```

`src/app/api/support-info/route.ts`:

- **GET (`:35-72`) is fully public** — no session. It reads `?org=<id>`, **defaulting to `1`** (`:40-41`), returns the seven fields plus `updatedByName/updatedAt`, `Cache-Control: no-store`. The code comment describes org 1 as *"Centralized marketplace ⇒ organization #1 (GoMina Group) runs platform support"* and the param as *"reserved for future per-owner storefronts"*.
- **POST (`:74-140`) requires a session** and is allowed when `user.role === "OWNER"` **or** `user.canManageSupport` (`:79-84`). It writes to `orgId = session.orgId ?? 1` (`:108`) — i.e. **the caller's own organisation**, not the org whose row the GET returned. Server-side length caps (`:19-27`), email regex (`:100`), and `updatedBy*` stamping.

Editor UI: `src/components/CustomerSupportModal.tsx` (250 lines). Its gate is `allowed = isOwner || !!currentUser?.canManageSupport` (`:50`); it **loads** with `fetch("/api/support-info")` — no org param (`:59`) — and **saves** with the same URL (`:118`).

Reachability: nav row `SUPPORT — "Support — Storefront HELP"` (`src/lib/navManifest.ts:548-557`), eligible `hasSupportEditor && (role === "OWNER" || canManageSupport)`; launched from the Command Center (`GoMinaApp.tsx:1164-1166`) and the sidebar. The `canManageSupport` grant itself is OWNER-only and toggled in `UserAccessConsole.tsx:455` (`perm-support-info`).

### 2.3 Permissions — the platform/tenant boundary

| Concept | Where | Meaning |
|---|---|---|
| `users.isSuperAdmin` | `schema.ts:113` | *"Platform-level Super Admin (the Main Owner) — administers organizations and may read across them; normal org OWNERs never gain this flag."* |
| `requireSuperAdmin(request)` | `auth.ts:509-513` | Session + `isSuperAdmin`, else `null`. |
| `requireOwnerSession` | `auth.ts:504-506` | Session + `role === "OWNER"`. |
| `canManageSupport` | `schema.ts:91` | OWNER-granted *"Customer Support — storefront HELP"* permission. |
| `canViewFinance`, `businessManageIds`, `canCreateBusiness`, … | `schema.ts:80-104` | The established "OWNER grants a scoped capability" pattern. |

The Super Admin flag is granted only by the migration (`dev-tooling/migrate-multiowner.mjs:43`, `migrate-production-schema.mjs:501`: `UPDATE users SET is_super_admin = TRUE WHERE id = 1`). In the seeded production dataset the Super Admin **is also org 1's OWNER** — which is why the org-1 coupling below has never surfaced as a bug.

`/api/admin/organizations` (`src/app/api/admin/organizations/route.ts`) is the **only** place `requireSuperAdmin` is used (3 references, 1 file). Its `POST` (`:114-216`) is a complete, correct provisioning routine: validates inputs → enforces globally-unique login email → derives a unique `slug` → inserts `organizations` row → inserts the OWNER `users` row (`isSuperAdmin: false`, `primaryOrgId`) → sets a one-time password → inserts `organization_members` → writes `company_settings` → writes an immutable audit row via `writeAdminTrail()`. It returns `initialPassword` **once**.

Its errors are the ones a review pipeline must reuse: `409` on duplicate email, `400` on invalid email.

### 2.4 Notifications, push, audit — and their scope limits

| Piece | File | Scope |
|---|---|---|
| `notifications` table | `schema.ts:3045-3069` | `userId` (recipient), `businessId` (nullable, but see below), `ownerId` (tenant), `type`, `recordRef`, `isRead`; indexes on `businessId`, `(userId,id)`, `ownerId` |
| `GET /api/notifications` | `api/notifications/route.ts:20` | `where(eq(notifications.userId, user.id))` → **inherently private per user** |
| `notify.ts` helpers | `lib/notify.ts` (608 lines) | `orderNotificationRecipients` (`:53`), `notifyPurchase`, `notifyPoultryStageTransition`, `notifyChecklistOverdue`, `notifyApprovalRequest`, `notifyApprovalDecision`, `notifyDunning` |
| `fanOut()` | `lib/notify.ts:94-153` | **Requires `businessId: number`**, resolves `ownerId` from the business, dedupes on `(userId, type, recordRef)`, then fires push |
| `orderNotificationRecipients()` | `lib/notify.ts:53-92` | Returns only users who are members of *that business's organisation* — *"A notification can never cross to another Owner's users."* |
| Push | `lib/push.ts` | Categories `orders · approvals · alerts · tasks · messages · reports` (`:26-27`); `urlForNotification()` (`:55`) maps type → deep link |
| Audit | `lib/audit.ts:5` + `schema.ts:3115-3134` | `action`, `targetType`, `targetLabel`, `detail`, `ownerId` (**nullable**) — free-text targetType, already used for `ORGANIZATION` |
| Approvals | `schema.ts:3960-3986` + `lib/approvals.ts` + `ApprovalInbox.tsx` | **The workflow precedent**: `status PENDING · APPROVED · REJECTED · CANCELLED`, `requestedBy*`, `decidedBy*`, `decidedAt`, `decisionReason` — but `ownerId` and `businessId` are both `NOT NULL`, so it cannot host a platform request as-is |

`notify.ts:53` also carries the privacy invariant that must be preserved: *"A notification can never cross to another Owner's users."*

### 2.5 Anti-abuse primitives already available

- `src/lib/rateLimit.ts` — in-process sliding window, `throttle(ip, { key, limit, windowMs })` → `429` + `Retry-After`; `clientIp()` takes the first `x-forwarded-for` hop.
- `src/app/api/order/route.ts:30-58` — the reference **public write** flow: `throttle(clientIp(request), { key: "order", limit: 30, window_ms: 60_000 })` → validation → business-status check → **organisation suspension kill switch** → feature flags.
- `src/lib/phone.ts` — `validatePhone(…, { exactDigits: PHONE_EXACT_DIGITS_STOREFRONT })` (Ghana 10-digit rule).
- `src/lib/apiError.ts` — sanitizes DB/framework internals out of 5xx responses.
- CSRF posture is sound for a JSON POST: the session is an `httpOnly, SameSite=Lax` cookie (`lib/auth.ts:12,20`) with a header-based secondary channel; `SameSite=Lax` means a cross-site form POST does not carry the cookie.
- `src/proxy.ts` — **FARM_ADVISOR default-deny** over `/api/:path*` with an explicit allowlist. Anonymous and non-advisor sessions pass straight through; an advisor hitting an unlisted path gets `403` *before* route code runs.

### 2.6 Documentation / test contracts that constrain changes

- `dev-tooling/verify-storefront-help.mjs` — A1–A10 (public GET `200`; **anonymous POST `401`**; GM/BM without grant `403`; no self-grant; grant → POST `200` → GET serves it; revoke → `403`; invalid email `400`), B (editor UI + toggle round-trip), C3/C3b/C3c (HELP modal, **9**-step guide, every action label in the guide exists verbatim in the DOM), Z (fixture purge, live data byte-identical).
- `dev-tooling/multiowner-verify.mjs:261-272` — asserts **per-org** support-info read-back via `?org=<id>`, including that org 1 stays unaffected by org B's write. Any change to the `?org=` contract must keep this green.
- `docs/CUSTOMER-ORDER-TRACKING-AUDIT.md`, `docs/MULTI-OWNER-PLAN.md` — prior art for the storefront and tenancy decisions.

---

## 3. Current issues

Severity: **S1** must fix before shipping any feature here · **S2** should fix · **S3** nice to fix.

### F1 — No acquisition path exists (S1)
Zero references to any join/register/onboard/lead/demo-request concept in `src/`. The login page (`src/app/page.tsx` / `LoginScreen.tsx`) offers no "new here?" route, and the Order Page HELP panel is support-only. A prospective business has **no way to reach the platform owner**. This is the gap the feature is meant to close — worth stating plainly because it means there is no legacy flow to preserve.

### F2 — "Platform" Help/Contact is implicit and hard-coded (S1)
The storefront HELP panel shows org 1's row because `GET /api/support-info` **defaults to `orgId = 1`** when no `?org=` is passed (`support-info/route.ts:40-41`), and `order/page.tsx:744` passes nothing. Nothing in the data model says "this row is the platform's"; it is an accident of "GoMina Group happens to be organisation #1". The storefront is explicitly a *centralized marketplace across all organisations*, so its HELP content is by definition **platform-scope** — it should be modelled as such, not inferred from a row id.

### F3 — Read/write asymmetry between the editor and the API (S1)
`CustomerSupportModal` **reads** with no org param (→ org 1) at `:59` but the API **writes** to `session.orgId` (`route.ts:108`). For the Super Admin (org 1) the two coincide, which is why this has never been caught. For any other organisation's OWNER, opening the editor shows them **org 1's content**, and pressing *Save* overwrites **their own** row — an invisible, confusing dead end, and latent cross-tenant content bleed the moment a second org's owner uses the editor in earnest. It also means a tenant can never actually customise the panel they are shown (see F5).

### F4 — `canManageSupport` is the wrong gate for platform content (S1)
The platform-wide HELP row (what every shopper sees on `/order`) is editable by `role === "OWNER"` **or any user holding `canManageSupport`** — a grant designed for *a tenant's own* storefront HELP. Today only the Super Admin happens to be org 1's OWNER, so it works by convention. If org 1 ever has a second OWNER or a granted staffer, they can rewrite the platform's public support details. **Platform Help/Contact editing must be tied to `isSuperAdmin`**, not to a tenant-scoped grant.

### F5 — Unauthenticated cross-tenant read of every organisation's support row (S2)
`GET /api/support-info?org=<any>` returns any organisation's contact name, phone, WhatsApp, email and address **with no session** (`:35-72`). It is deliberate (the comment calls `?org=` "reserved for future per-owner storefronts", and `multiowner-verify.mjs:261-272` tests it), but as it stands it is an unauthenticated tenant-directory disclosure, and the org-id space is trivially enumerable. Recommendation: keep the contract for a *future* authenticated per-owner storefront, but on the public path only ever serve the **platform** row, and require a session for any other org.

### F6 — Notifications cannot be addressed to "the platform" (S1)
`fanOut()` demands a `businessId`; `orderNotificationRecipients()` only returns that business's org members. A platform request has **no business and no tenant**. There is no `platformOwnerRecipients()` and no `urlForNotification()` mapping for a platform type. Anything built on the existing helper would either crash or silently notify nobody.

### F7 — No email, anywhere (S2)
No mail provider in `package.json` (no nodemailer/SendGrid/Resend/Postmark). Notifications are bell + web-push only (`web-push` + VAPID). Consequences to design around: the Super Admin can be pinged *in-app*; the **applicant cannot be emailed** a confirmation or a decision. Either accept a "keep this reference code and check back" flow, or budget for an email provider as separate work.

### F8 — Approval has no request record (S2)
`POST /api/admin/organizations` is an imperative provision form; it stores no *inbound request*, no status, no provenance, no decision reason, and no link from a request to the org it created. `approval_requests` is the right *shape* (see §2.4) but is unusable for this because `ownerId` and `businessId` are `NOT NULL`.

### F9 — No platform audit target yet (S3)
`audit_trail.targetType` is free text and `ownerId` is nullable, so platform rows *can* be written; nothing writes them yet — `writeAdminTrail()` falls back to `ownerId ?? actor.orgId` (`admin/organizations/route.ts:53`). Platform request decisions need `targetType: "PLATFORM_REQUEST"` with `ownerId: null` so they are never attributed to a tenant.

### F10 — Panel copy blurs platform vs shop (S3)
Inside HELP, `contactName` is captioned *"Your customer-care contact"* and `address` *"Our shop location"* (`:2238`, `:2274`) — shop-flavoured wording for what is actually the platform/org helpdesk, while the same panel sits on a page selling *all* tenants' goods. Adding a platform CTA is a good moment to make the two voices distinct.

### F11 — FARM_ADVISOR middleware interaction (S3, but easy to forget)
`src/proxy.ts` default-denies every `/api/*` path not on its allowlist for authenticated advisor sessions. A new `/api/platform-requests` is therefore automatically `403` for advisors (read **and** write) — which is the desired posture for the admin list, and a decision to make consciously for the public POST. **Do not add these to the allowlist.**

### F12 — In-process rate limiting only (S3)
`rateLimit.ts` is a per-process `Map`; the module documents the single-node assumption and the Redis upgrade path. Fine for the embedded single-node deployment; relevant if the platform ever scales horizontally.

### F13 — Marketplace context for any public CTA (S3)
Because `/order` aggregates every tenant's catalogue, a "Join GoMina 360" CTA there is seen by shoppers of *all* tenants. It must be unmistakably **platform-branded** and must never imply that the shop being browsed is recruiting or that the applicant's data goes to that shop.

### F14 — Minor doc drift (S3)
`verify-storefront-help.mjs`'s header comment says "the 7-step guide"; the live guide and assertions use **9**. Harmless, but it will mislead whoever extends that file for the new work.

---

## 4. Can the Help/Contact section carry this? Yes — recommended shape

**The Help/Contact section is the right surface, for four reasons:** it is already the page's single "everything you need" panel; it already owns the contact-information concept and its edit path; it is reachable from the header *and* footer; and its contents are already driven by a database row the owner can edit — so "let the Platform Owner edit what's displayed" is a change of *scope and gate*, not a new subsystem.

**But the form itself should not live inside the modal.** Recommended split:

| Concern | Where | Why |
|---|---|---|
| Platform Help/Contact **content** | existing HELP panel (section 1) — scope made explicit | Already there; only the scope/gate changes |
| **Entry point** for registration | new "Join GoMina 360" block inside the HELP panel + a footer line + a link on the login page (the login link is armed by the Super Admin's **login-page switch**, hidden until asked for) | Zero-friction discovery at the two places a stranger actually is, with the staff sign-in gate kept free of marketing unless the owner opts in |
| **The form** | its own public route `/join` (linked from the block) | Shareable/indexable, room for purpose selection + privacy note + bot protection, and it keeps the storefront modal — whose step-count and labels are asserted verbatim by E2E — small and stable |
| **Review/manage** | `PlatformAdminPanel` → new **Requests** section (badge on the nav row) | The console is already Super-Admin-only, already the org-lifecycle home, and approving must anyway call the provisioning logic that lives behind it |

A compact inline form is a defensible alternative if you want the request to be creatable without leaving the modal; the recommendation is `/join` with an in-panel CTA, because anti-abuse controls and a privacy statement need real estate, and because the HELP modal's contents are pinned by `verify-storefront-help` C3/C3b/C3c.

---

## 5. Recommended design

### 5.1 Platform-scope the Help/Contact content (fix the foundation first)

Make the storefront's support content **explicitly platform-scoped** instead of "org 1 by accident":

- Add a scope discriminator to `customer_support_info` — either an additive `scope text NOT NULL DEFAULT 'ORGANIZATION'` with a single `PLATFORM` row, or a nullable `organizationId` for the platform row plus a `system_markers` key (`schema.ts:401-406`, already used as a singleton lock). The marker approach reuses an existing singleton pattern and avoids a nullable FK.
- Public GET: **always** serve the platform row on the storefront; keep `?org=` + a session for the future per-owner storefront (preserves `multiowner-verify.mjs:261-272`).
- POST: gate the **platform** row on `requireSuperAdmin()`; keep the per-org row on `role === "OWNER" || canManageSupport` so no tenant loses capability.
- Fix the modal's read/write asymmetry (F3) so the editor always loads the row its Save will write.
- Additive platform-registration fields on the same row (all nullable, so the editor degrades gracefully):
  `registrationEnabled` · `registrationHeadline` · `registrationNote` · plus the existing 7 contact fields. **Additive columns only** — the seven existing fields and their limits stay byte-compatible for the A1–A10 suite.

### 5.2 New table: `platform_requests`

Platform-level, **no `ownerId`** — that absence *is* the privacy guarantee: there is no tenant column to leak it through, and no tenant-scoped query can ever match it.

```
id
purpose           text not null     -- allowlisted, see below
status            text not null default 'PENDING'  -- PENDING|IN_REVIEW|NEEDS_INFO|APPROVED|REJECTED|CLOSED
reference         text not null unique             -- opaque requester-facing code, e.g. GMR-7F3K2Q
businessName      text
contactName       text not null
contactEmail      text
contactPhone      text
businessType      text              -- reuse BUSINESS_TYPES keys from lib/businessTypes.ts
location          text              -- city/region, free text
message           text
-- decision / provenance
decidedByUserId / decidedByName / decidedByRole
decidedAt         timestamp
decisionReason    text
createdOrganizationId integer       -- set when approval provisions an org
createdOwnerUserId    integer
reviewNotes       jsonb             -- optional append-only trail of internal notes
meta              jsonb             -- userAgent, hashed IP, source page
createdAt / updatedAt
index (status, id) · index (contactEmail)
```

`purpose` allowlist (mirrors the `APPROVAL_REQUEST_STATUSES` style already in `lib/approvals.ts:58`):

```
JOIN_PLATFORM   – I want to run my business on GoMina 360
REQUEST_DEMO    – Show me how it works
PARTNERSHIP     – Supplier / reseller / integration partnership
SALES_PRICING   – Plans, pricing & billing questions
SUPPORT         – Help with an existing account or order
OTHER
```

### 5.3 The public write endpoint — `POST /api/platform-requests`

Anonymous-allowed, modelled line-for-line on the proven `/api/order` public-write flow:

1. `throttle(clientIp(request), { key: "platform-request", limit: 5, windowMs: 3_600_000 })` **plus** a short burst cap — registration is far lower volume than ordering, so it can be far stricter than 30/min.
2. Reject non-`PENDING`-able payloads; validate `purpose` against the allowlist (unknown → `400`, never stored raw).
3. Length caps on every field (mirroring `support-info/route.ts:19-27`); `contactName` ≥ 2 chars; `validatePhone(…, { exactDigits: PHONE_EXACT_DIGITS_STOREFRONT })` when a phone is given; email regex reuse.
4. **Honeypot** field + a minimum time-on-form check; optional Cloudflare Turnstile if you want a real bot gate (needs a new env pair, e.g. `NEXT_PUBLIC_TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY`, and a server-side verify — flagging the new dependency rather than assuming it).
5. Dedupe: refuse (or silently no-op) a second `PENDING` request from the same email.
6. **Response contains only** `{ success: true, reference: "GMR-…" }` — never the row, never an id, never a count, never a status lookup. The reference lets a genuine applicant follow up by phone/WhatsApp without creating a public read surface.
7. `apiError()` for unexpected failures so schema internals never leak.
8. Log with the existing hashed-IP convention (`IP_HASH_SALT`, already documented in `.env.example`) — no raw PII in logs.

### 5.4 The private read / decide endpoint — `GET` + `PATCH /api/platform-requests`

- Both behind **`requireSuperAdmin(request)`** (`lib/auth.ts:509`) — the same gate the org-lifecycle route uses, and the only gate that is not tenant-derived. `401` unauthenticated, `403` for everyone else including org OWNERs, GMs and `canManageSupport` holders.
- `GET`: optional `?status=` filter, newest-first, paginated. **Never** scoped by `ownerId` — the platform scope *is* the query.
- `PATCH` actions, each writing an `audit_trail` row (`targetType: "PLATFORM_REQUEST"`, `ownerId: null`, `targetLabel: reference`):
  `START_REVIEW` · `NEEDS_INFO` · `APPROVE` · `REJECT` · `CLOSE` — all except review transitions require `decisionReason` for `REJECT`.
- **`APPROVE` calls the existing provisioning path.** Extract the body of `POST /api/admin/organizations` (`:114-216`) into a shared helper (e.g. `src/lib/organizationProvisioning.ts`) taking `{ name, ownerName, ownerEmail, ownerPhone, contactPhone }`, then have **both** the console form and the approval action call it. On success, stamp `createdOrganizationId` / `createdOwnerUserId` on the request and return the **one-time password to the Super Admin only, once** — never persisted, never in a notification body (F7, and the same discipline as the existing console's `initialPassword`).
- Handle the existing error contracts: `409` duplicate email (→ surface as *"this applicant already has an account — resolve in the console"*), `400` invalid email.
- **Approval should not be automatic from the request alone** if you prefer a human step: an equally valid variant is `APPROVE` = *"approved, provision when ready"*, with a one-click **Provision now** button that pre-fills the existing console form from the request. This avoids creating an account from a form filled by an anonymous stranger. See open question Q1.

### 5.5 Notification to the Platform Owner — the one genuinely new primitive

`fanOut()` cannot address the platform (§2.4, F6). Add a small, explicit platform path rather than loosening the tenant one:

- `platformOwnerRecipients()` → active users with `isSuperAdmin = true` (mirrors `orderNotificationRecipients`' shape).
- `notifyPlatformRequest(request)` → inserts one `notifications` row per Super Admin (`type: "PLATFORM_REQUEST_NEW"`, `businessId: null`, **`ownerId: null`**, `recordRef: reference`, `title`/`body` from `purpose` + business name, `priority: "HIGH"` for `JOIN_PLATFORM`) and fires `pushAfterBell` with category **`messages`** (an existing category — no schema change).
- Extend `urlForNotification()` (`lib/push.ts:55`) to map the new type to the Platform Owners → Requests view.
- The dedupe logic in `fanOut` (on `userId + type + recordRef`) is worth mirroring so a retry can't double-notify.
- **Privacy is already correct** on the read side: `/api/notifications` filters `userId = me`, so only Super Admins ever see these bell rows, and no tenant can enumerate them.

### 5.6 Supervision UI

Inside `PlatformAdminPanel` (already Super-Admin-gated in `GoMinaApp.tsx:1131` and by `navManifest.ts:531-540`):

- A **Requests** section above the organisation table: filter tabs (`PENDING` default, plus the rest), count badges, newest-first list showing purpose · business · contact · age.
- A detail drawer with the full submission, an **Approve / Reject / Needs info / Close** action bar with a required reason on reject, and a link to the created organisation once provisioned.
- Reuse the existing typed-confirm and "expanded row" interaction patterns from that panel (its inline comments show these were chosen deliberately to prevent click-through accidents on destructive actions) and the `STATUS_STYLE` badge convention from `ApprovalInbox.tsx:30-34`.
- One-time password presentation: same banner pattern as the existing *"Owner provisioned successfully"* block (`PlatformAdminPanel.tsx:228-241`).

### 5.7 Storefront entry point

- New **"Join GoMina 360"** block inside the HELP modal (after the contact block, before the how-to), rendered only when the platform row's `registrationEnabled` is true and a headline is set; primary CTA → `/join`; copy must be platform-branded (F13).
- Footer line alongside the existing HELP line, and — **opt-in, off by default** — a "Want your business on GoMina 360?" link on the login page (`/`), controlled by the Super Admin's login-page switch (see docs/PLATFORM-INFORMATION-GUIDE.md §3).
- `/join` collects: purpose (required, radio/select), contact name (required), business name, email, phone, business type (reuse `lib/businessTypes.ts` labels), location, message; shows the platform contact details from the same row (so the applicant can also just call); returns the reference code with "keep this safe".
- All fields text-rendered by React (no `dangerouslySetInnerHTML`) — the same posture as the current panel, which renders `extraInfo` with `whitespace-pre-line` and escapes by construction.

### 5.8 Explicitly **not** recommended

- **Do not** put requests in `customer_support_info` or in any table with an `ownerId` — a tenant column is a leak vector and would force every future query to prove it filters correctly.
- **Do not** reuse `approval_requests` for this (its `ownerId`/`businessId` are `NOT NULL`) — a platform twin is cleaner than loosening a table every tenant workflow depends on.
- **Do not** expose requests through `/api/init`, the notifications list of non-Super-Admins, exports, or the business-scoped backup chain.
- **Do not** add the new endpoints to the `proxy.ts` advisor allowlist.
- **Do not** return the request row (or a status endpoint) to the anonymous submitter beyond the reference code.
- **Do not** reuse `canManageSupport` as the platform-edit gate (F4).

---

## 6. Implementation plan (when you're ready to build)

| Phase | Work | Files (indicative) |
|---|---|---|
| **1 — Foundation** | Scope the support row (`PLATFORM` marker); platform row readable publicly, write-gated on `requireSuperAdmin`; keep per-org write on OWNER/`canManageSupport`; fix the modal's read/write asymmetry | `db/schema.ts`, `api/support-info/route.ts`, `components/CustomerSupportModal.tsx`, `migrate-production-schema.mjs` |
| **2 — Data + API** | `platform_requests` table + migration; public `POST` (throttle/validate/honeypot/dedupe/reference); `requireSuperAdmin` `GET`/`PATCH`; `audit_trail` rows | `db/schema.ts`, new `api/platform-requests/route.ts`, `lib/platformRequests.ts`, `migrate-production-schema.mjs` |
| **3 — Notify** | `platformOwnerRecipients()`, `notifyPlatformRequest()`, `urlForNotification` mapping, push category `messages` | `lib/notify.ts`, `lib/push.ts` |
| **4 — Approval → provisioning** | Extract the org-provisioning core; wire `APPROVE` (or `Provision now`) to it; one-time-password presentation | `lib/organizationProvisioning.ts` (new), `api/admin/organizations/route.ts`, `api/platform-requests/route.ts` |
| **5 — Surfaces** | Requests section in the console + nav badge; HELP-panel CTA block + footer + login-page link; `/join` page | `components/PlatformAdminPanel.tsx`, `app/order/page.tsx`, `app/page.tsx`/`LoginScreen.tsx`, new `app/join/page.tsx`, `lib/navManifest.ts` |
| **6 — Editable registration info** | Registration fields in the platform Help/Contact editor | `api/support-info/route.ts`, `CustomerSupportModal.tsx` |
| **7 — Verification** | Extend the storefront suite; new platform-request suite | `dev-tooling/verify-storefront-help.mjs`, new `dev-tooling/verify-platform-requests.mjs` |

**Verification contract to add** (mirroring the existing suite style — real headless browser + live DB, self-cleaning):

- Anonymous `POST /api/platform-requests` succeeds and returns **only** a reference code.
- Rate limit trips (`429` + `Retry-After`); invalid purpose/email/phone → `400`; honeypot → rejected.
- `GET`/`PATCH` as **anonymous → 401**; as org OWNER → **403**; as GM → **403`; as a `canManageSupport` grantee → **403**; as Super Admin → `200`.
- The submitted request appears in **no** tenant-visible payload (`/api/init`, bell rows of tenant users, exports).
- Approve → organisation provisioned, `createdOrganizationId` stamped, audit row written with `ownerId: null`, one-time password returned once.
- Reject → `decisionReason` stored, no organisation created, audit row written.
- The platform HELP row remains byte-identical to the suite's baseline for the tenant-visible fields (protects A1–A10 and Z4).

---

## 6b. Live evidence from the running preview

Observations against the seeded preview (11 units · 18 users · 7 employees), which make several findings concrete:

| Observation | Confirms |
|---|---|
| `SELECT count(*) FROM customer_support_info` → **0 rows**; `GET /api/support-info` → `{"success":true,"info":null}` | The live Order Page HELP panel is currently rendering its **empty state** (*"Our support contacts are being set up"*). Whatever we design, the platform Help/Contact content does not exist yet — so there is nothing to migrate, only to seed. F2, F10 |
| `organizations` holds **two** rows — `1 · GoMina Group` and `2 · AU WM Demo Org` — and `users.is_super_admin = true` for exactly **one** user (`1 · Kwame Mina`) | The multi-org, single-Super-Admin model the design must serve is real, not theoretical. F1, F4 |
| `GET /api/support-info?org=2` answers **`200` with no session** | Any organisation's support row is anonymously readable by enumerating `org` ids. F5 |
| Both organisations have `owner_user_id = 1`, and user 1 is the Super Admin | Explains why the read/write asymmetry (F3) and the platform gate (F4) have never caused a visible incident — they only surface with a *second* Owner. |

---

## 7. Open questions for your call

1. **Approval semantics.** Should *Approve* **auto-provision** the organisation + Owner login (reusing the existing routine), or mark the request `APPROVED` and require a second **Provision now** click that pre-fills the console form? *Recommendation: the two-step variant* — creating an account is a higher-risk action than deciding on it, and the console already returns a one-time password that a human must hand over.
2. **Tenant HELP rows.** Keep the per-organisation row *and* the platform row (tenants keep their own editor; the storefront shows the platform one), or retire the tenant editor to avoid two similar-looking editors? *Recommendation: keep both* — `multiowner-verify` already asserts the per-org path, and it is the natural home for future per-owner storefronts.
3. **Applicant confirmation.** With no email provider (F7), is a "save your reference code and contact us" flow acceptable, or should an email provider be added as separate work? *Recommendation: reference code now; email later if volume justifies it.*
4. **Bot protection.** Honeypot + rate limit only, or add Cloudflare Turnstile (new env vars + a server verify)? *Recommendation: start with honeypot + strict throttle; add Turnstile if junk arrives.*
5. **Form placement.** Standalone `/join` page (recommended) or an inline form inside the HELP modal? And should the `/order` CTA also appear on `/track`?
6. **Platform edit gate.** Super Admin only (recommended, F4), or Super Admin **or** the org-1 OWNER?

Nothing above has been implemented. Tell me which options you want and I'll build it in the phases in §6.
