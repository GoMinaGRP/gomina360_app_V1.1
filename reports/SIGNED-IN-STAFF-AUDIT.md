# Signed-In Staff — Organization, Display & Security Audit

**Scope:** the "Signed-In Staff" board under **Enterprise Users → Signed-In Staff** (`SignedInStaffPanel.tsx` + `GET/POST /api/staff-access` + `user_sessions` presence pipeline), examined against the session / staff / organization / business / branch / multi-owner architecture.
**Status of this document:** analysis + recommendation only. No code changes were made in this audit (per the agreed scope for this section).
**Baseline inspected:** branch `arena/01a0a375-gomina360-app-v1-1` @ `67ba6c4`, which already includes the P0–P3 work (staff-access org boundary, delegated-manager scope enforcement, presence lifecycle).

---

## 1. What exists today (verified by reading the code)

### 1.1 Presence pipeline
- `user_sessions` (id, userId, tokenHash, createdAt, expiresAt, lastSeenAt, endedAt, endReason, revokedAt) — one row per sign-in; there is **no org, business, branch, device, or network column** on it.
- `POST /api/session/heartbeat` parks (`revoked_at`) the caller's own session on `active:false` and un-parks on real API calls — presence is honest and cheap.
- `GET /api/staff-access` (283-line route) builds one row per user: joined `users × userBusinessAccess × userSessions × businesses`, derives `signedInNow`, `onlineNow` (lastSeen within window + not parked), `accessStatus` (`ACTIVE/DISABLED/REVOKED`), sorts presence-first, 15s client polling.

### 1.2 Authorization boundaries (as shipped in this branch)
- **Viewer gate:** OWNER, or BRANCH/GENERAL_MANAGER with `canManageUsers` (`SignedInStaffPanel` renders a lock screen otherwise).
- **Super Admin** (`users.isSuperAdmin`): sees **every user in every organization, flat in a single table**.
- **Normal Owner**: sees only users who are members of their own organization(s) (`organizationMembers` join).
- **Delegated manager**: viewers/acton restricted to staff whose `assignedBusinessId` is in their scope (`accessibleBusinessIds`); cross-org targets explicitly refused server-side; OWNER rows can never be disabled; self actions blocked.
- **Legacy rule:** users with no org record (pre-multi-owner rows) share the "legacy universe" — an org-less viewer sees the org-less population; both-org-recorded comparisons are strict. (Added in P1 to stop breaking legacy data.)

### 1.3 The display
One **flat table**: Staff | Role | Business & Branch (primary assignment only) | Presence | Signed In Since | Last Login | Last Logout | Access | Actions + five KPI chips and one presence filter.

## 2. Findings

**F-1 (High, clarity) — Super Admin's board mixes organizations flatly.** For the Super Admin, org Acme's Acme receptionist, GoMina Group's GM, and a fixture-org worker all render as one undifferentiated list. Names/emails can collide across orgs; actions (disable/revoke) are then one mis-click away from hitting a *different organization's* staffer. The org boundary enforced on read does nothing for disambiguation on display.

**F-2 (High, clarity) — Normal Owner's board mixes businesses/branches flatly.** Within one org, an org-level GM, a POULTRY-01 branch manager, and eight workers from six businesses interleave. The "Business & Branch" cell exists but is not a grouping; there is no way to answer "who is working at GoMina Hardware right now?" without scanning.

**F-3 (Medium, semantics) — Presence has no business/branch context.** A session is global: signing in once makes a user "ONLINE" for every business they can access (primary + granted). The board cannot truthfully say where they are *working*. The `grantedBusinessIds` count pill gestures at this but keeps the ambiguity.

**F-4 (Medium, governance) — Session rows carry no provenance metadata.** No device label/user-agent, no IP hash, no sign-in business selection. Investigating "who signed in at 22:40 from where?" has to stop at "account X, sessionCount 2".

**F-5 (Medium, security-hygiene) — Action evidence is thin.** `SET_ACCESS`/`END_SESSION`/`RESET_PASSWORD` on `/api/staff-access` are authorized and reversible but do not write into the app's own `audit_trail` (`record_deletion_logs`-style forensics exist elsewhere — staff-access should emit too). For a live-ops console this is the place an auditor first checks.

**F-6 (Low, tenant-enumeration) — Error language leaks org existence.** Messages like "That user belongs to a different organization." confirm to an attacker probing sequential ids that another org exists. Prefer a single refusal ("Not in your scope") outside the audit log; keep the detail in server logs/audit only.

**F-7 (Low, transitional debt) — The legacy org-less bypass** is correct additively but is a permanent hole if left: any future user accidentally created without `organization_members` rows escapes the org boundary. Needs a one-time backfill + a creation-path invariant, not UI work.

**Non-findings (already sound):** per-row org isolation on read/write, delegated scope checks, OWNER/self protection, revocation semantics (password cleared + force-admission), presence parking model, `endReason` taxonomy (`DISABLED/FORCE_LOGOUT/…`).

## 3. Design principles for the target state

1. **Secure-by-scope:** the API decides visibility; the UI never re-filters across scopes.
2. **One session, many scopes:** presence is per *account*, placement (org → business → branch) is *display*, not identity.
3. **Normal Owners must never sense other orgs exist** (no org dropdown, no org names, no cross-org hints). Their clarity comes from grouping the *business* they own.
4. **Super Admin reads cross-org explicitly, never accidentally.** Cross-org visibility must be an intentional act (selector/drill-down), with org identity on every row.
5. **Additive-only migrations:** extend `GET /api/staff-access` with grouped payload + optional params; keep the current flat shape valid (suites depend on `sis-*` testids and row preseence semantics).

## 4. Recommended approach

### Phase A — Server-side grouping (zero schema change; highest value)

Change `GET /api/staff-access` to compute scope once and return **both** the flat list (back-compat) and a nested structure:

```jsonc
{
  "success": true,
  "meta": { "canView": true, "canManage": true,
            "scopeType": "SUPER_ADMIN" | "OWNER_ORG" | "MANAGER_BRANCHES",
            "orgCount": 3, "businessCount": 9, /* existing counters */
            "groups": [
              { "orgId": 1, "orgName": "GoMina Group", "orgStatus": "ACTIVE",
                "businesses": [
                  { "businessId": 1, "businessName": "Mina Akuafo Poultry Farm",
                    "businessCode": "POULTRY-01", "staffCount": 6, "onlineCount": 2,
                    "hq": false },
                  { "businessId": 0, "businessName": "— Shared / HQ (no primary branch) —",
                    "hq": true, "staffCount": 2 }
                ] }
            ] },
  "staff": [ /* current flat rows, enriched per row:
                   organizationId, organizationName (masked for non-super-admins: omit entirely),
                   primaryBusiness:{id,name,code,branchLocation},
                   isPrimaryHome:  true|false  */ ]
}
```

Rules:
- **Normal Owner:** one org group; businesses = owner's org businesses sorted by onlineCount desc; HQ bucket captures multi-branch/org-level accounts (`assignedBusinessId NULL`). No org fields in the response *at all* beyond their own org id (F-6).
- **Super Admin:** `meta.scopeType=SUPER_ADMIN`; groups = ACTIVE orgs (plus "Suspended" collapsed), ordered by online count; a `?organizationId=` query narrows the board (and powers any drill-down link from the Super Admin panel); `staff` rows always carry `organizationName` for SA only.
- **Delegated manager:** `scopeType=MANAGER_BRANCHES`; groups restricted to their granted businesses; org fields omitted (unless SA).

### Phase B — Display (pure UI work)

1. **Collapsible group headers** `Org ▸ Business ▸ rows` with per-group KPI strip (signed-in/online/disabled/revoked) — reuse the current `sis-*` row markup verbatim, just nested.
2. **Scope switcher above the table**, visible per role:
   - super admin: Organization dropdown (default "All organizations — grouped"), Suspended-orgs toggle;
   - owner: Business dropdown (default "Whole organization"), plus existing presence filter;
   - manager: no switcher (scope is already narrowed).
3. **Row enrichment:** secondary line "4 granted branches" expands to a chip list (fixes F-3 ambiguity); presence tooltip "session is account-wide, not per-branch" copy (one line) to teach the semantic.
4. **Suspended org styling** for SA (greyed group, "SUSPENDED" pill) — suspension context matters next to presence.
5. **Keep 15s polling; stop `load()` flicker by updating rows in place** (minor UX, part of same edit).

### Phase C — Session provenance (additive columns; enables F-4)

Extend `user_sessions` (additive, backfill-safe): `device_label text` (parsed UA, client-side), `ip_hash text` (SHA-256(ip + local salt), never raw IP), `user_agent text` (truncated 200), `initial_business_id integer NULL` (the business chosen at sign-in / first focus).
- SignedInStaff row adds: "Chrome · Android (Accra-GPS)"-style line + "signed-in at POULTRY-01" when set; SA additionally sees ip hash.
- The heartbeat keeps being the sole writer of `lastSeen/revokedAt`; `initial_business_id` set on login and updated only when the user *changes focused business first time* — never elasticity games.

### Phase D — Governance hardening (small, high leverage)

1. Route `SET_ACCESS / END_SESSION / RESET_PASSWORD / CREATE-SESSION-OPS` through `writeTrail`/`audit_trail` (actor × target × action × endReason payload), so the Audit Command Center surfaces staff-access events (fixes F-5).
2. Replace cross-org refusal wording with scope-blind refusal (fixes F-6): `403 { error: "That account is outside your scope." }`, detailed only in server logs.
3. One-time migration: backfill `organization_members` + `primary_org_id` for all legacy users into GoMina Group (org 1) / their appropriate org; afterwards make `/api/users` create-invocations reject org-less accounts (orgId required on write path) → the F-7 bypass shrinks to read-compat only.

### Out of scope explicitly
- Per-business sign-in (separate presence per branch) — changes session semantics globally; revisit only if product asks for "who is physically at X" rather than "who is online in our app".
- Redis/CRDT presence (current 15s SQL poll is well within load at this scale).

## 5. Acceptance tests (when implementing)

Add to existing suites rather than new ones:
- `verify-staff-access` (G-block): assert grouped payload shape + SA drill-down (`organizationId` narrows; other orgs absent), legacy user appears only in legacy/org bucket, actions still 403 out-of-scope with blinded wording.
- `multiowner-verify`: org-A owner sees only org-A rows in `groups[0].orgId`; suspended org B members vanish from A's board pre/post suspension; SA board lists both orgs as separate groups and never mixes rows.
- `audit-notify-verify`/`audit-security`: SET_ACCESS rows present in `audit_trail` with actor/target; F-6 wording asserted (`different organization` phrase gone).
- Panel snapshot: per-group KPI strip renders (testids `sis-group-{orgId}` / `sis-bizgroup-{businessId}`) without removing existing `sis-row-*`.

## 6. Effort estimate

| Phase | Files | Effort |
|---|---|---|
| A (grouped API + scope metadata) | 1 route, 1 lib (`orgGrouping.ts` exists — extend) | 0.5–1 day |
| B (panel grouping UI + switchers) | `SignedInStaffPanel.tsx` | 0.5–1 day |
| C (session provenance) | schema/migration, login, heartbeat, panel | 1 day |
| D (audit trail + wording + org backfill) | route + migration + users route | 0.5 day |

Total ≈ **2.5–3.5 dev-days**, fully additive, suites kept green by extending rather than replacing behavior.

## 7. Verdict

The board is **already tenant-correct on the wire** (post-P0–P3): nobody can read or act outside their authorized scope. The remaining problem is purely **display organization and governance evidence** — solved cleanly by (A) server-computed org→business grouping with scope-aware response shaping, (B) grouped/collapsible UI with per-scope switching, (C) additive session provenance, (D) audit-trail wiring. No breaking change to the session model, the presence pipeline, or any consumer of `/api/staff-access` is required.
