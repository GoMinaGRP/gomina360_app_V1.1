/**
 * verify-p4-writers.mjs — P4 (correctness writers) consolidation suite.
 *
 * Proves, end-to-end through the real API + real database, the P4 fixes:
 *
 *   A · CRM single matcher — an ONLINE order (`/api/order`, the path that used
 *       to run its own find-or-create in `lib/trackingServer`) and a TILL sale
 *       (`/api/sales`) for the same phone number resolve to ONE customer row,
 *       and an anonymous "Walk-in Customer" order creates none.
 *   B · Document numbering — receipts from the till sale and from a credit
 *       instalment both use the shared generator: RCP-YYYY-NNNN, unique,
 *       monotonically increasing (no clock-derived duplicates).
 *   C · Transaction numbering — every new ledger row uses TRX-YYYY-########
 *       from `nextTrxNumber` and is unique.
 *   D · Employee single writer — the QR/quick-add path (`/api/enterprise`) and
 *       the full registration path (`/api/employees`) share one create core:
 *       continuous EMP-#### numbering per unit + a CREATED history row each.
 *   E · CRM indexes — the (businessId, phone) / (businessId, name) match
 *       indexes exist in Postgres.
 *   F · Tenant isolation — nothing the run creates leaks into another unit.
 *
 * Everything is tagged TEST-P4- and purged in the finally block.
 */
import { createRequire } from "node:module";
const require = createRequire("/home/user/pgtooling/package.json");
const { Client } = require("pg");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.GOMINA_OWNER_PW || "Owner@GoMina26" };

let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}${extra ? ` — ${extra}` : ""}`); }
};

const client = new Client({ connectionString: DB });
const q = async (sql, params = []) => (await client.query(sql, params)).rows;
const q1 = async (sql, params = []) => (await q(sql, params))[0];

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: OWNER.email, password: OWNER.pw }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`login failed: ${res.status} ${body.error || ""}`);
  return body.sessionToken || body.token;
}
const H = (t) => ({ "Content-Type": "application/json", "x-gomina-session": t });
const call = async (t, path, method = "GET", body = null) => {
  const res = await fetch(`${BASE}${path}`, { method, headers: H(t), body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const pub = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const TAG = "TEST-P4";
const stamp = Date.now().toString().slice(-6);

const purge = async () => {
  try {
    await client.query(`delete from customer_trackings where customer_name like $1`, [`${TAG}%`]).catch(() => {});
    await client.query(`delete from sales_documents where customer_name like $1`, [`${TAG}%`]).catch(() => {});
    await client.query(`delete from transactions where description like $1`, [`%${TAG}%`]).catch(() => {});
    await client.query(`delete from credit_sales where customer_name like $1`, [`${TAG}%`]).catch(() => {});
    await client.query(`delete from customers where name like $1 or phone like $2`, [`${TAG}%`, `%${stamp}%`]).catch(() => {});
    await client.query(`delete from inventory_items where sku like $1`, [`${TAG}%`]).catch(() => {});
    await client.query(`delete from employee_history where employee_id in (select id from employees where name like $1)`, [`${TAG}%`]).catch(() => {});
    await client.query(`delete from employees where name like $1`, [`${TAG}%`]).catch(() => {});
    await client.query(`delete from payroll_entries where employee_name like $1`, [`${TAG}%`]).catch(() => {});
  } catch (e) {
    console.error("purge warning:", e.message);
  }
};

await client.connect();
let token = null;
try {
  await purge();
  token = await login();
  ok("owner session established", !!token);

  const biz = Object.fromEntries(
    (await q(`select id, code from businesses where code in ('HARDWARE-01','POULTRY-01')`)).map((r) => [r.code, r.id]),
  );
  const HW = biz["HARDWARE-01"], OTHER = biz["POULTRY-01"];
  ok("fixture businesses present", !!(HW && OTHER), JSON.stringify(biz));

  const hwItem = await q1(
    `insert into inventory_items (name, sku, business_id, category, quantity, unit, cost_price_ghs, selling_price_ghs, min_stock_threshold, status)
     values ($1,$2,$3,'TEST',50,'Units',10,20,1,'IN_STOCK') returning id`,
    [`${TAG} Item`, `${TAG}-ITEM-${stamp}`, HW],
  );
  const phone = `024${stamp}7`; // 10 digits as the storefront validator requires

  /* ══════════════ E. CRM match indexes ══════════════ */
  console.log("\n── E. CRM match indexes ──");
  const idx = (await q(`select indexname from pg_indexes where tablename='customers'`)).map((r) => r.indexname);
  ok("(businessId, phone) index present", idx.includes("customers_business_phone_idx"), idx.join(","));
  ok("(businessId, name) index present", idx.includes("customers_business_name_idx"), idx.join(","));

  /* ══════════════ A. ONE CRM matcher ══════════════ */
  console.log("\n── A. CRM single matcher (online order ↔ till sale) ──");
  const online = await pub("/api/order", {
    businessId: HW, customerName: `${TAG} Online Buyer`, customerPhone: phone,
    fulfillmentType: "PICKUP", paymentChoice: "ON_DELIVERY",
    items: [{ inventoryId: hwItem.id, quantity: 1 }],
  });
  const code = online.body?.trackingCode;
  ok("online order placed", online.status === 200 && /^GM-/.test(code || ""), JSON.stringify(online.body || {}).slice(0, 160));
  const c1 = await q(`select * from customers where business_id=$1 and phone=$2`, [HW, phone]);
  ok("online order opens exactly ONE CRM row", c1.length === 1, `rows=${c1.length}`);

  // Same phone, DIFFERENT name, through the till (postSale → linkOrCreateCustomer).
  const sale = await call(token, "/api/sales", "POST", {
    businessId: HW, branchCode: "HARDWARE-01", customerName: `${TAG} Till Alias`, customerPhone: phone,
    paymentMethod: "CASH", cartItems: [{ inventoryId: hwItem.id, quantity: 1, sellingPrice: 20 }],
    createdByName: "Suite", createdByRole: "OWNER",
  });
  ok("till sale accepted", sale.status === 200, JSON.stringify(sale.body || {}).slice(0, 160));
  const c2 = await q(`select * from customers where business_id=$1 and phone=$2`, [HW, phone]);
  ok("till sale with a different name REUSES the same CRM row (phone match)",
    c1.length === 1 && c2.length === 1 && c2[0].id === c1[0].id,
    `online=${c1.length} afterTill=${c2.length} ids=${c1.map((r) => r.id).join("/")}→${c2.map((r) => r.id).join("/")}`);
  ok("spend accrued on the shared row", Number(c2[0]?.total_spent_ghs || 0) >= 20,
    `totalSpent=${c2[0]?.total_spent_ghs}`);

  // Anonymous buyer — must never create a CRM row (matchOnly rule preserved
  // from the pre-refactor trackingServer matcher).
  const before = Number((await q1(`select count(*)::int c from customers where business_id=$1`, [HW])).c);
  const anonPhone = `025${stamp}8`;
  const anon = await pub("/api/order", {
    businessId: HW, customerName: "Walk-in Customer", customerPhone: anonPhone, fulfillmentType: "PICKUP",
    paymentChoice: "ON_DELIVERY", items: [{ inventoryId: hwItem.id, quantity: 1 }],
  });
  const after = Number((await q1(`select count(*)::int c from customers where business_id=$1`, [HW])).c);
  const anonRow = await q(`select id from customers where business_id=$1 and phone=$2`, [HW, anonPhone]);
  ok("anonymous order creates NO CRM row", anon.status === 200 && after === before && anonRow.length === 0,
    `status=${anon.status} before=${before} after=${after} rows=${anonRow.length} ${JSON.stringify(anon.body || {}).slice(0, 120)}`);

  /* ══════════════ B. Shared document numbering ══════════════ */
  console.log("\n── B. Document numbering ──");
  const receipts = await q(
    `select document_number from sales_documents where business_id=$1 and document_type='RECEIPT' and customer_name like $2`,
    [HW, `${TAG}%`],
  );
  // The sequence continues from the highest already-issued number, so legacy
  // clock-derived numbers (e.g. RCP-2026-816452) keep receipts monotonic.
  const legacyMax = Number((await q1(
    `select coalesce(max(nullif(regexp_replace(document_number, '^.*-', ''), '')::bigint), 0) m
     from sales_documents where document_number like 'RCP-2026-%' and customer_name not like $1`,
    [`${TAG}%`],
  )).m);
  ok("till receipt uses the shared sequence (RCP-YYYY-N, monotonic)",
    receipts.length === 1 && /^RCP-\d{4}-\d+$/.test(receipts[0].document_number) &&
      Number(receipts[0].document_number.split("-").pop()) > legacyMax,
    `receipt=${receipts[0]?.document_number} legacyMax=${legacyMax}`);

  // Credit sale → instalment receipt + invoice, both through the generator.
  const credit = await call(token, "/api/credit-sales", "POST", {
    businessId: HW, branchCode: "HARDWARE-01", customerName: `${TAG} Credit Buyer`, customerPhone: `027${stamp}7`,
    cartItems: [{ inventoryId: hwItem.id, quantity: 1 }], depositGhs: 5, createdByName: "Suite", createdByRole: "OWNER",
  });
  const creditDocs = await q(
    `select document_number, document_type from sales_documents where business_id=$1 and customer_name like $2 order by id`,
    [HW, `${TAG} Credit Buyer`],
  );
  ok("credit sale created (deposit posted)", credit.status === 200, JSON.stringify(credit.body || {}).slice(0, 160));
  ok("credit documents use the shared sequence",
    creditDocs.length >= 1 && creditDocs.every((d) => /^(RCP|INV)-\d{4}-\d+$/.test(d.document_number)),
    creditDocs.map((d) => d.document_number).join(","));
  const dupes = await q(
    `select document_number, count(*)::int c from sales_documents where document_number like 'RCP-%' or document_number like 'INV-%'
     group by document_number having count(*) > 1`,
  );
  ok("no duplicate document numbers anywhere", dupes.length === 0, JSON.stringify(dupes));

  /* ══════════════ C. Transaction numbering ══════════════ */
  console.log("\n── C. Transaction numbering ──");
  const txns = await q(
    `select transaction_number from transactions where business_id=$1 and (description like $2 or category='Inventory Sale') and created_at > now() - interval '10 minutes'`,
    [HW, `%${TAG}%`],
  );
  ok("new ledger rows use TRX-YYYY-########", txns.length > 0 && txns.every((t) => /^TRX-\d{4}-\d{8}$/.test(t.transaction_number)),
    txns.map((t) => t.transaction_number).join(","));
  const txnDupes = await q(
    `select transaction_number, count(*)::int c from transactions group by transaction_number having count(*) > 1 limit 5`,
  );
  ok("no duplicate transaction numbers", txnDupes.length === 0, JSON.stringify(txnDupes));

  /* ══════════════ D. Employee single writer ══════════════ */
  console.log("\n── D. Employee create core (quick-add ↔ full registration) ──");
  const empBefore = Number(
    (await q1(`select count(*)::int c from employees where business_id=$1 and employee_no like 'EMP-%'`, [HW])).c,
  );
  const quick = await call(token, "/api/enterprise", "POST", {
    entityType: "employee",
    data: { businessId: HW, name: `${TAG} QuickAdd`, role: "Loader", salaryGhs: 1200, branch: "HW Yard" },
  });
  const quickId = quick.body?.item?.id;
  ok("quick-add employee created", quick.status === 200 && !!quickId, JSON.stringify(quick.body || {}).slice(0, 160));
  const full = await call(token, "/api/employees", "POST", {
    data: { businessId: HW, name: `${TAG} FullReg`, role: "Cashier", salaryGhs: 1500, branch: "HW Front" },
  });
  const fullId = full.body?.employee?.id;
  ok("full registration employee created", full.status === 200 && !!fullId, JSON.stringify(full.body || {}).slice(0, 160));

  const empRows = await q(
    `select id, name, employee_no from employees where id = any($1::int[]) order by id`,
    [[quickId, fullId].filter(Boolean)],
  );
  const nums = empRows.map((r) => Number(String(r.employee_no || "").replace(/\D/g, "")) || 0);
  ok("both paths number EMP-#### from one generator",
    empRows.length === 2 && empRows.every((r) => /^EMP-\d{4}$/.test(r.employee_no)),
    empRows.map((r) => `${r.name}:${r.employee_no}`).join(" | "));
  ok("quick-add continues the unit's sequence (no reuse, no collision)",
    nums.length === 2 && new Set(nums).size === 2 && Math.max(...nums) === empBefore + 2,
    `nums=${nums.join(",")} before=${empBefore}`);

  const hist = await q(
    `select employee_id, action from employee_history where employee_id = any($1::int[]) order by id`,
    [[quickId, fullId].filter(Boolean)],
  );
  ok("each create writes its CREATED history row",
    hist.filter((h) => h.action === "CREATED").length === 2,
    JSON.stringify(hist));

  /* ══════════════ F. Tenant isolation ══════════════ */
  console.log("\n── F. Tenant isolation ──");
  const leakCust = await q(`select id from customers where business_id=$1 and phone=$2`, [OTHER, phone]);
  ok("buyer row never leaks into another unit", leakCust.length === 0);
  const leakEmp = await q(`select id from employees where business_id=$1 and name like $2`, [OTHER, `${TAG}%`]);
  const empBiz = await q(`select id, business_id from employees where id = any($1::int[])`, [[quickId, fullId].filter(Boolean)]);
  ok("employee rows never leak into another unit",
    leakEmp.length === 0 && empBiz.every((r) => Number(r.business_id) === HW),
    `leaks=${leakEmp.length} biz=${empBiz.map((r) => r.business_id).join(",")}`);

} finally {
  await purge();
  await client.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
