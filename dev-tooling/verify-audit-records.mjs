// Acceptance: Audit & Review → Records shows the COMPLETE underlying record
// for every record type (full fields + photos + related/child records), and
// every auditable activity (asset approvals/transfers, employee history,
// deletions, user/access activities) is linked back to the original entry.
// This runs end-to-end against the live app + DB, across multiple businesses
// and both the OWNER (full scope) and a scoped auditor (Emmanuel, business 2).
//
//   node dev-tooling/verify-audit-records.mjs

import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const pg = req("pg");

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const DB_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";

const client = new pg.Client(DB_URL);
await client.connect();
const q = async (sql, params) => (await client.query(sql, params)).rows;
const q1 = async (sql, params) => (await q(sql, params))[0] || null;

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ""}`); }
};

const IMG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`login ${email}: ${res.status} ${body.error || ""}`);
  return body.sessionToken;
}
const H = (token) => ({ "Content-Type": "application/json", "x-gomina-session": token });

async function auditList(token, extra = "") {
  const res = await fetch(`${BASE}/api/audit${extra}`, { headers: H(token) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function auditDetail(token, r) {
  const p = new URLSearchParams({ record: "1", recordType: r.recordType, recordId: String(r.recordId) });
  if (r.recordSource) p.set("recordSource", r.recordSource);
  const res = await fetch(`${BASE}/api/audit?${p.toString()}`, { headers: H(token) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ══ 1. Fixtures: seed representative auditable records with photos & links ══
console.log("── 1. Seed test fixtures ──");
const txId = (await q1(
  `INSERT INTO transactions (transaction_number, business_id, branch_code, type, category, amount_ghs, payment_method, customer_id, supplier_id, description, date, status, recorded_by, recorded_by_role, recorded_by_user_id, receipt_images)
   VALUES ($1, 1, NULL, 'EXPENSE', 'Feed Expense', 1250.5, 'MTN_MOMO', NULL, 1, 'AUDTEST feed purchase with receipts', '2026-09-08', 'COMPLETED', 'Kwame Mina', 'OWNER', 1, $2::jsonb) RETURNING id`,
  [`AUDTEST-${Date.now()}`, JSON.stringify([IMG, IMG])]
)).id;

const invId = (await q1(
  `INSERT INTO inventory_items (name, sku, business_id, branch_code, category, quantity, unit, cost_price_ghs, selling_price_ghs, min_stock_threshold, status, expiry_date, photos, registered_by_name, registered_by_user_id)
   VALUES ('AUDTEST Layer Mash 50kg', $1, 2, 'BLOCK-01', 'Poultry Feed', 240, 'Bags', 180, 210, 20, 'IN_STOCK', '2026-12-31', $2::jsonb, 'Emmanuel Osei', 3) RETURNING id`,
  [`AUDTEST-SKU-${Date.now()}`, JSON.stringify([IMG, IMG, IMG])]
)).id;

// Asset activity on the existing business-2 block machine.
const astActId = (await q1(
  `INSERT INTO asset_audit_logs (asset_id, asset_code, action, status, requested_by_name, requested_by_role, details_json)
   VALUES (2, 'BLOCK-01-AST-0001', 'TRANSFER', 'APPROVED', 'Kofi Boahen', 'BRANCH_MANAGER', '{"from":"Spintex Road","to":"Adjiringanor"}') RETURNING id`
)).id;

// Deletion log with a full snapshot (photos preserved).
const delId = (await q1(
  `INSERT INTO record_deletion_logs (module, record_id, record_label, record_snapshot, reason, deleted_by_name, deleted_by_role)
   VALUES ('TRANSACTIONS', 999999, $1, $2::jsonb, 'AUDTEST duplicate entry removed', 'Kwame Mina', 'OWNER') RETURNING id`,
  [`AUDTEST-DEL-${Date.now()}`, JSON.stringify({ businessId: 1, branchCode: "POULTRY-01", amountGhs: 77.25, description: "Deleted duplicate sale", photos: [IMG] })]
)).id;

console.log(`  fixtures: tx=${txId} inv=${invId} astAct=${astActId} del=${delId}`);

try {
  // ══ 2. OWNER sees the complete record universe ══
  console.log("── 2. OWNER record universe ──");
  const ownerToken = await login("kwame.owner@gomina360.com", "Owner@GoMina26");
  const full = await auditList(ownerToken);
  ok("O1 /api/audit 200", full.status === 200, `HTTP ${full.status}`);
  const recs = full.body?.records || [];
  const types = new Set(recs.map((r) => r.recordType));
  ok("O2 core types present (TRANSACTION, INVENTORY_ITEM, EMPLOYEE, PAYROLL_RUN, ASSET, CHECKLIST, CCTV, OPERATION_LOG)",
    ["TRANSACTION", "INVENTORY_ITEM", "EMPLOYEE", "PAYROLL_RUN", "ASSET", "CHECKLIST", "CCTV_CAMERA", "OPERATION_LOG"].every((t) => types.has(t)),
    [...types].join(","));
  ok("O3 activity types linked in (ASSET_ACTIVITY, EMPLOYEE_HISTORY, USER_ACTIVITY, DELETION)",
    ["ASSET_ACTIVITY", "EMPLOYEE_HISTORY", "USER_ACTIVITY"].every((t) => types.has(t)),
    [...types].join(","));

  const txRow = recs.find((r) => r.recordType === "TRANSACTION" && r.recordId === txId);
  ok("O4 fixture transaction visible with imageCount", !!txRow && (txRow.imageCount || 0) >= 2, JSON.stringify(txRow?.imageCount));
  const invRow = recs.find((r) => r.recordType === "INVENTORY_ITEM" && r.recordId === invId);
  ok("O5 fixture inventory visible with imageCount", !!invRow && (invRow.imageCount || 0) >= 3, JSON.stringify(invRow?.imageCount));
  ok("O6 DELETION fixture visible", recs.some((r) => r.recordType === "DELETION" && r.recordId === delId));
  ok("O7 USERS module reported", (full.body?.report?.byModule || []).some((m) => m.module === "USERS"));

  // ══ 3. Detail drawer: complete underlying record ══
  console.log("── 3. OWNER opens complete records ──");
  const td = await auditDetail(ownerToken, txRow);
  ok("D1 transaction detail loads", td.status === 200 && td.body?.detail, `HTTP ${td.status}`);
  ok("D2 transaction full row (amount/description/method/payer)", td.body?.detail?.record?.amountGhs === 1250.5 && !!td.body.detail.record.description && td.body.detail.record.recordedBy === "Kwame Mina");
  ok("D3 transaction receipts surfaced as photos", (td.body?.detail?.photos || []).length >= 2, `photos=${td.body?.detail?.photos?.length}`);
  ok("D4 transaction links its supplier", (td.body?.detail?.related || []).some((x) => x.recordType === "SUPPLIER" && x.recordId === 1), JSON.stringify((td.body?.detail?.related || []).map((x) => x.recordType)));

  const idD = await auditDetail(ownerToken, invRow);
  ok("D5 inventory full row (quantity/prices/expiry)", idD.body?.detail?.record?.quantity === 240 && idD.body.detail.record.sellingPriceGhs === 210 && !!idD.body.detail.record.expiryDate);
  ok("D6 inventory photos surfaced", (idD.body?.detail?.photos || []).length >= 3, `photos=${idD.body?.detail?.photos?.length}`);

  const runRow = recs.find((r) => r.recordType === "PAYROLL_RUN" && r.recordId === 1);
  const runD = await auditDetail(ownerToken, runRow);
  ok("D7 payroll run links its employee entries", (runD.body?.detail?.related || []).filter((x) => x.recordType === "PAYROLL_ENTRY").length >= 1, JSON.stringify((runD.body?.detail?.related || []).map((x) => x.recordType)));

  const empRow = recs.find((r) => r.recordType === "EMPLOYEE" && r.recordId === 1);
  const empD = await auditDetail(ownerToken, empRow);
  ok("D8 employee links history/payroll records", (empD.body?.detail?.related || []).some((x) => x.recordType === "EMPLOYEE_HISTORY" || x.recordType === "PAYROLL_ENTRY"));

  const astActRow = recs.find((r) => r.recordType === "ASSET_ACTIVITY" && r.recordId === astActId);
  ok("D9 asset activity appears", !!astActRow);
  const astActD = await auditDetail(ownerToken, astActRow);
  ok("D10 asset activity links back to the live asset", (astActD.body?.detail?.related || []).some((x) => x.recordType === "ASSET" && x.recordId === 2));

  const delRow = recs.find((r) => r.recordType === "DELETION" && r.recordId === delId);
  const delD = await auditDetail(ownerToken, delRow);
  ok("D11 deletion preserves the snapshot + photos", delD.body?.detail?.record?.recordSnapshot?.amountGhs === 77.25 && (delD.body?.detail?.photos || []).length >= 1);

  const userActRow = recs.find((r) => r.recordType === "USER_ACTIVITY");
  if (userActRow) {
    const uaD = await auditDetail(ownerToken, userActRow);
    ok("D12 user activity detail loads (actor + target)", uaD.status === 200 && !!uaD.body?.detail?.record?.targetLabel, `HTTP ${uaD.status}`);
  } else ok("D12 user activity detail loads", false, "no USER_ACTIVITY row");

  // Related-row jump: open the supplier linked from the transaction.
  const supRel = (td.body?.detail?.related || []).find((x) => x.recordType === "SUPPLIER");
  const supD = await auditDetail(ownerToken, supRel);
  ok("D13 related supplier opens to its own full record", supD.status === 200 && supD.body?.detail?.record?.name === "Ghafeed Poultry Mills Ltd", `HTTP ${supD.status}`);

  // ══ 4. Scoped auditor: business 2 only, all modules, branch consistency ══
  console.log("── 4. Scoped auditor (Emmanuel, business 2) ──");
  const emToken = await login("emmanuel@gomina360.com", "GoMina@User3");
  const em = await auditList(emToken);
  ok("S1 scoped auditor list 200", em.status === 200, `HTTP ${em.status}`);
  const emRecs = em.body?.records || [];
  ok("S2 scope enforced: only business 2 (and no out-of-branch)", emRecs.length > 0 && emRecs.every((r) => r.businessId === 2), JSON.stringify([...new Set(emRecs.map((r) => r.businessId))]));
  ok("S3 fixture inventory (business 2) visible to scoped auditor", emRecs.some((r) => r.recordId === invId && r.recordType === "INVENTORY_ITEM"));
  ok("S4 business-1 transaction NOT visible to scoped auditor", !emRecs.some((r) => r.recordId === txId));

  const emInv = emRecs.find((r) => r.recordId === invId);
  const emInvD = await auditDetail(emToken, emInv);
  ok("S5 scoped auditor opens in-scope record detail", emInvD.status === 200 && (emInvD.body?.detail?.photos || []).length >= 3, `HTTP ${emInvD.status}`);

  const emTxD = await auditDetail(emToken, { recordType: "TRANSACTION", recordSource: "transactions", recordId: txId });
  ok("S6 scoped auditor blocked from out-of-scope record detail (403)", emTxD.status === 403, `HTTP ${emTxD.status}`);

  const emSupD = await auditDetail(emToken, supRel);
  ok("S7 shared supplier directory visible to scoped auditor", emSupD.status === 200 && emSupD.body?.detail?.record?.id === 1, `HTTP ${emSupD.status}`);

  // A non-auditor worker gets nothing.
  const workerToken = await login("comfort.agbenyega@gomina360.com", "GoMina@User13");
  const wk = await auditList(workerToken);
  ok("S8 non-granted worker still blocked (403)", wk.status === 403, `HTTP ${wk.status}`);
} finally {
  // ══ cleanup ══
  await q(`DELETE FROM transactions WHERE id = $1`, [txId]);
  await q(`DELETE FROM inventory_items WHERE id = $1`, [invId]);
  await q(`DELETE FROM asset_audit_logs WHERE id = $1`, [astActId]);
  await q(`DELETE FROM record_deletion_logs WHERE id = $1`, [delId]);
  await client.end();
}

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
