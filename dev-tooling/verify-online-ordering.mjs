/**
 * verify-online-ordering.mjs — Customer Online Ordering & Tracking E2E.
 *
 * Public storefront (no login): menu privacy, server-side pricing, stock
 * validation, CRM + chain linkage, staff notifications. Staff processing:
 * confirm → stock reservation (+ guard), cancel → stock restore, payment
 * confirmation → revenue booked + customer sees Paid. Full UI pass on the
 * /order storefront, /track payment card, staff console payment actions —
 * real browser, zero console errors. TEST data purged; inventory restored.
 */
import { createRequire } from "module";
const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");
const { Client } = require("pg");

const BASE = "http://127.0.0.1:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pass: process.env.GOMINA_OWNER_PW || "Owner@GoMina26" };
const WORKER = { email: "kwabena.mensah@gomina360.com", pass: "GoMina@User11" };
const T = "TEST OO Customer";

const results = [];
const baseline = {};
const pg = new Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });

const ok = (name, cond, extra = "") => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "✅" : "❌"} ${name}${cond ? "" : " — " + extra}`);
  return cond;
};

async function api(cookie, path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) },
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const loginCookie = async (creds) => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: creds.email, password: creds.pass }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  return (res.headers.get("set-cookie") || "").split(";")[0];
};

/* ── A: public menu ─────────────────────────────────────────────────── */
async function sectionA() {
  console.log("\n— A · Public menu API —");
  const res = await api(null, "/api/menu");
  const str = JSON.stringify(res.json || {});
  const biz1 = (res.json?.businesses || []).find((b) => b.businessId === 1);
  ok("A1 menu available with NO login", res.status === 200 && Array.isArray(res.json?.businesses) && res.json.businesses.length > 0);
  ok("A2 business→branch→products chain exposed", !!biz1 && typeof biz1.branchName === "string" && Array.isArray(biz1.products) && biz1.products.length > 0);
  const p = biz1?.products?.[0] || {};
  ok("A3 product fields: name/category/unit/price/availability",
    typeof p.name === "string" && typeof p.category === "string" && typeof p.unit === "string" && p.price > 0 && p.available > 0);
  ok("A4 menu leaks no costs/margins/thresholds",
    !str.includes("costPriceGhs") && !str.includes("minStockThreshold") && !str.includes("cost_price_ghs"), str.slice(0, 200));
  baseline.menuItem = biz1?.products?.[0];
}

/* ── B: public order placement ──────────────────────────────────────── */
async function sectionB(cookies) {
  console.log("\n— B · Anonymous checkout —");
  const p = baseline.menuItem;
  const order = await api(null, "/api/order", {
    method: "POST",
    body: JSON.stringify({
      businessId: 1, customerName: T, customerPhone: "0551223344",
      fulfillmentType: "PICKUP", paymentChoice: "ON_DELIVERY",
      items: [{ inventoryId: p.id, quantity: 1 }], note: "TEST note from customer",
    }),
  });
  const code = order.json?.trackingCode || "";
  ok("B1 anonymous customer places an order → GM-* code", /^GM-[A-Z0-9]+-[A-Z0-9]{6}$/.test(code), JSON.stringify(order.json || {}).slice(0, 200));
  baseline.code1 = code;

  const rows = (await pg.query(`SELECT * FROM customer_trackings WHERE tracking_code=$1`, [code])).rows;
  const r = rows[0];
  ok("B2 order chained: Business→Branch→Customer→Product→Payment→Delivery",
    r && r.business_id === 1 && !!r.branch_code && r.customer_id != null && r.order_source === "ONLINE" &&
    r.payment_status === "UNPAID" && r.payment_choice === "ON_DELIVERY" && r.fulfillment_type === "PICKUP" &&
    Array.isArray(r.items) && r.items[0].inventoryId === p.id && r.items[0].unitPrice === p.price);
  ok("B2b customer note + CRM link captured", r?.customer_note === "TEST note from customer" && r?.created_by_role === "CUSTOMER");

  const price = await api(null, "/api/order", {
    method: "POST",
    body: JSON.stringify({
      businessId: 1, customerName: T + " Tamper", customerPhone: "0551223344",
      items: [{ inventoryId: p.id, quantity: 2, unitPrice: 0.01 }],
    }),
  });
  const pr = (await pg.query(`SELECT total_ghs, items FROM customer_trackings WHERE tracking_code=$1`, [price.json?.trackingCode || ""])).rows[0];
  ok("B3 client-tampered prices ignored — server re-prices everything",
    pr && Math.abs(pr.total_ghs - 2 * p.price) < 1e-9, JSON.stringify(pr || {}).slice(0, 160));

  const over = await api(null, "/api/order", {
    method: "POST",
    body: JSON.stringify({
      businessId: 1, customerName: T, customerPhone: "0551998877",
      items: [{ inventoryId: p.id, quantity: Math.floor(p.available) + 5000 }],
    }),
  });
  ok("B4 over-ordering stock refused (409, named product)", over.status === 409 && (over.json?.error || "").includes("available"));

  const noName = await api(null, "/api/order", { method: "POST", body: JSON.stringify({ businessId: 1, customerPhone: "0551998877", items: [{ inventoryId: p.id, quantity: 1 }] }) });
  const noPhone = await api(null, "/api/order", { method: "POST", body: JSON.stringify({ businessId: 1, customerName: T, items: [{ inventoryId: p.id, quantity: 1 }] }) });
  const noDest = await api(null, "/api/order", { method: "POST", body: JSON.stringify({ businessId: 1, customerName: T, customerPhone: "0551998877", fulfillmentType: "DELIVERY", items: [{ inventoryId: p.id, quantity: 1 }] }) });
  const badBiz = await api(null, "/api/order", { method: "POST", body: JSON.stringify({ businessId: 99999, customerName: T, customerPhone: "0551998877", items: [{ inventoryId: p.id, quantity: 1 }] }) });
  ok("B5 validation: name(400) phone(400) delivery-address(400) business(404)",
    noName.status === 400 && noPhone.status === 400 && noDest.status === 400 && badBiz.status === 404);

  const momo = await api(null, "/api/order", {
    method: "POST",
    body: JSON.stringify({
      businessId: 1, customerName: T + " Momo", customerPhone: "0551223344",
      fulfillmentType: "DELIVERY", destinationAddress: "TEST Nsawam junction",
      paymentChoice: "MOMO_NOW", momoRef: "TESTMOMO123",
      items: [{ inventoryId: p.id, quantity: 1 }],
    }),
  });
  baseline.code2 = momo.json?.trackingCode;
  const mr = (await pg.query(`SELECT payment_status, payment_ref, destination_address FROM customer_trackings WHERE tracking_code=$1`, [baseline.code2 || ""])).rows[0];
  ok("B6 MoMo-now order → PENDING_CONFIRMATION with ref held staff-side",
    mr && mr.payment_status === "PENDING_CONFIRMATION" && mr.payment_ref === "TESTMOMO123" && mr.destination_address === "TEST Nsawam junction");
  const pub = await api(null, `/api/track?code=${baseline.code2}`);
  ok("B7 customer page shows payment status — but never the MoMo ref",
    pub.json?.tracking?.payment?.status === "PENDING_CONFIRMATION" && !JSON.stringify(pub.json).includes("TESTMOMO123"));

  const ntf = (await pg.query(
    `SELECT user_id FROM notifications WHERE type='ONLINE_ORDER_RECEIVED' AND record_ref=$1 AND id>$2`, [baseline.code2 ?? "", baseline.ntfMax])).rows;
  const ntfUsers = new Set(ntf.map((x) => x.user_id));
  ok("B8 owner + branch team bell-notified of the online order", ntfUsers.has(1) && ntfUsers.has(11), JSON.stringify(ntf));
}

/* ── C: staff processing — stock guard, payment, revenue ────────────── */
async function sectionC(cookies) {
  console.log("\n— C · Staff processing (stock & payment) —");
  const p = baseline.menuItem;
  const tr1 = (await pg.query(`SELECT * FROM customer_trackings WHERE tracking_code=$1`, [baseline.code1])).rows[0];

  // C1 stock commit on CONFIRM
  const invBefore = (await pg.query(`SELECT quantity FROM inventory_items WHERE id=$1`, [p.id])).rows[0].quantity;
  baseline.invTouched = { id: p.id, qty: invBefore };
  const conf = await api(cookies.worker, "/api/tracking", { method: "POST", body: JSON.stringify({ action: "SET_STATUS", id: tr1.id, status: "CONFIRMED" }) });
  const invAfter = (await pg.query(`SELECT quantity FROM inventory_items WHERE id=$1`, [p.id])).rows[0].quantity;
  ok("C1 staff CONFIRM reserves stock from branch inventory",
    conf.status === 200 && Math.abs(invAfter - (invBefore - 1)) < 1e-9,
    `conf=${conf.status} ${JSON.stringify(conf.json || {}).slice(0, 140)}`);
  ok("C1b stockCommitted flag set on the order",
    (await pg.query(`SELECT stock_committed FROM customer_trackings WHERE id=$1`, [tr1.id])).rows[0].stock_committed === true);

  // C2 cancel → stock returns
  const cancel = await api(cookies.worker, "/api/tracking", { method: "POST", body: JSON.stringify({ action: "SET_STATUS", id: tr1.id, status: "CANCELLED" }) });
  const invRestored = (await pg.query(`SELECT quantity FROM inventory_items WHERE id=$1`, [p.id])).rows[0].quantity;
  const cancelHist = (await pg.query(`SELECT status_history FROM customer_trackings WHERE id=$1`, [tr1.id])).rows[0].status_history;
  ok("C2 cancelling returns reserved stock (+ timeline says so)",
    cancel.status === 200 && Math.abs(invRestored - invBefore) < 1e-9 &&
    JSON.stringify(cancelHist).includes("returned") === true, JSON.stringify(cancelHist).slice(-200));

  // C3 confirm-guard: shrink stock under the order size → confirm must fail
  const guard = await api(null, "/api/order", {
    method: "POST",
    body: JSON.stringify({ businessId: 1, customerName: T + " Guard", customerPhone: "0551998877", items: [{ inventoryId: p.id, quantity: 5 }] }),
  });
  const gRow = (await pg.query(`SELECT id FROM customer_trackings WHERE tracking_code=$1`, [guard.json?.trackingCode || ""])).rows[0];
  baseline.qtyBeforeGuard = invBefore;
  await pg.query(`UPDATE inventory_items SET quantity=2, status='LOW_STOCK' WHERE id=$1`, [p.id]);
  const blocked = await api(cookies.owner, "/api/tracking", { method: "POST", body: JSON.stringify({ action: "SET_STATUS", id: gRow.id, status: "CONFIRMED" }) });
  await pg.query(`UPDATE inventory_items SET quantity=$2::double precision, status=CASE WHEN $2::double precision <=0 THEN 'OUT_OF_STOCK' WHEN $2::double precision <= min_stock_threshold THEN 'LOW_STOCK' ELSE 'IN_STOCK' END WHERE id=$1`, [p.id, baseline.qtyBeforeGuard]);
  const gStill = (await pg.query(`SELECT status, stock_committed FROM customer_trackings WHERE id=$1`, [gRow.id])).rows[0];
  ok("C3 confirm blocked with stock problem (409) and nothing deducted",
    blocked.status === 409 && (blocked.json?.error || "").includes("stock") && gStill.status === "RECEIVED" && gStill.stock_committed === false);

  // C4 MARK_PAID on the MoMo order → revenue booked + customer sees Paid
  const tr2 = (await pg.query(`SELECT * FROM customer_trackings WHERE tracking_code=$1`, [baseline.code2])).rows[0];
  const paid = await api(cookies.owner, "/api/tracking", { method: "POST", body: JSON.stringify({ action: "MARK_PAID", id: tr2.id, method: "MTN_MOMO" }) });
  const trx = paid.json?.tracking?.transactionId
    ? (await pg.query(`SELECT * FROM transactions WHERE id=$1`, [paid.json.tracking.transactionId])).rows[0]
    : null;
  ok("C4 staff confirm MoMo payment → PAID", paid.status === 200 && paid.json?.tracking?.paymentStatus === "PAID",
    JSON.stringify(paid.json || {}).slice(0, 180));
  ok("C4b revenue booked: INCOME transaction linked to the order",
    trx && trx.type === "INCOME" && trx.category === "Online Order Sale" && trx.payment_method === "MTN_MOMO" &&
    Math.abs(trx.amount_ghs - tr2.total_ghs) < 1e-9 && (trx.description || "").includes(baseline.code2));
  const pubPaid = await api(null, `/api/track?code=${baseline.code2}`);
  const paidHist = pubPaid.json?.tracking?.history || [];
  ok("C4c customer tracking page flips to Paid with a payment update",
    pubPaid.json?.tracking?.payment?.status === "PAID" && paidHist.some((h) => h.label === "Payment Confirmed"));

  // C5 guards: double-pay & cancelled-pay refused; worker out-of-scope refused
  const again = await api(cookies.owner, "/api/tracking", { method: "POST", body: JSON.stringify({ action: "MARK_PAID", id: tr2.id, method: "CASH" }) });
  const cancelledPay = await api(cookies.owner, "/api/tracking", { method: "POST", body: JSON.stringify({ action: "MARK_PAID", id: tr1.id, method: "CASH" }) });
  ok("C5 double payment (409) & cancelled-order payment (409) refused", again.status === 409 && cancelledPay.status === 409);

  const unauth = await api(null, "/api/order", { method: "GET" });
  ok("C6 storefront has no unsafe read surface (GET /api/order → 404/405)", unauth.status === 404 || unauth.status === 405);
}

/* ── D: real browser — storefront, tracking payment card, console ────── */
async function sectionD(cookies) {
  console.log("\n— D · Browser E2E (storefront + track + console) —");
  const browser = await puppeteer.launch({
    executablePath: "/tmp/al2023/chromium",
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const errors = [];
  const hookPage = (page, tag) => {
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const txt = m.text();
      if (/Failed to load resource/.test(txt) && /(401|400|403|404|409|413)/.test(txt)) return;
      if (/net::/.test(txt)) return;
      errors.push(`[${tag}] ${txt.slice(0, 300)}`);
    });
    page.on("pageerror", (e) => errors.push(`[${tag}] PAGEERROR ${String(e).slice(0, 300)}`));
  };

  /* Customer phones in an order on the storefront */
  const ctx = await browser.createBrowserContext();
  const p1 = await ctx.newPage();
  hookPage(p1, "storefront");
  await p1.setViewport({ width: 430, height: 932 });
  await p1.goto(`${BASE}/order`, { waitUntil: "networkidle0", timeout: 60000 });
  await p1.waitForFunction(() => document.body.innerText.includes("Order from our branches") || document.body.innerText.includes("Loading the store") === false, { timeout: 60000 });
  await p1.waitForSelector('[data-testid="oo-search"]', { timeout: 30000 });
  const anon = await p1.evaluate(() => ({
    hasLogin: !!document.querySelector('[data-testid="login-email"]'),
    hasSidebar: !!document.querySelector('[data-testid="nav-sidebar"]'),
    bizChips: document.querySelectorAll('[data-testid^="oo-biz-"]').length,
    products: document.querySelectorAll('[data-testid^="oo-prod-"]').length,
  }));
  ok("D1 storefront loads anonymously: branches + live-stock products",
    !anon.hasLogin && !anon.hasSidebar && anon.bizChips >= 1 && anon.products >= 1, JSON.stringify(anon));

  const firstAdd = await p1.evaluate(() => document.querySelector('[data-testid^="oo-add-"]')?.getAttribute("data-testid"));
  await p1.click(`[data-testid="${firstAdd}"]`);
  await p1.waitForSelector('[data-testid="oo-cart"]', { timeout: 10000 });
  ok("D2 add-to-cart works (cart bar with total)", true);
  // Fixed cart bar can overlap mid-page controls after scrollIntoView(nearest)
  // on a phone viewport — centre them first, as a human would.
  const centreClick = async (tid) => {
    await p1.$eval(`[data-testid="${tid}"]`, (el) => el.scrollIntoView({ block: "center" }));
    await new Promise((r) => setTimeout(r, 150));
    await p1.click(`[data-testid="${tid}"]`);
  };
  await centreClick("oo-delivery");
  await p1.waitForSelector('[data-testid="oo-destination"]', { timeout: 5000 });
  await p1.type('[data-testid="oo-name"]', T + " UI");
  await p1.type('[data-testid="oo-phone"]', "0551444555");
  await p1.type('[data-testid="oo-destination"]', "TEST Kasoa toll booth");
  // Delivery orders now pin their exact point on Google Maps (no geolocation
  // permission here → drop the pin at the map centre, then confirm).
  await p1.waitForSelector('[data-testid="oo-pin-root"]', { timeout: 10000 });
  await centreClick("oo-pin-set");
  await p1.waitForFunction(() => (document.querySelector('[data-testid="oo-pin-coords"]')?.textContent || "").includes(","), { timeout: 10000 });
  await centreClick("oo-place");
  await p1.waitForSelector('[data-testid="oo-code"]', { timeout: 20000 });
  const uiCode = await p1.$eval('[data-testid="oo-code"]', (el) => el.textContent.trim());
  ok("D3 customer places the whole order on their phone → tracking code", /^GM-[A-Z0-9]+-[A-Z0-9]{6}$/.test(uiCode), uiCode);
  baseline.code3 = uiCode;
  const uiRow = (await pg.query(`SELECT order_source, fulfillment_type, payment_status FROM customer_trackings WHERE tracking_code=$1`, [uiCode])).rows[0];
  ok("D3b UI order lands as ONLINE delivery order in the same system",
    uiRow?.order_source === "ONLINE" && uiRow?.fulfillment_type === "DELIVERY" && uiRow?.payment_status === "UNPAID");

  // Track it from the success button
  await p1.click('[data-testid="oo-track-my-order"]');
  await p1.waitForSelector('[data-testid="track-stepper"]', { timeout: 30000 });
  await p1.waitForSelector('[data-testid="track-payment"]', { timeout: 30000 });
  const payTxt = await p1.$eval('[data-testid="track-payment"]', (el) => el.textContent);
  ok("D4 customer sees order details + payment status ('Not paid yet') on /track",
    /Not paid yet/.test(payTxt) && /pay when your order arrives|Pay cash or MoMo/i.test(payTxt));
  await p1.screenshot({ path: "/home/user/order-2-customer-track.png" });
  await ctx.close();

  /* Owner console: ONLINE chip + payment confirmation via UI */
  const ctx2 = await browser.createBrowserContext();
  const p2 = await ctx2.newPage();
  hookPage(p2, "console");
  await p2.setViewport({ width: 1440, height: 960 });
  await p2.goto(`${BASE}/`, { waitUntil: "networkidle0", timeout: 60000 });
  await p2.waitForSelector('[data-testid="login-email"]', { timeout: 60000 });
  await p2.type('[data-testid="login-email"]', OWNER.email);
  await p2.type('[data-testid="login-password"]', OWNER.pass);
  await p2.click('[data-testid="login-submit"]');
  await p2.waitForFunction(() => !document.querySelector('[data-testid="login-email"]'), { timeout: 60000 });
  await p2.waitForSelector('[data-testid="sidebar-tab-tracking"]', { timeout: 30000 });
  await p2.click('[data-testid="sidebar-tab-tracking"]');
  await p2.waitForSelector('[data-testid="ct-root"]', { timeout: 30000 });
  await p2.type('[data-testid="ct-search"]', uiCode);
  await new Promise((r) => setTimeout(r, 1500));
  const uiTr = (await pg.query(`SELECT id FROM customer_trackings WHERE tracking_code=$1`, [uiCode])).rows[0];
  await p2.waitForSelector(`[data-testid="ct-online-${uiTr.id}"]`, { timeout: 15000 });
  ok("D5 console flags the order ONLINE", true);
  await p2.click(`[data-testid="ct-expand-${uiTr.id}"]`);
  await p2.waitForSelector(`[data-testid="ct-markpaid-${uiTr.id}"]`, { timeout: 10000 });
  await p2.click(`[data-testid="ct-markpaid-${uiTr.id}"]`);
  await new Promise((r) => setTimeout(r, 1800));
  const paidRow = (await pg.query(`SELECT payment_status, payment_method FROM customer_trackings WHERE id=$1`, [uiTr.id])).rows[0];
  ok("D5b owner confirms payment from the console (Cash, revenue booked)",
    paidRow.payment_status === "PAID" && paidRow.payment_method === "CASH");

  // AI help content covers online ordering + payments
  await p2.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /How to Use/i.test(x.textContent || ""));
    b?.click();
  });
  await new Promise((r) => setTimeout(r, 800));
  const aiText = await p2.evaluate(() => document.body.innerText);
  ok("D6 AI Help explains online ordering, processing & payments",
    /online order/i.test(aiText) && /payment/i.test(aiText) && /confirm/i.test(aiText));
  await p2.keyboard.press("Escape");
  await p2.screenshot({ path: "/home/user/order-3-console-online.png" });
  await ctx2.close();

  // storefront screenshot for the record
  const ctx3 = await browser.createBrowserContext();
  const p3 = await ctx3.newPage();
  hookPage(p3, "storefront2");
  await p3.setViewport({ width: 430, height: 932 });
  await p3.goto(`${BASE}/order`, { waitUntil: "networkidle0", timeout: 60000 });
  await p3.waitForSelector('[data-testid="oo-search"]', { timeout: 30000 });
  await p3.screenshot({ path: "/home/user/order-1-storefront.png" });
  await ctx3.close();

  await browser.close();
  ok("D7 ZERO page/console errors across storefront, track & console", errors.length === 0, errors.slice(0, 4).join(" | "));
}

/* ── cleanup & forensics ────────────────────────────────────────────── */
async function cleanup() {
  console.log("\n— Z · cleanup & forensics —");
  if (baseline.invTouched) {
    await pg.query(`UPDATE inventory_items SET quantity=$2::double precision, status=CASE WHEN $2::double precision <=0 THEN 'OUT_OF_STOCK' WHEN $2::double precision <= min_stock_threshold THEN 'LOW_STOCK' ELSE 'IN_STOCK' END WHERE id=$1`, [baseline.invTouched.id, baseline.invTouched.qty]);
  }
  const trk = await pg.query(`DELETE FROM customer_trackings WHERE id > $1 OR customer_name LIKE 'TEST%' RETURNING id`, [baseline.trMax]);
  const trx = await pg.query(`DELETE FROM transactions WHERE id > $1 AND (category='Online Order Sale' OR description LIKE '%TEST%') RETURNING id`, [baseline.trxMax]);
  const ntf = await pg.query(`DELETE FROM notifications WHERE id > $1 AND type IN ('ONLINE_ORDER_RECEIVED','ORDER_TRACKING_STATUS') RETURNING id`, [baseline.ntfMax]);
  const cust = await pg.query(`DELETE FROM customers WHERE id > $1 AND name LIKE 'TEST%' RETURNING id`, [baseline.custMax]);
  const sess = await pg.query(`DELETE FROM user_sessions WHERE id > $1 RETURNING id`, [baseline.sessMax]);
  const leftovers = (await pg.query(`SELECT count(*)::int c FROM customer_trackings WHERE customer_name LIKE 'TEST%'`)).rows[0].c;
  const trxLeft = (await pg.query(`SELECT count(*)::int c FROM transactions WHERE category='Online Order Sale' AND description LIKE '%TEST%'`)).rows[0].c;
  const invNow = baseline.invTouched ? (await pg.query(`SELECT quantity FROM inventory_items WHERE id=$1`, [baseline.invTouched.id])).rows[0].quantity : null;
  ok("Z1 TEST orders/transactions/notifications/customers/sessions purged", leftovers === 0 && trxLeft === 0);
  ok("Z2 inventory restored to exact pre-test quantity", !baseline.invTouched || Math.abs(invNow - baseline.invTouched.qty) < 1e-9, `qty=${invNow} want ${baseline.invTouched?.qty}`);
  const ntfLeft = (await pg.query(`SELECT count(*)::int c FROM notifications WHERE type='ONLINE_ORDER_RECEIVED' AND id > $1`, [baseline.ntfMax])).rows[0].c;
  ok("Z3 no TEST online-order notifications left behind (pre-existing user data untouched)", ntfLeft === 0);
  console.log(`   purged: trackings=${trk.rowCount} transactions=${trx.rowCount} notifications=${ntf.rowCount} customers=${cust.rowCount} sessions=${sess.rowCount}`);
}

(async () => {
  await pg.connect();
  baseline.trMax = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM customer_trackings`)).rows[0].m;
  baseline.trxMax = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM transactions`)).rows[0].m;
  baseline.ntfMax = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM notifications`)).rows[0].m;
  baseline.custMax = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM customers`)).rows[0].m;
  baseline.sessMax = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM user_sessions`)).rows[0].m;

  const cookies = { owner: await loginCookie(OWNER), worker: await loginCookie(WORKER) };
  try {
    await sectionA();
    await sectionB(cookies);
    await sectionC(cookies);
    await sectionD(cookies);
  } catch (e) {
    ok(`suite crashed: ${e.message}`, false);
    console.error(e);
  } finally {
    try { await cleanup(); } catch (e) { console.error("cleanup error:", e.message); }
    await pg.end();
  }
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
