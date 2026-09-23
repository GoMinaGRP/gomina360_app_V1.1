# Audit Interface — Responsive & Integration Fix Report

**Status: LIVE · Date: 2026-09-23 · Scope: Supervisor & Auditor Control Center + My Audit Issues (the whole Audit system UI)**
**Verification: 38/38 new responsive checks + 14 existing suites re-run green · tenant isolation & performance preserved**

---

## 1. The reported bug (reproduced & measured)

On phones, the **Records** table inside the Audit & Review center was wider than the screen and its container had `overflow-hidden`, so the browser **clipped** everything past the first columns. Measured at 390 px (iPhone-class) before the fix:

| Metric | Before | After |
|---|---|---|
| Table width | 845–1022 px (7 columns forced) | card layout, 0 px overflow |
| Verify button position | left 886 / right 914 — **far outside the 390 px viewport** | right 258 — **fully visible** |
| Visible columns | Record (only column ending at 373 px) | **everything**: ref, state, module, photos, title, detail, business · branch, worker, date |
| Audit actions (Open/History/Verify/Flag/Correct/Comment) | **unreachable** — auditing impossible on phone | **all 6 on every record, 0 clipped, with text labels** |
| Document horizontal overflow | clipped (looked "clean" but hid data) | 390 = viewport (true fit) |

Same defect affected the **Audit Log** table, the **Reports → Financial discrepancies** table, and (partly) the action/verify modals on small screens.

## 2. What was fixed

### 2.1 Responsive layout — `src/components/AuditCommandCenter.tsx`
- **New `useIsWide()` hook** (matchMedia, ≥1024 px). From `lg` up the classic tables render exactly as before; **below `lg` every list switches to a full card layout** (phone *and* tablet portrait). Only one layout is in the DOM at a time; **testids are identical in both** (`aud-rec-row-*`, `aud-verify-*`, `aud-flag-*`, …), so every existing suite keeps working.
- **Records cards** show the complete record (ref, review state, module, photo count, title, detail, business · branch, worker, date) and the **entire audit action set with icons + text labels** — nothing hidden, nothing clipped. The review-history expansion works inline on cards too.
- **Audit Log cards**: when, who, action chip, target, business · branch, reason/detail.
- **Financial discrepancies cards** (Reports tab): action, ref, amount, title, reason, raiser.
- Desktop tables got `overflow-x-auto` wrappers as belt-and-braces; the discrepancies header wraps.
- **Modals** (`aud-action`, `aud-verify`, `aud-correct`, detail drawer): `max-h-[88dvh] overflow-y-auto` + `role="dialog" aria-modal="true"` — long forms scroll on phones; `dvh` adapts to mobile browser chrome.
- **Accessibility**: `aria-label` on every icon-only button (row actions, refresh, close/back buttons) in addition to the existing `title`s.

### 2.2 Worker side — `src/components/MyAuditIssues.tsx`
- `88dvh` + dialog semantics + labelled close button. (It was already card-based and phone-safe.)

### 2.3 Integration bugs found & fixed — `src/app/api/audit/route.ts`
1. **"Open complete record" 404'd on CHECKLIST and CCTV rows.** `loadFullRecord` had no cases for them even though they are listed and scope-checked — the eye icon returned "Record not found" for the most-flagged record type (daily checklists). Added:
   - `CHECKLIST`: full entry + **related links to the assignee's other tasks the same day** (audit context).
   - `CCTV_CAMERA`: full camera config with **device credentials redacted** (password `[redacted]`, `user:pass@` pairs in stream URLs masked) — same redaction rule as the GET API.
2. *(data, not code)* Employees had aged out of the default 250-most-recent records view (hire-date sorting) — they remain reachable via the module filter; the stale suite assertion was corrected (see §4).

### 2.4 Tooling fixes
- **`dev-tooling/lib/fixture-purge.mjs`**: `purgeUserId` now also removes the user's `audit_assignments` rows (grantee **and** granter) — previously every purged fixture user leaked an orphan grant into the ACCESS tab forever.
- **Restored the canonical demo state**: the scoped-auditor demo grant for **Emmanuel Osei (business 2)** — expected by the ACCESS tab demo and `verify-live` D3 — is healed idempotently by `verify-audit-records.mjs` when missing, and kept (it is demo data, not a fixture).

## 3. How it works now (user-facing)

- **Desktop (≥1024 px)**: unchanged classic tables — 7-column Records, Audit Log, discrepancies, all charts.
- **Tablet portrait / phone (<1024 px)**: every audit list is a card stack. A phone auditor can: filter (Business/Module/Type/Branch/Worker/Status/dates/search — 2-column grid), **open the complete record** (drawer with photos, full fields, related records), **verify, flag, request correction, comment** (with priority + photo evidence), follow the **issue pipeline** (Flagged → Under Review → Correction Required → Resolved → Verified), read the **Audit Log**, and work **Reports & Charts** and **Auditor Access** — all without horizontal scrolling or clipped controls.
- **Worker on phone**: the flagged-issue strip → "Review & respond" → My Audit Issues inbox → respond with note/photo or mark resolved.
- **Permissions/tenant isolation: untouched** — all scoping stays server-side in `/api/audit` (verified: scoped auditor sees only business 2; out-of-scope detail 403; non-granted worker 403; cross-business checks green).

## 4. Test results (2026-09-23, live server + DB)

| Suite | Result | Notes |
|---|---|---|
| **verify-audit-responsive.mjs (NEW)** | **38/38** | §1 owner on 390×844: geometry (0 overflow, 0 clipped buttons of 240), cards, filters, drawer, full flag workflow (priority HIGH + photo), ISSUES/LOG/REPORTS/ACCESS tabs. §2 worker on phone: strip → inbox → respond. §3 owner on phone: review response → verify & close → record VERIFIED. §4 tablet 768×1024. §5 desktop 1440×900 regression (7-column table, history expansion). §6 TEST purge. |
| verify-live.mjs | 27/27 | Desktop records workflow, notifications, TEST grant lifecycle |
| verify-audit-records.mjs | 29/29 | Complete-record drawer for every type incl. the new CHECKLIST case; scoped-auditor isolation; updated: EMPLOYEE via module filter (date-rot), self-healing demo grant, dynamic non-granted worker |
| verify-audit-access.mjs | 28/28 | ACCESS tab grant/revoke/delegation |
| verify-audit-fixes.mjs | 51/51 | |
| audit-notify-verify.mjs | 104/104 | issue lifecycle + tenant fan-out (purger leak fixed) |
| audit-security.mjs | 23/23 | no password material in APIs |
| audit-deadlinks.mjs | clean | |
| verify-contextnav.mjs | 29/29 | |
| verify-notifications.mjs | 38/43 | **5 pre-existing environment failures** (web-push dispatch needs external push endpoints; session-idle timer) — **verified byte-identical on the parent build with my changes stashed**, unrelated to this work |
| verify-az-app-audit.mjs | 41/41 | incl. AUDIT tab surface |
| verify-clean-state.mjs | 109/109 | DB hygiene after everything |
| phase0-authz-matrix.mjs | 63/63 | |
| perf-verify.mjs | 20/20 | page weight / timings unchanged |
| audit-atoz.mjs | 39/39 | app-wide incl. G-phase responsive sweep 390/768/1440 |

Run the responsive suite: `bash dev-tooling/run-suite.sh dev-tooling/verify-audit-responsive.mjs` (~30 s, self-cleaning).

Screenshots: `reports/screenshots/audit-phone-BEFORE.png` (the reported bug) and `audit-phone-after.png`, `audit-tablet-after.png`, `audit-desktop-after.png`.

## 5. Files changed

**`src/components/AuditCommandCenter.tsx`** — card layouts (<lg) for Records/Log/discrepancies, shared `renderActions`/`renderHistory` (identical testids both layouts), `useIsWide` hook, scroll-safe modals, aria-labels, `overflow-x-auto` on tables.
**`src/components/MyAuditIssues.tsx`** — `dvh`, dialog semantics, labelled close.
**`src/app/api/audit/route.ts`** — `loadFullRecord` CHECKLIST (with same-day related links) + CCTV_CAMERA (credentials redacted) cases; drizzle `and`/`ne` imports.
**`dev-tooling/lib/fixture-purge.mjs`** — purge auditor grants with the purged user.
**`dev-tooling/verify-audit-records.mjs`** — module-filter for EMPLOYEE, self-healing demo grant, dynamic non-granted worker, defensive detail lookup.
**`dev-tooling/verify-audit-responsive.mjs`** (NEW) — the 38-check phone/tablet/desktop suite.

## 6. Demo accounts

- Owner (full audit control): `kwame.owner@gomina360.com` / `Owner@GoMina26`
- Scoped auditor (business 2 only): `emmanuel@gomina360.com` / `GoMina@User3`
- Worker (issue inbox): `akua.donkor@gomina360.com` / `GoMina@User10`

## 7. Known items

- The 5 `verify-notifications` failures are sandbox-environment issues (web-push dispatch to external endpoints; 10-min idle-logout timer) — pre-existing, reproduced on the parent build, out of scope here.
- The default Records view intentionally shows the 250 most-recent records (date-sorted); older record types (e.g. employees, dated by hire date) are reached through the module filter. If a paged/typed "universe" view is wanted later, it's an API-level design change.
