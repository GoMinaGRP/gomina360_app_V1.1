# Phase 4 — Correctness Writers (results)

**Scope:** the P4 slice of `docs/RE-AUDIT-DASHBOARDS-SHARED-MODULES.md` — remove the remaining
*conflicting write paths* for identity, numbering and the staff roster. No UI change, no workflow change.

**Principle:** one writer per data family, many surfaces. Every item below replaces a second
implementation with the existing shared one.

---

## What changed

| Ref | Finding | Change | Files |
|---|---|---|---|
| RA-03 | A **second CRM matcher** lived in `lib/trackingServer.ts` (its own org check, own loyalty rate, and an unfiltered `select() from customers` per order) | `linkCrmCustomer` now delegates to `linkOrCreateCustomer` (`lib/customerLink`) — the one matcher used by the till, credit sales and every module sale. Behaviour preserved: anonymous buyers are matched but never created (`matchOnly`), legacy group-shared rows stay matchable inside the same organization, new rows are stamped to the selling unit + owning org | `src/lib/trackingServer.ts` |
| RA-21 | CRM match lookups had only `businessId` indexed → full scans | Added `customers(business_id, phone)` and `customers(business_id, name)` indexes (drizzle push) | `src/db/schema.ts` |
| RA-07 | Receipt/invoice numbers minted in **three** places, two of them clock-derived (`RCP-YYYY-<clock>`) with ad-hoc collision patches | One generator `nextSalesDocumentNumber(kind)` → `PREFIX-YYYY-NNNN`, derived from the highest already-issued number for that prefix-year, probed for free slots. Used by `postSale` (till receipts), credit-sales (instalment receipts **and** credit invoices) and the `/api/sales-documents` route | new `src/lib/documentNumbers.ts`, `salePosting.ts`, `credit-sales/route.ts`, `sales-documents/route.ts` |
| — | Six hand-rolled `TRX-…` builders (payroll, telecom, transport, preorder, tracking, credit-sales) | All now use `nextTrxNumber()` (`lib/idNumbers`) — one shape, one collision strategy | those 6 files + `lib/businessProvisioning.ts` |
| RA-14 | **Two employee-create paths**: full `POST /api/employees` and the QR/quick-add branch in `/api/enterprise` (with its own hand-rolled `regexp_replace` MAX query for staff numbers) | New `lib/employeeCreate.ts` owns the roster write: `nextEmployeeNo(businessId)` + `createEmployeeRecord()` (insert + `employee_history` CREATED row). Both routes call it, so numbering and history can't drift | new `src/lib/employeeCreate.ts`, `employees/route.ts`, `enterprise/route.ts` |

### Correction to the audit (professional judgment)

**RA-06 (payroll skips the approval gate) is withdrawn.** Payroll is not ungated: it has a run-level
workflow — `DRAFT → REVIEW → APPROVE → PAY` (`api/payroll/route.ts:582-645`), and the ledger EXPENSE is
written only by the PAY/PAY_ALL actions, which refuse an un-approved run. Routing it through
`postOrGateExpenseTransaction` as well would double-gate a batch that is already approved and could stall
payouts. Payroll keeps its direct writer; only its transaction number was unified. Documented here so the
finding is not re-opened.

Also confirmed already-correct (no change needed): every module **expense** path (15 callers) and the
`/api/transactions` EXPENSE route already funnel through `postOrGateExpenseTransaction`.

---

## Test results (P4)

New suite `dev-tooling/verify-p4-writers.mjs` — **23 passed, 0 failed**:
CRM single matcher (online order ↔ till sale → ONE row; anonymous never created), document numbering
(shared sequence, monotonic, no duplicates), transaction numbering, employee single writer (both paths →
one generator + CREATED history), CRM indexes present, tenant isolation for buyers and employees.

Regression suites re-run against the new build:

| Suite | Result |
|---|---|
| `verify-single-writer` | 35 / 0 |
| `verify-procurement-chain` | 64 / 64 |
| `verify-clean-state` | 109 / 0 |
| `verify-shared-ui` | 30 / 0 |
| `verify-transport` | 120 / 0 |
| `verify-boutique` | 74 / 0 |
| `verify-employees` | **46 / 46** (regression found + fixed below) |
| `verify-payroll2` | 52 / 52 |
| `verify-credit-sales` | 39 / 0 (needs a ≥60-unit stock fixture; stocked for the run, then restored) |
| `verify-orders-maps` | 51 / 51 |
| `verify-feed-mill` | 100 / 0 |
| `verify-fish-feed-mill` | green |

**Issue found and fixed during the phase:** the first cut of `createEmployeeRecord` wrote the history
summary from the *raw* input, so an auto-generated staff number appeared as `(auto)` instead of
`EMP-0012`. `verify-employees` A12 caught it. The summary now accepts a builder `(row) => string` so the
route can quote the resolved number — 46/46 after the fix.

**Environment notes (not regressions):**
- `verify-hardware-audit phase1` requires a freshly provisioned HARDWARE-01; it also *deletes* the unit by
  design (phase2 verifies permanence). Re-provisioned with `npx tsx dev-tooling/run-seed.ts` after clearing
  both `hardware_flagship` and `deleted_business:HARDWARE-01` markers.
- `verify-orders-maps` Z4 asserts the branch GPS anchor is NULL at the end; it passes from a canonical DB
  (anchor NULL) and fails if demo fixtures have pre-set the anchor (5.556/−0.183 from `fixtures-e2e`).
- `verify-credit-sales` S1 requires a business holding ≥2 items with quantity ≥ 60.

---

## Ledger writers after P4

- **Income:** `postSale` (goods) · credit-sales `postInstallment` (payment against a receivable) ·
  transport/telecom/car-wash service sales (`bookTransaction` → shared expense helper for their EXPENSE
  leg) · preorder/online-order writers (unchanged this phase — scheduled with P5's `postServiceSale`).
- **Expenses:** `postOrGateExpenseTransaction` everywhere except payroll (run-approved) and provisioning
  (system, no actor).
- **CRM:** `linkOrCreateCustomer` only.
- **Numbering:** `nextTrxNumber` + `nextSalesDocumentNumber` only.
- **Roster:** `createEmployeeRecord` only.
