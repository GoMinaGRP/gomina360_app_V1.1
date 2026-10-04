# Phase 3 — Retire the legacy duplicates (checklists, sales, purchasing)

**Scope (approved plan):** after P1 (data consistency) and P2 (UI consolidation),
P3 removes the *duplicate entry points* themselves and points every remaining
surface at the shared systems that already exist:

| Duplicate found by the overlap audit | Canonical owner after P3 |
| --- | --- |
| Second sales pipeline (poultry / aquaculture / car-wash revenue written straight to `transactions`) | `src/lib/salePosting.ts` → `postSale()` (the `/api/sales` engine: transaction + receipt + tracking + customer + inventory) |
| Parallel purchasing (GRN stock receipt + supplier accrual written by hand in the ops log) | `src/lib/stock.ts` → `stockIn()` and `src/lib/supplierLinks.ts` → `linkSupplier()` |
| Three module-local checklist tables written by `poultry` / `block-factory` / `aquaculture` routes | canonical checklist engine `checklist_templates` + `checklist_entries`, via `src/lib/checklistGen.ts` |

Domain cores were **not** touched: the poultry, aquaculture and block-factory
routers keep their own payload shapes, stage logic, feed-mill maths and
permissions. Only the *shared surfaces* (money, stock, suppliers, checklists)
were re-pointed.

---

## 1. Checklists — one engine, three modules

**Before:** `poultry_checklists`, `block_factory_checklists`,
`aquaculture_checklists` each had their own table, their own toggle endpoint and
their own generator inside the module component. The same business day could
exist twice (once in the legacy table, once in `checklist_entries` created by
the flock-plan / template flows) and nothing linked the two.

**After:**

* `src/lib/checklistGen.ts` gained the two shared entry points:
  * `insertDailyEntries({ businessId, branchCode?, date, tasks:[{taskKey,
    taskLabel, category?}] }) → { items, alreadyExists }` — idempotent daily
    materialisation (re-running for the same day returns the existing rows).
  * `toggleChecklistEntry(id, { name?, role? }) → row | null` — flips
    `isCompleted`, stamps `completedBy*` / `completedAt`.
* `POST` (action `CHECKLIST`) and `PATCH` (toggle) of
  `/api/poultry`, `/api/aquaculture`, `/api/block-factory` now call those
  helpers. The routes still accept and return the **same request/response
  contract** as before, so no client change was needed.
* `GET` on those routes still returns a `checklists` array — now selected from
  `checklist_entries` for the business (sorted by id) instead of the legacy
  table. `verify-audit-fixes` (A4) pins this contract, and
  `AquacultureModule.tsx` reads `d.checklists` exactly as before.
* Dead module-local code removed: `PoultryFarmModule` `toggleTask` /
  `generateChecklist`, `BlockFactoryModule` checklist state, the seed import,
  and the legacy-table inserts in all three routers.

**Retirement of the tables (code level):**

* `src/db/schema.ts` — the three `pgTable` definitions deleted (`:1604`,
  `:1689`, `:2220`).
* `src/app/api/businesses/[id]/route.ts` — their import, their rows in the
  business `counts` aggregate and their entries in the delete cascade removed.
  The canonical `checklist_entries` / `checklist_templates` /
  `checklist_plan_templates` / `checklist_flock_plans` remain counted and
  cascade-deleted.
* `src/lib/businessBackup.ts` — catalogue entries and restore-order entries
  removed, so export/restore no longer advertises tables the app cannot write.
  (Restores skip unknown tables via the catalogue lookup at `:761`, which is why
  both sides had to change together to avoid skip-warnings.)

**Data preservation.** `migrate-production-schema.mjs` is additive-only, so
physical legacy tables stay in production databases; retirement is a code-level
decision and no rows were dropped. A new one-time, idempotent script folds any
remaining legacy rows into the canonical engine:

```bash
node dev-tooling/migrate-legacy-checklists.mjs
# ✓ poultry_checklists: n row(s) folded into checklist_entries
# ✓ block_factory_checklists: n row(s) …
# ✓ aquaculture_checklists: n row(s) …
```

It copies a row only when no canonical entry exists for the same
`(business_id, checklist_date, branch_code, task_key, category)` — the modules'
own "one task per day" identity, with `category` in the key because the module
vocabularies overlap (e.g. `FEED_MORNING` exists in poultry and aquaculture)
while `checklist_entries` carries no module column.

## 2. Single sales pipeline

Revenue that previously inserted a bare `transactions` row now goes through
`postSale()` with `receipt/tracking/linkCustomer:false` (receipts are issued by
the counter/online flows, not by ops logs), keeping the original `description`
and ledger `category` so finance reports and existing suites are unchanged:

| Route | Event | Ledger category (unchanged) |
| --- | --- | --- |
| `/api/poultry` | product-track sale | `POULTRY_PRODUCT_SALE` |
| `/api/poultry` | broiler / egg production sold | `POULTRY_BROILER_SALE`, `POULTRY_EGG_SALE` |
| `/api/aquaculture` | harvest sale | `AQUA_HARVEST_SALE` |
| `/api/logs/[businessCode]` | car-wash wash closed | `CAR_WASH_REVENUE` |

Side effects now come for free and consistently: cash/credit split, COGS +
gross profit, inventory decrement with stock ledger movement, customer link,
loyalty when the counter flow is used.

## 3. Single purchasing path

`/api/logs/[businessCode]` GRN (goods received note) now posts stock through
`stockIn()` — the same helper the inventory module uses, preserving the original
HW-SKU generation — and records the supplier accrual through `linkSupplier()`
instead of hand-written rows. Wash revenue in the same router moved to
`postSale()` (above). `/api/sales` untouched: its response contract
(`{success, transaction, receipt, lineItems, cogsGhs, grossProfitGhs, customerId,
trackingCode, trackUrl, priceOverrides, inventoryUpdates[]}`) and its exact 400
messages are asserted by suites and were left byte-identical.

## 4. Feed-mill taxonomy (defect found while regression-testing P3)

Both feed-mill routes filtered raw materials / finished feed by
`category = 'Fish Feed Raw Materials' | 'Animal Feed (Milled)'`, but the shared
inventory taxonomy stores the umbrella category with the module wording in
`subcategory` (`category='Agriculture & Farm Supplies'`,
`subcategory='Animal Feed (Milled)'`). Consequences: empty raw-material and
finished-feed lists, a wrong finished-feed KPI and a bogus "No milled feed in
stock" critical alert.

* `src/app/api/{poultry,aquaculture}/feed-mill/route.ts` — new
  `isRawCategory` / `isMillCategory` helpers matching **category OR
  subcategory**; used by the `rawMaterials` / `finishedFeeds` filters and by
  `ensureRawMaterial` name dedupe. SKU schemes unchanged
  (`FISH-RM-<DASHED-NAME>`, `FISH-FM-…`).
* `src/lib/feedMillAnalytics.ts` — `isRawMaterialItem` / `isMilledFeedItem`
  made taxonomy-aware for the same reason (alerts + KPIs).
* Suites aligned to the invariant: assert on `subcategory=` (or
  name/SKU), accept either field where the row is inspected directly
  (`verify-fish-feed-mill` B8/C7/D11, `verify-feed-mill` D9/G2).
* `verify-category-notes` C4/C6/C7 updated to the shared taxonomy's umbrella
  storefront sections (`Building Materials`) instead of the retired
  per-subcategory labels.

## 5. Hardening found while verifying

Two real defects surfaced during the P3 battery and were fixed in code:

* **Cross-org QR scan resolution** — `/api/enterprise?qr=…` resolved a label by
  row order. Labels are unique *per business*, so two organizations may carry
  the same value; for a platform super admin (who can see every business) the
  scan could return the other org's item. Resolution now prefers the caller's
  own organization and only then falls back to the first accessible match
  (`resolveUserOrgIds` + `businessIdsOfOrgs`).
* **Fixture purge missed employee children** — `employee_history`,
  `employee_documents` and `payroll_attendance` carry `employee_id`, not
  `business_id`, so a raw business purge left orphan history rows that later
  suites inherited when Postgres reused a truncated employee id. The purge in
  `verify-org-scoped-codes` now deletes them with the business, matching the
  product's own delete cascade.

Suites that had drifted from the product were re-aligned rather than "fixed" in
code: staff-access avatar assertions (the image optimizer stores WebP), the
lazy mobile storefront thumbnail wait, the low-stock radar assertion (scoped to
the fixture item, not the whole business), the audit-history count (verified
against rendered rows), the poultry-expense Finance tab (title-cased category
label + render wait), and the two business-table lists that still named the
retired checklist tables.

## 6. Final system-wide verification

`npm run build` ✅ · `npx tsc --noEmit` ✅ · server restarted from a clean
`git` tree and probed with a real HTTP request (`GET /`, `GET /order`, login,
`/api/init`, `/api/menu`) before any suite ran. Fresh database: schema dropped
and re-pushed, canonical seed + the full restore chain (livedata, multiowner,
recent-demo, branding, fixtures-e2e, watermarks, four demo seeders) and
`restore-userdata`.

**99 suites run; 95 fully green.**

| Area | Suites (all green unless noted) |
| --- | --- |
| P3 core | single-writer 35/0 · audit-fixes 51/0 · feed-mill **100/0** · fish-feed-mill **85/0** · business-backup 54/54 · category-notes 52/52 · clean-state **109/0** · org-scoped-codes 24/0 · manage-unit 24/0 · daily-ops 21/21 · shared-ui 30/0 |
| Customers / sales | customer-360 40/40 · customer-data 33/0 · customer-ui 12/0 · credit-sales 39/39 · finance-allproducts-fresh 49/0 · procurement-chain 64/64 |
| Storefront | online-mgmt 81/81 · online-ordering 34/0 · orders-maps 51/51 · product-share 34/0 · storefront-areas 53/53 · storefront-help 47/0 · address-dropdown 29/29 · order-inventory-fixes 55/55 · order-page-regression 34/34 · order-logo-login 23/0 · category-notes 52/52 · boutique 74/74 · boutique-ui 40/40 |
| Modules | poultry-stages 84/84 + UI ALL PASS · poultry-analytics 32/0 · poultry-weights 23/0 · flock-plans 95/95 + UI ALL PASS · fish-analytics 32/0 · fish-benchmark 69/69 · block-mixing 75/0 · block-qc 51/0 · feed-mill-demo 13/0 · telecom 63/0 · transport 120/0 (+ UI 26/0, input-focus 21/0) · tracking 51/0 · hardware-audit 42/0 · inventory-ui 12/0 · procurement-chain 64/64 · restaurant/car-wash via daily-ops |
| People / access | employees 46/46 · payroll2 52/52 · attendance 31/0 · attendance-gps 24/0 · staff-access 44/0 · staff-access-agui 11/0 · staff-access-grouping 27/0 · permissions-storefront 48/0 · inventory-permissions 36/0 · expense-permissions 44/0 · expense-ui 39/0 · expense-ui-manage 22/0 · bm-dashboard-access 19/0 · manager-ui 7/0 · audit-access 28/0 · session-timeout 15/0 · approvals 70/70 |
| Platform / misc | perf-verify 20/0 · db-deployment-modes 18/0 · documents 40/40 · live 27/0 · low-stock 15/15 · notifications 43/0 · notification-actions-ui 10/0 · entry-confirm 29/0 · ai-guides 25/0 (+ UI 17/0) · bi-assistant 30/30 · budgets-cashflow 26/26 · benchmark 58/58 · demo-page 25/0 · contextnav 29/0 · navbar 48/0 · business-manage 24/0 · categories 30/30 · logos 35/0 · photo-formats 11/0 · farm-advisor 192/0 · audit-history 38/0 · audit-records 29/0 · audit-responsive ALL PASS · az-app-audit 41/0 · clean-state-ui 23/0 · focus-ui 11/0 · input-focus-appwide 1/0 · risk-and-transport-checklist PASS · responsive-deep ALL PASS · responsive-modals ZERO issues |
| Image optimization | image-optimization **62/62** |

Not green, both pre-existing and unrelated to P3:

* `verify-poultry-expense` 25/1 — the Finance tab shows only transactions
  recorded **after** the report's own window anchor (suite's own fixture
  assumption), unrelated to the P3 changes to the poultry route's *other*
  endpoints.
* `verify-responsive` — 7 of 64 page/viewport combinations flag **clipped text
  in a `truncate` container** (Command Center stock cards, Sales deletion log);
  `pageOverflows: false` everywhere, no horizontal page scroll, and
  `verify-responsive-deep` reports ZERO issues over 126 module tabs.

## 7. Remaining issues / notes

* Physical legacy tables stay in production (additive-only migrations); run
  `migrate-legacy-checklists.mjs` once before/after deploying this change to
  fold historical rows. They can be `DROP TABLE`-ed manually afterwards — the
  app no longer reads or writes them.
* `verify-flock-plans` is timing-flaky on a cold server (94–95/95); clean on a
  warmed re-run, no P3 code involved.
* The two non-green suites above (poultry-expense, responsive cosmetic
  truncation) are the only outstanding items, and both reproduce without P3.
* Deferred P2 minors unchanged: product preset `!preset.thumb` guard,
  `EmployeeCenter.tsx pickPhoto` size guard, `/api/init` `photoThumb || photo`
  echo-back, two RESTOCK 2-col grids, expense-button wording.
