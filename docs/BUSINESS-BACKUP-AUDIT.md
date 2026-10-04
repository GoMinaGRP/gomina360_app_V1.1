# Business Export & Restore — audit, fixes, verification

Scope: the Business Export & Restore system
(`/api/business-backup/export`, `/api/business-backup/import`,
`src/lib/businessBackup.ts`, the Manage-Businesses download and
New-Business → Import backup flows).

Goal: exporting a business must carry **only that business and everything
needed to rebuild it**; importing must produce a **fully working unit under the
account performing the restore**, with no leakage, duplication or disruption.

## Findings (all fixed)

| # | Finding | Impact | Fix |
|---|---|---|---|
| 1 | **59 tables were missing from the export catalogue**, many business-scoped (budgets, procurement & goods receipts, approvals, action tasks, business documents, CRM interactions, fulfilment methods/options, all 8 transport tables, feed/mix formulations & batches, aquaculture/poultry benchmark profiles, advisor notes) | a restored unit silently lost those records | every business-scoped table added; child rows (formulation items, batch inputs, advisor note updates) pulled by parent id |
| 2 | `customerTrackings`, `creditSales`, `payrollRuns`, `payrollAttendance`, `attendanceLogs`, `employeeDocuments`, `employeeHistory` were **exported but never imported** | online orders, credit sales, payroll runs and HR history vanished on restore | added to the restore pipeline in dependency order |
| 3 | `suppliers` was looked up in the import catalogue but **never registered there** → vendor inserts silently did nothing | restored expense/purchase rows pointed at vendors that did not exist | registered in the catalogue + `insertTable` now warns loudly when a table is unknown |
| 4 | `remapUserId` returned the **raw source user id** | restored rows pointed at accounts of the source tenant — the same numeric id is a different person (or nobody) elsewhere | user ids never cross; nullable actor columns become NULL (name/role snapshots keep history readable), NOT NULL ones attach to the restoring account |
| 5 | Export embedded full **user account rows (email, phone, avatar, active flag, created-at)** for every actor | worker PII of unrelated accounts travelled in every archive | only `{id, name, role}` of actors that appear on an exported row |
| 6 | Customers were de-duplicated **globally by name+phone** | a restored business could bind to a customer row owned by another business/tenant — one mutable CRM record shared across tenants | customers are always re-created as private copies |
| 7 | Suppliers were de-duplicated **across all tenants**; source-supplier ids were matched against target ids by number | cross-tenant vendor linkage; wrong vendors attached | reuse only inside the importing organization, otherwise create; references go through the import map only |
| 8 | Source `owner_id` values were either copied (10 tables) or left NULL | data either looked like the source tenant's or became invisible to the importing org | every restored row is stamped with the importing organization |
| 9 | Import was **not transactional** | a failure mid-import left a half-populated business behind | one transaction for the whole restore + per-row SAVEPOINTs so a single bad row degrades to a warning |
| 10 | Globally-unique business codes (tracking codes, credit codes, purchase/quote/invoice/payment/receipt/requisition/task/batch numbers) collided with the rows still present in the source DB | those rows failed to restore | collision-checked suffixing with the new unit's code; the existing rows are never touched |
| 11 | Employees/customers/assets id maps were empty (transforms dropped `id` before the map was recorded) | every FK pointing at employees/customers (customer links, attendance, HR docs, orders) was dropped on restore | old id is read from the source row, not from the transformed values |
| 12 | Timestamp columns other than created/updated/recorded_at (clock-ins, receipt/QC dates) were fed ISO strings | "`toISOString is not a function`" — those rows failed to restore | ISO strings are converted to `Date` for timestamp columns (string-mode columns untouched) |
| 13 | Restored unit was only partially wired to its new account | a non-owner restorer could not see the unit; gaps (metrics/checklists) could remain | owner_id = importing org; access grant for the restoring account, GM grants for the org, gap-fill provisioning — the same contract as `POST /api/businesses` |
| 14 | Business settings (`pre_order_enabled`, `watermark_enabled`, `watermark_mode`) were not restored | storefront/pre-order behaviour changed after a restore | settings travel with the unit |
| 15 | A backup could carry rows of another business (hand-edited archive) | data could be smuggled into another unit | manifest is validated row-by-row on import; rejected with HTTP 400 |

## Deliberately NOT exported

Accounts/access (`users` beyond the display identity above, `organizations`,
`organization_members`, `user_business_access`, `advisor_assignments`,
`user_sessions`, push subscriptions/config), per-user `notifications`, and
tenant/platform configuration (`company_settings`, `system_markers`,
`integrations`, `payroll_statutory_config`, `customer_support_info`,
`record_deletion_logs`, unscoped approval policies). Restoring a unit never
grants a person access; that stays an explicit OWNER action in Users & Access.

## Verification

`dev-tooling/verify-business-backup.mjs` — **54 checks**, run against the real
app + real Postgres:

* export: single business row, no foreign rows, no account/PII/credential
  material, tenant/session tables absent, every required table present,
  child rows travel with parents, archive browsable;
* restore into a **different organization by a different account**: owner_id
  stamped on every row, no source-user references, private customer copies,
  vendors re-created per tenant, row-for-row table parity, FK remapping,
  circular references re-linked, importing account can open/export it while the
  source organization cannot see it;
* no disruption: source unit, sibling unit and another tenant's unit are
  row-for-row unchanged (checked immediately after the restore);
* permissions: worker without export/import grants → 403, another org's owner
  → 403, tampered archive → 400 with no rows written;
* repeat import creates a second distinct unit, first one untouched;
* conserved image thumbnails (`photo_thumb` / `photos_thumb`, generated by the
  upload-time optimizer — see `docs/IMAGE-OPTIMIZATION.md`) travel with the
  photos, so a restored unit keeps serving light list/menu images.

Regression suites re-run green after the changes: categories 30/30, boutique
74/74, order-page-regression 34/34, inventory-ui 12/12.

Follow-up fix found by this work: the audit surfaced that
`PATCH /api/businesses/[id]` re-provisioned a unit on a type change but returned
the result only as `reprovisioned`, while the editor reads `typeChange` — so the
"type changed … provisioned" notice never showed and `verify-manage-unit`'s E2
check could never pass. The response now carries `typeChange`, and E2 runs green
(`verify-manage-unit` 24/24).

## Notes / limits

* `?branchCode=` still exports the whole business for tables that have no
  branch column (unchanged behaviour, no isolation impact).
* Import always creates a NEW business; existing units are never overwritten.
* The restore transaction is one transaction per archive: very large archives
  hold it for the duration of the import (measured ~0.2 s for a typical unit).
