# Signed-In Staff — Phase A–D Implementation Report

**Branch:** `arena/01a0a375-gomina360-app-v1-1` · **Date:** 2026-09-19 · **Scope:** implementation of `reports/SIGNED-IN-STAFF-AUDIT.md` (findings F-1…F-7)

## What shipped (per phase)

### Phase C — session provenance (schema + capture)
- `user_sessions` gained **4 nullable columns** (pushed via `drizzle-kit push`, zero-downtime, additive): `device_label`, `user_agent`, `ip_hash`, `initial_business_id`. Heartbeat **never overwrites** them — they describe *this sign-in's origin*.
- `src/lib/auth.ts`: `createSession(userId, provenance?)` writes the four fields. New exports:
  - `hashClientIp(request)` → `sha256(ip + ":" + IP_HASH_SALT)` (256-bit, salted, **no raw IP stored**; `null` when no client IP is visible);
  - `deviceLabel(request)` → friendly label (`"Chrome · Android"`, `"Safari · iPhone"`, …) + truncated raw UA (≤220 chars).
- `src/app/api/auth/login/route.ts`: every login stamps the new session with label, UA, ip hash and the account's `initialBusinessId` (assigned primary branch).

### Phase A — grouped API (server-side, additive)
`GET /api/staff-access` now returns, in addition to the untouched flat `staff` array:
- **Per-row**: Phase-C provenance from the newest live session — `deviceLabel`, `ipHash`, `initialBusiness{id,name,code}`; `grantedBranches[{id,name,code}]` (resolves the old `grantedBusinessIds` to names); for **Super Admin only**, `organizationId/Name/Status` + `extraOrgCount` (multi-org badge data). Non-SA viewers receive **no org fields at all** (blind by omission).
- **`meta.scopeType`**: `SUPER_ADMIN` | `OWNER_ORG` | `MANAGER_BRANCHES`; **`meta.organizationCount`** and **`meta.drillOrg`**.
- **`meta.groups[]`**: display-only grouping (flat list stays the authorization contract): `{orgId, orgName, orgStatus, counts{total,signedIn,online}, businesses[{businessId, businessName, businessCode, counts, staffIds}]}`, sorted live-first. Business id `0` = the *"— Shared / HQ —"* bucket (no primary branch).
- **SA drill-down**: `?organizationId=N` narrows the board **server-side** to members of org N (unknown org → zero rows, no oracle).
- Non-SA viewers get exactly ONE group: the Owner's own organisation (with its **real name** — an owner knows their own org; no cross-org signal), or a neutral *"Your branches"* bucket set for delegated managers. **No flat-view regressions**: `staff` fields, `meta` counters and sort order are unchanged.

### Phase B — grouped UI (`SignedInStaffPanel.tsx`)
- Collapsible **Organization ▸ Business** group board on top of the identical row cells (all `sis-row-*`, `sis-kpi-*`, filter, refresh, notice, modal testids preserved); new wrappers `sis-group-{orgId}` / `sis-bizgroup-{businessId}` with per-group count strips (staff / signed-in / online).
- **Super Admin**: *PLATFORM VIEW · N ORGS* badge, org drill-down selector (`sis-orgfilter`, options cached from the unfiltered load), suspended-org styling (`ORG {STATUS}` chip, rose tint), org identity line under each staff cell (`sis-org-{id}`).
- **Owner**: single named group header + business-unit selector (`sis-bizfilter`); other owners' staff never reach the browser (server scope unchanged).
- **Delegated managers**: neutral branch buckets only (`Your branches`), no org data rendered anywhere.
- Provenance in cells: device line with hashed-source tooltip (`sis-device-{id}`), first-business-opened marker (`sis-firstbiz-{id}`), granted-branch chips (`sis-branches-{id}`).
- Legacy fallback table retained if a pre-Phase-A server responds without `groups`.

### Phase D — governance + debt
- **Audit trail on every POST action** (never-throwing `auditLog`, convention `target_type='USER'`, `record_id=<userId>`, actor org in `owner_id`):
  - `SET_ACCESS ACTIVE/DISABLED/REVOKED` → `STAFF_ENABLE` / `STAFF_DISABLE` / `STAFF_REVOKE` (with branch code of the target's primary branch);
  - `END_SESSION` → `STAFF_FORCE_LOGOUT`.
- **Blinded refusal wording**: cross-org and super-admin-target attempts now return a uniform `That account is outside your scope.` (no "different organization" / "outside your reach" phrasing — kills the org-existence oracle), with a **server-side `console.warn`** carrying actor-org/target-org ids for forensics. HTTP codes unchanged (403).
- **Org-membership backfill** (`dev-tooling/backfill-org-members.mjs`, advisory-locked, idempotent): any org-less user is enrolled into the org that owns their primary branch (`assigned_business_id → businesses.owner_id → organizations.owner_user_id`), fallback org #1; sets `primary_org_id` when empty. Wired into `setup-runtime.sh` (runs on every bring-up). Live DB: **0 orphans**.

## Verification battery (all on the production build)

| Suite | Result | Notes |
|---|---|---|
| `verify-staff-access.mjs` | **44/44 ✅** | original behaviour suite — full backward compat (rows, KPIs, disable/enable/revoke, force-logout, manager scoping, zero console errors) |
| `verify-staff-access-grouping.mjs` *(new)* | **27/27 ✅** | P1 group assembly/counts vs flat rows; P2 provenance (label/ip-hash/initial-business, heartbeat preserves columns); P3 SA drill-down; P4 fresh temp org+owner → OWNER_ORG single named group, own-cohort isolation, no org-field leak on owner rows, SA drill == owner cohort; P5 audit rows STAFF_DISABLE/STAFF_ENABLE/STAFF_FORCE_LOGOUT; P6 uniform blind 403; P7 no legacy wording. Self-cleaning. |
| `verify-staff-access-agui.mjs` *(new)* | **11/11 ✅** | headless-browser board: group/bucket headers + counts, SA badge + selector, provenance lines, org identity lines, collapse/expand integrity, 15 s auto-poll regroup, zero page errors |
| `multiowner-verify.mjs` | **118/118 ✅** | org isolation, marketplace, suspend/reactivate, owner provisioning |
| `audit-security.mjs` | **23/23 ✅** | injection/XSS/credential sweep |
| `audit-notify-verify.mjs` | **104/104 ✅** | issue lifecycle + cross-tenant silence |

Total: **327 checks, 0 failures.**

## Security & tenancy guarantees (re-asserted)
- The **flat server-scoped `staff` list remains the sole authorization path**; grouping is assembled *after* scoping from the same rows — display cannot widen visibility (verified P4: owner rows carry no org identifiers; P3: drill of foreign org returns 0 rows).
- Cross-org POST actions refused uniformly (403) with no existence signal; refused attempts are logged server-side with both org vectors.
- No raw IPs or full UAs in the API response — label + salted hash only.

## Files touched
`src/db/schema.ts` · `src/lib/auth.ts` · `src/app/api/auth/login/route.ts` · `src/app/api/staff-access/route.ts` · `src/components/SignedInStaffPanel.tsx` · `dev-tooling/backfill-org-members.mjs` *(new)* · `dev-tooling/setup-runtime.sh` · `dev-tooling/verify-staff-access-grouping.mjs` *(new)* · `dev-tooling/verify-staff-access-agui.mjs` *(new)*
