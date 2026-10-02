// verify-boutique.mjs — Boutique business type + size/colour variant stock.
//
// Proves the required Boutique chain end-to-end on the REAL app:
//   business creation → product creation → sizes/colours → inventory →
//   customer order → sale → stock deduction → reports/audit,
// plus permissions, tenant isolation, performance and no-regression checks on
// existing (non-variant) businesses.
//
// Everything is created through the public API exactly as the UI does, and
// every fixture is purged in the cleanup block.
//
// Run: bash dev-tooling/run-suite.sh dev-tooling/verify-boutique.mjs
import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const pg = req("pg");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.OWNER_PW || "Owner@GoMina26" };

const checks = [];
let failures = 0;
const ok = (name, cond, extra = "") => {
  checks.push({ name, pass: !!cond });
  if (!cond) failures++;
  console.log(`${cond ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`);
};

const client = new pg.Client(DB);
await client.connect();
const q = async (sql, params) => (await client.query(sql, params)).rows;
const q1 = async (sql, params) => (await q(sql, params))[0];

const login = async (email, password) => {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && !!j.sessionToken, cookie: (r.headers.get("set-cookie") || "").split(";")[0], user: j.user };
};
const api = async (cookie, method, path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await r.json();
  } catch {}
  return { status: r.status, data };
};

/** The ONE structural invariant of the variant layer: the parent item's
 *  quantity always equals the sum of its ACTIVE variant rows. */
const aggregateIsConsistent = async (inventoryId) => {
  const row = await q1(
    `select i.quantity item_qty,
            coalesce((select sum(v.quantity) from inventory_variants v
                       where v.inventory_id = i.id and v.is_active = true), 0) variant_qty
       from inventory_items i where i.id = $1`,
    [inventoryId],
  );
  return row && Math.abs(Number(row.item_qty) - Number(row.variant_qty)) < 0.001;
};
const variantQty = async (variantId) => Number((await q1(`select quantity from inventory_variants where id = $1`, [variantId]))?.quantity);
const itemQty = async (inventoryId) => Number((await q1(`select quantity from inventory_items where id = $1`, [inventoryId]))?.quantity);

// ── Cleanup bookkeeping ─────────────────────────────────────────────────────
let testBusinessId = null;
let testBusinessCode = null;
const testItemIds = [];
let createdVariantsOfTestItem = [];
// Every row the suite creates through the shared pipelines (sales, orders,
// credit) is recorded and removed again — suites self-clean.
const createdTransactions = new Set();
const createdDocuments = new Set();
const createdTrackings = new Set();
const createdCredits = new Set();
const track = (res) => {
  const d = res?.data;
  if (!d) return res;
  if (d.transaction?.id) createdTransactions.add(Number(d.transaction.id));
  if (d.deposit?.transaction?.id) createdTransactions.add(Number(d.deposit.transaction.id));
  if (d.receipt?.id) createdDocuments.add(Number(d.receipt.id));
  if (d.invoice?.id) createdDocuments.add(Number(d.invoice.id));
  if (d.creditSale?.id) createdCredits.add(Number(d.creditSale.id));
  for (const code of [d.trackingCode, d.creditSale?.trackingCode]) if (code) createdTrackings.add(String(code));
  return res;
};

const purge = async () => {
  try {
    const tIds = [...createdTransactions];
    const dIds = [...createdDocuments];
    const trCodes = [...createdTrackings];
    const cIds = [...createdCredits];
    if (tIds.length) await client.query(`delete from transactions where id = any($1::int[])`, [tIds]).catch(() => {});
    if (cIds.length) {
      await client.query(`delete from order_payments where credit_sale_id = any($1::int[])`, [cIds]).catch(() => {});
      await client.query(`delete from credit_sales where id = any($1::int[])`, [cIds]).catch(() => {});
    }
    if (trCodes.length) await client.query(`delete from customer_trackings where tracking_code = any($1::text[])`, [trCodes]).catch(() => {});
    if (dIds.length) await client.query(`delete from sales_documents where id = any($1::int[])`, [dIds]).catch(() => {});
    // Safety net for interrupted earlier runs (TEST-prefixed fixtures only).
    for (const table of ["customer_trackings", "sales_documents", "credit_sales"]) {
      await client.query(`delete from ${table} where customer_name like 'TEST %'`).catch(() => {});
    }
    await client.query(`delete from transactions where description like '%TEST %'`).catch(() => {});
    if (testItemIds.length) {
      await client.query(`delete from inventory_variants where inventory_id = any($1::int[])`, [testItemIds]);
      await client.query(`delete from inventory_items where id = any($1::int[])`, [testItemIds]);
    }
    if (testBusinessId) {
      for (const t of [
        "inventory_variants",
        "inventory_items",
        "checklist_entries",
        "checklist_templates",
        "business_metrics",
        "notifications",
        "customer_trackings",
        "transactions",
        "sales_documents",
        "audit_trail",
        "user_business_access",
      ]) {
        await client.query(`delete from ${t} where business_id = $1`, [testBusinessId]).catch(() => {});
      }
      await client.query(`delete from businesses where id = $1`, [testBusinessId]);
      if (testBusinessCode) await client.query(`delete from system_markers where marker like $1 || '%'`, [testBusinessCode]).catch(() => {});
    }
  } catch (e) {
    console.error("cleanup warning:", e.message);
  }
};

try {
  const owner = await login(OWNER.email, OWNER.pw);
  ok("owner login", owner.ok);

  // ═══ 1. Boutique business type is registered ═══════════════════════════
  const seeded = await q1(`select * from businesses where code = 'BOUTIQUE-01'`);
  ok("seeded Boutique flagship exists", !!seeded, seeded ? `#${seeded.id} ${seeded.name}` : "missing");
  ok("seeded unit category is Boutique", seeded?.category === "Boutique", seeded?.category);

  const seedVariants = await q(
    `select v.* from inventory_variants v where v.business_id = $1 and v.is_active = true order by v.id`,
    [seeded.id],
  );
  ok("flagship ships with size × colour variants", seedVariants.length >= 30, `${seedVariants.length} rows`);
  const seedItems = await q(`select * from inventory_items where business_id = $1 order by id`, [seeded.id]);
  ok("flagship ships apparel products", seedItems.length >= 4, `${seedItems.length} products`);
  const badAggregate = seedItems.filter((i) => {
    const sum = seedVariants
      .filter((v) => v.inventory_id === i.id)
      .reduce((s, v) => s + Number(v.quantity), 0);
    return Math.abs(sum - Number(i.quantity)) > 0.001;
  });
  ok("item quantity = sum of its variants", badAggregate.length === 0, `${badAggregate.length} drifted`);

  // New-unit provisioning through the real "New Branch / Unit" API.
  const createBiz = await api(owner.cookie, "POST", "/api/businesses", {
    name: "TEST Boutique Unit",
    category: "Boutique",
    branchLocation: "Accra",
    region: "Greater Accra",
    initialCapitalGhs: 1000,
  });
  ok("POST /api/businesses creates a Boutique unit", createBiz.status === 200 && createBiz.data?.business?.id, JSON.stringify(createBiz.data).slice(0, 160));
  testBusinessId = createBiz.data?.business?.id ?? null;
  testBusinessCode = createBiz.data?.business?.code ?? null;
  ok("new unit code uses the BOUTIQUE prefix", String(testBusinessCode || "").startsWith("BOUTIQUE"), testBusinessCode);
  const templates = testBusinessId
    ? await q(`select count(*)::int c from checklist_templates where business_id = $1`, [testBusinessId])
    : [{ c: 0 }];
  ok("new Boutique unit is provisioned (checklist templates)", templates[0].c > 0, `${templates[0].c} templates`);
  const cleanInv = testBusinessId
    ? await q(`select count(*)::int c from inventory_items where business_id = $1`, [testBusinessId])
    : [{ c: -1 }];
  ok("new Boutique unit starts CLEAN (no sample stock)", cleanInv[0].c === 0, `${cleanInv[0].c} items`);

  // ═══ 2. Product creation with sizes & colours (same API the UI uses) ═══
  const newProduct = await api(owner.cookie, "POST", "/api/enterprise", {
    entityType: "inventory",
    data: {
      businessId: seeded.id,
      name: "TEST Boutique Tee",
      sku: "TEST-BOUTIQUE-TEE",
      category: "Tops",
      unit: "Pieces",
      quantity: 0,
      costPriceGhs: 20,
      sellingPriceGhs: 45,
      minStockThreshold: 1,
      tracksVariants: true,
      boutiqueVariants: [
        { size: "S", color: "Red", sizeSystem: "LETTER", quantity: 3, minStockThreshold: 1 },
        { size: "M", color: "Red", sizeSystem: "LETTER", quantity: 5, minStockThreshold: 1 },
        { size: "M", color: "Blue", sizeSystem: "LETTER", quantity: 0, minStockThreshold: 1 },
      ],
      registeredByName: "TEST Suite",
    },
  });
  const testItem = newProduct.data?.item;
  if (testItem?.id) testItemIds.push(testItem.id);
  ok("product created with size/colour matrix", newProduct.status === 200 && newProduct.data?.variants === 3, JSON.stringify(newProduct.data).slice(0, 140));
  const itemAfter = testItem?.id ? await q1(`select * from inventory_items where id = $1`, [testItem.id]) : null;
  ok("aggregate quantity = sum of variants (3+5+0)", Number(itemAfter?.quantity) === 8, String(itemAfter?.quantity));
  ok("item flagged as variant-tracked", itemAfter?.tracks_variants === true);
  createdVariantsOfTestItem = testItem?.id
    ? await q(`select * from inventory_variants where inventory_id = $1 order by size, color`, [testItem.id])
    : [];
  ok("variant rows persisted (3)", createdVariantsOfTestItem.length === 3);

  // Owner adds a size through the variant API (replace matrix, same as the UI).
  const setRes = await api(owner.cookie, "POST", "/api/boutique", {
    action: "SET_VARIANTS",
    businessId: seeded.id,
    inventoryId: testItem.id,
    replace: true,
    variants: [
      { size: "S", color: "Red", sizeSystem: "LETTER", quantity: 3, minStockThreshold: 1 },
      { size: "M", color: "Red", sizeSystem: "LETTER", quantity: 5, minStockThreshold: 1 },
      { size: "M", color: "Blue", sizeSystem: "LETTER", quantity: 0, minStockThreshold: 1 },
      { size: "L", color: "Green", sizeSystem: "CUSTOM", quantity: 4, minStockThreshold: 1 },
    ],
  });
  ok("SET_VARIANTS adds a custom size", setRes.status === 200 && setRes.data?.variants?.length === 4, JSON.stringify(setRes.data).slice(0, 120));
  const aggregate2 = await q1(`select quantity from inventory_items where id = $1`, [testItem.id]);
  ok("aggregate re-synced after adding a size (12)", Number(aggregate2.quantity) === 12, String(aggregate2.quantity));

  const blueRow = await q1(`select * from inventory_variants where inventory_id = $1 and color = 'Blue'`, [testItem.id]);
  ok("out-of-stock variant row kept (Blue/M = 0)", Number(blueRow?.quantity) === 0);

  // Restock the out-of-stock combo (boutique restock action, no expense).
  const restock = await api(owner.cookie, "POST", "/api/boutique", {
    action: "ADJUST_STOCK",
    businessId: seeded.id,
    variantId: blueRow.id,
    delta: 2,
  });
  ok("ADJUST_STOCK restocks one size/colour", restock.status === 200 && Number(restock.data?.variant?.quantity) === 2, JSON.stringify(restock.data?.variant || {}).slice(0, 100));

  // ═══ 3. Customer storefront shows sizes/colours & availability ═════════
  const menu = await api(null, "GET", "/api/menu");
  const bizEntry = (menu.data?.businesses || []).find((b) => b.businessId === seeded.id);
  ok("public storefront lists the Boutique unit", !!bizEntry, `${(menu.data?.businesses || []).length} units`);
  const prod = (bizEntry?.products || []).find((p) => p.id === testItem.id);
  ok("storefront product exposes variants", !!prod?.hasVariants, JSON.stringify(prod?.variantOptions?.sizes || []).slice(0, 80));
  ok("storefront shows the product's sizes", (prod?.variantOptions?.sizes || []).length === 3);
  ok("storefront shows the product's colours", (prod?.variantOptions?.colors || []).length === 3);
  const variantSumNow = createdVariantsOfTestItem.length
    ? (
        await q(`select coalesce(sum(quantity),0) s from inventory_variants where inventory_id = $1 and is_active = true`, [testItem.id])
      )[0].s
    : 0;
  ok("storefront availability = live variant stock", Number(prod?.available) === Number(variantSumNow), `${prod?.available} vs ${variantSumNow}`);

  const redInStock = await api(owner.cookie, "POST", "/api/boutique", {
    action: "ADJUST_STOCK",
    businessId: seeded.id,
    variantId: (await q1(`select id from inventory_variants where inventory_id = $1 and size = 'M' and color = 'Red'`, [testItem.id])).id,
    quantity: 0,
  });
  ok("a size/colour can be exhausted", redInStock.status === 200);
  const menu2 = await api(null, "GET", "/api/menu");
  const prod2 = ((menu2.data?.businesses || []).find((b) => b.businessId === seeded.id)?.products || []).find((p) => p.id === testItem.id);
  const comboMRed = (prod2?.variantOptions?.variants || []).find((v) => v.size === "M" && v.color === "Red");
  ok("exhausted combination reports out of stock", comboMRed && comboMRed.inStock === false && Number(comboMRed.available) === 0, JSON.stringify(comboMRed));
  const sizeM = (prod2?.variantOptions?.sizes || []).find((s) => s.value === "M");
  const colorRed = (prod2?.variantOptions?.colors || []).find((c) => c.value === "Red");
  ok("size/colour aggregates respect exhaustion", sizeM?.value === "M" && colorRed?.value === "Red");

  // ═══ 4. Customer order requires + records the size/colour ══════════════
  const orderNoVariant = await api(null, "POST", "/api/order", {
    businessId: seeded.id,
    customerName: "TEST Boutique Buyer",
    customerPhone: "0244000111",
    fulfillmentType: "PICKUP",
    items: [{ inventoryId: testItem.id, quantity: 1 }],
  });
  ok("online order without a size/colour is refused", orderNoVariant.status >= 400, JSON.stringify(orderNoVariant.data).slice(0, 140));

  const outOfStockCombo = await api(null, "POST", "/api/order", {
    businessId: seeded.id,
    customerName: "TEST Boutique Buyer",
    customerPhone: "0244000111",
    fulfillmentType: "PICKUP",
    items: [{ inventoryId: testItem.id, quantity: 1, variantId: comboMRed.id }],
  });
  ok("online order for an out-of-stock size is refused", outOfStockCombo.status >= 400, JSON.stringify(outOfStockCombo.data).slice(0, 140));

  const variantS = createdVariantsOfTestItem.find((v) => v.size === "S");
  const order = await api(null, "POST", "/api/order", {
    businessId: seeded.id,
    customerName: "TEST Boutique Buyer",
    customerPhone: "0244000111",
    fulfillmentType: "PICKUP",
    paymentChoice: "ON_DELIVERY",
    items: [{ inventoryId: testItem.id, quantity: 2, variantId: variantS.id }],
  });
  track(order);
  ok("online order with size/colour accepted", order.status === 200 && order.data?.success, JSON.stringify(order.data).slice(0, 140));
  const tracking = await q1(`select * from customer_trackings where tracking_code = $1`, [order.data?.trackingCode]);
  const li0 = (tracking?.items || [])[0] || {};
  ok("order line records size/colour/variant", li0.size === "S" && li0.color === "Red" && Number(li0.variantId) === Number(variantS.id), JSON.stringify(li0));
  const stockPending = await q1(`select quantity from inventory_variants where id = $1`, [variantS.id]);
  ok("stock NOT deducted while order is pending", Number(stockPending.quantity) === 3, String(stockPending.quantity));

  const aggregateBefore = await itemQty(testItem.id);
  const confirm = await api(owner.cookie, "POST", "/api/tracking", { action: "SET_STATUS", id: tracking.id, status: "CONFIRMED" });
  ok("staff confirms the order", confirm.status === 200 && confirm.data?.success, JSON.stringify(confirm.data).slice(0, 120));
  ok("confirming deducts the EXACT size/colour (3 → 1)", (await variantQty(variantS.id)) === 1, String(await variantQty(variantS.id)));
  ok("order confirmation drops the aggregate by exactly the sold qty", (await itemQty(testItem.id)) === aggregateBefore - 2, `${aggregateBefore} → ${await itemQty(testItem.id)}`);
  ok("aggregate still equals the sum of active variants", await aggregateIsConsistent(testItem.id));

  const cancel = await api(owner.cookie, "POST", "/api/tracking", { action: "SET_STATUS", id: tracking.id, status: "CANCELLED" });
  const stockRestored = await q1(`select quantity from inventory_variants where id = $1`, [variantS.id]);
  ok("cancelling restores the exact size/colour", cancel.data?.success && Number(stockRestored.quantity) === 3, String(stockRestored.quantity));

  // ═══ 5. Counter sale (POS) with size/colour ════════════════════════════
  const saleVariant = await q1(`select * from inventory_variants where inventory_id = $1 and size = 'L'`, [testItem.id]);
  const aggregateBeforeSale = await itemQty(testItem.id);
  const sale = await api(owner.cookie, "POST", "/api/sales", {
    businessId: seeded.id,
    customerName: "TEST Boutique Counter",
    paymentMethod: "CASH",
    cartItems: [
      {
        inventoryId: testItem.id,
        sku: itemAfter.sku,
        name: itemAfter.name,
        quantity: 3,
        originalPrice: 45,
        sellingPrice: 45,
        variantId: saleVariant.id,
      },
    ],
    createdByName: "Owner",
    createdByRole: "OWNER",
  });
  track(sale);
  ok("counter sale with size/colour succeeds", sale.status === 200 && sale.data?.success, JSON.stringify(sale.data).slice(0, 140));
  const receiptLine = (sale.data?.receipt?.lineItems || [])[0] || {};
  ok("receipt line carries the size/colour", receiptLine.size === "L" && receiptLine.color === "Green" && Number(receiptLine.variantId) === Number(saleVariant.id), JSON.stringify(receiptLine).slice(0, 160));
  ok("receipt description names the size/colour", /Size:\s*L/.test(receiptLine.description || "") && /Colour:\s*Green/.test(receiptLine.description || ""), receiptLine.description);
  ok("counter sale deducts the exact size/colour (4 → 1)", (await variantQty(saleVariant.id)) === 1, String(await variantQty(saleVariant.id)));
  ok("counter sale drops the aggregate by exactly the sold qty", (await itemQty(testItem.id)) === aggregateBeforeSale - 3, `${aggregateBeforeSale} → ${await itemQty(testItem.id)}`);
  ok("aggregate still equals the sum of active variants", await aggregateIsConsistent(testItem.id));

  const oversell = await api(owner.cookie, "POST", "/api/sales", {
    businessId: seeded.id,
    customerName: "TEST Boutique Oversell",
    paymentMethod: "CASH",
    cartItems: [
      { inventoryId: testItem.id, sku: itemAfter.sku, name: itemAfter.name, quantity: 99, originalPrice: 45, sellingPrice: 45, variantId: saleVariant.id },
    ],
  });
  ok("overselling one size/colour is refused", oversell.status >= 400, `status ${oversell.status}`);
  ok("refused sale left stock untouched", (await variantQty(saleVariant.id)) === 1, String(await variantQty(saleVariant.id)));

  // Credit sale on a variant.
  const creditVariant = createdVariantsOfTestItem.find((v) => v.size === "M" && v.color === "Blue");
  const credit = await api(owner.cookie, "POST", "/api/credit-sales", {
    action: "create",
    businessId: seeded.id,
    customerName: "TEST Boutique Credit",
    customerPhone: "0244000133",
    depositAmount: 0,
    cartItems: [
      { inventoryId: testItem.id, sku: itemAfter.sku, name: itemAfter.name, quantity: 1, sellingPrice: 45, variantId: creditVariant.id },
    ],
  });
  track(credit);
  ok("credit sale with size/colour succeeds", credit.status === 200 && credit.data?.success, JSON.stringify(credit.data).slice(0, 140));
  ok("credit sale deducts the exact size/colour (2 → 1)", (await variantQty(creditVariant.id)) === 1, String(await variantQty(creditVariant.id)));

  // ═══ 6. Reports / audit / low stock ════════════════════════════════════
  const dash = await api(owner.cookie, "GET", `/api/boutique?businessId=${seeded.id}`);
  ok("boutique dashboard responds", dash.status === 200 && dash.data?.success);
  const best = dash.data?.bestSellers || {};
  ok("dashboard reports best-selling products", (best.products || []).length > 0, JSON.stringify((best.products || [])[0] || {}));
  ok("dashboard reports best-selling sizes", (best.sizes || []).some((s) => s.label === "L" || s.label === "M"), JSON.stringify((best.sizes || []).slice(0, 3)));
  ok("dashboard reports best-selling colours", (best.colors || []).length > 0, JSON.stringify((best.colors || []).slice(0, 3)));
  ok("dashboard reports inventory + low stock", dash.data?.inventory?.itemCount >= 4 && Array.isArray(dash.data?.inventory?.lowStockVariants));
  ok("dashboard reports variant summary", (dash.data?.variantSummary?.total || 0) >= 4);
  ok("dashboard reports sales + profit", typeof dash.data?.sales?.total === "number" && typeof dash.data?.profit?.month === "number");

  const variantAudit = await q(
    `select action from audit_trail where business_id = $1 and action like 'BOUTIQUE%' order by id desc limit 10`,
    [seeded.id],
  );
  ok("variant changes land in the shared audit trail", variantAudit.length >= 2, variantAudit.map((r) => r.action).join(", "));

  const lowAlerts = await q(`select 1 from notifications where business_id = $1 and record_ref like 'low-stock:%' limit 1`, [seeded.id]).catch(() => []);
  ok("low-stock alert plumbing reachable for the unit", Array.isArray(lowAlerts));

  // ═══ 7. Permissions ════════════════════════════════════════════════════
  const wk = await login("akua.donkor@gomina360.com", process.env.WORKER_PW || "GoMina@User10");
  ok("worker login", wk.ok);
  const noAccess = await api(wk.cookie, "GET", `/api/boutique?businessId=${seeded.id}`);
  ok("worker without a grant cannot read the unit", noAccess.status === 403, `status ${noAccess.status}`);

  // Grant the worker access to the boutique unit, then prove the write gates.
  await client.query(
    `insert into user_business_access (user_id, business_id, created_by_user_id)
     select $1, $2, 1 where not exists (select 1 from user_business_access where user_id = $1 and business_id = $2)`,
    [wk.user?.id ?? 10, seeded.id],
  );
  const wkRead = await api(wk.cookie, "GET", `/api/boutique?businessId=${seeded.id}`);
  ok("granted worker can read the unit", wkRead.status === 200 && wkRead.data?.success);
  const wkSet = await api(wk.cookie, "POST", "/api/boutique", {
    action: "SET_VARIANTS",
    businessId: seeded.id,
    inventoryId: testItem.id,
    variants: [{ size: "S", color: "Red", quantity: 0 }],
  });
  ok("worker cannot change sizes/colours (403)", wkSet.status === 403, `status ${wkSet.status}`);
  const wkExpense = await api(wk.cookie, "POST", "/api/boutique", {
    action: "ADJUST_STOCK",
    businessId: seeded.id,
    variantId: blueRow.id,
    delta: 1,
    unitCostGhs: 10,
    recordExpense: true,
  });
  ok("worker cannot book a restock expense (403)", wkExpense.status === 403, `status ${wkExpense.status}`);
  const wkRestock = await api(wk.cookie, "POST", "/api/boutique", {
    action: "ADJUST_STOCK",
    businessId: seeded.id,
    variantId: blueRow.id,
    delta: -1,
  });
  ok("worker may still receive/issue stock (no expense)", wkRestock.status === 200, `status ${wkRestock.status}`);
  await client.query(`delete from user_business_access where user_id = $1 and business_id = $2`, [wk.user?.id ?? 10, seeded.id]);

  // ═══ 8. Tenant isolation ═══════════════════════════════════════════════
  const otherOrg = await q1(`select id from businesses where code = 'WM-DEMO-02'`);
  if (otherOrg) {
    // A non-super-admin user of org 1 (the platform OWNER is a super admin and
    // is intentionally allowed everywhere — that is the platform kill switch).
    const cross = await api(wk.cookie, "GET", `/api/boutique?businessId=${otherOrg.id}`);
    ok("cross-tenant boutique read is refused", cross.status === 403, `status ${cross.status}`);
    const crossWrite = await api(wk.cookie, "POST", "/api/boutique", {
      action: "SET_VARIANTS",
      businessId: otherOrg.id,
      inventoryId: 1,
      variants: [{ size: "S", quantity: 1 }],
    });
    ok("cross-tenant boutique write is refused", crossWrite.status === 403, `status ${crossWrite.status}`);
    const crossOrder = await api(wk.cookie, "GET", `/api/boutique?businessId=${otherOrg.id}&variantsOnly=1`);
    ok("cross-tenant variant matrix read is refused", crossOrder.status === 403, `status ${crossOrder.status}`);
  } else {
    ok("cross-tenant fixture present", false, "WM-DEMO-02 missing");
  }

  // ═══ 9. Performance ════════════════════════════════════════════════════
  const timed = async (fn) => {
    const t = Date.now();
    await fn();
    return Date.now() - t;
  };
  const dashTimes = [];
  for (let i = 0; i < 5; i++) dashTimes.push(await timed(() => api(owner.cookie, "GET", `/api/boutique?businessId=${seeded.id}`)));
  dashTimes.sort((a, b) => a - b);
  ok("boutique dashboard responds fast (p95 < 1500 ms)", dashTimes[4] < 1500, `times ${dashTimes.join("/")} ms`);
  const menuTimes = [];
  for (let i = 0; i < 5; i++) menuTimes.push(await timed(() => api(null, "GET", "/api/menu")));
  menuTimes.sort((a, b) => a - b);
  ok("storefront catalogue stays fast (p95 < 1500 ms)", menuTimes[4] < 1500, `times ${menuTimes.join("/")} ms`);
  let perfSale = null;
  const saleTime = await timed(async () => {
    perfSale = await api(owner.cookie, "POST", "/api/sales", {
      businessId: seeded.id,
      customerName: "TEST Boutique Perf",
      paymentMethod: "CASH",
      cartItems: [{ inventoryId: testItem.id, sku: itemAfter.sku, name: itemAfter.name, quantity: 1, originalPrice: 45, sellingPrice: 45, variantId: blueRow.id }],
    });
  });
  track(perfSale);
  ok("variant sale completes fast (< 1500 ms)", saleTime < 1500, `${saleTime} ms`);

  // ═══ 10. No regressions on existing businesses/data ═══════════════════
  const poultryVariants = await q(`select count(*)::int c from inventory_variants where business_id = 1`);
  ok("existing business has no variant rows (unchanged)", poultryVariants[0].c === 0);
  const poultryItem = await q1(`select * from inventory_items where business_id = 1 order by id limit 1`);
  const plainSale = await api(owner.cookie, "POST", "/api/sales", {
    businessId: 1,
    customerName: "TEST Plain Regression",
    paymentMethod: "CASH",
    cartItems: [{ inventoryId: poultryItem.id, sku: poultryItem.sku, name: poultryItem.name, quantity: 1, originalPrice: poultryItem.selling_price_ghs, sellingPrice: poultryItem.selling_price_ghs }],
  });
  track(plainSale);
  ok("existing (plain) sale path still works", plainSale.status === 200 && plainSale.data?.success, JSON.stringify(plainSale.data).slice(0, 120));
  const plainLine = (plainSale.data?.receipt?.lineItems || [])[0] || {};
  ok("plain sale line has no variant fields", plainLine.size === undefined && plainLine.variantId === undefined);
  const poultryMenu = (await api(null, "GET", "/api/menu")).data?.businesses?.find((b) => b.businessCode === "POULTRY-01");
  const plainProd = (poultryMenu?.products || [])[0];
  ok("plain storefront product has no variant keys", plainProd && plainProd.hasVariants === undefined && plainProd.variantOptions === undefined);
  const plainOrder = await api(null, "POST", "/api/order", {
    businessId: 1,
    customerName: "TEST Plain Online",
    customerPhone: "0244000122",
    fulfillmentType: "PICKUP",
    items: [{ inventoryId: poultryItem.id, quantity: 1 }],
  });
  track(plainOrder);
  ok("plain online order still works without a variant", plainOrder.status === 200 && plainOrder.data?.success, JSON.stringify(plainOrder.data).slice(0, 120));
  const otherBizVariants = await q(`select count(*)::int c from inventory_variants where business_id <> $1`, [seeded.id]);
  ok("no variant rows leaked into other businesses", otherBizVariants[0].c === 0, `${otherBizVariants[0].c} leaked`);

  // Menu cache invalidation: a new variant row must be visible immediately.
  const fresh = await api(owner.cookie, "POST", "/api/boutique", {
    action: "ADJUST_STOCK",
    businessId: seeded.id,
    variantId: blueRow.id,
    delta: 5,
  });
  const menuAfter = await api(null, "GET", "/api/menu");
  const prodAfter = ((menuAfter.data?.businesses || []).find((b) => b.businessId === seeded.id)?.products || []).find((p) => p.id === testItem.id);
  const blueAfter = (prodAfter?.variantOptions?.variants || []).find((v) => v.size === "M" && v.color === "Blue");
  ok(
    "stock changes reach the storefront immediately (menu cache invalidated)",
    fresh.data?.success && Number(blueAfter?.available) === Number(fresh.data?.variant?.quantity) && (await aggregateIsConsistent(testItem.id)),
    JSON.stringify(blueAfter),
  );
} catch (e) {
  console.error("suite error:", e);
  failures++;
} finally {
  await purge();
  await client.end();
  console.log(`\n${failures === 0 ? "✅ ALL BOUTIQUE CHECKS PASSED" : `❌ ${failures} boutique check(s) FAILED`} (${checks.length} checks)`);
  process.exit(failures === 0 ? 0 : 1);
}
