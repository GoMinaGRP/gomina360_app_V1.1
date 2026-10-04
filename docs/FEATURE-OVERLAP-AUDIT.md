# GoMina 360 — Feature Overlap & Duplication Audit

**Status: report only — no code has been changed. Awaiting approval before implementation.**
Date: 2026-10-02 · Scope: all 11 business dashboards + generic dashboard, the 12 shared enterprise
module destinations in the sidebar, and the APIs/tables behind them.

Method: static audit of every writer and reader of the shared stores (`transactions`,
`inventoryItems`, `customers`, `suppliers`, `assets`, `employees`, `customerTrackings`,
`checklists*`) plus the module-local stores, cross-checked against the UI surfaces that mount
them. Every claim below is anchored to a file (line numbers as of commit `f0a3f8c`).

---

## 1. Baseline: how the system is layered today

**Storage.** One shared core (business-scoped) — `transactions`, `inventoryItems`,
`inventoryVariants`, `customers`, `suppliers` (+ procurement tables), `assets`, `employees`,
`businessDocuments`, `customerTrackings`, `checklists*` — plus ~45 module-specific operational
tables (`poultry*`, `aquaculture*`, `carWash*`, `telecom*`, `transport*`, `block*`, `hardware*`,
`electronics*`, `restaurant*`, `livestockLogs`, `boutique` = variants).

**Engines.** Shared processors already exist and are used well in places:
`/api/sales` (validate → deduct stock → ledger → receipt → audit), `/api/transactions`
(+ `postOrGateExpenseTransaction`), `/api/enterprise` (inventory/assets/suppliers/customers/
employees CRUD), `/api/procurement` (requisitions → quotes → POs → GRN → invoice → payment),
`/api/checklists`, `/api/documents`, `/api/tracking`, `/api/credit-sales`.

**UI.** Several shared components are already mounted everywhere — this is the strongest part of
the architecture and the model to extend:

| Shared component | Mounts | What that means |
|---|---|---|
| `FinancialReportSection.tsx` | 14 components (all 11 business modules, Sales & Payments, Finance, Command Center) | one finance engine, two scope modes (`mode="business"` locked / enterprise) |
| `ExpenseEntryForm.tsx` | 13 components | one expense entry UI |
| `DailyChecklistPanel.tsx` | 12 modules | one checklist engine |
| `SaleFields.tsx` + `/api/sales` | 5 modules (+8 callers of `/api/sales`) | one sale pipeline |
| `Real` shared modules (`SharedEnterpriseModule`) | Customers, Suppliers, Employees, Assets, Inventory, Transactions | one CRUD surface each |

**Conclusion of the baseline:** the *data* layer is mostly unified. The duplication is
concentrated in (a) **navigation/entry points**, (b) **module-local order & purchase workflows**
that bypass the shared pipelines, and (c) **re-implemented stock/customer item forms** that write
to the right tables through bespoke UI.

---

## 2. Findings, ranked

| # | Finding | Severity | Affected |
|---|---|---|---|
| **F1** | Module-local order flows bypass the shared sale pipeline: revenue, stock, receipts and CRM disagree depending on which screen was used | **High** | Hardware, Electronics, Restaurant, Block Factory |
| **F2** | "Customers" is presented in 3+ places, two of them with their own add-customer form | **High** | Sales & Payments, Customers module, Telecom, Boutique, dashboards |
| **F3** | Purchases are recorded in 3 module-private tables with free-text supplier names; the shared procurement chain (requisitions → PO → GRN → invoice → payment) is only reachable from Order & Tracking / Pre-Orders | **High** | Hardware, Electronics, Restaurant (+ Block Factory intakes) |
| **F4** | Inventory & Stock: 6 separate stock screens, 5 of them re-implementing "New item"/"Receive stock" forms (all writing correctly to the shared table) | Medium | Generic, Poultry, Block Factory, Hardware, Electronics, Restaurant, Car Wash, Boutique, Aqua, Telecom |
| **F5** | Finance/Reports has three entry points running the same component (dashboard tab, Sales & Payments → Financial Report, Finance & Reports module) | Medium | All modules + shared modules |
| **F6** | Checklists: shared engine + 3 legacy module checklist tables, 2 dead code paths | Medium | Poultry, Block Factory, Aquaculture |
| **F7** | Assets ↔ Fleet is a one-way mirror (vehicle create → asset row; later vehicle edits never sync); CCTV cameras are invisible to Assets | Medium | Transport, CCTV/Integrations |
| **F8** | Retail modules are copy-paste implementations of one pattern (Hardware vs Electronics share 60% of their function identifiers) | Medium | Hardware, Electronics, Restaurant |
| **F9** | `suppliers.totalSuppliedGhs` is only accrued by block factory + feed mills (`src/lib/supplierLinks.ts`); the Suppliers module column therefore reads 0 for every supplier used through module purchases | Low-Med | Suppliers module, Hardware, Electronics, Restaurant |
| **F10** | Employee (HR) records and login accounts are unlinked (`employees` has no `userId`); "Manage Sales Persons" manages accounts, "Employees & Payroll" manages HR, module "Staff" tabs read HR — three vocabularies for "staff" | Low-Med | Employees, Users & Access, Branch Workspace, all module Staff tabs |
| **F11** | Dead/superseded code: `SpecializedBusinessView` (used only by Livestock), poultry legacy checklist helpers, unused `checklists` state in Block Factory | Low | — |

---

## 3. Function-by-function audit

Legend — **A** = true business-specific function, keep on the dashboard · **B** = duplicate of a
shared module, consolidate · **C** = better integrated with / linked to the shared module ·
**D** = unnecessary, remove/consolidate eventually.

### 3.1 Sales

| Where | What it is | Class | Recommendation |
|---|---|---|---|
| Shared **Sales & Payments** (`BranchManagerSalesView.tsx:89,800`) | POS, credit, invoices, quotations, receipts, analytics, payments, returns, plus Customers/Inventory oversight sub-tabs | canonical | keep as the one sales destination |
| `/api/sales` (`route.ts:13-29`) | validate → stock deduct → ledger → receipt → CRM → tracking code | canonical engine | keep; make it the **only** writer of sale revenue |
| Dashboard "Record Sale" forms (`SaleFields`) | same fields, same endpoint — 5 bespoke wrappers | **C** | keep the entry point, share one wrapper component |
| `hardwareOrders` / `electronicsOrders` fulfilment → inline `transactions` insert (`hardware/route.ts:363-372`, `electronics/route.ts:52-64,365`) | second sale pipeline: no receipt (`salesDocuments`), no CRM customer, no tracking row | **B** | route fulfilment through `/api/sales` (or a shared "completeSale" helper) |
| `restaurantOrders` (KDS, `restaurant/route.ts:139-162,302-305`) | order queue whose SERVED state posts **nothing** to the ledger | **B** | post the sale on payment/serve through the shared pipeline |
| `blockFactoryOrders` / `blockFactoryDeliveries` (`block-factory/route.ts:463-496`) | order/delivery records with no ledger link (sales are recorded separately via `SaleFields`) | **B/C** | link order → sale, or drop the order workflow in favour of shared tracking |
| Boutique `SALES` (`BoutiqueModule.tsx:314-360`) | variant-aware POS over `/api/sales` | **A** (variant logic) / **C** (receipts) | keep; it is the model other modules should follow |
| Telecom `SALES` / MoMo commission postings (`telecom/route.ts:304-309,464`) | telco product sales + commissions posted to the ledger | **A** | keep; consider using the shared sale processor for the receipt/CRM half |
| Car Wash wash completion (`carwash/route.ts:26-36,457`) | service sale + chemical stock-out + CRM upsert + ledger in one action | **A** | keep (documented "exactly once" discipline) |
| Transport trip fares / bookings (`transport/route.ts:590-757`) | fare → ledger, booking → shared customer | **A** | keep |

### 3.2 Payments

| Where | What it is | Class | Recommendation |
|---|---|---|---|
| Sales & Payments → Payments / Receipts / Credit (`BranchManagerSalesView.tsx:800-811`, `/api/credit-sales`, `creditPayments`) | payment capture, installments, method breakdown | canonical | keep |
| Transactions & MoMo module | ledger CRUD incl. MoMo methods | canonical | keep |
| Procurement supplier payments (`/api/procurement`) | supplier-side payments | canonical | keep |
| Telecom `MoMo & Float` (`TelecomServicesModule.tsx:35`, `telecomLines.floatGhs/cashGhs`) | float/treasury reconciliation for agent lines | **A** | keep (it is a distinct domain ledger), but expose it as a telecom *sub-ledger* under the shared finance story, not a second "Payments" |
| Car Wash / Telecom / Transport payment capture inside their flow | payment method attached to the sale | **A** | keep |

### 3.3 Inventory & Stock

| Where | What it is | Class | Recommendation |
|---|---|---|---|
| Shared **Inventory & Stock** (`SharedEnterpriseModule` moduleType `INVENTORY`) | full CRUD, low stock, downloads | canonical | keep as the only *management* surface |
| Dashboard stock tabs (Generic `BusinessDashboardModule.tsx:606-640`, Poultry `:1226-1290`, Block `:INVENTORY`, Hardware `STOCK`, Electronics `PRODUCTS`, Restaurant `STOCK`, CarWash `STOCK`, Boutique `PRODUCTS`, Aqua `STOCK`, Telecom `AIRTIME/DATA`) | scoped, read-mostly views; Poultry explicitly labelled "Linked to Shared Inventory Module" | **C** | keep as scoped *views*; replace the duplicated **create/restock forms** with one shared form component (or a deep link that opens Inventory & Stock pre-filtered to the unit) |
| Item creation writing to `/api/enterprise` from 5 modules (`BlockFactoryModule.tsx:289`, `HardwareStoreModule.tsx:316`, `ElectronicsShopModule.tsx:312`, `RestaurantKitchenModule.tsx:259`, `BusinessDashboardModule.tsx:283`) | correct table, duplicated UI | **C→B** | one shared "New inventory item" form |
| Restock/purchase intake in module routes (hardware/electronics/restaurant/block) | correct shared stock mutation + shared expense | **C** | keep behaviour; see F3 for the record layer |
| Boutique `Sizes & Stock` (`/api/boutique` `SET_VARIANTS`/`ADJUST_STOCK`) | size × colour sub-layer over `inventoryVariants` | **A** | keep — correct extension of the shared store |
| Poultry feed stock / Aqua feed & batches / Block production stock | domain sub-ledgers that materialise into shared inventory | **A** | keep |

### 3.4 Expenses

Already consistent: every module posts through `ExpenseEntryForm` → `/api/transactions` or
`postOrGateExpenseTransaction` (approval gate, audit, categories). Car Wash, Telecom, Block Factory
and the feed mills add domain context (receipt, float, intake) but land in the same ledger.
**Class A/C — no consolidation required.** Only note: the *buttons* all read "Expense" while the
modal titles differ per module ("Log Expense — Car Wash", "Record Expense — Block Factory"),
which is cosmetic.

### 3.5 Assets

| Where | What it is | Class | Recommendation |
|---|---|---|---|
| Shared **Assets & Equipment** module (`assets`, `assetAuditLogs`, `assetDownloads`) | full register with QR, transfers, audit | canonical | keep |
| Transport `FLEET` (`transportVehicles` + `assetId`) | fleet unit with GPS, fuel, compliance; mirrored into `assets` on create (`transport/route.ts:395-405`) | **A** (domain) + **C** (mirror needs rules) | keep the vehicle as the operational record; make the asset mirror **two-way or explicitly one-way+documented**, and sync on update (currently `transport/route.ts:435` does not) |
| `cctvCameras` (Integrations Hub) | cameras with no asset link | **C** | decide: project cameras into Assets (with a "Surveillance" type) or state that CCTV is out of the asset register |

### 3.6 Customers

| Where | What it is | Class | Recommendation |
|---|---|---|---|
| Shared **Customers & CRM** + `Customer360Drawer` | canonical directory, 360° view | canonical | keep |
| Sales & Payments → Customers (`BranchManagerSalesView.tsx:2344`) | **second add-customer form** + list | **B** | reuse the shared customer form (or link to the CRM with the unit filter) — this is the clearest "duplicate of an existing shared module" in the app |
| Telecom `CUSTOMERS` (`TelecomServicesModule.tsx:645-663`) | read-through list with telco columns, notes that records are shared | **C** | keep |
| Boutique `CUSTOMERS & SUPPLIERS` (`BoutiqueModule.tsx:923-960`) | read-only lists with spend | **C** | keep |
| Module order tables with only `customerName`/`customerPhone` (hardware, electronics, restaurant, block factory, telecom) | duplicate customer identities; no `customerId` | **B** | store `customerId` and reuse the existing upsert helper used by `/api/sales:282`, `/api/carwash:145`, `/api/telecom:131`, `/api/transport:149` |
| Worker Dashboard → Customer Tracking | shared tracking console (scoped) | **C** | keep |

### 3.7 Suppliers & purchasing

| Where | What it is | Class | Recommendation |
|---|---|---|---|
| Shared **Suppliers & Vendors** + `/api/procurement` (requisitions, quotes, POs, GRN, invoices, payments, performance) + `ProcurementPanel` | full supply chain | canonical | keep — and surface it from more places (only `CustomerTrackingPanel.tsx:979` and `PreordersHubView.tsx:78` mount it today) |
| `hardwarePurchases`, `electronicsPurchases`, `restaurantPurchases` (schema; routes import **no** supplier tables) | parallel purchase records with free-text `supplierName`; stock-in and expense are correct, but no supplier record, no PO/GRN, and the shared Suppliers module never sees them | **B** | in order of effort: (1) call the existing `linkSupplier` helper (`src/lib/supplierLinks.ts`) so the supplier ledger accrues; (2) later, replace the table with supplier POs + GRN carrying a module/site field |
| Block Factory + both feed mills | already use `linkSupplier` — the pattern to copy | **A** | keep |
| `suppliers.totalSuppliedGhs` shown in the shared module (`SharedEnterpriseModule.tsx:2128`) | accrues only from the 2 module paths that call `linkSupplier` | **D (bug)** | fix as part of F3 |

### 3.8 Employees, staff and payroll

| Where | What it is | Class | Recommendation |
|---|---|---|---|
| Shared **Employees & Payroll** (`EmployeeCenter`, `PayrollCenter`, attendance review, `employeeDocuments`) | canonical HR | canonical | keep |
| Module `Staff` tabs (CarWash `STAFF`, Electronics `STAFF`, Restaurant `STAFF`, Hardware `YARD_OPS`, Transport `DRIVERS` `TransportModule.tsx:686-712`) | performance/assignment boards over the shared employee list ("from Employees — assign a driver…") | **C** | keep — good example of a linked domain view |
| Branch Workspace → **Manage Sales Persons** (`BranchManagerWorkerPanel` → `/api/users/workers`) | branch-scoped slice of login-account management | **C** | keep, but align naming with Users & Access and cross-link |
| `employees` ↔ `users` | no foreign key between HR and accounts | gap | decide the intended model (recommended: optional `employees.userId`, set when an employee also gets a login) |

### 3.9 Reports, exports and Finance

| Where | What it is | Class | Recommendation |
|---|---|---|---|
| `FinancialReportSection` (business-locked) mounted in every module | same code, unit scope | **C** | keep |
| **Finance & Reports** module (`EnterpriseFinanceView` → same component, enterprise scope) | consolidated view | canonical | keep |
| Sales & Payments → **Financial Report** tab (`BranchManagerSalesView.tsx:807`) | third entry point to the same report | **B** | remove the tab, link to the two scopes |
| `FinancialReportSection` re-implemented logic? | no — one engine | — | preserve this |
| Exports: `UniversalExportCenter` (cross-module) vs module PDF/Excel helpers (`lib/inventoryDownload`, `lib/assetDownload`, sales document printer) | different jobs: enterprise export vs record/format-specific print | **C** | keep; standardise naming ("Export" vs "Print") |
| Bi Assistant / AI Advisor / Scenario Planner | separate strategic surfaces | **A** | keep |

### 3.10 Orders, tracking, checklists, documents (extras found)

| Where | What it is | Class | Recommendation |
|---|---|---|---|
| Shared **Customer Order & Tracking** + storefront `/order` | canonical order pipeline (`customerTrackings`, privacy-safe tracking codes) | canonical | keep |
| Boutique `ORDERS` (`BoutiqueModule.tsx:377`) | uses `/api/tracking` | **C** | model to copy |
| Module order tables (hardware/electronics/restaurant/block) | parallel order systems that never appear in the shared tracking console | **B** | either retire in favour of shared tracking, or make the module order the *source* that creates a `customerTrackings` row |
| `checklists*` shared engine + `DailyChecklistPanel` in 12 modules | canonical | canonical | keep |
| `poultryChecklists`, `blockFactoryChecklists`, `aquacultureChecklists` | legacy per-module checklist tables; Aqua's dashboard reads its own table (`AquacultureModule.tsx:230`) while its checklist tab uses the shared engine; Poultry has dead helpers (`PoultryFarmModule.tsx:450-465`); Block Factory has unused state (`BlockFactoryModule.tsx:68`) | **D** | migrate Aqua's dashboard to `/api/checklists`, then retire the tables and dead code |
| Document Vault (`businessDocuments`) vs `employeeDocuments` (HR) vs per-record evidence images | different lifecycles (company compliance vs personnel files vs transaction evidence) | **A/C** | keep both; optionally let the Vault show HR docs read-only per business |

---

## 4. Per-business verdict (what stays on the dashboard)

| Business type | Keep on the dashboard (A) | Consolidate/link (B/C) | Remove later (D) |
|---|---|---|---|
| **Poultry Farm** | Flock & batch, Feed, Feed Mill, Water, Health & Vaccination, Production, AI Knowledge | Inventory tab (view), Finance tab | legacy checklist helpers/table |
| **Aquaculture / Fish Farm** | Fish stock & batches, Ponds, Feed, Feed Mill, Water quality, Harvest | Inventory/stock view, Finance tab | own checklist table in dashboard |
| **Block Factory** | Mixing, QC, Production master list, Deliveries (domain) | Inventory CRUD, Orders (→ sale or tracking), Finance | unused checklist state |
| **Livestock** | Overview, Herd & grazing | Finance tab | `SpecializedBusinessView` legacy wrapper |
| **Restaurant & Food** | Menu performance, KDS/order queue, Waste | Stock & purchases (→ shared procurement), Finance | local purchase table (long-term) |
| **Electronic Shop** | Warranty & serials, Products | Stock & orders/purchases (→ shared sale/procurement), Finance | local order/purchase tables (long-term) |
| **Car Wash** | Services & pricing, Bookings, Active washes, Staff performance | Stock & supplies, Finance | — |
| **Hardware Store** | Site deliveries, Yard ops | Stock & orders/purchases (→ shared sale/procurement), Finance | local order/purchase/delivery tables (long-term) |
| **Telecom & Digital** | MoMo & float, Airtime & data, Wi-Fi vouchers, Sales | Customers (view), Finance | — |
| **Transportation** | Fleet, Drivers, Trips, Bookings, Fuel, Maintenance, GPS, Trackers, Compliance | Assets mirror rules, Finance | — |
| **Boutique** | Sizes × colours (variants), POS, Customer orders (shared tracking) | Customers/Suppliers (views), Finance | — |
| **Generic (any category)** | Ops log, Checklist, Dashboard KPIs | Inventory (view+shared form), Finance, Customer/asset recap | bespoke item form |

---

## 5. Proposed consolidation strategy (for approval)

**Principle:** *one canonical module per function; a dashboard keeps only domain-specific
operations plus scoped, read-only views and deep links into the shared module.*

1. **One writer per fact.** Sales revenue, stock movements, expenses, customer identity and
   purchase records each get exactly one write path (the shared engines). Module routes may
   *orchestrate* (create the domain record, then call the shared processor) but must not insert
   shared facts themselves.
2. **Scoped views, not copies.** Where a dashboard already shows shared data (stock, customers,
   staff, finance), keep the view but pass the same shared component with a locked business scope —
   the `FinancialReportSection mode="business"` pattern the app already uses.
3. **Deep links over re-implementation.** Replace the 5 duplicated inventory-item forms and the
   Sales & Payments add-customer form with: *one shared form component* + a link that opens the
   shared module pre-filtered to the unit.
4. **Domain records reference shared records.** Add `customerId` to module order tables,
   `supplierId` to module purchases, and reuse `linkSupplier`; keep the domain columns.
5. **Navigation stays role-based** but removes the third copy of each destination
   (e.g. drop Sales & Payments → Financial Report; rename dashboard "Finance" to
   "Finance & Reports — this unit" so scope is obvious).

### Phased plan

| Phase | Work | Risk | Verification |
|---|---|---|---|
| **P1 — data consistency (no UI change)** | Restaurant/Block Factory order fulfilment posts the shared sale; hardware/electronics fulfilment stops hand-rolling `transactions` and calls the shared processor; module purchases call `linkSupplier`; customer upsert reused for module orders | Medium — money paths | existing `verify-credit-sales`, `verify-finance-allproducts-fresh`, `verify-procurement-chain`, `verify-hardware-audit`, `verify-telecom`, `verify-transport`, `verify-block-*`, `verify-boutique`; add "single writer" assertions |
| **P2 — UI consolidation** | One shared inventory-item/restock form; one shared customer form; Sales & Payments FIN_REPORT tab removed; dashboard stock/customer tabs re-mounted as scoped shared views | Low-Med — presentation only | `verify-inventory-ui`, `verify-customer-ui`, `verify-finance-*`, `verify-responsive` + `verify-responsive-deep` (286 views) |
| **P3 — retire legacy** | Aqua dashboard → shared checklists; drop `poultryChecklists`/`blockFactoryChecklists`/`aquacultureChecklists` + dead helpers; remove `SpecializedBusinessView`; decide module order/purchase tables' fate | Low — after P1 | full suite sweep + `verify-image-optimization` |

Each phase: `npx tsc --noEmit`, `npm run build`, run the named suites, keep tenant-isolation and
permission suites green (`verify-permissions-storefront`, `verify-inventory-permissions`,
`verify-expense-permissions`, `verify-audit-access`, `preorder-multitenant`).

### Explicitly NOT to be consolidated (genuinely business-specific)

Poultry flock/feed/health/production; aquaculture ponds/water/harvest/benchmarks; block mixing &
QC; car-wash services, bookings, wash queue; telecom float, lines, vouchers, Wi-Fi packages;
transport vehicles, trips, GPS, geofences, maintenance; boutique size × colour variants;
restaurant menu & kitchen display; livestock herd & grazing; every domain analytics view. These are
the reason a business-specific dashboard exists — they should stay, reading shared data.

---

## 6. Decisions requested

1. **Module order workflows** — (a) link the domain order to a shared sale (recommended), (b) let the
   shared tracking console own orders and retire the module tables, or (c) leave as-is?
2. **Purchases** — adopt the shared procurement chain for Hardware/Electronics/Restaurant now
   (bigger change) or first only adopt `linkSupplier` so the supplier ledger stops being blind
   (small, safe, recommended first step)?
3. **Sales & Payments extra tabs** — OK to remove the `Financial Report` tab and turn its
   `Customers`/`Inventory` sub-tabs into links to the real modules?
4. **Inventory create forms** — OK to replace the 5 dashboard "New item/Receive stock" forms with one
   shared form (keeping the buttons where they are)?
5. **Employees ↔ user accounts** — should an employee optionally link to a login account
   (`employees.userId`), or stay two deliberately separate registers?
6. **CCTV cameras** — register as assets, or keep out of the asset register?
7. **Phasing** — approve P1 → P2 → P3 in order (recommended), or a subset?

Reply with the decision numbers/choices and I will implement phase by phase, with tests, commits and
a results report per phase.
