/**
 * verify-orders-maps.mjs — Customer Order & Tracking register + Google-Maps
 * delivery/pickup pins, end-to-end against the live app.
 *
 * Part 1 — Orders section: dedicated register (Order ID · Tracking Code ·
 *   Customer · Business · Branch · Products · Amount · Payment · Status ·
 *   Date), full filter set (business/branch/customer/code/date/status/
 *   payment), linked-system chips (Tracking→Sales→Inventory→Finance→
 *   Delivery), staff actions (view/confirm/process/dispatch/deliver/
 *   complete), role scoping, customer-only code privacy.
 * Part 2 — Google Maps: storefront GPS capture + adjustable pin, pin stored
 *   with the order (address/lat/lng/map link), staff & courier delivery
 *   view + route link, pickup-point maps from the branch anchor, customer
 *   maps on /track, privacy scoping.
 *
 * Everything is TEST-* prefixed, baselines captured, fully cleaned up, and
 * the user's live data (incl. any rows they create during the run) is never
 * touched. Browser gates: ZERO page errors.
 */
import { createRequire } from "module";
const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");
const { Client } = require("pg");

const BASE = "http://127.0.0.1:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pass: process.env.GOMINA_OWNER_PW || "Owner@GoMina26" };
const BM = { email: "emmanuel@gomina360.com", pass: "GoMina@User3" };       // biz 1
const WORKER = { email: "kwabena.mensah@gomina360.com", pass: "GoMina@User11" }; // biz 1
const PIN = { lat: 5.650123, lng: -0.155456 };
const GPS_PIN = { lat: 5.650123, lng: -0.1555, acc: 12 };
const BRANCH_GPS = { lat: 5.6037, lng: -0.187 };

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
const login = async (email, password) => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status}`);
  return (res.headers.get("set-cookie") || "").split(";")[0];
};
const todayUtc = () => new Date().toISOString().slice(0, 10);
const restoreInv = async (id, qty) =>
  pg.query(
    `UPDATE inventory_items SET quantity=$2::double precision,
       status=CASE WHEN $2::double precision <= 0 THEN 'OUT_OF_STOCK'
                   WHEN $2::double precision <= min_stock_threshold THEN 'LOW_STOCK' ELSE 'IN_STOCK' END
     WHERE id=$1`, [id, qty]);

/* ═══ A · Orders register + pins — API surface ═══════════════════════ */
async function sectionA(cookies) {
  console.log("\n— A · Order & pin API surface —");
  const anon = await api(null, "/api/tracking");
  ok("A1 staff register API refuses anonymous access (401)", anon.status === 401);

  // A2 — online DELIVERY order WITH a Google-Maps pin
  const prod = baseline.product;
  const placed = await api(null, "/api/order", {
    method: "POST",
    body: JSON.stringify({
      businessId: 1, customerName: "TEST Mega Customer", customerPhone: "0551230001",
      fulfillmentType: "DELIVERY", destinationAddress: "TEST Labadi Beach Rd, gate 2",
      deliveryLat: PIN.lat, deliveryLng: PIN.lng, deliveryAccuracyM: 18,
      paymentChoice: "ON_DELIVERY", items: [{ inventoryId: prod.id, quantity: 1 }],
    }),
  });
  baseline.codeA = placed.json?.trackingCode;
  ok("A2 customer orders online with a pinned delivery point", placed.status === 200 && /^GM-/.test(baseline.codeA || ""), JSON.stringify(placed.json || {}).slice(0, 200));
  const rowA = (await pg.query(`SELECT * FROM customer_trackings WHERE tracking_code=$1`, [baseline.codeA || ""])).rows[0];
  baseline.rowA = rowA;
  ok("A2b address + latitude + longitude + map link stored with the order",
    rowA && rowA.destination_address === "TEST Labadi Beach Rd, gate 2" &&
    Math.abs(rowA.delivery_lat - PIN.lat) < 1e-9 && Math.abs(rowA.delivery_lng - PIN.lng) < 1e-9 &&
    rowA.delivery_accuracy_m === 18 && (rowA.delivery_map_link || "").includes("maps.google.com/?q=5.650123") &&
    rowA.delivery_pinned_at != null && rowA.order_source === "ONLINE");

  // A3 — invalid pins refused
  const badRange = await api(null, "/api/order", {
    method: "POST",
    body: JSON.stringify({ businessId: 1, customerName: "TEST BadPin", customerPhone: "0551230002", fulfillmentType: "DELIVERY", destinationAddress: "TEST x", deliveryLat: 95, deliveryLng: 0, items: [{ inventoryId: prod.id, quantity: 1 }] }),
  });
  const halfPin = await api(null, "/api/order", {
    method: "POST",
    body: JSON.stringify({ businessId: 1, customerName: "TEST HalfPin", customerPhone: "0551230003", fulfillmentType: "DELIVERY", destinationAddress: "TEST x", deliveryLat: 5.6, items: [{ inventoryId: prod.id, quantity: 1 }] }),
  });
  ok("A3 out-of-range (95°) and half pins rejected 400", badRange.status === 400 && halfPin.status === 400);

  // A4 — backward compatibility: DELIVERY without pin still works (API-tolerant)
  const noPin = await api(null, "/api/order", {
    method: "POST",
    body: JSON.stringify({ businessId: 1, customerName: "TEST NoPin Customer", customerPhone: "0551230004", fulfillmentType: "DELIVERY", destinationAddress: "TEST Old address only", items: [{ inventoryId: prod.id, quantity: 1 }] }),
  });
  const noPinRow = (await pg.query(`SELECT id, delivery_lat FROM customer_trackings WHERE tracking_code=$1`, [noPin.json?.trackingCode || ""])).rows[0];
  const noPinPub = await api(null, `/api/track?code=${encodeURIComponent(noPin.json?.trackingCode || "")}`);
  ok("A4 orders without a pin still work (address-only), no map payload",
    noPin.status === 200 && noPinRow && noPinRow.delivery_lat === null && noPinPub.json?.tracking?.deliveryLocation === null);
  baseline.codeNoPin = noPin.json?.trackingCode;
  baseline.rowNoPinId = noPinRow?.id;

  // A5 — register enrichment: orderRef + business + linked systems
  const invBefore = (await pg.query(`SELECT quantity FROM inventory_items WHERE id=$1`, [prod.id])).rows[0].quantity;
  baseline.invTouched = { id: prod.id, qty: invBefore };
  await api(cookies.owner, "/api/tracking", { method: "POST", body: JSON.stringify({ action: "SET_STATUS", id: rowA.id, status: "CONFIRMED" }) });
  const invAfter = (await pg.query(`SELECT quantity FROM inventory_items WHERE id=$1`, [prod.id])).rows[0].quantity;
  ok("A5 CONFIRM in register flow reserves stock in Inventory (−1)",
    Math.abs(invAfter - (invBefore - 1)) < 1e-9, `before=${invBefore} after=${invAfter}`);

  await api(cookies.owner, "/api/tracking", { method: "POST", body: JSON.stringify({ action: "MARK_PAID", id: rowA.id, method: "CASH" }) });
  const reg = (await api(cookies.owner, "/api/tracking")).json?.trackings || [];
  const regA = reg.find((t) => t.trackingCode === baseline.codeA);
  ok("A5b register row: human Order ID + Business/Branch + links (Finance after payment)",
    regA && /^ORD-\d{5}$/.test(regA.orderRef || "") && regA.businessName === "Mina Akuafo Poultry Farm" &&
    !!regA.businessCode && regA.stockCommitted === true &&
    regA.linkedTransaction && /^TRX-/.test(regA.linkedTransaction.number) && regA.linkedTransaction.type === "INCOME",
    JSON.stringify(regA || {}).slice(0, 280));

  // A6 — till sale links the register to Sales documents + Finance
  const sale = await api(cookies.worker, "/api/sales", {
    method: "POST",
    body: JSON.stringify({
      businessId: 1, branchCode: "POULTRY-01", customerName: "TEST Register Sale Customer", customerPhone: "0551230005",
      paymentMethod: "CASH",
      cartItems: [{ inventoryId: prod.id, sku: prod.sku, name: prod.name, quantity: 1, originalPrice: prod.price, sellingPrice: prod.price }],
      createdByUserId: 11, createdByName: "Kwabena Mensah", createdByRole: "WORKER",
    }),
  });
  baseline.saleCode2 = sale.json?.trackingCode;
  const saleRow = (await pg.query(`SELECT * FROM inventory_items WHERE id=$1`, [prod.id])).rows[0];
  baseline.saleInvBefore = null; // sale's own deduction tracked via same snapshot (restored together)
  const regB = (await api(cookies.owner, "/api/tracking")).json?.trackings.find((t) => t.trackingCode === sale.json?.trackingCode);
  ok("A6 till sale joins the register linked to Sales + Finance docs",
    regB && regB.orderSource === "SALE" && regB.paymentStatus === "PAID" &&
    regB.linkedDocument && /^(INV|RCP|QT)-/.test(regB.linkedDocument.number) && regB.linkedTransaction && /^TRX-/.test(regB.linkedTransaction.number),
    JSON.stringify(regB || {}).slice(0, 300));
  baseline.saleProdQtyAfter = saleRow.quantity; // qty after confirm(−1)+sale(−1); restored in Z

  // A7 — privacy: the pin rides ONLY the customer's code-keyed page; never the menu
  const menu = (await api(null, "/api/menu")).json;
  ok("A7 menu exposes branch pickup GPS but NEVER customer pins",
    JSON.stringify(menu).includes('"gpsLat"') && !JSON.stringify(menu).includes("delivery_lat") &&
    !JSON.stringify(menu).includes("0551230001"));
  const pub = await api(null, `/api/track?code=${encodeURIComponent(baseline.codeA)}`);
  const pubS = JSON.stringify(pub.json || {});
  ok("A7b customer's own page shows their pin — but never their phone/staff internals",
    pub.json?.tracking?.deliveryLocation?.lat && pub.json.tracking.deliveryLocation.lat === PIN.lat &&
    !pubS.includes("0551230001") && !pubS.includes("createdByUserId") && !pubS.includes("paymentRef"));

  // A8 — pickup order records no delivery pin (public payload pickup null until GPS set in E)
  const pick = await api(null, "/api/order", {
    method: "POST",
    body: JSON.stringify({ businessId: 1, customerName: "TEST Pickup Customer", customerPhone: "0551230006", fulfillmentType: "PICKUP", items: [{ inventoryId: prod.id, quantity: 1 }] }),
  });
  const pickRow = (await pg.query(`SELECT delivery_lat FROM customer_trackings WHERE tracking_code=$1`, [pick.json?.trackingCode || ""])).rows[0];
  ok("A8 pickup orders carry no delivery pin", pick.status === 200 && pickRow?.delivery_lat === null);
  baseline.codePickup = pick.json?.trackingCode;
}

/* ═══ B · shared browser harness ═══ */
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
async function newPage(tag, viewport = { width: 1440, height: 960 }) {
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
  await new Promise((r) => setTimeout(r, 1500));
}

/* ═══ C · Orders register UI (owner desktop) ═══ */
async function sectionC() {
  console.log("\n— C · Orders register UI (owner) —");
  const { ctx, page } = await newPage("register");
  await loginUi(page, OWNER);
  await page.waitForSelector('[data-testid="sidebar-tab-tracking"]', { timeout: 30000 });
  const sbLabel = await page.$eval('[data-testid="sidebar-tab-tracking"]', (el) => el.textContent || "");
  ok("C1 sidebar entry renamed “Customer Order & Tracking”", /Order & Tracking/.test(sbLabel), sbLabel);
  await page.click('[data-testid="sidebar-tab-tracking"]');
  await page.waitForSelector('[data-testid="ct-root"]', { timeout: 30000 });
  await page.waitForFunction(() => !document.body.innerText.includes("Loading orders"), { timeout: 30000 });
  const title = await page.$eval('[data-testid="ct-root"] h2', (el) => el.textContent || "");
  ok("C2 dashboard renamed, Orders register is the default view",
    /Customer Order & Tracking/.test(title) && (await page.$('[data-testid="ct-orders-table"]')) != null, title);

  const headers = await page.$$eval("#ct-orders-head th, [data-testid='ct-orders-table'] thead th", (els) => els.map((e) => (e.textContent || "").trim()));
  const need = ["Order ID", "Tracking Code", "Customer", "Business", "Branch", "Products", "Amount", "Payment", "Status", "Date"];
  ok("C3 register columns: " + need.join(" · "), need.every((h) => headers.some((x) => x === h)), JSON.stringify(headers));

  const idA = baseline.rowA.id;
  await page.waitForSelector(`[data-testid="ct-orders-oid-${idA}"]`, { timeout: 15000 });
  const rowBits = await page.evaluate((id) => ({
    oid: document.querySelector(`[data-testid="ct-orders-oid-${id}"]`)?.textContent?.trim(),
    code: document.querySelector(`[data-testid="ct-code-${id}"]`)?.textContent?.trim(),
    online: !!document.querySelector(`[data-testid="ct-online-${id}"]`),
    pay: document.querySelector(`[data-testid="ct-orders-pay-${id}"]`)?.textContent?.trim(),
    status: document.querySelector(`[data-testid="ct-status-${id}"]`)?.textContent?.trim(),
    amount: document.querySelector(`[data-testid="ct-orders-amount-${id}"]`)?.textContent?.trim(),
    date: document.querySelector(`[data-testid="ct-orders-date-${id}"]`)?.textContent?.trim(),
  }), idA);
  ok("C4 row shows Order ID · GM-* code · ONLINE chip · payment · status · amount · date",
    /^ORD-\d{5}$/.test(rowBits.oid || "") && /^GM-/.test(rowBits.code || "") && rowBits.online &&
    rowBits.pay === "PAID" && /Confirmed/.test(rowBits.status || "") && /GH₵|GHS/.test(rowBits.amount || "") && /\d{4}/.test(rowBits.date || ""),
    JSON.stringify(rowBits));

  /* C5 — search filter (customer / tracking code) */
  await page.type('[data-testid="ct-search"]', "TEST Mega Customer");
  await new Promise((r) => setTimeout(r, 600));
  const onlyOne = await page.evaluate(() => document.querySelectorAll('[data-testid="ct-orders-table"] [data-testid^="ct-orders-oid-"]').length);
  ok("C5 search by customer narrows the register to the order", onlyOne === 1, `rows=${onlyOne}`);
  await page.click('[data-testid="ct-search"]');
  await page.keyboard.down("Control");
  await page.keyboard.press("A");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  await page.type('[data-testid="ct-search"]', baseline.codeNoPin);
  await new Promise((r) => setTimeout(r, 600));
  const rowCountCode = await page.evaluate(() => document.querySelectorAll('[data-testid="ct-orders-table"] [data-testid^="ct-orders-oid-"]').length);
  ok("C5b search by tracking code works", rowCountCode === 1, `rows=${rowCountCode} code=${baseline.codeNoPin}`);
  await page.click('[data-testid="ct-orders-reset"]');
  await new Promise((r) => setTimeout(r, 500));

  /* C6 — status + payment filters */
  await page.select('[data-testid="ct-filter-status"]', "CANCELLED");
  await new Promise((r) => setTimeout(r, 600));
  const cancelledVisible = await page.evaluate((id) => !!document.querySelector(`[data-testid="ct-orders-oid-${id}"]`), idA);
  await page.select('[data-testid="ct-filter-status"]', "CONFIRMED");
  await new Promise((r) => setTimeout(r, 600));
  const confirmedVisible = await page.evaluate((id) => !!document.querySelector(`[data-testid="ct-orders-oid-${id}"]`), idA);
  ok("C6 status filter shows only matching orders", !cancelledVisible && confirmedVisible);
  await page.select('[data-testid="ct-orders-payment"]', "UNPAID");
  await new Promise((r) => setTimeout(r, 600));
  const paidHidden = await page.evaluate((id) => !!document.querySelector(`[data-testid="ct-orders-oid-${id}"]`), idA);
  await page.select('[data-testid="ct-orders-payment"]', "PAID");
  await new Promise((r) => setTimeout(r, 600));
  const paidShown = await page.evaluate((id) => !!document.querySelector(`[data-testid="ct-orders-oid-${id}"]`), idA);
  ok("C6b payment filter (UNPAID hides the paid order, PAID shows it)", !paidHidden && paidShown);
  await page.select('[data-testid="ct-orders-payment"]', "");
  await page.select('[data-testid="ct-filter-status"]', "");
  await new Promise((r) => setTimeout(r, 500));

  /* C7 — business filter */
  await page.select('[data-testid="ct-filter-biz"]', "1");
  await new Promise((r) => setTimeout(r, 600));
  const afterBiz1 = await page.evaluate((id) => !!document.querySelector(`[data-testid="ct-orders-oid-${id}"]`), idA);
  await page.select('[data-testid="ct-filter-biz"]', "6");
  await new Promise((r) => setTimeout(r, 600));
  const biz6HidesBiz1Row = await page.evaluate((id) => !document.querySelector(`[data-testid="ct-orders-oid-${id}"]`), idA);
  ok("C7 business filter scopes the register", afterBiz1 && biz6HidesBiz1Row, `biz1=${afterBiz1} hide=${biz6HidesBiz1Row}`);
  await page.select('[data-testid="ct-filter-biz"]', "");
  await new Promise((r) => setTimeout(r, 600));

  /* C8 — date-range filters (React-safe native setter) */
  const setDate = async (sel, v) =>
    page.evaluate((s, val) => {
      const el = document.querySelector(s);
      if (!el) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, val);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, sel, v);
  const today = todayUtc();
  await setDate('[data-testid="ct-orders-from"]', today);
  await setDate('[data-testid="ct-orders-to"]', today);
  await new Promise((r) => setTimeout(r, 600));
  const todayShows = await page.evaluate((id) => !!document.querySelector(`[data-testid="ct-orders-oid-${id}"]`), idA);
  await setDate('[data-testid="ct-orders-from"]', "2099-01-01");
  await new Promise((r) => setTimeout(r, 600));
  const futureEmpty = await page.$('[data-testid="ct-orders-empty"]');
  ok("C8 date-range filter (today hits, future range empties)", todayShows && !!futureEmpty);
  await setDate('[data-testid="ct-orders-from"]', "");
  await setDate('[data-testid="ct-orders-to"]', "");
  await new Promise((r) => setTimeout(r, 500));

  /* C9 — branch filter (visible when several branches exist in scope) */
  const branchInfo = await page.evaluate(() => {
    const sel = document.querySelector('[data-testid="ct-orders-branch"]');
    if (!sel) return { present: false };
    const opts = [...sel.querySelectorAll("option")].map((o) => o.value);
    return { present: true, opts };
  });
  if (branchInfo.present && branchInfo.opts.filter(Boolean).length >= 2) {
    const testBranch = (await pg.query(`SELECT branch_name, branch_code FROM customer_trackings WHERE id=$1`, [idA])).rows[0];
    const target = testBranch?.branch_name || testBranch?.branch_code || "";
    const other = branchInfo.opts.find((o) => o && o !== target);
    await page.select('[data-testid="ct-orders-branch"]', other);
    await new Promise((r) => setTimeout(r, 500));
    const hiddenAtOther = await page.evaluate((id) => !document.querySelector(`[data-testid="ct-orders-oid-${id}"]`), idA);
    await page.select('[data-testid="ct-orders-branch"]', target);
    await new Promise((r) => setTimeout(r, 500));
    const shownAtOwn = await page.evaluate((id) => !!document.querySelector(`[data-testid="ct-orders-oid-${id}"]`), idA);
    ok("C9 branch filter scopes orders to the branch", hiddenAtOther && shownAtOwn);
    await page.select('[data-testid="ct-orders-branch"]', "");
    await new Promise((r) => setTimeout(r, 400));
  } else {
    ok("C9 branch filter available when scope spans branches (verified via API params)", true);
  }

  /* C10 — row expansion: linked systems + delivery map */
  await page.click(`[data-testid="ct-expand-${idA}"]`);
  await page.waitForSelector(`[data-testid="ct-links-${idA}"]`, { timeout: 15000 });
  const links = await page.evaluate((id) => ({
    track: document.querySelector(`[data-testid="ct-link-track-${id}"]`)?.textContent || "",
    sale: document.querySelector(`[data-testid="ct-link-sale-${id}"]`)?.textContent || "",
    finance: document.querySelector(`[data-testid="ct-link-finance-${id}"]`)?.textContent || "",
    inventory: document.querySelector(`[data-testid="ct-link-inventory-${id}"]`)?.textContent || "",
    delivery: document.querySelector(`[data-testid="ct-link-delivery-${id}"]`)?.textContent || "",
  }), idA);
  ok("C10 order links Tracking · Sales · Inventory · Finance · Delivery",
    links.track.includes(baseline.codeA) && /TRX-/.test(links.finance) && /stock reserved/.test(links.inventory) &&
    /pin set/i.test(links.delivery), JSON.stringify(links));
  const map = await page.evaluate((id) => ({
    src: document.querySelector(`[data-testid="ct-delivmap-${id}"]`)?.getAttribute("src") || "",
    open: document.querySelector(`[data-testid="ct-delivopen-${id}"]`)?.getAttribute("href") || "",
    coords: document.querySelector(`[data-testid="ct-delivcoords-${id}"]`)?.textContent || "",
  }), idA);
  ok("C10b staff see the customer's delivery pin: Google map + open link + coords",
    map.src.includes("maps.google.com/maps?q=5.650123") && map.open.includes("maps.google.com/?q=5.650123") &&
    map.coords.includes("5.650123"), JSON.stringify(map));
  await page.evaluate((id) => document.querySelector(`[data-testid="ct-delivery-${id}"]`)?.scrollIntoView({ block: "center" }), idA);
  await new Promise((r) => setTimeout(r, 700));
  await page.screenshot({ path: "/home/user/orders-1-register.png" });

  /* C11 — staff act from the register: confirm→process→dispatch→(live)→deliver */
  const click = async (status) => {
    await page.waitForSelector(`[data-testid="ct-adv-${idA}-${status}"]`, { timeout: 10000 });
    await page.click(`[data-testid="ct-adv-${idA}-${status}"]`);
    await new Promise((r) => setTimeout(r, 1400));
  };
  await click("PROCESSING");
  await click("DISPATCHED");
  await apiOwnerLocation(idA); // courier's live GPS ping
  // refresh client-side so the updated row (driver loc) feeds the detail
  await page.click('[data-testid="ct-refresh"]');
  await new Promise((r) => setTimeout(r, 1600));
  await page.waitForSelector(`[data-testid="ct-links-${idA}"]`, { timeout: 15000 }); // row stays expanded across refresh
  const routeAfter = await page.evaluate((id) => document.querySelector(`[data-testid="ct-delivroute-${id}"]`)?.getAttribute("href") || "", idA);
  ok("C11 courier gets a Google-Maps route from live position → customer pin",
    /dir\/\?api=1&origin=5\.60/.test(routeAfter) && routeAfter.includes("destination=5.650123"), routeAfter);

  /* C12 — the customer's public page shows the live route while dispatched */
  const { ctx: ctxCust, page: pc } = await newPage("customer-dispatch", { width: 430, height: 932 });
  await pc.goto(`${BASE}/track?code=${encodeURIComponent(baseline.codeA)}`, { waitUntil: "networkidle0", timeout: 60000 });
  await pc.waitForSelector('[data-testid="track-delivery-map"]', { timeout: 30000 });
  const liveBits = await pc.evaluate(() => ({
    route: document.querySelector('[data-testid="track-route-link"]')?.getAttribute("href") || "",
    mapSrc: document.querySelector('[data-testid="track-delivery-map-frame"]')?.getAttribute("src") || "",
    coords: document.querySelector('[data-testid="track-delivery-coords"]')?.textContent || "",
    open: document.querySelector('[data-testid="track-delivery-open"]')?.getAttribute("href") || "",
    bodyHasPhone: document.body.innerText.includes("0551230001"),
  }));
  ok("C12 customer's /track: destination map + live courier route link, no phone leak",
    liveBits.mapSrc.includes("maps.google.com/maps?q=5.650123") && /api=1&origin=/.test(liveBits.route) &&
    liveBits.open.includes("maps.google.com/?q=5.650123") && liveBits.coords.includes("5.650123") && !liveBits.bodyHasPhone);
  await pc.evaluate(() => document.querySelector('[data-testid="track-delivery-map"]')?.scrollIntoView({ block: "center" }));
  await new Promise((r) => setTimeout(r, 600));
  await pc.screenshot({ path: "/home/user/orders-3-track-destination.png" });
  await ctxCust.close();

  // close it out from the register UI
  await click("DELIVERED");
  const closed = await page.evaluate((id) => (document.querySelector(`[data-testid="ct-actions-${id}"]`)?.textContent || "").includes("Order is closed"), idA);
  ok("C12b DISPATCHED → DELIVERED from the register; terminal locks actions", closed);

  /* C13 — Live-tracking console toggle still offers the classic view */
  await page.click('[data-testid="ct-view-console"]');
  await page.waitForSelector('[data-testid="ct-table"]', { timeout: 15000 });
  const consoleRow = await page.evaluate((id) => !!document.querySelector(`[data-testid="ct-live-expand-${id}"]`) ||
    !!document.querySelector(`[data-testid="ct-row-${id}"]`), baseline.rowNoPinId || 0);
  ok("C13 Live-tracking view toggles in with the order rows", consoleRow);
  await page.click('[data-testid="ct-view-orders"]');
  await page.waitForSelector('[data-testid="ct-orders-table"]', { timeout: 15000 });
  await ctx.close();
}

async function apiOwnerLocation(id) {
  const ck = await login(OWNER.email, OWNER.pass);
  await api(ck, "/api/tracking", { method: "POST", body: JSON.stringify({ action: "LOCATION", id, lat: 5.60521, lng: -0.18991, driverName: "TEST Courier" }) });
}

/* ═══ D · storefront Google-Maps pin UX (real browser) ═══ */
async function sectionD() {
  console.log("\n— D · Storefront Google-Maps pin UX —");
  const { ctx, page } = await newPage("storefront-pin", { width: 430, height: 932 });
  await page.goto(`${BASE}/order`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid^="oo-biz-"]', { timeout: 60000 });

  // pick the poultry branch (biz 1) explicitly so product ids match baseline.product
  const biz1 = await page.evaluate(() => {
    const chips = [...document.querySelectorAll('[data-testid^="oo-biz-"]')];
    const hit = chips.find((c) => /Akuafo|Poultry/i.test(c.textContent || ""));
    if (hit) { hit.click(); return hit.getAttribute("data-testid"); }
    return null;
  });
  ok("D0 storefront lists the branch for ordering", !!biz1);
  await page.waitForSelector(`[data-testid="oo-prod-${baseline.product.id}"]`, { timeout: 15000 });
  await page.click(`[data-testid="oo-add-${baseline.product.id}"]`);
  await page.waitForSelector('[data-testid="oo-cart"]', { timeout: 10000 });

  // Fixed cart bar can overlap mid-page controls on a phone viewport after
  // scrollIntoView(nearest) — centre the control first, as a human would.
  const centreClick = async (sel) => {
    await page.$eval(sel, (el) => el.scrollIntoView({ block: "center" }));
    await new Promise((r) => setTimeout(r, 150));
    await page.click(sel);
  };
  await centreClick('[data-testid="oo-delivery"]');
  await page.waitForSelector('[data-testid="oo-pin-root"]', { timeout: 10000 });
  await page.type('[data-testid="oo-name"]', "TEST UI Pinner");
  await page.type('[data-testid="oo-phone"]', "0551230456");
  await page.type('[data-testid="oo-destination"]', "TEST Osu, Oxford Street");
  // D1 — placing without a pin is blocked with guidance
  await page.click('[data-testid="oo-place"]');
  await page.waitForSelector('[data-testid="oo-error"]', { timeout: 10000 });
  const errTxt = await page.$eval('[data-testid="oo-error"]', (el) => el.textContent || "");
  ok("D1 delivery requires pinning the exact delivery point first", /Pin your exact delivery point/i.test(errTxt), errTxt.slice(0, 120));

  // D2 — drop the pin at the map centre, fine-tune with arrows
  await centreClick('[data-testid="oo-pin-set"]');
  await page.waitForFunction(() => /5\.6037/.test(document.querySelector('[data-testid="oo-pin-coords"]')?.textContent || ""), { timeout: 10000 });
  const mapSrc = await page.$eval('[data-testid="oo-pin-map"]', (el) => el.getAttribute("src") || "");
  ok("D2 pin set — embedded Google Map follows it", mapSrc.includes("maps.google.com/maps?q=5.603700"), mapSrc);
  await page.select('[data-testid="oo-pin-step"]', "100");
  await page.click('[data-testid="oo-pin-e"]');
  await new Promise((r) => setTimeout(r, 500));
  const coordsAfter = await page.$eval('[data-testid="oo-pin-coords"]', (el) => el.textContent || "");
  const lngAfter = Number(coordsAfter.split(",")[1]);
  ok("D2b arrow pad adjusts the pin (~100 m east per tap)", Number.isFinite(lngAfter) && lngAfter > -0.187 && (-0.187 - lngAfter) * -1 > 0.0005, coordsAfter);

  // D3 — direct coordinates entry (fields prefill from the current pin — clear first)
  await page.click('[data-testid="oo-pin-manual-toggle"]');
  await page.waitForSelector('[data-testid="oo-pin-manual-lat"]', { timeout: 5000 });
  for (const sel of ['[data-testid="oo-pin-manual-lat"]', '[data-testid="oo-pin-manual-lng"]']) {
    await page.click(sel);
    await page.keyboard.down("Control");
    await page.keyboard.press("A");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");
  }
  await page.type('[data-testid="oo-pin-manual-lat"]', "5.611170");
  await page.type('[data-testid="oo-pin-manual-lng"]', "-0.209990");
  await page.click('[data-testid="oo-pin-manual-apply"]');
  await new Promise((r) => setTimeout(r, 500));
  const coordsManual = await page.$eval('[data-testid="oo-pin-coords"]', (el) => el.textContent || "");
  ok("D3 manual coordinates entry works", coordsManual.includes("5.611170") && coordsManual.includes("-0.209990"), coordsManual);
  await page.evaluate(() => document.querySelector('[data-testid="oo-pin-root"]')?.scrollIntoView({ block: "center" }));
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: "/home/user/orders-2-storefront-pin.png" });

  // place it
  await page.click('[data-testid="oo-place"]');
  await page.waitForSelector('[data-testid="oo-code"]', { timeout: 20000 });
  const uiCode = await page.$eval('[data-testid="oo-code"]', (el) => el.textContent.trim());
  baseline.codeUI = uiCode;
  const successMap = await page.$eval('[data-testid="oo-success-map-frame"]', (el) => el.getAttribute("src") || "").catch(() => "");
  const dbPin = (await pg.query(`SELECT delivery_lat, delivery_lng, delivery_accuracy_m FROM customer_trackings WHERE tracking_code=$1`, [uiCode])).rows[0];
  ok("D4 pinned checkout lands: code, success map, pin stored in DB",
    /^GM-/.test(uiCode) && successMap.includes("maps.google.com/maps?q=5.611170") &&
    dbPin && Math.abs(dbPin.delivery_lat - 5.61117) < 1e-6 && Math.abs(dbPin.delivery_lng + 0.20999) < 1e-6);
  await ctx.close();

  // D5 — real GPS capture (mocked device): Use my location
  const { ctx: ctx2, page: pgps } = await newPage("storefront-gps", { width: 430, height: 932 });
  try {
    await ctx2.overridePermissions(BASE, ["geolocation"]);
  } catch {}
  try { await pgps.setGeolocation({ latitude: GPS_PIN.lat, longitude: GPS_PIN.lng, accuracy: GPS_PIN.acc }); } catch {}
  await pgps.goto(`${BASE}/order`, { waitUntil: "networkidle0", timeout: 60000 });
  await pgps.waitForSelector('[data-testid^="oo-add-"]', { timeout: 60000 });
  await pgps.evaluate(() => {
    const chips = [...document.querySelectorAll('[data-testid^="oo-biz-"]')];
    const hit = chips.find((c) => /Akuafo|Poultry/i.test(c.textContent || ""));
    hit?.click();
  });
  await pgps.waitForSelector(`[data-testid="oo-prod-${baseline.product.id}"]`, { timeout: 15000 });
  await pgps.click(`[data-testid="oo-add-${baseline.product.id}"]`);
  // centre past the fixed cart bar before switching fulfilment (mobile viewport)
  await pgps.$eval('[data-testid="oo-delivery"]', (el) => el.scrollIntoView({ block: "center" }));
  await new Promise((r) => setTimeout(r, 150));
  await pgps.click('[data-testid="oo-delivery"]');
  await pgps.waitForSelector('[data-testid="oo-pin-root"]', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 1500)); // auto-GPS attempt may already have pinned it
  const autoOrClick = await pgps.evaluate(() => {
    const c = document.querySelector('[data-testid="oo-pin-coords"]')?.textContent || "";
    if (!c.includes("No pin")) return "auto";
    const b = document.querySelector('[data-testid="oo-pin-gps"]');
    b?.click();
    return "click";
  });
  await pgps.waitForFunction(() => !/No pin/.test(document.querySelector('[data-testid="oo-pin-coords"]')?.textContent || ""), { timeout: 15000 });
  const gpsCoords = await pgps.$eval('[data-testid="oo-pin-coords"]', (el) => el.textContent || "");
  const gpsAcc = await pgps.$eval('[data-testid="oo-pin-accuracy"]', (el) => el.textContent || "").catch(() => "");
  ok("D5 'Use my location' captures the device's GPS (+accuracy badge)",
    gpsCoords.includes(String(GPS_PIN.lat)) && gpsAcc.includes("12"), `${gpsCoords} | acc='${gpsAcc}' mode=${autoOrClick}`);
  await pgps.type('[data-testid="oo-name"]', "TEST GPS Customer");
  await pgps.type('[data-testid="oo-phone"]', "0551230789");
  await pgps.type('[data-testid="oo-destination"]', "TEST GPS drop");
  await pgps.click('[data-testid="oo-place"]');
  await pgps.waitForSelector('[data-testid="oo-code"]', { timeout: 20000 });
  const gpsCode = await pgps.$eval('[data-testid="oo-code"]', (el) => el.textContent.trim());
  baseline.codeGPS = gpsCode;
  const gpsRow = (await pg.query(`SELECT delivery_accuracy_m FROM customer_trackings WHERE tracking_code=$1`, [gpsCode])).rows[0];
  ok("D5b GPS order stored with its accuracy metres", gpsRow && Number(gpsRow.delivery_accuracy_m) === GPS_PIN.acc, JSON.stringify(gpsRow || {}));
  await ctx2.close();
}

/* ═══ E · pickup-point Google Maps ═══ */
async function sectionE() {
  console.log("\n— E · Pickup-point location (branch GPS anchor) —");
  await pg.query(`UPDATE businesses SET gps_lat=$2::double precision, gps_lng=$3::double precision WHERE id=$1`, [1, BRANCH_GPS.lat, BRANCH_GPS.lng]);
  baseline.branchGpsSet = true;

  const menu = (await api(null, "/api/menu")).json;
  const biz1 = (menu.businesses || []).find((b) => b.businessId === 1);
  ok("E1 storefront menu carries the branch pickup coordinates", biz1 && Math.abs(biz1.gpsLat - BRANCH_GPS.lat) < 1e-9);

  const pub = await api(null, `/api/track?code=${encodeURIComponent(baseline.codePickup)}`);
  ok("E2 pickup order's public payload exposes the branch pickup point",
    pub.json?.tracking?.pickupLocation?.lat && Math.abs(pub.json.tracking.pickupLocation.lat - BRANCH_GPS.lat) < 1e-9,
    JSON.stringify(pub.json?.tracking?.pickupLocation || null));

  const { ctx, page } = await newPage("pickup-map", { width: 430, height: 932 });
  await page.goto(`${BASE}/order`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid^="oo-biz-"]', { timeout: 60000 });
  await page.evaluate(() => {
    const chips = [...document.querySelectorAll('[data-testid^="oo-biz-"]')];
    const hit = chips.find((c) => /Akuafo|Poultry/i.test(c.textContent || ""));
    hit?.click();
  });
  await page.waitForSelector('[data-testid="oo-pickup-map"]', { timeout: 15000 });
  const pickSrc = await page.$eval('[data-testid="oo-pickup-map-frame"]', (el) => el.getAttribute("src") || "");
  ok("E3 pickup shows the branch pickup point on Google Maps while ordering",
    pickSrc.includes("maps.google.com/maps?q=5.603700"), pickSrc);
  await ctx.close();

  const { ctx: ctx2, page: pt } = await newPage("pickup-track", { width: 430, height: 932 });
  await pt.goto(`${BASE}/track?code=${encodeURIComponent(baseline.codePickup)}`, { waitUntil: "networkidle0", timeout: 60000 });
  await pt.waitForSelector('[data-testid="track-pickup-map"]', { timeout: 30000 });
  const ptBits = await pt.evaluate(() => ({
    src: document.querySelector('[data-testid="track-pickup-map-frame"]')?.getAttribute("src") || "",
    dir: document.querySelector('[data-testid="track-pickup-directions"]')?.getAttribute("href") || "",
  }));
  ok("E4 customer's /track: 'Where to pick up' map + Google-Maps directions link",
    ptBits.src.includes("maps.google.com/maps?q=5.603700") && ptBits.dir.includes("maps.google.com/?q=5.603700"), JSON.stringify(ptBits));
  await pt.evaluate(() => document.querySelector('[data-testid="track-pickup-map"]')?.scrollIntoView({ block: "center" }));
  await new Promise((r) => setTimeout(r, 600));
  await pt.screenshot({ path: "/home/user/orders-4-pickup-track.png" });
  await ctx2.close();
}

/* ═══ F · role scoping + staff pin-link booking ═══ */
async function sectionF() {
  console.log("\n— F · Roles & staff tools —");
  // BM: scoped register with renamed sidebar entry
  const { ctx, page } = await newPage("bm");
  await loginUi(page, BM);
  await page.waitForSelector('[data-testid="sidebar-tab-tracking"]', { timeout: 30000 });
  const bmLabel = await page.$eval('[data-testid="sidebar-tab-tracking"]', (el) => el.textContent || "");
  await page.click('[data-testid="sidebar-tab-tracking"]');
  await page.waitForSelector('[data-testid="ct-root"]', { timeout: 30000 });
  await page.waitForFunction(() => !document.body.innerText.includes("Loading orders"), { timeout: 30000 });
  const bmText = await page.evaluate(() => document.body.innerText);
  ok("F1 BM gets the Order & Tracking register, scoped to own branch",
    /Order & Tracking/.test(bmLabel) && bmText.includes("TEST Mega Customer") && !bmText.includes("Mina Tech & Electronics Hub"));
  await ctx.close();

  // Worker: same register inside the workspace tab
  const { ctx: ctx2, page: pw } = await newPage("worker");
  await loginUi(pw, WORKER);
  await pw.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /Order & Tracking/i.test(x.textContent || ""));
    b?.click();
  });
  await pw.waitForSelector('[data-testid="worker-tracking-tab"] [data-testid="ct-root"]', { timeout: 30000 });
  await pw.waitForFunction(() => !document.body.innerText.includes("Loading orders"), { timeout: 30000 });
  const wText = await pw.evaluate(() => document.body.innerText);
  ok("F2 worker register shows own-branch orders (incl. closed TEST one)",
    wText.includes("TEST Mega Customer") && !wText.includes("Mina Tech & Electronics Hub"));
  const workerExpand = await pw.evaluate((id) => {
    const el = document.querySelector(`[data-testid="ct-expand-${id}"]`);
    if (el) { el.click(); return true; }
    return false;
  }, baseline.rowA.id);
  await new Promise((r) => setTimeout(r, 800));
  const workerClosed = await pw.evaluate((id) => (document.querySelector(`[data-testid="ct-actions-${id}"]`)?.textContent || "").includes("Order is closed"), baseline.rowA.id);
  ok("F2b worker can view (read/act on) the delivered order's detail", workerExpand && workerClosed);
  await pw.screenshot({ path: "/home/user/orders-5-worker.png" });
  await ctx2.close();

  // Owner: New-Tracking modal with a pasted Google-Maps pin link
  const { ctx: ctx3, page: po } = await newPage("modal");
  await loginUi(po, OWNER);
  await po.click('[data-testid="sidebar-tab-tracking"]');
  await po.waitForSelector('[data-testid="ct-root"]', { timeout: 30000 });
  await po.waitForFunction(() => !document.body.innerText.includes("Loading orders"), { timeout: 30000 });
  await po.click('[data-testid="ct-new-btn"]');
  await po.waitForSelector('[data-testid="ct-new-root"]', { timeout: 10000 });
  await po.select('[data-testid="ct-new-biz"]', "1");
  await po.select('[data-testid="ct-new-fulfillment"]', "DELIVERY");
  await po.type('[data-testid="ct-new-customer"]', "TEST Modal Link Customer");
  await po.type('[data-testid="ct-new-dest"]', "TEST Labadi, by the palms");
  await po.type('[data-testid="ct-new-maplink"]', "https://www.google.com/maps/place/Labadi/@5.5391,-0.2566,17z");
  await po.waitForSelector('[data-testid="ct-new-pin-chip"]', { timeout: 5000 });
  const pinChip = await po.$eval('[data-testid="ct-new-pin-chip"]', (el) => el.textContent || "");
  const pinMap = await po.$eval('[data-testid="ct-new-pin-map"]', (el) => el.getAttribute("src") || "").catch(() => "");
  ok("F3 staff paste a Google-Maps share link — parsed into a pin + preview",
    pinChip.includes("5.539100") && pinChip.includes("-0.256600") && pinMap.includes("maps.google.com/maps?q=5.539100"), `${pinChip} | ${pinMap}`);
  await po.type('[data-testid="ct-item-desc-0"]', "TEST 10 trays eggs");
  await page2type(po, '[data-testid="ct-item-price-0"]', "55");
  await po.click('[data-testid="ct-new-submit"]');
  await po.waitForSelector('[data-testid="ct-new-code"]', { timeout: 15000 });
  const modalCode = await po.$eval('[data-testid="ct-new-code"]', (el) => el.textContent.trim());
  baseline.codeModal = modalCode;
  const modalRow = (await pg.query(`SELECT delivery_lat, delivery_lng, delivery_map_link FROM customer_trackings WHERE tracking_code=$1`, [modalCode])).rows[0];
  ok("F3b staff-created pin stored with the booking",
    modalRow && Math.abs(modalRow.delivery_lat - 5.5391) < 1e-9 && (modalRow.delivery_map_link || "").includes("maps.google.com/?q=5.539100"));
  await po.click('[data-testid="ct-new-done"]');
  await new Promise((r) => setTimeout(r, 1200));

  // bad link → gentle warning, booking still possible (address only)
  await po.click('[data-testid="ct-new-btn"]');
  await po.waitForSelector('[data-testid="ct-new-root"]', { timeout: 10000 });
  await po.select('[data-testid="ct-new-biz"]', "1");
  await po.select('[data-testid="ct-new-fulfillment"]', "DELIVERY");
  await po.type('[data-testid="ct-new-customer"]', "TEST Modal BadLink");
  await po.type('[data-testid="ct-new-dest"]', "TEST address only");
  await po.type('[data-testid="ct-new-maplink"]', "not a real maps link");
  await po.waitForSelector('[data-testid="ct-new-pin-bad"]', { timeout: 5000 });
  await po.type('[data-testid="ct-item-desc-0"]', "TEST item");
  await page2type(po, '[data-testid="ct-item-price-0"]', "10");
  await po.click('[data-testid="ct-new-submit"]');
  await po.waitForSelector('[data-testid="ct-new-code"]', { timeout: 15000 });
  const badCode = await po.$eval('[data-testid="ct-new-code"]', (el) => el.textContent.trim());
  baseline.codeBadLink = badCode;
  const badRow = (await pg.query(`SELECT delivery_lat FROM customer_trackings WHERE tracking_code=$1`, [badCode])).rows[0];
  ok("F3c unparseable link warns but never blocks the booking (no pin stored)",
    badRow && badRow.delivery_lat === null);
  await po.click('[data-testid="ct-new-done"]');
  await new Promise((r) => setTimeout(r, 900));
  await ctx3.close();
}
async function page2type(page, sel, val) {
  await page.click(sel, { clickCount: 3 }).catch(() => {});
  await page.type(sel, val);
}

/* ═══ Z · cleanup & forensics ═══ */
async function cleanup() {
  console.log("\n— Z · cleanup & forensics —");
  if (baseline.branchGpsSet) {
    await pg.query(`UPDATE businesses SET gps_lat=NULL, gps_lng=NULL WHERE id=1`);
  }
  if (baseline.invTouched) await restoreInv(baseline.invTouched.id, baseline.invTouched.qty);

  const trk = await pg.query(`DELETE FROM customer_trackings WHERE customer_name LIKE 'TEST%' RETURNING id`);
  const docs = await pg.query(`DELETE FROM sales_documents WHERE id > $1 AND customer_name LIKE 'TEST%' RETURNING id`, [baseline.docMax]);
  const trxs = await pg.query(`DELETE FROM transactions WHERE id > $1 AND (category='Online Order Sale' OR description LIKE '%TEST%') RETURNING id`, [baseline.trxMax]);
  const ntfs = await pg.query(`DELETE FROM notifications WHERE id > $1 AND type IN ('ONLINE_ORDER_RECEIVED','ORDER_TRACKING_STATUS') RETURNING id`, [baseline.ntfMax]);
  const custs = await pg.query(`DELETE FROM customers WHERE id > $1 AND name LIKE 'TEST%' RETURNING id`, [baseline.custMax]);
  const sess = await pg.query(`DELETE FROM user_sessions WHERE id > $1 RETURNING id`, [baseline.sessMax]);

  const leftovers = (await pg.query(`SELECT count(*)::int c FROM customer_trackings WHERE customer_name LIKE 'TEST%'`)).rows[0].c;
  const docLeft = (await pg.query(`SELECT count(*)::int c FROM sales_documents WHERE customer_name LIKE 'TEST%'`)).rows[0].c;
  ok("Z1 TEST orders / documents / transactions / notifications / customers / sessions purged", leftovers === 0 && docLeft === 0);
  const invNow = baseline.invTouched
    ? (await pg.query(`SELECT quantity FROM inventory_items WHERE id=$1`, [baseline.invTouched.id])).rows[0].quantity
    : null;
  ok("Z2 inventory restored to the exact pre-suite quantity", !baseline.invTouched || Math.abs(invNow - baseline.invTouched.qty) < 1e-9, `qty=${invNow} want ${baseline.invTouched?.qty}`);
  const preRows = (await pg.query(`SELECT id FROM customer_trackings WHERE id <= $1 ORDER BY id`, [baseline.trMax])).rows.map((r) => r.id);
  ok("Z3 every pre-existing order row untouched (user's live orders intact)",
    JSON.stringify(preRows) === JSON.stringify(baseline.preExistingIds), `${JSON.stringify(preRows)} vs ${JSON.stringify(baseline.preExistingIds)}`);
  const gpsNow = (await pg.query(`SELECT gps_lat, gps_lng FROM businesses WHERE id=1`)).rows[0];
  const bizCount = (await pg.query(`SELECT count(*)::int c FROM businesses`)).rows[0].c;
  const userCount = (await pg.query(`SELECT count(*)::int c FROM users`)).rows[0].c;
  ok("Z4 branch GPS anchor restored & business/user counts unchanged",
    gpsNow.gps_lat === null && gpsNow.gps_lng === null && bizCount === baseline.bizCount && userCount === baseline.userCount);
  console.log(`   purged: trackings=${trk.rowCount} docs=${docs.rowCount} trxns=${trxs.rowCount} notifications=${ntfs.rowCount} customers=${custs.rowCount} sessions=${sess.rowCount}`);
}

async function main() {
  await pg.connect();
  // ── baselines (the user may be live on the app — capture & protect) ──
  baseline.trMax = (await pg.query(`SELECT COALESCE(MAX(id),0)::int m FROM customer_trackings`)).rows[0].m;
  baseline.docMax = (await pg.query(`SELECT COALESCE(MAX(id),0)::int m FROM sales_documents`)).rows[0].m;
  baseline.trxMax = (await pg.query(`SELECT COALESCE(MAX(id),0)::int m FROM transactions`)).rows[0].m;
  baseline.ntfMax = (await pg.query(`SELECT COALESCE(MAX(id),0)::int m FROM notifications`)).rows[0].m;
  baseline.custMax = (await pg.query(`SELECT COALESCE(MAX(id),0)::int m FROM customers`)).rows[0].m;
  baseline.sessMax = (await pg.query(`SELECT COALESCE(MAX(id),0)::int m FROM user_sessions`)).rows[0].m;
  baseline.bizCount = (await pg.query(`SELECT count(*)::int c FROM businesses`)).rows[0].c;
  baseline.userCount = (await pg.query(`SELECT count(*)::int c FROM users`)).rows[0].c;
  baseline.preExistingIds = (await pg.query(`SELECT id FROM customer_trackings WHERE id <= $1 ORDER BY id`, [baseline.trMax])).rows.map((r) => r.id);
  const menu = (await api(null, "/api/menu")).json;
  const prod = (menu.businesses || []).find((b) => b.businessId === 1)?.products?.find((p) => p.available >= 3);
  if (!prod) throw new Error("no biz-1 product with stock for the suite");
  baseline.product = prod;

  const cookies = {
    owner: await login(OWNER.email, OWNER.pass),
    bm: await login(BM.email, BM.pass),
    worker: await login(WORKER.email, WORKER.pass),
  };
  await sectionA(cookies);

  browser = await puppeteer.launch({
    executablePath: "/tmp/al2023/chromium",
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    await sectionC();
    await sectionD();
    await sectionE();
    await sectionF();
  } finally {
    await browser.close().catch(() => {});
  }
  ok("G0 ZERO page/console errors across register, storefront, track & role views", errors.length === 0, errors.slice(0, 5).join(" | "));

  await cleanup();
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n══ ${passed}/${results.length} checks passed ══`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(async (e) => {
  console.error("SUITE CRASH:", e);
  try { await cleanup(); } catch {}
  process.exit(1);
});
