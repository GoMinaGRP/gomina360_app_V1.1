# Phase 5 — Stock Unification (results)

**Scope:** the P5 slice of `docs/RE-AUDIT-DASHBOARDS-SHARED-MODULES.md` — eliminate every conflicting
`inventory_items.quantity` write path and every hand-rolled revenue/expense ledger row, so each data family
has exactly one writer. No workflow or UI change: the same buttons do the same things, but the writes are
auditable and the maths can no longer diverge.

---

## 1. One stock writer + a movement trail

`src/lib/stock.ts` is now the only place that moves stock:

| Export | Purpose |
|---|---|
| `applyStockChange({ businessId, inventoryId\|sku\|name, delta, reason, refType, refId, note, actor, … })` | Applies the signed change, recomputes status from the shared rule, appends a `stock_movements` row |
| `resolveInventoryItem()` | Tenant-scoped item lookup by id → SKU → name (shared by every caller) |
| `stockIn()` / `stockOut()` | Thin wrappers over `applyStockChange` (existing callers unchanged, now logged) |
| `stockMovementsFor()` | Read the trail for one item (newest first) |

New table **`stock_movements`** (business-scoped: id, inventoryId, sku, itemName, delta, quantityAfter,
reason `PRODUCTION|PURCHASE|SALE|CONSUMPTION|WASTE|HARVEST|RESTOCK|ADJUSTMENT|RESTORE|OPENING|RETURN`,
refType/refId, note, variantId, actor*, createdAt + 3 indexes) — so "why is stock 42 and not 50?" is now
answerable. It is registered for **export/restore** (`businessBackup`), the **business-delete cascade**
(`api/businesses/[id]`) and the new-unit clean-state list.

### Migrated writers (were raw read-modify-write + private status maths)

| Module | Movement | Reason |
|---|---|---|
| block-factory production / restock / mix rejection recovery | `:430` `:697` `:1037` | PRODUCTION · RESTOCK · RETURN |
| branch-unit RESTOCK (RA-20) | `:71` | RESTOCK |
| hardware delivery + purchase + item create | `:121` `:323` `:345` | SALE · PURCHASE · OPENING |
| electronics order + purchase + item create | `:33` `:339` `:358` | SALE · PURCHASE · OPENING |
| restaurant purchase / waste / item create | `:37` `:233` `:58` | PURCHASE · WASTE · OPENING |
| car-wash chemical draw | `:117` | CONSUMPTION |
| transport maintenance parts | `:766` | CONSUMPTION |
| sales center (non-variant) | `:219` | SALE |
| credit sales (non-variant) | `:631` | SALE |
| order commit / cancel restore (`lib/trackingServer`) | `:138` `:166` | SALE · RESTORE |
| goods receipt restock (`lib/preorder`) | `:448` | PURCHASE |
| approved inventory adjustment (`lib/approvals`) | `:357` | ADJUSTMENT |
| inventory register + un-gated edit (`api/enterprise`) | `:1005` `:467` | OPENING · ADJUSTMENT |
| starter kit (`lib/businessProvisioning`) | `:386` | OPENING |

**Items are never created with stock any more**: they are inserted empty and stocked through
`applyStockChange`, so even opening quantities are logged.

**Two deliberate remaining direct writers** (documented in `lib/boutique.ts`): `syncItemAggregate()` and its
"no active variants" fallback. These are **derived** writes — the aggregate is recomputed *from* the variant
rows (which are moved atomically per variant) — so they are not movements and log nothing.

---

## 2. One ledger writer per money family

New `src/lib/servicePosting.ts` → `postServiceSale()` writes module **revenue** (shared row shape, shared
`nextTrxNumber`, actor/recorded-by convention, optional business-isolated CRM accrual in the same call).

Converted to it: **car-wash** (`bookTransaction` INCOME leg), **telecom** (INCOME leg), **transport**
(INCOME leg), **online order sale** (`lib/trackingServer`), **preorder deposit/balance/full**
(`lib/preorder`) — all keep their own categories, descriptions and domain records, so nothing user-visible
changed, but the four copies of the row shape are gone.

Ledger writers now: `postSale` (goods) · `postServiceSale` (service/online/preorder revenue) ·
`postOrGateExpenseTransaction` (all expenses; approval-gated) · `credit-sales.postInstallment` (payment
against a receivable) · payroll (run-approved) · `branch-unit` OPS_LOG (a zero-amount operations log, not
money) · the generic `/api/transactions` route (delegates EXPENSE to the gate).

---

## 3. Test results (P5)

New suite `dev-tooling/verify-p5-stock.mjs` — **19 passed, 0 failed**:
- movement trail per module path (hardware purchase → PURCHASE, delivery → SALE, restaurant waste → WASTE,
  branch restock → RESTOCK, register → OPENING, edit → ADJUSTMENT), each asserting delta, `quantity_after`
  and the recomputed status;
- **static scan of the source tree** proving no file outside `lib/stock.ts` (and the two documented derived
  boutique cases + the fixture seeder) writes item quantity;
- service-sale row shape; tenant isolation; `stock_movements` present.

Regression suites re-run and green:

| Suite | Result |
|---|---|
| `verify-single-writer` | 35 / 0 |
| `verify-p4-writers` | 23 / 0 |
| `verify-clean-state` | 109 / 0 |
| `verify-shared-ui` | 30 / 0 |
| `verify-transport` / `verify-transport-ui` | 119 / 0 · 26 / 0 |
| `verify-boutique` | 74 / 0 |
| `verify-business-backup` | 54 / 0 (export/restore includes `stock_movements`) |
| `verify-block-mixing` / `verify-block-qc` | green · 51 / 0 ("block inventory byte-identical") |
| `verify-telecom` | 63 / 0 |
| `verify-feed-mill` / `verify-fish-feed-mill` | 100 / 0 · green |
| `verify-procurement-chain` | 64 / 64 |
| `verify-orders-maps` | 51 / 51 |
| `verify-online-ordering` / `verify-online-mgmt` | 34 / 0 · 81 / 0 |
| `verify-inventory-ui` / `verify-inventory-permissions` / `verify-low-stock` / `verify-order-inventory-fixes` | 12 / 0 · 37 / 0 · 15 / 0 · 55 / 0 |
| `verify-expense-ui` | 39 / 0 |
| `verify-employees` / `verify-payroll2` | 46 / 46 · 52 / 52 |
| `verify-hardware-audit phase1` | 42 / 0 |

**Issue found and fixed during the phase:** the first cut of the new `verify-p5-stock` static scan produced
false positives (it matched any later `quantity:` in a 1 200-character window) and the enterprise test used
`entityType: "INVENTORY"` where the route expects lowercase `inventory`. Both were **test** defects, not
product defects; fixed, then re-run green.

**Environment note:** the hardware audit's phase1 deletes HARDWARE-01 by design; it was re-provisioned
(clear both markers → `npx tsx dev-tooling/run-seed.ts`) so the preview and later suites have their fixture.
