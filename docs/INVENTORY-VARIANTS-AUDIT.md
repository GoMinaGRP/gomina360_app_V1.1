# Inventory & Stock → Add Stock Item — Variant Recording Audit

**Status:** audit + recommendation only. **No application code was changed.**
**Scope:** how products with options (size, colour, shoe size, style, model, capacity, other) are created,
stocked, restocked and made available today; what the Add Stock Item form does and does not capture;
how this integrates with the customer Order Page; and the recommended approach across business types.
**Branch:** `arena/01a0fecd-gomina360-app-v1-1` · **Base commit:** `84748d3` (tree clean)

---

## 1. Executive summary

The hard part already exists. The database has a complete, additive variant engine
(`inventory_items.tracksVariants` + `inventory_variants` rows with their own quantity, reorder point, SKU,
active flag, and a parent quantity kept as the live aggregate). The customer Order Page and POS already
consume it correctly: sizes/colours are projected to the storefront, out-of-stock combinations are
disabled, the checkout validates the chosen variant, the deduction is atomic, and cancellations restore
the right row.

**The gap is entirely on the business-facing side.** There is no way to *enter* variants where products
are actually registered:

1. **Add Stock Item never creates variants.** Its "Variants / Options" list is free text (`name` + `note`)
   with **no quantity**, stored in a legacy display-only JSON column. It never touches the variant engine.
   → *Gap A*
2. **The only variant-recording UI lives in a different module** — the Boutique module's "Sizes & Stock"
   modal — and it is reachable **only for businesses whose category maps to BOUTIQUE**. A shoe shop,
   electronics shop, or hardware store has **no surface at all** to record per-variant quantities.
   → *Gap B*
3. **Nothing stops a variant product from being written by the plain aggregate path.** The shared stock
   writer and the inventory edit modal both write `inventory_items.quantity` with no `tracksVariants`
   guard, so a restock/adjustment/sale on a variant item silently desynchronises it — and the next
   variant movement silently reverts it (a *lost deduction*, i.e. oversell risk). → *Gap C*
4. **Order Page wiring is already correct** and needs only cosmetic work (axis labels, optional
   per-variant price). → *Gap D (closed)*

**Recommendation in one line:** keep the existing variant engine, add one optional "variants" step to the
Add Stock Item form (and the record view), route every stock movement for a variant item through the
existing variant rows, and generalise the two axes to *named* axes so size / colour / shoe size /
capacity / style / model / custom all fit the same model. Products that do not need variants keep the
current form unchanged — **zero extra required fields**.

---

## 2. What happens today — end-to-end trace

### 2.1 Add Stock Item (Inventory & Stock)

| Step | Where | What happens |
|---|---|---|
| Form | `src/components/SharedEnterpriseModule.tsx` INVENTORY branch (~2768–3060) | Name, SKU (auto), category/subcategory, branch, **Quantity**, unit, min level, cost, selling price, photos, description, brand, model, size (as a spec), weight, custom specs, plus a **"Variants / Options (optional)"** list of `{name, note}` rows |
| Payload | `performAddItem` (~1104–1141) | Sends `quantity`, `minStockThreshold`, `specifications`, and `variants: invVariantsUI` — a JSON array of `{name, note}`. **Never sends `tracksVariants` or any quantity-per-variant matrix.** |
| Server | `src/app/api/enterprise/route.ts` POST | Inserts the item **empty**, then applies the opening quantity through the one stock writer `applyStockChange({ reason: "OPENING" })`. `variants` lands in `inventory_items.variants` (jsonb) via `sanitizeVariantList`. The server *does* support `tracksVariants: true` + `boutiqueVariants` (`/api/enterprise/route.ts:1008–1070`, calling `setVariantsForItem`) — **but no client ever sends it**, so that path is unreachable from the UI. |
| Result | `inventory_items` | `tracksVariants = false`, `quantity = n`, display-only chips. |

The form's variant rows therefore look like variant management but carry no stock, no availability and no
link to the Order Page.

### 2.2 Where variants can actually be recorded today

`src/components/BoutiqueModule.tsx` → tab **"Sizes & Stock"** → modal (`boutique-manage-<id>`):

- size **system** selector (`SIZE_SYSTEMS`: LETTER, SHOE_UK, SHOE_EU, SHOE_US, NUMERIC, KIDS, FREE, CUSTOM),
- size and colour chips (20 presets with hex) + free custom entry,
- a **matrix** with quantity **and** per-row reorder point per combination, plus "Fill all",
- save → `POST /api/boutique { action: "SET_VARIANTS" }` → `setVariantsForItem()`,
- restock → `ADJUST_STOCK` → `adjustVariantStock()`, optionally booking the landed cost as an expense.

Reachability is the problem: `GoMinaApp.tsx` maps **category → module**
(`MODULE_BY_CATEGORY`, ~1178–1204) and only `Boutique`, `Boutique & Fashion` and `Fashion & Apparel`
resolve to `BOUTIQUE`. Live data confirms the consequence: 17 inventory items, **4 with variants**
(39 active variant rows — all Boutique), while the 6 hardware items and the electronics item are all
`tracks_variants = false` with no way to change that from their own module.

### 2.3 Where variants are consumed (already correct)

- `/api/menu` (marketplace/order catalogue) projects `hasVariants` + `variantOptions {sizes, colors, variants[], totalAvailable}` from `storefrontVariants()`; out-of-stock combinations are marked.
- `src/app/order/page.tsx` ↔ `ProductVariantPicker.tsx` (shared with POS / `BranchManagerSalesView`) renders the axes, disables unavailable options, auto-selects when only one axis exists, and blocks "Add to cart" until the pick is complete and in stock.
- `POST /api/order` re-validates with `resolveVariantForLine()`; `POST /api/sales` and `/api/credit-sales` do the same, then deduct with the atomic `deductVariantQty()` (`quantity >= n` guard) and recompute the aggregate with `syncItemAggregate()`.
- Order commit (`src/lib/trackingServer.ts`) and cancellation restore (`restoreOrderStock`) are variant-aware; a variant line always targets its own row.
- Backup/restore (`src/lib/businessBackup.ts`) exports `inventoryVariants`, remaps `inventoryId`, regenerates SKUs, and carries `stockMovements` (which even has a `variantId` column).

So the customer-facing requirement — *"customers only see and order options that are actually
available"* — is satisfied by the engine. It is starved of data, not broken.

---

## 3. Findings

Severity: **S1** = data integrity / money risk · **S2** = blocking usability · **S3** = consistency/polish.

| # | Sev | Finding | Evidence |
|---|---|---|---|
| **F1** | S2 | **Add Stock Item cannot register variants.** Quantity is item-level only; the "Variants / Options" rows are `{name, note}` and are never written to `inventory_variants`. | `SharedEnterpriseModule.tsx:151, 1104–1141, 3030–3055` |
| **F2** | S2 | **The variant UI is Boutique-only.** Only categories mapping to `BOUTIQUE` expose "Sizes & Stock"; shoes, electronics capacity, hardware styles/models have no surface. | `GoMinaApp.tsx:1178–1204`, `BoutiqueModule.tsx` tab + modal |
| **F3** | S1 | **Aggregate writes are not guarded for variant items.** `applyStockChange()` and the inventory PATCH both write `inventory_items.quantity` (via `computeStockStatus`) with no `tracksVariants` check. Any non-variant-aware surface that restocks, adjusts or sells a variant item overwrites the derived aggregate; the next `syncItemAggregate()` silently reverts it — so a **sale's deduction disappears** and the item can be oversold, and the `stock_movements` row describes a change that no longer exists. | `stock.ts:109–170`; `api/enterprise/route.ts:299–358`; `boutique.ts:92–115` |
| **F4** | S1 | **Module stock paths deduct by aggregate.** Hardware delivery (`stockOutItem`), electronics receive/delivery, block factory, branch-unit restock, restaurant, car wash, transport, feed-mill use `applyStockChange`/`stockIn`/`stockOut` directly. For a variant item these bypass the variant rows entirely. | `api/hardware/route.ts:117–128, 323–360`; `api/electronics/route.ts:33, 328–370`; `stock.ts:248–310` |
| **F5** | S2 | **No restock surface for variants in Inventory & Stock.** The record view shows a single editable "Quantity on Hand" (`edit-inventory-qty`) — editing it on a variant item is exactly the desync in F3. There is no "Stock in / Stock out" action in that module, and the QR flow only views/prints a label ("Scan its QR label to restock fast" overpromises). | `SharedEnterpriseModule.tsx:3446–3451`, `QrRecordModal.tsx`, `QrScanModal.tsx` |
| **F6** | S3 | **Two variant representations coexist.** Legacy `inventory_items.variants` (jsonb chips) vs live `inventory_variants` rows. When a matrix exists `/api/menu` replaces the chips with live ones, so the jsonb list becomes invisible duplicate data; when no matrix exists it produces storefront chips that promise options the business never stocked. | `schema.ts:691, 697, 721`; `api/menu/route.ts:360–372` |
| **F7** | S3 | **Variant movements are missing from the audit trail.** `adjustVariantStock()` (the Boutique restock) updates the row and re-syncs the aggregate but writes **no** `stock_movements` row, even though that table already has a `variantId` column. Item-level movements log correctly. | `boutique.ts:254–290`; `schema.ts:776` |
| **F8** | S2 | **Per-variant reorder points exist in data but never alert.** Low-stock alerts and dashboards read the **parent** `quantity` against the **item** threshold (`lowStock.ts:49–57`, `actionCenter.ts`), so `min_stock_threshold` on a variant row is stored, editable in the Boutique matrix, and then ignored. | `lib/lowStock.ts`, `lib/actionCenter.ts` |
| **F9** | S3 | **The variant engine is hard-wired to exactly two axes with fixed names.** Columns are `size` + `color`, capped at 24 characters and 120 rows per item, and the label "Size"/"Colour" is hard-coded in the picker and in the menu projection. Capacity (128GB/256GB), style, or model can be *stored* (via `FREE`/`CUSTOM` systems) but will be **labelled "Size"** to customers. | `boutiqueSizes.ts:16, 105, 165–198`; `ProductVariantPicker.tsx:207, 241`; `api/menu/route.ts:368` |
| **F10** | S3 | **No per-variant price.** `inventory_variants` has no price column, so 256GB cannot cost more than 128GB (a pre-order option price or a separate product is the current workaround). | `schema.ts:721–746` |
| **F11** | S3 | **Fully sold-out variant products vanish from the shop** (`sellable = variantAvailable > 0 || preorderOptions.length > 0`), rather than showing "Out of stock". Defensible, but worth an explicit decision because it also hides the product page and its photos. | `api/menu/route.ts:319–321` |
| **F12** | S3 | **Nothing in Inventory & Stock indicates a product tracks variants.** The list, badges, filters and low-stock widgets treat an aggregate-36 shirt exactly like a plain item, so users cannot tell why its quantity does not behave like a normal number. | no `tracksVariants` reference in `src/components` |

### Root cause

```
ENGINE (complete)            ENTRY POINTS (missing / misplaced)              CONSUMERS (complete)
inventory_variants     ←──   Boutique "Sizes & Stock" modal only              Order Page / POS
  qty, threshold, SKU         (Boutique-category businesses only)             /api/menu projection
aggregate = SUM(rows)   ←──   Add Stock Item: free-text chips, no qty         /api/order, /api/sales, tracking
```

One engine, one orphaned entry point, and a second unguarded write path competing with it.

---

## 4. Recommended solution

### 4.1 Principles

1. **Reuse the engine** — `inventory_variants` + `syncItemAggregate` already give per-combination stock, atomic deduction, restore, SKU and storefront projection. Do not build a second system.
2. **One entry point next to the product** — variant setup belongs in Add Stock Item and in the record view, for **every** business type, not in a category-gated module tab.
3. **One writer per data family (P6)** — for a variant item, the variant rows are the truth and `applyStockChange` must route there; the plain aggregate path must refuse (with a clear message) instead of silently writing.
4. **Optional by default** — a product with no options looks and behaves exactly as today: one quantity, no extra fields.
5. **Everything the customer sees is derived** — the Order Page keeps reading the same projection it already reads.

### 4.2 Option model — two *named* axes, arbitrary meaning

Keep the existing two-axis storage (it is what the Order Page, POS, SKU generator and backup already
speak) but stop assuming the axes mean size and colour:

- Add two nullable columns on `inventory_items`: `optionAxis1Label`, `optionAxis2Label`
  (defaults: "Size" / "Colour"). Additive, no backfill required.
- The editor presets the pair per business type — Clothing: **Size × Colour**; Footwear: **Shoe size × Colour**;
  Electronics: **Capacity × Colour** (or Capacity alone); Hardware: **Size / Style / Model × Finish**;
  Grocery/Pharmacy: **Pack size × Variant**; Services: **Package** — plus **Custom** for anything else.
- Single-axis products (colour only, capacity only) already work and must keep working; the picker
  auto-completes them (`ProductVariantPicker` already does this).
- Three-plus axes are explicitly out of scope: two axes × the 120-row cap covers the cases described
  (Black/S…White/M, UK 6–10 × White/Black, 128/256GB × colour). Add a "package as separate items" note
  for anything beyond that.
- Axis values keep the 24-character limit (enough for "UK 10", "256GB", "Matte Black"); raise the value
  cap only if a real case needs it.

### 4.3 Add Stock Item UX (the core recommendation)

**Step 1 — unchanged simple flow.** Everything today stays: name, category, branch, quantity, unit, min
level, cost, selling price, photos, description, brand, model, specs. A non-variant product needs no
new field and sees no new screen.

**Step 2 — one optional toggle, placed directly under Quantity:**

```
Does this product come in sizes, colours or other options?      [ No ]  ← default
      Yes →  Axis 1: [Size ▾] values: S M L XL XXL [+ custom]  
             Axis 2: [Colour ▾] values: Black White Navy [+ custom]   (optional)
             ┌────────────┬──────────┬─────────┐
             │ Combination│ Quantity │ Reorder │
             ├────────────┼──────────┼─────────┤
             │ S / Black  │   10     │    3    │
             │ M / Black  │   15     │    3    │
             │ …          │          │         │  [Fill all] [Copy row 1 down]
             └────────────┴──────────┴─────────┘
             Total in stock: 51   (this becomes the product's quantity)
```

- The matrix is **generated from the chosen axis values** (chips + custom entry, exactly the affordances
  the Boutique editor already provides) so the business never types combinations by hand.
- When the toggle is **Yes**, the plain Quantity field is replaced by the matrix total — the form still
  has the same number of required fields as today.
- On submit, the client sends `tracksVariants: true` + the matrix to the **existing** POST path
  (`/api/enterprise` already understands it); the server stores rows via `setVariantsForItem()` and the
  aggregate is the sum. This turns an unreachable server capability into the normal flow.
- The legacy free-text "Variants / Options" list is **retired from the Add form**. If old chips exist on
  a record, the edit view offers a one-click "Turn these into options" (pre-fills axis values, quantities
  start at 0) — never an automatic migration, so no fake stock is invented.

### 4.4 Record view, restock and availability

- The record view replaces the single "Quantity on Hand" input for variant products with a read-only
  aggregate plus **"Manage options & stock"** (opens the same matrix) — this closes F5 and stops F3 at
  the UI. Non-variant products keep the plain editable quantity.
- Add a **Stock in / Stock out** action on each row (also reachable by scanning the product's QR label,
  which finally delivers the "scan to restock" promise): for a variant item it asks *which* combination,
  then applies a `delta` through the variant writer; for a plain item it keeps today's behaviour.
- Per-variant reorder points feed the low-stock list: show the item once, with the offending
  combinations and their counts underneath (`S/Black — 2 left, reorder at 3`).
- Availability is managed by editing quantities (0 = sold out, combination disabled on the Order Page)
  and by **deactivating** a combination that is no longer sold (kept out of the storefront, history
  preserved) — both already exist in the engine.
- Backup/restore needs no work: variants and movements are already exported and remapped.

### 4.5 One writer (data integrity, must land first)

Extend `applyStockChange()` (and the `/api/enterprise` PATCH) so that when the resolved item has
`tracksVariants = true`:

- a call **with** `variantId` updates that row (plus aggregate re-sync and a `stock_movements` row with
  `variantId`, which the table already supports);
- a call **without** `variantId` is **refused** with a plain message
  ("This product is stocked by size/colour — choose the combination to move") rather than writing the
  aggregate;
- direct PATCH `quantity` on such an item is refused the same way, so the edit modal cannot desync it.

Then wire the module flows (hardware GRN/delivery, electronics receive/delivery, block factory,
branch-unit, restaurant, car wash, transport, feed-mill) to pass a variant when the item tracks them —
the shared `ProductVariantPicker` already exists for exactly this kind of chooser. Until a flow is
wired, the guard fails safe (clear error) instead of silently losing stock.

Also give `adjustVariantStock()` the same `stock_movements` write (`variantId`, reason `RESTOCK` /
`ADJUSTMENT`) so the trail is complete.

### 4.6 Order Page integration (mostly already done)

- No behavioural change required to satisfy "customers only see/order available options": the projection,
  the picker's disabled states and the two server-side validations already do it.
- Cosmetic/consistency follow-ups: label the axes from `optionAxis1Label` / `optionAxis2Label` (instead
  of the hard-coded "Size"/"Colour"), use the per-variant price if added, and keep the lightbox chip list
  driven by live rows (already the case).
- Decide explicitly whether a fully sold-out variant product stays listed as "Out of stock" or is hidden
  as today. **Recommended default: keep today's behaviour** (hidden unless pre-order options exist) —
  the requirement is about not selling unavailable options, and hiding already satisfies it.

### 4.7 Coverage across business types

| Business type | Typical axes | How it looks in the same model |
|---|---|---|
| Boutique / fashion | Size × Colour | unchanged from today (LETTER/KIDS) |
| Footwear | Shoe size × Colour | `SHOE_UK`/`SHOE_EU`/`SHOE_US` systems — already seeded in `SIZE_SYSTEMS` |
| Electronics | Capacity × Colour, or Capacity | axis 1 labelled "Capacity", values 64GB/128GB/256GB |
| Hardware | Size / Style / Model × Finish | axis 1 labelled "Size" / "Style" / "Model" |
| Grocery / pharmacy | Pack size × Variant | FREE/NUMERIC systems |
| Restaurant / services | Package / portion | single axis, `FREE` |
| Any | Custom | business names both axes |

---

## 5. Phased implementation plan (not started)

Each phase is independently shippable and testable; no phase changes the customer Order Page contract.

**V1 — Integrity first (no UI change).** Variant-aware `applyStockChange` + PATCH guard; `stock_movements`
rows for variant adjustments; module flows fail safe with a clear message; per-variant low-stock surfaced
under the item.
*Acceptance:* a variant item cannot have its aggregate written by any non-variant path (verified by
attempting each path and asserting a refusal + unchanged rows); a restock/adjustment on a variant writes
one movement row with `variantId`; Order Page behaviour identical.

**V2 — One entry point.** "Options" step in Add Stock Item (toggle, axis pickers, matrix, totals) wired
to the existing `tracksVariants` POST capability; record view swaps the quantity field for
"Manage options & stock"; legacy chips retirement + "turn into options" helper.
*Acceptance:* Black/S 10, Black/M 15, Black/L 8, White/S 6, White/M 12 can be entered at registration in
one pass and appear as the product's quantity (51) and in the Order Page picker; a product with the
toggle left off is byte-identical in behaviour and payload to today.

**V3 — Restock & availability.** Stock in/out action on a row (and from the QR label), deactivate/reactivate
combinations, per-variant reorder alerts in the low-stock surface.
*Acceptance:* restock a single combination → only that row changes, aggregate and `stock_movements`
agree; deactivating a combination removes it from the storefront immediately and keeps it out of
`variantOptions`; a combination at 0 is disabled on the Order Page and rejected by `/api/order`.

**V4 — Storefront & POS polish.** Axis labels from the item, optional per-variant price, chip wording.
*Acceptance:* a capacity product shows "Capacity: 128GB" and not "Size: 128GB"; per-variant prices
survive order creation and receipts; existing Boutique products render exactly as before.

**V5 — Retire the duplicate.** Boutique "Sizes & Stock" becomes a thin launcher for the shared editor
(one admin component, two entry points), and the legacy `variants` jsonb column is marked read-only
(kept for compatibility, no longer writable from either UI).
*Acceptance:* no admin surface exists that can write the legacy chips; one shared component renders in
all entry points; full regression suite green.

---

## 6. What does **not** change

- Products without variants: same form, same fields, same quantity semantics, same payload shape.
- The four existing Boutique products and their 39 variant rows: data untouched.
- Order Page, cart, payment, tracking, deep links, POS, stock projection, atomic deduction, restore on
  cancellation: unchanged contracts.
- Export/restore, tenant isolation and permissions: untouched.
- Three-axis products: out of scope (documented workaround: separate products or the two closest axes).

## 7. Open questions (with recommended defaults)

1. **Per-variant price?** Recommended: yes, additive nullable `priceGhs` on `inventory_variants`, falling back to the parent price (needed for capacity/model). Can ship in V4.
2. **Max axes / variant cap?** Recommended: keep 2 axes and raise the 120-row cap only if a real product needs it; warn in the editor above ~60 rows.
3. **Fully sold-out variant product:** recommended keep hiding (today's behaviour) rather than a new UI state.
4. **Legacy free-text chips:** recommended read-only, no auto-migration.
5. **Returns/exchanges to a specific combination:** already supported by `restoreVariantQty`; add the picker in V3 if the returns flow exposes it.

## 8. Verification approach

- Reuse `dev-tooling/verify-*.mjs` suites for the storefront contract (`order-page-regression`, `customer-order-tracking`, `online-ordering`, `online-mgmt`, `finance-allproducts`).
- Add one variant suite per phase: matrix entry at registration (V2), aggregate/guards and movement trail (V1), restock/availability and storefront disabled states (V3), labels/prices (V4).
- DB-level assertions via `node dev-tooling/q.mjs` on `inventory_variants`, `inventory_items.quantity/status/tracks_variants` and `stock_movements.variant_id`.

## 9. Evidence appendix

- Live data at audit time: 17 inventory items, **4 variant-tracked** (Boutique), **39 active variant rows**, 1 item with legacy chips; 6 hardware items and 1 electronics item with no variant surface.
- `inventory_variants` uniqueness: `(inventory_id, size, color)` and `(business_id, sku)`; `size`/`color` are `NOT NULL DEFAULT ''` so single-axis rows are first-class (`schema.ts:721–746`).
- Aggregate recompute: `syncItemAggregate()` (`boutique.ts:92–115`) — the only derived writer; falls back to plain stock and clears `tracksVariants` when no active rows remain.
- Client entry points that can create variants today: `BoutiqueModule` → `POST /api/boutique SET_VARIANTS` (`boutique/route.ts:288`) and the seed.
- Server-side variant creation at registration exists (`api/enterprise/route.ts:1008–1070`) with no UI caller.
