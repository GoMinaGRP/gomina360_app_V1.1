# Feed Production Integration — Poultry Feed Mill
## Assessment & Recommended Architecture (recommendation-only; NO implementation yet)

**Reviewer:** Arena Agent · **Date:** 2026-09-19 · **Branch:** `arena/01a0a375-gomina360-app-v1-1` @ `a2a5d68`
**Preview:** GoMina 360 live on the tracked server (port 3000) — code inspected and module exercised in-browser.

---

## 1. Executive summary

**Recommendation: build "Feed Production & Milling" as a first-class sub-module of the existing Poultry Farm module** (new **Feed Mill** tab + `/api/poultry/feed-mill` API with 5 new tables), engineered so that **every piece of state the enterprise already owns stays in the shared systems** — raw materials and finished feed are ordinary `inventory_items` rows, money moves only through `transactions`, purchases reuse Suppliers (+ optionally the procurement pipeline), consumption reuses `poultry_feed_logs` so the intact FCR engine keeps working, and mill alerts reuse the notification bell/push channels.

What must be **new**: formulations (recipes), production batches with ingredient-draw line items and derived cost/kg, per-batch QC (modelled directly on `block_qc_checks`), and the mill UI. What must **never be duplicated**: stock, money, supplier, customer, employee, checklist, audit, export and alert plumbing.

Estimated effort: **~6.5–9 dev-days** over 3 additive phases (P1 movable-feast MVP → P2 QC/alerts/analytics → P3 polish), with a new self-cleaning verification suite and full regression re-runs at every phase. All changes are additive — nothing existing is rewritten, migrated destructively, or removed.

**Decision needed from you before build:** (a) approve poultry-unit placement vs a standalone "Feed Mill" business unit; (b) dual-booking rule (ingredient expense booked at purchase; batch cost derived — recommended); (c) hard QC gate (batch hold until pass; owner override) vs advisory-only.

---

## 2. Current-state assessment (what exists today, verified live)

### 2.1 Module structure
The **Poultry Farm Management** module (`src/components/PoultryFarmModule.tsx`, 1,591 lines; `src/app/api/poultry/route.ts`, one route with an `entity` switch) runs **10 tabs**: Dashboard · Flock & Batch · **Feed** · Water · Health & Vaccination · Production · Inventory · Finance · Daily Checklist · AI Knowledge. Live data: **Mina Akuafo Poultry Farm (POULTRY-01, Nsawam)** — 3 flocks / 9,465 birds (2 LAYERS batches + 1 BROILERS), flagship products EGGS + BROILER_WEIGHT, Health Score 70/100 with 1 critical + 2 warning alerts on-screen.

### 2.2 The systems reviewed, one by one

| Area | What exists | Reuse? |
|---|---|---|
| **Feeding** (`poultry_feed_logs`) | Typed feed log: `feedType` (STARTER/GROWER/FINISHER/LAYER_MASH/CONCENTRATE), qty kg, cost/kg, `entryType` = PURCHASE (also books `POULTRY_FEED_PURCHASE` EXPENSE) or CONSUMPTION, optional flock/batch link. **0 rows seeded today.** | **Reuse as the consumption ledger.** Add 3 nullable columns: `sourceType` (PURCHASED/OWN_MILL), `feedBatchId`, `inventoryId`. Own-mill consumption writes the same row shape → FCR and all analytics untouched. |
| **Feed stock** | **Derived, not real**: `feedStockKg = ΣPURCHASE − ΣCONSUMPTION` computed client-side. Purchased feed never lands in `inventory_items`. | **Replace the derivation with inventory-backed reading** when the mill exists (finished-feed inventory items), keeping the legacy derivation as fallback. This is the single biggest current gap. |
| **Inventory** (`inventory_items`, `src/lib/stock.ts`) | Business+SKU-unique items, qty/unit/cost/selling/min-threshold, status (IN/LOW/OUT), expiryDate, photos, QR; helpers `ensureInventoryItem/stockIn/stockOut/computeStockStatus`; production already stocks finished goods in (eggs/broilers/products). | **Reuse wholesale.** Raw materials (maize, soymeal, bran, premix…) and finished feed (per formulation SKU) MUST be ordinary inventory rows — never a parallel stock table. Mill production = `stockOut` ingredients + `stockIn` finished feed. |
| **Suppliers & Purchases** | `suppliers` (Ghafeed Poultry Mills Ltd "Poultry Feed & Concentrates" ✔ already a supplier), `supplierOrders`/`goodsReceipts` full procurement pipeline + `ProcurementCenter` UI + order/purchase bell notifications (`src/lib/notify.ts`); simpler analogs per module: block-factory `RESTOCK` entity, `hardwarePurchases`, `restaurantPurchases`, `electronicsPurchases` (RECEIVED → +stock + EXPENSE in one step). | **Reuse both tiers:** P1 = block-factory-style one-step intake (stock-in + optional EXPENSE); P2 = optional full supplier-order→GRN pipeline for large ingredient contracts. Supplier records untouched. |
| **Finance / expenses** | `transactions` (EXPENSE + INCOME), `expense_categories` incl. `FEED_PURCHASE` chip; shared `ExpenseEntryForm` embedded "Record Expense" on every module tab; poultry API already auto-books feed-purchase and health expenses; Finance tab reuses `FinancialReportSection` (finance/reports stay central). | **Reuse with a double-counting rule:** ingredients expensed ONCE at purchase (category `POULTRY_FEED_RAW_MATERIAL`); batch costs are *derived* (never re-booked); own-mill consumption books **no** transaction (internal transfer); external feed sales flow through ordinary Sales & Payments → INCOME automatically. |
| **Activities / checklists** | Unified engine `checklist_templates` + `checklist_entries` (auto-generated daily, assignable, auditable) — poultry module ALREADY reads its checklist from `/api/checklists`, not `poultry_checklists`. | **Reuse:** mill tasks (`MILL_CLEAN`, `SIEVE_CHECK`, `MOISTURE_TEST`, `BAG_SEAL`, `BIN_STOCK_TAKE`) become template rows; no parallel checklist. |
| **Reports & exports** | `FinancialReportSection` + universal export audit (`universal_exports`, moduleKey e.g. "POULTRY"), CSV injection hardening (`csvSafeCell`), branches/business-filtered reports. | **Reuse:** register a `FEED_MILL` export module key; mill cost/kg, ingredient spend by supplier, feed-cost-per-bird/egg trend as additional report section + opsLinks on the existing Finance tab. |
| **Audit (Supervisor & Auditor Control Center)** | `audit_reviews` + issue pipeline + `audit_trail`; OPERATION_LOG sources today = livestock/restaurant/electronics/carwash/hardware logs **(gap: poultry module tables are NOT auditable today)**. | **Fix the gap as part of this work:** register `poultry_feed_batches`, `poultry_feed_qc_checks`, `poultry_feed_formulations` (+ existing `poultry_feed_logs`) as OPERATION_LOG sources so mill records are flaggable/verifiable day one. |
| **Alerts & notifications** | Client-side `analyzePoultry` (Smart Alerts: mortality, feed intake, water, lay%, stock, profit, vaccinations — visible live on the dashboard) + health score; server-side bell (`notifications`) + web-push with an **"alerts"** category; transport module is the template for server-side critical alerts. | **Reuse both channels:** extend `analyzePoultry` with mill alerts (ingredient days-left, QC fail, formulation cost drift, finished-feed days-of-feed); server-side bell entries for CRITICAL mill events (QC FAIL, ingredient OUT_OF_STOCK) via existing notify/push plumbing. |
| **Analytics / FCR** | `poultryPerformance.ts` — feedDaily, recorded+calculated FCR (weight-gain based), ADG, biomass, lay%, egg-weight-vs-feed joins; `PoultryGrowthAnalytics` charts. | **Reuse:** FCR is derived from `poultry_feed_logs` CONSUMPTION rows — own-mill feed logs in the same shape, so FCR works unchanged. **New wins:** FCR *per feed batch* (traceability accelerator: lot A vs lot B performance), true feed cost/kg into cost-per-egg analytics. |
| **Flock management** | `poultry_flocks` (batch no, bird type, counts, mortality); FEED form already has a flock/batch selector (`BatchSelect`). | **Reuse verbatim** for mill-consumption targeting. |
| **Assets** | `assets` + maintenance dates + audit workflow. | **Reuse:** mixer/grinder/scale registered as MACHINERY assets at the unit; mill downtime surfaced via next-due maintenance. |
| **Master products** | `poultry_products` + auto-inventory-SKU linkage, user-extensible. | **Analog reused conceptually** for formulations (system knows every milled feed type). |
| **AI Knowledge** | `/api/poultry/knowledge` (250-line KB route). | **Extend:** feed-milling formulation/biosecurity articles (content-only). |
| **Quality control** | `block_qc_checks` — pipeline-stage QC with typed metrics, result vs standard, PASS/FAIL, photo evidence, tester stamp (Block Factory). | **Pattern-clone** as `poultry_feed_qc_checks` (moisture %, texture/grind, contaminants, weight-per-bag, CP check). Do NOT make a generic QC table — clone the proven shape, poultry-flavoured. |
| **Tenancy & permissions** | Business-scoped access (`canAccessBusiness`), org boundary for SA/owners, expense gate `canRecordExpenses`, records-management gate `canManageRecords`, deletion snapshots (`record_deletion_logs`). | **Reuse unchanged.** Destructive mill ops (reject batch, delete formulation) gated on `canManageRecords` + snapshot logs, consistent with the shared-record model. |

### 2.3 What is genuinely missing (the build surface)
1. **Real feed stock state** — currently a μclient sum with no inventory row (dashboard shows "Feed Stock 0 kg" even though the farm conceptually uses feed).
2. **Formulation/BOM capability** — nothing in the system expresses "recipe → ingredients → output". (Nearest analogs: `carWashServices.supplyInventoryId` consumable-draw-per-job; restaurant `costGhs` recipe cost-without-BOM.)
3. **Production batch records** with ingredient-draw lines and derived cost/kg.
4. **Feed-QC records** and a release gate.
5. **Batch-level traceability** (ingredient lot → feed batch → flock → production/FCR) and per-batch performance analytics.
6. **Property:** mill server-side alerts to the bell (poultry alerts today are client-computed views, fine for dashboards but silent when nobody is watching).

---

## 3. Recommended architecture

### 3.1 Placement decision (the load-bearing call)

**Option A — Poultry-unit sub-module (RECOMMENDED)**
New **Feed Mill** tab inside `PoultryFarmModule` + `src/app/api/poultry/feed-mill/route.ts` (GET full mill dataset + POST `entity` switch — the established module-route convention). The mill lives physically and operationally on the farm; farm staff already work this module daily; consumption→FCR distance is zero.

**Option B — Standalone "Feed Mill" business type** (new `businesses.category`, registered in `BUSINESS_TYPES`, its own module UI)
The manufacturing-unit pattern exists (Block Factory), so this is *possible*, and is the right destination **if** the mill becomes a commercial P&L selling feed to outside farms as its primary business. Costs now: duplicated module shell, cross-unit consumption links (flocks live in POULTRY-01 while stock lives in MILL-01), permission hops, and premature splitting of one physical site into two units.

**Option C — shared enterprise module** (like Suppliers) — rejected: mill data is unit-scoped operational data, not a group registry.

**Choose A now, design for B later**: all mill tables carry `businessId` (+`ownerId`), the API takes `businessId`, and the UI is a self-contained tab — promotion to a standalone unit later is a data move (re-point `businessId` rows or run both), never a rewrite. This matches how the Block Factory already embodies "production unit" conventions.

### 3.2 Data model — 5 new tables (all additive, existing rows untouched)

All tables: `id serial PK`, `businessId` + `branchCode` (+`branchName`), `ownerId` tenant scope (current-table convention), `createdAt defaultNow()`. Money `doublePrecision` in GH₵; dates `text('...')` `recordedDate`/`production_date` convention (matches module tables).

```text
FM1. poultry_feed_formulations          — recipe (versioned, soft-lockable)
    businessId, branchCode, ownerId
    formulationNo text unique            — "FRM-2026-0007"
    name text                            — "Layer Mash 17% CP (Nsawam Mill)"
    feedType text                        — STARTER/GROWER/FINISHER/LAYER_MASH/CONCENTRATE
                                           (SAME vocabulary as poultry_feed_logs → consumption stays typed)
    birdType text                        — LAYERS/BROILERS/BOTH
    ageFromWks / ageToWks int            — intended age band
    batchSizeKg double                   — standard mix volume, e.g. 500
    cpPctTarget / meKcalKgTarget double  — headline nutrient targets for QC
    notes text, active bool default true, version int default 1
    lastCostPerKgGhs double, lastProducedAt timestamp  (rolling cache)

FM2. poultry_feed_formulation_items     — BOM lines (Bill of Materials)
    formulationId int (FK),
    ingredientName text, inventoryId int + sku snapshot — links inventory_items (raw material)
    sharePct double  OR  quantityKgPerBatch double      — share-pct canonical; kg derived share×batchSize
    sequence int

FM3. poultry_feed_batches               — the production run (batch tracking head)
    businessId, branchCode, ownerId
    batchNumber text unique              — "FDB-2026-0043"
    formulationId int, formulationName + formulationSnapshot jsonb  (immutable copy used at mix time)
    productionDate text, operatorName, recordedByName/Role/UserId
    status text default PLANNED          — PLANNED→MIXING→QC_HOLD→RELEASED|REJECTED
    plannedInputKg double, actualInputKg, actualOutputKg
    yieldPct double                      — output/input (milling loss visible)
    ingredientCostGhs, labourCostGhs, overheadCostGhs, totalCostGhs, costPerKgGhs double
    finishedInventoryId int              — inventory_items row for finished feed
    finishedSku / finishedName text snapshots
    stockedQtyKg double, stockedAt timestamp
    releasedByName, releasedAt timestamp, qcGateNotes text
    notes text

FM4. poultry_feed_batch_inputs          — ingredient draw lines (traceability half-ledger)
    batchId int, inventoryId int, ingredientName + sku text
    plannedKg, actualKg double
    unitCostGhs double                   — snapshot from inventory costPriceGhs at draw time
    lineCostGhs double

FM5. poultry_feed_qc_checks             — cloned shape from block_qc_checks
    businessId, branchCode, batchId (+batchNumber snapshot), stage text
                                           — RAW_MATERIAL | GRINDING | MIXING | FINISHED_FEED | STORAGE
    sampleRef, testName, requiredStandard, testResult, resultValue/resultUnit
    passFail text default PASS
    moisturePct double, textureGrade text, contaminantsNote text, bagsCountOk bool
    notes, photo (data URL), testedAt defaultNow, testerName/Role, recordedByName/Role
```

**Additive columns on the existing table** (nullable; legacy rows stay PURCHASED/null):

```text
poultry_feed_logs += sourceType text default 'PURCHASED'   — PURCHASED | OWN_MILL
                  += feedBatchId int                        — poultry_feed_batches.id (traceability)
                  += inventoryId int                        — finished-feed inventory row drawn
```

### 3.3 State flows (reuse-the-plumbing discipline)

```
[Suppliers]──order/intake──▶ inventory_items (Raw Materials, unit Kg)   ← 1-step intake (P1: RESTOCK-pattern) or supplier_orders→goods_receipts (P2)
       │                                │ EXPENSE 'POULTRY_FEED_RAW_MATERIAL' (booked ONCE at intake)
       ▼                                ▼
[Formulations] ──▶ production run (FM3):
                    · validate BOM items in stock
                    · stockOut each ingredient (FM4 lines, cost snapshot = current costPriceGhs)
                    · compute ingredientCost; + labour/overhead inputs → totalCost, costPerKg
                    · stockIn finished feed SKU  → inventory_items ('Animal Feed (Milled)', batch-coded name)
                    · batch → QC_HOLD ──FM5 checks: any FAIL ⇒ REJECTED (owner override releases with note)
                    · PASS ⇒ RELEASED (auditLog 'FEED_BATCH_RELEASE')

[Farm worker logs feeding] → FEED form gains "Source: Commercial / Own Mill":
                    OWN_MILL → pick RELEASED batch (& optional flock):
                    · stockOut finished feed kg
                    · insert poultry_feed_logs { entryType: CONSUMPTION, feedType: formulation.feedType,
                        quantityKg, costPerKgGhs: batch.costPerKgGhs, sourceType: OWN_MILL,
                        feedBatchId, inventoryId, flockId/batchNumber }
                    · NO transaction (already expensed at intake — internal transfer)
                    PURCHASED → existing path untouched (books POULTRY_FEED_PURCHASE expense)

[Performance]  computePoultryPerformance unchanged (quantityKg CONSUMPTION rows)
    + NEW: FCR/ADG segmented by feedBatchId → "Batch FDB-2026-0041 vs 0042" quality signal
    + cost-per-egg / cost-per-bird-day using TRUE mill costs instead of purchase prices
```

### 3.4 Dashboard & workflow (UI design)

**New tab: "Feed Mill"** (Wheat/Factory icon) with an internal sub-nav mirroring module UX density:

1. **Overview** — KPI strip: finished feed in stock (kg + **days of feed**, from real inventory), raw-material coverage (min days across BOM inputs), today's batches (planned/running/released), last batch cost/kg vs commercial feed price (**saving per kg**, headline ROI), QC hold count, FCR-last-batch split (own-mill vs purchased). Smart-alerts block (extended `analyzePoultry` mill section). Quick actions: New Batch · Intake Materials · Log Mill Feeding · QC Entry.
2. **Formulations** — card/table list w/ cost/kg history trend; editor: header + BOM grid (share-% rows auto-summing to 100% validation), nutrient targets, age-band; deactivate (never hard-delete while referenced).
3. **Raw Materials** — read-through of `inventory_items` filtered to the Feed-Raw-Materials category: qty, cost, min-threshold, days-left at current burn; one-step **Intake** form (supplier picklist from shared Suppliers, qty/unit-cost/expense toggle/method) + optional P2 "raise supplier order" path.
4. **Production** — batch register (status badges, yield %, cost/kg), New-Batch wizard (pick formulation → planned batch size prefills BOM draw → record actuals → costs), detail drawer with ingredient lines, QC chain, release/reject actions (gate messaging), batch label content (number, date, kg, formulation — printable later).
5. **Quality** — the FM5 register + per-batch QC chain view (modelled on the block-factory QC dashboard panels).
6. **Consumption & FCR** — own-mill consumption table (joins to flock/batch), FCR-by-batch chart, cost-per-bird-day and cost-per-egg trend; link-outs to existing Growth Analytics tab.
7. **Reports** — mill cost report, ingredient spend by supplier period matrix, savings vs commercial feed, export buttons (universal exports, `FEED_MILL` key, standard approval/QR trail).

Forms reuse the module's modal+confirm pattern (`showForm`, `confirmEntry`), `formatMoney`, Recharts components, `BatchSelect`-style pickers, and testid conventions (`fm-*`).

### 3.5 Integrations summary (build ONCE, reuse EVERYTHING shared)

- **Inventory**: every material and milled feed an inventory item (auto-create on first use via `ensureInventoryItem`); thresholds drive existing low-stock alerts and finance valuation; QR support free.
- **Suppliers/Procurement**: P1 one-step intake (block-factory RESTOCK pattern); P2 optional `supplier_orders→goods_receipts` + bell notifications for mill-sized orders.
- **Finance**: single-booking rule (expensed at intake; never at production/consumption); sales via normal Sales & Payments; categories `POULTRY_FEED_RAW_MATERIAL`, `POULTRY_FEED_MILL_OPS` (labour/overhead), income via feed inventory sales.
- **Checklists**: mill tasks as `checklist_templates` (MILL_CLEAN, MOISTURE_TEST, SIEVE_CHECK, BIN_STOCK_TAKE) — unified engine keeps daily accountability and auditability.
- **Audit center**: register `poultry_feed_logs`, `poultry_feed_formulations`, `poultry_feed_batches`, `poultry_feed_qc_checks` as OPERATION_LOG sources + QC/release actions to `auditLog` (conventions from staff-access QC work).
- **Alerts**: client `analyzePoultry` extension (ingredient coverage < 5 days, finished feed < 3 days, any batch on QC hold > 24 h, cost drift ±15 % batch-over-batch) + server bell/push for CRITICAL ones via `notify.ts` + push **alerts** category.
- **Analytics**: new `feedMillAnalytics.ts` pure file (following `poultryPerformance.ts` data-in/data-out discipline): batch yield, cost/kg trend, BOM variance, FCR-by-batch, savings curve — all verifiable from DB.
- **Reports/UI reuse**: `FinancialReportSection` opsLinks, universal exports, Recharts, `ExpenseEntryForm`, tables/KPI cards already in the module.
- **Knowledge base**: extend `/api/poultry/knowledge` with formulation & milling SOP articles.
- **Assets**: mill machinery in the existing Assets module (MACHINERY at this business) with maintenance due dates.

### 3.6 Implementation approach (3 additive phases)

| Phase | Scope (all additive) | Size | Exit gate |
|---|---|---|---|
| **P0** | Drizzle schema for FM1–FM5 + 3 nullable `poultry_feed_logs` cols; `drizzle-kit push`; `/api/poultry/feed-mill` skeleton (GET + entity routing + auth/access pattern copied from module route). | ~0.5–1 d | schema live, route 401/400 semantics verified, `tsc`/build green |
| **P1 — Mill MVP** | Formulation CRUD; raw-material auto-item + one-step intake (stock-in + optional expense); production run (consume BOM → cost → stock-in finished, status PLANNED→MIXING→RELEASED skipping QC gate behind a flag); OWN_MILL consumption flow (stock-out + typed feed-log row, no txn); Feed Mill tab: Overview/Formulations/Raw Materials/Production/Consumption; analytics lib v1 (cost/kg, yields, days-of-feed from inventory). | ~2.5–3 d | `verify-feed-mill.mjs` (new self-cleaning suite) green; feed-tab derived stat switches to inventory reading when mill used; full regressions re-run |
| **P2 — QC, alerts, audit, reports** | FM5 QC UX + hard QC gate (QC_HOLD → RELEASED/REJECTED, owner override w/ note + auditLog); mill alerts into `analyzePoultry` + server bell push for criticals; audit-center source registration (incl. existing poultry logs gap); FCR-by-batch analytics + Reports/exports (`FEED_MILL`); mill checklist templates seeded as template rows; P2 procurement option (supplier order → GRN). | ~2–2.5 d | suite extended incl. QC gate refusal paths; audit row assertions; full battery re-run (staff-access, multiowner, security, notify) |
| **P3 — Polish & optionals** | KB articles; batch label printing; savings dashboard polish; aquaculture/livestock consumption sharing (their feed_logs gain sourceType); standalone "Feed Mill" business-type promotion path (Option B) if commercially warranted; equipment/downtime insights. | ~1.5–2 d | opt-in flag per business; docs |

**Total: ~6.5–9 dev-days.** Every phase ends with `tsc --noEmit` + production build + the full verification battery — the established release protocol.

### 3.7 Guardrails & conventions to preserve (hard requirements)
- **Additive-only**: no table reshapes, no destructive migrations; seed rule respected ("units start with zero sample data" — flagship-only demo seeds, if any).
- **No double-booking** (the finance invariant above) — codified in the API, commented in code, and asserted by the suite (expense count before/after a production run == unchanged).
- **Old paths keep working**: commercial-feed PURCHASE/CONSUMPTION flow untouched; if a business never opens the mill tab, nothing changes on screen (feature is lazily visible — tabs render on mill activity or an explicit "Enable Feed Milling" toggle in the tab header, off by default for other poultry units).
- **Permissions**: mill write actions require `canAccessBusiness` (like all module writes today); intake expenses honour `canRecordExpenses`; formulation deletion/batch rejection behind `canManageRecords` + `record_deletion_logs` snapshots.
- **Testing**: new `dev-tooling/verify-feed-mill.mjs` (PG + API asserts incl. traceability join lot→batch→flock→FCR row), UI suite extension, Ghana-realistic fixtures, canonical passwords, self-cleaning.
- Follow-ups deliberately NOT in scope: IoT scale/mixer integration, least-cost ration optimizer, MRP auto-reordering, multi-currency procurement (P3+ backlog).

### 3.8 Decisions requested before I start (blocking)
1. **Placement**: confirm Option A (mill inside the Poultry unit) for now.
2. **QC gate**: hard hold vs advisory — I recommend hard hold + owner override (evidence-first release).
3. **Cost healing**: confirm single-booking (expense at ingredient intake; batch costs derived only) and whether labour/overhead amounts should also write real EXPENSE transactions (`POULTRY_FEED_MILL_OPS`) at production time — recommended **yes** for Finance completeness, still single-counted because ingredients aren't.
4. **Feed unit**: kg as the sole canonical quantity (bags shown as kg/50 conversion display) — recommended.
5. **Savings default price**: do you want a "commercial feed reference price" per feed type stored on the formulation for the savings KPI, or compare against historical purchase prices of this business — recommended the latter (zero config).

---
*Next step on your word: "proceed with implementation" → I execute P0→P1 first, with the same phased test/commit cadence as the Signed-In Staff build.*
