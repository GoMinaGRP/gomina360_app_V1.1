/**
 * verify-single-writer.mjs — P1 consolidation suite (one writer per fact).
 *
 * Proves, end-to-end through the real API + real database, that the audit's
 * "second sales pipeline" and "parallel purchasing system" are gone:
 *
 *   A · Hardware order delivered      → ONE ledger INCOME (HARDWARE_ORDER_SALE)
 *                                       + ONE RECEIPT + ONE tracking row
 *                                       + CRM link, and re-advancing the status
 *                                       never double-posts.
 *   B · Electronics order delivered   → same (ELECTRONICS_ORDER_SALE), order row
 *                                       carries transactionId/salesDocumentId.
 *   C · Restaurant ticket SERVED      → ONE ledger INCOME (RESTAURANT_ORDER_SALE)
 *                                       + receipt + tracking; re-serving is a
 *                                       no-op (idempotency guard).
 *   D · Module purchases RECEIVED     → accrue the SHARED supplier ledger
 *                                       (suppliers.totalSuppliedGhs) and store
 *                                       supplierId on the purchase row.
 *   E · Order create links the shared CRM (customerId set, no duplicate buyer).
 *   F · Tenant isolation: every new row carries its own businessId; the other
 *       unit sees nothing.
 *   G · /api/sales regression: one txn + one receipt + tracking + CRM accrual.
 *   H · A discount larger than the subtotal is rejected BEFORE stock moves.
 *
 * Everything it creates is tagged TEST-SW- and purged in the finally block.
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

const TAG = "TEST-SW";
const stamp = Date.now().toString().slice(-6);
const created = { orders: [], purchases: [], inventoryIds: [], txnIds: [], docIds: [], trackingIds: [], customerIds: [] };

const purge = async () => {
  try {
    for (const table of ["hardware_orders", "electronics_orders", "restaurant_orders"]) {
      await client.query(
        `delete from ${table} where customer_name like $1 or order_number like $2${table === "restaurant_orders" ? " or order_number like $2" : ""}`,
        [`${TAG}%`, `%-${TAG}-%`],
      ).catch(() => {});
    }
    for (const table of ["hardware_purchases", "electronics_purchases", "restaurant_purchases"]) {
      await client.query(`delete from ${table} where supplier_name like $1`, [`${TAG}%`]).catch(() => {});
    }
    await client.query(`delete from sales_documents where customer_name like $1`, [`${TAG}%`]).catch(() => {});
    await client.query(`delete from customer_trackings where customer_name like $1`, [`${TAG}%`]).catch(() => {});
    await client.query(`delete from transactions where description like $1`, [`%${TAG}%`]).catch(() => {});
    await client.query(`delete from customers where name like $1`, [`${TAG}%`]).catch(() => {});
    await client.query(`delete from inventory_items where sku like $1 or name like $1`, [`${TAG}%`]).catch(() => {});
    await client.query(`delete from suppliers where name like $1`, [`${TAG}%`]).catch(() => {});
    await client.query(`delete from electronics_serials where serial_number like $1`, [`${TAG}%`]).catch(() => {});
  } catch (e) {
    console.error("purge warning:", e.message);
  }
};

await client.connect();
let token = null;
try {
  await purge(); // defensive: any rows a crashed earlier run left behind
  token = await login();
  ok("owner session established", !!token);

  const biz = Object.fromEntries(
    (await q(`select id, code from businesses where code in ('HARDWARE-01','TECH-01','FOOD-01','POULTRY-01')`))
      .map((r) => [r.code, r.id]),
  );
  const HW = biz["HARDWARE-01"], TECH = biz["TECH-01"], FOOD = biz["FOOD-01"], OTHER = biz["POULTRY-01"];
  ok("fixture businesses present", !!(HW && TECH && FOOD && OTHER), JSON.stringify(biz));

  // ── stock fixtures ───────────────────────────────────────────────────
  const mkItem = async (businessId, sku, name, qty, cost, price) =>
    q1(
      `insert into inventory_items (name, sku, business_id, category, quantity, unit, cost_price_ghs, selling_price_ghs, min_stock_threshold, status)
       values ($1,$2,$3,'TEST', $4,'Units',$5,$6,1,'IN_STOCK') returning id`,
      [name, sku, businessId, qty, cost, price],
    );
  const hwItem = await mkItem(HW, `${TAG}-HW-${stamp}`, `${TAG} Cement 50kg`, 100, 80, 100);
  const techItem = await mkItem(TECH, `${TAG}-TEC-${stamp}`, `${TAG} Radio`, 20, 150, 250);
  const foodMenu = await q1(
    `insert into restaurant_menu_items (business_id, branch_code, name, category, price_ghs, cost_ghs, is_active)
     values ($1, 'FOOD-01', $2, 'MAIN', 45, 18, true) returning id`,
    [FOOD, `${TAG} Jollof Plate`],
  );
  created.inventoryIds.push(hwItem.id, techItem.id);

  /* ══════════════ A. Hardware order → shared sale engine ══════════════ */
  console.log("\n── A. Hardware order fulfilment ──");
  const hwOrder = await call(token, "/api/hardware", "POST", {
    entity: "ORDER",
    data: {
      businessId: HW, customerName: `${TAG} Hardware Buyer`, customerPhone: `024${stamp}`,
      inventoryId: hwItem.id, quantity: 10, unitPriceGhs: 100, createdByName: "Suite", createdByRole: "OWNER",
    },
  });
  ok("hardware order created", hwOrder.status === 200 && hwOrder.body?.item?.id, JSON.stringify(hwOrder.body)?.slice(0, 160));
  const hwOrderId = hwOrder.body?.item?.id;
  created.orders.push(["hardware_orders", hwOrderId]);
  ok(
    "order create links the shared CRM customer",
    !!hwOrder.body?.item?.customerId,
    `customerId=${hwOrder.body?.item?.customerId}`,
  );
  created.customerIds.push(hwOrder.body?.item?.customerId);

  await call(token, "/api/hardware", "PATCH", { entity: "ORDER", id: hwOrderId, data: { status: "DELIVERED", actorName: "Suite", actorRole: "OWNER" } });
  await call(token, "/api/hardware", "PATCH", { entity: "ORDER", id: hwOrderId, data: { status: "DELIVERED", actorName: "Suite", actorRole: "OWNER" } }); // double-advance
  const hwTx = await q(`select * from transactions where business_id=$1 and category='HARDWARE_ORDER_SALE' and description like $2`, [HW, `%${TAG}%`]);
  const hwDocs = await q(`select * from sales_documents where business_id=$1 and customer_name like $2`, [HW, `${TAG}%`]);
  const hwTrack = await q(`select * from customer_trackings where business_id=$1 and customer_name like $2`, [HW, `${TAG}%`]);
  const hwStock = await q1(`select quantity from inventory_items where id=$1`, [hwItem.id]);
  ok("exactly ONE ledger INCOME for the delivered order", hwTx.length === 1, `rows=${hwTx.length}`);
  ok("amount + category unchanged (1000, HARDWARE_ORDER_SALE)", Number(hwTx[0]?.amount_ghs) === 1000 && hwTx[0]?.category === "HARDWARE_ORDER_SALE", JSON.stringify(hwTx[0]?.amount_ghs));
  ok("a RECEIPT sales document now exists (was missing)", hwDocs.length === 1 && Number(hwDocs[0]?.total_ghs) === 1000, `docs=${hwDocs.length}`);
  ok("receipt carries the CRM customer", hwDocs[0]?.customer_id && hwDocs[0].customer_id === hwOrder.body?.item?.customerId, `doc=${hwDocs[0]?.customer_id} order=${hwOrder.body?.item?.customerId}`);
  ok("a tracking row now exists (order now appears in Order & Tracking)", hwTrack.length === 1 && hwTrack[0].status === "RECEIVED", `rows=${hwTrack.length}`);
  ok("stock deducted exactly once (100 − 10)", Number(hwStock?.quantity) === 90, `qty=${hwStock?.quantity}`);
  ok("re-advancing DELIVERED posts nothing extra", hwTx.length === 1 && hwDocs.length === 1);
  created.txnIds.push(...hwTx.map((t) => t.id));
  created.docIds.push(...hwDocs.map((d) => d.id));
  created.trackingIds.push(...hwTrack.map((t) => t.id));

  const hwCust = await q1(`select * from customers where name = $1`, [`${TAG} Hardware Buyer`]);
  ok("buyer accrues spend in the shared CRM (1000)", Number(hwCust?.total_spent_ghs) === 1000, `spent=${hwCust?.total_spent_ghs}`);

  /* ═══════════ B. Electronics order → shared sale engine ═════════════ */
  console.log("\n── B. Electronics order fulfilment ──");
  const tecOrder = await call(token, "/api/electronics", "POST", {
    entity: "ORDER",
    data: {
      businessId: TECH, customerName: `${TAG} Tech Buyer`, customerPhone: `055${stamp}`,
      inventoryId: techItem.id, quantity: 2, unitPriceGhs: 250, createdByName: "Suite", createdByRole: "OWNER",
    },
  });
  const tecOrderId = tecOrder.body?.item?.id;
  ok("electronics order created + CRM linked", tecOrder.status === 200 && !!tecOrder.body?.item?.customerId, JSON.stringify(tecOrder.body)?.slice(0, 160));
  await call(token, "/api/electronics", "PATCH", { entity: "ORDER", id: tecOrderId, data: { status: "DELIVERED", actorName: "Suite", actorRole: "OWNER" } });
  await call(token, "/api/electronics", "PATCH", { entity: "ORDER", id: tecOrderId, data: { status: "DELIVERED", actorName: "Suite", actorRole: "OWNER" } });
  const tecTx = await q(`select * from transactions where business_id=$1 and category='ELECTRONICS_ORDER_SALE' and description like $2`, [TECH, `%${TAG}%`]);
  const tecDocs = await q(`select * from sales_documents where business_id=$1 and customer_name like $2`, [TECH, `${TAG}%`]);
  const tecRow = await q1(`select transaction_id, sales_document_id, customer_id from electronics_orders where id=$1`, [tecOrderId]);
  const tecStock = await q1(`select quantity from inventory_items where id=$1`, [techItem.id]);
  ok("exactly ONE ledger INCOME (ELECTRONICS_ORDER_SALE, 500)", tecTx.length === 1 && Number(tecTx[0]?.amount_ghs) === 500, `rows=${tecTx.length}`);
  ok("receipt created + linked on the order row", tecDocs.length === 1 && tecRow?.sales_document_id === tecDocs[0]?.id, `doc=${tecRow?.sales_document_id}`);
  ok("order row carries the ledger transaction id", !!tecRow?.transaction_id && tecRow.transaction_id === tecTx[0]?.id);
  ok("stock deducted once (20 − 2)", Number(tecStock?.quantity) === 18, `qty=${tecStock?.quantity}`);
  created.txnIds.push(...tecTx.map((t) => t.id));
  created.docIds.push(...tecDocs.map((d) => d.id));

  /* ═════════ C. Restaurant ticket → shared sale on SERVED ════════════ */
  console.log("\n── C. Restaurant ticket served ──");
  const foodOrder = await call(token, "/api/restaurant", "POST", {
    entity: "ORDER",
    data: {
      businessId: FOOD, customerName: `${TAG} Diner`, customerPhone: `020${stamp}`,
      itemName: `${TAG} Jollof Plate`, menuItemId: foodMenu.id, quantity: 3, unitPriceGhs: 45,
      orderType: "DINE_IN", createdByName: "Suite", createdByRole: "OWNER",
    },
  });
  const foodOrderId = foodOrder.body?.item?.id;
  ok("kitchen ticket created + CRM linked", foodOrder.status === 200 && !!foodOrder.body?.item?.customerId, JSON.stringify(foodOrder.body)?.slice(0, 160));
  await call(token, "/api/restaurant", "PATCH", { entity: "ORDER", id: foodOrderId, data: { status: "COOKING", actorName: "Suite", actorRole: "OWNER" } });
  const served = await call(token, "/api/restaurant", "PATCH", { entity: "ORDER", id: foodOrderId, data: { status: "SERVED", actorName: "Suite", actorRole: "OWNER" } });
  const reServed = await call(token, "/api/restaurant", "PATCH", { entity: "ORDER", id: foodOrderId, data: { status: "SERVED", actorName: "Suite", actorRole: "OWNER" } });
  const foodTx = await q(`select * from transactions where business_id=$1 and category='RESTAURANT_ORDER_SALE' and description like $2`, [FOOD, `%${TAG}%`]);
  const foodDocs = await q(`select * from sales_documents where business_id=$1 and customer_name like $2`, [FOOD, `${TAG}%`]);
  const foodRow = await q1(`select transaction_id, sales_document_id, posted_at from restaurant_orders where id=$1`, [foodOrderId]);
  ok("serving posts the ticket to the ledger (135)", foodTx.length === 1 && Number(foodTx[0]?.amount_ghs) === 135, `rows=${foodTx.length} amt=${foodTx[0]?.amount_ghs}`);
  ok("serving creates the receipt + stamps the ticket", foodDocs.length === 1 && !!foodRow?.transaction_id && !!foodRow?.posted_at, `posted=${reServed.body?.posted}`);
  ok("re-serving is idempotent (still ONE posting)", foodTx.length === 1 && foodDocs.length === 1, `tx=${foodTx.length} docs=${foodDocs.length}`);
  ok("recipe cost recorded for real COGS/profit", Number(foodDocs[0]?.cogs_ghs) === 54 && Number(foodDocs[0]?.gross_profit_ghs) === 81, `cogs=${foodDocs[0]?.cogs_ghs} profit=${foodDocs[0]?.gross_profit_ghs}`);
  created.txnIds.push(...foodTx.map((t) => t.id));
  created.docIds.push(...foodDocs.map((d) => d.id));

  /* ════════════ D. Purchases → shared supplier ledger ════════════════ */
  console.log("\n── D. Parallel purchases feed the shared Suppliers ledger ──");
  const cases = [
    { route: "/api/hardware", entity: "PURCHASE", biz: HW, item: `${TAG} Cement`, cost: 90, qty: 5, expect: 450 },
    { route: "/api/electronics", entity: "PURCHASE", biz: TECH, item: `${TAG} Radio`, cost: 140, qty: 4, expect: 560 },
    { route: "/api/restaurant", entity: "PURCHASE", biz: FOOD, item: `${TAG} Rice`, cost: 12, qty: 50, expect: 600 },
  ];
  for (const c of cases) {
    const supName = `${TAG} Vendor ${c.route.split("/").pop()}`;
    const po = await call(token, c.route, "POST", {
      entity: c.entity,
      data: {
        businessId: c.biz, supplierName: supName, itemName: c.item, quantity: c.qty, unitCostGhs: c.cost,
        status: "ORDERED", recordExpense: false, createdByName: "Suite", createdByRole: "OWNER",
      },
    });
    const poId = po.body?.item?.id;
    if (poId) {
      await call(token, c.route, "PATCH", { entity: c.entity, id: poId, data: { status: "RECEIVED", createdByName: "Suite", createdByRole: "OWNER" } });
    }
    const sup = await q1(`select id, total_supplied_ghs from suppliers where name=$1`, [supName]);
    const poRow = poId ? await q1(`select supplier_id from ${c.route.split("/").pop()}_purchases where id=$1`, [poId]) : null;
    ok(
      `${c.route.split("/").pop()}: received purchase accrues the supplier ledger (${c.expect})`,
      !!sup && Number(sup.total_supplied_ghs) === c.expect,
      `supplier=${sup ? sup.total_supplied_ghs : "none"} po=${po.status}`,
    );
    ok(
      `${c.route.split("/").pop()}: purchase row links the shared supplier (supplierId)`,
      !!poRow?.supplier_id && poRow.supplier_id === sup?.id,
      `poSupplier=${poRow?.supplier_id} supplier=${sup?.id}`,
    );
    created.purchases.push([`${c.route.split("/").pop()}_purchases`, poId]);
  }

  /* ═════════════ F. Tenant isolation across all new rows ═════════════ */
  console.log("\n── F. Tenant isolation ──");
  const leakage = await q1(
    `select
       (select count(*) from sales_documents where customer_name like $1 and business_id not in ($2,$3,$4)) docs,
       (select count(*) from customer_trackings where customer_name like $1 and business_id not in ($2,$3,$4)) tracks,
       (select count(*) from transactions where description like $5 and business_id not in ($2,$3,$4)) txns`,
    [`${TAG}%`, HW, TECH, FOOD, `%${TAG}%`],
  );
  ok("no receipt / tracking / ledger row escaped its unit", Number(leakage.docs) === 0 && Number(leakage.tracks) === 0 && Number(leakage.txns) === 0, JSON.stringify(leakage));
  const crossUnit = await q1(
    `select count(*) c from restaurant_orders where business_id = $1 and customer_name like $2`, [OTHER, `${TAG} Diner`],
  );
  ok("another unit has zero knowledge of the new customer", Number(crossUnit.c) === 0);

  /* ══════════ G. Sales Center regression (still one writer) ══════════ */
  console.log("\n── G. Sales Center regression ──");
  const saleBefore = await q1(`select count(*) c from transactions where business_id=$1`, [HW]);
  const sale = await call(token, "/api/sales", "POST", {
    businessId: HW, branchCode: "HARDWARE-01", customerName: `${TAG} POS Buyer`, customerPhone: `027${stamp}`,
    paymentMethod: "CASH", cartItems: [{ inventoryId: hwItem.id, quantity: 4, sellingPrice: 100 }],
    createdByName: "Suite", createdByRole: "OWNER",
  });
  const saleTx = await q(`select * from transactions where business_id=$1 and category='Inventory Sale' and description like $2`, [HW, `%${TAG}%`]);
  const saleDoc = await q(`select * from sales_documents where business_id=$1 and customer_name like $2`, [HW, `${TAG} POS Buyer`]);
  ok("sale posts ONE ledger INCOME + ONE receipt + tracking code", sale.status === 200 && saleTx.length === 1 && saleDoc.length === 1 && !!sale.body?.trackingCode, JSON.stringify(sale.body)?.slice(0, 120));
  ok("sale response keeps its documented shape", !!sale.body?.transaction && !!sale.body?.receipt && (sale.body?.inventoryUpdates || []).length === 1);
  const saleAfter = await q1(`select count(*) c from transactions where business_id=$1`, [HW]);
  ok("no extra ledger rows were created by the shared refactor", Number(saleAfter.c) === Number(saleBefore.c) + 1, `${saleBefore.c} → ${saleAfter.c}`);
  created.txnIds.push(...saleTx.map((t) => t.id));
  created.docIds.push(...saleDoc.map((d) => d.id));

  /* ══════ H. Bad discount is rejected BEFORE stock moves ════════════ */
  console.log("\n── H. Discount validation happens before stock movement ──");
  const qtyBefore = Number((await q1(`select quantity from inventory_items where id=$1`, [hwItem.id]))?.quantity);
  const badSale = await call(token, "/api/sales", "POST", {
    businessId: HW, branchCode: "HARDWARE-01", customerName: `${TAG} Bad Discount`, paymentMethod: "CASH",
    cartItems: [{ inventoryId: hwItem.id, quantity: 5, sellingPrice: 100 }], discount: 9999,
    createdByName: "Suite", createdByRole: "OWNER",
  });
  const qtyAfter = Number((await q1(`select quantity from inventory_items where id=$1`, [hwItem.id]))?.quantity);
  ok("over-subtotal discount is rejected (400)", badSale.status === 400, `status=${badSale.status}`);
  ok("rejected sale left stock untouched", qtyAfter === qtyBefore, `qty ${qtyBefore} → ${qtyAfter}`);
} catch (e) {
  failed++;
  console.error("💥 suite error:", e?.message || e);
} finally {
  await purge();
  await client.end();
}

console.log(`\n══ single-writer (P1): ${passed} passed, ${failed} failed ══`);
process.exit(failed ? 1 : 0);
