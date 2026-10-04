# Boutique (fashion / clothing / apparel)

GoMina 360 business type **Boutique** — the same platform backbones as every
other unit, plus a size × colour stock layer for apparel, footwear and
accessories.

## What was reused (no duplicate systems)

| Requirement | Reused system | Change made |
| --- | --- | --- |
| Inventory | `inventory_items` (one stock register) | additive `tracks_variants` flag + `inventory_variants` rows; item `quantity` stays the live aggregate |
| Sales / POS | `/api/sales`, `BranchManagerSalesView` + the module's own till | optional `variantId` per cart line; receipt lines carry `size`/`color` and the description shows `[Size: M · Colour: Black]` |
| Credit sales | `/api/credit-sales` | same `variantId` handling |
| Customer Orders | `/api/order`, `/api/tracking`, `/track` | variant required for variant products, validated against the variant's own stock; commit/restore deduct the exact variant |
| Expenses | `ExpenseEntryForm` + `postOrGateExpenseTransaction` | variant restock can book a `BOUTIQUE_STOCK_RESTOCK` expense |
| Finance & Reports | `FinancialReportSection` | mounted on the module's Finance tab with boutique ops links |
| Customers / Suppliers | shared CRM tables | surfaced on the module's tab |
| Audit | shared `audit_trail` via `lib/audit.ts` | `BOUTIQUE_SET_VARIANTS`, `BOUTIQUE_ADJUST_VARIANT_STOCK`, `BOUTIQUE_DELETE_VARIANT` |
| Customer storefront | `/order` + `/api/menu` | `hasVariants` / `variantOptions` projection; picker gates Add to Cart; sold-out combos disabled |
| Daily checklist | `provisionBusiness` + per-type templates | `BOUTIQUE_TASKS` in `lib/checklistDefaults.ts` |
| Backups | `lib/businessBackup.ts` | `inventory_variants` exported and remapped on import |

The closest pre-existing module is the **Electronic Shop** (retail stock +
orders + receipts); Boutique reuses its architecture — scoped business module,
shared API routes — and only adds the variant layer.

## Data model

```
inventory_items
  tracks_variants  boolean  (false/NULL for every pre-existing item)
  quantity         = Σ active inventory_variants.quantity   (kept in sync)

inventory_variants
  business_id, inventory_id, size, color, size_system, sku,
  quantity, min_stock_threshold, status, is_active, sort_order
  UNIQUE (inventory_id, size, color) · UNIQUE (business_id, sku)
```

* Size systems: `LETTER`, `SHOE_UK`, `SHOE_EU`, `SHOE_US`, `NUMERIC`, `KIDS`,
  `FREE`, `CUSTOM` — plus free-text custom sizes/colours.
* An item without variant rows behaves **byte-identically** to before.
* Removing a combination deactivates its row; sales history is kept.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/boutique?businessId=N` | dashboard: sales, expenses, profit, inventory, variant summary, orders, low stock, best-selling products/sizes/colours |
| `GET /api/boutique?businessId=N&variantsOnly=1` | lightweight variant matrix for the staff POS |
| `POST /api/boutique` `SET_VARIANTS` | create/replace a product's size × colour matrix |
| `POST /api/boutique` `ADJUST_STOCK` | restock / stock-take one variant (optional expense booking) |
| `POST /api/boutique` `DELETE_VARIANT` | deactivate one variant |
| `POST /api/enterprise` (`entityType: "inventory"`) | accepts `tracksVariants: true` + `boutiqueVariants: [...]` at product creation |
| `POST /api/sales` · `/api/credit-sales` · `/api/order` | accept `variantId` per line |

Permissions mirror the shared modules: matrix edits require the
inventory-edit gate (`OWNER` or an owner-delegated manager); stock adjustments
are allowed for business members, but booking the restock cost as an expense
additionally needs `canRecordExpenses` for `WORKER`s. Every route is
`canAccessBusiness`-scoped (tenant isolation).

## Demo unit

`seed.ts` provisions **BOUTIQUE-01 — Mina Fashion Boutique** (owner #1, General
Manager grant) with four apparel products whose stock lives on size × colour
rows (letter, numeric and UK shoe sizes; 39 variant rows). It is a one-time,
tombstone-aware, marker-guarded pass — existing units and data are untouched.

## Verification

* `bash dev-tooling/run-suite.sh dev-tooling/verify-boutique.mjs` — 74 checks:
  business-type creation + provisioning, product / matrix creation, storefront
  projection, order → confirm → deduct → cancel → restore, POS/credit sales,
  oversell protection, receipts, reports, audit, permissions, tenant isolation,
  performance and no-regression checks on plain businesses.
* `bash dev-tooling/run-suite.sh dev-tooling/verify-boutique-ui.mjs` — 40
  checks in a real browser: module tabs, variant editor save, POS sale with
  size/colour receipt, storefront chips/out-of-stock/gating, lightbox picker.
