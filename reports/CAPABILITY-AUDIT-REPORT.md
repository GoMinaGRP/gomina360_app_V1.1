# GoMina 360 — Capability Audit: Documents · Approvals · Procurement · CRM · Unified AI BI Assistant

**Date:** 2026-09-26 · **Scope:** full read-only architecture audit of the live app
(commit base `78438a1` + P1–P4 roadmap build, ~134-table schema, 61 API route groups,
91 components) · **Mode: audit and recommendations only — nothing was implemented.**

**Requested focus areas:** (1) Document & Attachment Management, (2) Approval Workflows,
(3) Procurement (PR → Quote → PO → GRN → Inventory → Invoice → Payment), (4) Customer CRM,
(5) Unified AI Business-Intelligence Assistant.

This audit **updates and deepens** `reports/PRODUCT-GAP-ASSESSMENT.md` (which was written
against commit `120def7`, before P1–P4 shipped). Every "exists" claim below was verified in
code this session; where P1–P4 (Action Center, low-stock, cron/digest/SLA, budgets/cash-flow)
changed the picture, that is called out.

---

## 0. Executive summary

GoMina 360 already contains **substantial, hardened implementations in all five areas** —
more than the request implies. The correct strategy is therefore **not** to build five new
systems; it is to (a) close specific, well-bounded gaps, (b) consolidate fragmented
parallel implementations onto the existing cores, and (c) unify the many deterministic
"AI" engines behind one assistant surface.

| Area | Verdict today | One-line finding |
|---|---|---|
| **1. Documents** | **~55% exists** | Generated commercial docs (quote/invoice/receipt PDFs) and per-entity attachments are strong; there is **no central vault** — attachments live in 20+ scattered per-table columns, only employees have a real document registry, **veterinary reports and delivery notes are structured data with no downloadable document**, and nothing alerts on expiry. |
| **2. Approvals** | **~35% exists** | Three bespoke approval lifecycles (assets, data exports, payroll) + QC holds + audit corrections — but **no configurable framework** (no thresholds, no expense/PO/discount/deletion approvals). The asset pattern is the proven template to generalize. |
| **3. Procurement** | **~65% exists** | A genuinely good PO→GRN→stock→expense core exists (`supplier_orders`/`goods_receipts`), but the chain **starts too late (no PR/approval) and ends too early (no supplier invoice match, no payables/payment tracking)** — plus 5 module-specific purchase flows duplicate it. |
| **4. CRM** | **~60% exists** | Rich transactional data (orders with GPS fulfilment, tracking, credit sales + installments, loyalty points) but **transactional, not relational**: no customer-360 view, no interaction log, no dunning, no repeat-customer insights. Mostly a presentation+alerting gap, not a schema gap. |
| **5. Unified AI BI** | **~45% exists** | Six solid deterministic engines (insights, notes-AI, scenario, benchmarks, smart alerts, and now Action Center/digest/budgets) — but they are **six separate surfaces**, and there is **no conversational/NL layer and no consolidated assistant**. Consolidation first, LLM last. |

**Headline recommendation (priority order):**
1. **Approval framework** (generalize the asset workflow; expense + PO approval first) — highest risk-reduction per effort.
2. **Procurement completion** (PR + approval + supplier invoice/payables) — builds directly on #1 and the existing PO/GRN core.
3. **Customer 360 + dunning** — data already exists; highest visible value to the owner.
4. **Document vault with expiry alerts** — extends the proven `employee_documents` pattern; needs the storage decision first.
5. **Unified BI assistant** — one surface over the existing engines; LLM layer optional and last.

---

## 1. Method

* Full read of `src/db/schema.ts` (all ~134 tables), all 61 `src/app/api/*` route groups,
  and the 91 components in `src/components/`.
* Cross-checked live behaviour against the 85-suite E2E battery and the existing reports
  (`PRODUCT-GAP-ASSESSMENT.md`, `HARDWARE-MODULE-AUDIT-REPORT.md`, `AZ-AUDIT-REPORT.md`,
  `ACTION-CENTER-ROADMAP-IMPLEMENTATION.md`).
* Every recommendation was checked against the **do-not-duplicate** inventory (§9) and the
  platform baseline (§2).

---

## 2. Platform baseline every area must build on (do not rebuild)

These are live, hardened capabilities that all five areas should **reuse as foundations**:

| Capability | Where | Relevance |
|---|---|---|
| Auth, multi-org tenancy, role model (OWNER/GM/BM/WORKER/FARM_ADVISOR/super-admin), `accessibleBusinessIds` / `filterByAccess` scoping | `src/lib/auth.ts`, enforced server-side in every route | Any new document/approval/CRM/BI surface gets tenant isolation for free by routing through these helpers |
| Notifications: bell + 25+ event types, fan-out, per-user settings (incl. an **`approvals` category already defined**), web push (VAPID) | `notifications`, `push_*` tables, `src/lib/notify.ts`, `src/lib/push.ts` | Approval events, doc-expiry alerts, dunning reminders all plug in here |
| Immutable audit trail | `audit_trail`, `record_deletion_logs`, `employee_history` | The natural log for an approval framework (who requested/approved/rejected, when, why) |
| **Action Center + My Tasks** (P1, shipped): generic `action_tasks` with owner, due date, priority, source link, completion audit; audit issues now carry `dueDate`; notification→task conversion | `action_tasks`, `AuditCommandCenter`, `MyTasksCard`, `/api/tasks` | Every new engine (approvals, dunning, doc expiry, payables) should land its follow-ups **here**, not in a new list |
| Scheduled jobs (P2, shipped): `/api/cron/daily` — checklists, **low-stock sweep**, auto-complete, task/issue **SLA escalation**, **daily digest** (`recordRef digest:{uid}:{date}`, same-day dedupe) | `src/app/api/cron/*`, `vercel.json` (06:00 UTC) | Time-based behaviour (expiry alerts, dunning, payables aging, board packs) no longer needs new plumbing |
| Low-stock engine (P3, shipped): status normalization + `low-stock:{biz}:{date}` notifications | `/api/low-stock`, inventory status machine | The reorder-PO trigger point |
| Budgets + cash-flow forecast (P4, shipped): per-business/category/period budgets with variance, 13-week projection from starting cash + net flows | `budgets`, `/api/budgets`, `/api/cashflow`, `BudgetsAndCashflowSection` | The financial context a BI assistant should narrate; approval thresholds can reference budget variance |
| Universal export (PDF/XLSX/CSV + QR verification + **approval audit for worker exports**) | `universal_exports`, `src/lib/universalExport.ts` | Both a document generator and an existing approval precedent |
| Deterministic "AI" engines (§6.5) | see Area 5 | The BI assistant's backend |

---

## 3. Area 1 — Document & Attachment Management

### 3.1 What exists today (verified)

**A. Generated commercial documents — FULLY implemented.**
* `sales_documents` (`/api/sales-documents`, `SalesDocumentBuilder.tsx`): QUOTATION /
  INVOICE / RECEIPT with numbered documents (`INV-2026-…`, `QT-…`, `RCP-…`), line items,
  tax, absolute + percentage discounts, COGS/gross profit capture, full status machine
  (DRAFT→SENT→PAID/PARTIAL/ACCEPTED/REJECTED/**CONVERTED**/EXPIRED), quotations convert to
  invoices (`linkedQuotationId`), paid invoices link to transactions
  (`linkedTransactionId`), print/PDF output, logo resolution on every document
  (branch→business→company crest via `src/lib/logos.ts`).
* Payroll payslips: printable HTML + jsPDF payroll run PDFs with embedded resolved logo.
* Universal Export Center: PDF/EXCEL/CSV exports of dashboards/reports with QR
  verification codes and the worker-approval audit trail.

**B. Per-entity attachments — PARTIALLY implemented (the "pockets").**
| Domain | What exists | Where |
|---|---|---|
| Employees | **The only true document registry**: `employee_documents` with doc types `EMPLOYMENT_CONTRACT / CERTIFICATE / QUALIFICATION / WORK_PERMIT / ID_COPY / OTHER`, `fileData` (base64 image **or PDF**), `issuedOn`/**`expiresOn`**, upload audit + immutable `employee_history` | `EmployeeCenter.tsx`, `/api/employees` |
| Inventory | product photos (`photo` + `photos[]` gallery, multi-photo storefront gallery) | `inventory_items` |
| Transactions | expense receipt photos (`receiptImage`, `receiptImages[]`) | `transactions` |
| Audit issues | evidence + response photos | `audit_reviews` |
| Tasks / QC / advisor notes / trips | single photo columns (`action_tasks.photo`, QC `photo`, `advisor_notes.photo`, `transport_trips.receiptPhoto`) | per-table |
| Vehicles | **dates only**: `insuranceExpiry`, `licenseExpiry`, `fitnessExpiry`, `roadworthyExpiry`, insurance company, + one `photo`; vehicles also link to `assets` | `transport_vehicles` |
| Vet/health | structured records, not documents: `poultry_health_records` (VACCINATION/TREATMENT/INSPECTION/MORTALITY/BIOSECURITY with `administeredBy` (vet name), `nextDueDate`) + `healthStatus` flags on flocks/logs | poultry module |
| Delivery evidence | structured delivery records (`hardware_deliveries`, `block_factory_deliveries` — customer, vehicle #, driver, status, date, notes) — no document artifact | module tables |

**C. Document management UX — partially implemented.** The commercial-documents
list in `BranchManagerSalesView` has a **text search box** (`docSearchTerm` —
number/customer/description) plus per-type lists (invoices / quotations /
receipts); server-side permission gates (`canAccessBusiness` → 403) and the
universal export center (PDF/XLSX/CSV + QR) round it out. What does **not**
exist is cross-cutting management: no single searchable/filterable surface
across document **types and modules** (commercial docs + employee docs +
photos + future vault docs), and no document-level permission model beyond
business scoping.

### 3.2 Gaps
1. **No central document vault.** Business-level documents (business licences, permits,
   leases, calibration certificates, contracts with suppliers/customers, insurance
   policies) have nowhere to live. Only employees have a registry.
2. **No downloadable veterinary reports per batch/flock** (verified: no export/PDF path
   touches health data). The structured data is all there — `poultry_health_records`
   (vaccinations, treatments, inspections, mortality, biosecurity, `administeredBy`,
   `nextDueDate`) and per-flock health status — but a vet visit produces **no report
   artifact** a manager can download, print for the vet to sign, or keep on file.
   Same for aquaculture (health lives in logs/water-quality, no report).
3. **No delivery-note documents.** Hardware site deliveries and block-factory
   deliveries are structured records (with vehicle, driver, quantities, status), but
   there is no printable/PDF delivery note for the driver or the customer to sign —
   and no way to attach the signed copy back.
4. **No cross-cutting search/filter/permissions surface.** Each pocket has its own tiny
   viewer inside its module; the only document search that exists is the commercial
   documents box in `BranchManagerSalesView`. There is no "all documents for business
   X / type Y / expiring soon" management view.
5. **No expiry alerting.** `employee_documents.expiresOn` and the four vehicle expiry
   fields exist but nothing sweeps them — no notification, no Action Center task. (P2's
   cron now makes this trivial to add.)
6. **No arbitrary-record attachments.** You cannot attach a scanned vet report PDF to a
   flock, a signed contract to a supplier, or a delivery note PDF to a goods receipt.
7. **Storage constraint (A3):** all files are base64 data-URLs in Postgres columns. Fine
   today; a vault multiplies volume and needs an object-storage decision first (or an
   explicit size-capped interim policy).

### 3.3 Overlaps / fragmentation
* Four different "document" concepts coexist: generated commercial docs
  (`sales_documents`), the employee registry (`employee_documents`), export artifacts
  (`universal_exports`), and ad-hoc photo columns. This is acceptable **if** a vault
  becomes the single registry that links to them rather than replacing them.
* Vehicle document dates duplicate the concept already modelled better in
  `employee_documents` (issued/expiry + file).
* Health data is recorded in two shapes (rich per-flock `poultry_health_records` vs a
  bare `healthStatus` enum on daily logs) — fine, but the vet-report generator should
  read both.

### 3.4 Integration recommendations
1. **New `business_documents` table** cloned from the proven `employee_documents` shape
   (docType, title, fileData, issuedOn/expiresOn, uploadedBy, businessId/branchCode,
   ownerId) **plus** optional polymorphic links (`relatedType`, `relatedId`) so the same
   registry serves business docs AND "attach a PDF to this flock/supplier/PO/vehicle".
   Vehicle expiry fields should be **mirrored** into vault docs (keep the structured
   dates for dashboards, store the file in the vault).
2. **Doc types seed from the request list:** invoice, receipt, quotation, vet report,
   delivery note, contract, certificate, licence/permit, insurance, vehicle document,
   other. Generated `sales_documents` and payslip PDFs stay where they are — the vault
   links to them (`relatedType: 'SALE_DOCUMENT'`), never copies them.
3. **Generated report documents (new, high-value, cheap):**
   * **Veterinary report per flock/batch** — a downloadable PDF (jsPDF, same pattern as
     payslips/`generateSalesDocumentPDF`) summarizing the flock's health record:
     vaccinations/treatments/inspections with dates and `administeredBy`, mortality
     curve, current health status, `nextDueDate` schedule — with the resolved logo and
     a signature block for the attending vet. Store the generated file (or a
     regeneration pointer) in the vault against the flock. Same generator serves
     aquaculture batches from their log data.
   * **Delivery note per dispatch** — printable PDF from the existing
     `hardware_deliveries` / `block_factory_deliveries` records (customer, items,
     quantities, vehicle/driver, date), with a signature line; the signed paper can be
     photographed and attached back to the same record via the vault.
4. **Expiry sweep in the existing cron** (`/api/cron/daily`): 30/7/0-day ladders →
   notification (reuse `approvals`-style categories) **+ Action Center task**
   (`sourceRef: 'doc-expiry:{id}'`) — exactly the pattern P3 low-stock and P2 issue
   escalation already use.
5. **One management UI** (search by business/type/status/expiry, filter, preview,
   permission-gated per business scope) modelled on the Audit Command Center's
   filter/list patterns — this is where cross-cutting search finally lives; upload flow
   reuses the existing image-compression/PDF-accept plumbing (`verify-photo-formats`
   documents the accept matrix).
6. **Permissions:** viewer = anyone with business access; uploader = staff with
   `canManageRecords`-style flags; deletions flow through the approval framework (Area 2)
   and `record_deletion_logs`.

---

## 4. Area 2 — Approval Workflows

### 4.1 What exists today (verified) — three bespoke lifecycles, no framework

| Workflow | Lifecycle | Mechanics | Gap vs "configurable" |
|---|---|---|---|
| **Asset changes** (`/api/assets/audit`) | `REQUEST_EDIT / REQUEST_TRANSFER / REQUEST_DELETE` → `PENDING` → `APPROVED / REJECTED` | request row in `asset_audit_logs` with reason; approver decides; immutable log | Only assets; hard-coded approver rules; no thresholds, no delegation |
| **Data exports** (`/api/exports`) | WORKER request → `PENDING` → `APPROVED / REJECTED` → `COMPLETED` | worker exports always require approval regardless of grants; approver action recorded on `universal_exports` | Only exports; binary (worker vs everyone else) |
| **Payroll runs** | `DRAFT → REVIEWED → APPROVED → PAID` | owner or `canManageRecords` gate; payment requires APPROVED | Only payroll; no delegation/limits |
| **QC hold/release** (feed/block batches) | batch `HELD` → released/discarded with reason | per-module QC centers | Not an approval queue; no approver identity chain |
| **Audit corrections** | issue flagged → assignee responds → reviewer VERIFIES; escalation ladder via cron (P2) | `audit_reviews` + `audit_issue_updates` + SLA sweep | Disciplinary/factual, not spend-control |

Also relevant: notifications already define an **`approvals`** category in per-user push
settings (currently unused by a real approvals queue), and `record_deletion_logs` +
`audit_trail` give the logging pattern.

### 4.2 Gaps (vs the request: purchases, expenses, inventory adjustments, discounts, deletions, sensitive actions)
1. **Expense approvals** — workers with `canRecordExpenses` post straight to the P&L; no
   sign-off tier, no spending limit, no owner delegation. **This is the highest-risk gap
   in the whole audit** (money leaves the business unreviewed).
2. **PO approval** — `supplier_orders` start at `RAISED` and anyone with procurement
   rights can advance them; no approval gate before committing spend.
3. **Inventory adjustment approval** — stock-ins/outs happen implicitly through module
   flows (orders, receipts, waste) with audit trail but no correction-approval flow for
   manual adjustments.
4. **Discount approval** — percentage discounts are captured everywhere (till, sales
   docs, orders) but unlimited and unreviewed.
5. **Deletion approval** — only assets have it; business/document/customer deletions are
   immediate (logged, but not gated).
6. **No generic framework** — each workflow re-implements status enums, decision routes
   and logging; no "approval policy" concept (rules like "expenses > GH₵ 500 need OWNER"),
   no unified pending-approvals queue, no delegation ("BM approves up to GH₵ 200").

### 4.3 Integration recommendations
1. **Generalize, don't invent:** create one `approval_requests` table +
   `/api/approvals` route family that mirrors the asset workflow's shape —
   `{ targetType, targetId, action, payloadSnapshot, requestedBy, status: PENDING/APPROVED/REJECTED/CANCELLED, decidedBy, decidedAt, reason }`,
   with every transition written to `audit_trail`. The asset flow then becomes the first
   consumer (adapter), not a parallel system.
2. **Policy layer** (`approval_policies`, org-scoped): rule tuples
   `action ∈ {EXPENSE, PO, INVENTORY_ADJUSTMENT, DISCOUNT, DELETION, DATA_EXPORT, PAYROLL}`
   × threshold (amount/percent) × approver role/user, with a default allow-list for the
   OWNER. Keep it deliberately simple — rules evaluated in code, not a workflow engine.
3. **Wire the five requested gates** in this order (risk × effort):
   a. **Expenses** (worker submits → PENDING → approver) — reuse `transactions` draft
      state or the request snapshot; approved → existing expense booking path unchanged.
   b. **POs** — `supplier_orders` gains a `PENDING_APPROVAL` state before `RAISED`
      commits; approval notifications to the policy approver; Action Center task with due
      date (P1 machinery).
   c. **Inventory adjustments** — manual quantity corrections route through requests;
      module-driven stock movements stay automatic (they already have audit trail).
   d. **Discounts** — policy threshold on `discountPercent` at till/sales-doc time;
      over-threshold → request (or role-gated hard cap).
   e. **Deletions** — extend the asset REQUEST_DELETE pattern to businesses, documents
      (Area 3 vault), customers and suppliers.
4. **One inbox:** pending approvals render in the **Action Center** as a linked zone
   (exactly like audit issues) + bell notifications via the existing `approvals`
   category; no separate approvals page needed.
5. **Delegation:** policies may name a delegate approver with an optional spend cap —
   modelled on the existing BM `user_business_access` grant UX.

---

## 5. Area 3 — Procurement (PR → Quote → Supplier → PO → GRN → Inventory → Invoice → Payment)

### 5.1 What exists today (verified)

**The core chain — PO → GRN → Inventory → Expense — FULLY implemented and solid:**
* `supplier_orders` (PO): unique `PO-SO-2026-…` numbers, org-scoped supplier (FK or
  ad-hoc name), shipping method, expected ETA, currency, line items
  `[{inventoryId, description, qty, unitCostGhs, trackingId}]`, totals, status machine
  `RAISED→SENT→SHIPPED→IN_TRANSIT→ARRIVED→RECEIVED|CANCELLED` **with full
  `statusHistory`**, creator audit, tenant `ownerId`.
* `goods_receipts` (GRN): unique `GRN-2026-…`, **the only stock gate** — receipt is the
  single point where PO stock increments `inventory_items` (with correct status
  re-normalization), scoped strictly to the PO's own business; the supplier **expense is
  booked exactly once** at receipt (`expenseBooked` guard).
* `/api/procurement` (`RAISE` / `ADVANCE` / `RECEIVE` / `CANCEL`) with bell/push
  notifications on milestones; UI: `ProcurementPanel` (also embedded in
  `PreordersHubView`).
* **Demand propagation:** storefront preorders drive PO lines (`trackingLineIds`), and
  posting a GRN makes preorder items reservable for customer fulfilment
  (`propagatePoStage`, `resolvePreorders`, `preorderLinesForReceipt`). This is a genuine
  mini-ERP differentiator.
* **Low-stock engine (P3, shipped):** sweeps `min_stock_threshold`, normalizes stock
  status, notifies `low-stock:{biz}:{date}` with same-day dedupe — the natural trigger
  for reorder-PO drafting.
* Suppliers directory (`suppliers`, org-scoped, payment terms, categories, contact
  person) — used by the procurement + feed-mill raw-intake flows.

**Parallel module-specific purchase flows (fragmentation):**
`hardware_purchases` (ORDERED→RECEIVED, stock-in + expense booking),
`electronics_purchases`, `restaurant_purchases`, feed-mill raw intake
(`poultry/fish_feed_batch_inputs` with supplier ledger rows), block-mix raw inputs —
five direct-purchase paths that bypass `supplier_orders`.

### 5.2 Gaps (the missing head and tail of the chain)
1. **PR (purchase requisition):** no internal request ("we need 40 bags of maize"),
   no department/requester → approver flow. (Depends on Area 2.)
2. **Supplier quotation stage:** no RFQ to suppliers, no quote capture/comparison
   (price, lead time, terms) before PO creation. `suppliers` has `paymentTerms` but no
   price lists or quote history.
3. **Supplier invoice + 3-way match:** no supplier-invoice registration (invoice number,
   amount, attachments), no PO↔GRN↔invoice matching or variance flagging.
4. **Payables / payments:** the expense is auto-booked at GRN (payment method hardcoded
   CASH); there is **no supplier ledger, no "what do we owe", no aging, no payment
   recording against POs/suppliers**. The suppliers table has payment terms that nothing
   consumes.
5. **Supplier performance:** lead-time adherence, fill rate, price variance — no data
   capture (statusHistory timestamps are actually a good raw source for lead time).
6. **Low-stock → PO not wired:** the P3 engine alerts but does not draft a PO.

### 5.3 Integration recommendations
1. **Front of the chain (new, small):** `purchase_requisitions` (requester, business,
   lines `{inventoryId?, description, qty, needBy}`, status
   `DRAFT→PENDING_APPROVAL→APPROVED→ORDERED|REJECTED|CANCELLED`) → on approval, either
   auto-draft a `supplier_orders` PO or branch to RFQ. Approval via the Area-2 framework;
   follow-ups in the Action Center.
2. **Quote stage (new, thin):** `supplier_quotes` (requisition/PO link, supplier, lines,
   total, lead time, terms, validity) with a simple comparison view; winning quote
   converts to a PO (mirroring quotation→invoice conversion in `sales_documents` — same
   UX precedent). No supplier-facing portal; staff enter quotes.
3. **Tail of the chain (the money side):**
   * `supplier_invoices` (PO link, invoice number/date, amount, status, attachments via
     Area-3 vault, optional 3-way-match result) — posting books the payable;
   * `supplier_payments` (invoice/PO link, method, ref) mirroring the proven
     `credit_sales`/`credit_payments` pattern on the receivables side — **reuse that
     design verbatim, mirrored** (balance, aging, receipts, INCOME/EXPENSE ledger
     postings);
   * aging-by-supplier view + "supplier statement" export via the universal export
     center.
4. **Consolidation (debt paydown, medium-term):** migrate module-specific purchase flows
   onto `supplier_orders`/`goods_receipts` (hardware first — it already has
   ORDERED→RECEIVED semantics). Keep module UX; change the backing store. This removes 5
   parallel stock-in/expense implementations.
5. **Low-stock → draft PO:** extend the P3 sweep to optionally create a
   `purchase_requisition` (or draft PO) at `min_stock_threshold × lead-time multiplier`
   for owner confirmation — one notification click away from an approved reorder.
6. **Supplier performance** falls out almost free once invoices + statusHistory
   timestamps exist: lead time (SENT→ARRIVED), fill rate (ordered vs received qty),
   price variance (quote vs invoice). Present in the suppliers directory.

---

## 6. Area 4 — Customer CRM

### 6.1 What exists today (verified)

**Transactional data — strong:**
* `customers`: type segmentation (WHOLESALE/RETAIL/CORPORATE/DISTRIBUTOR), contact +
  standardized Ghana location (region/district/town), `totalSpentGhs`, `loyaltyPoints`
  (redeemed in car-wash/credit-sale flows), cross-unit sharing (null businessId) with
  org tenant scoping.
* `customer_trackings` (orders): unique unguessable tracking codes, items, discounts
  (absolute + percent), totals, full fulfilment model (PICKUP at branch/pickup points /
  DELIVERY with customer Google-Maps GPS pin + accuracy + map link), status chain
  RECEIVED→CONFIRMED→PROCESSING→READY|DISPATCHED→COMPLETED|DELIVERED|CANCELLED, links to
  sale documents and transactions, **public no-login /track page** for customers.
* `credit_sales` + `credit_payments`: buy-now-pay-later anchored to order codes — stock
  out up front, installments post INCOME + mint RECEIPTs, `balanceGhs` tracked to zero.
* `order_payments`: deposits/balances/full payments with MoMo refs for online orders.
* Storefront (public /order per business with areas/GPS radius/QR links), quotations →
  invoices (CONVERTED), receipts; `CustomerTrackingPanel` for staff order management;
  customer directory section in `SharedEnterpriseModule`.

**Relational layer — thin:** no per-customer consolidated view (verified: no
customer-detail component), no interaction log, no preferences, no dunning.

### 6.2 Gaps
1. **Customer 360:** no single view joining orders, payments, credit exposure, tracking
   history, loyalty, documents (statements). The pieces exist in separate surfaces.
2. **Customer statements:** no printable/emailed statement (open credit, payments,
   activity) — universal export center could generate this today.
3. **Dunning / overdue alerts:** credit sales carry due dates and balances, but nothing
   sweeps for overdue installments. (Cron P2 makes this a small job; the advisor-notes
   overdue-badge pattern proves the UI.)
4. **Interactions log:** calls, visits, complaints, WhatsApp follow-ups — nowhere to
   record them (daily_notes are business-level, advisor_notes are advisor-scoped).
5. **Preferences & notes per customer:** preferred fulfilment, payment method, delivery
   address book (beyond the per-order pin), free-text notes.
6. **Repeat-customer insights:** no RFM/segmentation (recency/frequency/monetary), no
   "top customers", no churn/lapse indicators, no repeat-rate per storefront. All
   computable from existing tables.

### 6.3 Integration recommendations
1. **Customer 360 drawer/panel** (no new tables needed for v1): aggregate per customer —
   profile, lifetime `totalSpentGhs`, order history (trackings) with statuses, credit
   sales + balances + payment history, loyalty points, linked documents (Area-3 vault via
   `relatedType: 'CUSTOMER'`). Follow the Audit Command Center drawer patterns; scope via
   existing access helpers. Add `customer_notes`/`customer_interactions` (small table:
   customerId, type, note, actor, at) for the relational layer.
2. **Statements:** one export template in the universal export center (PDF with the
   resolved logo + QR verification, like payslips) — cheapest high-visibility win.
3. **Dunning ladder in cron:** overdue credit installments → T+1/T+7/T+30 notifications
   (bell + push) + Action Center task per customer (`sourceRef: 'dunning:{creditId}'`),
   capped per day. Mirrors P3's dedupe conventions.
4. **Repeat-customer insights:** deterministic metrics in the BI layer (Area 5): RFM
   segments, repeat rate, average days between orders, top-10 customers per business —
   surfaced in the assistant and the customers directory (badges like the audit
   priority chips). No LLM required.
5. **Preferences:** extend `customers` with a small jsonb (`preferences`) + address book
   table rather than new bespoke columns; prefill checkout from it.

---

## 7. Area 5 — Unified AI Business-Intelligence Assistant

### 7.1 What exists today (verified) — six deterministic engines, six surfaces

| Engine | Implementation | Surface today |
|---|---|---|
| **AI Decision Advisor** | `/api/ai` — OWNER/GM only; keyword-rules over a **real** scenario-engine baseline (quarterly books + live ledger); `ai_insights` rows with category/impact/projected gain; 60 s cooldown + 24 h dedupe + retention cap | `AiAdvisorView` |
| **Notes AI** | daily-notes analysis + rolling `business_insights` (issue register, category trends, rolling summary); advisor notes get **benchmark-KPI corroboration** against the linked flock/batch | notes panels, advisor console |
| **AI Section Guides** | per-business-type + per-section contextual guides with Q&A box | `AiSectionGuide` (in every section) |
| **Scenario & forecast engine** | `src/lib/scenarioEngine.ts` — live baseline, per-variable % impacts, saved simulations (single source of truth for what-ifs) | `ScenarioPlannerView` |
| **Benchmarks & smart alerts** | poultry/fish benchmark profiles + flock/batch performance bands; poultry analytics alerts | benchmark panels, `PoultryAnalyticsAlerts` |
| **Ops intelligence (P1–P4, shipped)** | Action Center (tasks + linked audit issues with SLA escalation), low-stock engine, daily digest, budgets variance + 13-week cash-flow forecast | Action Center, digest notifications, `BudgetsAndCashflowSection` |

**No LLM anywhere** (verified by search — zero OpenAI/Anthropic/Gemini/LLM imports). All
intelligence is deterministic, testable, offline-safe, tenant-scoped.

### 7.2 Gaps
1. **No unified assistant**: six surfaces, six mental models. The owner cannot ask one
   place "what needs my attention and why?" (the daily digest is the closest thing, but
   it is notification-shaped, not interactive).
2. **No natural-language query layer** ("why did poultry profit drop in August?",
   "which customers haven't ordered in 60 days?"). The data and scoping exist; the NL →
   query/summary layer does not.
3. **No cross-engine narration**: budgets variance, low-stock, audit issues, dunning
   (future), payables (future) are reported separately with no consolidated narrative.
4. **Insight → action gap (half-closed):** P1 gave every alert a place to land
   (Action Center tasks), but `ai_insights` rows still have no "convert to task" action.
5. **No forecasting beyond cash-flow** (P4) — no demand forecasting for stock planning
   (historical orders could support simple moving-average/seasonal baselines).
6. **No anomaly detection** (statistical z-scores on existing series — cheap, no LLM).

### 7.3 Integration recommendations — "consolidate first, narrate second, LLM last"
**Security & authorization model (applies to every phase):** the assistant is a normal
authenticated surface — it inherits the platform's server-side scoping
(`accessibleBusinessIds` / `filterByAccess` per request, org-tenant boundary, role
gates), so a BM sees only their units' operational/financial/Action-Center data, an
OWNER/GM their org, a FARM_ADVISOR only the sections granted in their
`advisor_assignments` (the e74f1ef per-section model). Every assistant query/answer
writes an audit-trail row (who asked, what scope was used, which engine artifacts
answered). No endpoint ever returns cross-org data, and the LLM phase (U3) receives
only pre-scoped engine outputs — never raw table access.
1. **Phase U1 — One surface (no new intelligence):** a Unified BI Assistant view that
   federates the existing engines into one ranked feed: today's digest content, budget
   variances, low-stock, audit issues + SLA, ai_insights, benchmark deviations, and (as
   they ship) dunning/payables/doc-expiry. Every card links to its source record and
   carries an Action-Center "make it a task" button (reusing the notification→task
   machinery). This is presentation + routing over existing APIs — zero new analytics.
2. **Phase U2 — Deterministic Q&A (intent router, still no LLM):** a small query panel
   that classifies the question into intents (finance summary, top customers, stock
   status, overdue items, budget variance, forecast) and answers from the engines —
   essentially the AiSectionGuide UX backed by real scoped queries. Keep the OWNER/GM
   gate of `/api/ai`; extend BM access to their own scope via `accessibleBusinessIds`.
3. **Phase U3 — Optional LLM layer (opt-in, off by default):** if/when added, the LLM
   **narrates and queries the deterministic engines; it never replaces them** (the
   engines are the moat: no hallucination, no API cost, works offline). Pattern: LLM
   generates the query plan / narrative from **engine outputs and pre-scoped data
   summaries** — never raw table access; every answer cites the engine artifacts it came
   from; full prompt/response audit-trail rows; org-scoped data assembly server-side
   (same helpers as every route). Suggested first uses: narrative board-pack text,
   plain-English explanation of a budget variance, digest summarization.
4. **Cheap wins to fold in:** z-score anomaly flags on revenue/expenses/production
   series; `ai_insights` → task conversion; forecast series for reorder planning
   (moving average over orders — feeds Area 3's auto-draft PR).

---

## 8. Cross-cutting observations

1. **Storage (A3) is the gating decision** for the document vault and any attachment
   expansion: base64-in-Postgres everywhere today. Decide either (a) size-capped interim
   (≤ ~2 MB/file, PDF+images only, compression as today) or (b) object storage with a
   URL column + signed access. The vault design should isolate this behind one storage
   helper so (b) is a later swap.
2. **Duplication debt worth scheduling:** five module purchase flows vs
   `supplier_orders`; four legacy per-type checklist tables (noted in the gap
   assessment); photo columns in 20+ tables (leave them; the vault links rather than
   migrates them).
3. **The approvals inbox should be the Action Center**, not a new top-level tab — the
   P1 linked-zone pattern (audit issues) is the exact template.
4. **Notification hygiene:** new event types should follow the P3 conventions (typed
   `recordRef` with same-day dedupe, bell + push fan-out via existing helpers) to avoid
   the cross-suite interference class seen in the battery.
5. **Q1-2026 static baseline (A6)** will increasingly distort engine baselines
   (`computeScenarioBaseline`) as live data accumulates — schedule a rolling-baseline
   decision before the BI assistant relies on it for narratives.

---

## 9. Prioritized roadmap (value × dependency)

| Rank | Initiative | Value | Effort | Depends on | Delivers |
|---|---|---|---|---|---|
| **R1** | **Approval framework** (generalize asset pattern + policies; gate expenses, then POs, discounts, adjustments, deletions) | ★★★★★ (risk reduction on real money) | Low-Med | Nothing — pattern + notifications + Action Center all exist | Area 2 complete; unblocks R2 |
| **R2** | **Procurement completion** (PR → approval → supplier quotes → PO → GRN → **supplier invoice + payables/payments**; low-stock → draft PR; supplier performance) | ★★★★★ | Med | R1 (approval gate), R4 vault (invoice attachments — can start without) | Full PR→Payment chain (Area 3) |
| **R3** | **Customer 360 + statements + dunning** (+ interactions/preferences; RFM insights) | ★★★★☆ | Low-Med | Dunning needs cron (done); RFM feeds R5 | Area 4 complete |
| **R4** | **Document vault + expiry alerts + generated docs** (vet-report PDFs per flock/batch, delivery notes, vehicle/employee doc mirroring, record attachments) | ★★★★☆ | Med | Storage decision (A3); cron (done) | Area 1 complete; serves R2 invoices |
| **R5** | **Unified BI Assistant** (U1 feed consolidation → U2 deterministic Q&A → U3 optional LLM) | ★★★☆☆ (compounds with R1–R4) | Med → High | U1 anytime; U2 benefits from R3/R4 data; U3 last | Area 5 complete |

**Suggested build order:** R1 → R2 → R3 → R4 → R5-U1/U2, with R5-U1 (consolidated
feed) pullable forward at any point since it only federates what exists. R3 and R4 are
independent and can proceed in parallel with R2 after R1. Within R4, the **vet-report
and delivery-note PDF generators are the cheapest visible wins** (data + PDF patterns
exist) and can ship before the full vault.

### 9.1 Risks and mitigations

| # | Risk | Areas affected | Mitigation |
|---|---|---|---|
| RK1 | **Uncontrolled spend while approvals don't exist** — every day without expense/PO approval is real money leaves the business unreviewed | R1, R2 | Ship R1's expense gate first, even before the full policy layer (a fixed "worker submissions need OWNER/GM sign-off" rule is already valuable) |
| RK2 | **DB bloat from base64 documents** (A3) — a vault + vet/delivery PDFs multiplies stored bytes in Postgres | R4 | Decide the storage strategy first: size-capped interim (≤ ~2 MB/file, compressed) behind a single storage-helper abstraction, so object storage is a later swap, not a rewrite |
| RK3 | **Approval bottleneck / owner overload** — if every small expense needs the owner, staff stop recording | R1 | Thresholds + delegation from day one (spend caps per role/user); the policy table ships with the first gate, not after |
| RK4 | **Procurement parallel-flow confusion** — five module purchase paths vs the unified chain invites double-counted stock/expense during migration | R2 | Migrate module-by-module behind the same UI (hardware first), one E2E suite per migration step; never both paths live for the same module |
| RK5 | **LLM cost / hallucination / privacy** (R5-U3) — an LLM with raw data access could leak cross-tenant data or invent figures | R5 | Deterministic engines stay the only data source; the LLM narrates pre-scoped engine outputs; opt-in and off by default; full prompt/response audit trail; every answer cites its engine artifacts |
| RK6 | **Suite/data-state drift** — the E2E battery has several date- and demo-state-calibrated suites (documented this session); big features landing on shifting fixtures breed false failures | All | With each initiative, add suites that are snapshot-relative (state captured at start, compared at end) per the AZ-M5 convention; keep demo seeders idempotent and part of recovery |
| RK7 | **Static Q1-2026 baseline divergence** (A6) — scenario/insight baselines drift from reality as live data accumulates | R5 | Decide rolling-baseline semantics before the BI assistant narrates "trends" from the baseline blend |
| RK8 | **Scope creep in the "vault"** — trying to migrate all 20+ photo columns at once | R4 | Vault is additive: link, don't migrate; only employee + vehicle documents move in v1 |

### 9.2 Professional recommendations — what to implement first and why

1. **Start with R1 (approvals), specifically the expense gate.** It is the only gap in
   this audit where absence actively loses money every day; the pattern is already
   proven in production (asset workflow + export approval + payroll states); and it
   carries no schema risk beyond one new table. It also makes every later
   money-related feature safer.
2. **Immediately after, R4's two PDF generators (vet reports, delivery notes)** as a
   quick, high-visibility win while R2 is designed — they need no new tables if
   generated on demand and directly answer two explicit owner needs (vet documentation
   per batch, signed delivery evidence) with existing jsPDF patterns.
3. **R2 is the structural build of the cycle** — it converts procurement from "good PO
   handling" into the complete PR→Payment chain and retires the largest duplication
   debt (five module purchase paths). Do not start it before R1's PO gate exists.
4. **R3 rides the existing data** — customer 360 + statements are mostly presentation;
   dunning plugs into the shipped cron. Highest owner-visible value per hour of work.
5. **R5 strictly last, in U1→U2→U3 order.** The consolidation feed (U1) makes every
   existing engine more valuable at near-zero risk; the deterministic Q&A (U2) is where
   real "BI assistant" value appears; the LLM layer (U3) is optional polish that must
   never sit in the critical path of a decision.
6. **Do not rebuild anything on the §11 non-duplication list** — every recommendation
   above composes with those systems (the list was re-verified during this audit).

## 10. Related improvements (professional-judgment additions)

* Migrate module purchase flows onto the unified PO/GRN core (R2 follow-on).
* `ai_insights` → Action-Center task conversion button (one-day win).
* Anomaly (z-score) alerts folded into the digest.
* Supplier statement + customer statement export templates (universal export center).
* Vehicle document expiry mirrored into the vault with the expiry ladder.
* Rolling-baseline decision for the scenario engine.
* Livestock module depth (herd inventory/weights) — unchanged recommendation from the
  gap assessment; not part of these five areas.

## 11. Explicit non-duplication list (verified — do NOT rebuild)

Sales documents + quotation→invoice conversion · payroll approval states · asset
request→approve workflow · export approval audit · employee document registry ·
suppliers directory · PO/GRN pipeline + preorder demand propagation · low-stock engine ·
Action Center/tasks · cron digest/SLA · budgets + cash-flow forecast · scenario engine ·
benchmarks (poultry/fish) · notes-AI + advisor corroboration · AI section guides ·
notifications/push fan-out with per-user categories · universal export (PDF/XLSX/CSV+QR)
· multi-org scoping/permissions/session model · public storefront + order tracking +
credit sales/installments.

---

*Audit performed read-only; no product code was changed as part of this audit. (Separate
battery-recovery fixes landed earlier in the session are documented in
`reports/ACTION-CENTER-ROADMAP-IMPLEMENTATION.md`.)*
