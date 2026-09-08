/**
 * verify-permissions-storefront.mjs — New Branch/Unit permission, exact-10
 * customer phone, drag-the-map delivery pin & storefront How-To E2E.
 *
 *   N · "New Branch/Unit" permission: non-grantee 403 → owner grants (API)
 *       → grantee creates a unit + auto-grant → owner revokes → 403 again.
 *       Escalation guard (grantee cannot re-grant himself). Owner console UI
 *       toggle round-trips the flag; GM dashboard button appears/disappears
 *       with the grant.
 *   P · Customer Number = EXACTLY 10 digits: API 400s for 9/11 digits and
 *       +233 international form with the exact copy; a 10-digit order
 *       succeeds; the storefront field shows the live error and clears it.
 *   M · Delivery map: pin structurally at the map centre — dragging the map
 *       moves the saved coordinate (~0.59 m/px at z18), the Google embed
 *       re-centres on the new pin, the marker stays centred, zoom buttons
 *       re-frame, and the pin-at-shop warn appears/clears around the 75 m
 *       guard rail.
 *   H · HELP-housed "How to Use" guide: hidden until the HELP button is
 *       tapped; panel carries the 7 steps + support contacts; close/reload
 *       hides them again.
 *   C · Catalog sanity: category sections + chips + add-to-cart intact.
 *   Z · TEST purge, live-data forensics byte-check, zero page errors.
 *
 * TEST-only artifacts; every live row restored (gps anchor, grants, stock).
 */
import { createRequire } from "module";
const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");
const { Client } = require("pg");

const BASE = "http://127.0.0.1:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pass: process.env.GOMINA_OWNER_PW || "Owner@GoMina26" };
const GM = { email: "abena.gm@gomina360.com", pass: "GoMina@User2", id: 2 };       // executive: dashboard button gate
const BM = { email: "emmanuel@gomina360.com", pass: "GoMina@User3", id: 3 };       // non-executive: API-level creation
const T = "TEST PS Customer";
const SHOP = { lat: 5.598, lng: -0.1870 };                                          // temp GPS anchor for biz 1

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
const loginCookie = async (creds) => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: creds.email, password: creds.pass }),
  });
  if (!res.ok) throw new Error(`login failed for ${creds.email}: ${res.status}`);
  return (res.headers.get("set-cookie") || "").split(";")[0];
};

/* ── N · New Branch/Unit permission ─────────────────────────────────── */
async function sectionN(cookies) {
  console.log("\n— N · New Branch/Unit permission (API) —");
  const mkBody = () => JSON.stringify({
    name: "TEST Emmanuel Hardware Branch", category: "Hardware Store",
    town: "TEST Kasoa", region: "Central", contactPhone: "0550001122",
  });
  // N1 without the grant → refused with the exact guidance
  const denied = await api(cookies.bm, "/api/businesses", { method: "POST", body: mkBody() });
  ok("N1 BM without grant cannot create a unit (403, names the permission)",
    denied.status === 403 && /New Branch\/Unit permission/i.test(denied.json?.error || ""),
    `${denied.status} ${JSON.stringify(denied.json || {}).slice(0, 180)}`);

  // N2 owner grants via PATCH /api/users
  const grant = await api(cookies.owner, "/api/users", {
    method: "PATCH",
    body: JSON.stringify({ userId: BM.id, canCreateBusiness: true }),
  });
  const flagAfterGrant = (await pg.query(`SELECT can_create_business FROM users WHERE id=$1`, [BM.id])).rows[0].can_create_business;
  ok("N2 OWNER grants New Branch/Unit → users.can_create_business=true",
    grant.status === 200 && grant.json?.success === true && flagAfterGrant === true,
    `${grant.status} ${JSON.stringify(grant.json || {}).slice(0, 160)}`);

  // N3 the grantee creates a unit through the app API
  const made = await api(cookies.bm, "/api/businesses", { method: "POST", body: mkBody() });
  const newBiz = made.json?.business;
  baseline.newBizId = newBiz?.id ?? null;
  ok("N3 grantee creates a fully provisioned branch/unit in one call",
    made.status === 200 && made.json?.success === true && !!newBiz?.id && /^HARDWARE-/.test(newBiz.code || ""),
    `${made.status} ${JSON.stringify(made.json || {}).slice(0, 200)}`);

  // N4 auto-grant: the unit lands on the creator's own list immediately
  const list = await api(cookies.bm, "/api/businesses", { method: "GET" });
  const inScope = (list.json?.businesses || []).some((b) => b.id === baseline.newBizId);
  const grantRow = baseline.newBizId
    ? (await pg.query(`SELECT id FROM user_business_access WHERE user_id=$1 AND business_id=$2`, [BM.id, baseline.newBizId])).rows[0]
    : null;
  ok("N4 creator auto-receives access — the new unit is in HIS sidebar list",
    list.status === 200 && inScope && !!grantRow);

  // N5 owner revokes → the gate springs shut again
  await api(cookies.owner, "/api/users", { method: "PATCH", body: JSON.stringify({ userId: BM.id, canCreateBusiness: false }) });
  const revoked = await api(cookies.bm, "/api/businesses", { method: "POST", body: mkBody() });
  const flagAfterRevoke = (await pg.query(`SELECT can_create_business FROM users WHERE id=$1`, [BM.id])).rows[0].can_create_business;
  ok("N5 OWNER removes the permission → grantee refused again (403)",
    revoked.status === 403 && flagAfterRevoke === false, `${revoked.status}`);

  // N6 privilege escalation: the grantee may not grant the power to himself
  await api(cookies.owner, "/api/users", { method: "PATCH", body: JSON.stringify({ userId: BM.id, canCreateBusiness: true }) });
  const selfGrant = await api(cookies.bm, "/api/users", {
    method: "PATCH",
    body: JSON.stringify({ userId: BM.id, canCreateBusiness: true }),
  });
  const flagStill = (await pg.query(`SELECT can_create_business FROM users WHERE id=$1`, [BM.id])).rows[0].can_create_business;
  ok("N6 non-owner cannot grant himself branch-creation powers (403)",
    selfGrant.status === 403 && flagStill === true, `${selfGrant.status}`);
  await api(cookies.owner, "/api/users", { method: "PATCH", body: JSON.stringify({ userId: BM.id, canCreateBusiness: false }) });
}

/* ── N-UI · owner console toggle + GM dashboard button ─────────────── */
async function sectionNui(browser, errors, cookies) {
  console.log("\n— N-UI · Owner console toggle & dashboard button —");
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
  const uiLogin = async (page, creds) => {
    await page.goto(`${BASE}/`, { waitUntil: "networkidle0", timeout: 60000 });
    await page.waitForSelector('[data-testid="login-email"]', { timeout: 60000 });
    await page.type('[data-testid="login-email"]', creds.email);
    await page.type('[data-testid="login-password"]', creds.pass);
    await page.click('[data-testid="login-submit"]');
    await page.waitForFunction(() => !document.querySelector('[data-testid="login-email"]'), { timeout: 60000 });
  };

  // Owner edits the BM in Users & Access: toggle ON → save → DB true; OFF → false
  const ctxO = await browser.createBrowserContext();
  const po = await ctxO.newPage();
  hookPage(po, "owner-console");
  await po.setViewport({ width: 1440, height: 960 });
  await uiLogin(po, OWNER);
  await po.waitForSelector('[data-testid="open-user-access"]', { timeout: 30000 });
  await po.click('[data-testid="open-user-access"]');
  await po.waitForSelector(`[data-testid="user-edit-${BM.id}"]`, { timeout: 30000 });
  await po.click(`[data-testid="user-edit-${BM.id}"]`);
  await po.waitForSelector('[data-testid="perm-create-business"]', { timeout: 15000 });
  const toggleLabel = await po.$eval('[data-testid="perm-create-business"]', (el) => el.closest("div")?.textContent || el.textContent || "");
  ok("N7 owner sees the New Branch/Unit toggle in the permission list",
    /New Branch\/Unit/i.test(toggleLabel), toggleLabel.slice(0, 120));

  await po.click('[data-testid="perm-create-business"]');
  await po.screenshot({ path: "/home/user/perm-toggle-console.png" });
  await po.click('[data-testid="user-edit-save"]');
  await po.waitForFunction(() => !document.querySelector('[data-testid="user-edit-form"]') || document.querySelector('[data-testid="user-access-notice"]'), { timeout: 20000 }).catch(() => {});
  await sleep(900);
  const dbOn = (await pg.query(`SELECT can_create_business FROM users WHERE id=$1`, [BM.id])).rows[0].can_create_business;
  ok("N7b owner grants via the UI toggle → saved server-side", dbOn === true);

  // Re-open the same user and revoke from the UI as well
  await po.reload({ waitUntil: "networkidle0" });
  await po.waitForSelector('[data-testid="open-user-access"]', { timeout: 30000 });
  await po.click('[data-testid="open-user-access"]');
  await po.waitForSelector(`[data-testid="user-edit-${BM.id}"]`, { timeout: 30000 });
  await po.click(`[data-testid="user-edit-${BM.id}"]`);
  await po.waitForSelector('[data-testid="perm-create-business"]', { timeout: 15000 });
  await po.click('[data-testid="perm-create-business"]');
  await po.click('[data-testid="user-edit-save"]');
  await sleep(1200);
  const dbOff = (await pg.query(`SELECT can_create_business FROM users WHERE id=$1`, [BM.id])).rows[0].can_create_business;
  ok("N7c owner removes the permission via the UI toggle → saved server-side", dbOff === false);
  await ctxO.close();

  // GM dashboard button tracks the grant
  const ctxG = await browser.createBrowserContext();
  const pgG = await ctxG.newPage();
  hookPage(pgG, "gm-dash");
  await pgG.setViewport({ width: 1440, height: 960 });
  await uiLogin(pgG, GM);
  await pgG.waitForSelector('[data-testid="command-center-root"]', { timeout: 45000 }); // command center mounted
  const btnBefore = await pgG.$('[data-testid="open-new-business"]');
  ok("N8 GM WITHOUT the grant sees no New Branch / Unit button", !btnBefore);
  await api(cookies.owner, "/api/users", { method: "PATCH", body: JSON.stringify({ userId: GM.id, canCreateBusiness: true }) });
  await pgG.reload({ waitUntil: "networkidle0" });
  await pgG.waitForSelector('[data-testid="command-center-root"]', { timeout: 45000 });
  const btnAfter = await pgG.$('[data-testid="open-new-business"]');
  ok("N8b GM WITH the grant sees the New Branch / Unit button", !!btnAfter);
  if (btnAfter) {
    await pgG.click('[data-testid="open-new-business"]');
    await sleep(700);
    const modalTxt = await pgG.evaluate(() => document.body.innerText);
    ok("N8c grantee can open the New Branch / Unit creation modal", /New (Business|Branch)|Enterprise Unit/i.test(modalTxt));
    await pgG.keyboard.press("Escape");
  }
  // The "Manage Units" button must NOT come along with the creation grant —
  // delivery-area management stays on its own canManageOnline permission.
  const manageUnits = await pgG.$('[data-testid="open-manage-businesses"]');
  ok("N8d creation grant does NOT leak the Manage Units surface", !manageUnits);
  await api(cookies.owner, "/api/users", { method: "PATCH", body: JSON.stringify({ userId: GM.id, canCreateBusiness: false }) });
  await pgG.reload({ waitUntil: "networkidle0" });
  await pgG.waitForSelector('[data-testid="command-center-root"]', { timeout: 45000 });
  const btnRevoked = await pgG.$('[data-testid="open-new-business"]');
  ok("N8e revoking the grant hides the button again on the dashboard", !btnRevoked);
  await ctxG.close();
}

/* ── P · exact-10 customer phone (API) ──────────────────────────────── */
async function sectionP() {
  console.log("\n— P · Customer number must be EXACTLY 10 digits (API) —");
  const eggsId = 1;
  const attempt = (phone) => api(null, "/api/order", {
    method: "POST",
    body: JSON.stringify({
      businessId: 1, customerName: T, customerPhone: phone,
      fulfillmentType: "PICKUP", paymentChoice: "ON_DELIVERY",
      items: [{ inventoryId: eggsId, quantity: 1 }],
    }),
  });
  const nine = await attempt("055123456");          // 9
  ok("P1 9 digits refused (400) with the exact copy",
    nine.status === 400 && /exactly 10 digits/.test(nine.json?.error || "") && /9 digit/.test(nine.json?.error || ""),
    `${nine.status} ${nine.json?.error || ""}`);
  const eleven = await attempt("05512345678");       // 11
  ok("P2 11 digits refused (400) with the exact copy",
    eleven.status === 400 && /exactly 10 digits/.test(eleven.json?.error || "") && /11 digit/.test(eleven.json?.error || ""),
    `${eleven.status} ${eleven.json?.error || ""}`);
  const intl = await attempt("+233551234567");       // 12 digits + country code
  ok("P3 international +233 form refused with guidance (400)",
    intl.status === 400 && /without the country code/.test(intl.json?.error || ""),
    `${intl.status} ${intl.json?.error || ""}`);
  const letters = await attempt("055AB34567");
  ok("P4 letters still refused (400, digits-only rule kept)", letters.status === 400 && /only contain digits/.test(letters.json?.error || ""));
  const spaced = await attempt("055 123 4567");      // separators OK, 10 digits
  const code = spaced.json?.trackingCode || "";
  baseline.trackingCode = code;
  ok("P5 exactly-10 digits (formatted 055 123 4567) → order accepted, GM code",
    spaced.status === 200 && /^GM-[A-Z0-9]+-[A-Z0-9]{6}$/.test(code),
    `${spaced.status} ${JSON.stringify(spaced.json || {}).slice(0, 200)}`);
  if (code) {
    const row = (await pg.query(`SELECT customer_phone FROM customer_trackings WHERE tracking_code=$1`, [code])).rows[0];
    ok("P5b the 10-digit number is stored canonicalised (separators stripped)", row?.customer_phone === "0551234567", row?.customer_phone);
  }
}

/* ── H/C/M-UI · storefront: how-to, catalog, phone field, map drag ──── */
async function sectionStorefront(browser, errors) {
  console.log("\n— H/C/P/M · Storefront (how-to, catalog, live phone, map drag) —");
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
  const clickT = async (page, tid) => {
    await page.$eval(`[data-testid="${tid}"]`, (el) => el.scrollIntoView({ block: "center" }));
    await sleep(250);
    await page.click(`[data-testid="${tid}"]`);
  };
  const setInput = async (page, tid, text) => {
    await page.$eval(`[data-testid="${tid}"]`, (el) => {
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    if (text) await page.type(`[data-testid="${tid}"]`, text);
  };

  // Temp GPS anchor for business 1 so the pin lands exactly at the shop
  await pg.query(`UPDATE businesses SET gps_lat=$1, gps_lng=$2 WHERE id=1`, [SHOP.lat, SHOP.lng]);

  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  hookPage(page, "storefront");
  await page.setViewport({ width: 430, height: 932, isMobile: true, hasTouch: true });
  await page.goto(`${BASE}/order`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid="oo-search"]', { timeout: 30000 });

  /* H — HELP-housed how-to guide (instructions only behind the HELP button) */
  const preSteps = await page.$('[data-testid="oo-howto-steps"]');
  const preModal = await page.$('[data-testid="oo-help-modal"]');
  ok("H1 instructions are NOT on the page before HELP is tapped", !preSteps && !preModal);
  const helpBtn = await page.$('[data-testid="oo-help"]');
  ok("H1b a visible HELP button sits in the header", !!helpBtn);
  await clickT(page, "oo-help");
  await page.waitForSelector('[data-testid="oo-howto-steps"]', { timeout: 15000 });
  const stepCount = await page.$$eval('[data-testid^="oo-howto-step-"]', (els) => els.length);
  const stepText = await page.$eval('[data-testid="oo-howto-steps"]', (el) => el.textContent);
  const helpInfo = await page.$('[data-testid="oo-help-info"]');
  ok("H2 HELP panel opens with the 7-step guide beside the support contacts",
    stepCount === 7 && !!helpInfo, `steps=${stepCount}`);
  ok("H2b steps cover the real flow (categories, 10-digit phone, drag-the-map, GM code)",
    /categor/i.test(stepText) && /exactly 10 digits/.test(stepText) && /drag the map/i.test(stepText) && /GM-/.test(stepText));
  await page.screenshot({ path: "/home/user/storefront-howto.png" });
  await clickT(page, "oo-help-close");
  await page.waitForSelector('[data-testid="oo-help-modal"]', { hidden: true, timeout: 10000 });
  const stepsAfterClose = await page.$('[data-testid="oo-howto-steps"]');
  ok("H3 closing HELP hides the instructions again", !stepsAfterClose);
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForSelector('[data-testid="oo-help"]', { timeout: 30000 });
  const stepsAfterReload = await page.$('[data-testid="oo-howto-steps"]');
  ok("H4 instructions stay hidden across a reload until HELP is tapped again", !stepsAfterReload);

  /* C — category catalog browse sanity */
  await clickT(page, "oo-biz-1");
  await page.waitForSelector('[data-testid="oo-catalog"]', { timeout: 30000 }).catch(() => {});
  await sleep(400);
  const catalog = await page.evaluate(() => {
    const secs = [...document.querySelectorAll('[data-testid^="oo-catsec-"]')]
      .filter((el) => !/count/.test(el.getAttribute("data-testid")));
    return {
      sections: secs.length,
      chips: [...document.querySelectorAll('[data-testid^="oo-cat-"]')].map((el) => el.getAttribute("data-testid")),
      productsAll: document.querySelectorAll('[data-testid^="oo-prod-"]').length,
    };
  });
  ok("C1 products render grouped in category sections with category chips",
    catalog.sections >= 1 && catalog.chips.length >= 2 && catalog.productsAll >= 2, JSON.stringify(catalog));
  const otherChip = catalog.chips.find((c) => c !== "oo-cat-ALL" && !/catsec/.test(c));
  if (otherChip) {
    await clickT(page, otherChip);
    await sleep(500);
    const filtered = await page.$$eval('[data-testid^="oo-prod-"]', (els) => els.length);
    ok("C2 tapping a category chip filters the grid (browse one category)",
      filtered >= 1 && filtered < catalog.productsAll, `filtered=${filtered} all=${catalog.productsAll}`);
    await clickT(page, "oo-cat-ALL");
    await sleep(400);
  }
  const firstAdd = await page.evaluate(() => document.querySelector('[data-testid^="oo-add-"]')?.getAttribute("data-testid"));
  await clickT(page, firstAdd);
  await page.waitForSelector('[data-testid="oo-cart"]', { timeout: 10000 });
  ok("C3 add-to-cart from the grouped catalog still works", !!firstAdd);

  /* P — live phone error in the checkout */
  await clickT(page, "oo-delivery");
  await page.waitForSelector('[data-testid="oo-name"]', { timeout: 10000 });
  await setInput(page, "oo-phone", "055123456"); // 9
  await page.waitForSelector('[data-testid="oo-phone-error"]', { timeout: 8000 });
  const errTxt9 = await page.$eval('[data-testid="oo-phone-error"]', (el) => el.textContent);
  ok("P6 storefront shows the live error on a 9-digit number",
    /exactly 10 digits/.test(errTxt9) && /9 digit/.test(errTxt9), errTxt9);
  await page.type('[data-testid="oo-phone"]', "0"); // → 0551234560 (10)
  await page.waitForSelector('[data-testid="oo-phone-error"]', { hidden: true, timeout: 8000 });
  ok("P7 the error clears the moment the number reaches exactly 10 digits", true);
  await setInput(page, "oo-phone", "05512345678"); // 11
  await page.waitForSelector('[data-testid="oo-phone-error"]', { timeout: 8000 });
  const errTxt11 = await page.$eval('[data-testid="oo-phone-error"]', (el) => el.textContent);
  ok("P8 11 digits flagged live as well", /exactly 10 digits/.test(errTxt11) && /11 digit/.test(errTxt11), errTxt11);
  await setInput(page, "oo-phone", "+233551234567");
  await page.waitForSelector('[data-testid="oo-phone-error"]', { timeout: 8000 });
  const errTxtIntl = await page.$eval('[data-testid="oo-phone-error"]', (el) => el.textContent);
  ok("P9 +233 form flagged live with country-code guidance", /without the country code/.test(errTxtIntl), errTxtIntl);
  await setInput(page, "oo-phone", "0551234560"); // leave a valid number behind
  await page.waitForSelector('[data-testid="oo-phone-error"]', { hidden: true, timeout: 8000 });

  /* M — drag the map; pin stays at the centre */
  await page.waitForSelector('[data-testid="oo-pin-root"]', { timeout: 15000 });
  await clickT(page, "oo-pin-set"); // pin straight on the (temp-anchored) shop
  await page.waitForFunction(
    (want) => (document.querySelector('[data-testid="oo-pin-coords"]')?.textContent || "").includes(String(want)),
    { timeout: 15000 }, SHOP.lat.toFixed(6),
  );
  const coords0 = await page.$eval('[data-testid="oo-pin-coords"]', (el) => el.textContent.trim());
  await page.waitForSelector('[data-testid="oo-pin-shop-warn"]', { timeout: 10000 });
  ok("M1 pin dropped exactly at the shop → 75m guard-rail warning shows", true, coords0);

  const [lat0, lng0] = coords0.split(",").map((s) => parseFloat(s));
  // Drag the map ~300px to the right with a real mouse gesture
  const drag = await page.$('[data-testid="oo-pin-drag"]');
  const box = await drag.boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 300, cy + 24, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction(
    (prev) => {
      const t = document.querySelector('[data-testid="oo-pin-coords"]')?.textContent || "";
      return t.includes(",") && t.trim() !== prev;
    },
    { timeout: 15000 }, coords0,
  );
  const coords1 = await page.$eval('[data-testid="oo-pin-coords"]', (el) => el.textContent.trim());
  const [lat1, lng1] = coords1.split(",").map((s) => parseFloat(s));
  // haversine metres
  const rad = Math.PI / 180;
  const dLat = (lat1 - lat0) * rad, dLng = (lng1 - lng0) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat0 * rad) * Math.cos(lat1 * rad) * Math.sin(dLng / 2) ** 2;
  const metres = 2 * 6371000 * Math.asin(Math.sqrt(a));
  ok("M2 dragging the map 300px moves the SAVED pin ~178m (not just the view)",
    metres > 75 && metres < 400, `moved ${metres.toFixed(1)}m ${coords0} → ${coords1}`);
  ok("M2b dragging right pulled the centre west (lng decreased)", lng1 < lng0, `${lng0} → ${lng1}`);
  const warnAfterDrag = await page.$('[data-testid="oo-pin-shop-warn"]');
  ok("M3 guard-rail warning clears once the pin is >75m from the shop", !warnAfterDrag);
  const iframeSrc = await page.$eval('[data-testid="oo-pin-map"]', (el) => el.src);
  ok("M4 Google embed re-centres on the new pin (q= matches saved coords)",
    iframeSrc.includes(lat1.toFixed(6)) && iframeSrc.includes(lng1.toFixed(6)),
    iframeSrc.slice(0, 140));
  const markerBox = await (await page.$('[data-testid="oo-pin-marker"]')).boundingBox();
  const offX = Math.abs(markerBox.x + markerBox.width / 2 - cx);
  ok("M5 the marker never leaves the map centre while the map moves", offX <= 12, `offX=${offX.toFixed(1)}px`);

  const zBefore = (await page.$eval('[data-testid="oo-pin-map"]', (el) => el.src)).match(/&z=(\d+)/)?.[1];
  await clickT(page, "oo-pin-zoom-out");
  await page.waitForFunction((z) => document.querySelector('[data-testid="oo-pin-map"]')?.src.includes(`&z=${Number(z) - 1}&`), { timeout: 15000 }, zBefore);
  const zOut = (await page.$eval('[data-testid="oo-pin-map"]', (el) => el.src)).match(/&z=(\d+)/)?.[1];
  await clickT(page, "oo-pin-zoom-in");
  await page.waitForFunction((z) => document.querySelector('[data-testid="oo-pin-map"]')?.src.includes(`&z=${Number(z) + 1}&`), { timeout: 15000 }, zOut);
  const zIn = (await page.$eval('[data-testid="oo-pin-map"]', (el) => el.src)).match(/&z=(\d+)/)?.[1];
  ok("M6 zoom +/− re-frames around the same pin (z param follows)",
    Number(zOut) === Number(zBefore) - 1 && Number(zIn) === Number(zBefore),
    `z ${zBefore}→${zOut}→${zIn}`);
  ok("M7 nudge pad / GPS / manual coords / Clear all still present alongside drag",
    !!(await page.$('[data-testid="oo-pin-nudge"]')) && !!(await page.$('[data-testid="oo-pin-gps"]')) &&
    !!(await page.$('[data-testid="oo-pin-manual-toggle"]')) && !!(await page.$('[data-testid="oo-pin-clear"]')));
  await page.screenshot({ path: "/home/user/storefront-map-drag.png" });
  await ctx.close();
}

/* ── Z · cleanup & forensics ────────────────────────────────────────── */
async function cleanup() {
  console.log("\n— Z · cleanup & forensics —");
  // Remove the TEST business and everything provisioned for it
  if (baseline.newBizId) {
    const id = baseline.newBizId;
    await pg.query(`DELETE FROM user_business_access WHERE business_id=$1`, [id]);
    await pg.query(`DELETE FROM business_metrics WHERE business_id=$1`, [id]);
    await pg.query(`DELETE FROM checklist_templates WHERE business_id=$1`, [id]);
    await pg.query(`DELETE FROM businesses WHERE id=$1 AND name LIKE 'TEST%'`, [id]);
  }
  // Restore live rows the suite touched
  await pg.query(`UPDATE users SET can_create_business=false WHERE id IN ($1,$2)`, [BM.id, GM.id]);
  await pg.query(`UPDATE businesses SET gps_lat=NULL, gps_lng=NULL WHERE id=1`);
  // Purge the one valid TEST order (PICKUP never reserved stock)
  const trk = await pg.query(`DELETE FROM customer_trackings WHERE id>$1 AND customer_name LIKE 'TEST%' RETURNING id`, [baseline.trMax]);
  const ntf = await pg.query(`DELETE FROM notifications WHERE id>$1 AND type IN ('ONLINE_ORDER_RECEIVED','ORDER_TRACKING_STATUS') RETURNING id`, [baseline.ntfMax]);
  const cust = await pg.query(`DELETE FROM customers WHERE id>$1 AND name LIKE 'TEST%' RETURNING id`, [baseline.custMax]);
  const sess = await pg.query(`DELETE FROM user_sessions WHERE id>$1 RETURNING id`, [baseline.sessMax]);
  console.log(`   purged: business=${baseline.newBizId ?? "-"} trackings=${trk.rowCount} notifications=${ntf.rowCount} customers=${cust.rowCount} sessions=${sess.rowCount}`);

  const counts = (await pg.query(`SELECT
      (SELECT count(*)::int FROM businesses) b, (SELECT count(*)::int FROM users) u,
      (SELECT count(*)::int FROM customers) cu, (SELECT count(*)::int FROM customer_trackings) t,
      (SELECT count(*)::int FROM sales_documents) sd, (SELECT count(*)::int FROM transactions) tx,
      (SELECT count(*)::int FROM inventory_items) ii`)).rows[0];
  // Byte-identical vs the SUITE-START snapshot — the owner trades live on the
  // preview, so absolute numbers may grow DURING the run; only the delta the
  // suite itself caused must be zero.
  const base = baseline.counts || {};
  ok("Z1 live data byte-identical to suite start (suite caused zero net change)",
    counts.b === base.b && counts.u === base.u && counts.cu === base.cu && counts.t === base.t &&
    counts.sd === base.sd && counts.tx === base.tx && counts.ii === base.ii,
    `start=${JSON.stringify(base)} end=${JSON.stringify(counts)}`);
  const eggs = (await pg.query(`SELECT quantity::float q FROM inventory_items WHERE id=1`)).rows[0];
  ok("Z2 eggs stock untouched (873.63)", Math.abs(eggs.q - 873.63) < 1e-9, `qty=${eggs.q}`);
  const sale = (await pg.query(`SELECT status FROM customer_trackings WHERE tracking_code='GM-POULTRY-ESY6GN'`)).rows[0];
  ok("Z3 the owner's live GH₵55 sale GM-POULTRY-ESY6GN intact", sale?.status === "RECEIVED");
  const gps = (await pg.query(`SELECT gps_lat, gps_lng FROM businesses WHERE id=1`)).rows[0];
  ok("Z4 temp GPS anchor fully restored to NULL", gps.gps_lat == null && gps.gps_lng == null);
  const grants = (await pg.query(`SELECT count(*)::int c FROM users WHERE can_create_business=true`)).rows[0].c;
  ok("Z5 no stray New Branch/Unit grants left behind", grants === 0);
  const bizLeft = (await pg.query(`SELECT count(*)::int c FROM businesses WHERE name LIKE 'TEST%'`)).rows[0].c;
  ok("Z6 TEST business fully removed (incl. metrics/templates/access)", bizLeft === 0);
}

(async () => {
  await pg.connect();
  baseline.trMax = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM customer_trackings`)).rows[0].m;
  baseline.trxMax = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM transactions`)).rows[0].m;
  baseline.ntfMax = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM notifications`)).rows[0].m;
  baseline.custMax = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM customers`)).rows[0].m;
  baseline.sessMax = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM user_sessions`)).rows[0].m;
  baseline.counts = (await pg.query(`SELECT
      (SELECT count(*)::int FROM businesses) b, (SELECT count(*)::int FROM users) u,
      (SELECT count(*)::int FROM customers) cu, (SELECT count(*)::int FROM customer_trackings) t,
      (SELECT count(*)::int FROM sales_documents) sd, (SELECT count(*)::int FROM transactions) tx,
      (SELECT count(*)::int FROM inventory_items) ii`)).rows[0];
  console.log(`   baseline counts: ${JSON.stringify(baseline.counts)}`);
  // Pre-flight: target users must start un-granted; biz-1 GPS must start NULL
  const preFlags = (await pg.query(`SELECT id, can_create_business FROM users WHERE id IN (2,3)`)).rows;
  if (preFlags.some((r) => r.can_create_business)) {
    console.log("pre-flight: clearing stale grants on users 2/3");
    await pg.query(`UPDATE users SET can_create_business=false WHERE id IN (2,3)`);
  }
  await pg.query(`UPDATE businesses SET gps_lat=NULL, gps_lng=NULL WHERE id=1`);

  const cookies = {
    owner: await loginCookie(OWNER),
    gm: await loginCookie(GM),
    bm: await loginCookie(BM),
  };
  const errors = [];
  const browser = await puppeteer.launch({
    executablePath: "/tmp/al2023/chromium",
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    await sectionN(cookies);
    await sectionP();
    await sectionNui(browser, errors, cookies);
    await sectionStorefront(browser, errors);
  } catch (e) {
    ok(`suite crashed: ${e.message}`, false);
    console.error(e);
  } finally {
    await browser.close().catch(() => {});
    try { await cleanup(); } catch (e) { console.error("cleanup error:", e.message); }
    await pg.end();
  }
  ok("ZERO page/console errors across all UI passes", errors.length === 0, errors.slice(0, 5).join(" | "));
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
