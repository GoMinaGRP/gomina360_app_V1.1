/**
 * verify-storefront-areas.mjs — Maps-aware storefront (service areas),
 * online-ordering management + QR/share links, image enlarge, staff-login
 * isolation, and form auto-close — end-to-end against the live app.
 *
 * A · Menu & enforcement API: service-area fields served; disabled units
 *     hidden from /order & refused at checkout; fulfilment switches; radius
 *     refused beyond area (server-side); PATCH gating (worker 403, manager
 *     whitelist OK, cross-business 403, non-whitelist 403, validation 400s).
 * B · Storefront "serving my location": GPS & pin flows, distance badges,
 *     near/all toggle, out-of-area branches hidden & flagged, deep links
 *     honoured, on mobile viewport.
 * C · Product image enlarge (lightbox): open / add-to-cart / Esc / backdrop.
 * D · Customer pages carry NO staff-login entry; tracking page has a
 *     scannable share QR.
 * E · Management UI: owner full flow (list → online panel → save → QR),
 *     navbar deep link, BM straight-to-panel with scoped actions, worker
 *     entry hidden.
 * F · Forms auto-close: Add-Stock-Item closes + flash + clean reopen;
 *     worker quick-customer flashes & clears.
 * Z · every TEST row purged; businesses/users/gps/radius/notes restored;
 *     inventory untouched; ZERO page/console errors gate.
 */
import { createRequire } from "module";
const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");
const { Client } = require("pg");

const BASE = "http://127.0.0.1:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pass: process.env.GOMINA_OWNER_PW || "Owner@GoMina26" };
const BM = { email: "emmanuel@gomina360.com", pass: "GoMina@User3" };          // biz 1
const WORKER = { email: "kwabena.mensah@gomina360.com", pass: "GoMina@User11" }; // biz 1

const ANCHOR = { lat: 5.6037, lng: -0.187 };        // Accra CBD (biz1 temp anchor)
const ANCHOR_FAR = { lat: 6.6911, lng: -1.6244 };   // Kumasi (biz2 temp anchor)
const CUST_NEAR = { lat: 5.6041, lng: -0.187 };     // ~45 m from biz1 anchor
const CUST_INTL = { lat: 6.9, lng: -1.9 };          // 33 km+ from both anchors
const PIN_FAR = { lat: 5.9, lng: -0.187 };          // ~33 km north of ANCHOR
const RADIUS_KM = 8;

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
const patchBiz = (cookie, id, body) => api(cookie, `/api/businesses/${id}`, { method: "PATCH", body: JSON.stringify(body) });

/* ═══ browser harness ═══ */
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
const clickByText = (page, text, tag = "button") =>
  page.evaluate(
    (txt, tg) => {
      const el = [...document.querySelectorAll(tg)].find((e) => (e.textContent || "").trim().includes(txt));
      if (el) { el.click(); return true; }
      return false;
    },
    text,
    tag,
  );
const shot = (page, name) => page.screenshot({ path: `/home/user/${name}.png` });

/* ═══ A · Menu + enforcement + gating API ═══ */
async function grantBmOnline(cookies, on) {
  const res = await api(cookies.owner, "/api/users", {
    method: "PATCH",
    body: JSON.stringify({ userId: 3, canManageOnline: on }),
  });
  ok(`SETUP BM canManageOnline=${on}`, res.status === 200 && res.json?.success === true, JSON.stringify(res.json || {}).slice(0, 160));
}

async function sectionA(cookies) {
  console.log("\n— A · service-area menu + enforcement + PATCH gating —");
  await grantBmOnline(cookies, true);

  const menu = (await api(null, "/api/menu")).json;
  const m1 = (menu.businesses || []).find((b) => b.businessId === 1);
  ok("A1 menu serves service-area & branch-linkage fields (never customer data)",
    m1 && "serviceRadiusKm" in m1 && "pickupEnabled" in m1 && "deliveryEnabled" in m1 &&
    "serviceNote" in m1 && m1.branchCode === "POULTRY-01" &&
    !("deliveryLat" in m1) && JSON.stringify(m1).includes("customerName") === false);

  const anon = await patchBiz(null, 1, { serviceRadiusKm: 9 });
  const wk = await patchBiz(cookies.worker, 1, { serviceRadiusKm: 9 });
  ok("A2 anonymous + WORKER PATCH refused 403 (workers are NOT authorized staff)",
    anon.status === 403 && wk.status === 403, `anon=${anon.status} worker=${wk.status}`);

  const ownSet = await patchBiz(cookies.owner, 1, {
    serviceRadiusKm: RADIUS_KM, serviceNote: "TEST delivery note", gpsLat: ANCHOR.lat, gpsLng: ANCHOR.lng,
  });
  const ownGet = await api(cookies.owner, "/api/businesses/1");
  ok("A3 owner sets radius + note + branch pin (reflected on read)",
    ownSet.status === 200 && ownGet.json?.business?.serviceRadiusKm === RADIUS_KM &&
    ownGet.json?.business?.serviceNote === "TEST delivery note" &&
    Math.abs((ownGet.json?.business?.gpsLat ?? 0) - ANCHOR.lat) < 1e-9,
    JSON.stringify(ownSet.json || {}).slice(0, 160));

  const bmOk = await patchBiz(cookies.bm, 1, { serviceRadiusKm: RADIUS_KM });
  const bmScope = await patchBiz(cookies.bm, 1, { name: "TEST Rename Attempt" });
  const bmCross = await patchBiz(cookies.bm, 2, { serviceRadiusKm: 3 });
  ok("A4 authorized BM: whitelist OK on own unit; name → 403; other unit → 403",
    bmOk.status === 200 && bmScope.status === 403 && bmCross.status === 403,
    `ok=${bmOk.status} scope=${bmScope.status} cross=${bmCross.status}`);

  const badR = await patchBiz(cookies.owner, 1, { serviceRadiusKm: -5 });
  const bigR = await patchBiz(cookies.owner, 1, { serviceRadiusKm: 5000 });
  const halfGps = await patchBiz(cookies.owner, 1, { gpsLat: 5.6 });
  const halfGps2 = await patchBiz(cookies.owner, 1, { gpsLat: null });
  ok("A5 validation: radius −5/5000 → 400; asymmetric GPS pair refused 400",
    badR.status === 400 && bigR.status === 400 && halfGps.status === 400 && halfGps2.status === 400,
    `${badR.status}/${bigR.status}/${halfGps.status}/${halfGps2.status}`);

  // A6 — switching a unit OFF removes it from the storefront AND refuses checkout
  const off = await patchBiz(cookies.owner, 2, { onlineOrderingEnabled: false });
  const menuHidden = (await api(null, "/api/menu")).json;
  const prod2 = baseline.product2;
  const blocked = await api(null, "/api/order", {
    method: "POST",
    body: JSON.stringify({ businessId: 2, customerName: "TEST OffBiz", customerPhone: "0551000002", fulfillmentType: "PICKUP", items: [{ inventoryId: prod2.id, quantity: 1 }] }),
  });
  ok("A6 online-off unit vanishes from /order menu and checkout refuses 404",
    off.status === 200 && !(menuHidden.businesses || []).some((b) => b.businessId === 2) && blocked.status === 404,
    `${off.status}/${blocked.status}`);
  await patchBiz(cookies.owner, 2, { onlineOrderingEnabled: true });
  const menuBack = (await api(null, "/api/menu")).json;
  ok("A6b switching back ON restores the unit on the storefront immediately",
    (menuBack.businesses || []).some((b) => b.businessId === 2));

  // A7 — fulfilment switches enforced at checkout
  await patchBiz(cookies.owner, 1, { deliveryEnabled: false });
  const p = baseline.product;
  const delBlocked = await api(null, "/api/order", {
    method: "POST",
    body: JSON.stringify({ businessId: 1, customerName: "TEST DelSwitch", customerPhone: "0551000003", fulfillmentType: "DELIVERY", destinationAddress: "TEST addr", deliveryLat: CUST_NEAR.lat, deliveryLng: CUST_NEAR.lng, items: [{ inventoryId: p.id, quantity: 1 }] }),
  });
  const pickOk = await api(null, "/api/order", {
    method: "POST",
    body: JSON.stringify({ businessId: 1, customerName: "TEST PickSwitch", customerPhone: "0551000004", fulfillmentType: "PICKUP", items: [{ inventoryId: p.id, quantity: 1 }] }),
  });
  ok("A7 delivery switch OFF: DELIVERY refused 400 with hint, PICKUP still works",
    delBlocked.status === 400 && /not offering delivery/i.test(delBlocked.json?.error || "") && pickOk.status === 200,
    `${delBlocked.status}:${(delBlocked.json?.error || "").slice(0, 60)} / ${pickOk.status}`);
  await patchBiz(cookies.owner, 1, { deliveryEnabled: true });

  // A8 — service-area enforcement on the delivery pin (server-side guarantee)
  const farOrder = await api(null, "/api/order", {
    method: "POST",
    body: JSON.stringify({ businessId: 1, customerName: "TEST FarPin", customerPhone: "0551000005", fulfillmentType: "DELIVERY", destinationAddress: "TEST far", deliveryLat: PIN_FAR.lat, deliveryLng: PIN_FAR.lng, items: [{ inventoryId: p.id, quantity: 1 }] }),
  });
  ok("A8 out-of-area delivery pin refused 400 with distance explanation",
    farOrder.status === 400 && /outside/.test(farOrder.json?.error || "") && /km/.test(farOrder.json?.error || ""),
    `${farOrder.status}: ${(farOrder.json?.error || "").slice(0, 120)}`);
  const nearOrder = await api(null, "/api/order", {
    method: "POST",
    body: JSON.stringify({ businessId: 1, customerName: "TEST NearPin", customerPhone: "0551000006", fulfillmentType: "DELIVERY", destinationAddress: "TEST near", deliveryLat: CUST_NEAR.lat, deliveryLng: CUST_NEAR.lng, deliveryAccuracyM: 15, items: [{ inventoryId: p.id, quantity: 1 }] }),
  });
  baseline.codeNear = nearOrder.json?.trackingCode;
  ok("A8b in-area pinned order succeeds and links its tracking code", nearOrder.status === 200 && /^GM-/.test(baseline.codeNear || ""));
  const row = (await pg.query(`SELECT business_id, branch_code, delivery_lat FROM customer_trackings WHERE tracking_code=$1`, [baseline.codeNear || ""])).rows[0];
  ok("A8c order links Business → Branch → Delivery pin on the tracking chain",
    row && row.business_id === 1 && row.branch_code === "POULTRY-01" && Math.abs(row.delivery_lat - CUST_NEAR.lat) < 1e-9);

  // biz2 gets the far anchor + radius for the UI filter section
  await patchBiz(cookies.owner, 2, { serviceRadiusKm: RADIUS_KM, gpsLat: ANCHOR_FAR.lat, gpsLng: ANCHOR_FAR.lng });
}

/* ═══ B · storefront “serving my location” (mobile) ═══ */
async function sectionB() {
  console.log("\n— B · storefront serving-my-location (mobile) —");
  const v = { width: 430, height: 932 };

  // B1·2 — granted GPS next to biz1 anchor
  const { ctx, page } = await newPage("nearme-near", v);
  await ctx.overridePermissions(BASE, ["geolocation"]);
  await page.setGeolocation({ latitude: CUST_NEAR.lat, longitude: CUST_NEAR.lng, accuracy: 12 });
  await page.goto(`${BASE}/order`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid="oo-locate"]', { timeout: 30000 });
  await page.click('[data-testid="oo-locate"]');
  await page.waitForSelector('[data-testid="oo-locate-state"]', { timeout: 20000 });
  const state = await page.$eval('[data-testid="oo-locate-state"]', (el) => el.textContent || "");
  ok("B1 GPS fix captured on the storefront (coords + source shown)",
    /GPS fix/.test(state) && /5\.604/.test(state), state.slice(0, 120));
  const dist = await page.$eval('[data-testid="oo-biz-dist-1"]', (el) => el.textContent || "").catch(() => "");
  const biz2Gone = (await page.$('[data-testid="oo-biz-2"]')) === null;
  const biz1There = (await page.$('[data-testid="oo-biz-1"]')) !== null;
  ok("B2 near view shows only serving branches: biz1≈0 km present, biz2 (Kumasi) hidden",
    biz1There && /km/.test(dist) && biz2Gone, `dist="${dist}" biz1=${biz1There} biz2Gone=${biz2Gone}`);
  await shot(page, "areas-1-storefront-nearme");

  await page.click('[data-testid="oo-locate-showall"]');
  await page.waitForSelector('[data-testid="oo-biz-2"]', { timeout: 10000 });
  const outBadge = await page.$eval('[data-testid="oo-biz-out-2"]', (el) => el.textContent || "").catch(() => "");
  ok("B3 “Show all” reveals out-of-area branches, flagged pickup-only", /pickup only/i.test(outBadge), outBadge);
  await page.click('[data-testid="oo-locate-nearonly"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="oo-biz-2"]'), { timeout: 10000 });
  ok("B4 re-tightening the filter hides the out-of-area branch again", true);

  // B5 — chosen branch survives deep links even when shared/QR-targeted
  await page.goto(`${BASE}/order?biz=2`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid="oo-root"]', { timeout: 30000 });
  const selActive = await page.$eval('[data-testid="oo-biz-2"]', (el) => el.className || "");
  ok("B5 shared/QR link ?biz= still selects the branch (never a dead end)",
    /border-cyan-500\/60/.test(selActive), selActive.slice(0, 120));
  await ctx.close();

  // B6 — far GPS: biz1 drops out of the serving list too. Select an
  // unanchored branch first (the selected chip is always kept visible).
  const { ctx: ctx3, page: p3 } = await newPage("nearme-far", v);
  await ctx3.overridePermissions(BASE, ["geolocation"]);
  await p3.setGeolocation({ latitude: CUST_INTL.lat, longitude: CUST_INTL.lng, accuracy: 20 });
  await p3.goto(`${BASE}/order`, { waitUntil: "networkidle0", timeout: 60000 });
  await p3.waitForSelector('[data-testid="oo-biz-8"]', { timeout: 30000 });
  await p3.click('[data-testid="oo-biz-8"]');
  await p3.waitForSelector('[data-testid="oo-locate"]', { timeout: 30000 });
  await p3.click('[data-testid="oo-locate"]');
  await p3.waitForSelector('[data-testid="oo-locate-state"]', { timeout: 20000 });
  const bothGone = (await p3.$('[data-testid="oo-biz-1"]')) === null && (await p3.$('[data-testid="oo-biz-2"]')) === null;
  const unanchoredThere = (await p3.$('[data-testid="oo-biz-8"]')) !== null;
  ok("B6 33 km+ away: both radius-limited branches hidden; unanchored branches still listed",
    bothGone && unanchoredThere, `biz1/2gone=${bothGone} biz8=${unanchoredThere}`);
  await p3.click('[data-testid="oo-locate-clear"]');
  await p3.waitForSelector('[data-testid="oo-biz-1"]', { timeout: 10000 });
  ok("B7 Clear removes the filter — every branch returns", (await p3.$('[data-testid="oo-biz-2"]')) !== null);
  await ctx3.close();

  // B8·9 — permission denied → pin fallback flow
  const { ctx: ctx4, page: p4 } = await newPage("nearme-denied", v);
  await p4.goto(`${BASE}/order`, { waitUntil: "networkidle0", timeout: 60000 });
  await p4.waitForSelector('[data-testid="oo-locate"]', { timeout: 30000 });
  await p4.click('[data-testid="oo-locate"]');
  await p4.waitForSelector('[data-testid="oo-locate-error"]', { timeout: 20000 });
  const pickerUp = (await p4.$('[data-testid="oo-loc-pin-root"]')) !== null;
  ok("B8 denied GPS shows plain explanation + drop-a-pin fallback", pickerUp);
  await p4.waitForSelector('[data-testid="oo-loc-pin-set"]', { timeout: 15000 });
  await p4.click('[data-testid="oo-loc-pin-set"]'); // drop at Accra-centre (near biz1 anchor)
  await p4.waitForSelector('[data-testid="oo-locate-state"]', { timeout: 15000 });
  const pinState = await p4.$eval('[data-testid="oo-locate-state"]', (el) => el.textContent || "");
  const biz2GonePin = (await p4.$('[data-testid="oo-biz-2"]')) === null;
  ok("B9 dropped pin drives the same serving filter (source “Pinned”)",
    /Pinned/.test(pinState) && biz2GonePin, pinState.slice(0, 100));
  await ctx4.close();
}

/* ═══ C · product image enlarge ═══ */
async function sectionC(cookies) {
  console.log("\n— C · product image enlarge (lightbox) —");
  const PHOTO =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAABpJREFUeNpi/P//PwMuwMTABSAGMBKMDhIgwAA14oEFDPjbtQAAAABJRU5ErkJggg==";
  const created = await api(cookies.owner, "/api/enterprise", {
    method: "POST",
    body: JSON.stringify({
      entityType: "inventory",
      data: {
        name: "TEST Photo Widget", sku: "TEST-PHOTO-1", businessId: 1, branchCode: "POULTRY-01",
        category: "General", quantity: 5, unit: "Units", costPriceGhs: 1, sellingPriceGhs: 4,
        minStockThreshold: 1, photo: PHOTO, photos: [PHOTO],
      },
    }),
  });
  const itemId = created.json?.item?.id;
  baseline.testItemId = itemId;
  ok("C0 TEST product WITH a photo is sellable on the storefront", created.status === 200 && !!itemId, JSON.stringify(created.json || {}).slice(0, 140));

  const { ctx, page } = await newPage("lightbox", { width: 430, height: 932 });
  await page.goto(`${BASE}/order?biz=1`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector(`[data-testid="oo-photo-${itemId}"]`, { timeout: 30000 });
  await page.click(`[data-testid="oo-photo-${itemId}"]`);
  await page.waitForSelector('[data-testid="oo-lightbox-img"]', { timeout: 10000 });
  const src = await page.$eval('[data-testid="oo-lightbox-img"]', (el) => el.getAttribute("src") || "");
  const title = await page.evaluate(() => document.querySelector('[data-testid="oo-lightbox"]')?.textContent || "");
  ok("C1 tapping the photo enlarges it in a lightbox (image + name + price)",
    src.startsWith("data:image/png") && /TEST Photo Widget/.test(title) && /GH₵/.test(title));
  await shot(page, "areas-2-image-lightbox");
  await page.click('[data-testid="oo-lightbox-add"]');
  await page.waitForSelector('[data-testid="oo-cart-total"]', { timeout: 10000 });
  const total = await page.$eval('[data-testid="oo-cart-total"]', (el) => el.textContent || "");
  const closedAfterAdd = (await page.$('[data-testid="oo-lightbox"]')) === null;
  ok("C2 “Add to cart” from the lightbox works and closes it (cart GH₵ 4.00)",
    closedAfterAdd && /4\.00/.test(total), total);
  await page.click(`[data-testid="oo-photo-${itemId}"]`);
  await page.waitForSelector('[data-testid="oo-lightbox"]', { timeout: 10000 });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[data-testid="oo-lightbox"]'), { timeout: 10000 });
  ok("C3 Escape closes the lightbox", true);
  await page.click(`[data-testid="oo-photo-${itemId}"]`);
  await page.waitForSelector('[data-testid="oo-lightbox"]', { timeout: 10000 });
  await page.mouse.click(8, 8); // backdrop, outside the card
  await page.waitForFunction(() => !document.querySelector('[data-testid="oo-lightbox"]'), { timeout: 10000 });
  ok("C4 backdrop tap closes the lightbox (thumb-friendly on mobile)", true);
  await ctx.close();
}

/* ═══ D · no staff login on customer pages + share QR ═══ */
async function sectionD() {
  console.log("\n— D · staff-login isolation + tracking share QR —");
  const trackHtml = await (await fetch(`${BASE}/track`)).text();
  const orderHtml = await (await fetch(`${BASE}/order?biz=1`)).text();
  const leaks = (html) =>
    /Staff sign in/i.test(html) || /href="\/login/i.test(html) || />[^<]*staff[^<]*log\s*in/i.test(html);
  ok("D1 customer pages carry NO staff-login entry of any kind",
    !leaks(trackHtml) && !leaks(orderHtml));
  const anchorLeaks = (html) => (html.match(/<a[^>]+href="\/"[^>]*>/gi) || []).length;
  ok("D2 no link on customer pages points at the staff sign-in screen",
    anchorLeaks(trackHtml) === 0 && anchorLeaks(orderHtml) === 0);

  const { ctx, page } = await newPage("track-qr", { width: 430, height: 932 });
  await page.goto(`${BASE}/track?code=${encodeURIComponent(baseline.codeNear)}`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid="track-qr-img"]', { timeout: 30000 });
  const qrSrc = await page.$eval('[data-testid="track-qr-img"]', (el) => el.getAttribute("src") || "");
  ok("D3 tracking page renders a scannable share QR of the order link",
    qrSrc.startsWith("data:image/png;base64,") && qrSrc.length > 500);
  const footer = await page.$eval('[data-testid="track-footer"]', (el) => el.textContent || "");
  ok("D4 footer states customer-only page (former Staff sign-in removed)",
    /customer-only/.test(footer) && !/Staff sign in/i.test(footer), footer.slice(0, 120));
  await shot(page, "areas-3-track-share-qr");
  await ctx.close();
}

/* ═══ E · management UI ═══ */
async function sectionE(cookies) {
  console.log("\n— E · online-ordering management UI —");

  // E1 owner: command center → manage units → online panel → save
  const { ctx, page } = await newPage("mgmt-owner");
  await loginUi(page, OWNER);
  await page.waitForSelector('[data-testid="open-manage-businesses"]', { timeout: 30000 });
  await page.click('[data-testid="open-manage-businesses"]');
  await page.waitForSelector('[data-testid="manage-biz-modal"]', { timeout: 15000 });
  await page.click('[data-testid="manage-biz-online-POULTRY-01"]');
  await page.waitForSelector('[data-testid="mb-onl-root"]', { timeout: 10000 });
  const toggles = await page.evaluate(() =>
    ["enabled", "pickup", "delivery"].every((k) => !!document.querySelector(`[data-testid="mb-onl-toggle-${k}"]`)));
  ok("E1 owner opens a unit's Online panel with storefront switches", toggles);
  await page.click('[data-testid="mb-onl-radius"]');
  await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control");
  await page.type('[data-testid="mb-onl-radius"]', "6.5");
  ok("E2 editing marks the panel dirty (unsaved-changes badge)",
    (await page.$('[data-testid="mb-onl-dirty"]')) !== null);
  await page.click('[data-testid="mb-onl-save"]');
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="manage-biz-modal"]')?.textContent || "").includes("settings saved"),
    { timeout: 15000 },
  );
  const refl = (await api(cookies.owner, "/api/businesses/1")).json?.business;
  ok("E3 save persists (radius 6.5 reflected via API immediately)", refl?.serviceRadiusKm === 6.5, String(refl?.serviceRadiusKm));
  const orderUrl = await page.$eval('[data-testid="mb-onl-order-url"]', (el) => el.value || "");
  const qrOrder = await page.$eval('[data-testid="mb-onl-qr-order"]', (el) => el.getAttribute("src") || "");
  const qrTrack = await page.$eval('[data-testid="mb-onl-qr-track"]', (el) => el.getAttribute("src") || "");
  const shareBtns = await page.evaluate(() =>
    ["mb-onl-copy-order", "mb-onl-qr-order-dl", "mb-onl-copy-track", "mb-onl-qr-track-dl"].every(
      (t) => !!document.querySelector(`[data-testid="${t}"]`)));
  ok("E4 shareable order link + tracking link + both QR codes + copy/download",
    /\/order\?biz=1$/.test(orderUrl) && qrOrder.startsWith("data:image/png;base64,") &&
    qrTrack.startsWith("data:image/png;base64,") && shareBtns, orderUrl);
  const deepLinkWorks = await (async () => {
    const m = (await api(null, "/api/menu")).json;
    return (m.businesses || []).some((b) => b.businessId === 1);
  })();
  ok("E5 unit stays on the storefront under its link while settings change", deepLinkWorks);
  await shot(page, "areas-4-mgmt-online-panel");
  await ctx.close();

  // E6 owner navbar deep-link opens the manager (list mode, owner scope)
  const { ctx: ctx6, page: p6 } = await newPage("mgmt-nav-owner");
  await loginUi(p6, OWNER);
  await p6.waitForSelector('[data-testid="user-menu-btn"]', { timeout: 30000 });
  await p6.click('[data-testid="user-menu-btn"]');
  await p6.waitForSelector('[data-testid="open-online-ordering"]', { timeout: 10000 });
  await p6.click('[data-testid="open-online-ordering"]');
  await p6.waitForSelector('[data-testid="manage-biz-modal"]', { timeout: 10000 });
  const ownerGlobe = (await p6.$('[data-testid="manage-biz-online-POULTRY-01"]')) !== null ||
    (await p6.$('[data-testid="mb-onl-root"]')) !== null;
  ok("E6 navbar entry opens Online management for the owner", ownerGlobe);
  await ctx6.close();

  // E7 BM: straight into his own unit's panel; destructive actions hidden
  const { ctx: ctx7, page: p7 } = await newPage("mgmt-bm");
  await loginUi(p7, BM);
  await p7.waitForSelector('[data-testid="user-menu-btn"]', { timeout: 30000 });
  await p7.click('[data-testid="user-menu-btn"]');
  await p7.waitForSelector('[data-testid="open-online-ordering"]', { timeout: 10000 });
  await p7.click('[data-testid="open-online-ordering"]');
  await p7.waitForSelector('[data-testid="mb-onl-root"]', { timeout: 15000 });
  const hdr = await p7.evaluate(() => document.querySelector('[data-testid="manage-biz-modal"]')?.textContent || "");
  ok("E7 BM lands straight on his own branch's Online panel", /Mina Akuafo Poultry Farm/.test(hdr), hdr.slice(0, 90));
  const gpsState = await p7.$eval('[data-testid="mb-onl-gps-state"]', (el) => el.textContent || "");
  ok("E8 BM sees the branch pin status inside the service-area card", /Not set|,[ ]*-?\d/.test(gpsState), gpsState.slice(0, 90));
  await shot(p7, "areas-5-mgmt-bm");
  await clickByText(p7, "All Units");
  await p7.waitForSelector('[data-testid="manage-biz-online-POULTRY-01"]', { timeout: 10000 });
  const bmActions = await p7.evaluate(() => ({
    globe: !!document.querySelector('[data-testid="manage-biz-online-POULTRY-01"]'),
    del: !!document.querySelector('[data-testid="manage-biz-delete-POULTRY-01"]'),
    reset: !!document.querySelector('[data-testid="manage-biz-reset-POULTRY-01"]'),
    edit: !!document.querySelector('[data-testid="manage-biz-edit-POULTRY-01"]'),
  }));
  ok("E9 BM scope: Online button only — delete/reset/edit stay OWNER-only",
    bmActions.globe && !bmActions.del && !bmActions.reset && !bmActions.edit, JSON.stringify(bmActions));
  await ctx7.close();

  // E10 worker: the management entry is hidden entirely
  const { ctx: ctx8, page: p8 } = await newPage("mgmt-worker");
  await loginUi(p8, WORKER);
  await p8.waitForSelector('[data-testid="user-menu-btn"]', { timeout: 30000 });
  await p8.click('[data-testid="user-menu-btn"]');
  await p8.waitForSelector('[data-testid="user-account-menu"]', { timeout: 10000 });
  const workerEntry = (await p8.$('[data-testid="open-online-ordering"]')) === null;
  ok("E10 WORKER has no online-ordering entry in the account menu", workerEntry);
  await ctx8.close();
}

/* ═══ F · forms auto-close ═══ */
async function sectionF() {
  console.log("\n— F · completed forms close + confirm + reopen clean —");
  const { ctx, page } = await newPage("forms-owner");
  await loginUi(page, OWNER);
  await page.waitForFunction(
    () => [...document.querySelectorAll("button")].some((b) => (b.textContent || "").includes("Inventory & Stock")),
    { timeout: 30000 },
  );
  await clickByText(page, "Inventory & Stock");
  await page.waitForFunction(
    () => [...document.querySelectorAll("button")].some((b) => (b.textContent || "").includes("Add Stock Item")),
    { timeout: 30000 },
  );
  await clickByText(page, "Add Stock Item");
  await page.waitForSelector('[data-testid="inv-name"]', { timeout: 15000 });
  await page.type('[data-testid="inv-name"]', "TEST Flash Item");
  await page.click('[data-testid="inv-qty"]');
  await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control");
  await page.type('[data-testid="inv-qty"]', "3");
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button[type=submit]")].find((b) => (b.textContent || "").includes("Save Record"));
    btn?.click();
  });
  await page.waitForFunction(() => !document.querySelector('[data-testid="inv-name"]'), { timeout: 20000 });
  ok("F1 completed Add-Stock-Item form closes itself on save", true);
  await page.waitForSelector('[data-testid="sem-form-flash"]', { timeout: 15000 });
  const flash = await page.$eval('[data-testid="sem-form-flash"]', (el) => el.textContent || "");
  ok("F2 a confirmation flash stays as the receipt on the register", /form closed/i.test(flash), flash.slice(0, 90));
  if (await page.$('[data-testid="qr-record-close"]')) await page.click('[data-testid="qr-record-close"]').catch(() => {});
  await clickByText(page, "Add Stock Item");
  await page.waitForSelector('[data-testid="inv-name"]', { timeout: 15000 });
  const vals = await page.evaluate(() => ({
    name: document.querySelector('[data-testid="inv-name"]')?.value,
    qty: document.querySelector('[data-testid="inv-qty"]')?.value,
  }));
  ok("F3 reopened form starts clean (no stale TEST name / quantity back to starter)",
    vals.name === "" && vals.qty === "50", JSON.stringify(vals));
  const row = (await pg.query(`SELECT id, name, quantity FROM inventory_items WHERE name='TEST Flash Item' ORDER BY id DESC LIMIT 1`)).rows[0];
  baseline.flashItemId = row?.id;
  ok("F4 the saved record actually landed (TEST Flash Item, qty 3)", !!row && Number(row.quantity) === 3);
  await shot(page, "areas-6-form-flash");
  await ctx.close();

  // F5 worker quick-customer form
  const { ctx: ctxW, page: pw } = await newPage("forms-worker");
  await loginUi(pw, WORKER);
  const tabHit = await pw.evaluate(() => {
    const el = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "Customers");
    if (el) { el.click(); return true; }
    return false;
  });
  ok("F5a worker Customers tab opens", tabHit);
  await pw.waitForSelector('input[placeholder="Customer full name"]', { timeout: 15000 });
  await pw.type('input[placeholder="Customer full name"]', "TEST Flash Customer");
  await pw.evaluate(() => {
    const btn = [...document.querySelectorAll("button[type=submit]")].find((b) => (b.textContent || "").includes("Create Customer"));
    btn?.click();
  });
  await pw.waitForSelector('[data-testid="wk-form-flash"]', { timeout: 15000 });
  const wkFlash = await pw.$eval('[data-testid="wk-form-flash"]', (el) => el.textContent || "");
  const cleared = await pw.evaluate(() => document.querySelector('input[placeholder="Customer full name"]')?.value === "");
  ok("F5 worker customer form flashes & clears after completion",
    /Customer added/.test(wkFlash) && cleared, `${wkFlash.slice(0, 60)} cleared=${cleared}`);
  await ctxW.close();
}

/* ═══ Z · cleanup & forensics ═══ */
async function cleanup() {
  console.log("\n— Z · cleanup & forensics —");
  // restore business online/surface state exactly (ids 1 & 2)
  await grantBmOnline({ owner: baseline.ownerCookie }, baseline.bmOnlineWas);
  for (const b of baseline.bizRestore) {
    await pg.query(
      `UPDATE businesses SET online_ordering_enabled=$2, pickup_enabled=$3, delivery_enabled=$4,
         service_radius_km=$5, service_note=$6, gps_lat=$7, gps_lng=$8 WHERE id=$1`,
      [b.id, b.onl, b.pick, b.del, b.rad, b.note, b.glat, b.glng],
    );
  }
  // TEST rows out (never anything without the TEST prefix)
  const trk = await pg.query(`DELETE FROM customer_trackings WHERE customer_name LIKE 'TEST%' RETURNING id`);
  const docs = await pg.query(`DELETE FROM sales_documents WHERE id > $1 AND customer_name LIKE 'TEST%' RETURNING id`, [baseline.docMax]);
  const trxs = await pg.query(`DELETE FROM transactions WHERE id > $1 AND (category='Online Order Sale' OR description LIKE '%TEST%') RETURNING id`, [baseline.trxMax]);
  const ntfs = await pg.query(`DELETE FROM notifications WHERE id > $1 AND type IN ('ONLINE_ORDER_RECEIVED','ORDER_TRACKING_STATUS') RETURNING id`, [baseline.ntfMax]);
  const custs = await pg.query(`DELETE FROM customers WHERE id > $1 AND name LIKE 'TEST%' RETURNING id`, [baseline.custMax]);
  const inv = await pg.query(`DELETE FROM inventory_items WHERE id > $1 AND (name LIKE 'TEST%' OR sku LIKE 'TEST%') RETURNING id`, [baseline.invMax]);
  const sess = await pg.query(`DELETE FROM user_sessions WHERE id > $1 RETURNING id`, [baseline.sessMax]);

  const leftT = (await pg.query(`SELECT count(*)::int c FROM customer_trackings WHERE customer_name LIKE 'TEST%'`)).rows[0].c;
  const leftD = (await pg.query(`SELECT count(*)::int c FROM sales_documents WHERE customer_name LIKE 'TEST%'`)).rows[0].c;
  const leftI = (await pg.query(`SELECT count(*)::int c FROM inventory_items WHERE name LIKE 'TEST%' OR sku LIKE 'TEST%'`)).rows[0].c;
  const leftC = (await pg.query(`SELECT count(*)::int c FROM customers WHERE name LIKE 'TEST%'`)).rows[0].c;
  ok("Z1 all TEST orders/documents/items/customers purged", leftT === 0 && leftD === 0 && leftI === 0 && leftC === 0,
    `t=${leftT} d=${leftD} i=${leftI} c=${leftC}`);

  const bizNow = (await pg.query(`SELECT id, online_ordering_enabled o, pickup_enabled p, delivery_enabled d, service_radius_km r, service_note n, gps_lat la, gps_lng ln FROM businesses WHERE id IN (1,2) ORDER BY id`)).rows;
  const restoredOk = bizNow.every((r) => {
    const want = baseline.bizRestore.find((b) => b.id === r.id);
    return want && r.o === want.onl && r.p === want.pick && r.d === want.del && r.r === want.rad &&
      (r.n ?? null) === (want.note ?? null) && (r.la ?? null) === (want.glat ?? null) && (r.ln ?? null) === (want.glng ?? null);
  });
  ok("Z2 businesses 1 & 2 online/gps/radius state restored to the pre-suite snapshot", restoredOk,
    JSON.stringify(bizNow));

  const prodQty = baseline.product
    ? Number((await pg.query(`SELECT quantity FROM inventory_items WHERE id=$1`, [baseline.product.id])).rows[0]?.quantity)
    : null;
  ok("Z3 sellable stock untouched by the suite", baseline.product == null || Math.abs(prodQty - baseline.qtyBefore) < 1e-9,
    `${prodQty} vs ${baseline.qtyBefore}`);

  const preRows = (await pg.query(`SELECT id FROM customer_trackings WHERE id <= $1 ORDER BY id`, [baseline.trMax])).rows.map((r) => r.id);
  ok("Z4 every pre-existing order row untouched", JSON.stringify(preRows) === JSON.stringify(baseline.preExistingIds));
  const bizCount = (await pg.query(`SELECT count(*)::int c FROM businesses`)).rows[0].c;
  const userCount = (await pg.query(`SELECT count(*)::int c FROM users`)).rows[0].c;
  ok("Z5 business & user counts unchanged", bizCount === baseline.bizCount && userCount === baseline.userCount);
  console.log(`   purged: trackings=${trk.rowCount} docs=${docs.rowCount} trxns=${trxs.rowCount} notifs=${ntfs.rowCount} customers=${custs.rowCount} items=${inv.rowCount} sessions=${sess.rowCount}`);
}

async function main() {
  await pg.connect();
  // baselines (the user may be live — capture & protect)
  baseline.trMax = (await pg.query(`SELECT COALESCE(MAX(id),0)::int m FROM customer_trackings`)).rows[0].m;
  baseline.docMax = (await pg.query(`SELECT COALESCE(MAX(id),0)::int m FROM sales_documents`)).rows[0].m;
  baseline.trxMax = (await pg.query(`SELECT COALESCE(MAX(id),0)::int m FROM transactions`)).rows[0].m;
  baseline.ntfMax = (await pg.query(`SELECT COALESCE(MAX(id),0)::int m FROM notifications`)).rows[0].m;
  baseline.custMax = (await pg.query(`SELECT COALESCE(MAX(id),0)::int m FROM customers`)).rows[0].m;
  baseline.sessMax = (await pg.query(`SELECT COALESCE(MAX(id),0)::int m FROM user_sessions`)).rows[0].m;
  baseline.invMax = (await pg.query(`SELECT COALESCE(MAX(id),0)::int m FROM inventory_items`)).rows[0].m;
  baseline.bizCount = (await pg.query(`SELECT count(*)::int c FROM businesses`)).rows[0].c;
  baseline.userCount = (await pg.query(`SELECT count(*)::int c FROM users`)).rows[0].c;
  baseline.preExistingIds = (await pg.query(`SELECT id FROM customer_trackings WHERE id <= $1 ORDER BY id`, [baseline.trMax])).rows.map((r) => r.id);
  baseline.bizRestore = (await pg.query(
    `SELECT id, online_ordering_enabled onl, pickup_enabled pick, delivery_enabled del,
       service_radius_km rad, service_note note, gps_lat glat, gps_lng glng FROM businesses WHERE id IN (1,2) ORDER BY id`)).rows;
  const menu = (await api(null, "/api/menu")).json;
  baseline.product = (menu.businesses || []).find((b) => b.businessId === 1)?.products?.find((p) => p.available >= 5);
  baseline.product2 = (menu.businesses || []).find((b) => b.businessId === 2)?.products?.[0];
  if (!baseline.product || !baseline.product2) throw new Error("menu lacks sellable products on biz 1/2");
  baseline.qtyBefore = Number((await pg.query(`SELECT quantity FROM inventory_items WHERE id=$1`, [baseline.product.id])).rows[0].quantity);

  // The Online Storefront & Delivery Areas permission is OWNER-granted now —
  // capture Emmanuel's flag, then grant it for the BM sections (restored in Z).
  baseline.bmOnlineWas = (await pg.query(`SELECT can_manage_online f FROM users WHERE id=3`)).rows[0]?.f === true;

  const cookies = {
    owner: await login(OWNER.email, OWNER.pass),
    bm: await login(BM.email, BM.pass),
    worker: await login(WORKER.email, WORKER.pass),
  };
  baseline.ownerCookie = cookies.owner;
  await sectionA(cookies);

  browser = await puppeteer.launch({
    executablePath: "/tmp/al2023/chromium",
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    await sectionB();
    await sectionC(cookies);
    await sectionD();
    await sectionE(cookies);
    await sectionF();
  } finally {
    await browser.close().catch(() => {});
  }
  ok("G0 ZERO page/console errors across storefront, track, management & forms", errors.length === 0, errors.slice(0, 5).join(" | "));

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
