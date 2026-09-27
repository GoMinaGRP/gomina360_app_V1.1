#!/usr/bin/env node
/**
 * Hardware & Building Materials module — complete acceptance audit.
 *
 * Covers the owner directive (2026-09):
 *   H1. Deletion permanence — a Hardware unit removed by the OWNER (Manage
 *       Units → Delete) is NEVER resurrected by the boot seeder. Root cause
 *       of the old bug: ensureHardwareFlagship() re-provisioned HARDWARE-01
 *       on every seed pass. Fixed with system_markers (one-time pass marker
 *       + deleted_business tombstones).
 *   H2. Ledger-backed finances — the starter-kit cost is a REAL expense
 *       transaction ("Opening Stock — Starter Kit"), not a silent metrics
 *       fold: dashboards/finance show the same totals, every cedi backed by
 *       a manageable record. No demo/fake or disconnected data.
 *   H3. Full workflow — sale, order pipeline, purchase pipeline, deliveries
 *       (standalone + order-linked), GRN, expense: stock movements and
 *       finance postings fire exactly once, never double-counted.
 *   H4. Cache coherence — hardware mutations drop the /api/init snapshot so
 *       post-save refreshes read fresh stock/ledger data.
 *   H5. Permissions — business-scope isolation, worker expense-permission
 *       parity on the API, anonymous refused.
 *   H6. Clean units — a brand-new Hardware unit created from the app starts
 *       with zero sample data (owner directive).
 *
 * Phases (the app process must be RESTARTED between them):
 *   node dev-tooling/verify-hardware-audit.mjs phase1   # fresh-DB checks + workflow + permissions
 *   node dev-tooling/verify-hardware-audit.mjs phase2   # after OWNER deleted HARDWARE-01:
 *                                                      # still gone, tombstone present
 *   (phase2 is run AFTER an app restart so the boot seeder got its chance
 *    to resurrect the unit — and must not have.)
 */
import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const pg = req("pg");

const BASE = process.env.BASE || "http://localhost:3000";
const DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.GOMINA_OWNER_PW || "Owner@GoMina26" };
const PHASE = process.argv[2] || "phase1";

let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.error(`❌ ${name}${extra ? ` — ${extra}` : ""}`); }
};
const client = new pg.Client(DB);

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`login ${email}: ${res.status} ${body.error || ""}`);
  return body.sessionToken;
}
const H = (t) => ({ "Content-Type": "application/json", "x-gomina-session": t });
const call = async (t, path, method = "GET", body = null) => {
  const res = await fetch(`${BASE}${path}`, { method, headers: H(t), body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const q = async (sql, params) => (await client.query(sql, params)).rows;

await client.connect();
try {
  if (PHASE === "phase1") {
    // ══ H2. Starter kit is ledger-backed ════════════════════════════════
    console.log("── H2. Starter-kit finances are ledger-backed ──");
    const hw = (await q(`SELECT id FROM businesses WHERE code = 'HARDWARE-01'`))[0];
    ok("HARDWARE-01 exists (seeded flagship)", !!hw);
    if (hw) {
      const kitTx = await q(
        `SELECT * FROM transactions WHERE business_id = $1 AND category = 'Opening Stock — Starter Kit'`,
        [hw.id]
      );
      const invVal = await q(
        `SELECT COALESCE(SUM(quantity * cost_price_ghs), 0) v FROM inventory_items WHERE business_id = $1`,
        [hw.id]
      );
      ok("opening-stock expense transaction exists", kitTx.length === 1,
        `got ${kitTx.length}`);
      ok("transaction amount = inventory cost value",
        kitTx.length === 1 && Math.abs(Number(kitTx[0].amount_ghs) - Number(invVal[0].v)) < 1,
        `txn=${kitTx[0]?.amount_ghs} inv=${invVal[0]?.v}`);
      const metric = (await q(`SELECT * FROM business_metrics WHERE business_id = $1`, [hw.id]))[0];
      ok("metrics carry NO folded expenses (zero-based)",
        metric && Number(metric.expenses_ghs) === 0, `expenses=${metric?.expenses_ghs}`);
      ok("metrics carry NO folded loss", metric && Number(metric.net_profit_ghs) === 0,
        `net=${metric?.net_profit_ghs}`);
      // Dashboard total = ledger total (live layering math).
      const ledgerExp = await q(
        `SELECT COALESCE(SUM(amount_ghs),0) s FROM transactions WHERE business_id = $1 AND type = 'EXPENSE'`,
        [hw.id]
      );
      ok("every displayed expense cedi exists as a ledger row",
        Math.abs(Number(ledgerExp[0].s) - Number(kitTx[0]?.amount_ghs || 0)) < 1,
        `ledger=${ledgerExp[0].s}`);
      const marker = await q(`SELECT value FROM system_markers WHERE key = 'hardware_flagship'`);
      ok("one-time hardware seed marker recorded", marker.length === 1);
    }

    // ══ H6. New hardware unit starts clean ══════════════════════════════
    console.log("── H6. New Hardware unit starts clean ──");
    const owner = await login(OWNER.email, OWNER.pw);
    const created = await call(owner, "/api/businesses", "POST", {
      name: "AUDIT Hardware Clean Unit",
      category: "Hardware Store",
      region: "Ashanti", district: "Kumasi Metropolitan", town: "Asokwa",
      managerName: "Clean Unit Manager", contactPhone: "+233 24 000 1111",
      initialCapitalGhs: 50000,
    });
    ok("hardware unit created from the app", created.status === 200 && created.body.success,
      JSON.stringify(created.body).slice(0, 120));
    const newId = created.body.business?.id;
    const newCode = created.body.business?.code;
    if (newId) {
      const counts = await q(`
        SELECT
          (SELECT COUNT(*) FROM inventory_items WHERE business_id = $1) inv,
          (SELECT COUNT(*) FROM transactions WHERE business_id = $1) tx,
          (SELECT COUNT(*) FROM hardware_orders WHERE business_id = $1) ord,
          (SELECT COUNT(*) FROM hardware_purchases WHERE business_id = $1) pur,
          (SELECT COUNT(*) FROM hardware_deliveries WHERE business_id = $1) dlv,
          (SELECT COUNT(*) FROM hardware_logs WHERE business_id = $1) grn,
          (SELECT COUNT(*) FROM business_metrics WHERE business_id = $1) met`,
        [newId]);
      const c = counts[0];
      ok("no starter inventory", Number(c.inv) === 0, `got ${c.inv}`);
      ok("no transactions (incl. no phantom opening expense)", Number(c.tx) === 0, `got ${c.tx}`);
      ok("no orders/purchases/deliveries/GRNs",
        [c.ord, c.pur, c.dlv, c.grn].every((v) => Number(v) === 0), JSON.stringify(c));
      ok("exactly one zero-based metrics row", Number(c.met) === 1);
      // Clean up the audit unit right away.
      const del = await call(owner, `/api/businesses/${newId}`, "DELETE", { confirmCode: newCode });
      ok("audit unit deleted (cleanup)", del.status === 200);
    }

    // ══ H3. Full hardware workflow on the flagship ══════════════════════
    console.log("── H3. Complete workflow (stock + finance, exactly once) ──");
    const init1 = await (await fetch(`${BASE}/api/init`, { headers: H(owner) })).json();
    const BIZ = init1.businesses.find((b) => b.code === "HARDWARE-01").id;
    const cement = init1.inventory.find((i) => i.businessId === BIZ && /Cement/i.test(i.name));
    const q0 = cement.quantity;
    console.log(`   (cement #${cement.id} starts at ${q0})`);

    // 3.1 counter sale
    const sale = await call(owner, "/api/sales", "POST", {
      businessId: BIZ, customerName: "AUDIT Buyer", paymentMethod: "CASH",
      cartItems: [{ inventoryId: cement.id, quantity: 10 }],
      createdByUserId: 1, createdByName: "Audit", createdByRole: "OWNER",
    });
    ok("counter sale recorded", sale.status === 200 && sale.body.success);

    // 3.2 order pipeline
    const order = await call(owner, "/api/hardware", "POST", { entity: "ORDER", data: {
      businessId: BIZ, customerName: "AUDIT Order", inventoryId: cement.id,
      itemName: cement.name, quantity: 20, unitPriceGhs: 118, deliverySite: "Audit Site",
      createdByName: "Audit", createdByRole: "OWNER" } });
    const ordId = order.body.item?.id;
    ok("order created", order.status === 200 && !!ordId);
    await call(owner, "/api/hardware", "PATCH", { entity: "ORDER", id: ordId, data: { status: "READY" } });
    const del1 = await call(owner, "/api/hardware", "PATCH", { entity: "ORDER", id: ordId, data: { status: "DELIVERED" } });
    ok("order delivered", del1.body.item?.status === "DELIVERED");

    // 3.3 purchase pipeline
    const pu = await call(owner, "/api/hardware", "POST", { entity: "PURCHASE", data: {
      businessId: BIZ, supplierName: "Ghacem Cement Distributors Ltd", itemName: cement.name,
      inventoryId: cement.id, quantity: 100, unitCostGhs: 100, status: "ORDERED",
      createdByName: "Audit", createdByRole: "OWNER" } });
    const puId = pu.body.item?.id;
    ok("purchase ordered", pu.status === 200 && !!puId);
    const rec1 = await call(owner, "/api/hardware", "PATCH", { entity: "PURCHASE", id: puId, data: { status: "RECEIVED" } });
    ok("purchase received", rec1.body.item?.status === "RECEIVED");

    // 3.4 standalone delivery
    const dl = await call(owner, "/api/hardware", "POST", { entity: "DELIVERY", data: {
      businessId: BIZ, customerName: "AUDIT Site", siteAddress: "Audit Addr", inventoryId: cement.id,
      itemName: cement.name, quantity: 5, unit: "Bags",
      createdByName: "Audit", createdByRole: "OWNER" } });
    const dlId = dl.body.item?.id;
    await call(owner, "/api/hardware", "PATCH", { entity: "DELIVERY", id: dlId, data: { status: "EN_ROUTE" } });
    const dd = await call(owner, "/api/hardware", "PATCH", { entity: "DELIVERY", id: dlId, data: { status: "DELIVERED" } });
    ok("standalone delivery completed", dd.body.item?.status === "DELIVERED");

    // 3.5 order-linked delivery — must NOT deduct again
    const dl2 = await call(owner, "/api/hardware", "POST", { entity: "DELIVERY", data: {
      businessId: BIZ, orderNumber: order.body.item.orderNumber, customerName: "AUDIT Order",
      inventoryId: cement.id, itemName: cement.name, quantity: 20, unit: "Bags",
      createdByName: "Audit", createdByRole: "OWNER" } });
    await call(owner, "/api/hardware", "PATCH", { entity: "DELIVERY", id: dl2.body.item?.id, data: { status: "DELIVERED" } });

    // 3.6 GRN
    const grn = await call(owner, "/api/logs/HARDWARE-01", "POST", {
      supplierName: "Ghacem Cement Distributors Ltd", itemName: cement.name,
      quantityReceived: 50, unit: "Bags", unitCostGhs: 98, condition: "GOOD",
      receivedBy: "Audit", recordedByRole: "OWNER", paymentMethod: "BANK_TRANSFER", recordExpense: true });
    ok("GRN logged", grn.status === 200 && grn.body.success);

    // 3.7 direct expense
    const ex = await call(owner, "/api/transactions", "POST", {
      businessId: BIZ, type: "EXPENSE", category: "Forklift Fuel", amountGhs: 250,
      paymentMethod: "CASH", description: "audit diesel", recordedBy: "Audit", recordedByRole: "OWNER" });
    ok("expense recorded", ex.status === 200 && ex.body.success);

    // ── H4. cache coherence: init reflects the mutations IMMEDIATELY ──
    console.log("── H4. /api/init reflects hardware mutations immediately ──");
    const init2 = await (await fetch(`${BASE}/api/init`, { headers: H(owner) })).json();
    const cement2 = init2.inventory.find((i) => i.id === cement.id);
    // 200 -10(sale) -20(order) +100(purchase) -5(standalone dlv) +50(GRN) = 315
    ok("stock math exact after workflow", cement2.quantity === q0 - 10 - 20 + 100 - 5 + 50,
      `expected ${q0 + 115}, got ${cement2.quantity}`);
    const txns = init2.transactions.filter((t) => t.businessId === BIZ);
    const saleTx = txns.filter((t) => t.type === "INCOME" && t.category === "Inventory Sale");
    const ordTx = txns.filter((t) => t.category === "HARDWARE_ORDER_SALE");
    ok("sale income booked once (10×118)", saleTx.length === 1 && saleTx[0].amountGhs === 1180,
      JSON.stringify(saleTx.map((t) => t.amountGhs)));
    ok("order revenue booked once (20×118)", ordTx.length === 1 && ordTx[0].amountGhs === 2360,
      JSON.stringify(ordTx.map((t) => t.amountGhs)));
    const purTx = txns.filter((t) => t.category === "Stock Purchase (Hardware)");
    ok("purchase expense booked once (100×100)", purTx.length === 1 && purTx[0].amountGhs === 10000,
      JSON.stringify(purTx.map((t) => t.amountGhs)));
    const grnTx = txns.filter((t) => t.category === "HARDWARE_STOCK_RECEIPT");
    ok("GRN expense booked once (50×98)", grnTx.length === 1 && grnTx[0].amountGhs === 4900,
      JSON.stringify(grnTx.map((t) => t.amountGhs)));
    const fuelTx = txns.filter((t) => t.category === "Forklift Fuel");
    ok("direct expense booked once", fuelTx.length === 1 && fuelTx[0].amountGhs === 250);

    // double-advance guards
    await call(owner, "/api/hardware", "PATCH", { entity: "ORDER", id: ordId, data: { status: "DELIVERED" } });
    await call(owner, "/api/hardware", "PATCH", { entity: "PURCHASE", id: puId, data: { status: "RECEIVED" } });
    const init3 = await (await fetch(`${BASE}/api/init`, { headers: H(owner) })).json();
    const cement3 = init3.inventory.find((i) => i.id === cement.id);
    const txns3 = init3.transactions.filter((t) => t.businessId === BIZ);
    ok("re-advancing terminal statuses changes nothing",
      cement3.quantity === cement2.quantity &&
      txns3.filter((t) => t.category === "HARDWARE_ORDER_SALE").length === 1 &&
      txns3.filter((t) => t.category === "Stock Purchase (Hardware)").length === 1,
      `qty=${cement3.quantity}`);

    // cancelled order never books
    const co = await call(owner, "/api/hardware", "POST", { entity: "ORDER", data: {
      businessId: BIZ, customerName: "AUDIT Cancel", inventoryId: cement.id, quantity: 3,
      unitPriceGhs: 118, createdByName: "Audit", createdByRole: "OWNER" } });
    await call(owner, "/api/hardware", "PATCH", { entity: "ORDER", id: co.body.item?.id, data: { status: "CANCELLED" } });
    const init4 = await (await fetch(`${BASE}/api/init`, { headers: H(owner) })).json();
    const cement4 = init4.inventory.find((i) => i.id === cement.id);
    ok("cancelled order: no stock movement, no revenue",
      cement4.quantity === cement3.quantity &&
      !init4.transactions.some((t) => t.businessId === BIZ && t.description?.includes("AUDIT Cancel")),
      `qty=${cement4.quantity}`);

    // ══ H5. Permissions & isolation ═════════════════════════════════════
    console.log("── H5. Permissions & isolation ──");
    const bm = await login("emmanuel@gomina360.com", "GoMina@User3"); // BM of POULTRY-01
    ok("cross-business BM blocked from hardware GET",
      (await call(bm, `/api/hardware?businessId=${BIZ}`)).status === 403);
    ok("cross-business BM blocked from hardware POST",
      (await call(bm, "/api/hardware", "POST", { entity: "ORDER", data: { businessId: BIZ, customerName: "x", quantity: 1 } })).status === 403);
    ok("cross-business BM blocked from GRN",
      (await call(bm, "/api/logs/HARDWARE-01", "POST", { supplierName: "x", itemName: "y", quantityReceived: 1 })).status === 403);
    ok("cross-business BM blocked from hardware expense",
      (await call(bm, "/api/transactions", "POST", { businessId: BIZ, type: "EXPENSE", category: "x", amountGhs: 1 })).status === 403);
    ok("anonymous blocked from hardware GET",
      (await fetch(`${BASE}/api/hardware?businessId=${BIZ}`)).status === 401);

    // worker expense-permission parity
    const worker = await login("akua.donkor@gomina360.com", "GoMina@User10"); // WORKER @ POULTRY-01, canRecordExpenses=false
    const wExp = await call(worker, "/api/transactions", "POST", {
      businessId: 1, type: "EXPENSE", category: "Sneaky", amountGhs: 10,
      recordedBy: "Worker", recordedByRole: "WORKER" });
    ok("WORKER without expense permission cannot book expenses (403)",
      wExp.status === 403, `got ${wExp.status}`);

    // Hardware-yard worker: same rule on the GRN route (books an expense).
    const W_EMAIL = "audit.hw.worker@gomina360.com", W_PW = "Audit@Worker1";
    const mkWorker = await call(owner, "/api/users", "POST", {
      name: "AUDIT HW Worker", email: W_EMAIL, role: "WORKER",
      assignedBusinessId: BIZ, phone: "+233240000009",
      canRecordSales: true, canRecordExpenses: false, canManageStock: true,
      password: W_PW,
    });
    if (mkWorker.status === 200 && mkWorker.body.success) {
      const hwWorkerTok = await login(W_EMAIL, W_PW);
      const g1 = await call(hwWorkerTok, "/api/logs/HARDWARE-01", "POST", {
        supplierName: "AUDIT Supplier", itemName: cement.name,
        quantityReceived: 2, unit: "Bags", unitCostGhs: 90, recordExpense: true });
      ok("hardware WORKER (no expense right) blocked from expense-booking GRN",
        g1.status === 403, `got ${g1.status}`);
      const g2 = await call(hwWorkerTok, "/api/logs/HARDWARE-01", "POST", {
        supplierName: "AUDIT Supplier", itemName: cement.name,
        quantityReceived: 2, unit: "Bags", unitCostGhs: 90, recordExpense: false });
      ok("hardware WORKER can still log a stock-only GRN",
        g2.status === 200 && g2.body.success, `got ${g2.status}`);
      const g3 = await call(hwWorkerTok, "/api/transactions", "POST", {
        businessId: BIZ, type: "EXPENSE", category: "Sneaky", amountGhs: 5 });
      ok("hardware WORKER blocked from direct expense posting",
        g3.status === 403, `got ${g3.status}`);
      // cleanup: remove the audit worker + its GRN trail
      await q(`DELETE FROM user_sessions WHERE user_id = (SELECT id FROM users WHERE email = $1)`, [W_EMAIL]);
      await q(`DELETE FROM hardware_logs WHERE supplier_name = 'AUDIT Supplier'`);
      await q(`DELETE FROM transactions WHERE category = 'HARDWARE_STOCK_RECEIPT' AND business_id = $1 AND recorded_by = 'AUDIT HW Worker'`, [BIZ]);
      await q(`DELETE FROM organization_members WHERE user_id = (SELECT id FROM users WHERE email = $1)`, [W_EMAIL]);
      await q(`DELETE FROM users WHERE email = $1`, [W_EMAIL]);
    } else {
      ok("hardware worker fixture created", false, JSON.stringify(mkWorker.body).slice(0, 120));
    }

    // ── Deletion permanence: phase 1 deletes the flagship ────────────────
    console.log("── H1 (phase 1). OWNER deletes HARDWARE-01 ──");
    const delHw = await call(owner, `/api/businesses/${BIZ}`, "DELETE", { confirmCode: "HARDWARE-01" });
    ok("HARDWARE-01 deleted by OWNER", delHw.status === 200 && delHw.body.success,
      JSON.stringify(delHw.body).slice(0, 120));
    const gone = await q(`SELECT COUNT(*) c FROM businesses WHERE code = 'HARDWARE-01'`);
    ok("HARDWARE-01 gone from businesses", Number(gone[0].c) === 0);
    const tomb = await q(`SELECT key FROM system_markers WHERE key = 'deleted_business:HARDWARE-01'`);
    ok("deletion tombstone recorded", tomb.length === 1);
    const hwRows = await q(`
      SELECT
        (SELECT COUNT(*) FROM inventory_items i JOIN businesses b ON b.id = i.business_id WHERE b.code = 'HARDWARE-01') inv,
        (SELECT COUNT(*) FROM hardware_orders) ord,
        (SELECT COUNT(*) FROM hardware_purchases) pur,
        (SELECT COUNT(*) FROM hardware_deliveries) dlv,
        (SELECT COUNT(*) FROM hardware_logs) grn`);
    ok("all hardware operational records purged",
      Number(hwRows[0].inv) === 0 && Number(hwRows[0].ord) === 0 &&
      Number(hwRows[0].pur) === 0 && Number(hwRows[0].dlv) === 0 && Number(hwRows[0].grn) === 0,
      JSON.stringify(hwRows[0]));
    console.log("\n→ NOW RESTART the app process, then run: node dev-tooling/verify-hardware-audit.mjs phase2");
  }

  if (PHASE === "phase2") {
    console.log("── H1 (phase 2). After restart: deletion is FINAL ──");
    const still = await q(`SELECT COUNT(*) c FROM businesses WHERE code = 'HARDWARE-01'`);
    ok("HARDWARE-01 NOT resurrected by the boot seeder", Number(still[0].c) === 0,
      `found ${still[0].c} row(s)`);
    const marker = await q(`SELECT key FROM system_markers WHERE key = 'hardware_flagship'`);
    ok("one-time hardware seed marker still recorded", marker.length === 1);
    const tomb = await q(`SELECT key FROM system_markers WHERE key = 'deleted_business:HARDWARE-01'`);
    ok("deletion tombstone still recorded", tomb.length === 1);
    const otherBiz = await q(`SELECT COUNT(*) c FROM businesses WHERE code <> 'HARDWARE-01'`);
    ok("other businesses untouched by the seed pass", Number(otherBiz[0].c) >= 7,
      `got ${otherBiz[0].c}`);
    // The seeder must not have re-provisioned starter inventory either.
    const inv = await q(
      `SELECT COUNT(*) c FROM inventory_items i JOIN businesses b ON b.id = i.business_id WHERE b.code = 'HARDWARE-01'`);
    ok("no orphaned hardware inventory", Number(inv[0].c) === 0);
  }
} finally {
  await client.end();
}

console.log(`\n══ hardware audit (${PHASE}): ${passed} passed, ${failed} failed ══`);
process.exit(failed ? 1 : 0);
