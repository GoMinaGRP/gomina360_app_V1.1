# Hardware & Building Materials Module — Complete Audit & Fix Report

**Date:** 2026-09-22 · **Branch:** `arena/01a0c754-gomina360-app-v1-1` · **Commit:** `07d4c32`
**Scope:** Session timeout policy (10 min → 24 h) + full audit of the Hardware & Building
Materials module (inventory, sales, purchases, expenses/finance, suppliers, reports,
analytics, audit, permissions, integrations).

---

## Part 1 — Automatic logout / session timeout: 10 minutes → 24 hours

| Layer | Before | After | File |
|---|---|---|---|
| Client idle auto-logout | 10 min | **24 h** | `src/components/IdleLogout.tsx` |
| Server idle ceiling (`SESSION_IDLE_MS`) | 10 min | **24 h** | `src/lib/auth.ts` |
| Idle sign-out notice copy | "after 10 minutes" | "after 24 hours" | `src/components/GoMinaApp.tsx` |

Unchanged by design (security preserved): absolute session lifetime (7 days), cookie
`Max-Age`, account lockout (5 fails / 15 min), scrypt password hashing, org/tenant gates,
session-hash-at-rest. Applies uniformly to every user, role, business and device — the
policy lives in two shared constants.

**Verified** (`dev-tooling/verify-session-timeout.mjs`, 15/15 ✅):
- Session idle 23 h → still authenticated.
- Session idle 25 h → rejected 401, DB row ended `IDLE_TIMEOUT`, data endpoints refuse it,
  other live sessions unaffected.
- Re-login after expiry restores the same identity.
- Absolute 7-day TTL still ends sessions (`EXPIRED`).
- Browser idle auto-logout mechanism fires (via the documented `gomina.idleMs` test seam)
  and the sign-in screen explains the automatic sign-out.

## Part 2 — Hardware module audit findings & fixes

### 2.1 CRITICAL — Deleted Hardware units reappeared after removal from Manage Unit
**Root cause:** `ensureHardwareFlagship()` in `src/db/seed.ts` ran on **every** seed pass
(every server cold start via `/api/init`) and re-inserted `HARDWARE-01` whenever it was
absent — treating the OWNER's deletion as "not yet repaired". Reproduced live: unit deleted
(id 8) → app restart → unit resurrected (id 12) with re-seeded starter data.

**Fix (permanent, root cause):**
- New `system_markers` table (`src/db/schema.ts`) + resilient helpers (`src/lib/systemMarkers.ts`).
- The hardware flagship pass is now **one-time** per database (marker `hardware_flagship`);
  it never re-runs after its first pass.
- `DELETE /api/businesses/[id]` writes a **tombstone** (`deleted_business:<CODE>`) — no
  auto-provisioning path can ever resurrect an OWNER-deleted unit, today or in the future.
- Tombstone/marker writes are failure-tolerant (missing table ⇒ no-op), so deletion can
  never fail on a pre-migration database.

**Verified** (`dev-tooling/verify-hardware-audit.mjs` phase 1 = 42/42, phase 2 = 5/5 ✅):
delete via the Manage-Units API → restart the app process (boot seeder runs) → unit stays
deleted, no orphaned inventory, other businesses untouched. A user-created replacement
Hardware unit works normally (and also stays deleted when deleted).

### 2.2 CRITICAL — Demo/disconnected data in expenses, dashboards & analytics
**Root cause:** `provisionBusiness({starterKit: true})` folded the GH₵86,850 starter-kit
cost into `business_metrics` (expenses / net profit / cash flow) **without booking any
transaction**. Result: dashboards and the Finance report showed *"Expenses GH₵86.8k —
0 postings"*, a phantom *"Q1-2026 baseline (system records)"* strip and a *"Mar '26 · Q1
close"* trend bucket — figures that existed nowhere as manageable, exportable records.

**Fix:**
- The starter-kit cost is now booked as a **real EXPENSE transaction**
  ("Opening Stock — Starter Kit", recorded-by "System (opening stock)") — visible in the
  ledger, expense mix, payments channel, exports and the audit trail.
- Metrics stay zero-based (only the real stock valuation remains), so every displayed
  total is unchanged — but now 100 % ledger-backed (live layering math preserved).
- **One-time legacy repair** converts the folded metrics of pre-fix databases into the
  same real transaction (verified on a simulated pre-fix DB: fold → ledger row, metrics
  zeroed, marker set).
- `financeReport.ts` no longer folds a zero baseline into a phantom "Q1 close" trend
  bucket/footnote; the 7 original demo businesses keep their labelled Q1-2026 baseline
  exactly as before.

### 2.3 Functional — stale dashboards after hardware mutations
`/api/hardware` imported `ttlInvalidate` but never called it, and `/api/logs/[code]` (GRN)
didn't invalidate either — after recording orders/purchases/deliveries/GRNs the UI's
post-save refresh could read a ≤2.5 s-stale `/api/init` snapshot. Both routes now invalidate
the shared init cache. **Verified:** stock/ledger figures are correct immediately after
every mutation.

### 2.4 Permissions — worker expense-rights parity (server-side)
`/api/transactions` (EXPENSE) and the hardware GRN expense booking did not enforce the
WORKER `canRecordExpenses` flag (the feed-mill routes already did). Both now reject with a
clear 403; stock-only GRNs remain allowed. Verified with a real hardware-assigned worker.

### 2.5 Analytics — "Received" per material
Material Performance's *Received* column counted only GRN yard receipts; it now also counts
RECEIVED supplier purchases (the primary restock path), matched the same way the API
matches stock-ins.

### 2.6 Tooling hardening
The production schema reconciler's serial-realignment sweep crashed on tables without an
`id` column (broke `npm run build` with the new table); it now skips such tables.

### 2.7 Audited & confirmed correct (no change needed)
- Stock/finance linkage: counter sales, order PENDING→READY→DELIVERED, purchases
  ORDERED→RECEIVED, standalone vs order-linked deliveries (never double-deducted), GRNs,
  cancellations — every posting fires exactly once; re-advancing terminal statuses is a no-op.
- Access control: business-scope isolation (cross-business BM blocked on every hardware
  endpoint), anonymous 401, GM grants work.
- Clean units: brand-new Hardware units (app-created or after reset) start with zero sample
  data and zero-based metrics — no phantom opening expense.
- Reports/analytics/audit/AI guides/integrations: all read from live scoped records;
  `FinancialReportSection` correctly filters to the active business.
- Suppliers card, customers panel, checklists: connected to real persistent records.

## Regression evidence (all on the final build)

| Suite | Result |
|---|---|
| `verify-hardware-audit.mjs` phase 1 (fresh DB, workflow, cache, permissions, deletion) | **42/42 ✅** |
| `verify-hardware-audit.mjs` phase 2 (post-restart deletion permanence) | **5/5 ✅** |
| `verify-session-timeout.mjs` (24 h policy) | **15/15 ✅** |
| `verify-clean-state.mjs` (all business types) | **109/109 ✅** |
| `verify-manage-unit.mjs` (Manage Unit permission model) | **24/24 ✅** |
| `verify-expense-permissions.mjs` | **39/39 ✅** |
| `phase0-authz-matrix.mjs` (anon/Owner/GM/BM/Worker) | **63/63 ✅** |
| `tsc --noEmit` / production build / browser smoke (0 page errors) | ✅ |

**Demo credentials:** OWNER `kwame.owner@gomina360.com` / `Owner@GoMina26` ·
BM `emmanuel@gomina360.com` / `GoMina@User3` · GM `abena.gm@gomina360.com` / `GoMina@User2`
