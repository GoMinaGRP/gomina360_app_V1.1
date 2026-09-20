# Phase 0 — Security Hardening Report (pre multi-owner)

**Date:** 2026-09-14 · **Branch:** `arena/01a0a375-gomina360-app-v1-1` · **Scope:** F1/F2 fixes + same-pattern review. No multi-owner architecture changes. All existing data and functionality preserved (row-count baseline re-verified).

## Findings fixed

| # | Route | Issue | Fix |
|---|-------|-------|-----|
| F1 | `GET /api/logs/[businessCode]` | No authentication at all | Session required; business code must map to a business the caller can access (`canAccessBusiness`), else 403/404 |
| F2 | `/api/enterprise` | `businessId \|\| 1` fallback silently defaulted to business 1; identity fields taken from the client | Fallback removed; actor derived from session; access checked per record; employee-creation path gates on `canAccessBusiness(data.businessId)` |
| F3 | Module routes (block-factory, aquaculture, carwash, electronics, restaurant, hardware, telecom, checklists) | Session required but no business-scope check — any signed-in user could read/write any business | `canAccessBusiness` guard after every businessId resolution — GET/POST and every PATCH entity block (with pre-fetch + 404 where handlers were update-first) |
| NEW-a | `GET /api/sales-documents` (unscoped) | No businessId param ⇒ returned ALL businesses' documents | Unscoped listing filtered through `accessibleBusinessIds`; explicit businessId must be accessible |
| NEW-b | `DELETE /api/checklists?id=…&role=…` | Authorization taken from the client-supplied `role` query param (spoofable OWNER) | Role derived from session; template fetched → 404 → `canAccessBusiness(existing.businessId)` → delete |
| NEW-c | `/api/users/workers` (GET/POST/PATCH/DELETE) | Returned raw `users` rows incl. `passwordHash`, `failedLoginAttempts`, `lockedUntil`; zero role/scope gates (back door around `/api/users`) | `stripSecret` on every response (adds `hasPassword` boolean); `managerCanScope` (OWNER, or GM/BM with access to the worker's business) gates all writes and reads-by-business |
| NEW-d | `PATCH/DELETE /api/assets` | `actorRole`/`actorUserId`/`actorName` trusted from body/query (`"OWNER"` ⇒ full power) | Role & identity derived from session; `canAccessBusiness` on the asset's business; transfers additionally require access to the target business; audit rows stamped from session |
| NEW-e | `/api/assets/audit` (GET/POST/PATCH) | Unscoped GET; any signed-in user could APPROVE asset requests; requester identity client-supplied | GET scoped via asset→business; POST stamps requester from session + access check; PATCH requires session role OWNER/GENERAL_MANAGER + access to the asset's business; approver stamped from session |
| NEW-f | `POST /api/assets/download` | Client-supplied downloader id/name/role | Downloader identity stamped from session; optional business context must be accessible. `GET` history: only OWNER/GM may read other users' history |

`POST /api/sales`, `POST /api/branch-unit` received `canAccessBusiness` guards as well.

**Verified already-safe (no change):** poultry (`canAccessBusiness` per handler), poultry/knowledge (static corpus), notifications (scoped to session user), attendance `SET_BUSINESS_LOCATION`, `/api/order` (public storefront — validates input, no auth needed by design), `/api/enterprise` PATCH (actor from session, `recordPermissions` flags resolved server-side).

## Verification results

- `tsc --noEmit`: **0 errors**; `eslint src/app/api`: **0 errors** (3 pre-existing warnings unrelated to these changes).
- `dev-tooling/audit-security.mjs`: **23/23 clean** (S1–S6c, incl. SQLi/XSS probes, DB-intact check, no password material in API responses).
- `dev-tooling/phase0-authz-matrix.mjs`: **63/63 pass** — anon / Owner / GM / BM(biz1) / BM(biz2) / Worker(biz1) × read+write, cross-business denials, role-spoof attempts (`actorRole:"OWNER"`, `?role=OWNER`, `requestedByUserId:999`) all neutralized and DB-verified.
- Legit flows preserved: GM (grants on all 8 businesses) reads any business; BM reads/writes own business (worker create+delete round-trip OK); Worker reads own business module data; Owner retains full access.
- Data preservation baseline re-counted after all tests: `businesses=8, users=18, poultry_logs=2, employees=7, inventory_items=11, transactions=6` — matches pre-work baseline exactly. All rows created during testing were deleted.

## Notes / residuals (defer to multi-owner phase, D1–D5)

1. `record_deletion_logs` has no `businessId` column, so `GET /api/enterprise?deletionLogs=1` is a global (session-gated) list; scoping lands with the multi-owner schema work.
2. Frontend callers always send explicit `businessId` and (for workers panel, checklists, assets) run in a business context, so no UI regressions are expected; the removed client-side `role`/`actorRole` parameters are simply ignored server-side now.
3. Test credentials used: Owner `kwame.owner@gomina360.com`, GM `abena.gm@gomina360.com`, BM `emmanuel@gomina360.com` (biz1), BM `kofi@gomina360.com` (biz2), Worker `akua.donkor@gomina360.com` (biz1).
