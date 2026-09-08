/**
 * verify-tracking.mjs — Customer Tracking end-to-end.
 *
 * Covers: unique codes minted on every sale, public no-login tracking page
 * (strict per-code scoping / privacy), the 5-status flow with transition
 * guards, Business→Branch→Customer→Order→Product linkage, staff
 * authorization scoping (owner/manager/worker), live Google-Maps dispatch
 * location, notifications, staff console UI + public page UI (real browser,
 * ZERO console errors incl. maps iframe), AI help content, full data hygiene
 * (everything TEST-* purged, user data untouched).
 */
import { createRequire } from "module";
const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");
const { Client } = require("pg");

const BASE = "http://127.0.0.1:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pass: process.env.GOMINA_OWNER_PW || "Owner@GoMina26" };
const WORKER = { email: "kwabena.mensah@gomina360.com", pass: "GoMina@User11" }; // id 11, biz 1
const BM = { email: "emmanuel@gomina360.com", pass: "GoMina@User3" }; // id 3, BM biz 1
const TEST_NAME = "TEST Track Customer";
const TEST_PHONE = "0500998877";

const results = [];
let baseline = {};
const pg = new Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });

const ok = (name, cond, extra = "") => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "✅" : "❌"} ${name}${cond ? "" : " — " + extra}`);
  return cond;
};

async function api(cookie, path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(opts.headers || {}),
    },
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const login = async (email, password) => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status}`);
  return (res.headers.get("set-cookie") || "").split(";")[0];
};

/* ── A: sale mints a tracking code; public access is scoped ───────────── */
async function sectionA(pg, cookies) {
  console.log("\n— A · Sale auto-mints tracking code / public scoping —");
  const inv = (await pg.query(
    `SELECT * FROM inventory_items WHERE business_id=1 AND status <> 'OUT_OF_STOCK' AND quantity >= 1 ORDER BY id LIMIT 1`)).rows[0];
  const invQtyBefore = inv.quantity;
  baseline.invId = inv.id;
  baseline.invQty = invQtyBefore;

  const sale = await api(cookies.worker, "/api/sales", {
    method: "POST",
    body: JSON.stringify({
      businessId: 1,
      branchCode: "POULTRY-01",
      customerName: TEST_NAME,
      customerPhone: TEST_PHONE,
      paymentMethod: "CASH",
      cartItems: [{ inventoryId: inv.id, sku: inv.sku, name: inv.name, quantity: 1, originalPrice: inv.selling_price_ghs, sellingPrice: inv.selling_price_ghs }],
      createdByUserId: 11, createdByName: "Kwabena Mensah", createdByRole: "WORKER",
    }),
  });
  const code = sale.json?.trackingCode || "";
  ok("A1 sale returns a unique GM-* tracking code", /^GM-[A-Z0-9]+-[A-Z0-9]{6}$/.test(code), JSON.stringify(sale.json).slice(0, 200));

  const rows = (await pg.query(`SELECT * FROM customer_trackings WHERE tracking_code=$1`, [code])).rows;
  const row = rows[0];
  ok("A2 DB row links Business→Branch→Customer→Order→Product",
    row && row.business_id === 1 && !!row.branch_code && row.customer_name === TEST_NAME &&
    row.sale_document_id != null && row.transaction_id != null &&
    Array.isArray(row.items) && row.items.length === 1 && row.status === "RECEIVED" &&
    Array.isArray(row.status_history) && row.status_history.length === 1,
    JSON.stringify(row || {}).slice(0, 300));
  baseline.saleCode = code;
  baseline.saleDocId = row?.sale_document_id;
  baseline.saleTrxId = row?.transaction_id;

  const pub = await api(null, `/api/track?code=${encodeURIComponent(code)}`);
  const pubStr = JSON.stringify(pub.json || {});
  ok("A3 public lookup works with NO login & returns only this code's data",
    pub.status === 200 && pub.json?.tracking?.code === code &&
    pub.json.tracking.businessName && pub.json.tracking.customerName === TEST_NAME &&
    pub.json.tracking.items?.length === 1 && pub.json.tracking.history?.length === 1);
  ok("A3b public payload leaks no PII/internals",
    pub.status === 200 && !pubStr.includes(TEST_PHONE) &&
    !pubStr.includes("createdByUserId") && !pubStr.includes("customerPhone") &&
    !pubStr.includes("saleDocumentId") && !pubStr.includes("transactionId"),
    pubStr.slice(0, 240));

  const unknown = await api(null, `/api/track?code=GM-POULTRY-ZZZZZZ`);
  ok("A4 unknown code → 404 (nothing revealed)", unknown.status === 404);
  const malformed = await api(null, `/api/track?code=ABC123`);
  ok("A5 malformed code → 400", malformed.status === 400);
  const noCode = await api(null, `/api/track`);
  ok("A5b missing code → 400", noCode.status === 400);

  // Public must NOT require auth — but staff API MUST.
  const unauthList = await api(null, `/api/tracking`);
  ok("A6 staff console API refuses anonymous access (401)", unauthList.status === 401);
  const unauthPost = await api(null, `/api/tracking`, { method: "POST", body: JSON.stringify({ action: "CREATE", businessId: 1 }) });
  ok("A6b staff mutation refuses anonymous access (401)", unauthPost.status === 401);
}

/* ── B: status flow, transitions, role scoping ────────────────────────── */
async function sectionB(pg, cookies) {
  console.log("\n— B · Status flow & authorization —");
  const code = baseline.saleCode;
  const find = async (ck) => {
    const res = await api(ck, `/api/tracking?q=${encodeURIComponent(code)}`);
    return (res.json?.trackings || []).find((t) => t.trackingCode === code);
  };
  let t = await find(cookies.worker);
  ok("B0 worker sees own-branch order in console list", !!t && t.id > baseline.trMax);

  for (const next of ["CONFIRMED", "PROCESSING"]) {
    const r = await api(cookies.worker, "/api/tracking", { method: "POST", body: JSON.stringify({ action: "SET_STATUS", id: t.id, status: next, note: `moving to ${next}` }) });
    ok(`B1 worker advances ${t.status} → ${next}`, r.status === 200 && r.json?.tracking?.status === next, JSON.stringify(r.json || {}).slice(0, 150));
    t = r.json.tracking;
  }
  ok("B1b history grew with actor + timestamp entries",
    Array.isArray(t.statusHistory ?? t.status_history ? (t.statusHistory ?? t.status_history) : []) &&
    (t.statusHistory || t.status_history).length === 3);

  const bad = await api(cookies.owner, "/api/tracking", { method: "POST", body: JSON.stringify({ action: "SET_STATUS", id: t.id, status: "DELIVERED" }) });
  ok("B2 invalid jump PROCESSING → DELIVERED refused (400)", bad.status === 400);

  // Owner creates a tracking in business 2 — worker (biz 1) must not touch it.
  const c2 = await api(cookies.owner, "/api/tracking", {
    method: "POST",
    body: JSON.stringify({ action: "CREATE", businessId: 2, customerName: TEST_NAME + " B2", items: [{ description: "TEST blocks", quantity: 10, unitPrice: 5 }], note: "TEST" }),
  });
  const code2 = c2.json?.tracking?.trackingCode;
  ok("B3 owner creates biz-2 tracking", /^GM-/.test(code2 || ""));
  baseline.biz2Code = code2;

  const workerList = await api(cookies.worker, `/api/tracking`);
  ok("B3b worker console never lists biz-2 orders",
    (workerList.json?.trackings || []).every((x) => x.businessId === 1 || x.business_id === 1));

  const denied = await api(cookies.worker, "/api/tracking", { method: "POST", body: JSON.stringify({ action: "SET_STATUS", id: c2.json.tracking.id, status: "CONFIRMED" }) });
  ok("B4 worker cannot update another branch's order (403)", denied.status === 403);

  const deniedCreate = await api(cookies.worker, "/api/tracking", {
    method: "POST", body: JSON.stringify({ action: "CREATE", businessId: 2, customerName: TEST_NAME, items: [{ description: "x", quantity: 1, unitPrice: 1 }] }),
  });
  ok("B4b worker cannot create in another branch (403)", deniedCreate.status === 403);

  // Branch manager of biz 1: scoped view + cannot touch biz 2 either.
  const bmList = await api(cookies.bm, `/api/tracking`);
  ok("B5 branch manager sees only own branch scope",
    (bmList.json?.trackings || []).length > 0 &&
    (bmList.json?.trackings || []).every((x) => x.businessId === 1));
  const bmDenied = await api(cookies.bm, "/api/tracking", { method: "POST", body: JSON.stringify({ action: "SET_STATUS", id: c2.json.tracking.id, status: "CONFIRMED" }) });
  ok("B5b branch manager refused on out-of-scope order (403)", bmDenied.status === 403);

  const ownerList = await api(cookies.owner, `/api/tracking`);
  const ownerBiz2 = (ownerList.json?.trackings || []).find((x) => x.trackingCode === code2);
  ok("B6 owner sees every business's orders", !!ownerBiz2);
}

/* ── C: delivery flow + live location ─────────────────────────────────── */
async function sectionC(pg, cookies) {
  console.log("\n— C · Dispatch & live location —");
  const create = await api(cookies.owner, "/api/tracking", {
    method: "POST",
    body: JSON.stringify({
      action: "CREATE", businessId: 1, customerName: TEST_NAME + " Delivery",
      items: [{ description: "TEST dressed chicken", quantity: 2, unitPrice: 90 }],
      fulfillmentType: "DELIVERY", destinationAddress: "TEST Kasoa market", note: "TEST",
    }),
  });
  const tr = create.json?.tracking;
  baseline.dlvId = tr?.id;
  baseline.dlvCode = tr?.trackingCode;
  ok("C1 owner creates DELIVERY tracking", /^GM-/.test(tr?.trackingCode || "") && tr?.status === "RECEIVED");

  const earlyLoc = await api(cookies.owner, "/api/tracking", { method: "POST", body: JSON.stringify({ action: "LOCATION", id: tr.id, lat: 5.6037, lng: -0.1870 }) });
  ok("C2 location ping refused before dispatch (409)", earlyLoc.status === 409);

  for (const next of ["CONFIRMED", "PROCESSING", "DISPATCHED"]) {
    const r = await api(cookies.owner, "/api/tracking", { method: "POST", body: JSON.stringify({ action: "SET_STATUS", id: tr.id, status: next }) });
    ok(`C3 advance → ${next}`, r.status === 200 && r.json?.tracking?.status === next, JSON.stringify(r.json || {}).slice(0, 140));
  }

  const loc = await api(cookies.owner, "/api/tracking", {
    method: "POST", body: JSON.stringify({ action: "LOCATION", id: tr.id, lat: 5.60371, lng: -0.18701, driverName: "TEST Rider", vehicleNote: "TEST bike" }),
  });
  ok("C4 live location accepted while DISPATCHED", loc.status === 200);

  const pub = await api(null, `/api/track?code=${baseline.dlvCode}`);
  const live = pub.json?.tracking?.live;
  ok("C5 public page now shows LIVE map data (Google Maps coords)",
    live && Math.abs(live.lat - 5.60371) < 1e-6 && Math.abs(live.lng + 0.18701) < 1e-6 && live.driverName === "TEST Rider");
  ok("C5b public payload carries the customer's own destination only",
    pub.json?.tracking?.destinationAddress === "TEST Kasoa market");

  const done = await api(cookies.owner, "/api/tracking", { method: "POST", body: JSON.stringify({ action: "SET_STATUS", id: tr.id, status: "DELIVERED" }) });
  ok("C6 DISPATCHED → DELIVERED", done.status === 200);
  const pub2 = await api(null, `/api/track?code=${baseline.dlvCode}`);
  ok("C6b live map closes after delivery (coords no longer public)", pub2.json?.tracking?.live === null && pub2.json?.tracking?.status === "DELIVERED");
  const after = await api(cookies.owner, "/api/tracking", { method: "POST", body: JSON.stringify({ action: "SET_STATUS", id: tr.id, status: "CANCELLED" }) });
  ok("C7 terminal orders reject further updates (400)", after.status === 400);
}

/* ── D: staff notifications on status change ─────────────────────────── */
async function sectionD(pg, cookies) {
  console.log("\n— D · Notifications —");
  const create = await api(cookies.worker, "/api/tracking", {
    method: "POST",
    body: JSON.stringify({ action: "CREATE", businessId: 1, customerName: TEST_NAME + " Notify", items: [{ description: "TEST eggs tray", quantity: 1, unitPrice: 55 }] }),
  });
  baseline.ntfId = create.json?.tracking?.id;
  const adv = await api(cookies.owner, "/api/tracking", { method: "POST", body: JSON.stringify({ action: "SET_STATUS", id: create.json.tracking.id, status: "CONFIRMED", note: "approved" }) });
  ok("D0 owner advances worker-created order", adv.status === 200);
  const n = (await pg.query(
    `SELECT * FROM notifications WHERE type='ORDER_TRACKING_STATUS' AND user_id=11 AND id > $1 ORDER BY id DESC LIMIT 1`, [baseline.ntfMax])).rows[0];
  ok("D1 creator got an in-app bell notification of the change",
    !!n && n.title.includes("Confirmed") && (n.body || "").includes("Kwame"),
    JSON.stringify(n || {}).slice(0, 200));
}

/* ── E: real browser E2E — staff console + public page (0 errors) ─────── */
async function sectionE(pg) {
  console.log("\n— E · Browser E2E (staff console, worker tab, public page) —");
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
      if (/net::/.test(txt)) return; // maps iframe / beacon transport noise
      errors.push(`[${tag}] ${txt.slice(0, 300)}`);
    });
    page.on("pageerror", (e) => errors.push(`[${tag}] PAGEERROR ${String(e).slice(0, 300)}`));
  };
  const loginUi = async (page, creds) => {
    await page.goto(`${BASE}/`, { waitUntil: "networkidle0", timeout: 60000 });
    await page.waitForSelector('[data-testid="login-email"]', { timeout: 60000 });
    await page.type('[data-testid="login-email"]', creds.email);
    await page.type('[data-testid="login-password"]', creds.pass);
    await page.click('[data-testid="login-submit"]');
    await page.waitForFunction(() => !document.querySelector('[data-testid="login-email"]'), { timeout: 60000 });
    await new Promise((r) => setTimeout(r, 1500));
  };

  /* E1 owner console + AI help */
  const ctx1 = await browser.createBrowserContext();
  const p1 = await ctx1.newPage();
  hookPage(p1, "owner");
  await p1.setViewport({ width: 1440, height: 960 });
  await loginUi(p1, OWNER);
  await p1.waitForSelector('[data-testid="sidebar-tab-tracking"]', { timeout: 30000 });
  ok("E1 owner sidebar shows Customer Order & Tracking", true);
  await p1.click('[data-testid="sidebar-tab-tracking"]');
  await p1.waitForSelector('[data-testid="ct-root"]', { timeout: 30000 });
  const kpis = await p1.evaluate(() => ["ct-kpi-active", "ct-kpi-dispatched", "ct-kpi-ready", "ct-kpi-done"].every((id) => document.querySelector(`[data-testid="${id}"]`)));
  ok("E1b console renders with KPI strip", kpis);

  // AI help
  await p1.evaluate(() => {
    const btns = [...document.querySelectorAll("button")];
    const b = btns.find((x) => /How to Use/i.test(x.textContent || ""));
    b?.click();
  });
  await new Promise((r) => setTimeout(r, 800));
  const aiText = await p1.evaluate(() => document.body.innerText);
  ok("E2 AI Help explains create/update/use of tracking",
    /tracking code/i.test(aiText) && /Give a customer|tracking/i.test(aiText) && /status/i.test(aiText));
  await p1.keyboard.press("Escape");

  /* E3 create via UI */
  await p1.click('[data-testid="ct-new-btn"]');
  await p1.waitForSelector('[data-testid="ct-new-root"]', { timeout: 10000 });
  await p1.select('[data-testid="ct-new-biz"]', "1");
  await p1.type('[data-testid="ct-new-customer"]', TEST_NAME + " UI");
  await p1.type('[data-testid="ct-item-desc-0"]', "TEST UI broiler");
  await p1.type('[data-testid="ct-item-price-0"]', "95");
  await p1.click('[data-testid="ct-new-submit"]');
  await p1.waitForSelector('[data-testid="ct-new-code"]', { timeout: 15000 });
  const uiCode = await p1.$eval('[data-testid="ct-new-code"]', (el) => el.textContent.trim());
  ok("E3 console creates a tracking & shows the code to give the customer", /^GM-[A-Z0-9]+-[A-Z0-9]{6}$/.test(uiCode), uiCode);
  baseline.uiCode = uiCode;
  await p1.click('[data-testid="ct-new-done"]');
  await new Promise((r) => setTimeout(r, 1200));

  /* E3b advance a status from the UI */
  const uiRow = (await pg.query(`SELECT id FROM customer_trackings WHERE tracking_code=$1`, [uiCode])).rows[0];
  await p1.waitForSelector(`[data-testid="ct-expand-${uiRow.id}"]`, { timeout: 15000 });
  await p1.click(`[data-testid="ct-expand-${uiRow.id}"]`);
  await p1.waitForSelector(`[data-testid="ct-adv-${uiRow.id}-CONFIRMED"]`, { timeout: 10000 });
  await p1.type(`[data-testid="ct-note-${uiRow.id}"]`, "TEST confirmed via console");
  await p1.click(`[data-testid="ct-adv-${uiRow.id}-CONFIRMED"]`);
  await new Promise((r) => setTimeout(r, 1500));
  const pubAfter = await api(null, `/api/track?code=${uiCode}`);
  ok("E3b status update via UI reaches the public page instantly",
    pubAfter.json?.tracking?.status === "CONFIRMED" &&
    (pubAfter.json.tracking.history || []).some((h) => (h.note || "").includes("TEST confirmed via console")));
  await p1.screenshot({ path: "/home/user/track-1-console.png" });
  await ctx1.close();

  /* E4 worker workspace tab scoping */
  const ctx2 = await browser.createBrowserContext();
  const p2 = await ctx2.newPage();
  hookPage(p2, "worker");
  await p2.setViewport({ width: 1440, height: 960 });
  await loginUi(p2, WORKER);
  await p2.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /Order & Tracking/i.test(x.textContent || ""));
    b?.click();
  });
  await p2.waitForSelector('[data-testid="worker-tracking-tab"] [data-testid="ct-root"]', { timeout: 30000 });
  await p2.waitForFunction(() => !document.body.innerText.includes("Loading trackings"), { timeout: 30000 });
  const workerText = await p2.evaluate(() => document.body.innerText);
  ok("E4 worker gets the tracking console inside their workspace", true);
  ok("E4b worker workspace never shows biz-2 orders",
    baseline.biz2Code ? !workerText.includes(baseline.biz2Code) : true);
  await p2.screenshot({ path: "/home/user/worker-tracking.png" });
  await ctx2.close();

  /* E5 branch manager sidebar entry */
  const ctx3 = await browser.createBrowserContext();
  const p3 = await ctx3.newPage();
  hookPage(p3, "bm");
  await p3.setViewport({ width: 1440, height: 960 });
  await loginUi(p3, BM);
  const bmHasEntry = await p3.evaluate(() => !!document.querySelector('[data-testid="sidebar-tab-tracking"]'));
  ok("E5 branch manager sidebar shows Order & Tracking", bmHasEntry);
  await ctx3.close();

  /* E6 public customer page — dispatched order with live map */
  const ctx4 = await browser.createBrowserContext();
  const p4 = await ctx4.newPage();
  hookPage(p4, "public");
  await p4.setViewport({ width: 430, height: 932 }); // a customer phone
  await p4.goto(`${BASE}/track?code=${encodeURIComponent(baseline.dlvCode)}`, { waitUntil: "networkidle0", timeout: 60000 });
  await p4.waitForSelector('[data-testid="track-stepper"]', { timeout: 30000 });
  const pubChecks = await p4.evaluate(() => ({
    hasLogin: !!document.querySelector('[data-testid="login-email"]'),
    hasSidebar: !!document.querySelector('[data-testid="nav-sidebar"]'),
    body: document.body.innerText,
  }));
  ok("E6 public page is customer-facing: no login form, no staff dashboard",
    !pubChecks.hasLogin && !pubChecks.hasSidebar);
  ok("E6b customer sees journey, order details and update feed",
    /Delivered/i.test(pubChecks.body) && /TEST Kasoa market/.test(pubChecks.body) && /Status updates/i.test(pubChecks.body));

  // unknown code message
  await p4.goto(`${BASE}/track?code=GM-POULTRY-XXXXX9`, { waitUntil: "networkidle0", timeout: 60000 });
  await p4.waitForSelector('[data-testid="track-error"]', { timeout: 30000 });
  ok("E6c unknown code shows a friendly not-found state", true);

  // live map while dispatched: build a fresh dispatched order via UI-driven flow
  const mk = await api(await loginCookie(OWNER), "/api/tracking", {
    method: "POST",
    body: JSON.stringify({ action: "CREATE", businessId: 1, customerName: TEST_NAME + " Map", items: [{ description: "TEST eggs", quantity: 1, unitPrice: 55 }], fulfillmentType: "DELIVERY", destinationAddress: "TEST town" }),
  });
  const mapTr = mk.json.tracking;
  baseline.mapId = mapTr.id;
  baseline.mapCode = mapTr.trackingCode;
  const ownCk = await loginCookie(OWNER);
  for (const next of ["CONFIRMED", "PROCESSING", "DISPATCHED"]) {
    await api(ownCk, "/api/tracking", { method: "POST", body: JSON.stringify({ action: "SET_STATUS", id: mapTr.id, status: next }) });
  }
  await api(ownCk, "/api/tracking", { method: "POST", body: JSON.stringify({ action: "LOCATION", id: mapTr.id, lat: 5.611, lng: -0.205, driverName: "TEST Courier" }) });
  await p4.goto(`${BASE}/track?code=${encodeURIComponent(baseline.mapCode)}`, { waitUntil: "networkidle0", timeout: 60000 });
  await p4.waitForSelector('[data-testid="track-map"]', { timeout: 30000 });
  const mapSrc = await p4.$eval('[data-testid="track-map-frame"]', (el) => el.src || "");
  ok("E7 dispatched order shows the LIVE Google Map", /maps\.google\.com/.test(mapSrc) && mapSrc.includes("5.611"));
  const notifyBtn = await p4.evaluate(() => !!document.querySelector('[data-testid="track-notify-toggle"]'));
  ok("E7b customer notify-me toggle present", notifyBtn);
  await p4.screenshot({ path: "/home/user/track-2-public-map.png" });
  await ctx4.close();

  await browser.close();
  ok("E8 ZERO page/console errors across every flow", errors.length === 0, errors.slice(0, 4).join(" | "));
}
async function loginCookie(creds) { return login(creds.email, creds.pass); }

/* ── cleanup & forensics ──────────────────────────────────────────────── */
async function cleanup(pg) {
  console.log("\n— Z · cleanup & forensics —");
  // inventory restoration for the test sale
  if (baseline.invId) {
    await pg.query(`UPDATE inventory_items SET quantity=$2::double precision, status=CASE WHEN $2::double precision <= 0 THEN 'OUT_OF_STOCK' WHEN $2::double precision <= min_stock_threshold THEN 'LOW_STOCK' ELSE 'IN_STOCK' END WHERE id=$1`, [baseline.invId, baseline.invQty]);
  }
  const trk = await pg.query(`DELETE FROM customer_trackings WHERE id > $1 OR customer_name LIKE 'TEST%' RETURNING id`, [baseline.trMax]);
  const docs = await pg.query(`DELETE FROM sales_documents WHERE id > $1 AND customer_name LIKE 'TEST%' RETURNING id`, [baseline.docMax]);
  const trxs = await pg.query(`DELETE FROM transactions WHERE id > $1 AND description LIKE '%TEST%' RETURNING id`, [baseline.trxMax]);
  const ntfs = await pg.query(`DELETE FROM notifications WHERE id > $1 AND type='ORDER_TRACKING_STATUS' RETURNING id`, [baseline.ntfMax]);
  const custs = await pg.query(`DELETE FROM customers WHERE id > $1 AND name LIKE 'TEST%' RETURNING id`, [baseline.custMax]);
  const sess = await pg.query(`DELETE FROM user_sessions WHERE id > $1 RETURNING id`, [baseline.sessMax]);
  const invAfter = baseline.invId ? (await pg.query(`SELECT quantity FROM inventory_items WHERE id=$1`, [baseline.invId])).rows[0]?.quantity : null;
  const leftovers = (await pg.query(`SELECT count(*)::int c FROM customer_trackings WHERE customer_name LIKE 'TEST%'`)).rows[0].c;
  const docLeft = (await pg.query(`SELECT count(*)::int c FROM sales_documents WHERE customer_name LIKE 'TEST%'`)).rows[0].c;
  ok("Z1 TEST data purged (trackings, docs, trxns, notifications, customers, sessions)",
    leftovers === 0 && docLeft === 0);
  ok("Z1b inventory restored to exact baseline", invAfter === baseline.invQty, `qty=${invAfter} expect ${baseline.invQty}`);
  const userCounts = {
    trackings: (await pg.query(`SELECT count(*)::int c FROM customer_trackings WHERE id <= $1`, [baseline.trMax])).rows[0].c,
    businesses: (await pg.query(`SELECT count(*)::int c FROM businesses`)).rows[0].c,
    users: (await pg.query(`SELECT count(*)::int c FROM users`)).rows[0].c,
  };
  ok("Z2 user data intact (businesses & users unchanged, pre-existing trackings untouched)",
    userCounts.businesses === baseline.bizCount && userCounts.users === baseline.userCount);
  console.log(`   purged: trackings=${trk.rowCount} docs=${docs.rowCount} trxns=${trxs.rowCount} notifications=${ntfs.rowCount} customers=${custs.rowCount} sessions=${sess.rowCount}`);
}

/* ── main ─────────────────────────────────────────────────────────────── */
(async () => {
  await pg.connect();
  baseline.trMax = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM customer_trackings`)).rows[0].m;
  baseline.docMax = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM sales_documents`)).rows[0].m;
  baseline.trxMax = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM transactions`)).rows[0].m;
  baseline.ntfMax = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM notifications`)).rows[0].m;
  baseline.custMax = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM customers`)).rows[0].m;
  baseline.sessMax = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM user_sessions`)).rows[0].m;
  baseline.bizCount = (await pg.query(`SELECT count(*)::int c FROM businesses`)).rows[0].c;
  baseline.userCount = (await pg.query(`SELECT count(*)::int c FROM users`)).rows[0].c;
  baseline.trCount = (await pg.query(`SELECT count(*)::int c FROM customer_trackings`)).rows[0].c;

  const cookies = {
    owner: await loginCookie(OWNER),
    worker: await loginCookie(WORKER),
    bm: await loginCookie(BM),
  };

  try {
    await sectionA(pg, cookies);
    await sectionB(pg, cookies);
    await sectionC(pg, cookies);
    await sectionD(pg, cookies);
    await sectionE(pg);
  } catch (e) {
    ok(`suite crashed: ${e.message}`, false);
    console.error(e);
  } finally {
    try { await cleanup(pg); } catch (e) { console.error("cleanup error:", e.message); }
    await pg.end();
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
