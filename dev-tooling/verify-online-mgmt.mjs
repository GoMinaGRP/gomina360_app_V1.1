/**
 * verify-online-mgmt.mjs — clean-start business isolation, percentage
 * discounts, pickup locations, per-branch service areas/localities,
 * active-only maps ordering, and owner-granted Online Storefront & Delivery
 * Areas permissions — end-to-end against the live app.
 *
 * A · New business starts CLEAN: provisioning seeds zero sample rows; the
 *     unit is invisible on the storefront; CRM writes are business-stamped.
 * B · Percentage discounts: /api/sales, quotations, tracking orders — the
 *     amount + final total auto-calculate, receipts carry "Discount 10%",
 *     the customer tracking page shows subtotal/discount/total.
 * C · Pickup locations: CRUD + owner-grant matrix (ungranted 403, granted
 *     BM own-scope ✓, cross-biz 403, worker 403), menu exposure, checkout
 *     requires a choice, snapshot survives removal (chain intact).
 * D · Service areas/localities: different per branch, grant matrix, menu
 *     exposure, server enforcement (in-area 200 / out-of-area 400 naming
 *     the areas), storefront near-me behaviour, name-only areas advisory,
 *     MAINTENANCE/INACTIVE units vanish from the menu (active-only).
 * E · Permissions & management UI: Users & Access toggle persists; BM
 *     lands on own Online panel with areas/pickups CRUD via UI; owner's
 *     help & MoMo save persists; revoke hides everything again.
 * F · Customer surfaces: checkout pickup chooser + MoMo destination hint;
 *     confirmation & /track show help/MoMo + named pickup point; "Delivers
 *     to:" area chips on the storefront.
 * Z · TEST rows purged (incl. the TEST unit via owner DELETE cascade),
 *     business surface restored, grant restored, stock restored,
 *     ZERO page/console errors gate.
 */
import { createRequire } from "module";
const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");
const { Client } = require("pg");

const BASE = "http://127.0.0.1:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pass: process.env.GOMINA_OWNER_PW || "Owner@GoMina26" };
const BM = { email: "emmanuel@gomina360.com", pass: "GoMina@User3" }; // BRANCH_MANAGER of biz 1
const WORKER = { email: "kwabena.mensah@gomina360.com", pass: "GoMina@User11" }; // WORKER of biz 1

const OSU = { lat: 5.56, lng: -0.1826 };            // TEST Osu area centre (biz1)
const INSIDE_OSU = { lat: 5.5604, lng: -0.1829 };   // ~45 m inside the area
const FAR_AWAY = { lat: 6.7, lng: -1.65 };          // outside every TEST zone

const results = [];
const baseline = {};
const pg = new Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });

const ok = (name, cond, extra = "") => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "✅" : "❌"} ${name}${cond ? "" : " — " + extra}`);
  return cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  await sleep(1500);
}
const centreClick = async (page, sel) => {
  await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (el) el.scrollIntoView({ block: "center" });
  }, sel);
  await sleep(160);
  await page.click(sel);
};
const shot = (page, name) => page.screenshot({ path: `/home/user/${name}.png` });

/* ═══ A · clean start + CRM isolation ═══ */
async function sectionA(cookies) {
  console.log("\n— A · new business starts completely clean —");
  const make = await api(cookies.owner, "/api/businesses", {
    method: "POST",
    body: JSON.stringify({
      name: "TEST Clean Hardware Depot",
      category: "Hardware Store",
      region: "Ashanti",
      district: "Kumasi Metropolitan",
      town: "TESTCLEAN",
      managerName: "TEST Clean Manager",
      contactPhone: "+233200009999",
      initialCapitalGhs: 7000,
      monthlyTargetRevenueGhs: 3000,
    }),
  });
  const biz = make.json?.business;
  ok("A1 owner creates TEST unit — provisioning is sample-free", make.status === 200 && biz?.id > 0 &&
    (make.json?.provisioned?.starterItems ?? 0) === 0 && (make.json?.provisioned?.starterKitCostGhs ?? 0) === 0,
    JSON.stringify({ starterItems: make.json?.provisioned?.starterItems, cost: make.json?.provisioned?.starterKitCostGhs }));
  baseline.testBizId = biz?.id;
  baseline.testBizCode = biz?.code;

  const counts = (
    await pg.query(
      `SELECT
        (SELECT count(*)::int FROM inventory_items WHERE business_id=$1) inv,
        (SELECT count(*)::int FROM customers WHERE business_id=$1) cust,
        (SELECT count(*)::int FROM transactions WHERE business_id=$1) trx,
        (SELECT count(*)::int FROM sales_documents WHERE business_id=$1) docs,
        (SELECT count(*)::int FROM assets WHERE business_id=$1) assets,
        (SELECT count(*)::int FROM employees WHERE business_id=$1) emps,
        (SELECT count(*)::int FROM service_areas WHERE business_id=$1) areas,
        (SELECT count(*)::int FROM pickup_locations WHERE business_id=$1) picks,
        (SELECT COALESCE((SELECT expenses_ghs FROM business_metrics WHERE business_id=$1), -1)) expenses,
        (SELECT count(*)::int FROM checklist_templates WHERE business_id=$1) tpls`,
      [baseline.testBizId],
    )
  ).rows[0];
  ok("A2 zero inventory / customers / finance / assets / employees / areas / pickups for the new unit",
    counts.inv === 0 && counts.cust === 0 && counts.trx === 0 && counts.docs === 0 &&
    counts.assets === 0 && counts.emps === 0 && counts.areas === 0 && counts.picks === 0,
    JSON.stringify(counts));
  ok("A2b metrics are zero-based (no sample kit cost folded in)", Number(counts.expenses) === 0, `expenses=${counts.expenses}`);
  ok("A2c operational checklist templates still provision (config, not records)", counts.tpls > 0, `tpls=${counts.tpls}`);

  const menu = (await api(null, "/api/menu")).json;
  ok("A3 clean unit does NOT appear on the customer storefront (nothing to sell yet)",
    !(menu.businesses || []).some((b) => b.businessId === baseline.testBizId));

  // CRM isolation write-paths
  const scoped = await api(cookies.owner, "/api/enterprise", {
    method: "POST",
    body: JSON.stringify({ entityType: "customer", data: { name: "TEST Clean Customer", phone: "+233555010101", businessId: baseline.testBizId } }),
  });
  const scopedId = scoped.json?.item?.id;
  ok("A4 customer created through the module lands stamped to its business", scoped.status === 200 && scopedId > 0,
    JSON.stringify({ status: scoped.status }));
  baseline.orphanCustId = scopedId || null; // rides away with the TEST unit delete
  const scopeRow = (await pg.query(`SELECT business_id b FROM customers WHERE id=$1`, [scopedId || 0])).rows[0];
  ok("A4b the customer row carries the unit's business_id (never NULL)", scopeRow?.b === baseline.testBizId, `b=${scopeRow?.b}`);

  const missing = await api(cookies.owner, "/api/enterprise", {
    method: "POST",
    body: JSON.stringify({ entityType: "customer", data: { name: "TEST Orphan Customer", phone: "+233555020202" } }),
  });
  ok("A5 a customer with NO business is refused (isolation enforced), not made group-shared",
    missing.status === 400 && /business/i.test(missing.json?.error || ""), `${missing.status} ${missing.json?.error || ""}`);

  // sale-stamped CRM
  const prod = baseline.product;
  const sale = await api(cookies.owner, "/api/sales", {
    method: "POST",
    body: JSON.stringify({
      businessId: 1,
      customerName: "TEST Discount Buyer",
      customerPhone: "0555030303",
      paymentMethod: "CASH",
      cartItems: [{ inventoryId: prod.id, sku: prod.sku, name: prod.name, quantity: 4, sellingPrice: prod.price, originalPrice: prod.price }],
      discountPercent: 10,
      createdByUserId: 1, createdByName: "OWNER", createdByRole: "OWNER",
    }),
  });
  ok("A6 sale with TEST buyer succeeds", sale.status === 200 && sale.json?.success === true, `${sale.status} ${sale.json?.error || ""}`);
  baseline.saleDocId = sale.json?.receipt?.id ?? null;
  const custRow = (
    await pg.query(`SELECT business_id b FROM customers WHERE id>$1 AND name='TEST Discount Buyer' ORDER BY id DESC LIMIT 1`, [baseline.custMax])
  ).rows[0];
  ok("A7 sale-created CRM customer is stamped to the selling business (not group-shared)", custRow?.b === 1, `b=${custRow?.b}`);
}

/* ═══ B · percentage discounts ═══ */
async function sectionB(cookies) {
  console.log("\n— B · percentage discounts everywhere —");
  const prod = baseline.product;
  const subtotal = 4 * prod.price;
  const expectAmt = Math.round(subtotal * 0.1 * 100) / 100;

  const doc = (
    await pg.query(`SELECT discount_percent pct, discount_ghs amt, subtotal_ghs sub, total_ghs tot FROM sales_documents WHERE id=$1`, [baseline.saleDocId || 0])
  ).rows[0];
  ok("B1 sale receipt stores 10% AND the auto-calculated amount",
    doc && Number(doc.pct) === 10 && Math.abs(Number(doc.amt) - expectAmt) < 0.01,
    JSON.stringify(doc || {}));
  ok("B1b receipt total = subtotal − discount amount",
    doc && Math.abs(Number(doc.tot) - (Number(doc.sub) - Number(doc.amt))) < 0.01,
    `tot=${doc?.tot} sub=${doc?.sub} amt=${doc?.amt}`);
  const trx = (
    await pg.query(`SELECT description d FROM transactions WHERE id>$1 AND description LIKE '%TEST Discount Buyer%' ORDER BY id DESC LIMIT 1`, [baseline.trxMax])
  ).rows[0];
  ok("B2 finance ledger entry narrates the 10% discount", trx && /10% discount/.test(trx.d), trx?.d?.slice(0, 120) || "missing");

  const quote = await api(cookies.owner, "/api/sales-documents", {
    method: "POST",
    body: JSON.stringify({
      documentType: "QUOTATION", businessId: 1, customerName: "TEST Quote Customer",
      lineItems: [{ description: "TEST Quote Line", quantity: 10, unitPrice: 20 }],
      discountPercent: 15, createdByUserId: 1, createdByName: "OWNER",
    }),
  });
  const qdoc = quote.json?.document;
  ok("B3 quotation with 15% — amount & final total auto-calculated",
    quote.status === 200 && Number(qdoc?.discountPercent) === 15 &&
    Math.abs(Number(qdoc?.discountGhs) - 30) < 0.01 && Math.abs(Number(qdoc?.totalGhs) - 170) < 0.01,
    JSON.stringify({ pct: qdoc?.discountPercent, amt: qdoc?.discountGhs, tot: qdoc?.totalGhs }));

  const legacy = await api(cookies.owner, "/api/sales-documents", {
    method: "POST",
    body: JSON.stringify({
      documentType: "QUOTATION", businessId: 1, customerName: "TEST Legacy Customer",
      lineItems: [{ description: "TEST Legacy Line", quantity: 2, unitPrice: 50 }],
      discountGhs: 25, createdByUserId: 1, createdByName: "OWNER",
    }),
  });
  ok("B4 flat GH₵ discount still works and back-derives the stored percent",
    legacy.status === 200 && Math.abs(Number(legacy.json?.document?.discountPercent) - 25) < 0.01,
    `pct=${legacy.json?.document?.discountPercent}`);

  for (const bad of [-5, 150]) {
    const r = await api(cookies.owner, "/api/sales-documents", {
      method: "POST",
      body: JSON.stringify({ documentType: "QUOTATION", businessId: 1, customerName: "TEST Bad", lineItems: [{ description: "x", quantity: 1, unitPrice: 1 }], discountPercent: bad, createdByName: "OWNER" }),
    });
    ok(`B5 percent ${bad} refused (400)`, r.status === 400, `${r.status}`);
  }

  // staff tracking order with a discount — public payload mirrors it
  const track = await api(cookies.owner, "/api/tracking", {
    method: "POST",
    body: JSON.stringify({
      action: "CREATE", businessId: 1, customerName: "TEST Tracked Discount",
      items: [{ description: "TEST Tracked Line", quantity: 3, unitPrice: 25 }],
      discountPercent: `20`,
    }),
  });
  baseline.discTrackCode = track.json?.tracking?.trackingCode;
  const trow = (
    await pg.query(`SELECT discount_percent pct, discount_ghs amt, total_ghs tot FROM customer_trackings WHERE tracking_code=$1`, [baseline.discTrackCode || ""])
  ).rows[0];
  ok("B6 staff order carries 20% + auto amount + net total",
    track.status === 200 && Number(trow?.pct) === 20 && Math.abs(Number(trow?.amt) - 15) < 0.01 && Math.abs(Number(trow?.tot) - 60) < 0.01,
    JSON.stringify({ status: track.status, ...trow }));
  const pub = (await api(null, `/api/track?code=${encodeURIComponent(baseline.discTrackCode || "")}`)).json?.tracking;
  ok("B7 public tracking payload shows subtotal + discount to the customer",
    pub && Number(pub.discountPercent) === 20 && Number(pub.discountGhs) === 15 && Number(pub.subtotalGhs) === 75,
    JSON.stringify({ pct: pub?.discountPercent, amt: pub?.discountGhs, sub: pub?.subtotalGhs }));
}

/* ═══ C · pickup locations ═══ */
async function sectionC(cookies) {
  console.log("\n— C · pickup locations: CRUD + authorization + checkout —");
  const add = async (cookie, body) =>
    api(cookie, "/api/service-areas?kind=pickups", { method: "POST", body: JSON.stringify(body) });

  const p1 = await add(cookies.owner, {
    businessId: 1, name: "TEST Spintex Depot", address: "Spintex Road, near the shell station",
    lat: 5.6038, lng: -0.1871, instructions: "Ask for the TEST blue gate", contactPhone: "+233555040404",
  });
  baseline.pick1 = p1.json?.pickup?.id;
  ok("C1 owner adds a pickup point with a map pin + instructions", p1.status === 200 && baseline.pick1 > 0, `${p1.status} ${p1.json?.error || ""}`);
  const p2 = await add(cookies.owner, { businessId: 1, name: "TEST Osu Shopfront", address: "Oxford Street" });
  baseline.pick2 = p2.json?.pickup?.id;
  ok("C1b second pickup point (address-only) added", p2.status === 200 && baseline.pick2 > 0);

  // Grant matrix — Emmanuel currently has NO grant (section A/B changed nothing).
  const denied = await add(cookies.bm, { businessId: 1, name: "TEST BM Forbidden Point" });
  ok("C2 UNGRANTED manager is refused (403) with a pointer to Permissions",
    denied.status === 403 && /Users & Access|Online storefront/i.test(denied.json?.error || ""), `${denied.status} ${denied.json?.error || ""}`);
  const workerTry = await add(cookies.worker, { businessId: 1, name: "TEST Worker Forbidden" });
  ok("C2b worker is refused (403)", workerTry.status === 403, `${workerTry.status}`);

  await api(cookies.owner, "/api/users", { method: "PATCH", body: JSON.stringify({ userId: 3, canManageOnline: true }) });
  const bmOwn = await add(cookies.bm, { businessId: 1, name: "TEST BM Tema Point", address: "Tema Comm 1" });
  baseline.pick3 = bmOwn.json?.pickup?.id;
  ok("C3 granted BM manages pickup points on his own branch", bmOwn.status === 200 && baseline.pick3 > 0, `${bmOwn.status} ${bmOwn.json?.error || ""}`);
  const bmCross = await add(cookies.bm, { businessId: 2, name: "TEST BM Cross Point" });
  ok("C3b …but NOT on another branch (403)", bmCross.status === 403, `${bmCross.status}`);

  const badName = await add(cookies.owner, { businessId: 1, name: "T" });
  const badGps = await add(cookies.owner, { businessId: 1, name: "TEST Bad Gps", lat: 95, lng: 2 });
  const halfGps = await add(cookies.owner, { businessId: 1, name: "TEST Half Gps", lat: 5.6 });
  ok("C4 validation: short name / out-of-range GPS / half pair all 400",
    badName.status === 400 && badGps.status === 400 && halfGps.status === 400,
    `${badName.status}/${badGps.status}/${halfGps.status}`);

  const edit = await api(cookies.bm, "/api/service-areas?kind=pickups", {
    method: "PATCH", body: JSON.stringify({ id: baseline.pick3, address: "Tema Community 1, Block B", active: true }),
  });
  ok("C5 granted BM edits his branch's point", edit.status === 200 && /Block B/.test(edit.json?.pickup?.address || ""), `${edit.status}`);

  const menu1 = ((await api(null, "/api/menu")).json.businesses || []).find((b) => b.businessId === 1);
  const menuNames = (menu1?.pickupLocations || []).map((p) => p.name);
  ok("C6 storefront menu serves the active pickup points (never staff data)",
    menuNames.includes("TEST Spintex Depot") && menuNames.includes("TEST BM Tema Point") && menuNames.includes("TEST Osu Shopfront"),
    menuNames.join("|"));
  await api(cookies.owner, "/api/service-areas?kind=pickups", { method: "PATCH", body: JSON.stringify({ id: baseline.pick2, active: false }) });
  const menu1b = ((await api(null, "/api/menu")).json.businesses || []).find((b) => b.businessId === 1);
  ok("C6b switched-off point disappears from the customer menu immediately",
    !(menu1b?.pickupLocations || []).some((p) => p.name === "TEST Osu Shopfront"));

  // checkout requires the choice, then snapshots it
  const noChoice = await api(null, "/api/order", {
    method: "POST",
    body: JSON.stringify({
      businessId: 1, customerName: "TEST Pickup Chooser", customerPhone: "0555050505",
      fulfillmentType: "PICKUP", items: [{ inventoryId: baseline.product.id, quantity: 1 }],
    }),
  });
  ok("C7 PICKUP checkout without a chosen point is refused (400) and explains",
    noChoice.status === 400 && /collect|pickup/i.test(noChoice.json?.error || ""), `${noChoice.status} ${noChoice.json?.error || ""}`);
  const withChoice = await api(null, "/api/order", {
    method: "POST",
    body: JSON.stringify({
      businessId: 1, customerName: "TEST Pickup Chooser", customerPhone: "0555050505",
      fulfillmentType: "PICKUP", pickupLocationId: baseline.pick1,
      items: [{ inventoryId: baseline.product.id, quantity: 1 }],
    }),
  });
  baseline.pickOrderCode = withChoice.json?.trackingCode;
  ok("C8 order with a chosen point lands; snapshot stored on the chain",
    withChoice.status === 200 && /^GM-/.test(baseline.pickOrderCode || ""), `${withChoice.status} ${withChoice.json?.error || ""}`);
  const snap = (
    await pg.query(`SELECT pickup_location_id pid, pickup_location_name pname, pickup_lat plat FROM customer_trackings WHERE tracking_code=$1`, [baseline.pickOrderCode || ""])
  ).rows[0];
  ok("C8b the snapshot carries id + name + map point", snap?.pid === baseline.pick1 && /Spintex Depot/.test(snap?.pname || "") && snap?.plat != null, JSON.stringify(snap || {}));

  const pub = (await api(null, `/api/track?code=${encodeURIComponent(baseline.pickOrderCode || "")}`)).json?.tracking;
  ok("C9 public tracking names the pickup point (with directions link)",
    pub?.pickupLocation?.name === "TEST Spintex Depot" && /blue gate/.test(pub?.pickupLocation?.address || "") === false && !!pub?.pickupLocation?.mapLink,
    JSON.stringify(pub?.pickupLocation || {}));
  // (help/MoMo on the tracking payload is asserted in F6 after E8 sets the contacts.)
  const crmBuyer = (
    await pg.query(`SELECT business_id bid FROM customers WHERE name=$1 ORDER BY id DESC LIMIT 1`, ["TEST Pickup Chooser"])
  ).rows[0];
  ok("C9c storefront buyer's CRM record is stamped to the selling business (isolation)",
    crmBuyer?.bid === 1, JSON.stringify(crmBuyer || {}));

  // removal keeps history
  const del = await api(cookies.bm, "/api/service-areas?kind=pickups", { method: "DELETE", body: JSON.stringify({ id: baseline.pick3 }) });
  const stillThere = (
    await pg.query(`SELECT pickup_location_name pname FROM customer_trackings WHERE tracking_code=$1`, [baseline.pickOrderCode || ""])
  ).rows[0];
  ok("C10 BM removes his point; past order keeps its snapshot (chain intact)",
    del.status === 200 && /Spintex Depot/.test(stillThere?.pname || ""), `${del.status}`);
}

/* ═══ D · service areas / localities + active-only maps ordering ═══ */
async function sectionD(cookies) {
  console.log("\n— D · service areas/localities per branch + active-only —");
  const add = (cookie, body) => api(cookie, "/api/service-areas", { method: "POST", body: JSON.stringify(body) });

  const a1 = await add(cookies.owner, {
    businessId: 1, name: "TEST Osu", centerLat: OSU.lat, centerLng: OSU.lng, radiusKm: 2, note: "Same-day before 2pm",
  });
  baseline.area1 = a1.json?.area?.id;
  ok("D1 owner defines a geocoded locality for biz 1", a1.status === 200 && baseline.area1 > 0, `${a1.status} ${a1.json?.error || ""}`);
  const a2 = await add(cookies.owner, { businessId: 1, name: "TEST Tema (name only)" });
  baseline.area2 = a2.json?.area?.id;
  ok("D1b name-only advisory area coexists", a2.status === 200 && baseline.area2 > 0);

  const bmDenied = await add(cookies.bm, { businessId: 1, name: "TEST Should Still Work Area" });
  ok("D2 granted BM (from section C) manages areas on own branch too",
    bmDenied.status === 200 && bmDenied.json?.area?.id > 0, `${bmDenied.status} ${bmDenied.json?.error || ""}`);
  baseline.area3 = bmDenied.json?.area?.id;
  const bmCrossArea = await add(cookies.bm, { businessId: 2, name: "TEST Cross Area" });
  ok("D2b …but not on another branch (403)", bmCrossArea.status === 403, `${bmCrossArea.status}`);
  const workerArea = await add(cookies.worker, { businessId: 1, name: "TEST Worker Area" });
  ok("D2c worker refused (403)", workerArea.status === 403, `${workerArea.status}`);

  const kumasi = await api(cookies.owner, "/api/service-areas", {
    method: "POST", body: JSON.stringify({ businessId: 2, name: "TEST Kumasi Central", centerLat: 6.6885, centerLng: -1.6244, radiusKm: 4 }),
  });
  baseline.area4 = kumasi.json?.area?.id;
  ok("D3 different branch defines a DIFFERENT area set", kumasi.status === 200 && baseline.area4 > 0);

  const menu = (await api(null, "/api/menu")).json;
  const m1 = (menu.businesses || []).find((b) => b.businessId === 1);
  const m2 = (menu.businesses || []).find((b) => b.businessId === 2);
  const names1 = (m1?.serviceAreas || []).map((a) => a.name);
  ok("D4 menu serves each unit's own localities",
    names1.includes("TEST Osu") && names1.includes("TEST Tema (name only)") && (m2?.serviceAreas || []).some((a) => a.name === "TEST Kumasi Central"),
    names1.join("|"));
  await api(cookies.owner, "/api/service-areas", { method: "PATCH", body: JSON.stringify({ id: baseline.area3, active: false }) });
  const m1b = ((await api(null, "/api/menu")).json.businesses || []).find((b) => b.businessId === 1);
  ok("D4b inactive area disappears from the customer menu", !(m1b?.serviceAreas || []).some((a) => a.name === "TEST Should Still Work Area"));

  // server enforcement: in-area OK / out of every zone refused, naming areas
  const pinOrder = (lat, lng) =>
    api(null, "/api/order", {
      method: "POST",
      body: JSON.stringify({
        businessId: 1, customerName: "TEST Area Rider", customerPhone: "0555060606",
        fulfillmentType: "DELIVERY", destinationAddress: "TEST delivery address",
        deliveryLat: lat, deliveryLng: lng,
        items: [{ inventoryId: baseline.product.id, quantity: 1 }],
      }),
    });
  const inside = await pinOrder(INSIDE_OSU.lat, INSIDE_OSU.lng);
  baseline.areaOrderCode = inside.json?.trackingCode;
  ok("D5 delivery pinned INSIDE the Osu locality is accepted", inside.status === 200 && /^GM-/.test(baseline.areaOrderCode || ""), `${inside.status} ${inside.json?.error || ""}`);
  const outside = await pinOrder(FAR_AWAY.lat, FAR_AWAY.lng);
  ok("D6 pinned OUTSIDE every locality → 400 explaining + naming the areas",
    outside.status === 400 && /outside/.test(outside.json?.error || "") && /TEST Osu/.test(outside.json?.error || ""),
    `${outside.status} ${outside.json?.error || ""}`);

  // active-only storefront
  const toMaint = await api(cookies.owner, "/api/businesses/2", { method: "PATCH", body: JSON.stringify({ status: "MAINTENANCE" }) });
  const menuAfter = (await api(null, "/api/menu")).json;
  ok("D7 MAINTENANCE unit vanishes from the customer storefront",
    toMaint.status === 200 && !(menuAfter.businesses || []).some((b) => b.businessId === 2), `patch=${toMaint.status}`);
  const offOrder = await api(null, "/api/order", {
    method: "POST",
    body: JSON.stringify({ businessId: 2, customerName: "TEST Nobody", customerPhone: "0555070707", fulfillmentType: "PICKUP", items: [{ inventoryId: 3, quantity: 1 }] }),
  });
  ok("D7b checkout refuses it too (404)", offOrder.status === 404, `${offOrder.status}`);
  const backOn = await api(cookies.owner, "/api/businesses/2", { method: "PATCH", body: JSON.stringify({ status: "ACTIVE" }) });
  const menuBack = (await api(null, "/api/menu")).json;
  ok("D7c restoring ACTIVE brings the unit straight back", backOn.status === 200 && (menuBack.businesses || []).some((b) => b.businessId === 2));
}

/* ═══ E · permissions + management UI + owner contacts ═══ */
async function sectionE(cookies) {
  console.log("\n— E · Users & Access permissions + Online management UI —");

  // E1: the owner sees the new permission in Users & Access and it persists.
  const { ctx, page } = await newPage("E:owner-access");
  await loginUi(page, OWNER);
  const opened = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="open-user-access"]')
      || [...document.querySelectorAll("button, a")].find((e) => /Users & Access/i.test(e.textContent || ""));
    if (btn) { btn.click(); return true; }
    return false;
  });
  await page.waitForSelector('[data-testid="user-access-console"]', { timeout: 15000 }).catch(() => {});
  const editClicked = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="user-edit-3"]');
    if (b) { b.click(); return true; }
    return false;
  });
  await page.waitForSelector('[data-testid="user-edit-form"]', { timeout: 15000 }).catch(() => {});
  await page.waitForSelector('[data-testid="perm-online"]', { timeout: 10000 }).catch(() => {});
  const toggle = await page.$('[data-testid="perm-online"]');
  ok("E1 owner sees the “Online storefront & delivery areas” permission toggle",
    opened && editClicked && !!toggle, `opened=${opened} edit=${editClicked} toggle=${!!toggle}`);
  if (toggle) {
    const before = await page.$eval('[data-testid="perm-online"]', (el) => el.getAttribute("aria-checked") || el.className);
    await centreClick(page, '[data-testid="perm-online"]');
    await sleep(350);
    const after = await page.$eval('[data-testid="perm-online"]', (el) => el.getAttribute("aria-checked") || el.className);
    ok("E1b the toggle flips", before !== after);
    // leave it: grant PERSISTed via the form save — find the user's current value instead.
  }
  await shot(page, "mgmt-1-permission-toggle");
  await ctx.close();

  // Grant is already live from section C (API); prove it persisted on the row.
  const flagRow = (await pg.query(`SELECT can_manage_online f FROM users WHERE id=3`)).rows[0];
  ok("E2 the grant persists on Emmanuel's account (DB of record)", flagRow?.f === true, `f=${flagRow?.f}`);

  // E3: BM lands on his own unit's Online panel; areas + pickups CRUD via UI.
  const { ctx: ctxB, page: pb } = await newPage("E:bm-panel", { width: 1440, height: 1000 });
  await loginUi(pb, BM);
  await pb.waitForSelector('[data-testid="user-menu-btn"]', { timeout: 30000 });
  await pb.click('[data-testid="user-menu-btn"]');
  await pb.waitForSelector('[data-testid="open-online-ordering"]', { timeout: 15000 }).catch(() => {});
  await pb.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => /open-online-ordering/.test(b.getAttribute("data-testid") || ""));
    btn?.click();
  });
  await pb.waitForSelector('[data-testid="mb-onl-root"]', { timeout: 20000 }).catch(() => {});
  const onlOpen = await pb.$('[data-testid="mb-onl-root"]');
  const hdr = await pb.evaluate(() => document.body.innerText.slice(0, 400));
  ok("E3 granted BM opens his branch's Online panel straight from the account menu",
    !!onlOpen && /Mina Akuafo Poultry Farm/.test(hdr), hdr.slice(0, 90).replace(/\n/g, " "));
  // BM's "All Units" list proves his scope: the Online action shows, while
  // edit/delete/reset (and logo) actions stay OWNER-only.
  await pb.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /All Units/i.test(x.textContent || ""));
    b?.click();
  });
  await pb.waitForFunction(() =>
    [...document.querySelectorAll("[data-testid^='manage-biz-online-']")].some((b) => b.offsetParent !== null),
    { timeout: 10000 }).catch(() => {});
  const scopedActions = await pb.evaluate(() => ({
    onlineBtns: [...document.querySelectorAll("[data-testid^='manage-biz-online-']")].filter((b) => b.offsetParent !== null).length,
    deleteBtns: [...document.querySelectorAll("[data-testid^='manage-biz-delete-']")].filter((b) => b.offsetParent !== null).length,
    editBtns: [...document.querySelectorAll("[data-testid^='manage-biz-edit-']")].filter((b) => b.offsetParent !== null).length,
    resetBtns: [...document.querySelectorAll("[data-testid^='manage-biz-reset-']")].filter((b) => b.offsetParent !== null).length,
    logoBtns: [...document.querySelectorAll("[data-testid^='manage-biz-logos-']")].filter((b) => b.offsetParent !== null).length,
  }));
  ok("E3b BM scope: Online actions only — delete/edit/reset/logos stay OWNER-only",
    scopedActions.onlineBtns >= 1 && scopedActions.deleteBtns === 0 && scopedActions.editBtns === 0 &&
    scopedActions.resetBtns === 0 && scopedActions.logoBtns === 0,
    JSON.stringify(scopedActions));
  // …and back into his own unit's Online panel for the CRUD checks below.
  await pb.evaluate(() => {
    const b = document.querySelector('[data-testid="manage-biz-online-POULTRY-01"]')
      || document.querySelector("[data-testid^='manage-biz-online-']");
    b?.click();
  });
  await pb.waitForSelector('[data-testid="mb-onl-root"]', { timeout: 15000 }).catch(() => {});

  const hasAreasUi = await pb.waitForSelector('[data-testid="mb-areas"]', { timeout: 15000 }).then(() => true).catch(() => false);
  const hasPickupsUi = await pb.waitForSelector('[data-testid="mb-pickups"]', { timeout: 10000 }).then(() => true).catch(() => false);
  ok("E4 panel shows the unit's Service areas + Pickup locations sections",
    hasAreasUi && hasPickupsUi, `areas=${hasAreasUi} pickups=${hasPickupsUi}`);

  await pb.type('[data-testid="mb-area-add-name"]', "TEST UI Area Dansoman");
  await pb.type('[data-testid="mb-area-add-radius"]', "4");
  await pb.type('[data-testid="mb-area-add-lat"]', "5.5479");
  await pb.type('[data-testid="mb-area-add-lng"]', "-0.2531");
  await centreClick(pb, '[data-testid="mb-area-add-btn"]');
  await pb.waitForFunction(() => {
    const rows = [...document.querySelectorAll("[data-testid^='mb-area-row-']")];
    return rows.some((r) => /Dansoman/.test(r.textContent || ""));
  }, { timeout: 12000 }).catch(() => {});
  const uiAreaRow = await pb.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-testid^='mb-area-row-']")];
    return rows.filter((r) => /Dansoman/.test(r.textContent || "")).map((r) => r.getAttribute("data-testid"));
  });
  ok("E5 BM adds a service area through the UI", uiAreaRow.length > 0, uiAreaRow.join(","));
  baseline.uiAreaId = Number((uiAreaRow[0] || "").replace("mb-area-row-", "")) || null;
  if (baseline.uiAreaId) {
    await centreClick(pb, `[data-testid="mb-area-toggle-${baseline.uiAreaId}"]`);
    await sleep(700);
    const off = (await pg.query(`SELECT active a FROM service_areas WHERE id=$1`, [baseline.uiAreaId])).rows[0]?.a;
    ok("E5b the Active/Off toggle writes through", off === false, `active=${off}`);
    await centreClick(pb, `[data-testid="mb-area-del-${baseline.uiAreaId}"]`);
    await sleep(900);
    const gone = (await pg.query(`SELECT count(*)::int c FROM service_areas WHERE id=$1`, [baseline.uiAreaId])).rows[0].c === 0;
    ok("E5c Remove deletes the area", gone);
    baseline.uiAreaId = null;
  }

  await pb.type('[data-testid="mb-pick-add-name"]', "TEST UI Point Kaneshie");
  await pb.type('[data-testid="mb-pick-add-addr"]', "Kaneshie Market Road");
  await centreClick(pb, '[data-testid="mb-pick-add-btn"]');
  await pb.waitForFunction(() => {
    const rows = [...document.querySelectorAll("[data-testid^='mb-pick-row-']")];
    return rows.some((r) => /Kaneshie/.test(r.textContent || ""));
  }, { timeout: 12000 }).catch(() => {});
  const uiPickRow = await pb.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-testid^='mb-pick-row-']")];
    return rows.filter((r) => /Kaneshie/.test(r.textContent || "")).map((r) => r.getAttribute("data-testid"));
  });
  ok("E6 BM adds a pickup point through the UI", uiPickRow.length > 0, uiPickRow.join(","));
  baseline.uiPickId = Number((uiPickRow[0] || "").replace("mb-pick-row-", "")) || null;
  await shot(pb, "mgmt-2-bm-areas-pickups");
  await ctxB.close();

  // E7: owner sets customer help + MoMo via the panel (saved with settings).
  const { ctx: ctxO, page: po } = await newPage("E:owner-panel", { width: 1440, height: 1000 });
  await loginUi(po, OWNER);
  await po.waitForSelector('[data-testid="user-menu-btn"]', { timeout: 30000 });
  await po.click('[data-testid="user-menu-btn"]');
  await po.waitForSelector('[data-testid="open-online-ordering"]', { timeout: 15000 }).catch(() => {});
  await po.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => /open-online-ordering/.test(b.getAttribute("data-testid") || ""));
    btn?.click();
  });
  await sleep(1200);
  // owner sees the LIST first — pick POULTRY-01's Online action
  await po.waitForSelector('[data-testid="manage-biz-online-POULTRY-01"]', { timeout: 15000 });
  await centreClick(po, '[data-testid="manage-biz-online-POULTRY-01"]');
  await po.waitForSelector('[data-testid="mb-onl-help"]', { timeout: 15000 });
  await po.type('[data-testid="mb-onl-help"]', "+233 24 100 2000");
  await po.type('[data-testid="mb-onl-momo"]', "059 411 2233");
  await po.type('[data-testid="mb-onl-momoname"]', "Mina Akuafo Poultry");
  const dirty = await po.$('[data-testid="mb-onl-dirty"]');
  ok("E7 editing contacts marks the panel dirty (unsaved badge)", !!dirty);
  await centreClick(po, '[data-testid="mb-onl-save"]');
  await sleep(1500);
  const dbRow = (
    await pg.query(`SELECT customer_help_phone h, momo_number n, momo_name m FROM businesses WHERE id=1`)
  ).rows[0];
  ok("E8 help line + MoMo number + payee name persist on the unit",
    dbRow?.h === "+233 24 100 2000" && dbRow?.n === "059 411 2233" && dbRow?.m === "Mina Akuafo Poultry",
    JSON.stringify(dbRow || {}));
  baseline.contactsSet = true;
  await shot(po, "mgmt-3-owner-contacts");
  await ctxO.close();

  // E9: revoke → surfaces disappear again.
  await api(cookies.owner, "/api/users", { method: "PATCH", body: JSON.stringify({ userId: 3, canManageOnline: false }) });
  const deniedAgain = await api(cookies.bm, "/api/service-areas?businessId=1");
  ok("E9 after revoke the BM loses API access immediately (403)", deniedAgain.status === 403, `${deniedAgain.status}`);
  const { ctx: ctxR, page: pr } = await newPage("E:bm-revoked");
  await loginUi(pr, BM);
  await pr.waitForSelector('[data-testid="user-menu-btn"]', { timeout: 30000 });
  await pr.click('[data-testid="user-menu-btn"]');
  await pr.waitForSelector('[data-testid="user-account-menu"]', { timeout: 15000 }).catch(() => {});
  await sleep(400);
  const entry = await pr.$('[data-testid="open-online-ordering"]');
  ok("E9b …and the account-menu entry is gone", !entry);
  await ctxR.close();
  // re-grant? NO — restore at Z to the ORIGINAL captured value (false today).
}

/* ═══ F · customer surfaces ═══ */
async function sectionF(cookies) {
  console.log("\n— F · customer surfaces: chooser, confirmation, tracking, chips —");
  const { ctx, page } = await newPage("F:storefront", { width: 1440, height: 1000 });
  await page.goto(`${BASE}/order?biz=1`, { waitUntil: "networkidle0", timeout: 60000 });
  await sleep(800);

  const chips = await page.$$eval("[data-testid^='oo-biz-areachip-']", (els) => els.map((e) => e.textContent || ""));
  ok("F1 storefront lists the branch's localities (“Delivers to:” chips)",
    chips.some((c) => /TEST Osu/.test(c)) && chips.some((c) => /TEST Tema/.test(c)), chips.join("|"));

  const momoDest = await page.$eval('[data-testid="oo-momo-dest"]', (el) => el.textContent || "").catch(() => null);
  ok("F2 MoMo destination shown in the payment card", !!momoDest && /059 411 2233/.test(momoDest), `${momoDest}`);

  // pick a product into the cart, then the pickup chooser appears
  const addBtn = await page.evaluate(() => {
    const btns = [...document.querySelectorAll("[data-testid^='oo-add-']")];
    if (btns[0]) { btns[0].click(); return true; }
    return false;
  });
  ok("F3 product added to the cart", addBtn);
  await sleep(500);
  await page.waitForSelector('[data-testid="oo-pickpoints"]', { timeout: 10000 });
  const points = await page.$$eval("[data-testid^='oo-pickpoint-']", (els) => els.map((e) => e.textContent || ""));
  ok("F4 checkout makes the customer choose a pickup point",
    points.some((t) => /TEST Spintex Depot/.test(t)) && points.some((t) => /TEST BM Tema Point|Kaneshie|Osu Shopfront/.test(t)),
    points.join(" | ").slice(0, 160));
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("[data-testid^='oo-pickpoint-']")].find((e) => /Spintex Depot/.test(e.textContent || ""));
    el?.click();
  });
  await page.type('[data-testid="oo-name"]', "TEST Chooser Customer");
  await page.type('[data-testid="oo-phone"]', "0555080808");
  await centreClick(page, '[data-testid="oo-place"]');
  await page.waitForSelector('[data-testid="oo-success"]', { timeout: 20000 });
  baseline.uiOrderCode = await page.$eval('[data-testid="oo-code"]', (el) => el.textContent?.trim());
  const pickLine = await page.$eval('[data-testid="oo-success-pickpoint"]', (el) => el.textContent || "").catch(() => null);
  const momo = await page.$eval('[data-testid="oo-success-momo"]', (el) => el.textContent || "").catch(() => null);
  const help = await page.$eval('[data-testid="oo-success-help"]', (el) => el.textContent || "").catch(() => null);
  ok("F5 confirmation names the pickup point",
    !!pickLine && /Spintex Depot/.test(pickLine), `${pickLine}`);
  ok("F5b confirmation shows the MoMo number + payee immediately",
    !!momo && /059 411 2233/.test(momo) && /Mina Akuafo/.test(momo), `${momo}`);
  ok("F5c confirmation shows the customer help line",
    !!help && /100 2000/.test(help), `${help}`);
  await shot(page, "mgmt-4-order-confirmation");

  // /track page mirror
  await page.goto(`${BASE}/track?code=${encodeURIComponent(baseline.uiOrderCode)}`, { waitUntil: "networkidle0", timeout: 60000 });
  await sleep(600);
  const tMomo = await page.$eval('[data-testid="track-momo"]', (el) => el.textContent || "").catch(() => null);
  const tHelp = await page.$eval('[data-testid="track-help"]', (el) => el.textContent || "").catch(() => null);
  const tPick = await page.$eval('[data-testid="track-pickpoint-name"]', (el) => el.textContent || "").catch(() => null);
  ok("F6 /track shows the MoMo payment destination",
    !!tMomo && /059 411 2233/.test(tMomo) && /Mina Akuafo/.test(tMomo), `${tMomo}`);
  ok("F6b /track shows the help line", !!tHelp && /100 2000/.test(tHelp), `${tHelp}`);
  ok("F6c /track names the chosen pickup point", !!tPick && /Spintex Depot/.test(tPick), `${tPick}`);
  const payCall = await page.$('[data-testid="track-payment-call"]');
  const payCallText = payCall ? await page.$eval('[data-testid="track-payment-call"]', (el) => el.textContent || "") .catch(() => null) : null;
  const payCallHref = payCall ? await page.$eval('[data-testid="track-payment-call"]', (el) => el.getAttribute("href") || "").catch(() => null) : null;
  ok("F6d Payment card shows tap-to-call for payment assistance / delivery support",
    !!payCall && /payment assistance or delivery support/i.test(payCallText || "") && /\+233 24 100 2000/.test(payCallText || "") &&
    !!payCallHref && payCallHref.startsWith("tel:+233241002000"),
    `${payCallHref} · ${(payCallText || "").slice(0, 70)}`);
  const staffRow = ((await api(cookies.owner, "/api/tracking")).json?.trackings || []).find((r) => r.trackingCode === baseline.uiOrderCode);
  ok("F7 staff tracking register carries the unit's business telephone (for payment support)",
    staffRow?.businessHelpPhone === "+233 24 100 2000", `${staffRow?.businessHelpPhone}`);
  await shot(page, "mgmt-5-track-contacts");
  await ctx.close();
}

/* ═══ Z · cleanup & forensics ═══ */
async function cleanup(cookies) {
  console.log("\n— Z · cleanup & forensics —");
  // TEST unit removed through the owner cascade (takes areas/pickups/customers)
  if (baseline.testBizId) {
    const del = await api(cookies.owner, `/api/businesses/${baseline.testBizId}`, {
      method: "DELETE",
      body: JSON.stringify({ confirmCode: baseline.testBizCode }),
    });
    const left = (
      await pg.query(
        `SELECT (SELECT count(*)::int FROM service_areas WHERE business_id=$1) a,
           (SELECT count(*)::int FROM pickup_locations WHERE business_id=$1) p,
           (SELECT count(*)::int FROM customers WHERE business_id=$1) c,
           (SELECT count(*)::int FROM businesses WHERE id=$1) b`,
        [baseline.testBizId],
      )
    ).rows[0];
    ok("Z1 TEST unit deleted via owner cascade — areas/pickups/customers/unit all gone",
      del.status === 200 && left.a === 0 && left.p === 0 && left.c === 0 && left.b === 0,
      `${del.status} ${JSON.stringify(left)}`);
  }
  // TEST areas / points on real units
  await pg.query(`DELETE FROM service_areas WHERE name LIKE 'TEST%' RETURNING id`).then((r) => (baseline._aa = r.rowCount));
  await pg.query(`DELETE FROM pickup_locations WHERE name LIKE 'TEST%' RETURNING id`).then((r) => (baseline._pp = r.rowCount));
  // TEST orders / docs / trxns / customers / sessions / notifs (same guards as the other suites)
  const tr = await pg.query(`DELETE FROM customer_trackings WHERE id > $1 RETURNING id`, [baseline.trMax]);
  const dc = await pg.query(`DELETE FROM sales_documents WHERE id > $1 AND customer_name LIKE 'TEST%' RETURNING id`, [baseline.docMax]);
  const tx = await pg.query(
    `DELETE FROM transactions WHERE id > $1 AND (category='Online Order Sale' OR category='Inventory Sale' OR description LIKE '%TEST%') RETURNING id`,
    [baseline.trxMax],
  );
  const cu = await pg.query(`DELETE FROM customers WHERE id > $1 AND name LIKE 'TEST%' RETURNING id`, [baseline.custMax]);
  const nt = await pg.query(
    `DELETE FROM notifications WHERE id > $1 AND type IN ('ONLINE_ORDER_RECEIVED','ORDER_TRACKING_STATUS') RETURNING id`,
    [baseline.ntfMax],
  );
  const ss = await pg.query(`DELETE FROM user_sessions WHERE id > $1 RETURNING id`, [baseline.sessMax]);
  console.log(`   purged: trackings=${tr.rowCount} docs=${dc.rowCount} trxns=${tx.rowCount} customers=${cu.rowCount} notifs=${nt.rowCount} sessions=${ss.rowCount} areas=${baseline._aa} pickups=${baseline._pp}`);

  // business 1 & 2 surface restored exactly (incl. contacts + status)
  for (const b of baseline.bizRestore) {
    await pg.query(
      `UPDATE businesses SET online_ordering_enabled=$2, pickup_enabled=$3, delivery_enabled=$4,
         service_radius_km=$5::double precision, service_note=$6,
         customer_help_phone=$7, momo_number=$8, momo_name=$9, status=$10
       WHERE id=$1`,
      [b.id, b.onl, b.pick, b.del, b.rad, b.note, b.help, b.momo, b.momoname, b.status],
    );
  }
  // grant restored
  await api(cookies.owner, "/api/users", { method: "PATCH", body: JSON.stringify({ userId: 3, canManageOnline: baseline.bmOnlineWas }) });
  // stock restored (only B-section sale touched it)
  if (baseline.product) {
    await pg.query(`UPDATE inventory_items SET quantity=$2::double precision WHERE id=$1`, [baseline.product.id, baseline.qtyBefore]);
  }

  const grants = (await pg.query(`SELECT can_manage_online f FROM users WHERE id=3`)).rows[0]?.f === true;
  ok("Z2 grant restored to its original state", grants === baseline.bmOnlineWas, `f=${grants}`);
  const modified = (
    await pg.query(
      `SELECT count(*)::int c FROM businesses WHERE id IN (1,2) AND (
         status IS DISTINCT FROM 'ACTIVE'
         OR customer_help_phone IS NOT NULL OR momo_number IS NOT NULL OR momo_name IS NOT NULL
         OR service_note IS NOT NULL OR service_radius_km IS NOT NULL
       )`,
    )
  ).rows[0].c;
  const expected = baseline.bizRestore.filter(
    (b) => b.status !== "ACTIVE" || b.help != null || b.momo != null || b.momoname != null || b.note != null || b.rad != null,
  ).length;
  ok("Z3 business surfaces back to baseline", modified === expected, `${modified} vs ${expected}`);
  const leftovers = (
    await pg.query(
      `SELECT (SELECT count(*)::int FROM service_areas WHERE name LIKE 'TEST%') +
              (SELECT count(*)::int FROM pickup_locations WHERE name LIKE 'TEST%') +
              (SELECT count(*)::int FROM customers WHERE name LIKE 'TEST%') +
              (SELECT count(*)::int FROM customer_trackings WHERE customer_name LIKE 'TEST%') c`,
    )
  ).rows[0].c;
  ok("Z4 zero TEST leftovers anywhere", leftovers === 0, `left=${leftovers}`);
  const counts = (
    await pg.query(`SELECT (SELECT count(*)::int FROM businesses) b, (SELECT count(*)::int FROM users) u`)
  ).rows[0];
  ok("Z5 business & user counts unchanged", counts.b === baseline.bizCount && counts.u === baseline.userCount,
    `${counts.b}/${baseline.bizCount} · ${counts.u}/${baseline.userCount}`);
  if (baseline.product) {
    const q = Number((await pg.query(`SELECT quantity FROM inventory_items WHERE id=$1`, [baseline.product.id])).rows[0]?.quantity);
    ok("Z6 the sold product's stock is restored exactly", Math.abs(q - baseline.qtyBefore) < 1e-9, `${q} vs ${baseline.qtyBefore}`);
  }
  ok("G0 ZERO page/console errors across all flows", errors.length === 0, errors.slice(0, 3).join(" || "));
}

async function main() {
  await pg.connect();
  baseline.trMax = (await pg.query(`SELECT COALESCE(MAX(id),0)::int m FROM customer_trackings`)).rows[0].m;
  baseline.docMax = (await pg.query(`SELECT COALESCE(MAX(id),0)::int m FROM sales_documents`)).rows[0].m;
  baseline.trxMax = (await pg.query(`SELECT COALESCE(MAX(id),0)::int m FROM transactions`)).rows[0].m;
  baseline.ntfMax = (await pg.query(`SELECT COALESCE(MAX(id),0)::int m FROM notifications`)).rows[0].m;
  baseline.custMax = (await pg.query(`SELECT COALESCE(MAX(id),0)::int m FROM customers`)).rows[0].m;
  baseline.sessMax = (await pg.query(`SELECT COALESCE(MAX(id),0)::int m FROM user_sessions`)).rows[0].m;
  baseline.bizCount = (await pg.query(`SELECT count(*)::int c FROM businesses`)).rows[0].c;
  baseline.userCount = (await pg.query(`SELECT count(*)::int c FROM users`)).rows[0].c;
  baseline.bizRestore = (
    await pg.query(
      `SELECT id, online_ordering_enabled onl, pickup_enabled pick, delivery_enabled del,
         service_radius_km rad, service_note note, customer_help_phone help, momo_number momo,
         momo_name momoname, status
       FROM businesses WHERE id IN (1,2) ORDER BY id`,
    )
  ).rows;
  baseline.bmOnlineWas = (await pg.query(`SELECT can_manage_online f FROM users WHERE id=3`)).rows[0]?.f === true;

  const menu = (await api(null, "/api/menu")).json;
  baseline.product = (menu.businesses || []).find((b) => b.businessId === 1)?.products?.find((p) => p.available >= 5);
  if (!baseline.product) throw new Error("menu lacks a sellable product on biz 1");
  baseline.qtyBefore = Number((await pg.query(`SELECT quantity FROM inventory_items WHERE id=$1`, [baseline.product.id])).rows[0].quantity);

  const cookies = {
    owner: await login(OWNER.email, OWNER.pass),
    bm: await login(BM.email, BM.pass),
    worker: await login(WORKER.email, WORKER.pass),
  };

  // determinism: C2 expects Emmanuel UNGRANTED at the start (Z restores the original flag).
  await api(cookies.owner, "/api/users", { method: "PATCH", body: JSON.stringify({ userId: 3, canManageOnline: false }) });

  try {
    await sectionA(cookies);
    await sectionB(cookies);
    await sectionC(cookies);
    await sectionD(cookies);

    browser = await puppeteer.launch({
      executablePath: "/tmp/al2023/chromium",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      defaultViewport: { width: 1440, height: 960 },
    });
    await sectionE(cookies);
    await sectionF(cookies);
  } finally {
    await cleanup(cookies);
    if (browser) await browser.close().catch(() => {});
    await pg.end();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n══ ${results.length - failed.length}/${results.length} checks passed ══`);
  if (failed.length > 0) {
    console.log("FAILED:");
    failed.forEach((f) => console.log(`  ✗ ${f.name}`));
    process.exit(1);
  }
}

main().catch(async (e) => {
  console.error("SUITE CRASHED:", e);
  try { await pg.end(); } catch {}
  process.exit(2);
});
