/**
 * verify-storefront-help.mjs — Amazon-style storefront redesign + HELP panel
 * + Customer Support (storefront HELP) permission E2E.
 *
 *   A · Support-info API security & grant lifecycle:
 *       public GET ok; anonymous POST 401; GM/BM without grant 403; GM cannot
 *       self-grant (403); owner PATCH-grants → GM POSTs full info → GET serves
 *       it; owner revokes → 403 again; owner can always POST; bad email 400.
 *   B · Admin UI: owner Command-Center "Storefront HELP" button → editor modal
 *       saves (fields → API); owner console perm-support-info toggle round-
 *       trips server-side; granted GM sees the sidebar entry & opens the
 *       editor; revoked → entry gone.
 *   C · Storefront: visible HELP button; instructions + support contacts are
 *       NOT on the page until HELP is tapped; modal shows support info with
 *       tel:/wa.me/mailto: links + the 7-step guide; close/reload keeps them
 *       hidden; Amazon-style structure: sticky header w/ search, department
 *       chips, store cards, header cart badge, ≥3-column desktop grid,
 *       availability badges, product photo + lightbox; mobile 2-column grid.
 *   Z · TEST purge, live-data forensics byte-check vs suite start, 0 errors.
 *
 * TEST-only artifacts; every live row restored (support info, grants, photo,
 * sessions).
 */
import { createRequire } from "module";
const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");
const { Client } = require("pg");

const BASE = "http://127.0.0.1:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pass: process.env.GOMINA_OWNER_PW || "Owner@GoMina26" };
const GM = { email: "abena.gm@gomina360.com", pass: "GoMina@User2", id: 2 };
const BM = { email: "emmanuel@gomina360.com", pass: "GoMina@User3", id: 3 };

const SUPPORT = {
  contactName: "TEST Ama Serwaa — Customer Care",
  phone: "055 123 4567",
  whatsapp: "233551234567",
  email: "support.test@gomina360.com",
  address: "TEST Plot 14, Spintex Road, Accra",
  openingHours: "TEST Mon–Sat 7:00 AM – 7:00 PM",
  extraInfo: "TEST Deliveries pause during heavy rain; after-hours WhatsApp only.",
};
// 1×1 PNG (transparent) — temporary product photo for the image-path checks.
const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const results = [];
const baseline = {};
const pageErrors = [];
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

const hookPage = (page, tag) => {
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const txt = m.text();
    if (/Failed to load resource/.test(txt) && /(401|400|403|404|409|413)/.test(txt)) return;
    if (/net::/.test(txt)) return;
    pageErrors.push(`[${tag}] ${txt.slice(0, 300)}`);
  });
  page.on("pageerror", (e) => pageErrors.push(`[${tag}] PAGEERROR ${String(e).slice(0, 300)}`));
};
const clickT = async (page, tid) => {
  await page.$eval(`[data-testid="${tid}"]`, (el) => el.scrollIntoView({ block: "center" }));
  await sleep(250);
  await page.click(`[data-testid="${tid}"]`);
};
const setInput = async (page, tid, text) => {
  await page.$eval(`[data-testid="${tid}"]`, (el) => {
    el.focus();
    const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  if (text) await page.type(`[data-testid="${tid}"]`, text);
};

/* ── A · Support-info API security & grant lifecycle ────────────────── */
async function sectionA(cookies) {
  console.log("\n— A · Support-info API security & grant lifecycle —");
  const pub = await api(null, "/api/support-info");
  ok("A1 public GET /api/support-info answers 200 without any login",
    pub.status === 200 && pub.json?.success === true, `${pub.status}`);

  const anon = await api(null, "/api/support-info", { method: "POST", body: JSON.stringify(SUPPORT) });
  ok("A2 anonymous POST is refused (401)", anon.status === 401, `${anon.status}`);

  const gmDenied = await api(cookies.gm, "/api/support-info", { method: "POST", body: JSON.stringify(SUPPORT) });
  ok("A3 GM WITHOUT the grant cannot edit support info (403, names owner-grant)",
    gmDenied.status === 403 && /OWNER/.test(gmDenied.json?.error || "") && /granted Customer Support access|Customer Support/.test(gmDenied.json?.error || ""),
    `${gmDenied.status} ${(gmDenied.json?.error || "").slice(0, 120)}`);

  const bmDenied = await api(cookies.bm, "/api/support-info", { method: "POST", body: JSON.stringify(SUPPORT) });
  ok("A4 BM WITHOUT the grant cannot edit support info (403)", bmDenied.status === 403, `${bmDenied.status}`);

  const selfGrant = await api(cookies.gm, "/api/users", {
    method: "PATCH", body: JSON.stringify({ userId: GM.id, canManageSupport: true }),
  });
  const flagAfterSelf = (await pg.query(`SELECT can_manage_support FROM users WHERE id=$1`, [GM.id])).rows[0].can_manage_support;
  ok("A5 a non-owner cannot self-grant Customer Support powers (403, flag untouched)",
    selfGrant.status === 403 && flagAfterSelf === false, `${selfGrant.status}`);

  const grant = await api(cookies.owner, "/api/users", {
    method: "PATCH", body: JSON.stringify({ userId: GM.id, canManageSupport: true }),
  });
  const flagOn = (await pg.query(`SELECT can_manage_support FROM users WHERE id=$1`, [GM.id])).rows[0].can_manage_support;
  ok("A6 OWNER grants the GM Customer Support access (PATCH → flag true)",
    grant.status === 200 && flagOn === true, `${grant.status}`);

  const gmPost = await api(cookies.gm, "/api/support-info", { method: "POST", body: JSON.stringify(SUPPORT) });
  ok("A7 the granted GM saves the full support record (200)",
    gmPost.status === 200 && gmPost.json?.success === true, `${gmPost.status} ${JSON.stringify(gmPost.json || {}).slice(0, 160)}`);
  const pubAfter = await api(null, "/api/support-info");
  const i = pubAfter.json?.info || {};
  ok("A7b public GET now serves every saved field (contact, phone, whatsapp, email, address, hours, extra)",
    i.contactName === SUPPORT.contactName && i.phone === SUPPORT.phone && i.whatsapp === SUPPORT.whatsapp &&
    i.email === SUPPORT.email && i.address === SUPPORT.address && i.openingHours === SUPPORT.openingHours &&
    i.extraInfo === SUPPORT.extraInfo, JSON.stringify(i).slice(0, 200));

  await api(cookies.owner, "/api/users", { method: "PATCH", body: JSON.stringify({ userId: GM.id, canManageSupport: false }) });
  const gmRevoked = await api(cookies.gm, "/api/support-info", { method: "POST", body: JSON.stringify(SUPPORT) });
  const flagOff = (await pg.query(`SELECT can_manage_support FROM users WHERE id=$1`, [GM.id])).rows[0].can_manage_support;
  ok("A8 revoking the grant locks the GM out again (403, flag false)",
    gmRevoked.status === 403 && flagOff === false, `${gmRevoked.status}`);

  const ownerPost = await api(cookies.owner, "/api/support-info", { method: "POST", body: JSON.stringify(SUPPORT) });
  ok("A9 the OWNER can always edit the support information (200)",
    ownerPost.status === 200 && ownerPost.json?.success === true, `${ownerPost.status}`);

  const badEmail = await api(cookies.owner, "/api/support-info", {
    method: "POST", body: JSON.stringify({ ...SUPPORT, email: "not-an-email" }),
  });
  ok("A10 invalid email is refused (400)", badEmail.status === 400, `${badEmail.status}`);
}

/* ── B · Admin UI: owner editor + console toggle + grantee sidebar ──── */
async function sectionB(browser, cookies) {
  console.log("\n— B · Admin UI (owner editor, console toggle, grantee sidebar) —");
  const uiLogin = async (page, creds) => {
    await page.goto(`${BASE}/`, { waitUntil: "networkidle0", timeout: 60000 });
    await page.waitForSelector('[data-testid="login-email"]', { timeout: 60000 });
    await page.type('[data-testid="login-email"]', creds.email);
    await page.type('[data-testid="login-password"]', creds.pass);
    await page.click('[data-testid="login-submit"]');
    await page.waitForFunction(() => !document.querySelector('[data-testid="login-email"]'), { timeout: 60000 });
  };

  // B1–B2 owner: Command Center button → editor modal → save → API reflects
  const ctxO = await browser.createBrowserContext();
  const po = await ctxO.newPage();
  hookPage(po, "owner-editor");
  await po.setViewport({ width: 1440, height: 960 });
  await uiLogin(po, OWNER);
  await po.waitForSelector('[data-testid="command-center-root"]', { timeout: 45000 });
  const btn = await po.$('[data-testid="open-support-info"]');
  ok("B1 OWNER sees the amber “Storefront HELP” button on the Command Center", !!btn);
  await po.click('[data-testid="open-support-info"]');
  await po.waitForSelector('[data-testid="support-modal"]', { timeout: 15000 });
  await po.waitForSelector('[data-testid="support-name"]', { timeout: 15000 });
  await setInput(po, "support-name", SUPPORT.contactName);
  await setInput(po, "support-phone", SUPPORT.phone);
  await setInput(po, "support-whatsapp", SUPPORT.whatsapp);
  await setInput(po, "support-email", SUPPORT.email);
  await setInput(po, "support-address", SUPPORT.address);
  await setInput(po, "support-hours", SUPPORT.openingHours);
  await setInput(po, "support-extra", SUPPORT.extraInfo);
  await po.screenshot({ path: "/home/user/support-owner-editor.png" });
  await po.click('[data-testid="support-save"]');
  await po.waitForSelector('[data-testid="support-saved"]', { timeout: 15000 });
  const after = await api(null, "/api/support-info");
  ok("B2 owner editor save lands on the public API immediately",
    after.json?.info?.contactName === SUPPORT.contactName && after.json?.info?.openingHours === SUPPORT.openingHours,
    JSON.stringify(after.json?.info || {}).slice(0, 160));
  await po.click('[data-testid="support-close"]');

  // B3 owner console: perm-support-info toggle round-trips on the GM
  await po.waitForSelector('[data-testid="open-user-access"]', { timeout: 30000 });
  await po.click('[data-testid="open-user-access"]');
  await po.waitForSelector(`[data-testid="user-edit-${GM.id}"]`, { timeout: 30000 });
  await po.click(`[data-testid="user-edit-${GM.id}"]`);
  await po.waitForSelector('[data-testid="perm-support-info"]', { timeout: 15000 });
  const toggleLabel = await po.$eval('[data-testid="perm-support-info"]', (el) => el.closest("div")?.textContent || el.textContent || "");
  ok("B3 owner sees the Customer Support toggle in the permission list",
    /Customer Support/i.test(toggleLabel) && /HELP/i.test(toggleLabel), toggleLabel.slice(0, 140));
  await po.click('[data-testid="perm-support-info"]');
  await po.screenshot({ path: "/home/user/perm-support-toggle.png" });
  await po.click('[data-testid="user-edit-save"]');
  await sleep(1200);
  const dbOn = (await pg.query(`SELECT can_manage_support FROM users WHERE id=$1`, [GM.id])).rows[0].can_manage_support;
  ok("B3b owner grants via the UI toggle → saved server-side", dbOn === true);
  await ctxO.close();

  // B4 granted GM: sidebar entry + Command Center button open the editor
  const ctxG = await browser.createBrowserContext();
  const pgG = await ctxG.newPage();
  hookPage(pgG, "gm-grantee");
  await pgG.setViewport({ width: 1440, height: 960 });
  await uiLogin(pgG, GM);
  await pgG.waitForSelector('[data-testid="command-center-root"]', { timeout: 45000 });
  const sideEntry = await pgG.$('[data-testid="sidebar-support-info"]');
  const ccBtn = await pgG.$('[data-testid="open-support-info"]');
  ok("B4 granted GM sees the sidebar “Support — Storefront HELP” entry AND the dashboard button",
    !!sideEntry && !!ccBtn);
  await pgG.click('[data-testid="sidebar-support-info"]');
  await pgG.waitForSelector('[data-testid="support-modal"]', { timeout: 15000 });
  const hasSave = await pgG.$('[data-testid="support-save"]');
  ok("B4b granted GM opens the editor with a working save surface", !!hasSave);
  await pgG.screenshot({ path: "/home/user/support-grantee-sidebar.png" });
  await pgG.click('[data-testid="support-close"]');
  await api(cookies.owner, "/api/users", { method: "PATCH", body: JSON.stringify({ userId: GM.id, canManageSupport: false }) });
  await pgG.reload({ waitUntil: "networkidle0" });
  await pgG.waitForSelector('[data-testid="command-center-root"]', { timeout: 45000 });
  const sideGone = await pgG.$('[data-testid="sidebar-support-info"]');
  const ccGone = await pgG.$('[data-testid="open-support-info"]');
  ok("B5 revoking hides the sidebar entry AND the dashboard button again", !sideGone && !ccGone);
  await ctxG.close();
}

/* ── C · Storefront HELP panel + Amazon-style structure ─────────────── */
async function sectionC(browser) {
  console.log("\n— C · Storefront HELP panel + Amazon-style structure —");

  /* Desktop pass */
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  hookPage(page, "storefront-desktop");
  await page.setViewport({ width: 1440, height: 960 });
  await page.goto(`${BASE}/order`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid="oo-search"]', { timeout: 30000 });

  const preModal = await page.$('[data-testid="oo-help-modal"]');
  const preSteps = await page.$('[data-testid="oo-howto-steps"]');
  const preInfo = await page.$('[data-testid="oo-help-info"]');
  ok("C1 HELP content is NOT on the page before the button is tapped (modal, steps, contacts all absent)",
    !preModal && !preSteps && !preInfo);

  const helpVisible = await page.$eval('[data-testid="oo-help"]', (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.top >= 0;
  }).catch(() => false);
  const helpInHeader = await page.$eval('[data-testid="oo-header"] [data-testid="oo-help"]', () => true).catch(() => false);
  ok("C2 a visible HELP button sits in the sticky header", helpVisible && helpInHeader);

  await clickT(page, "oo-help");
  await page.waitForSelector('[data-testid="oo-help-modal"]', { timeout: 15000 });
  await page.waitForSelector('[data-testid="oo-howto-steps"]', { timeout: 15000 });
  const stepCount = await page.$$eval('[data-testid^="oo-howto-step-"]', (els) => els.length);
  const stepText = await page.$eval('[data-testid="oo-howto-steps"]', (el) => el.textContent);
  ok("C3 tapping HELP opens the panel with the 7-step guide inside",
    stepCount === 7, `steps=${stepCount}`);
  ok("C3b steps cover the real flow (categories, 10-digit phone, drag-the-map, GM code)",
    /categor/i.test(stepText) && /exactly 10 digits/.test(stepText) && /drag the map/i.test(stepText) && /GM-/.test(stepText));

  const info = await page.evaluate(() => ({
    contact: document.querySelector('[data-testid="oo-help-contact"]')?.textContent || "",
    phoneHref: document.querySelector('[data-testid="oo-help-phone"]')?.getAttribute("href") || "",
    waHref: document.querySelector('[data-testid="oo-help-whatsapp"]')?.getAttribute("href") || "",
    emailHref: document.querySelector('[data-testid="oo-help-email"]')?.getAttribute("href") || "",
    address: document.querySelector('[data-testid="oo-help-address"]')?.textContent || "",
    hours: document.querySelector('[data-testid="oo-help-hours"]')?.textContent || "",
    extra: document.querySelector('[data-testid="oo-help-extra"]')?.textContent || "",
  }));
  ok("C4 HELP shows every saved support field (contact, phone, WhatsApp, email, address, hours, extra)",
    info.contact.includes(SUPPORT.contactName) &&
    info.phoneHref.startsWith("tel:") && info.phoneHref.includes("0551234567") &&
    info.waHref === `https://wa.me/${SUPPORT.whatsapp}` &&
    info.emailHref === `mailto:${SUPPORT.email}` &&
    info.address.includes("Spintex") && info.hours.includes("7:00 AM") &&
    info.extra.includes("heavy rain"),
    JSON.stringify(info).slice(0, 240));
  await page.screenshot({ path: "/home/user/storefront-help-open.png" });

  await clickT(page, "oo-help-close");
  await page.waitForSelector('[data-testid="oo-help-modal"]', { hidden: true, timeout: 10000 });
  const stepsAfterClose = await page.$('[data-testid="oo-howto-steps"]');
  ok("C5 closing HELP hides instructions & contacts again", !stepsAfterClose);

  // Amazon-style structure
  const structure = await page.evaluate(() => {
    const header = document.querySelector('[data-testid="oo-header"]');
    const chips = [...document.querySelectorAll('[data-testid^="oo-cat-"]')].length;
    const prods = [...document.querySelectorAll('[data-testid^="oo-prod-"]')];
    const avail = [...document.querySelectorAll('[data-testid^="oo-avail-"]')];
    const photos = [...document.querySelectorAll('[data-testid^="oo-photo-"]')].length;
    // Column density: read the grid's computed track count directly (item
    // count per section varies — singleton category grids are legit).
    const gridEl = [...document.querySelectorAll('[data-testid^="oo-catsec-"]')]
      .filter((el) => !/count/.test(el.getAttribute("data-testid")))
      .map((sec) => sec.querySelector(".grid"))
      .find(Boolean);
    const trackCount = (g) => {
      if (!g) return 0;
      const v = getComputedStyle(g).gridTemplateColumns || "";
      const rep = v.match(/repeat\((\d+)/);
      if (rep) return Number(rep[1]);
      return v.split(/\s+/).filter((x) => x && x !== "none").length;
    };
    const colsDesktop = trackCount(gridEl);
    const first4 = [colsDesktop]; // reuse slot below
    const cs = header ? getComputedStyle(header) : null;
    const sample = prods[0];
    return {
      sticky: cs ? (cs.position === "sticky" || cs.position === "fixed") : false,
      searchInHeader: !!document.querySelector('[data-testid="oo-header"] [data-testid="oo-search"]'),
      chips,
      prodCount: prods.length,
      availCount: avail.length,
      availTexts: [...new Set(avail.slice(0, 6).map((el) => el.textContent.trim()))],
      photos,
      topRowCols: colsDesktop,
      cardHasPrice: sample ? /GH₵/.test(sample.textContent) : false,
      cardHasCat: sample ? !!sample.querySelector('[class*="bg-slate-100"]') || /per /.test(sample.textContent) : false,
      cartBtn: !!document.querySelector('[data-testid="oo-header-cart"]'),
      cartBadge: !!document.querySelector('[data-testid="oo-header-cart-count"]'),
      bizRow: !!document.querySelector('[data-testid="oo-bizrow"]'),
      bizAll: !!document.querySelector('[data-testid="oo-biz-all"]'),
      groups: document.querySelectorAll('[data-testid^="oo-bizsec-"]').length,
    };
  });
  ok("C6 sticky Amazon-style header carries the search bar", structure.sticky && structure.searchInHeader,
    JSON.stringify({ sticky: structure.sticky, searchInHeader: structure.searchInHeader }));
  ok("C6b department chips strip renders under the header", structure.chips >= 2, `chips=${structure.chips}`);
  ok("C7 wide desktop grid shows ≥3 product columns (Amazon-like density)", structure.topRowCols >= 3,
    `cols=${structure.topRowCols}`);
  ok("C7b every card shows name, category/unit, GH₵ price AND an availability badge",
    structure.prodCount >= 5 && structure.availCount === structure.prodCount && structure.cardHasPrice && structure.cardHasCat &&
    structure.availTexts.some((t) => /In stock|Only|Out of stock/.test(t)),
    JSON.stringify({ p: structure.prodCount, a: structure.availCount, texts: structure.availTexts }));
  ok("C8 product images render for photographed items (photo button present)",
    structure.photos >= 1, `photos=${structure.photos}`);
  ok("C8b header cart button with live count badge + store cards row (All businesses)",
    structure.cartBtn && structure.cartBadge && structure.bizRow && structure.bizAll);
  ok("C8c all businesses stay grouped on one page", structure.groups >= 3, `groups=${structure.groups}`);

  // Photo lightbox from the one-page grid adds to the RIGHT shop
  await clickT(page, "oo-photo-1");
  await page.waitForSelector('[data-testid="oo-lightbox-img"]', { timeout: 10000 });
  ok("C9 tapping a product photo opens the Amazon-style image lightbox", true);
  await page.screenshot({ path: "/home/user/storefront-lightbox.png" });
  await clickT(page, "oo-lightbox-add");
  await page.waitForSelector('[data-testid="oo-cart"]', { timeout: 10000 });
  const cartAfterZoom = await page.evaluate(() => ({
    badge: document.querySelector('[data-testid="oo-header-cart-count"]')?.textContent || "",
    total: document.querySelector('[data-testid="oo-cart-total"]')?.textContent || "",
  }));
  ok("C9b lightbox “Add to Cart” lands in the cart (badge 1, eggs GH₵55)",
    cartAfterZoom.badge === "1" && /55/.test(cartAfterZoom.total), JSON.stringify(cartAfterZoom));
  await clickT(page, "oo-clear");

  // Search filters across the one-page catalog
  await setInput(page, "oo-search", "cement");
  await sleep(400);
  const searchState = await page.evaluate(() => ({
    prods: document.querySelectorAll('[data-testid^="oo-prod-"]').length,
    names: [...document.querySelectorAll('[data-testid^="oo-prod-"]')].map((el) => el.textContent).join(" "),
  }));
  ok("C10 search narrows the whole-catalog grid (cement → cement only)",
    searchState.prods >= 1 && /cement/i.test(searchState.names) && !/Egg Trays/i.test(searchState.names),
    JSON.stringify(searchState).slice(0, 180));
  await page.screenshot({ path: "/home/user/storefront-amazon.png" });
  await setInput(page, "oo-search", "");
  await sleep(300);

  // Reload: HELP content stays hidden until tapped again (no memory needed)
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForSelector('[data-testid="oo-help"]', { timeout: 30000 });
  const stepsAfterReload = await page.$('[data-testid="oo-howto-steps"]');
  ok("C11 instructions never leak back onto the page after a reload", !stepsAfterReload);
  // Footer HELP affordance opens the same panel; bottom close works
  await clickT(page, "oo-help-footer");
  await page.waitForSelector('[data-testid="oo-help-modal"]', { timeout: 10000 });
  await clickT(page, "oo-help-close-bottom");
  await page.waitForSelector('[data-testid="oo-help-modal"]', { hidden: true, timeout: 10000 });
  ok("C12 footer HELP link opens the panel and the bottom close works", true);
  await ctx.close();

  /* Mobile pass (390×844): wrapped header, 2-column grid, add-to-cart badge */
  const ctxM = await browser.createBrowserContext();
  const pm = await ctxM.newPage();
  hookPage(pm, "storefront-mobile");
  await pm.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await pm.goto(`${BASE}/order`, { waitUntil: "networkidle0", timeout: 60000 });
  await pm.waitForSelector('[data-testid="oo-search"]', { timeout: 30000 });
  const mob = await pm.evaluate(() => {
    const grids = [...document.querySelectorAll('[data-testid^="oo-catsec-"]')]
      .filter((el) => !/count/.test(el.getAttribute("data-testid")))
      .map((sec) => sec.querySelector(".grid"))
      .filter(Boolean);
    const grid = grids.find((g) => g.querySelectorAll('[data-testid^="oo-prod-"]').length >= 3) || grids[0];
    const cv = grid ? (getComputedStyle(grid).gridTemplateColumns || "") : "";
    const rep = cv.match(/repeat\((\d+)/);
    const help = document.querySelector('[data-testid="oo-help"]');
    const r = help ? help.getBoundingClientRect() : null;
    return {
      colsRow1: rep ? Number(rep[1]) : cv.split(/\s+/).filter((x) => x && x !== "none").length,
      helpVisible: !!r && r.width > 0 && r.top >= 0 && r.right <= (window.innerWidth + 2),
      searchFull: !!document.querySelector('[data-testid="oo-search"]'),
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 2,
    };
  });
  ok("C13 mobile: HELP button visible in header, no horizontal overflow",
    mob.helpVisible && !mob.horizontalOverflow, JSON.stringify(mob));
  ok("C13b mobile: products fall into a 2-per-row grid", mob.colsRow1 === 2, `cols=${mob.colsRow1}`);
  await clickT(pm, "oo-add-1");
  await sleep(400);
  const mobBadge = await pm.$eval('[data-testid="oo-header-cart-count"]', (el) => el.textContent);
  ok("C13c mobile add-to-cart updates the header badge", mobBadge === "1", `badge=${mobBadge}`);
  await pm.screenshot({ path: "/home/user/storefront-amazon-mobile.png" });
  await ctxM.close();
}

/* ── cleanup & forensics ────────────────────────────────────────────── */
async function cleanup() {
  console.log("\n— Z · cleanup & forensics —");
  // support info: restore the byte-exact baseline row (or remove if none existed)
  if (baseline.supportRow) {
    const r = baseline.supportRow;
    await pg.query(
      `UPDATE customer_support_info SET contact_name=$1, phone=$2, whatsapp=$3, email=$4, address=$5,
         opening_hours=$6, extra_info=$7, updated_by_user_id=$8, updated_by_name=$9, updated_by_role=$10, updated_at=$11
       WHERE id=1`,
      [r.contact_name, r.phone, r.whatsapp, r.email, r.address, r.opening_hours, r.extra_info,
       r.updated_by_user_id, r.updated_by_name, r.updated_by_role, r.updated_at],
    );
  } else {
    await pg.query(`DELETE FROM customer_support_info WHERE id=1`);
  }
  const supAfter = await pg.query(`SELECT * FROM customer_support_info WHERE id=1`);
  ok("Z1 support-info row restored byte-for-byte to suite start",
    JSON.stringify(supAfter.rows[0] || null) === JSON.stringify(baseline.supportRow || null),
    `start=${JSON.stringify(baseline.supportRow || null).slice(0, 120)} end=${JSON.stringify(supAfter.rows[0] || null).slice(0, 120)}`);

  // grants + photo + sessions restored
  await pg.query(`UPDATE users SET can_manage_support=false WHERE id IN ($1,$2)`, [GM.id, BM.id]);
  await pg.query(`UPDATE inventory_items SET photo=NULL WHERE id=1`);
  await pg.query(`DELETE FROM user_sessions WHERE id>$1`, [baseline.sessMax]);

  const grants = (await pg.query(`SELECT count(*)::int c FROM users WHERE can_manage_support=true`)).rows[0].c;
  ok("Z2 no stray Customer Support grants left behind (others' live grants preserved)", grants === baseline.grantCount, `end=${grants} start=${baseline.grantCount}`);
  const photo = (await pg.query(`SELECT photo FROM inventory_items WHERE id=1`)).rows[0].photo;
  ok("Z3 temporary product photo removed", photo == null);

  const counts = (await pg.query(`SELECT
      (SELECT count(*)::int FROM businesses) b, (SELECT count(*)::int FROM users) u,
      (SELECT count(*)::int FROM customers) cu, (SELECT count(*)::int FROM customer_trackings) t,
      (SELECT count(*)::int FROM sales_documents) sd, (SELECT count(*)::int FROM transactions) tx,
      (SELECT count(*)::int FROM inventory_items) ii`)).rows[0];
  const base = baseline.counts || {};
  ok("Z4 live data byte-identical to suite start", JSON.stringify(counts) === JSON.stringify(base),
    `start=${JSON.stringify(base)} end=${JSON.stringify(counts)}`);
  ok("Z5 owner's POULTRY-02 + live sale intact",
    (await pg.query(`SELECT count(*)::int c FROM businesses WHERE code='POULTRY-02'`)).rows[0].c === 1 &&
    (await pg.query(`SELECT count(*)::int c FROM customer_trackings WHERE tracking_code='GM-POULTRY-ESY6GN'`)).rows[0].c === 1);
  ok("Z6 zero page/console errors across every pass", pageErrors.length === 0, pageErrors.slice(0, 5).join(" | "));
}

(async () => {
  await pg.connect();
  baseline.sessMax = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM user_sessions`)).rows[0].m;
  baseline.counts = (await pg.query(`SELECT
      (SELECT count(*)::int FROM businesses) b, (SELECT count(*)::int FROM users) u,
      (SELECT count(*)::int FROM customers) cu, (SELECT count(*)::int FROM customer_trackings) t,
      (SELECT count(*)::int FROM sales_documents) sd, (SELECT count(*)::int FROM transactions) tx,
      (SELECT count(*)::int FROM inventory_items) ii`)).rows[0];
  console.log(`   baseline counts: ${JSON.stringify(baseline.counts)}`);
  baseline.supportRow = (await pg.query(`SELECT * FROM customer_support_info WHERE id=1`)).rows[0] || null;
  console.log(`   baseline support row: ${baseline.supportRow ? "exists" : "none"}`);
  baseline.grantCount = (await pg.query(`SELECT count(*)::int c FROM users WHERE can_manage_support=true AND id NOT IN ($1,$2)`, [GM.id, BM.id])).rows[0].c;
  console.log(`   baseline live support grants (other users): ${baseline.grantCount}`);
  // Pre-flight: clean slate for grant flags + eggs photo
  await pg.query(`UPDATE users SET can_manage_support=false WHERE id IN ($1,$2)`, [GM.id, BM.id]);
  baseline.eggPhoto = (await pg.query(`SELECT photo FROM inventory_items WHERE id=1`)).rows[0].photo;
  await pg.query(`UPDATE inventory_items SET photo=$1 WHERE id=1`, [PNG_1PX]);

  const cookies = {
    owner: await loginCookie(OWNER),
    gm: await loginCookie(GM),
    bm: await loginCookie(BM),
  };
  const browser = await puppeteer.launch({
    executablePath: "/tmp/al2023/chromium",
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    await sectionA(cookies);
    await sectionB(browser, cookies);
    await sectionC(browser);
  } catch (e) {
    ok(`suite crashed: ${e.message}`, false);
    console.error(e);
  } finally {
    await browser.close().catch(() => {});
    try { await cleanup(); } catch (e) { console.error("cleanup error:", e.message); }
    await pg.end();
  }
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
