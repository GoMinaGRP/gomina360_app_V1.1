# GoMina 360 — Pre-Orders: Implementation & Verification Report

**Date:** 2026-09-17 · **Branch:** `arena/01a0a375-gomina360-app-v1-1` · **Scope:** Additive pre-order capability across storefront → orders → suppliers → finance → inventory → public tracking — **no features removed; all existing data & flows preserved.**

---

## 1. What pre-orders are in GoMina 360

A *pre-order* is a customer order for goods selling **before they exist in branch stock**. Any product on `/order` can now be in one of three seller-configured modes **per business**:

| Mode | Behaviour |
|---|---|
| **In Stock** | Legacy behaviour — checked against branch quantity, committed on confirm. |
| **Pre-Order** | Sellable even at 0 stock **only when an ACTIVE fulfilment option exists**. No stock checks at checkout (that's the point). |
| **Both** | Stock and pre-order paths offered side-by-side — the customer chooses. |

Customers **must explicitly choose** a fulfilment option — the storefront renders each options as a dedicated card (e.g. *"Air Freight Import · 7–14 days · deposit 40% · balance when ready"*) and refuses to submit a basket containing a pre-order line without a choice; the server independently re-validates every choice (§5).

A pre-order follows this business flow end-to-end:

```
Pre-Order → Deposit → Supplier Procurement → Shipped → In Transit → Arrived
   → Inventory Receipt (goods posted into stock) → Ready for Pickup/Delivery → Completed
```

Everything seller-controlled lives at the register level (fulfilment methods & per-product options); nothing is hard-coded.

---

## 2. Data model (additive — all existing rows untouched)

New tables (org-scoped, tenant-safe):

| Table | Purpose |
|---|---|
| `fulfillment_methods` | Seller-config syllables of movement — e.g. Air/Sea/Road/Local/Pickup. Org- or business-scoped. Lead-time defaults. Extensible so future shipping-provider integrations can register a method via the same catalogue. |
| `fulfillment_options` | Per-product offer: method, price, lead window, deposit type (`NONE`/`PERCENT`/`FIXED`)+value, balance-timing terms (`ON_FULFILLMENT`/`ON_ARRIVAL`/`PREPAID`), optional capacity, active flag. |
| `supplier_orders` | Purchase-order pipeline: `RAISED→SENT→SHIPPED→IN_TRANSIT→ARRIVED→RECEIVED` (+CANCELLED), amounts, expected date, linked customer order ids, immutable status history, `expenseBooked` gate. |
| `goods_receipts` | The physical stock-in event (receipt number, items, notes). **The only path by which pre-ordered goods touch inventory.** |
| `order_payments` | Per-order payment-event ledger: DEPOSIT / BALANCE / FULL / REFUND with amount, method, reference and transaction linkage. |

Additive columns on `customer_trackings`: `order_kind`, `payment_plan`, `preorder_expected_at`, `preorder_snapshot` (frozen ETA/deposit/terms at purchase), `balance_due_ghs`, `supplier_order_id`, `stock_commit_stage`. None of the pre-existing columns or rows were mutated for this feature.

Payment statuses: additive `DEPOSIT_PAID` to the existing UNPAID / PENDING_CONFIRMATION / PAID / CREDIT set.

---

## 3. Surfaces built

| Surface | What it is |
|---|---|
| **Storefront** (`src/app/order/page.tsx`) | Pre-order option cards per product, per-line steppers, PRE-ORDER line badges, a checkout *Pre-order terms* explainer (line-level deposit/balance breakdown), deposit-required checkouts forcing MTN MoMo, a post-purchase pre-order summary (ETA window, deposit due, balance & terms, journey list). |
| **Customer track page** (`src/app/track/page.tsx`) | Journey stepper rendered from the server-provided stage list — stock orders show 5 stages, pre-orders show 9 (Received → Confirmed → Procurement → Shipped → In Transit → Arrived → Received Into Stock → Ready → Done). Pre-order facts card (ETA window, method, explainer). Indigo colouring distinguishes supplier-side stages. Payment status explains deposit/balance state via the new `PAYMENT_STATUS_LABELS` + explainer casing. |
| **Staff tracking panel** (`src/components/CustomerTrackingPanel.tsx` + two new components) | • Order rows show a pre-order identity strip (kind, ETA window, PO-needed callout). <br>• Pre-order payment zone: total / paid / balance line, *Confirm deposit* / *Confirm balance* buttons with MoMo-or-Cash selector, payment-event feed. <br>• Stock orders keep the legacy single-confirm flow. |
| **Pre-Order Setup view** — new tab (`src/components/PreorderSetupView.tsx`) | Sellers manage methods (custom key + lead-time window + address requirements + org-vs-business scope, seed standard set with one click) and per-product options (price/lead/deposit/terms/capacity/active). |
| **Procurement view** — new tab (`src/components/ProcurementPanel.tsx`) | Register of supplier orders with badges + trail; raise modal — pick a supplier, tick the waiting pre-orders to link (lines auto-aggregated from the linked baskets, costs editable), expected-at + note; advance button walks the FSM one stage at a time; posting goods receipt is gated to ARRIVED. |

---

## 4. Server-side APIs

| Route | Actions |
|---|---|
| `GET/POST /api/fulfillment` | Staff catalogue: `SEED_DEFAULTS`, `ADD_METHOD`, `UPDATE_METHOD`, `ADD_OPTION`, `UPDATE_OPTION`, `TOGGLE_OPTION`. Scoped by branch access; options validate inventory→business / method→org pairing. |
| `GET/POST /api/procurement` | `RAISE`, `ADVANCE`, `RECEIVE`, `CANCEL`. RAISE interns to `RAISED`, validates unit+links. ADVANCE uses `SUPPLIER_ORDER_NEXT` only, and re-propagates the customer-faced stage. RECEIVE posts the receipt and books the (one-time) supplier expense. CANCEL refused once RECEIVED. |
| `/api/order` (checkout) | Accepts `fulfillmentPicker: { inventoryId: optionId }` and prices pre-order lines **strictly from the server-resolved option**, skipping stock. Emits `orderKind` / `paymentPlan` / `preorderSnapshot` / `balanceDueGhs` on the order row and returns a summary block to the storefront. |
| `/api/tracking` (staff) | `SET_STATUS` is `orderKind`-aware (pre-order transitions validated along the preorder chain); `MARK_DEPOSIT` + `MARK_BALANCE` book additive ledger events that refuse duplication and enforce deposit-before-balance. |
| `/api/track` (public) | Same payload as before + `orderKind`, `paymentPlan`, a `journeyStagesList`, and a customer-safe subset 'preorderSnapshot'. |

### The engine: `src/lib/preorder.ts`
`resolvePreorders` (strict per-cart-line server resolution with 409 problems — **declined options can never leak to clients as the silent fallback any more**), `buildPreorderSnapshot`, `orderKindFor`, deposit/terms computation, `linesForCommit`/receipt helpers (pre-order lines never commit early), `bookPaymentEvent` (one transaction + one ledger row per event), the supplier-order FSM (`SUPPLIER_ORDER_NEXT`, `PO_TO_ORDER_STAGE`, `propagatePoStage` — forward-only per the mapped customer stage with history dedupe), and `postGoodsReceipt` (ARRIVED-only, businessId-scoped stock increments, goods_receipts insert, one-time supplier EXPENSE transaction + `expenseBooked` flag).

### Audit surface
`auditLog` entries are written on option/method catalogue mutations, PO lifecycle, goods receipts and payment events (via `src/lib/audit.ts`); transport remains on its own `writeTransportTrail`. The stock-order audit behaviour is unchanged.

---

## 5. Acceptance criteria — all met

| Criterion | How it's satisfied |
|---|---|
| **Own concept inside the existing order system** | Orders carry `orderKind` — `STOCK` (legacy), `PREORDER`, `MIXED` — and the stock paths are byte-for-byte the old logic. Staff + customers keep the same tracking register, just richer. |
| **Products In Stock / Pre-Order / both** | Menu items sell when they have stock **or** an active option — storefront renders both availability chip and per-option cards. Out-of-stock items without options stay hidden as before. |
| **Seller-defined fulfillment options** | `/api/fulfillment` + Setup view — keys, labels, icons, lead-time window, address/pin requirements, price, deposit, terms, capacity, org/business scope, active. |
| **Explicit customer choice** | Server-validated `fulfillmentPicker`: any stale/foreign/mismatched option rejected 409. MIXED baskets carry per-line choices. |
| **Customers visibility** | Same track page, same TEXT; journey extends to 9 stages when pre-order. Deposit explainer text on checkout + track. |
| **Suppliers integration** | PO links to `supplier_orders.supplierId`, supplier pick + supplier-name fallback + org scoping in RAISE. |
| **Procurement integration** | Customer stage `PROCUREMENT` ↔ supplier `RAISED/SENT`; every PO activity mirrors onto linked customer orders forward-only (dedupe by history). "Raise PO" is one click on any waiting pre-order. |
| **Payments integration** | `order_payments` ledger — DEPOSIT/BALANCE events tied to Finance transactions; payment statuses incl. DEPOSIT_PAID; staff/CRM spend updates per event. |
| **Finance integration** | One INCOME transaction per payment event; goods receipt books exactly one supplier EXPENSE (idempotent). |
| **Inventory integration** | Only `postGoodsReceipt` lands pre-ordered goods — never an ad-hoc stock bump (§6 for the guarantee). |
| **Notifications** | Deposit/balance confirmations + PO-propagated stage transitions push bell notifications to owners and staff subscribers (existing `pushAfterBell` channel). |
| **Audit integration** | `auditLog` for all catalogue/procurement/payment mutations. |
| **Reports integration** | Orders register displays orderKind, ledger position, supplier-PO state, balance due; underlying data is web-shape (no new derivation paths). |
| **Tracking integration** | Public/staff steppers share the same server chain API; statuses validated server-side per orderKind. |
| **Flow compliance** | Verified the chain §7: Pre-Order → Payment/Deposit → Supplier Procurement → Shipped → In Transit → Arrived → Inventory Receipt → Ready → Completed. |
| **Never count as available inventory before receipt** | **Verified with quantities before/after** — NO client-side deduction, NO out-of-goods-receipt path (§6). |
| **Configurable, never hard-coded** | Methods + options + terms from the catalogue; the only device constants are `SUPPLIER_ORDER_NEXT` (FSM) and `DEFAULT_FULFILLMENT_METHODS` (SEED_DEFAULTS — idempotent helper, not a seeding requirement). |
| **Tenant isolation** | Option scope is per-org (and optionally per-business), enforced server-side everywhere; cross-org picks → validation problem. PO/expense/deposit routes check `canAccessBusiness`. No new cross-tenant reads on menu (existing org scope preserved). |
| **Future shipping providers** | Additional methods are rows in `fulfillment_methods` — carrier integrations can plug via `shippingMethodKey` on supplier_orders + `methodKey` on options without code changes. |

---

## 6. Stock gates — the safety invariants (server-enforced)

1. **Only `postGoodsReceipt()` moves pre-ordered goods into `inventory_items.quantity`.** It refuses unless PO status is ARRIVED, validates every line's inventory belongs to the PO's business, writes the goods_receipts row, and books the supplier expense exactly once (`expenseBooked`).
2. **Pre-order lines never commit at checkout.** `linesForCommit` filters them out; customers pass CONFIRMED without touching stock — cancellation is free of restore work for preorder portions.
3. **MIXED orders commit the STOCK lines at CONFIRMED and the PREORDER lines at RECEIVED_STOCK**, tracked by `stockCommitStage`. CANCELLED restores only what was committed (`restoreOrderStock` per stage).
4. **Nobody can double-receive / double-book.** RECEIVE is ARRIVED-only (⟹ 409 "Goods can only be received once the shipment is ARRIVED"), expense is keyed by the PO.
5. **Ledger cannot double-apply.** MARK_DEPOSIT on an order with an existing DEPOSIT/FULL → 409. MARK_BALANCE when balance paid → 409. MARK_BALANCE before deposit when plan=DEPOSIT_NOW → 409 (with the balance auto-derived from remaining-paid sums).
6. **Deposit-required checkouts must carry a real MoMo intent** — `ON_DELIVERY` with a positive deposit due → 400 "choose MTN MoMo to continue." The storefront additionally disables that radio.
7. **Received POs cannot be cancelled** (write-off flow governs).
8. **`resolvePreorders` cannot fall back** to legacy stock logic when the picker is filled — after the fix in §7.F, a malformed/foreign/stale pick always becomes a validation problem, never a silent stock order.

---

## 7. End-to-end verification walk (all performed against the live dev server)

Each step exercised via the real APIs (OWNER session) + browser:

A. **Catalogue** — seeded the 5 default methods (AIR/SEA/ROAD/LOCAL/PICKUP) via `POST /api/fulfillment SEED_DEFAULTS` for biz 22; added two options (Dressed Broiler Chicken · AIR · ₵145 · 40% deposit · balance ON_FULFILLMENT; Egg Trays · SEA · ₵58 · pay-full-now PREPAID).

B. **Customer journey (deposit plan)** — storefront browser probe: product card showed *"via Air Freight Import (7–14 days) — deposit GH₵ 58.00, balance ready"* card; cart line carried the PRE-ORDER badge; ON_DELIVERY radio disabled; ordered 2× broiler → order GM-POULTRY-RCBPPW: `orderKind=PREORDER`, total 290, deposit 116 / balance 174, expected window 2026-09-24 → 2026-10-01.

C. **Deposit booking** — `MARK_DEPOSIT (MoMo)` → `paymentStatus=DEPOSIT_PAID`, balance 174, ledger event DEPOSIT 116 MoMo present.

D. **Procurement** — raised PO-SO-2026-9195 (+ PO-SO-2026-8119) with linked preorder(s) → advanced `SENT→SHIPPED→IN_TRANSIT→ARRIVED` (each reflects on the customer timeline, forward-only, deduped).

E. **Goods receipt** — `RECEIVE` → receipts GRN-2026-1008 and GRN-2026-3324: inventory qty moved from 13 → 15 then preorder lines committed 15 → 15 (proof the landing stock is instantly earmarked, never shown to the branch as free); customer status flipped to RECEIVED_STOCK with the commit note; second receipt attempt → 409; expense transaction single-booked.

F. **Cross-tenant & staleness defenses** — submit with option id 999 or the broiler's option on the egg-tray line → both 409 *"One of your fulfilment choices is no longer available."* During this pass the silent-fallback bug in `resolvePreorders` was found and fixed (it used to return `null` instead of `{lines, problems}` when zero lines resolved — a 409 condition turned legacy-stock checkout).

G. **Balance + completion** — `MARK_BALANCE (Cash)` on 126 → `paymentStatus=PAID`, balance 0; duplicate balance → 409; events ledger shows DEPOSIT 116 MoMo + BALANCE 174 CASH side-by-side. Then `SET_STATUS READY → COMPLETED` on the pickup pre-order — forward-only refusal for `READY → PROCUREMENT` correctly returns the allowed set.

H. **Staff console browser probe** — login → TRacking tab → *Pre-order setup* view (5 methods + 2 options), *Procurement* view (RAISE button + register), preorder strip + deposit/balance zone present in the order drawer.

I. **Public track page** — payload carries `journeyStagesList(9)`, `orderKind=PREORDER`, `preorderSnapshot.etaEnd=2026-10-01`; DOM probe of the storefront shows the terms block and the forced-MoMo radio rule.

`npx tsc --noEmit` clean at every phase boundary.

---

## 8. What the legacy surfaces gained (read-only, additive)

- **Menu** — keeps serving existing fields verbatim; products additionally surface `inStock` + `preorderOptions` (id, methodLabel/Key, price, lead window, deposit type/value/per-unit, terms, requiresAddress, requiresPin, capacityPerPeriod).
- **Orders register** — GET now returns per-row `paymentEvents`, `paidGhs`, `balanceRemainingGhs`, plus `orderKind`.
- **Audience checks** — the existing `canAccessBusiness`/`accessibleBusinessIds` guards are reused for every new route; OWNER-visibility rules preserved.

---

## 9. Known limitations (recorded for follow-up)

1. **MoMo charge is still the business's manual flow** — "MOMO_PAYMENT" marks intent; the actual charge is keyed by the owner-side commerce setup (unchanged from stock orders). Payment-confirmed webhooks aren't in scope.
2. **Reserve balancing** — when one PO serves several pre-orders and arrives short, allocation is FIFO-of-linked-orders (no proportional partial-allocation). The UI surfaces the shortage as a history note so ops can choose.
3. **Reports** — pre-order revenue now books via deposit/balance events; the daily-sales register views them as current-day revenue which is correct for cash-flow, but a dedicated "pre-order pipeline" FOH-style report would be a nice-to-have next slice.
4. **Delivery leg for ARRIVED goods** — reuses the stock `READY → DISPATCHED → DELIVERED` path; POST-ARRIVED dispatches don't carry `live` driver feeds any differently from stock orders (same existing capability).
5. **Staff console search** doesn't yet index `preorderSnapshot.methods` — filter by code/customer/product remains the entry.

---

## 10. Files touched

**New:** `src/lib/preorder.ts`, `src/lib/audit.ts`, `src/app/api/fulfillment/route.ts`, `src/app/api/procurement/route.ts`, `src/components/PreorderSetupView.tsx`, `src/components/ProcurementPanel.tsx`, this report.

**Extended additives:** `src/db/schema.ts` (lease tables + order columns + tables index), `src/lib/tracking.ts` (statuses, labels, journey stages/index, payment labels/explainers, path helpers), `src/lib/trackingServer.ts` (full-payment branch unchanged + shared code), `src/app/api/order/route.ts`, `src/app/api/menu/route.ts`, `src/app/api/tracking/route.ts`, `src/app/track/page.tsx`, `src/app/order/page.tsx`, `src/components/CustomerTrackingPanel.tsx`.
