/**
 * verify-order-inventory-fixes — E2E proof for the five Order & Inventory fixes:
 *
 *   A · Customer Phone   — storefront field validates live; API rejects
 *                          too-short / too-long / non-digit numbers with 400.
 *   B · Order Quantity   — customers can TYPE the quantity (desktop + stepper
 *                          intact), clamped to available stock, 0 removes.
 *   C · Customer Pin     — pin left at the shop's own location is warned +
 *                          blocked (client AND server); a nudged pin is saved
 *                          verbatim and shown on /track (never replaced with
 *                          the owner's pickup location).
 *   D · Notifications    — new user assigned duty gets existing open orders +
 *                          purchases in their bell (backfill); live online
 *                          orders + purchases reach assigned staff AND
 *                          extra-access grantees.
 *   E · Mobile Inventory — registration modal fields ≥16px (no iOS zoom-jump),
 *                          modal scrolls smoothly to the submit button, full
 *                          registration works on a phone-sized touch viewport.
 *   F · Desktop stays at 14px and keeps working.
 *   G · Cleanup + forensics — every TEST artifact removed, every baseline
 *       business/user field restored, live data untouched.
 *
 * Runs BOTH viewport profiles: desktop 1440×960 and mobile 390×844
 * (isMobile + hasTouch). Zero page errors tolerated.
 */
import { createRequire } from "module";
const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");
const { Client } = require("pg");

const BASE = "http://127.0.0.1:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pass: process.env.GOMINA_OWNER_PW || "Owner@GoMina26" };
const SHOP = { lat: 5.6037, lng: -0.187 }; // temporary biz-1 anchor, restored to NULL after
const DESKTOP = { width: 1440, height: 960 };
const MOBILE = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };

const results = [];
const pg = new Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });
const created = { codes: [], phones: [], purchaseNumbers: [], inventoryIds: [], userId: null, notifUserIds: [] };

const ok = (name, cond, extra = "") => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "✅" : "❌"} ${name}${cond ? "" : " — " + String(extra).slice(0, 220)}`);
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
const login = async (email, password) => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status}`);
  return (res.headers.get("set-cookie") || "").split(";")[0];
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ─── browser harness ─── */
let browser;
const errors = [];
function hookPage(page, tag) {
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const txt = m.text();
    if (/Failed to load resource/.test(txt) && /(401|400|403|404|409|413)/.test(txt)) return;
    if (/net::/.test(txt)) return;
    errors.push(`[${tag}] ${txt.slice(0, 300)}`);
  });
  page.on("pageerror", (e) => errors.push(`[${tag}] PAGEERROR ${String(e).slice(0, 300)}`));
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
}
async function newPage(tag, viewport = DESKTOP) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  hookPage(page, tag);
  await page.setViewport(viewport);
  return { ctx, page };
}
async function loginUi(page, creds) {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid="login-email"]', { timeout: 60000 });
  await page.type('[data-testid="login-email"]', creds.email);
  await page.type('[data-testid="login-password"]', creds.pass);
  await page.click('[data-testid="login-submit"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="login-email"]'), { timeout: 60000 });
  await sleep(1200);
}
const clickByText = (page, text, tag = "button") =>
  page.evaluate((txt, tg) => {
    const el = [...document.querySelectorAll(tg)].find((e) => (e.textContent || "").trim().includes(txt));
    if (el) { el.click(); return true; }
    return false;
  }, text, tag);
// Scroll an element to viewport centre first, then click it — required near
// the storefront's fixed cart bar, where puppeteer's own scrollIntoView leaves
// half-visible controls under the bar (a tap would land on the bar instead).
const clickT = async (page, testid) => {
  await page.evaluate((tid) => document.querySelector(`[data-testid="${tid}"]`)?.scrollIntoView({ block: "center" }), testid);
  await new Promise((r) => setTimeout(r, 250));
  await page.click(`[data-testid="${testid}"]`);
};
const selectT = async (page, testid, value) => {
  await page.evaluate((tid) => document.querySelector(`[data-testid="${tid}"]`)?.scrollIntoView({ block: "center" }), testid);
  await new Promise((r) => setTimeout(r, 250));
  await page.select(`[data-testid="${testid}"]`, value);
};
async function fillField(page, testid, value) {
  // Deterministic clear: set the DOM value via the native setter and fire a
  // real input event so React's controlled state resets before typing.
  await page.evaluate((tid) => {
    const el = document.querySelector(`[data-testid="${tid}"]`);
    if (!el) return;
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, testid);
  await page.type(`[data-testid="${testid}"]`, value);
}

/* ═══ A · phone validation — API ═══ */
async function sectionA() {
  console.log("\n— A · phone validation: API rejects bad numbers, records nothing —");
  const cart = [{ inventoryId: 6, quantity: 1 }]; // biz 8 cement
  const baseOrder = {
    businessId: 8, customerName: "TEST Phone Probe", fulfillmentType: "PICKUP",
    destinationAddress: "", paymentChoice: "ON_DELIVERY", momoRef: "", note: "", items: cart,
  };
  const before = await pg.query(`SELECT count(*)::int c FROM customer_trackings`);
  // Storefront customer numbers must be EXACTLY 10 Ghana-local digits — the
  // exact-10 copy covers both too-short and too-long probes.
  const probes = [
    ["too short (5 digits)", "02441", /exactly 10 digits/i],
    ["too long (17 digits)", "02441122334455667", /exactly 10 digits/i],
    ["contains letters", "0244ABC123", /only contain digits/i],
    ["empty", "", /phone number/i],
  ];
  for (const [label, phone, re] of probes) {
    const r = await api(null, "/api/order", { method: "POST", body: JSON.stringify({ ...baseOrder, customerPhone: phone }) });
    ok(`A: API 400 for ${label}`, r.status === 400 && r.json?.success === false && re.test(r.json?.error || ""),
      `${r.status} ${JSON.stringify(r.json || {})}`);
  }
  const after = await pg.query(`SELECT count(*)::int c FROM customer_trackings`);
  ok("A: rejected phones create NO orders/side effects", after.rows[0].c === before.rows[0].c,
    `before=${before.rows[0].c} after=${after.rows[0].c}`);
}

/* ═══ B · storefront desktop: live phone error + typed quantity + full order ═══ */
let T1; // biz-8 PICKUP online order code (used by the notification section)
async function sectionB() {
  console.log("\n— B · DESKTOP storefront: live phone error + typed qty + order —");
  const { ctx, page } = await newPage("storefront-desktop");
  await page.goto(`${BASE}/order?biz=8`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid="oo-add-6"]', { timeout: 30000 });

  // — typed quantity —
  await page.click('[data-testid="oo-add-6"]');
  await page.waitForSelector('[data-testid="oo-qty-6"]', { timeout: 10000 });
  const isInput = await page.$eval('[data-testid="oo-qty-6"]', (el) => el.tagName);
  ok("B1 quantity is a typeable INPUT (kept oo-qty-6 testid)", isInput === "INPUT", isInput);
  await fillField(page, "oo-qty-6", "4");
  await sleep(300);
  let total = await page.$eval('[data-testid="oo-cart-total"]', (el) => el.textContent || "");
  ok("B2 typed qty 4 → cart total GH₵ 472.00", /472\.00/.test(total), total);
  await fillField(page, "oo-qty-6", "9999");
  await sleep(300);
  total = await page.$eval('[data-testid="oo-cart-total"]', (el) => el.textContent || "");
  ok("B3 typed qty clamps to available stock 200 → GH₵ 23600.00", /23600\.00/.test(total), total);
  await fillField(page, "oo-qty-6", "0");
  await sleep(300);
  ok("B4 typing 0 removes the line (Add button returns)", !!(await page.$('[data-testid="oo-add-6"]')));
  // stepper still works
  await page.click('[data-testid="oo-add-6"]');
  await page.waitForSelector('[data-testid="oo-qty-6"]', { timeout: 5000 });
  await page.click('[data-testid="oo-plus-6"]');
  await sleep(200);
  const stepped = await page.$eval('[data-testid="oo-qty-6"]', (el) => el.value);
  ok("B5 −/+ stepper still works alongside typing (1→2)", stepped === "2", stepped);

  // — live phone validation —
  await page.type('[data-testid="oo-phone"]', "02441");
  await sleep(200);
  let err = await page.$eval('[data-testid="oo-phone-error"]', (el) => el.textContent || "").catch(() => "");
  ok("B6 live error for too-short number (exact-10 rule)", /exactly 10 digits/.test(err), err);
  await fillField(page, "oo-phone", "02441122334455667");
  await sleep(200);
  err = await page.$eval('[data-testid="oo-phone-error"]', (el) => el.textContent || "").catch(() => "");
  ok("B7 live error for too-long number (exact-10 rule)", /exactly 10 digits/.test(err), err);
  await fillField(page, "oo-phone", "0244ABC123");
  await sleep(200);
  err = await page.$eval('[data-testid="oo-phone-error"]', (el) => el.textContent || "").catch(() => "");
  ok("B8 live error for letters in number", /digits/.test(err), err);
  await fillField(page, "oo-phone", "0551112233");
  await sleep(200);
  ok("B9 valid number clears the live error", !(await page.$('[data-testid="oo-phone-error"]')));

  // — full order end-to-end (also seeds the notification backfill) —
  await fillField(page, "oo-name", "TEST Bell Desktop");
  await page.click('[data-testid="oo-place"]');
  await page.waitForSelector('[data-testid="oo-code"]', { timeout: 30000 });
  T1 = (await page.$eval('[data-testid="oo-code"]', (el) => el.textContent || "")).trim();
  created.codes.push(T1); created.phones.push("0551112233");
  ok("B10 desktop order placed end-to-end (pickup)", /^GM-HARDWARE-/.test(T1), T1);
  const row = (await pg.query(`SELECT customer_phone FROM customer_trackings WHERE tracking_code=$1`, [T1])).rows[0];
  ok("B11 server stored the canonical phone", row?.customer_phone === "0551112233", row?.customer_phone);
  await ctx.close();
}

/* ═══ C · MOBILE storefront: pin-at-shop warning, block, nudge, save, track ═══ */
let T3;
async function sectionC(ownerCookie) {
  console.log("\n— C · MOBILE storefront: delivery pin never the shop's location —");
  // temp anchor for biz 1 (exact original NULL restored in G)
  const patch = await api(ownerCookie, "/api/businesses/1", { method: "PATCH", body: JSON.stringify({ gpsLat: SHOP.lat, gpsLng: SHOP.lng }) });
  ok("C0 biz-1 temporary GPS anchor set", patch.status === 200, JSON.stringify(patch.json || {}).slice(0, 120));

  // Server-side guard first (defence in depth, no browser involved)
  const atShop = await api(null, "/api/order", {
    method: "POST",
    body: JSON.stringify({
      businessId: 1, customerName: "TEST Pin Probe", customerPhone: "0559998877",
      fulfillmentType: "DELIVERY", destinationAddress: "TEST Lane 3",
      deliveryLat: SHOP.lat, deliveryLng: SHOP.lng,
      paymentChoice: "ON_DELIVERY", momoRef: "", note: "",
      items: [{ inventoryId: 12, quantity: 1 }],
    }),
  });
  ok("C1 API refuses a delivery pin dropped exactly at the shop (400)",
    atShop.status === 400 && /shop/i.test(atShop.json?.error || ""), `${atShop.status} ${JSON.stringify(atShop.json || {}).slice(0, 140)}`);

  const { ctx, page } = await newPage("storefront-mobile", MOBILE);
  await page.goto(`${BASE}/order?biz=1`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid="oo-add-12"]', { timeout: 30000 });
  await page.click('[data-testid="oo-add-12"]');
  await page.waitForSelector('[data-testid="oo-qty-12"]', { timeout: 10000 });
  await page.click('[data-testid="oo-delivery"]');
  await page.waitForSelector('[data-testid="oo-dest-input"]', { timeout: 10000 });
  await page.type('[data-testid="oo-dest-input"]', "TEST Coconut Avenue, House 12");
  // drop the pin exactly at map centre (= the shop) without nudging
  await page.waitForSelector('[data-testid="oo-pin-set"]', { timeout: 10000 });
  await clickT(page, "oo-pin-set");
  await sleep(400);
  ok("C2 pin-at-shop warning appears (mobile)", !!(await page.$('[data-testid="oo-pin-shop-warn"]')));
  await page.type('[data-testid="oo-name"]', "TEST Pin Customer");
  await page.type('[data-testid="oo-phone"]', "0553334455");
  await page.click('[data-testid="oo-place"]');
  await sleep(700);
  const blocked = await page.$eval('[data-testid="oo-error"]', (el) => el.textContent || "").catch(() => "");
  ok("C3 unchecked shop-pin BLOCKS the order on mobile", /shop/i.test(blocked), blocked.slice(0, 120));
  // nudge 500m east ×2 → customer's real point
  await selectT(page, "oo-pin-step", "500");
  await clickT(page, "oo-pin-e");
  await sleep(250);
  await clickT(page, "oo-pin-e");
  await sleep(500);
  ok("C4 warning clears once the pin is really the customer's", !(await page.$('[data-testid="oo-pin-shop-warn"]')));
  await page.click('[data-testid="oo-place"]');
  await page.waitForSelector('[data-testid="oo-code"]', { timeout: 30000 });
  T3 = (await page.$eval('[data-testid="oo-code"]', (el) => el.textContent || "")).trim();
  created.codes.push(T3); created.phones.push("0553334455");
  ok("C5 mobile delivery order placed with the nudged pin", /^GM-POULTRY-/.test(T3), T3);

  const tRow = (await pg.query(`SELECT delivery_lat, delivery_lng, delivery_map_link FROM customer_trackings WHERE tracking_code=$1`, [T3])).rows[0];
  const dlng = tRow?.delivery_lng, dlat = tRow?.delivery_lat;
  ok("C6 DB saved the CUSTOMER pin (~1 km east of shop), not shop coords",
    dlat != null && Math.abs(dlat - SHOP.lat) < 0.0005 && dlng > SHOP.lng + 0.006,
    `lat=${dlat} lng=${dlng} shop=${SHOP.lat},${SHOP.lng}`);
  ok("C7 DB pin is NOT the owner's pickup location",
    !(Math.abs(dlat - SHOP.lat) < 0.0005 && Math.abs(dlng - SHOP.lng) < 0.0005), `${dlat},${dlng}`);

  // success-screen map + public tracking page must show the customer pin
  const successSrc = await page.$eval('[data-testid="oo-success-map-frame"]', (el) => el.getAttribute("src") || "").catch(() => "");
  const expectedQ = `q=${Number(dlat).toFixed(6)},${Number(dlng).toFixed(6)}`;
  ok("C8 order-success map renders the customer pin", successSrc.includes(expectedQ), successSrc.slice(0, 120));

  await page.goto(`${BASE}/track?code=${encodeURIComponent(T3)}`, { waitUntil: "networkidle0", timeout: 60000 });
  await sleep(1200);
  const trackSrc = await page.evaluate(() => {
    const f = [...document.querySelectorAll("iframe")].find((i) => (i.getAttribute("src") || "").includes("maps.google"));
    return f ? f.getAttribute("src") : "";
  });
  ok("C9 /track map shows the customer pin (not the shop pin)", trackSrc.includes(expectedQ), trackSrc.slice(0, 120));

  const hOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
  ok("C10 storefront has NO horizontal overflow on mobile", !hOverflow);
  await ctx.close();
}

/* ═══ D · notifications: backfill on assignment + live fan-out ═══ */
let T2, P1, P2, testUser = null;
async function sectionD(ownerCookie) {
  console.log("\n— D · notifications: bell backfill for new users + live fan-out —");
  const uniq = Date.now().toString().slice(-5);
  P1 = `TEST-PO-${uniq}A`; P2 = `TEST-PO-${uniq}B`;
  const mkPurchase = (num) => api(ownerCookie, "/api/hardware", {
    method: "POST",
    body: JSON.stringify({
      entity: "PURCHASE",
      data: {
        businessId: 8, purchaseNumber: num, supplierName: "TEST Bell Supplier",
        itemName: "TEST Bell Cement Restock", quantity: 25, unitCostGhs: 100,
        status: "ORDERED", orderDate: "2026-09-03", createdByName: "Kwame Mina",
      },
    }),
  });
  const p1 = await mkPurchase(P1);
  created.purchaseNumbers.push(P1);
  ok("D1 TEST purchase recorded (biz 8)", p1.status === 200 && p1.json?.success === true, JSON.stringify(p1.json || {}).slice(0, 160));
  const own0 = await api(ownerCookie, "/api/notifications");
  ok("D2 owner bell got PURCHASE_RECORDED immediately",
    (own0.json?.notifications || []).some((n) => n.type === "PURCHASE_RECORDED" && n.recordRef === P1),
    JSON.stringify((own0.json?.notifications || [])[0] || {}));

  // new user assigned to biz 8 — AFTER the order (T1) and purchase (P1) exist
  const mk = await api(ownerCookie, "/api/users", {
    method: "POST",
    body: JSON.stringify({
      name: "TEST Bell User", email: `test.bell.${uniq}@gomina.test`, phone: "0557778899",
      password: "GoMina@Test99", role: "WORKER", assignedBusinessId: 8, canRecordSales: true,
    }),
  });
  testUser = mk.json?.user;
  created.userId = testUser?.id;
  created.phones.push("0557778899");
  ok("D3 TEST staff account created + assigned to biz 8", mk.status === 200 && !!testUser?.id, JSON.stringify(mk.json || {}).slice(0, 160));

  const testCookie = await login(testUser.email, "GoMina@Test99");
  const bell1 = await api(testCookie, "/api/notifications");
  const n1 = bell1.json?.notifications || [];
  ok("D4 new user's bell shows the EXISTING online order (backfill)",
    n1.some((n) => n.recordRef === T1 && ["ONLINE_ORDER_RECEIVED", "ORDER_ASSIGNED"].includes(n.type)),
    n1.map((n) => `${n.type}:${n.recordRef}`).join("|").slice(0, 160));
  ok("D5 new user's bell shows the EXISTING purchase (backfill)",
    n1.some((n) => n.type === "PURCHASE_RECORDED" && n.recordRef === P1),
    n1.map((n) => `${n.type}:${n.recordRef}`).join("|").slice(0, 160));
  ok("D6 unreadCount reflects the backfilled duty", (bell1.json?.unreadCount || 0) >= 2, bell1.json?.unreadCount);

  // live fan-out: a second purchase must reach the assigned user with NO new backfill
  const p2 = await mkPurchase(P2);
  created.purchaseNumbers.push(P2);
  ok("D7 second TEST purchase recorded", p2.status === 200);
  const bell2 = await api(testCookie, "/api/notifications");
  ok("D8 live PURCHASE_RECORDED reaches the assigned staff member",
    (bell2.json?.notifications || []).some((n) => n.type === "PURCHASE_RECORDED" && n.recordRef === P2));

  // extra-access duty grant → backfill that business's open orders
  const grant = await api(ownerCookie, "/api/users", { method: "PATCH", body: JSON.stringify({ userId: testUser.id, extraAccessIds: [1] }) });
  ok("D9 duty grant for biz 1 saved", grant.status === 200, JSON.stringify(grant.json || {}).slice(0, 120));
  const bell3 = await api(testCookie, "/api/notifications");
  const n3 = bell3.json?.notifications || [];
  const liveRefs = ["GM-POULTRY-UE7N7R", "GM-POULTRY-SZF6KC", "GM-POULTRY-QSPQYH"];
  ok("D10 granted user's bell now shows biz-1's live open orders",
    liveRefs.some((ref) => n3.some((n) => n.recordRef === ref)),
    n3.map((n) => `${n.type}:${n.recordRef}`).join("|").slice(0, 200));

  // live online order on the granted business → grantee + owner both pinged
  const t2res = await api(null, "/api/order", {
    method: "POST",
    body: JSON.stringify({
      businessId: 1, customerName: "TEST Bell Kofi", customerPhone: "0552223344",
      fulfillmentType: "PICKUP", destinationAddress: "", paymentChoice: "ON_DELIVERY",
      momoRef: "", note: "", items: [{ inventoryId: 1, quantity: 1 }],
    }),
  });
  T2 = t2res.json?.trackingCode || t2res.json?.tracking?.trackingCode;
  created.codes.push(T2); created.phones.push("0552223344");
  ok("D11 live online order placed on granted biz 1", t2res.status === 200 && !!T2, JSON.stringify(t2res.json || {}).slice(0, 140));
  const bell4 = await api(testCookie, "/api/notifications");
  ok("D12 ONLINE_ORDER_RECEIVED reaches the extra-access GRANTEE live",
    (bell4.json?.notifications || []).some((n) => n.type === "ONLINE_ORDER_RECEIVED" && n.recordRef === T2));
  const own2 = await api(ownerCookie, "/api/notifications");
  ok("D13 ONLINE_ORDER_RECEIVED still reaches the OWNER",
    (own2.json?.notifications || []).some((n) => n.type === "ONLINE_ORDER_RECEIVED" && n.recordRef === T2));

  // mobile bell UI for the new user
  const { ctx, page } = await newPage("bell-mobile", MOBILE);
  await loginUi(page, { email: testUser.email, pass: "GoMina@Test99" });
  await page.waitForSelector('[data-testid="notif-bell"]', { timeout: 30000 });
  const badge = await page.$eval('[data-testid="notif-badge"]', (el) => Number(el.textContent) || 0).catch(() => 0);
  ok("D14 bell badge shows unread duty on mobile", badge >= 3, badge);
  await page.click('[data-testid="notif-bell"]');
  await page.waitForSelector('[data-testid="notif-panel"]', { timeout: 10000 });
  const panel = await page.$eval('[data-testid="notif-panel"]', (el) => el.textContent || "");
  ok("D15 bell panel lists order + purchase entries", panel.includes(T1.slice(0, 12)) && /TEST-PO-/.test(panel), panel.slice(0, 140));
  await ctx.close();
}

/* ═══ E · MOBILE inventory registration ═══ */
async function sectionE() {
  console.log("\n— E · MOBILE inventory: no zoom-jump, smooth scroll, submits —");
  const { ctx, page } = await newPage("inventory-mobile", MOBILE);
  await loginUi(page, OWNER);
  await page.waitForFunction(
    () => [...document.querySelectorAll("button")].some((b) => (b.textContent || "").includes("Inventory & Stock")),
    { timeout: 30000 });
  await clickByText(page, "Inventory & Stock");
  await page.waitForFunction(
    () => [...document.querySelectorAll("button")].some((b) => (b.textContent || "").includes("Add Stock Item")),
    { timeout: 30000 });
  await clickByText(page, "Add Stock Item");
  await page.waitForSelector('[data-testid="inv-name"]', { timeout: 15000 });

  const fontPx = await page.$eval('[data-testid="inv-name"]', (el) => parseFloat(getComputedStyle(el).fontSize));
  ok("E1 mobile inventory inputs are ≥16px (iOS will NOT auto-zoom/shake)", fontPx >= 16, `${fontPx}px`);

  const scrollInfo = await page.evaluate(() => {
    const f = document.querySelector('[data-testid="inv-name"]');
    const card = f?.closest(".max-h-\\[92vh\\]") || f?.closest("div[class*='max-h']");
    if (!card) return { found: false };
    const before = card.scrollTop;
    card.scrollTop = card.scrollHeight;
    return { found: true, scrollable: card.scrollHeight > card.clientHeight + 10, before, after: card.scrollTop, heightOk: card.clientHeight <= innerHeight };
  });
  ok("E2 long mobile form is scroll-contained (scrollable to the submit button)",
    scrollInfo.found && scrollInfo.scrollable && scrollInfo.after > scrollInfo.before && scrollInfo.heightOk,
    JSON.stringify(scrollInfo));

  await page.type('[data-testid="inv-name"]', "TEST Mobile Nails Packet");
  await fillField(page, "inv-qty", "7");
  // smooth-scroll the submit into view then tap it (touch-mode click)
  const submitted = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button[type=submit]")].find((b) => (b.textContent || "").includes("Save Record"));
    if (!btn) return false;
    btn.scrollIntoView({ block: "center" });
    btn.click();
    return true;
  });
  ok("E3 submit button reachable by smooth scroll at the bottom of the form", submitted);
  await page.waitForFunction(() => !document.querySelector('[data-testid="inv-name"]'), { timeout: 30000 });
  ok("E4 mobile registration submits and closes", true);
  const row = (await pg.query(`SELECT id, quantity FROM inventory_items WHERE name='TEST Mobile Nails Packet' ORDER BY id DESC LIMIT 1`)).rows[0];
  if (row) created.inventoryIds.push(row.id);
  ok("E5 mobile-registered item actually landed in stock (qty 7)", !!row && Number(row.quantity) === 7, JSON.stringify(row || {}));
  const hOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
  ok("E6 inventory screen has NO horizontal overflow on mobile", !hOverflow);
  await shot(page, "oifix-mobile-inventory");
  await ctx.close();
}

/* ═══ F · DESKTOP inventory keeps its compact 14px look and works ═══ */
async function sectionF() {
  console.log("\n— F · DESKTOP inventory: compact look preserved, still registers —");
  const { ctx, page } = await newPage("inventory-desktop", DESKTOP);
  await loginUi(page, OWNER);
  await page.waitForFunction(
    () => [...document.querySelectorAll("button")].some((b) => (b.textContent || "").includes("Inventory & Stock")),
    { timeout: 30000 });
  await clickByText(page, "Inventory & Stock");
  await page.waitForFunction(
    () => [...document.querySelectorAll("button")].some((b) => (b.textContent || "").includes("Add Stock Item")),
    { timeout: 30000 });
  await clickByText(page, "Add Stock Item");
  await page.waitForSelector('[data-testid="inv-name"]', { timeout: 15000 });
  const fontPx = await page.$eval('[data-testid="inv-name"]', (el) => parseFloat(getComputedStyle(el).fontSize));
  ok("F1 desktop keeps the compact 14px field style", fontPx === 14, `${fontPx}px`);
  await page.type('[data-testid="inv-name"]', "TEST Desktop Cement Bag");
  await fillField(page, "inv-qty", "3");
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button[type=submit]")].find((b) => (b.textContent || "").includes("Save Record"));
    btn?.click();
  });
  await page.waitForFunction(() => !document.querySelector('[data-testid="inv-name"]'), { timeout: 30000 });
  const row = (await pg.query(`SELECT id, quantity FROM inventory_items WHERE name='TEST Desktop Cement Bag' ORDER BY id DESC LIMIT 1`)).rows[0];
  if (row) created.inventoryIds.push(row.id);
  ok("F2 desktop registration still lands in stock (qty 3)", !!row && Number(row.quantity) === 3, JSON.stringify(row || {}));
  await ctx.close();
}
const shot = (page, name) => page.screenshot({ path: `/home/user/${name}.png` });

/* ═══ G · cleanup + forensics ═══ */
async function sectionG(ownerCookie, base) {
  console.log("\n— G · cleanup + forensics (every TEST trace removed, live data intact) —");
  // business 1 GPS back to its exact original NULL
  await api(ownerCookie, "/api/businesses/1", { method: "PATCH", body: JSON.stringify({ gpsLat: null, gpsLng: null }) });
  const b1 = (await pg.query(`SELECT gps_lat, gps_lng FROM businesses WHERE id=1`)).rows[0];
  ok("G1 biz-1 GPS restored exactly (NULL)", b1?.gps_lat == null && b1?.gps_lng == null, JSON.stringify(b1));
  // TEST user account (API removes user + sessions + grants)
  if (created.userId) {
    const del = await api(ownerCookie, `/api/users?userId=${created.userId}`, { method: "DELETE" });
    ok("G2 TEST user deleted via API", del.status === 200 && del.json?.success === true, JSON.stringify(del.json || {}).slice(0, 120));
  }
  // notifications for the TEST user + every TEST record
  await pg.query(`DELETE FROM notifications WHERE user_id = ANY($1)`, [[created.userId].filter(Boolean)]);
  if (created.codes.length || created.purchaseNumbers.length) {
    await pg.query(`DELETE FROM notifications WHERE record_ref = ANY($1)`, [[...created.codes, ...created.purchaseNumbers]]);
  }
  // TEST purchases (ORDERED → never touched stock or finance)
  if (created.purchaseNumbers.length) {
    await pg.query(`DELETE FROM hardware_purchases WHERE purchase_number = ANY($1)`, [created.purchaseNumbers]);
  }
  // TEST orders + any CRM rows they linked
  if (created.codes.length) {
    await pg.query(`DELETE FROM customer_trackings WHERE tracking_code = ANY($1)`, [created.codes]);
  }
  if (created.phones.length) {
    await pg.query(`DELETE FROM customers WHERE phone = ANY($1) AND name LIKE 'TEST%'`, [created.phones]);
  }
  if (created.inventoryIds.length) {
    await pg.query(`DELETE FROM inventory_items WHERE id = ANY($1)`, [created.inventoryIds]);
  }
  await pg.query(`DELETE FROM user_sessions WHERE id > $1`, [base.maxSessionId]);

  const after = { };
  for (const t of Object.keys(base.counts)) {
    after[t] = (await pg.query(`SELECT count(*)::int c FROM ${t}`)).rows[0].c;
  }
  const mismatches = Object.entries(base.counts).filter(([t, c]) => after[t] !== c)
    .map(([t, c]) => `${t}:${c}→${after[t]}`);
  ok("G3 ALL live-data table counts unchanged", mismatches.length === 0, mismatches.join(", "));
  const eggs = (await pg.query(`SELECT quantity FROM inventory_items WHERE id=1`)).rows[0];
  ok("G4 live stock untouched (eggs qty = 873.63)", Number(eggs?.quantity) === 873.63, eggs?.quantity);
  const strays = (await pg.query(`SELECT count(*)::int c FROM customer_trackings WHERE customer_name LIKE 'TEST%' OR tracking_code LIKE 'TEST%'`)).rows[0].c
    + (await pg.query(`SELECT count(*)::int c FROM notifications WHERE title LIKE '%TEST%' OR body LIKE '%TEST %'`)).rows[0].c;
  ok("G5 no TEST strays in trackings/notifications", strays === 0, strays);
}

/* ═══ main ═══ */
console.log("══ verify-order-inventory-fixes — 5 fixes × mobile + desktop ══");
await pg.connect();
const ownerCookie = await login(OWNER.email, OWNER.pass);
const base = {
  maxSessionId: (await pg.query(`SELECT COALESCE(max(id),0)::int m FROM user_sessions`)).rows[0].m,
  counts: Object.fromEntries(
    (await pg.query(`
      SELECT 'businesses' t, count(*)::int c FROM businesses
      UNION ALL SELECT 'users', count(*)::int FROM users
      UNION ALL SELECT 'customers', count(*)::int FROM customers
      UNION ALL SELECT 'customer_trackings', count(*)::int FROM customer_trackings
      UNION ALL SELECT 'sales_documents', count(*)::int FROM sales_documents
      UNION ALL SELECT 'transactions', count(*)::int FROM transactions
      UNION ALL SELECT 'inventory_items', count(*)::int FROM inventory_items
      UNION ALL SELECT 'hardware_purchases', count(*)::int FROM hardware_purchases
      UNION ALL SELECT 'electronics_purchases', count(*)::int FROM electronics_purchases
      UNION ALL SELECT 'restaurant_purchases', count(*)::int FROM restaurant_purchases
      UNION ALL SELECT 'notifications', count(*)::int FROM notifications`)).rows.map((r) => [r.t, r.c])),
};
console.log(`baseline: ${JSON.stringify(base.counts)}`);

browser = await puppeteer.launch({
  executablePath: "/tmp/al2023/chromium",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  headless: "new",
});

await sectionA();
await sectionB();
await sectionC(ownerCookie);
await sectionD(ownerCookie);
await sectionE();
await sectionF();
await browser.close().catch(() => {});
await sectionG(ownerCookie, base);

const passed = results.filter((r) => r.pass).length;
console.log(`\n══ ${passed}/${results.length} checks passed ══`);
if (errors.length) {
  console.log(`\n⚠ ${errors.length} page error(s):`);
  errors.slice(0, 10).forEach((e) => console.log("  " + e));
} else {
  console.log("page errors: 0");
}
if (results.some((r) => !r.pass)) {
  console.log("FAILED:", results.filter((r) => !r.pass).map((r) => r.name).join(" | "));
}
await pg.end();
process.exit(results.some((r) => !r.pass) || errors.length ? 1 : 0);
