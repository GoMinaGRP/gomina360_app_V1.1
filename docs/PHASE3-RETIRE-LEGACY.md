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

## 5. Results

Build `npm run build` ✅ · `npx tsc --noEmit` ✅ · server started and probed with
a real HTTP request before each suite.

| Suite | Result |
| --- | --- |
| `verify-single-writer` | 35 / 0 |
| `verify-audit-fixes` | 51 / 0 |
| `verify-daily-ops` | 21 / 21 (ALL PASSED) |
| `verify-feed-mill` (poultry) | **100 / 0** (was 97/3 — stale-taxonomy failures) |
| `verify-fish-feed-mill` | **85 / 0** |
| `verify-business-backup` | 54 checks, ALL PASSED |
| `verify-category-notes` | **52 / 52** (incl. business DELETE cascade) |
| `verify-clean-state` | 109 / 0 |
| `verify-org-scoped-codes` | 24 / 0 |
| `verify-manage-unit` | 24 / 0 |
| `verify-poultry-stages` / `-ui` | 84 / 84 · ALL PASS |
| `verify-flock-plans` | 94–95 / 95 (known flaky, clean on re-run) |
| `verify-fish-analytics` / `verify-poultry-analytics` | 32/32 · 32/32 |
| `verify-block-mixing` / `verify-block-qc` | 75 / 0 · 51 / 0 |
| `verify-fish-benchmark` / `verify-feed-mill-demo` / `verify-ai-guides` | 69 OK · 13 / 0 · 25 / 0 |

**Migration probe:** synthetic legacy rows inserted into all three tables →
`migrate-legacy-checklists.mjs` folded 3 entries (dedup by module vocabulary),
second run folded 0 (idempotent), probe rows deleted, `checklist_entries`
returned to 188.

## 6. Remaining issues / notes

* `verify-poultry-expense` 25/1 — pre-existing, unrelated to P3 (expense module).
* `verify-flock-plans` is timing-flaky (94–95/95); clean on re-run, no P3 code
  involved.
* Physical legacy tables stay in production (additive-only migrations); run
  `migrate-legacy-checklists.mjs` once before/after deploying this change to
  fold historical rows. They can be `DROP TABLE`-ed manually afterwards — the
  app no longer reads or writes them.
* Deferred P2 minors unchanged: product preset `!preset.thumb` guard,
  `EmployeeCenter.tsx pickPhoto` size guard, `/api/init` `photoThumb || photo`
  echo-back, two RESTOCK 2-col grids, expense-button wording.
