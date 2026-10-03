# Re-Audit — Business Dashboards & Shared Modules

**Scope:** all business dashboards (11 vertical modules + generic BusinessDashboard) and every shared module
(Sales & Payments, Inventory/Stock, Expenses, Assets, Customers, Suppliers, Employees/Payroll, Reports &
Finance, Checklists/Tasks, Procurement/Orders, Exports, AI surfaces) across GoMina 360.

**Method:** read-only static audit — 3 grep/line-trace sweeps over the current branch tip; every claim below
carries a `file:line` anchor. No files were modified, nothing was committed. This document is a **decision
input only**: no consolidation is implemented until the strategy in §5–§6 is approved.

**Baseline:** builds on `docs/FEATURE-OVERLAP-AUDIT.md` (F1–F11) and the delivered phases
`PHASE1-DATA-CONSISTENCY.md`, `PHASE2-UI-CONSOLIDATION.md`, `PHASE3-RETIRE-LEGACY.md`. Work already landed
by those phases is listed in §7 so it is not re-opened.

Severity: **H** = data correctness / whole-tenant risk · **M** = duplicated logic or divergent behaviour ·
**L** = hygiene / consistency.

---

## 1. Executive Summary

The P1–P3 work closed the *worst* duplication (one sale writer for goods, one customer matcher for module
sales, one checklist engine, one finance report component, three unified form families). This re-audit finds
the remaining duplication is **narrow but real**, and concentrated in five places:

| # | Issue | Sev | Why it matters |
|---|-------|-----|----------------|
| 1 | **20 raw `inventoryItems.quantity` writes** across API routes/lib bypass `src/lib/stock.ts` | H | Stock accuracy, low-stock status and any future movement history are computed in ≥6 different ways |
| 2 | **Ledger is still written by 7 non-`postSale` paths** (transport, telecom, car-wash, payroll, preorder, tracking, credit instalments) | H/M | Receipt numbering, customer spend accrual and tracking registration are re-implemented; approval gate skipped by payroll |
| 3 | **Transport is the last checklist outlier** — reads shared `checklistTemplates` but stores completions in its own `transport_vehicle_checklists`, never mounts `DailyChecklistPanel` | H/M | Transport custom-task compliance never reaches the shared engine/reporting |
| 4 | **Second customer matcher in `src/lib/trackingServer.ts:176-220`** — re-implements org-scoped find-or-create + loyalty, and scans the **entire `customers` table** per order | H | Double spend accrual risk on preorder/online flows; unbounded scan is a scaling bug |
| 5 | **Transport → Assets mirror is create-only, one-way** (`transport/route.ts:382`, nothing else syncs) | M | Stale asset rows; maintenance never reaches the Assets module |

Everything else is cohesion debt rather than divergence: two entry points to the same orders (PreordersHub ↔
CustomerTrackingPanel), module STOCK/PURCHASE tabs beside the enterprise INVENTORY/Procurement surfaces,
Transport's bespoke REPORTS tab, the legacy `/api/logs/[businessCode]` shim, and `SpecializedBusinessView`
(1 137 lines with a single live consumer).

**Headline recommendation:** do **not** merge dashboards or domain cores. Consolidate on the *writer/source of
truth* layer (stock, ledger, customer, checklist, assets), and convert every remaining overlap into a
**deep link or filtered view** of the shared surface. Six modules can be finished with small, low-risk
changes; the stock and ledger migrations are the only medium-effort items.

---

## 2. Dashboard Inventory (what exists today)

11 vertical modules + 1 generic fallback. Tab labels are verbatim.

| Module | Tabs (verbatim) | Overlap verdict |
|---|---|---|
| PoultryFarm | Dash · Flock&Batch · Feed · Feed Mill · Water · Health&Vaccination · Production · Inventory · Finance&Reports · Daily Checklist · AI Knowledge | Domain core ✔ — `Inventory`/`Finance&Reports`/`Daily Checklist` are shared mounts |
| Aquaculture | Dash · Fish Stock&Batches · Ponds/Tanks · Feed Mgmt · Feed Mill · Water Quality · Tasks · Harvest Status · Finance&Reports | Same ✔; no shared checklist tab (Tasks pane instead) |
| BlockFactory | Dash · Inventory · Mixing · Finance&Reports · Quality Control · Daily Checklist | Same ✔; mixing/QC are domain |
| Livestock | Overview · Herd&Grazing · Finance&Reports · Daily Checklist | Herd tab is the **only consumer** of `SpecializedBusinessView` |
| RestaurantKitchen | Dash · Menu Performance · Stock,Cost&Waste · Sales&Orders · Purchases&Suppliers · Finance&Reports · Staff&Checklist | `Purchases&Suppliers` overlaps ProcurementPanel — currently module-native |
| HardwareStore | Dash · Stock&Materials · Orders&Purchases · Site Deliveries · Finance&Reports · Staff&Yard Ops · Daily Checklist | `Orders&Purchases`: sales fulfil via `postSale`, purchases via `linkSupplier` (P1) ✔ |
| ElectronicsShop | Dash · Products&Stock · Orders&Purchases · Finance&Reports · Warranty&Serials · Staff&Ops · Daily Checklist | Same ✔ |
| CarWash | Dash · Services&Pricing · Bookings · Active Washes · Stock&Supplies · Staff · Finance&Reports · Daily Checklist | Mounts shared checklist ✔; revenue is its own ledger writer (see RA-02) |
| TelecomServices | Dash · MoMo&Float · Airtime&Data · Wi-Fi&Vouchers · Sales · Finance · Customers · Reports · Daily Checklist | Mounts shared checklist ✔; `Finance` read-only; `Reports` = `FinancialReportSection`; **own ledger writer** |
| Transport | Dash · Fleet · Drivers · Trips&Routes · Bookings · Fuel · Maintenance · Live GPS · GPS Trackers · Safety&Alerts · Daily Checklist · Reports&AI | **Two outliers**: bespoke `Reports&AI` (no shared finance component) and its own checklist store |
| Boutique | Dash · Sizes&Stock · Sales · Customer Orders · Finance&Reports · Customers&Suppliers · Daily Checklist | Clean; `Customers&Suppliers` tab duplicates CRM/Procurement entries |
| BusinessDashboard (generic) | Dash · Inventory · Finance · Daily Checklist | `Inventory`/`Finance` fully duplicate the enterprise INVENTORY/FINANCE surfaces |

Shared-component mount map (exact counts, current tip):

| Component | Mounts | Where |
|---|---|---|
| `FinancialReportSection` | 14 | all modules except **Transport**, + `EnterpriseFinanceView`, `CommandCenterDashboard`, `SpecializedBusinessView` |
| `ExpenseEntryForm` | 12 | all modules, some via `BusinessDashboardModule` expense presets |
| `DailyChecklistPanel` | 12 | all modules except **Transport**, + `SpecializedBusinessView` |
| `InventoryItemFields` / `SaleFields` | 5 | Block, BusinessDashboard, Electronics, Hardware, Restaurant |
| `ProcurementPanel` | 2 | `CustomerTrackingPanel`, `PreordersHubView` |
| `AssetRegistrationModal`, `PayrollCenter` | 1 each | only inside `SharedEnterpriseModule` |
| `UniversalExportCenter`, `SharedEnterpriseModule`, `AttendanceClock` | 1 each | `GoMinaApp`, `Navbar` |

---

## 3. Domain-by-Domain Findings

### 3.1 Sales & Payments

**Good:** `/api/sales` → `postSale()` (`src/lib/salePosting.ts:75-79`) is the canonical goods-sale writer;
hardware/electronics/restaurant fulfilments route through it (P1); credit-sales' `linkCustomer`
(`credit-sales/route.ts:171`) correctly *delegates* to `linkOrCreateCustomer` — not a duplicate.

**Remaining:** the ledger is still written directly by 7 paths:

| Path | Anchor | Nature | Disposition |
|---|---|---|---|
| Car-wash revenue | `api/carwash/route.ts:442` (`bookTransaction`) | own service sale | route through shared service-sale wrapper |
| Telecom sales / commission / float cost | `api/telecom/route.ts:289,292,294,449,463` | own service sales | keep domain pricing, share posting |
| Transport booking / revenue / fuel / maintenance | `api/transport/route.ts:577,655,694,744` | own service sales + expense | share posting |
| Credit-sales instalment | `api/credit-sales/route.ts:222` (`postInstallment`) | payment against receivable — legitimate distinct writer | keep, but share receipt numbering |
| Payroll payout | `api/payroll/route.ts:465` | expense | keep, **add approval gate** path |
| Preorder deposit/balance | `src/lib/preorder.ts:235` | deposit + sale | share posting |
| Online order sale | `src/lib/trackingServer.ts:250` | storefront sale | share posting |

Document numbering is triplicated: `RCP-{year}-{6 digits}` in `salePosting.ts:264` and `credit-sales:247`
(both with `Math.random` collision patches), `INV-…` hand-built at `credit-sales:660`, while a correct
prefix+sequence generator already exists at `api/sales-documents/route.ts:173`.

Payment-method vocabularies diverge in three places: `forms/SaleFields.tsx:80`
(`CASH, MTN_MOMO, TELECEL_CASH, BANK_TRANSFER, POS_CARD`), `TelecomServicesModule.tsx:83` (adds
`AT_MONEY, CARD`), `TransportModule.tsx:78` (`… CHEQUE`), plus the expense form's own list.

### 3.2 Inventory & Stock

`src/lib/stock.ts` exposes only 4 exports (`stockIn`, `stockOut` + helpers) and has **22 callers**, but
**20 raw quantity writes** exist outside it, each re-deriving status:

`block-factory:432/694/1034`, `branch-unit:72`, `carwash:119`, `credit-sales:632`, `electronics:35/339`,
`hardware:123/324`, `restaurant:39/232`, `sales:225`, `transport:765`, `lib/approvals:359`,
`lib/boutique:112/230`, `lib/preorder:449`, `lib/trackingServer:134/159`.

There is **no stock-movement/audit table** in the schema — so "why did stock change?" cannot be answered,
and every writer is a potential divergence point. Module STOCK tabs are genuinely domain-specific
(batches, pond stock, sizes, waste) and should stay; but their item CRUD should go through
`InventoryItemFields` + `/api/enterprise` (P2 did the fields; the writers above still bypass status logic).

### 3.3 Expenses

`ExpenseEntryForm` is mounted in 12 components, and BusinessDashboard's Fuel/Payroll/Rent/… preset buttons
all open the same form (`TABS:369`, form `:716`, presets `:725`) — good. Residual gaps: `branch-unit`
`EXPENSE`/`RESTOCK` (`api/branch-unit/route.ts:106,50`) writes its own way (RESTOCK also writes
`inventoryItems.quantity` at `:72` = RA-05), and payroll bypasses the `/api/transactions` approval gate.

### 3.4 Assets

Only 3 writers touch `assets`: `api/assets/route.ts`, `api/enterprise/route.ts` (shared master),
`api/transport/route.ts`. The Transport mirror inserts on vehicle create (`:382`) and **never** syncs
vehicle update (`:422`), status (`:406`), trips (`:512`), odometer (`:693`) or maintenance (`:737`), and
there is no `delete(assets)` sync. `AssetRegistrationModal` is reachable only through
`SharedEnterpriseModule.tsx:3803` — a good single entry point.

### 3.5 Customers / CRM / Orders

`linkOrCreateCustomer` has 8 API callers (block-factory, carwash, credit-sales, electronics, hardware,
restaurant, telecom, transport) — the P1 matcher is the standard. **But** `src/lib/trackingServer.ts:176-220`
implements a *second* matcher (`linkCustomer`): org-scoped find-or-create, loyalty accrual
(`Math.floor(spend/100)`), and — critically — `db.select().from(customers)` with **no business filter** on a
per-order path. It is the customer path for preorders/online orders, so the same customer can accrue spend
through `postSale` *and* here.

Customer entry points: enterprise CUSTOMERS module, `CustomerQuickAddForm` (BranchManagerSalesView,
WorkerDashboard), and `ct-new-customer` in `CustomerTrackingPanel.tsx:1444` ("New Customer Order &
Tracking") — all three write via `/api/enterprise`, so this is a *linking*, not merging, problem.
No module order table links to `customerTrackings` (no `trackingCode` columns anywhere in the 11 modules) —
fulfilment flows through `/api/fulfillment` → `postSale({tracking})`.

Orders: `CustomerTrackingPanel` and `PreordersHubView` both expose ORDERS/PREORDER/PROCUREMENT and both
mount `ProcurementPanel` (`CustomerTrackingPanel.tsx:979`, `PreordersHubView.tsx:76`) — two front doors to
one object graph.

### 3.6 Suppliers & Purchasing

Module purchases now call `linkSupplier` (6 callers) and stamp `supplierId` (P1) ✔. Overlap that remains:
the enterprise SUPPLIERS master shows `totalSuppliedGhs` (`SharedEnterpriseModule.tsx:2128`) but has **no
purchase-order/invoice drill-down**, and module "Orders & Purchases" tabs (Hardware, Electronics,
Restaurant, Boutique) are separate surfaces from `ProcurementPanel`/`/api/procurement`.

### 3.7 Employees & Payroll

Full create/edit path: `EmployeeCenter.tsx` (POST `:219` → `/api/employees`, PATCH `:505`, DELETE `:516`),
rendered from `SharedEnterpriseModule.tsx:1578` → `:3851`. A **second lightweight create** exists:
`api/enterprise/route.ts:656-711` (`entityType:"employee"`, writes `employeeHistory:699`), reachable from
the QR-scan flow (`SharedEnterpriseModule.tsx:240` → generic builder `:1078`). `PayrollCenter` is mounted
only for the EMPLOYEES module (`:3841`) and owns attendance review (`PayrollCenter.tsx:796`), while
`AttendanceClock` sits in `Navbar.tsx:201` — appropriate split.

### 3.8 Reports & Finance

`FinancialReportSection` is one component with two scopes (business-locked in modules, enterprise in
`EnterpriseFinanceView`) = the P2 goal met. Exceptions: **Transport** keeps a bespoke `Reports&AI` tab, and
`SpecializedBusinessView` (1 137 lines, one live consumer) still mounts it. Exports are already
centralised: `UniversalExportCenter` (single global entry, `GoMinaApp.tsx:1826`) plus
`lib/universalExport|inventoryDownload|assetDownload`; only `AuditCommandCenter`/`PayrollCenter`/
the two BenchmarkPanels do local CSV via the shared `csvSafeCell` helper — acceptable.

### 3.9 Checklists & Tasks

One engine (`checklistEntries`/`checklistTemplates`, `/api/checklists`) with 3 legacy tables retired in P3.
**Transport is the sole outlier:** it reads shared `checklistTemplates` via `api/transport/route.ts:245`
(response `:309-310`), but writes completions to `transport_vehicle_checklists`
(`route.ts:~967`) inside a 12-check mechanical pre-trip form, never touches `checklistEntries`, and does not
mount `DailyChecklistPanel`. CarWash (`:803`) and Telecom (`:703`) correctly mount the shared panel.
Aquaculture has no checklist tab (Tasks pane) — intentional.

### 3.10 Other shared surfaces

- Legacy `/api/logs/[businessCode]` still re-serves WASH revenue (`:304`), Hardware GRN (`:374`) and
  `linkSupplier` (`:430`) for 5 component callers (Electronics `:101/:332`, Hardware `:101/:336`,
  `SpecializedBusinessView:210`, Restaurant `:94/:278`, `GoMinaApp:688`).
- `SpecializedBusinessView` (1 137 lines) → only `LivestockModule.tsx:305`.
- `GoMinaApp.tsx` hosts 6 global features (AI advisor/console/BI assistant/scenario planner/document vault/
  export centre) while `AiSectionGuide` is mounted in 23 components — a monolith hotspot, not a duplicate.
- Poultry vs Aqua share `AdvisorNotesPanel` ✔ but maintain parallel benchmark/growth panels
  (`PoultryBenchmark*` vs `FishBenchmark*`).

---

## 4. Consolidated Issue Register

Disposition: **MERGE** into shared implementation · **LINK** (deep link / filtered view, keep surface) ·
**RETIRE** · **KEEP** (intentional domain split). Effort: S ≤ half day, M ≤ 2 days, L > 2 days.

| ID | Issue | Sev | Disposition | Effort |
|---|---|---|---|---|
| RA-01 | 20 raw `inventoryItems.quantity` writers bypass `lib/stock` (no movement trail) | H | MERGE → one `applyStockChange()` (extend `stock.ts`), migrate writers | L |
| RA-02 | 7 ledger writers outside `postSale` (transport/telecom/carwash/payroll/preorder/tracking/instalment) | H | MERGE shared parts: a `postServiceSale()`/`postExpense()` pair over `salePosting`; keep domain pricing | M–L |
| RA-03 | Second customer matcher `trackingServer.ts:176-220`, unbounded `customers` scan, double spend accrual | H | MERGE → `linkOrCreateCustomer`; add `(businessId, phone)`/`(name)` indexes | S–M |
| RA-04 | Transport reads shared `checklistTemplates` but stores completions privately; no shared panel | H/M | MERGE completions into `checklistEntries` + mount `DailyChecklistPanel`; keep 12-check pre-trip form as a module-specific **template** | M |
| RA-05 | Transport→Assets mirror create-only/one-way | M | LINK: replace mirror with `assetId` reference + "Open in Assets →"; or make bidirectional via one helper | M |
| RA-06 | Payroll expense skips `/api/transactions` approval gate | M | MERGE → shared `postExpense({requireApproval:true})` | S |
| RA-07 | Duplicate document numbering (`RCP` ×2 with random collision patches, `INV` hand-built) | M | MERGE → `sales-documents` sequence generator | S |
| RA-08 | Divergent payment-method vocabularies (3 lists + expense form) | L | MERGE → `lib/paymentMethods.ts`; per-domain allowlist from one superset | S |
| RA-09 | Module FINANCE tab vs enterprise FINANCE tab = same component, two scopes in one workspace | M | LINK/decide: keep module view, add cross-link, or drop module tab when enterprise tab exists | S |
| RA-10 | BusinessDashboard generic `Inventory`/`Finance` tabs fully duplicate enterprise surfaces | M | LINK → replace bodies with deep links (pattern already used by P2 Sales&Payments) | S |
| RA-11 | `PreordersHubView` ↔ `CustomerTrackingPanel` both mount ProcurementPanel + same hubs | M | LINK: one becomes a filtered view/entry point of the other | S–M |
| RA-12 | Module "Orders&Purchases"/"Purchases&Suppliers" tabs vs ProcurementPanel/`/api/procurement` | M | LINK: keep module tab, add "Open in Procurement →" + shared supplier picker | M |
| RA-13 | Supplier master has no purchase-order/invoice drill-down (`totalSuppliedGhs` only) | M | LINK: supplier drawer pulls `/api/procurement` + module purchases by `supplierId` | M |
| RA-14 | Second employee-create path via `/api/enterprise` QR flow, divergent fields/history | M | MERGE: QR modal delegates to `POST /api/employees` (or shared create helper) | S–M |
| RA-15 | Transport bespoke `Reports&AI` (only module without `FinancialReportSection`) | M | MERGE: shared component with transport metric props; keep GPS/telemetry panels | M |
| RA-16 | `SpecializedBusinessView` 1 137 lines, 1 live consumer (Livestock HERD) | L | RETIRE into `LivestockModule`/shared panels | M |
| RA-17 | Legacy `/api/logs/[businessCode]` duplicates WASH revenue + Hardware GRN + `linkSupplier` | L | RETIRE: migrate 5 callers to module APIs, delete route | M |
| RA-18 | Module STOCK tabs vs enterprise INVENTORY (item CRUD duplicated) | M | KEEP tabs (domain) + LINK + finish `InventoryItemFields`/`/api/enterprise` writer unification (ties to RA-01) | M |
| RA-19 | Poultry/Aqua parallel benchmark & growth panels | L | MERGE shell only (`SpeciesBenchmarkPanel`), keep domain data | M |
| RA-20 | `/api/branch-unit` RESTOCK/EXPENSE legacy paths | L | MERGE into `stock.ts` + `postExpense` (subsumed by RA-01/RA-06) | S |
| RA-21 | Missing indexes on `customers(phone)/(name)`; unbounded scans | M | Add indexes + `businessId` filters (pairs with RA-03) | S |

**Do not merge (KEEP):** poultry flock/feed/water/health/AI-knowledge · aquaculture ponds/water
quality/harvest · block mixing/QC · livestock herd & grazing · restaurant menu performance/waste ·
hardware site deliveries · electronics warranty/serials · car-wash bays/active washes · telecom MoMo float/
airtime/Wi-Fi vouchers · transport fleet/trips/GPS/geofences/violations/pre-trip inspection · boutique
sizes/customer orders · all module KPI headers. These are the product's differentiation and are already
correctly isolated.

---

## 5. Recommended Consolidation Strategy

**Principle:** one *writer* per data family, many *surfaces*; overlap is resolved by links, not by merging
dashboards.

1. **Shared source-of-truth writers (the only real merges).**
   `lib/stock.ts` (stock + optional movement log) · `lib/salePosting.ts` (`postSale`, add
   `postServiceSale`) · `lib/customerLink.ts` (the only customer matcher) · `lib/supplierLink` (already
   used) · `lib/expensePosting.ts` (new thin wrapper: ledger + approval gate) · `/api/employees` (only
   employee create) · `/api/enterprise` (assets/inventory master) · `checklistEntries` (all checklist
   completions) · `sales-documents` numbering.
2. **Link-don't-duplicate for every module tab that re-renders an enterprise surface**
   (`Stock`, `Orders&Purchases`, `Customers`, module `Finance`, BusinessDashboard `Inventory/Finance`,
   PreordersHub). Use the P2 deep-link pattern.
3. **Retire dead weight** (`SpecializedBusinessView`, `/api/logs/[businessCode]`, the transport asset
   mirror-as-copy, transport checklist store).
4. **Keep every domain operation core untouched** (see KEEP list) and preserve existing data,
   permissions, tenant isolation and tests throughout.

### Proposed phases (for approval)

| Phase | Content | Effort | Risk | Extra test suites to reuse |
|---|---|---|---|---|
| **P4 — correctness writers** | RA-03 (+21), RA-06, RA-07, RA-14, RA-20 | S–M | Low | `verify-single-writer`, `verify-procurement-chain` |
| **P5 — stock unification** | RA-01/RA-18 writer migration, optional `stock_movements` log, RA-02 `postServiceSale`/`postExpense` split | L | Medium (many call sites) | `verify-single-writer`, `verify-transport`, `verify-feed-mill`, `verify-fish-feed-mill`, `verify-clean-state` |
| **P6 — surfaces & retirement** | RA-09/10/11/12/13/15/16/17, RA-04 checklists, RA-19 shell | M–L | Medium | `verify-shared-ui`, `verify-transport`, `verify-responsive-modals`, `verify-clean-state` |

Each phase would follow the established protocol: implement → run the existing suite set plus targeted new
checks → post a per-phase results report → auto-continue when green → finish with a system-wide
verification and a final implementation & test report (commit **and** push each phase).

---

## 6. Decisions Requested (before any implementation)

1. **Module FINANCE tabs vs enterprise FINANCE (RA-09/RA-10):** keep both with a cross-link, or make the
   module tab a *filtered view of the same component instance* so there is literally one finance surface?
2. **Orders front doors (RA-11):** make `PreordersHubView` the single hub and turn
   `CustomerTrackingPanel`'s order tabs into deep links, or the reverse?
3. **Transport ↔ Assets (RA-05):** reference-only link (recommended) or keep a mirror and make it fully
   bidirectional?
4. **Stock movement history (RA-01):** is an explicit `stock_movements` audit table wanted (recommended —
   it makes every future stock question answerable), or is a single shared writer without a log enough for
   now?

---

## 7. Already Consolidation-Completed (do not re-open)

| Family | Now single source |
|---|---|
| Goods sales → ledger | `postSale` (`lib/salePosting.ts`); hardware/electronics/restaurant fulfil via it |
| Customer match for module sales | `linkOrCreateCustomer` (8 API callers) |
| Supplier accrual on module purchases | `linkSupplier` + `supplierId` (6 callers) |
| Checklists | `checklistEntries`/`checklistTemplates`; 3 legacy tables retired (P3) |
| Item/sale/customer form fields | `InventoryItemFields`, `SaleFields`, `ModuleFormFields`, `CustomerQuickAddForm` |
| Finance report rendering | `FinancialReportSection` (14 mounts, business-locked + enterprise scope) |
| Sales & Payments report tab | removed; deep links into Customers & CRM / Inventory & Stock (P2) |
| Exports | `UniversalExportCenter` + shared download libs |
| Assets/employees/payroll UI | `AssetRegistrationModal`, `EmployeeRegistration`/`EmployeeProfile`, `PayrollCenter` — single mounts |

**Known deferred minors (unchanged):** preset `!preset.thumb` guard · `EmployeeCenter.pickPhoto` size guard ·
`/api/init` `photoThumb || photo` echo-back · 2 RESTOCK 2-column grids · expense-button wording.

---

*Report only — no code has been changed, no commit has been made. Awaiting approval of §5–§6 before
implementing; on approval I will proceed phase by phase (P4 → P5 → P6) with per-phase test results and a
final implementation & test report.*
