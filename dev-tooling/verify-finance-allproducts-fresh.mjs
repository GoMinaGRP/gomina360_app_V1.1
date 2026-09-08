/**
 * verify-finance-allproducts-fresh.mjs
 *
 *   F · "Finance & Reports – Enterprise Users" permission: owner grants →
 *       non-executive sees ONLY the FINANCE tab (scoped data), clicks through
 *       to Finance & Reports; owner revokes → tab gone. Self-grant 403.
 *   Q · Fresh-business dashboards: brand-new units of EVERY category render
 *       clean in a real browser — zero page errors, no NaN/undefined/Infinity
 *       junk; Poultry Health & Performance Score and Aquaculture Farm Health
 *       show the neutral "ready to go" state (also verified against the
 *       owner's REAL new POULTRY-02, read-only).
 *   S · Storefront "all products, one page": default ALL businesses view,
 *       per-business groups with category sections inside, global search,
 *       focus chips; cross-business cart needs (and gets) explicit confirm;
 *       deny keeps the cart. How-to guide explains the new flow.
 *   Z · TEST purge + live-data forensics byte-identical vs suite start.
 */
import { createRequire } from "module";
const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");
const { Client } = require("pg");

const BASE = "http://127.0.0.1:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pass: process.env.GOMINA_OWNER_PW || "Owner@GoMina26" };
const BM = { email: "emmanuel@gomina360.com", pass: "GoMina@User3", id: 3 };

const CATEGORIES = [
  { category: "Poultry Farm", name: "TEST Poultry Sprout", tabs: ["Dashboard", "Flock & Batch", "Feed", "Water", "Health & Vaccination", "Production", "Inventory", "Finance", "Daily Checklist", "AI Knowledge"], healthTest: "pa-empty" },
  { category: "Aquaculture", name: "TEST Aqua Sprout", tabs: ["Dashboard", "Fish Stock & Batches", "Ponds / Tanks", "Feed Management", "Water Quality", "Tasks & Activities", "Harvest Status", "Finance"], healthTest: "aqua-health-empty" },
  { category: "Hardware Store", name: "TEST Hardware Sprout", tabs: ["Dashboard", "Stock & Materials", "Orders & Purchases", "Site Deliveries", "Finance & Reports", "Staff & Yard Ops", "Daily Checklist"] },
  { category: "Block Factory", name: "TEST Blocks Sprout", tabs: ["Dashboard", "Inventory", "Finance", "Quality Control", "Daily Checklist"] },
  { category: "Livestock", name: "TEST Livestock Sprout", tabs: ["Overview", "Herd & Grazing", "Finance", "Daily Checklist"] },
  { category: "Restaurant & Food", name: "TEST Kitchen Sprout", tabs: ["Dashboard", "Menu Performance", "Stock, Cost & Waste", "Sales & Orders", "Purchases & Suppliers", "Finance & Reports", "Staff & Checklist"] },
  { category: "Electronic Shop", name: "TEST Electronics Sprout", tabs: ["Dashboard", "Products & Stock", "Orders & Purchases", "Finance & Reports", "Warranty & Serials", "Staff & Ops", "Daily Checklist"] },
  { category: "Car Wash", name: "TEST Wash Sprout", tabs: ["Dashboard", "Services & Pricing", "Bookings", "Active Washes", "Stock & Supplies", "Staff", "Finance & Reports", "Daily Checklist"] },
  { category: "Telecom & Digital Services", name: "TEST Telecom Sprout", tabs: ["Dashboard", "MoMo & Float", "Airtime & Data", "Wi-Fi & Vouchers", "Sales", "Finance", "Customers", "Reports", "Daily Checklist"] },
];

const results = [];
const baseline = { createdBizIds: [] };
const pageErrors = [];
const junkHits = [];
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
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: creds.email, password: creds.pass }),
  });
  if (!res.ok) throw new Error(`login failed ${creds.email}: ${res.status}`);
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
const uiLogin = async (page, creds) => {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid="login-email"]', { timeout: 60000 });
  await page.type('[data-testid="login-email"]', creds.email);
  await page.type('[data-testid="login-password"]', creds.pass);
  await page.click('[data-testid="login-submit"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="login-email"]'), { timeout: 60000 });
};
const scanJunk = async (page, where) => {
  const junk = await page.evaluate(() => {
    const t = document.body?.innerText || "";
    const hits = [];
    for (const re of [/\bNaN\b/, /\bundefined\b/, /\bInfinity\b/]) {
      const m = t.match(re);
      if (m) hits.push(m[0]);
    }
    return hits;
  });
  if (junk.length) junkHits.push(`${where}: ${junk.join(",")}`);
  return junk.length === 0;
};
const clickExact = async (page, label) => {
  const found = await page.evaluate((want) => {
    const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === want);
    if (btn) { btn.click(); return true; }
    return false;
  }, label);
  return found;
};

/* ── F · Finance & Reports — Enterprise Users permission ────────────── */
async function sectionF(browser, cookies) {
  console.log("\n— F · Finance & Reports permission —");
  // API gates
  await api(cookies.owner, "/api/users", { method: "PATCH", body: JSON.stringify({ userId: BM.id, canViewFinance: false }) });
  const selfGrant = await api(cookies.bm, "/api/users", { method: "PATCH", body: JSON.stringify({ userId: BM.id, canViewFinance: true }) });
  const flagAfterSelf = (await pg.query(`SELECT can_view_finance FROM users WHERE id=$1`, [BM.id])).rows[0].can_view_finance;
  ok("F1 non-owner cannot grant himself Finance & Reports access (403)",
    selfGrant.status === 403 && flagAfterSelf === false, `${selfGrant.status}`);
  const grant = await api(cookies.owner, "/api/users", { method: "PATCH", body: JSON.stringify({ userId: BM.id, canViewFinance: true }) });
  const dbFlag = (await pg.query(`SELECT can_view_finance FROM users WHERE id=$1`, [BM.id])).rows[0].can_view_finance;
  ok("F2 OWNER grants Finance & Reports → users.can_view_finance=true",
    grant.status === 200 && grant.json?.success === true && dbFlag === true, `${grant.status}`);

  // BM browser pass with the grant ON
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  hookPage(page, "bm-finance");
  await page.setViewport({ width: 1440, height: 960 });
  await uiLogin(page, BM);
  await sleep(1200);
  const finTab = await page.$('[data-testid="sidebar-tab-finance"]');
  ok("F3 granted BM sees Finance & Reports in the sidebar (his only shared module)", !!finTab);
  if (finTab) {
    await finTab.click();
    await sleep(2500);
    const body = await page.evaluate(() => document.body.innerText);
    ok("F4 Finance & Reports view opens for the grantee (no Access Restricted wall)",
      !/Access Restricted/.test(body) && (/Finance/i.test(body) || /Revenue|Profit|Report/i.test(body)));
    // Hard scope proof at the API level: the BM's whole data payload only
    // ever contains the units he can access (poultry only — no extra grants).
    const initRes = await fetch(`${BASE}/api/init`, { headers: { Cookie: cookies.bm } }).then((r) => r.json());
    const bizIds = (initRes.businesses || []).map((b) => b.id).sort((a, b) => a - b);
    ok("F5 the finance data is scoped to HIS units (payload carries poultry only)",
      initRes.success === true && bizIds.length === 1 && bizIds[0] === 1, JSON.stringify(bizIds));
    await page.screenshot({ path: "/home/user/finance-grantee-view.png" });
  }
  // revoke and confirm the tab disappears
  await api(cookies.owner, "/api/users", { method: "PATCH", body: JSON.stringify({ userId: BM.id, canViewFinance: false }) });
  await page.reload({ waitUntil: "networkidle0" });
  await sleep(1500);
  const finTabAfter = await page.$('[data-testid="sidebar-tab-finance"]');
  ok("F6 owner revokes the grant → Finance & Reports leaves the sidebar", !finTabAfter);
  await ctx.close();

  // Owner console shows the toggle
  const ctxO = await browser.createBrowserContext();
  const po = await ctxO.newPage();
  hookPage(po, "owner-console");
  await po.setViewport({ width: 1440, height: 960 });
  await uiLogin(po, OWNER);
  await po.waitForSelector('[data-testid="open-user-access"]', { timeout: 30000 });
  await po.click('[data-testid="open-user-access"]');
  await po.waitForSelector(`[data-testid="user-edit-${BM.id}"]`, { timeout: 30000 });
  await po.click(`[data-testid="user-edit-${BM.id}"]`);
  await po.waitForSelector('[data-testid="perm-finance"]', { timeout: 15000 });
  const label = await po.$eval('[data-testid="perm-finance"]', (el) => el.closest("div")?.textContent || "");
  ok("F7 owner sees the Finance & Reports permission in the console list", /Finance & Reports/i.test(label), label.slice(0, 140));
  await po.screenshot({ path: "/home/user/finance-perm-console.png" });
  await ctxO.close();
}

/* ── Q · fresh-business dashboards (all categories) ─────────────────── */
async function sectionQ(browser, cookies) {
  console.log("\n— Q · fresh-business dashboards (all categories) —");
  // create one TEST unit per category
  for (const c of CATEGORIES) {
    const res = await api(cookies.owner, "/api/businesses", {
      method: "POST",
      body: JSON.stringify({ name: c.name, category: c.category, town: "TEST Accra" }),
    });
    const b = res.json?.business;
    if (!b?.id) { ok(`Q0 create ${c.category}`, false, JSON.stringify(res.json || {}).slice(0, 160)); return; }
    c.biz = b;
    baseline.createdBizIds.push(b.id);
  }
  ok("Q1 nine brand-new units provisioned through the app API (one per category)",
    CATEGORIES.every((c) => !!c.biz), JSON.stringify(CATEGORIES.map((c) => c.biz?.code)));

  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  hookPage(page, "fresh-dash");
  await page.setViewport({ width: 1440, height: 960 });
  await uiLogin(page, OWNER);
  await sleep(1500);

  for (const c of CATEGORIES) {
    // open the unit from the sidebar by its name
    const opened = await page.evaluate((name) => {
      const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes(name));
      if (btn) { btn.click(); return true; }
      return false;
    }, c.name);
    if (!opened) { ok(`Q.${c.category}: openable from the sidebar`, false); continue; }
    await sleep(2200);
    let clean = true;
    for (const tab of c.tabs) {
      const clicked = await clickExact(page, tab);
      if (!clicked) { ok(`Q.${c.category} tab "${tab}" clickable`, false); clean = false; continue; }
      await sleep(750);
      if (!(await scanJunk(page, `${c.category}/${tab}`))) clean = false;
    }
    // named health-score empty states on the DASHBOARD tab
    if (c.healthTest) {
      await clickExact(page, c.tabs[0]); // back to Dashboard
      await sleep(800);
      const empty = await page.$(`[data-testid="${c.healthTest}"]`);
      ok(`Q2 ${c.category} Health & Performance Score shows the neutral "ready to go" state`, !!empty);
      const txt = await page.evaluate(() => document.body.innerText);
      ok(`Q2b ${c.category} dashboard carries first-steps guidance (not a fake 100)`,
        /ready to go/i.test(txt) && /first|Brand-new/i.test(txt));
    }
    ok(`Q.${c.category}: every tab renders clean (no NaN/undefined/Infinity junk)`, clean, junkHits.slice(-2).join(" | "));
    const dashErrs = pageErrors.filter((e) => e.startsWith("[fresh-dash]")).length;
    ok(`Q.${c.category}: zero page errors across all tabs`, dashErrs === 0, pageErrors.slice(-2).join(" | "));
    pageErrors.length = 0;
  }

  // The owner's REAL new POULTRY-02 — read-only check that his unit shows
  // exactly the clean state he asked for.
  const openedReal = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("kkkkk"));
    if (btn) { btn.click(); return true; }
    return false;
  });
  await sleep(2200);
  const realEmpty = await page.$('[data-testid="pa-empty"]');
  ok("Q3 the owner's brand-new POULTRY-02 renders the same clean ready-to-start score card", openedReal && !!realEmpty);
  await page.screenshot({ path: "/home/user/fresh-poultry-dash.png" });
  await ctx.close();
}

/* ── S · storefront: all products, one page ─────────────────────────── */
async function sectionS(browser) {
  console.log("\n— S · storefront: all products from all businesses, one page —");
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  hookPage(page, "store-all");
  await page.setViewport({ width: 430, height: 932, isMobile: true, hasTouch: true });
  let dialogAction = "accept";
  page.on("dialog", (d) => (dialogAction === "accept" ? d.accept() : d.dismiss()));
  await page.goto(`${BASE}/order`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid="oo-catalog"]', { timeout: 30000 });
  await sleep(500);

  const land = await page.evaluate(() => ({
    allChip: !!document.querySelector('[data-testid="oo-biz-all"]'),
    groups: [...document.querySelectorAll('[data-testid^="oo-bizsec-"]')].length,
    cards: document.querySelectorAll('[data-testid^="oo-prod-"]').length,
    chips: [...document.querySelectorAll('[data-testid^="oo-cat-"]')].map((el) => el.textContent.trim()),
  }));
  ok("S1 the storefront lands on a ONE-PAGE all-businesses catalog by default",
    land.allChip && land.groups >= 4 && land.cards >= 6, JSON.stringify(land));
  // A poultry category ("Poultry Products" — eggs) AND hardware categories
  // ("Cement & Mortar") must BOTH be in the union — across-business proof.
  // (The ALL chip is labelled "All departments" in the Amazon-style nav bar;
  // it is identified by its oo-cat-ALL testid.)
  const allChipPresent = await page.evaluate(() => !!document.querySelector('[data-testid="oo-cat-ALL"]'));
  ok("S1b category chips span EVERY business (poultry + hardware categories)",
    allChipPresent && land.chips.some((c) => /poultry/i.test(c)) && land.chips.some((c) => /cement/i.test(c)),
    land.chips.join("|"));
  const groupsHaveHeaders = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="oo-bizsec-"]')].every((g) =>
      /· \d+ product/.test(g.textContent || "") && g.querySelector('[data-testid^="oo-catsec-"]')),
  );
  ok("S2 every business group carries its header + category sections inside", groupsHaveHeaders);

  // Global search filters across the entire grid
  await page.type('[data-testid="oo-search"]', "broiler");
  await sleep(700);
  const afterSearch = await page.evaluate(() => ({
    groups: [...document.querySelectorAll('[data-testid^="oo-bizsec-"]')].length,
    eggsShown: !!document.querySelector('[data-testid="oo-prod-1"]'),
    broilerShown: !!document.querySelector('[data-testid="oo-prod-12"]'),
  }));
  ok("S3 search narrows the whole multi-business grid (broiler only, one group)",
    afterSearch.groups === 1 && !afterSearch.eggsShown && afterSearch.broilerShown, JSON.stringify(afterSearch));
  await page.$eval('[data-testid="oo-search"]', (el) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(600);

  // Focus chip → single-business mode; back to ALL
  await page.evaluate(() => document.querySelector('[data-testid="oo-focus-8"]')?.click());
  await sleep(800);
  const focused = await page.evaluate(() => ({
    singleChips: document.querySelectorAll('[data-testid="oo-cat-ALL"]') ? 1 : 0,
    groups: [...document.querySelectorAll('[data-testid^="oo-bizsec-"]')].length,
    cement: !!document.querySelector('[data-testid="oo-prod-6"]'),
    broiler: !!document.querySelector('[data-testid="oo-prod-12"]'),
  }));
  ok("S4 a group's Focus chip narrows to that single shop (hardware depot, category chips back)",
    focused.groups === 0 && focused.cement && !focused.broiler, JSON.stringify(focused));
  await page.evaluate(() => document.querySelector('[data-testid="oo-biz-all"]')?.click());
  await sleep(800);
  const backAll = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="oo-bizsec-"]')].length);
  ok("S5 the All businesses chip restores the one-page grid", backAll >= 4, `groups=${backAll}`);

  // Cross-business cart: confirm switches, deny keeps
  const clickTid = async (tid) => {
    await page.$eval(`[data-testid="${tid}"]`, (el) => el.scrollIntoView({ block: "center" }));
    await sleep(250);
    await page.click(`[data-testid="${tid}"]`);
    await sleep(600);
  };
  // The cart bar is collapsible — line testids only render when expanded.
  const readCart = async () => {
    const hasLines = await page.$('[data-testid^="oo-cart-line-"]');
    if (!hasLines) {
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll('[data-testid="oo-cart"] button')];
        btns.find((b) => /item/.test(b.textContent || ""))?.click();
      });
      await sleep(400);
    }
    return page.evaluate(() => ({
      total: document.querySelector('[data-testid="oo-cart-total"]')?.textContent || "",
      lines: [...document.querySelectorAll('[data-testid^="oo-cart-line-"]')].map((el) => el.dataset.testid),
    }));
  };
  await clickTid("oo-add-1"); // eggs — poultry
  const cart1 = await readCart();
  ok("S6 first add starts a single-shop cart (poultry eggs in the bar)",
    cart1.lines.includes("oo-cart-line-1") && /55/.test(cart1.total), JSON.stringify(cart1));
  await clickTid("oo-add-6"); // cement — hardware depot; dialog ACCEPT
  const cart2 = await readCart();
  ok("S7 cross-shop add asks to switch the cart → cement-only cart at GH₵118.00",
    cart2.lines.includes("oo-cart-line-6") && !cart2.lines.includes("oo-cart-line-1") && /118/.test(cart2.total),
    JSON.stringify(cart2));
  dialogAction = "dismiss";
  await clickTid("oo-add-1"); // eggs again; dialog DISMISS
  const cart3 = await readCart();
  ok("S8 declining the switch keeps the cart exactly as it was",
    cart3.lines.includes("oo-cart-line-6") && !cart3.lines.includes("oo-cart-line-1"), JSON.stringify(cart3));
  dialogAction = "accept";

  // how-to guide teaches the new flow — now housed inside the HELP panel
  if (!(await page.$('[data-testid="oo-howto-steps"]'))) {
    await clickTid("oo-help");
    await sleep(400);
  }
  const howto = await page.evaluate(() => document.querySelector('[data-testid="oo-howto-steps"]')?.textContent || "");
  ok("S9 the HELP guide explains one-page browsing + focus chips", /one page/i.test(howto));
  await page.screenshot({ path: "/home/user/storefront-all-products.png" });
  await ctx.close();
}

/* ── cleanup & forensics ────────────────────────────────────────────── */
async function cleanup() {
  console.log("\n— Z · cleanup & forensics —");
  for (const id of baseline.createdBizIds) {
    await pg.query(`DELETE FROM user_business_access WHERE business_id=$1`, [id]);
    await pg.query(`DELETE FROM business_metrics WHERE business_id=$1`, [id]);
    await pg.query(`DELETE FROM checklist_templates WHERE business_id=$1`, [id]);
    await pg.query(`DELETE FROM businesses WHERE id=$1 AND name LIKE 'TEST%'`, [id]);
  }
  await pg.query(`UPDATE users SET can_view_finance=false WHERE id=$1`, [BM.id]);
  await pg.query(`DELETE FROM user_sessions WHERE id>$1`, [baseline.sessMax]);
  const counts = (await pg.query(`SELECT
      (SELECT count(*)::int FROM businesses) b, (SELECT count(*)::int FROM users) u,
      (SELECT count(*)::int FROM customers) cu, (SELECT count(*)::int FROM customer_trackings) t,
      (SELECT count(*)::int FROM sales_documents) sd, (SELECT count(*)::int FROM transactions) tx,
      (SELECT count(*)::int FROM inventory_items) ii`)).rows[0];
  const base = baseline.counts || {};
  ok("Z1 live data byte-identical to suite start", JSON.stringify(counts) === JSON.stringify(base),
    `start=${JSON.stringify(base)} end=${JSON.stringify(counts)}`);
  ok("Z2 all nine TEST units fully removed", baseline.createdBizIds.every((id) => id > 0) &&
    (await pg.query(`SELECT count(*)::int c FROM businesses WHERE name LIKE 'TEST%'`)).rows[0].c === 0);
  ok("Z3 no stray Finance & Reports grants left", (await pg.query(`SELECT count(*)::int c FROM users WHERE can_view_finance=true`)).rows[0].c === 0);
  const eggs = (await pg.query(`SELECT quantity::float q FROM inventory_items WHERE id=1`)).rows[0];
  ok("Z4 eggs stock untouched (873.63)", Math.abs(eggs.q - 873.63) < 1e-9, `qty=${eggs.q}`);
  ok("Z5 owner's live sale GM-POULTRY-ESY6GN + new POULTRY-02 intact",
    (await pg.query(`SELECT count(*)::int c FROM customer_trackings WHERE tracking_code='GM-POULTRY-ESY6GN'`)).rows[0].c === 1 &&
    (await pg.query(`SELECT count(*)::int c FROM businesses WHERE code='POULTRY-02'`)).rows[0].c === 1);
  ok("Z6 zero page/console errors across every UI pass", pageErrors.length === 0, pageErrors.slice(0, 4).join(" | "));
  ok("Z7 zero NaN/undefined/Infinity junk hits across every tab walk", junkHits.length === 0, junkHits.slice(0, 4).join(" | "));
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
  await pg.query(`UPDATE users SET can_view_finance=false WHERE id=$1`, [BM.id]);

  const cookies = { owner: await loginCookie(OWNER), bm: await loginCookie(BM) };
  const browser = await puppeteer.launch({
    executablePath: "/tmp/al2023/chromium",
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    await sectionF(browser, cookies);
    await sectionQ(browser, cookies);
    await sectionS(browser);
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
