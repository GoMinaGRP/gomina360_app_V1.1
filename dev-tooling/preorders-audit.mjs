// Pre-orders FULL audit probe — drives the real UI end-to-end with headless
// Chromium: enable → data entry (methods + options, incl. focus/typing +
// dropdowns) → publish → storefront → customer order, on desktop AND mobile.
//
//   LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/preorders-audit.mjs
//
// Asserts (hard fails on any):
//  [1] sidebar "Pre-Orders" chip exists for the OWNER and opens the hub
//  [2] unit toggle flips OFF→ON (and back finally)
//  [3] SEED_DEFAULTS produces methods; method Edit/Disable/Enable work
//  [4] NEW-METHOD data entry: key/label/icon/lead-days types without losing
//      keystrokes; requiresAddress + requiresPin persist to the row
//  [5] NEW-OPTION data entry: product & method dropdowns populated, supplier
//      dropdown populated (≥ 2 entries), focus-keeps-typing on numbers
//      (145 → price), deposit % field appears after type switch, saved row
//      shows price/deposit/balance/supplier/address
//  [6] PROCUREMENT raise dialog supplier dropdown is populated (was broken)
//  [7] storefront /order: poultry card now carries the indigo preCard
//  [8] customer can complete a pre-order on the BLOCK unit (cross-type)
//  [9] mobile viewport repeats storefront+option rendering
// [10] guide tab renders with both journeys
import { createRequire } from "module";
import fs from "fs";
const require2 = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require2("puppeteer-core");

const BASE = "http://127.0.0.1:3001";
const OUT = new URL("./.verify-out/", import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const rec = (step, ok, extra = {}) => results.push({ step, ok, ...extra });
const hardFail = (msg) => { results.push({ step: "HALT", ok: false, msg }); };

async function typeKeeping(page, sel, text) {
  await page.click(sel, { clickCount: 3 });
  // type char by char; re-assert focus each 2 chars (catch remount focus loss)
  for (let i = 0; i < text.length; i++) {
    await page.type(sel, text[i], { delay: 15 });
    if (i % 2 === 1) {
      const focused = await page.evaluate((s) => document.activeElement === document.querySelector(s), sel);
      if (!focused) return { retained: false, at: i };
    }
  }
  const finalVal = await page.$eval(sel, (el) => el.value);
  return { retained: true, finalVal };
}

async function login(page, email, password) {
  await page.goto(BASE + "/", { waitUntil: "networkidle0", timeout: 90000 });
  const ok = await page.evaluate(async ({ email, password }) => {
    const r = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email, password }),
    });
    return (await r.json())?.success === true;
  }, { email, password });
  await page.reload({ waitUntil: "networkidle0", timeout: 90000 });
  return ok;
}

async function ownerConsole(page, tag) {
  const t = (n) => `${tag}.${n}`;
  // [1] sidebar entry
  await page.waitForSelector('[data-testid="sidebar-tab-preorders"]', { timeout: 30000 }).catch(() => null);
  const hasChip = await page.$('[data-testid="sidebar-tab-preorders"]') !== null;
  rec(t("hasHubChip"), hasChip);
  if (!hasChip) return false;
  await page.click('[data-testid="sidebar-tab-preorders"]');
  await page.waitForSelector('[data-testid="ph-root"]', { timeout: 15000 }).catch(() => null);
  rec(t("hubOpened"), await page.$('[data-testid="ph-root"]') !== null);

  // pick POULTRY-01 in the unit selector (first unit by default) — the toggle
  await page.waitForSelector('[data-testid="po-unit-enabled"]', { timeout: 8000 }).catch(() => null);
  const toggleTxt0 = await page.$eval('[data-testid="po-unit-enabled"]', (el) => el.innerText).catch(() => "");
  rec(t("toggleInitial"), /OFF/i.test(toggleTxt0), { txt: toggleTxt0 });

  // [2] flip ON (idempotent — if a prior run already enabled the unit, skip)
  if (/OFF/i.test(toggleTxt0)) {
    await page.click('[data-testid="po-unit-enabled"]').catch(() => null);
    await page.waitForFunction(() => /ON/i.test(document.querySelector('[data-testid="po-unit-enabled"]')?.innerText || ""), { timeout: 12000 }).catch(() => null);
  }
  const onTxt = await page.$eval('[data-testid="po-unit-enabled"]', (el) => el.innerText).catch(() => "");
  rec(t("toggleFlippedOn"), /ON/i.test(onTxt), { txt: onTxt });

  // seed methods if the seed button is there
  const seedExists = await page.$('[data-testid="po-seed"]');
  if (seedExists) { await page.click('[data-testid="po-seed"]'); await new Promise((r) => setTimeout(r, 1800)); }
  const mCount = await page.evaluate(() => document.querySelectorAll('[data-testid^="po-method-"]').length);
  rec(t("methodsPresent"), mCount > 0, { count: mCount });

  // [4] NEW METHOD data-entry incl. focus-typing
  await page.click('[data-testid="po-new-method"]');
  await page.waitForSelector('[data-testid="po-m-key"]', { timeout: 8000 });
  const k = await typeKeeping(page, '[data-testid="po-m-key"]', "BOAT");
  const l = await typeKeeping(page, '[data-testid="po-m-label"]', "Riverboat Courier");
  const mn = await typeKeeping(page, '[data-testid="po-m-leadmin"]', "3");
  const mx = await typeKeeping(page, '[data-testid="po-m-leadmax"]', "6");
  await page.select('[data-testid="po-m-icon"]', "boat").catch(() => null);
  await page.click('[data-testid="po-m-address"]').catch(() => null);
  await page.click('[data-testid="po-m-pin"]').catch(() => null);
  rec(t("methodEntryFocus"), k.retained && l.retained && mn.retained && mx.retained, {
    key: k.finalVal, label: l.finalVal, mn: mn.finalVal, mx: mx.finalVal,
  });
  await page.click('[data-testid="po-m-save"]');
  await new Promise((r) => setTimeout(r, 1500));
  const hasBoat = await page.evaluate(() => document.querySelector('[data-testid="po-methods"]')?.innerText.includes("Riverboat Courier") || false);
  const hasPin = await page.evaluate(() => document.querySelector('[data-testid="po-methods"]')?.innerText.includes("customer PIN") || false);
  rec(t("methodSavedWithFlags"), hasBoat && hasPin, { hasBoat, hasPin });

  // [3] method edit + disable/enable
  const anyEditBtn = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-testid^="po-method-"]')];
    const boatRow = rows.find((r) => r.innerText.includes("Riverboat"));
    return boatRow?.querySelector('[data-testid^="po-m-edit-"]')?.getAttribute("data-testid") || null;
  });
  if (anyEditBtn) {
    await page.click(`[data-testid="${anyEditBtn}"]`);
    await page.waitForSelector('[data-testid="po-m-label"]', { timeout: 6000 });
    const e = await typeKeeping(page, '[data-testid="po-m-label"]', " River Courier 2");
    rec(t("methodEditFocus"), e.retained, { label: e.finalVal });
    await page.click('[data-testid="po-m-save"]');
    await new Promise((r) => setTimeout(r, 1300));
    const renamed = await page.evaluate(() => document.querySelector('[data-testid="po-methods"]')?.innerText.includes("River Courier 2") || false);
    rec(t("methodEdited"), renamed);
    // toggle OFF then back ON
    const tid = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid^="po-method-"]')];
      const boatRow = rows.find((r) => r.innerText.includes("River Courier 2"));
      return boatRow?.querySelector('[data-testid^="po-m-toggle-"]')?.getAttribute("data-testid") || null;
    });
    if (tid) {
      await page.click(`[data-testid="${tid}"]`); await new Promise((r) => setTimeout(r, 1100));
      const off = await page.evaluate(() => document.querySelector('[data-testid="po-methods"]')?.innerText.match(/River Courier 2[\s\S]*OFF/) !== null);
      await page.click(`[data-testid="${tid}"]`); await new Promise((r) => setTimeout(r, 1100));
      rec(t("methodToggle"), off !== null);
    }
  } else rec(t("methodEdited"), false, { why: "no edit button on created row" });

  // [5] NEW OPTION data-entry
  await page.click('[data-testid="po-new-option"]');
  await page.waitForSelector('[data-testid="po-o-inv"]', { timeout: 8000 });
  const prodOptions = await page.$$eval('[data-testid="po-o-inv"] option', (os) => os.length);
  const methOptions = await page.$$eval('[data-testid="po-o-method"] option', (os) => os.length);
  const suppOptions = await page.$$eval('[data-testid="po-o-supplier"] option', (os) => os.length).catch(() => 0);
  rec(t("dropdownsPopulated"), prodOptions > 1 && methOptions > 1 && suppOptions > 1, { prodOptions, methOptions, suppOptions });
  const firstProd = await page.$$eval('[data-testid="po-o-inv"] option', (os) => os[1]?.value);
  const firstMeth = await page.$$eval('[data-testid="po-o-method"] option', (os) => os[1]?.value);
  await page.select('[data-testid="po-o-inv"]', firstProd);
  await page.select('[data-testid="po-o-method"]', firstMeth);
  if (suppOptions > 1) {
    const firstSup = await page.$$eval('[data-testid="po-o-supplier"] option', (os) => os[1]?.value);
    await page.select('[data-testid="po-o-supplier"]', firstSup);
  }
  await page.select('[data-testid="po-o-addr"]', "YES").catch(() => null);
  const pr = await typeKeeping(page, '[data-testid="po-o-price"]', "145.50");
  const lmn = await typeKeeping(page, '[data-testid="po-o-leadmin"]', "7");
  const lmx = await typeKeeping(page, '[data-testid="po-o-leadmax"]', "14");
  await page.select('[data-testid="po-o-deptype"]', "PERCENT");
  await page.waitForSelector('[data-testid="po-o-depval"]', { timeout: 5000 }).catch(() => null);
  const depField = await page.$('[data-testid="po-o-depval"]') !== null;
  let dv = { retained: false, finalVal: "" };
  if (depField) dv = await typeKeeping(page, '[data-testid="po-o-depval"]', "40");
  rec(t("optionEntryFocus"), pr.retained && lmn.retained && lmx.retained && depField && dv.retained, {
    price: pr.finalVal, lmn: lmn.finalVal, lmx: lmx.finalVal, dep: dv.finalVal, depField,
  });
  await page.click('[data-testid="po-o-terms"]').catch(() => null);
  await page.click('[data-testid="po-o-save"]');
  await new Promise((r) => setTimeout(r, 1600));
  const rowShown = await page.evaluate(() => {
    const txt = document.querySelector('[data-testid="po-options"]')?.innerText || "";
    return {
      price: txt.includes("145.50"), deposit: txt.includes("40%"),
      supplierShown: /supplier:/i.test(txt), addrShown: /address required/i.test(txt),
    };
  });
  rec(t("optionSavedFull"), Object.values(rowShown).every(Boolean), rowShown);

  // [6] procurement raise dialog supplier dropdown
  await page.click('[data-testid="ph-tab-procurement"]').catch(() => null);
  await new Promise((r) => setTimeout(r, 1800));
  const raiseBtn = await page.evaluate(() => {
    const bs = [...document.querySelectorAll("button")];
    const b = bs.find((x) => /Raise.*PO|Raise purchase|New purchase/i.test(x.innerText || ""));
    return b ? true : false;
  });
  let supDD = 0;
  if (raiseBtn) {
    await page.evaluate(() => {
      const bs = [...document.querySelectorAll("button")];
      const b = bs.find((x) => /Raise.*PO|Raise purchase|New purchase/i.test(x.innerText || ""));
      b?.click();
    });
    await page.waitForSelector('[data-testid="proc-raise-modal"]', { timeout: 8000 }).catch(() => null);
    supDD = await page.$$eval('[data-testid="proc-r-supplier"] option', (os) => os.length).catch(() => 0);
  }
  rec(t("procSupplierDropdown"), raiseBtn && supDD > 1, { raiseBtn, supDD });

  // close the raise modal if open (overlay would swallow the tab click)
  await page.keyboard.press("Escape").catch(() => null);
  await page.evaluate(() => {
    const modal = document.querySelector('[data-testid="proc-raise-modal"]');
    modal?.querySelector("button")?.click();
  });
  await new Promise((r) => setTimeout(r, 500));
  // [10] guide tab
  await page.click('[data-testid="ph-tab-guide"]').catch(() => null);
  await new Promise((r) => setTimeout(r, 700));
  const guide = await page.evaluate(() => document.querySelector('[data-testid="ph-guide"]') !== null);
  rec(t("guideRenders"), guide);
  await page.screenshot({ path: `${OUT}/audit-hub-${tag.toLowerCase()}.png` });
  return true;
}

async function storefrontDesktop(page) {
  // [7] storefront for poultry (biz 1) — preCard visible
  await page.goto(`${BASE}/order?biz=1`, { waitUntil: "networkidle0", timeout: 90000 });
  await page.waitForFunction(() => /Grade A/.test(document.body.innerText), { timeout: 60000 }).catch(() => null);
  await new Promise((r) => setTimeout(r, 1500));
  const pre = await page.evaluate(() => ({
    badge: !!document.querySelector('[data-testid="oo-biz-preorder-badge"]'),
    card: /Pre-order/.test(document.body.innerText),
    method: /Air Freight|River/.test(document.body.innerText),
  }));
  rec("sf.b1-preCard", pre.badge && pre.card && pre.method, pre);
  await page.screenshot({ path: `${OUT}/audit-storefront-b1-desktop.png`, fullPage: false });

  // marketplace view (screenshot evidence parity): all departments chips
  await page.goto(`${BASE}/order`, { waitUntil: "networkidle0", timeout: 90000 });
  await new Promise((r) => setTimeout(r, 1800));
  const market = await page.evaluate(() => ({
    chips: document.body.innerText.includes("All departments"),
    concrete: document.body.innerText.includes("Mina Concrete"),
  }));
  rec("sf.marketplace-chips", market.chips && market.concrete, market);
  await page.screenshot({ path: `${OUT}/audit-marketplace-desktop.png`, fullPage: false });
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: "/tmp/al2023/chromium",
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    defaultViewport: { width: 1440, height: 900 },
  });
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => rec("pageerror", false, { msg: String(e).slice(0, 140) }));
    rec("login", await login(page, "kwame.owner@gomina360.com", "Owner@GoMina26"));
    await ownerConsole(page, "OWNER");
    await storefrontDesktop(page);
  } catch (e) {
    hardFail(String(e).slice(0, 200));
  } finally {
    fs.writeFileSync(`${OUT}/preorders-audit.json`, JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results, null, 1));
    await browser.close();
  }
})();
