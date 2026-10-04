# Phase 2 — UI consolidation (results report)

**Scope** — audit `docs/FEATURE-OVERLAP-AUDIT.md` §5, phase **P2**: *one shared
inventory-item/restock form; one shared customer form; the Sales & Payments "Financial Report" tab
removed; dashboard stock/customer tabs re-mounted as scoped shared views.*

**Rule followed** — **deep links over re-implementation**: keep every button where the business
expects it, replace the *body* behind it with the one shared implementation, and point to the
canonical module for full management.

**Preserved** — labels/wording per unit, form field keys (submit handlers untouched), test-ids the
suites drive (`hwf-*`, `cwf-*`, `telf-*`), field-level behaviour (empty-number handling, datalists,
required flags), permissions and tenant scoping.

---

## 1. New shared components

| File | Replaces | Notes |
|---|---|---|
| `src/components/shared/ModuleFormFields.tsx` | **9** hand-copied dark input + select pairs (business dashboard, block factory, electronics, hardware, restaurant, car wash, telecom, poultry, aquaculture) | one owner of the markup, tone (`slate800`/`slate900`), optional test-id prefix and the three empty-number conventions (`coerce` → 0, `empty` → "", `undefined`). Modules keep a two-line local wrapper pinning their defaults, so ~hundreds of call sites stayed untouched. A **tenth** copy inside `src/components/forms/SaleFields.tsx` was folded in as well; the shared select now honours per-option `disabled` (out-of-stock sale rows). |
| `src/components/shared/InventoryItemFields.tsx` | **5** duplicated "new stock item" field grids (`BlockFactoryModule`, `HardwareStoreModule`, `ElectronicsShopModule`, `RestaurantKitchenModule`, `BusinessDashboardModule`) | business wording via props (Material/Product/Item name, unit datalist or free text, restaurant's expiry date instead of a selling price), one definition of *which keys* the stock intake posts. Carries `data-testid="inv-item-fields"` so suites and the P2 guard can assert the shared grid is the one rendered. |
| `src/components/shared/CustomerQuickAddForm.tsx` | **2** copies of the quick-add customer form + POST (`BranchManagerSalesView`, `WorkerDashboard`) | same `/api/enterprise` `entityType: "customer"` payload, business-scoped, `@client.gh` e-mail fallback, reset-on-success; `custq-*` / `wd-custq-*` test-ids. The rich Customers & CRM form is unchanged and stays canonical. |

`src/components/forms/SaleFields.tsx` (the existing shared sale field group) now composes the shared
field pair instead of carrying its own copy.

## 2. Retired duplicates and added links

* **Sales & Payments → "Financial Report" tab removed.** It was the third entry point to the same
  `FinancialReportSection`; the report lives in Finance & Reports, once, for both scopes. A comment
  in place of the old block records why.
* **Deep links instead of a second CRM.** The Customers sub-tab keeps the unit-scoped list and the
  quick-add form, and (for users who may actually open the module — `isExecutive ||
  businessManageIds > 0`) shows **"Full Customers & CRM →"**; the Inventory sub-tab shows
  **"Inventory & Stock →"**. Both route through the app's real tab switch (`onNavigate` →
  `setActiveTab`) and were verified to land on those modules, so the shortcut can never drop a user
  on the "Access Restricted" screen.

## 3. Numbers

* 13 files changed, **+143 / −390** lines in the phase commit (net −247), plus 3 new shared
  components and 1 new suite.
* Duplicated implementations removed: 10 field pairs → 1, 5 item grids → 1, 2 quick-add customer
  forms → 1.
* `verify-responsive-modals`: **140 modals opened and audited, zero issues** (the reworked item
  modals included) — desktop, tablet and mobile widths.

## 4. Verification

`dev-tooling/verify-shared-ui.mjs` (new, self-purging `TEST-SUI` rows) — **30 passed, 0 failed**:

* **A. Sales & Payments** — the *Financial Report* tab is gone while New Sale / Credit / Invoices /
  Quotations / Payments / Receipts / Returns / Customers / Inventory remain; the Customers sub-tab
  renders the shared quick-add (`custq-*`); a customer created through it persists to the database,
  is tenant-bound (`business_id` set) and keeps the RETAIL + phone payload contract; the
  "Full Customers & CRM" shortcut opens the real module and the "Inventory & Stock" shortcut opens
  the real inventory table.
* **B. Module item forms** — hardware, electronics, restaurant, block factory all render the shared
  grid; hardware keeps its `hwf-*` ids and creates a row with quantity 7, cost 10, price 14.50 and
  the taxonomy-normalised category (`Building Materials` / `Cement & Mortar`); the restaurant form
  keeps its expiry-date field and hides the retail selling price.
* **C. Anti-duplication guard** — exactly one item-grid definition and one quick-add implementation
  exist in the source tree; all five module item forms import the shared grid; all nine modules route
  through the shared field pair. This is the regression net against re-inlining the forms.
* **D. Hygiene** — no page errors during the run.

Regression suites re-run green after P2: manager-ui 7/0 · credit-sales 39/39 · customer-ui 12/0 ·
customer-360 40/40 · inventory-ui 12/0 · inventory-permissions 37/0 · expense-ui 39/0 ·
expense-ui-manage 22/0 · expense-permissions 45/0 · bm-dashboard-access 19/0 · low-stock 15/15 ·
responsive-modals 140 modals clean · input-focus-appwide 0 fail · block-mixing 75/0 · telecom 63/63 ·
boutique-ui 40/40 · permissions-storefront 48/0 · single-writer (P1) 35/0.

## 5. Deliberately not changed

* **Domain dashboards stay domain dashboards** (audit §4): poultry flock/feed/health, aquaculture
  ponds/water/benchmarks, block mixing & QC, car-wash queue, telecom float/lines/vouchers, transport
  fleet/GPS, boutique size × colour. They read the shared data; they are not duplicates.
* **Expenses** — audit §3.4 already proved every module posts through `ExpenseEntryForm` →
  `/api/transactions`/`postOrGateExpenseTransaction`. The only residue is cosmetic modal-title
  wording; no consolidation was performed because none is required.
* **The canonical Customers & CRM form** (business selector, client type, address, notes) is richer
  than the field quick-add and is the surface the deep links open; it was left untouched.
* **Module read-only stock/customer tabs** were kept in place (scoped, read-through) rather than
  replaced wholesale — full management now routes to the canonical modules via the new links, and
  the five *create* surfaces share one implementation.

## 6. Follow-ups handed to P3

* Grid/showcase views for the canonical modules (audit §6.3) — not part of the P2 acceptance list.
* `SpecializedBusinessView` and the legacy checklist tables / dead helpers (P3 retire list).
* Module order & purchase tables: decide whether the shared tracking/procurement console should own
  them outright.
