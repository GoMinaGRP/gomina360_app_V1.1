# GoMina 360 — Multi-Owner Upgrade: Inspection Report & Recommended Plan

**Status: PLAN ONLY — no code, schema, or data has been modified.**
Prepared 2026-09-15 after a full source inspection and a live run of the current app.

---

## 1. How this was verified (provenance)

The current app was **run and tested unmodified** in a sandbox:

- Embedded PostgreSQL 18.4 (`dev-tooling/start-pg.mjs`) + `npx drizzle-kit push` + `/api/init` seed.
- Next.js dev server on `0.0.0.0:3000`; `/api/health` → `{"ok":true}`.
- Signed in as the current Owner (`kwame.owner@gomina360.com` / factory password `Owner@GoMina26`), the General Manager (id=2) and a Branch Manager (id=3).
- Verified live: owner sees all 8 businesses (`accessibleBusinessIds: null` = unrestricted); GM sees granted units `[1..8]`; BM sees only `POULTRY-01` (businesses, users, transactions, assets, employees all scoped server-side).
- Verified live: audit scope resolution (OWNER → `level:"OWNER", businessIds:null`), staff-access gating (BM → `canView:false`), notification fan-out query, public storefront (`/api/menu` = 6 trading businesses with no login).

**Everything below comes from reading the actual code and probing the running system — not assumptions.**

---

## 2. Current architecture (what exists today)

### 2.1 The tenant model: there is exactly one, and it is the `OWNER` role

- The entire database belongs, implicitly, to **one Owner account**: `users.id = 1`, *Kwame Mina*, `role = "OWNER"`, `assignedBusinessId = null`.
- There is **no owner/organization column anywhere** in the 96-table schema. The tenant boundary is *not in the data* — it is in the code, as 78 `role === "OWNER"` checks (+12 `role !== "OWNER"`) spread across **34 files**.
- Access rule (centralized in `src/lib/auth.ts`):
  - `role === "OWNER"` → `accessibleBusinessIds()` returns `null` → **unrestricted**.
  - Everyone else → `assignedBusinessId` ∪ `user_business_access` grants ∪ `businessManageIds` (manage grants).
- Every business record chains off `businesses.id` (`businessId` FK-style column + denormalized `branchCode`/`branchName`).

### 2.2 Data map (96 tables)

| Class | Count | Tables / meaning |
|---|---|---|
| `businessId` NOT NULL | 74 | All operational data: transactions, inventory, employees, payroll, assets, all 8 module log families, checklists, credit sales, tracking, audit reviews/assignments, notifications source data |
| `businessId` nullable | 5 | `customers` (null = “shared across units”), `universal_exports`, `ai_insights` (null = enterprise-wide), `notifications`, `audit_trail` |
| No `businessId` at all | 17 | `users`, `user_sessions`, `user_business_access`, `businesses` (root), `suppliers` (**enterprise-shared directory**), `integrations` (group-wide), `company_settings`, `customer_support_info`, `payroll_statutory_config`, `push_config` (4 singleton `id=1` rows), `scenario_simulations`, `record_deletion_logs`, `asset_audit_logs`, `inventory_downloads`, `asset_downloads`, `audit_issue_updates`, `push_subscriptions`, `user_push_settings` |

### 2.3 Auth & sessions

- scrypt password hashes (`scrypt:salt:hash`); 5-strike / 15-min lockout; `accessRevokedAt` kill-switch.
- Server-side sessions: 32-byte bearer token, only SHA-256 hash stored; httpOnly `SameSite=None; Secure; Partitioned` cookie **plus** a `x-gomina-session` header fallback for iframe previews (`sessionBridge.ts`); 7-day TTL + 10-min idle expiry; soft-close audit (`end_reason`), `revokedAt` park/unpark drives the Online chip.
- Sessions are bound to `userId` only — **no org/tenant context**.

### 2.4 Roles & permission grants (`users` table)

`OWNER`, `GENERAL_MANAGER`, `BRANCH_MANAGER`, `SUPERVISOR`, `ACCOUNTANT`, `WORKER` + 13 OWNER-granted flags: `canManageRecords, canDeleteInventory, canManageExpenses, canManageUsers, canManageCctv, canManageAuditors, canManageOnline, canCreateBusiness, canViewFinance, canManageSupport, canExportData, canRecordSales/Expenses/Stock` and `businessManageIds[]` (unit-manage power). Grant/revoke is OWNER-only everywhere (verified in `/api/users` PATCH: a 100-line privilege matrix protecting elevation, password resets, and the OWNER account itself — “The OWNER account must remain an active OWNER”, `/api/staff-access`: “the OWNER account can never be disabled or revoked”).

### 2.5 Dashboards / reports / notifications / audit

- **Main dashboard payload**: `/api/init` — select-all-then-filter in JS for ~20 entity sets, scoped by `accessibleBusinessIds`. Executives get the full user directory; others get same-business accounts only.
- **Reports/exports**: `/api/exports`, `/api/inventory/download`, `/api/assets/download`, `UniversalExportCenter` with approval workflow + QR audit trails.
- **Notifications**: DB bell (`notifications`) + Web Push (`push_subscriptions`/`user_push_settings`, global VAPID in `push_config id=1`). Fan-out (`lib/notify.ts`): *“the OWNER + assigned staff + grantees”* — **the recipient rule is hard-coded to the single global OWNER role**.
- **Audit center**: `audit_assignments` (scoped by business/branch/modules), `audit_reviews` issue pipeline, `audit_issue_updates`, immutable `audit_trail`, `record_deletion_logs`, `asset_audit_logs`, `employee_history`, download trails. OWNER level = unrestricted; auditors strictly assignment-scoped.
- **Public storefront (no login)**: `/api/menu`, `/api/order`, `/api/track`, `/api/support-info` — aggregates **all** trading businesses group-wide; tracking codes are the sole access key (`GM-…`).
- **Backup/restore**: `/api/business-backup/export|import` walks a well-defined business subtree (`lib/businessBackup.ts` `TABLES` registry) with PK remapping — a huge asset for the migration (see §6.4).

---

## 3. Findings that directly shape the upgrade

### 3.1 Pre-existing security findings (fix regardless of multi-owner)

| # | Finding | Evidence |
|---|---|---|
| F1 | **`/api/logs/[businessCode]` requires NO authentication.** Any anonymous caller can pull operations logs for any business by guessing a group-style code. Verified live: `GET /api/logs/POULTRY-01` → full poultry logs with zero session. `getSessionInfo` is imported but never invoked on the GET path. | `src/app/api/logs/[businessCode]/route.ts` |
| F2 | **Cross-business write default `|| 1`.** `/api/enterprise` POST `employee` and `inventory` fall back to `businessId: … || 1` when the client omits it — the `canAccessBusiness` guard only runs when an id is *present*. A restricted user can write into business #1 by omission. Today this is intra-tenant; under multiple owners it becomes **a cross-tenant write**. | `src/app/api/enterprise/route.ts:390, :582` |
| F3 | Global unique constraints that will break under multiple owners: `expense_categories.name` (`.unique()` — two owners can’t both have “Fuel”), `users.email` (globally unique — two owners’ staff can’t share an email; that may be intended, but it is a decision), plus 33 global `.unique()` columns to classify (§5.3). | `src/db/schema.ts` |

### 3.2 Hard-coded singletons and identity assumptions

- `users.id = 1` treated as **the** Owner in `seed.ts` (audit rows `actorUserId: 1`) and `user_id = 2` as **the** GM (`ensureHardwareFlagship` raw-SQL grants, seed repair paths).
- Four singleton “single live row, id=1” tables: `company_settings` (logo), `customer_support_info` (storefront HELP, read publicly), `payroll_statutory_config` (Ghana SSNIT/PAYE rates), `push_config` (VAPID keypair). Under multiple owners the first three are **per-owner data**; the fourth is infrastructure (can stay global).
- `seedDatabase()` mints the one Owner with factory credentials and runs **on every `/api/init` call** (provisioning via read path) — owner onboarding must become an explicit flow.
- 41 route files use select-all-then-filter-in-JS; a missed filter is a leak, today and after the upgrade (mitigated by plan §6.5).
- The OWNER concept is overloaded: it means “super user of *the* deployment” and “owner of *the* company”. With multiple owners these must be split (§4).

### 3.3 What is already multi-owner-friendly (do not underestimate)

- **Everything chains off `businesses.id`** — 74 tables with NOT NULL `businessId`, consistently enforced; grants keyed by businessId; audit/notification scoping all business-keyed.
- `accessibleBusinessIds()` is a **single chokepoint** used nearly everywhere.
- The whole-business **backup/restore engine already serializes an entire business subtree with dependency remapping** — the definition of “one owner’s complete data” will be `businesses WHERE owner_id = ?` joined through exactly this registry.
- Frontend is already role-driven (`GoMinaApp.tsx` gates tabs by role/flags) and consumes server-scoped payloads.

---

## 4. Recommended target architecture

### Option analysis

| Approach | Verdict |
|---|---|
| **A. Single DB, shared schema, add `owner_id` organization discriminator** | ✅ **Recommended** — matches the existing business-scoped enforcement, one pool (Vercel/serverless-friendly), additive migration, reversible |
| B. Schema-per-owner (`org_acme.*`) | ❌ Migrations × N, cross-owner super-admin queries become painful, pool-per-schema |
| C. Database-per-owner | ❌ Best isolation but deployment/provisioning complexity far beyond this team’s current shape; breaks the single `DATABASE_URL` model |
| D. A **plus** Postgres Row-Level Security (RLS) as defense-in-depth | 🟡 Phase-5 optional hardening; do **not** make RLS the only barrier (Drizzle bypasses per-user roles are extra work; app-level scoping must remain primary) |

### 4.1 Target model

```
platform_admins / super admin (users.is_super_admin)
        │  can read across orgs for support, never auto-member
        ▼
organizations (NEW)  ──────────────┐ (one row per independent Owner)
   id, name, slug,                  │
   status, createdBy, …             │ owner_id
        ▼                           ▼
organization_members (NEW)        businesses.owner_id → organizations.id
 user_id ↔ organization_id        (every current business gets owner 1)
 role_in_org: OWNER               ▼
        │              all 96 tables inherit org scope transitively via
        └───────────── businessId → businesses.owner_id, and directly via
                       an owner_id column on the tables that need it (§5)
```

**Dual role for the current Owner:** *Kwame Mina* (`users.id=1`) becomes
`is_super_admin = true` **and** the `OWNER` member of organization #1
(“GoMina Group”). From his seat, nothing changes; he additionally gains the
platform view to provision and support other owners.

### 4.2 Role redesign (the critical semantic change)

| Today | After upgrade |
|---|---|
| `role = "OWNER"` (one global super user) | `users.is_super_admin` (platform level, tiny list) **separate from** per-org `role = "OWNER"` (organization_members / kept in `users.role` for compatibility, but evaluated **within the caller’s org**) |
| `accessibleBusinessIds() → null` ⇒ all businesses | Returns org-scoped ids; `null` only for super_admins. An org OWNER gets *all businesses of their own org*, never other orgs |
| “OWNER may grant anything” | An org OWNER grants only inside their org; cross-org grants (`user_business_access`, `businessManageIds`, `audit_assignments`) rejected at the API **and** constrained in SQL |
| GM id=2 / owner id=1 assumptions | Resolved via `organizations` + memberships, never hard-coded ids |

Session shape gains `orgId` (the org the user is acting in); super admins get
an explicit, audited **org switcher** (support access logged in `audit_trail`).

---

## 5. Complete change inventory

### 5.1 Schema (all additive, idempotent — nothing destructive, ever)

| Table(s) | Change |
|---|---|
| **NEW `organizations`** | id, name, slug (storefront), status, contact, logo?, created_by, created_at |
| **NEW `organization_members`** | org_id, user_id, role_in_org, is_primary, unique(user_id, org_id), FKs |
| `businesses` | `+ owner_id integer` → backfilled 1 → NOT NULL → FK + index. `code` stays globally unique (public storefront identity; also prevents customer confusion between owners) |
| `users` | `+ is_super_admin boolean default false`, `+ primary_org_id integer`. Keep `email` globally unique (recommended — one login identity per person; org membership is separate) |
| 74 business-linked tables | No column needed *if* every query joins through `businesses`; **recommend adding denormalized `owner_id` to high-traffic/audit tables** (`transactions`, `inventory_items`, `sales_documents`, `customer_trackings`, `credit_sales`, `employees`, `assets`, `payroll_runs/entries`, `notifications`, `audit_trail`, `audit_reviews`, `record_deletion_logs`, `*_downloads`, `universal_exports`, `employee_history`, `business_insights`) — backfilled by join. Enables single-column filtering, cheap per-owner purge/export, and later RLS |
| `suppliers` | `+ owner_id` (today “enterprise-shared” = implicitly org-1-shared) |
| `integrations` | `+ owner_id` (group-wide → per-owner) |
| `customers` | `+ owner_id`; the `businessId = null “shared across units”` case becomes “shared across **the owner’s** units” |
| `ai_insights`, `scenario_simulations` | `+ owner_id`; “enterprise-wide” (null business) ⇒ “this owner’s enterprise” |
| `company_settings`, `customer_support_info`, `payroll_statutory_config` | Convert singleton `id=1` → **one row per organization** (`org_id` unique); all `eq(id, 1)` call sites (init, logos, payroll, support-info) resolve the caller’s org |
| `push_config` | Stays global (platform VAPID keypair) — infrastructure, not tenant data |
| `expense_categories` | Drop global `name` unique → composite unique `(owner_id, name)` (+ carries `owner_id`) |
| `user_business_access`, `audit_assignments` | No column strictly required; enforce “grant business ∈ user’s org” in code + `CHECK`/FK-composite later; optional `owner_id` for fast purges |
| `user_sessions`, `push_subscriptions`, `user_push_settings` | Unchanged (user-scoped) |
| Sequences/codes | Stay **globally** unique where public (`businesses.code`, `trackingCode`, `transactionNumber`, `documentNumber`, `assetCode` per branch scheme, voucher codes) and generators must stop scanning *all* rows: `nextBusinessCode`, asset-code probing, SKU sequences etc. become org-filtered (also removes an enumeration side channel) |

### 5.2 Auth / access layer (`src/lib/auth.ts` — the chokepoint)

- `getSessionInfo` → additionally resolves memberships (`organization_members`) → `{ user, sessionId, orgId, isSuperAdmin }`.
- `accessibleBusinessIds(user, orgId)`:
  - super admin + no explicit org context → `null` (all) *or* an explicit org selection (support mode, audited);
  - org OWNER role → all `businesses WHERE owner_id = orgId` (no more global `null`);
  - others → existing union **∩** `owner_id = orgId`.
- Every `role === "OWNER"` check (34 files) re-mapped to a helper: `isOrgOwner(ctx)` / `isSuperAdmin(ctx)` — this replaces the overloaded meaning safely and centrally (introduce `requireOrgOwner`, `requireSuperAdmin`).
- Grants, `businessManageIds`, audit assignments, notification fan-out recipients: “the OWNER” ⇒ “**the target business’s org OWNER(s)** (+ super admin where appropriate)” — `lib/notify.ts`, `lib/trackingServer.ts`, `/api/audit`, `/api/users`, `/api/staff-access` all updated; cross-org recipient leakage becomes impossible by construction.

### 5.3 API routes (61 handlers) — treatment classes

| Class | Routes | Work |
|---|---|---|
| Org-filtered reads/writes (most) | `/api/init`, `/api/businesses*`, `/api/enterprise`, `/api/transactions`, 8 module families (`poultry`, `block-factory`, `aquaculture`, `carwash`, `electronics`, `restaurant`, `hardware`, `telecom`, `livestock` via logs), `/api/checklists`, `/api/daily-notes`, `/api/sales*`, `/api/credit-sales`, `/api/expense-categories`, `/api/attendance`, `/api/payroll`, `/api/cctv`, `/api/assets*`, `/api/exports*`, `/api/tracking`, `/api/service-areas`, `/api/branch-unit`, `/api/logs/[businessCode]`, `/api/business-backup/*` | Add org scope to the existing access check; fix F2 defaults; push filters into SQL where cheap |
| User/admin management | `/api/users*`, `/api/staff-access`, `/api/users/workers`, `/api/profile`, `/api/auth/*`, `/api/session/*` | Org membership semantics; elevation restricted to org; super-admin protections preserved |
| Audit & notifications | `/api/audit*`, `/api/notifications`, `/api/push/*` | Scope per org; recipients per org |
| Public storefront | `/api/menu`, `/api/order`, `/api/track`, `/api/support-info`, `/api/geocode`, `/api/reverse-geocode` | **Decision D1 below** (single marketplace vs per-owner storefront); tracking codes stay global keys; support-info per org |
| Platform | `/api/init` (stop seeding via GET — make provisioning explicit), `/api/health` (add per-org check), NEW `/api/admin/organizations*` (super admin: list/provision/suspend orgs, audited) | New flows |

### 5.4 Frontend (`src/components/*`)

- LoginScreen: unchanged UX (email+password); server resolves org (single-org users无缝; multi-org users pick).
- `GoMinaApp` + `Navbar`: org context label; super-admin org switcher; hide cross-org affordances.
- `UserAccessConsole`/`EnterpriseUserPanel`: manage only in-org users; “OWNER” wording per org.
- `ManageBusinessesModal`/`NewBusinessModal`: create units stamped with caller org.
- `UniversalExportCenter`, dashboards, `ContextNavigator`: all receive org-scoped payloads automatically once the API layer is scoped; add per-org branding resolution (`company_settings` per org).

### 5.5 Provisioning, seed, migrations tooling

- `seed.ts`: seeds **org #1 only** (current demo data) and marks user 1 super-admin. Remove `user_id=2`-style hard-codes (resolve by role within org).
- New-owner onboarding (implementation choice D2): Main-Owner-console “Create Owner” → creates org + OWNER membership + clean workspace (reuse `provisionBusiness`-style minimal seed; **no** demo data).
- `dev-tooling/migrate-production-schema.mjs`: extended with the additive org columns/backfills (idempotent; `pg_advisory_xact_lock` already used). `drizzle-kit push` for new tables/constraints in controlled order.

---

## 6. Migration plan (existing production data stays intact)

**Guiding rules:** additive-only SQL; NULL first, backfill, then NOT NULL; every step reversible/old-code compatible until the cutover flag; count-verified; backup first.

### Phase 0 — Safety & pre-existing fixes (no behavior change for valid users)
0.1 Take a full DB backup (`dev-tooling/backup-livedata.mjs` pattern) and store the archive.
0.2 Fix **F1** (auth gate on `/api/logs/[businessCode]`) and **F2** (`|| 1` defaults) as a tiny hardening PR — these are bugs today and cross-tenant holes tomorrow.
0.3 Snapshot row counts per table (baseline for §6.5 verification).

### Phase 1 — Additive schema (deployable immediately; zero user impact)
1.1 Create `organizations`, `organization_members`; insert org #1 “GoMina Group”.
1.2 Add all nullable `owner_id` / `is_super_admin` / `primary_org_id` columns + indexes.
1.3 Backfill (idempotent SQL, in a transaction): every existing business → org 1; user 1 → super admin + org-1 OWNER member; user 2 → org-1 member (GM); every other user → org 1 via their `assignedBusinessId.owner_id`; all business-linked tables → `owner_id` via `JOIN businesses`; global tables (`suppliers`, `integrations`, singletons, insights, scenarios) → org 1.
1.4 Convert singleton settings to per-org rows (copy row id=1 → org 1), relax `expense_categories` unique to `(owner_id, name)`.
1.5 Flip `businesses.owner_id` NOT NULL + FK; legacy code still ignores it — safe.

### Phase 2 — Core isolation engine (code)
2.1 Session/org context + `accessibleBusinessIds` org-scoping + `isOrgOwner/isSuperAdmin` helpers; re-map the 90 `OWNER` checks behind helpers (mechanical, file-by-file, typechecked).
2.2 Notification/audit/grant fan-out “per org” rewrite; sequence generators org-filtered.
2.3 Settings/logo/statutory/support-info lookups resolve caller org.
2.4 **Cutover switch**: `GOMINA_MULTI_OWNER=1` env gate between old/new code paths until Phase 4 proves green; rollback = unset.

### Phase 3 — Org lifecycle & UI
3.1 Super-admin console: list orgs, create Owner (org + membership + clean workspace), suspend org, impersonate-with-audit-log.
3.2 Login/org selection; Navbar org label & switcher; Users & Access scoped.
3.3 Public storefront decision D1 implemented (marketplace with owner attribution **or** per-owner `/[orgSlug]` storefront — recommendation: start with marketplace + `owner` attribution, keep per-owner slugs reserved in schema).

### Phase 4 — Hardening & verification
4.1 Every GET route added to an automated **isolation matrix test** (two orgs seeded; assert org-B user/session sees 0 org-A rows; assert anonymous sees 0 private rows; assert cross-org writes 403/404). Runnable like existing `dev-tooling/verify-*.mjs`.
4.2 Load test per-org scoping on init payload (indexes verified via `EXPLAIN`).
4.3 Remove env gate; keep helpers.

### Phase 5 — Optional defense in depth
- Postgres RLS policies (`owner_id = current_setting('app.org')`) on the big operational tables + `FORCE ROW LEVEL SECURITY`; separate DB roles. Only after Phases 1–4 are stable; app-level scoping remains the primary barrier.

### 6.4 Using the backup engine as a safety net
Before Phase 2 flips enforcement, export every business via `/api/business-backup/export` (owner session). If *anything* goes wrong later, each business subtree can be re-imported verbatim (`BACKUP_FORMAT_VERSION 1.0` already remaps PKs/FKs). This also gives the future “move/clone a business between owners” feature for free.

### 6.5 Verification gates (each phase blocks the next)
- Row-count diff per table: only `organizations/members` (+settings rows) should grow.
- Isolation matrix: 0 cross-org reads/writes; anonymous matrix unchanged.
- Golden-path E2E per role (existing `verify-live.mjs` suite must stay green).
- Owner experience diff test: current Owner’s dashboard payload before vs after = identical (modulo timestamps).

---

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Missed filter in a select-all-then-filter route ⇒ silent cross-org leak | Centralize scoping in query helpers; the Phase-4 isolation matrix runs over **every** route; code-review checklist for new routes |
| Overloaded `OWNER` semantics breaks something subtle | Introduce `isSuperAdmin` **without removing** `role=OWNER` in phase 2; re-map the 90 checks behind helpers; gate by env flag |
| Number-sequence collisions once many owners mint codes concurrently | Generators org-scoped (or tenant-prefixed) + keep DB unique constraints (already global for public codes); probe-loop already exists for asset codes — generalize it |
| Public storefront leaks competitor data between owners | D1 decision; per-owner `slug` reserved in schema now |
| Migration partially applied on Vercel builds | Advisory lock already in `migrate-production-schema.mjs`; all DDL additive/idempotent; rollback = redeploy previous build (old code ignores new columns) |
| “Current owner is special” assumptions (id=1/id=2) | Backfilled memberships make id=1 *also* a normal org OWNER; tests assert org-1 behavior identical |

## 8. Effort estimate (rough, single engineer)

| Phase | Scope | Est. |
|---|---|---|
| 0 | 2 security fixes + backup | 0.5–1 day |
| 1 | Schema + backfill + verification SQL | 1–2 days |
| 2 | Auth/org context + 90 check re-mapping + fan-out + sequences + settings | 4–6 days |
| 3 | Admin console, login/org picker, storefront decision, UI polish | 3–4 days |
| 4 | Isolation test matrix + perf + cutover | 2–3 days |
| 5 (optional) | RLS | 2–4 days |

## 9. Decisions needed from the product owner before implementation

- **D1 — Storefront topology:** one shared marketplace storefront where customers see all owners’ businesses (with owner attribution), or per-owner storefronts (`gominahub.com/<owner-slug>`)? *(Recommendation: shared marketplace first; schema reserves per-owner slugs.)*
- **D2 — New-owner onboarding:** Main Owner creates owners from an admin console (recommended for control), or public self-serve signup?
- **D3 — Email uniqueness:** keep one global login identity per person (recommended), or allow the same email in two orgs (requires login = email+org)?
- **D4 — Super-admin visibility:** should the Main Owner browse other owners’ operational data (with audit log), or act only on org settings/health (privacy-first, support via export-and-share)?
- **D5 — Phase 0 fixes:** ship F1/F2 as an immediate tiny hardening PR before the big branch?

---

## 10. Bottom line

The current app is a well-organized **single-tenant, business-scoped** system: the `OWNER` role *is* the tenant. The safest upgrade is **not a rewrite** — it is inserting an `organizations` layer above the existing `businesses` root, splitting the overloaded OWNER role into *platform super admin* (the current Owner) + *per-org OWNER*, and driving scoping through the already-centralized `accessibleBusinessIds` chokepoint with additive, verifiable migrations. No table rebuilds, no data destruction, rollback at every step, and the existing business backup engine doubles as the per-owner data mover.

---

## 11. Addendum — Allowed Business Types (delivered)

Per-Owner control of which business *types* each organization may operate, managed exclusively by the platform Super Admin (Main Owner).

- **Schema (additive):** `organizations.business_types_restricted boolean default false` (FALSE ⇒ every current & future type allowed — legacy default for all pre-existing orgs) + `organization_business_types (organization_id, business_type_key, …)` with `unique(org,key)`. `migrate-production-schema.mjs` creates both idempotently.
- **Canonical registry:** `src/lib/businessTypes.ts` — 9 keys (POULTRY_FARM … TELECOM_DIGITAL), synonym-normalized matching (`businessTypeKeyOf`), `allowedBusinessTypesOfOrg`, `businessTypeAllowed`. Unknown/future category strings pass for unrestricted orgs (back-compat) and are refused for restricted orgs.
- **Server gates (UI filtering alone is never enough):**
  - `POST /api/businesses` refuses non-granted category with 403 for restricted orgs;
  - `PATCH /api/businesses/[id]` refuses re-typing INTO a non-granted category with 403;
  - Super Admin and unrestricted orgs are never gated.
- **Admin console (`/api/admin/organizations` + PlatformAdminPanel):** directory GET returns `businessTypeOptions`, per-org `businessTypesRestricted` + `allowedBusinessTypes`; PATCH actions `SET_BUSINESS_TYPES` (checkbox set), `GRANT_BUSINESS_TYPE`, `REVOKE_BUSINESS_TYPE`, `UNRESTRICT_BUSINESS_TYPES` (lifts restriction entirely). Org #1 (main workspace) refuses restriction (400). Owners cannot manage their own types (403). All mutations audit-trailed.
- **Safe revocation:** revoking a type removes only the grant row — existing businesses of that type stay fully visible, owned and operable; only NEW creation/re-typing is refused (verified).
- **UI:** NewBusinessModal category picker filtered to granted types (with granted-list hint + "no types granted" notice); ManageBusinessesModal edit picker filtered likewise, and the Super Admin list view gains per-row Owner/Org identity chips plus an org filter. `/api/init` carries `allowedBusinessTypes {restricted, types[]}` for the caller.
- **Tests:** `dev-tooling/multiowner-verify.mjs` Section 8 (23 checks): set/grant/revoke/unrestrict, 403 create & re-type paths, safe revocation, zero-grant refusal, org-1 protection, owner self-management refusal, Super-Admin pass-through, unknown-category back-compat. All suites green: phase0 63/63, security 23/23, multiowner 93/93.

## 12. Addendum — Owner lifecycle & Super-Admin business display (delivered)

- **Suspend / Reactivate:** suspension ends every live member session at once and blocks re-login; reactivation restores everything — businesses, customers, users, settings and allowed business types all return unchanged (enforced + tested).
- **Delete Owner:** `DELETE_ORGANIZATION` (typed organization-name confirmation required, never the main workspace `id=1`, never by Owners themselves). Deletion permanently revokes platform access — all member accounts deactivated, all sessions ended (`endReason ORG_DELETED`), login blocked (403) — while **preserving every byte of data**: businesses, users, customers, stock, money, ledgers, allowed business types. The org shows `DELETED` in the console, disappears from the marketplace, and can be brought back with **Restore** (`ACTIVATE`), which reactivates member accounts. Full audit-trail entries (`SUSPEND_ORGANIZATION`, `ACTIVATE_ORGANIZATION`, `DELETE_ORGANIZATION`, `RESTORE_ORGANIZATION`).
- **Super-Admin "Manage Businesses & Branches":** with "All Owners / Orgs" the list is grouped — `YOUR BUSINESSES — GoMina Group (Main Owner)` first, then `OWNED BY <ORG NAME>` sections; every row keeps an Owner/Org chip, shows the business crest (logo) when one exists, plus per-Owner and per-business-type filter dropdowns. Normal Owners never receive the cross-owner directory.
- **Login:** DELETED workspaces are hard-blocked (403) alongside SUSPENDED, with a distinct message.
- **Tests:** multiowner-verify Section 9 (+25 checks; total 118/118 green): suspend→login-block + zero data loss; reactivate→identity of businesses/customers/type-grants; delete→typed-confirm, no self-delete, no org-1 delete, sessions killed, marketplace removal, data preserved (Super-Admin view + org-context customers); restore→accounts reactivated with all settings; UI integrity (directory only for Super Admin, ownerId stamps).

## 13. Addendum — Organization Lens (delivered)

The Super Admin's intentional "whose data am I looking at" context —
sidebar selector with three modes:

- **My Workspace** (default, the normal operational view): everything is
  scoped to the Main Owner's own organization (#1) — businesses, metrics,
  customers, inventory, transactions, staff, specialized logs — exactly as
  any Owner sees their own workspace.
- **All Organizations** (platform-wide oversight): the full payload remains
  (Super Admin data never disappears), but every interface becomes
  organization-aware — the sidebar groups businesses as
  `YOUR BUSINESSES — GoMina Group (MAIN OWNER)` first and
  `OWNED BY <ORG NAME>` per Owner (org crest when available, status chips,
  unit counts); the Command Center shows per-organization financial rollup
  cards (units, revenue, expenses, net profit) above the platform totals,
  explicitly labeled as combining every Owner.
- **One Owner/Organization**: focused single-org view with the same
  labeling, header lens chip, and automatic Command-Center return when an
  open dashboard leaves the focused org.

Business dashboards themselves carry an org-identity banner (crest, owning
Organization, MAIN-OWNER vs another Owner). Organization grouping per row
is basis testable via data-testids (`org-lens-select`,
`sidebar-org-group-<orgId>`, `org-identity-banner-<code>`,
`org-rollup-grid`, `lens-banner`).

Scope is computed CLIENT-SIDE over the already-fetched payload
(`ownerId` → businesses; `businessId` lookups for linked records) — the
server contract never changes, tenant isolation is untouched, and normal
Owners' views are byte-identical (verified: no directory, no flags, org-1
scoped payloads). Shared pure logic lives in `src/lib/orgGrouping.ts`
(grouping + rollups; mirrored by `dev-tooling/lens-verify.mjs`, 15 checks).

Verification: multiowner-verify 118/118, phase0 authz 63/63, security
23/23, lens-verify 15/15 (multi-org), `tsc --noEmit` src-clean.

## 14. Addendum — Owner Management confirmations & performance optimization (delivered)

**Owner lifecycle UX:** suspend now requires an explicit two-click
confirmation ("Ends all member sessions now?"); delete keeps the typed-name
confirmation; every lifecycle mutation is audit-trailed
(SUSPEND/ACTIVATE/DELETE/RESTORE_ORGANIZATION).

**Performance audit & optimization** (no features removed, semantics
unchanged — verified by scope-parity tests):

1. **`/api/init` access path** — previously 24+ sequential full-table
   `select()` round trips filtered only in JavaScript; now ONE parallel
   batch with SQL-level pre-scoping for non-Super-Admins (businessId /
   ownerId IN scope). The JS scoping remains the final enforcement layer;
   D4 (Super Admin ⇒ full payload) is untouched by design.
2. **28 perf indexes** (`business_id` / `owner_id` / session & membership
   columns across every hot table), idempotent in
   `migrate-production-schema.mjs`.
3. **Public marketplace `/api/menu`** — previously built the full catalog
   per request; now per-process 10-second TTL cache (`src/lib/ttlCache.ts`)
   with explicit invalidation from every catalog-affecting write
   (enterprise CRUD, businesses CRUD, org lifecycle, order placement).
   Warm hit ~5–6ms (was ~13–15ms); checkout still re-validates stock, so
   staleness can never oversell.
4. **Frontend:** shared in-flight refresh dedupe (a burst of `onChanged`
   calls used to fan out N identical `/api/init` refetches); per-org
   rollups memoized in the Command Center; 11 crest/logo `<img>` rendered
   `loading="lazy" decoding="async"`.
5. **Measured (fixture DB, warm):** init ~50ms both users, menu hit ~6ms,
   login ~59ms, root ~35ms. Cold first-hits in dev are webpack compile
   costs, eliminated in production builds.

**Verification:** `dev-tooling/perf-verify.mjs` (13/13 — latency gates,
JS↔SQL scope parity, cache behavior, index coverage, invariants) plus all
suites: multiowner 118/118, phase0 63/63, security 23/23, lens 15/15,
tsc clean.

---

## 15. Owner-Management Console — end-to-end UI audit & lifecycle verification (2026-09-16)

The Platform Owners & Organizations console was audited against the
observed UI, which rendered **only the Status column** — the Suspend,
Reactivate, Delete and Restore controls were unreachable. Two root
causes were found and fixed (no backend duplication; all lifecycle
APIs already existed from §12):

1. **Actions column clipped off-screen (layout).** The directory table
   sits in a `rounded-2xl overflow-hidden` card with no scroll wrapper.
   Its seven columns have a natural minimum width (~1080px) but at
   laptop viewports (sidebar open) only ~690px is available, so the
   rightmost **Actions** column was physically clipped. The table is
   now wrapped in `overflow-x-auto` with `min-w-[1080px]` — measured in
   a real headless Chromium: before the fix the controls were off-screen,
   after the fix they are reachable by scrolling.
2. **Suspend confirm could self-undo (interaction hazard).** The old
   two-click confirm swapped the cell's buttons in place; when the badge
   flipped, the re-rendered cell placed "Reactivate" in the exact spot
   the Confirm click ended, and the trailing edge of the same click
   could re-fire it (observed in audit trails as SUSPEND→ACTIVATE
   ~120ms apart). Confirmation now opens an **expanded panel row**
   (same proven pattern as the typed-name Delete panel): the click
   geometry is disjoint, making accidental immediate reactivation
   impossible. Verified: exactly one audit row per lifecycle action.

**Also this round:**
- `next build` was failing on pre-existing invalid route exports
  (`MIN_PASSWORD_LENGTH`, `otPayFor`, `POULTRY_PRODUCTS`); constants
  de-exported, production build + `next start` now run green. All
  lifecycle verification (and the suites below) were executed against
  the **production build**.
- Dev-only flake explanation for history: `next dev` auto-restarts
  ("Server is approaching the used memory threshold") and transiently
  serves HTML error pages ("Manifest file is empty") mid-flight —
  production serving is unaffected.

**Verification — `dev-tooling/owner-lifecycle-ui-verify.mjs`** drives
the real console in headless Chromium (`playwright-core` +
`@sparticuz/chromium` dev-deps): sidebar entry, main-org protection,
UI provisioning (one-time password capture), actions-column geometry,
two-step suspend + cancel semantics, session termination, blocked
logins, marketplace hide/show, typed-name delete enablement rules,
deleted-org soft-delete data preservation (SQL), status filtering,
restore (login + same business id back on the marketplace), and the
audit trail (CREATE/SUSPEND/ACTIVATE/DELETE/RESTORE organization).
**52/52 passed** — five consecutive full-lifecycle runs, plus
multiowner 118/118 · phase0 63/63 · security 23/23 · lens 15/15 ·
perf 13/13 · `next build` clean.

Run it: `LD_LIBRARY_PATH=/tmp/nss-stub node dev-tooling/owner-lifecycle-ui-verify.mjs`
(in sandboxes without system NSS libs, the tiny stub set in
`/tmp/nss-stub` satisfies the runtime linker for http-only testing;
with normal system Chromium deps installed, the env var is unnecessary).
