# Phase 1 — Data consistency (results report)

**Scope** — audit `docs/FEATURE-OVERLAP-AUDIT.md` §5, phase **P1**. Prioritised findings:
**F1** (the second sales pipeline), **F3** (the parallel purchasing system), **F2/F4** partly
(the same sale/purchase written twice with different side-effects).

**Goal** — one writer per fact. Every unit that fulfils an order must post money through the
same engine the Sales Center uses; every purchase must accrue the shared supplier register; every
customer must come from the one CRM matcher.

**Preserve** — existing data, categories, wording, permissions, tenant isolation, and the
`/api/sales` response contract.

---

## 1. What was built

| New file | What it owns |
|---|---|
| `src/lib/salePosting.ts` | `postSale()` — ledger `INCOME` → receipt (`salesDocuments`) → CRM link/accrual → tracking code, plus `normalizeSaleLines()`, `computeSaleTotals()`. Options: `receipt`/`tracking`/`linkCustomer` toggles, `customerId`, `customerSpendOverride`, `actor`, `date`, idempotency keys. Also invalidates the `/api/init` snapshot. |
| `src/lib/customerLink.ts` | `linkOrCreateCustomer()` — the single find-or-create rule for the CRM (business-isolated with opt-in legacy shared matching, `matchOnly`, `byId`, per-caller phone fallback and loyalty convention) and `isAnonymousBuyer()`. Never throws. |

Reused as-is: `stock.ts` (single stock movement), `supplierLinks.ts` (`linkSupplier`),
`expensePosting.ts`, `tracking.ts`, `idNumbers.ts`, `ttlCache.ts`.

**No `customerUpsert.ts` was added** — the plan's original name was superseded by
`linkOrCreateCustomer`; the helper lives in `customerLink.ts` only.

## 2. Wiring — who now posts through the shared engine

| Surface | Before | After |
|---|---|---|
| `/api/sales` (Sales Center, POS, boutique, storefront checkout) | its own ledger + receipt + tracking code | delegates to `postSale()`; response contract and 400 messages unchanged |
| Hardware order **delivered** | hand-rolled `insert(transactions)`, no receipt, no CRM, no tracking | `postSale()` (`HARDWARE_ORDER_SALE`), id written back to the order |
| Electronics order **delivered** | same | `postSale()` (`ELECTRONICS_ORDER_SALE`) + `transactionId`/`salesDocumentId` on the order row (idempotent) |
| Restaurant kitchen ticket **SERVED** | posted **nothing** to finance | `postSale()` (`RESTAURANT_ORDER_SALE`) with menu COGS → profit; re-serve is a no-op (`restaurant_orders.transaction_id` guard) |
| Block factory order | already through `/api/sales` | order create now links the buyer and stores `customer_id` |
| Module purchases **received** (hardware / electronics / restaurant) | free-text `supplierName`, supplier ledger blind | `linkSupplier()` + `purchases.supplier_id` (stock-in and expense logic untouched) |
| Car wash, telecom, transport, credit sales customer upserts | four near-identical matchers | one `linkOrCreateCustomer()` (per-caller phone/loyalty behaviour preserved) |

## 3. Schema (additive only)

`customerId` on hardware/electronics/restaurant/block-factory orders; `transactionId`,
`salesDocumentId`, `customerPhone`, `postedAt` on electronics/restaurant orders; `supplierId` on
the three module purchase tables. Applied with `drizzle-kit push` and verified with
`dev-tooling/migrate-production-schema.mjs` ("schema already in sync") + direct column checks.
No existing row was rewritten; historical rows simply read as "not yet posted".

## 4. Defects fixed on the way

1. **Discount beyond subtotal was rejected *after* stock had been deducted.** `/api/sales` now
   validates money before any movement (same 400 text).
2. **Buyers linked at order-create time never accrued spend/loyalty** — `postSale()` now accrues
   onto the order's `customerId` (`byId`, tenant-checked) instead of only matching by name/phone.
3. **Restaurant revenue was invisible to finance** — serving a ticket previously created no
   ledger row at all.

## 5. Verification

`dev-tooling/verify-single-writer.mjs` (new, self-purging, `TEST-SW` rows) — **35 passed, 0 failed**,
reproduced twice:

* hardware order delivered → exactly **one** `HARDWARE_ORDER_SALE` income (1000), one receipt, one
  tracking code, CRM link + spend, stock deducted once, second "delivered" is a no-op;
* electronics order → one income (500), receipt linked on the order row, stock once;
* restaurant SERVED → 135 once, re-serve idempotent, COGS 54 / profit 81;
* 3 module purchases → `suppliers.total_supplied_ghs` 450 / 560 / 600 and `supplier_id` stored;
* order-create CRM link; tenant isolation (no cross-unit rows); `/api/sales` regression (1 tx +
  1 receipt + 1 tracking, nothing extra); over-subtotal discount → 400 with stock untouched.

Regression suites re-run green: telecom 63/63 · transport 120/0 · credit-sales 39/39 ·
tracking 51/0 · customer-data 33/0 · customer-ui 12/0 · customer-360 40/40 · online-mgmt 81/81 ·
checkout-product-details 38/0 · boutique 74/74 · finance-allproducts-fresh 49/0 ·
block-mixing 75/0 · expense-ui 39/0 · inventory-ui 12/0 · audit-fixes 51/0 · live 27/27 ·
manager-ui 7/0 · bm-dashboard-access 19/0.

Two transient, **non-P1** failures were run down before closing the phase: `verify-telecom`'s
checklist-template count (stale leftover rows from an aborted earlier run — green on a clean
re-run) and `verify-customer-data`'s canonical-row count (test-deletion interaction in the suite
itself — green on a clean re-run). `verify-block-mixing`'s B7 asserted the pre-taxonomy literal
category `Block Raw Materials`, which the app intentionally normalises to `Building Materials`
(`src/lib/inventoryCategories.ts`); the assertion was corrected to the documented taxonomy
(name match + umbrella category) — 75/75.

## 6. Deliberately not changed

* **Poultry production revenue** (`poultry/route.ts:717`, `:814`) and **aquaculture harvest
  revenue** (`aquaculture/route.ts:422`) still insert their ledger row directly. They are
  *production/harvest* events with domain categories (`POULTRY_EGG_SALE`, `AQUA_HARVEST_SALE`), not
  order fulfilments: they already write the shared ledger through the shared numbering helper, do
  not duplicate a sale, and minting receipts/tracking codes for them would change farm paperwork.
  Flagged for the P3 decision list instead of being changed silently.
* Ledger `category` values, receipt/tracking numbering and the `/api/sales` response contract are
  unchanged — existing suites and printed documents depend on them.
