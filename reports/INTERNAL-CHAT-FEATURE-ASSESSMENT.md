# GoMina 360 — Internal Business Chat: Architecture Audit & Design Assessment

**Date:** 2026-09-27 · **Status:** DESIGN ONLY — not implemented (per directive)
**Feature:** Internal chat/communication for authorized Owners, Managers and Workers —
direct messages, business/branch channels, replies, photos/files, mentions, timestamps,
unread notifications, searchable history, record/alert sharing, and message→action
conversion. Owner-controlled enablement and access. Strict tenant isolation.

---

## 1. Executive summary

**Recommendation: build a lean, native chat feature on top of GoMina 360's existing
primitives — do not embed a third-party chat service and do not add new infrastructure.**

The audit (§2) shows the app already owns every hard part of chat except the message store
itself:

| Chat need | Already exists in GoMina 360 |
|---|---|
| Identity, roles, per-user OWNER grants | `users` (roles + 15 OWNER-granted flags), `organization_members` |
| Tenant scoping helpers | `accessibleBusinessIds()`, `canAccessBusiness()`, `resolveUserOrgIds()` (`src/lib/auth.ts`) |
| Recipient resolution (who's in a unit) | `orderNotificationRecipients()` — org OWNER + assigned staff + grantees, same-org only (`src/lib/notify.ts`) |
| Unread badge + deep links | `notifications` (recordType/recordId/recordRef), `NotificationBell` (30 s poll) |
| OS-level push, per-category | Web Push w/ **"messages" category already defined** (`src/lib/push.ts`) |
| Actions with provenance | `action_tasks` (sourceType/sourceId/sourceRef) + **notification→task conversion already shipped in the bell** |
| Attachment validation & storage convention | Document Vault (`business_documents`): data-URL, 2.5 MB cap, image/PDF whitelist, polymorphic `relatedType/relatedId` |
| Presence (online/idle) | session heartbeat (`/api/session/heartbeat`) drives the Signed-In Staff online chip |
| Owner org-level switches + audit | "Allowed Business Types" pattern (`businessTypesRestricted` + child table + `auditLog()` on every change) |
| Search | SQL `ILIKE` per route (no FTS engine — chat search should match this) |

What's missing is exactly four tables + one API surface + one view. Estimated effort
(§9): ~9–12 working days for Phases 1–2, delivered behind a **default-OFF org switch**
so nothing changes for any tenant until its Owner enables chat.

**Key architectural finding:** there is **no WebSocket/SSE infrastructure** anywhere in
the app — everything (bell, dashboards) is HTTP polling. Chat should use the same model
(10–15 s poll while a conversation is open, aligned with the 30 s bell poll). This keeps
the single-process `next start` deployment unchanged; the API shape below is
upgrade-friendly to SSE later without client rewrites.

---

## 2. Audit of existing systems (facts the design builds on)

### 2.1 Users, roles & permissions
- Roles: `OWNER`, `GENERAL_MANAGER`, `BRANCH_MANAGER`, `ACCOUNTANT`, `SUPERVISOR`,
  `WORKER`, `FARM_ADVISOR` (+ platform `isSuperAdmin`). Workers/BMs carry
  `assignedBusinessId`; extra access flows through `user_business_access` grants and
  `businessManageIds` (OWNER-granted unit-management delegation).
- Fine-grained capability flags are **OWNER-granted booleans on the user row**
  (`canManageUsers`, `canManageRecords`, `canManageOnline`, `canCreateBusiness`,
  `canViewFinance`, …). This is the established pattern a future `canAdminChat` would
  follow.
- `accessibleBusinessIds(user)` is the single source of truth for scope: `null` ⇒
  platform Super Admin; OWNER ⇒ own org's businesses; FARM_ADVISOR ⇒ **only active,
  unexpired `advisor_assignments`** (deliberately sandboxed, read-only); everyone else ⇒
  assignment ∪ grants ∩ own org. Every chat read/write must go through the same helpers.
- Multi-tenancy: `organizations` + `organization_members` (+ `primaryOrgId`); all
  operational tables carry `ownerId` (= organizations.id) as tenant scope.
- Secure sessions: bearer tokens (SHA-256 hashed), lockout, session console, heartbeat
  presence (`user_sessions.lastSeenAt` / `revokedAt` "parking").

### 2.2 Notifications & push
- `notifications`: recipient `userId`, `type`, `title/body`, **`recordType`/`recordId`/
  `recordRef` deep-link**, `businessId`, `branchCode`, `priority`, tenant `ownerId`,
  `isRead`. Bell polls `GET /api/notifications` every 30 s (60 rows + unreadCount +
  openAssignedCount); `PATCH` marks read.
- `notify.ts` fan-out: per-recipient rows, **dedupe on (userId, type, recordRef)**, then
  `pushAfterBell()` fires Web Push only for fresh rows. Recipient sets are strictly
  same-organization.
- `userPushSettings` categories: orders, approvals, alerts, tasks, **messages**, reports —
  the "messages" category exists and is currently unused. Chat mentions map onto it with
  zero push-system changes.

### 2.3 Action Center
- `action_tasks`: `taskNumber`, tenant `ownerId`, `businessId`/`branchCode`, title/detail,
  **provenance (`sourceType`/`sourceId`/`sourceRef`/`sourceLabel` — supports
  notifications, audit issues, advisor follow-ups, checklists, approvals)**, assignee,
  priority, status, due date, completion trail. `createTask()` in `src/lib/actionCenter.ts`.
- The bell **already converts a notification into a task** ("Convert to action", carrying
  the source link). Message→action is the same flow with a new `sourceType`.
- Linked-items aggregation + overdue escalation sweep already exist.

### 2.4 Attachments & files
- Document Vault (`business_documents`, R4): data-URL `fileData` (image/* or
  application/pdf), **`MAX_DOC_BYTES` 2.5 MB** validated in `src/lib/documents.ts`,
  polymorphic `relatedType`/`relatedId`, uploader provenance, expiry sweeps. Same shape
  cloned by `employee_documents` and `sales_documents`.
- Photos elsewhere are data-URLs in text/jsonb columns (`inventory_items.photos`,
  transactions `receipt_images`, `avatarUrl`). There is no object storage — and chat
  should not introduce one.

### 2.5 Real-time, search, admin patterns
- No WebSocket/SSE anywhere; all live updates are polling.
- Search is per-route SQL `ILIKE` (notifications, audit issues). No FTS index — fine at
  this scale; chat search should use `ILIKE` + trigram-friendly indices rather than
  pulling in a search engine.
- Org-level Owner switches follow the "Allowed Business Types" precedent:
  `organizations.businessTypesRestricted` + `organization_allowed_types` child table,
  OWNER/Super-Admin API, `auditLog()` on every grant/revoke, existing businesses
  unaffected. **Chat enablement should clone this pattern.**
- `auditLog()` (never-throws) is the compliance trail for admin actions.

### 2.6 Things that must NOT be duplicated
- `customer_interactions` (type `MESSAGE`) is **customer-facing CRM**, not internal chat —
  keep the domains separate; optionally surface a "log to customer timeline" action later.
- The AI assistant panels are AI chat with a different lifecycle — reuse only the
  message-list UI idiom, not the data model.
- The bell already owns alerting: **chat must not become a second alert feed**
  (low-stock, orders, audit issues stay bell-only; chat gets them only via explicit
  "share into chat", §6.3).

---

## 3. Recommended design

### 3.1 Data model (4 new tables + 2 setting tables, all additive)

```
chat_settings                 — one row per organization (absent ⇒ chat DISABLED)
  organizationId (unique) · isEnabled (default false)
  · allowRoles jsonb           — {"OWNER":true,"GENERAL_MANAGER":true,
                                  "BRANCH_MANAGER":true,"WORKER":true,
                                  "ACCOUNTANT":false,"SUPERVISOR":false}
  · disabledBusinessIds jsonb  — Owner can switch specific units out of chat
  · updatedBy / audit trail via auditLog()

chat_user_overrides           — per-user exceptions to the role policy
  organizationId · userId · status ('ALLOWED' | 'BLOCKED') · note · updatedBy*

chat_channels
  id · ownerId (tenant) · kind ('ORG' | 'BUSINESS' | 'BRANCH' | 'DIRECT')
  · businessId (null for ORG/DIRECT) · branchCode
  · name · slug · description · isArchived · createdById · createdAt
  — auto-provisioned: "🏢 HQ — All Units" (ORG) on enable; one BUSINESS channel
    per chat-enabled unit; BRANCH channels created by unit managers as needed.
    DIRECT channels are lazy: created on first DM, members exactly 2.

chat_channel_members
  channelId · userId · role ('MEMBER' | 'ADMIN') · lastReadMessageId · mutedAt
  · joinedAt — unique (channelId, userId). ADMIN: OWNER/GM org-wide, unit BM in
    their channels, or OWNER-promoted members.

chat_messages
  id · ownerId · channelId · parentId (replies/threads, null = top-level)
  · authorUserId · authorName · authorRole (denormalized, matches codebase style)
  · body text · mentions jsonb ([userId,…])
  · attachments jsonb ([{name, mime, bytes, dataUrl}] — see §3.5)
  · sharedRecord jsonb ({recordType, recordId, recordRef, label, businessId,
    branchCode, icon, preview}) — the record/alert "share card", §6.3
  · clientId (client-generated id — send idempotency for optimistic UI)
  · createdAt · editedAt · deletedAt (soft delete: admins redact, never hard-erase)
  indexes: (channelId, id desc) · (ownerId, channelId) · GIN(mentions)
```

No migration of existing data; no seed rows (chat is invisible until an Owner enables it).

### 3.2 Access model — the Owner controls everything

Server-side resolver (mirrors `accessibleBusinessIds` style), evaluated on **every**
chat API call:

```
chatAccessOf(user) →
  1. org chat_settings.isEnabled?        (absent/false ⇒ 404-style "disabled")
  2. role allowed by allowRoles?         (OWNER always allowed — cannot lock self out)
  3. user not BLOCKED in chat_user_overrides?
  4. visible channels =
       ORG channel      — every chat-enabled member
       BUSINESS/BRANCH  — ∩ accessibleBusinessIds(user), minus disabledBusinessIds
       DIRECT           — chat_channel_members rows for me
  5. FARM_ADVISOR: excluded in v1 (external, read-only sandbox; access flows only
     through advisor_assignments — a future "advisor channel" could extend this,
     §8). SUPER_ADMIN: read-only across orgs for compliance, same as audit.
  6. canAdminChat(user) = OWNER or GENERAL_MANAGER (org-wide) · BRANCH_MANAGER
     within their units' channels · optional OWNER-granted canAdminChat flag
     (follows the existing OWNER-grant pattern when finer delegation is needed).
```

Owner administration (all `auditLog()`-ed, cloning the Allowed-Types API design):
enable/disable chat org-wide; toggle roles; allow/block individual users; disable
individual businesses; archive channels; redact messages. BMs administer only their own
unit's channels/members. Deactivating a user (existing `isActive`/access-revocation
flows) automatically removes them from all recipient resolution — chat reads membership
live rather than caching rosters.

**Isolation invariants (all enforced in SQL, not just UI):**
- Every table carries tenant `ownerId`; every query filters by the caller's org(s)
  (`resolveUserOrgIds`) **and** channel membership; channel creation requires
  `canAccessBusiness(businessId)` and `businesses.ownerId == channel.ownerId`.
- DM creation verifies **both users share an organization and both pass chatAccessOf** —
  cross-org DMs are impossible by construction.
- Disabled ≠ deleted: turning chat off (or blocking a user) hides channels and stops
  writes; **history is preserved** (consistent with the platform's preserve-data
  philosophy, e.g. org suspension).

### 3.3 API surface (one route group, existing auth stack)

| Route | Purpose |
|---|---|
| `GET /api/chat/summary` | Poll: my channels (name, kind, unit), per-channel unread (`lastReadMessageId` vs max), presence dots (from `user_sessions`), org enabled state. 15 s while chat open / piggybacked on the 30 s bell poll otherwise. |
| `GET /api/chat/messages?channelId&before=&limit=` | Paged history (newest-first window, `before` cursor). **Attachment `dataUrl` stripped** — metadata only; full file fetched on click. |
| `GET /api/chat/search?q=&channelId?` | `ILIKE` over `body` + `sharedRecord.recordRef`/`label`, scoped to my channels of my orgs. Same search idiom as the rest of the app. |
| `POST /api/chat/messages` | Send: body/mentions/attachment/sharedRecord/parentId/clientId. Re-verifies membership + org; returns the persisted row (clientId matched ⇒ idempotent). |
| `PATCH /api/chat/messages/:id` · `DELETE` | Edit (author, window) / redact (author or channel ADMIN) — soft delete + `auditLog` for admin redactions. |
| `POST /api/chat/read` | Advance `lastReadMessageId`; also marks my `CHAT_MENTION` bell rows for that channel read (§3.4). |
| `POST /api/chat/channels` · `PATCH` | Create/archive channels (ADMIN-scoped as §3.2). |
| `GET/PATCH /api/chat/admin` | OWNER-only: enable/disable, role toggles, user allow/block, business switches. `auditLog()` every mutation. |

### 3.4 Unread & notifications (no duplication)

- **Per-channel unread counts** come from `chat_channel_members.lastReadMessageId` —
  computed in `summary`, rendered as chat badges. **No notification rows are written for
  ordinary messages** (a bell row per message would flood the existing system).
- **@mentions** are the only chat events that cross into the bell: one
  `notifications` row (`type: 'CHAT_MENTION'`, `recordRef: 'chat:<channelId>'`, deep-link
  via existing `onOpenRecord` routing) fanned out through `notify.ts`'s existing dedupe,
  then Web Push under the already-defined **"messages"** push category. Opening the
  channel marks them read.
- Optional Phase 3: a daily "N unread messages" digest via the existing daily-ops sweep
  pattern (opt-in per `userPushSettings`).

### 3.5 Photos & files

Reuse the Document Vault **conventions** (validator + limits) without routing chat
through the vault table: `src/lib/documents.ts`'s mime whitelist (image/*, PDF) and
`MAX_DOC_BYTES` (2.5 MB) applied to inline `attachments` jsonb on the message. Rationale:
chat needs fast self-contained reads and has no document lifecycle (expiry/replacement)
— vault semantics don't fit — but the rules stay identical so nothing new to police. The
poll/history payloads carry metadata only; `dataUrl` loads lazily per attachment.
(If orgs later need bigger files, that's a platform-wide object-storage decision, not a
chat one.)

### 3.6 UI

- New top-level **"Chat"** sidebar tab (next to Action Center) + `CHAT` entry in
  ContextNavigator's Shared Enterprise Modules — hidden unless the org enabled chat
  (flag served via `/api/init` snapshot, like `allowedTypes`).
- Two-pane layout (desktop) / stack navigation (mobile, matching the app's responsive
  patterns): channel list with unread badges + presence dots → conversation with
  day-dividers, timestamps, reply threads (indented, collapsible), share cards,
  mention chips, and the compose bar (@-autocomplete of channel members, attach,
  share-record, send).
- Conversation header hosts "Convert to action" (§6.2) and channel admin actions.
- No new page shell: a `ChatModule` in the Action Center pattern (one component + API),
  keeping the P2 "module shell" roadmap in mind.

---

## 4. Tenant isolation & security checklist (test plan)

1. Worker in org A can never list/read/post in org B channels (API-level tests).
2. DM only between same-org users; attempt with cross-org userId ⇒ 403 + no channel row.
3. `disabledBusinessIds` hides a unit's channels for *everyone* except… no one (Owner
   included) — but history is retained and restored if re-enabled.
4. Blocking a user stops sends immediately; their `lastReadMessageId` state is frozen
   (not deleted).
5. FARM_ADVISOR: chat API returns disabled even if org chat is on.
6. `chat_settings.isEnabled=false` org: all chat routes return disabled; sidebar tab
   hidden; **zero new notification rows**.
7. Super Admin sees cross-org only for compliance reads (matches audit behavior), all
   writes still impossible.
8. Message redaction: `deletedAt` set, body null, `auditLog` entry written.
9. Attachment validation: >2.5 MB or non-whitelisted mime rejected before insert.
10. Existing suites must stay green with chat disabled (default state) — the feature is
    invisible to the current battery, then a new `verify-chat-*` battery (core,
    permissions, isolation, integrations) gates enablement.

---

## 5. Integrations with existing records (the high-value part)

### 5.1 Share a record/alert into chat
Every shareable thing in GoMina 360 already has a `(recordType, recordId, recordRef,
label)` identity — the notifications/Audit Center convention. "Share to chat" (added to
Action Center rows, bell rows, and record detail headers) opens a channel/user picker
(reuse the Action Center assignable-staff picker idiom) and posts a message whose
`sharedRecord` jsonb renders as a card: icon + label + unit + ref. **The card is a
deep link using the existing `onOpenRecord`/`urlForNotification` routing — no new
navigation system.** Alerts (low-stock, audit issues, order events) are *shared*, not
auto-posted, preserving the bell as the single alert feed.

### 5.2 Message → action (convert)
`action_tasks` provenance already accepts arbitrary sources, and the bell's
notification→task conversion is the exact UX precedent. "Convert to action" on a message
POSTs the existing `/api/tasks` `createTask` with
`sourceType: 'CHAT_MESSAGE', sourceId: messageId, sourceRef: 'chat:<channelId>'`,
`sourceLabel: '"<first 40 chars>" — <author>, <channel>'`, prefilled title/assignee
(mentioned users first) + due date/priority pickers. The Action Center's linked-items
section gains a "From chat" group with a jump-back link. (Roadmap P2 item from the
structural audit — "await critical audit writes" — applies to task creation too.)

### 5.3 Presence
Online/idle dots per member come from `user_sessions` (heartbeat already maintains it
for the Signed-In Staff console) — read-only reuse, no new heartbeat.

---

## 6. Phasing, effort & rollout

| Phase | Contents | Effort |
|---|---|---|
| **1 — Core** | Tables, access resolver, channels + DMs + replies, send/read/unread, mentions + bell integration + push category, history & search, ChatModule UI (desktop+mobile), default-OFF switch + Owner admin (enable, roles, users, businesses), `verify-chat-core/-permissions/-isolation` suites | ~6–7 days |
| **2 — Integration** | Attachments (validator reuse), share-record cards + pickers, message→action conversion, presence dots, `verify-chat-integration` suite | ~3–4 days |
| **3 — Later (optional)** | Reactions, read receipts, pinning, retention/archival job, daily unread digest, UniversalExportCenter export, advisor-channel via `advisor_assignments`, SSE upgrade if polling ever shows latency | backlog |

Rollout: ship dark (no org has `chat_settings`) → Owner enables per org → pilot with
HQ channel → expand. The full existing battery remains green throughout because the
default state changes nothing.

---

## 7. Alternatives considered

| Option | Verdict |
|---|---|
| **Embedded SaaS chat** (Slack/Crisp/Chatwoot widget) | ❌ Breaks self-contained tenancy (data leaves the org's DB), adds external accounts/cost, can't reuse GoMina permissions/records, another vendor for Ghanaian SME owners to manage. |
| **Self-hosted chat server** (Matrix/Rocket.Chat container) | ❌ New runtime + ops burden in a single-process Next deployment; separate identity realm would need syncing; overkill for intra-org messaging at this scale. |
| **Polling-based native chat on existing primitives** (recommended) | ✅ Zero new infra; reuses auth, tenant scoping, notifications, push, attachments, Action Center, presence; upgrade path to SSE behind the same API contract. |

---

## 8. Additional improvements recommended (beyond the ask)

1. **Dedupe/polish while touching these systems:** the `GET /api/notifications` poll
   scans `audit_reviews` on every 30 s beat per user — pre-existing minor cost; worth an
   index/scoping pass when chat's summary endpoint is added (both hit the same beat).
2. **Chat export** in UniversalExportCenter (org-scoped, OWNER/GM) — compliance story
   for a communication record.
3. **Retention policy** (chat_settings, default keep-forever; optional N-day pruning of
   attachments only) — DB bloat control without touching message text.
4. **`canAdminChat` OWNER-grant** following the existing delegation-flag pattern if
   Owners want a non-GM chat admin.
5. **Read-only "advisor channel"** (Phase 3) to let a FARM_ADVISOR receive (not send)
   unit updates within an active `advisor_assignments` window — would close the loop
   with the advisor sandbox instead of bypassing it.
6. **Message → customer timeline** bridge: one click logs a chat decision as a
   `customer_interactions` NOTE — connects internal comms to the CRM without merging
   the domains.

---

## 9. Conclusion

The simplest secure integration is a **4-table message store behind the platform's
existing auth, scoping, notification, push, attachment and Action Center machinery,
default-off per organization, with the Owner holding role/user/business switches**.
It duplicates nothing (bell stays the alert feed, vault stays the document system,
CRM stays customer-facing), enforces tenancy at the SQL layer like every other module,
and lands in two phases of roughly 9–12 working days total.

*No code was changed for this assessment; all referenced behavior was verified against
the codebase on 2026-09-27 (`src/lib/auth.ts`, `src/lib/notify.ts`, `src/lib/push.ts`,
`src/lib/actionCenter.ts`, `src/lib/documents.ts`, `src/db/schema.ts`,
`src/app/api/{notifications,tasks,session/heartbeat,admin/organizations}`,
`src/components/{NotificationBell,ActionCenter,Sidebar,ContextNavigator}.tsx`).*
