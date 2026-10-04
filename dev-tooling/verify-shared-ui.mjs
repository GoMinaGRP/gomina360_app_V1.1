#!/usr/bin/env node
/**
 * P2 — shared UI surfaces acceptance test.
 *
 * Verifies, in a real headless Chromium, that the consolidated forms really are
 * the ones the modules render and that nothing regressed:
 *
 *   A. Sales & Payments
 *      - the duplicate "Financial Report" tab is gone (the report lives in
 *        Finance & Reports, once, for both scopes)
 *      - the Customers sub-tab uses the shared quick-add form (data-testid
 *        custq-*), creates a real tenant-bound customer row, and offers the
 *        deep link into the full Customers & CRM module
 *      - the Inventory sub-tab offers the deep link into Inventory & Stock
 *   B. The five module "new stock item" forms all render the single shared
 *      field grid (data-testid inv-item-fields) with their own wording, and the
 *      hardware one still creates a correctly-normalized inventory row.
 *   C. No new page errors.
 *
 * Self-cleaning: every row it creates is prefixed TEST-SUI and deleted on exit.
 *
 * Run (app on :3000):  bash dev-tooling/run-suite.sh dev-tooling/verify-shared-ui.mjs
 */
import { createRequire } from "node:module";
import { revealAllUnits } from "./rail-util.mjs";
import fs from "node:fs";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");
const pg = req("pg");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.GOMINA_OWNER_PW || "Owner@GoMina26" };
const OUT = new URL("./.verify-out/", import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
};

const client = new pg.Client(process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db");
await client.connect();
const q1 = async (s, p = []) => (await client.query(s, p)).rows[0];

const mod = req("@sparticuz/chromium");
const chromium = mod.default ?? mod;
const browser = await puppeteer.launch({
  executablePath: await chromium.executablePath(),
  args: [...(chromium.args || []), "--no-sandbox", "--disable-setuid-sandbox"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950, deviceScaleFactor: 1 });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e.message || e).slice(0, 160)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = 90000;
const waitSel = (sel, t = T) => page.waitForSelector(sel, { timeout: t });
const clickTid = async (tid, t = T) => { await waitSel(`[data-testid="${tid}"]`, t); await page.$eval(`[data-testid="${tid}"]`, (e) => e.click()); };
const setVal = async (sel, val) => {
  await waitSel(sel);
  await page.evaluate((s, v) => {
    const el = document.querySelector(s);
    const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, sel, val);
};
const bodyText = () => page.evaluate(() => document.querySelector("main")?.innerText || "");
const clickByText = async (text, scope = "button") => {
  const hit = await page.evaluate((t, sc) => {
    const els = [...document.querySelectorAll(sc)];
    const el = els.find((e) => (e.textContent || "").trim().toLowerCase() === t.toLowerCase());
    if (el) { el.click(); return true; }
    return false;
  }, text, scope);
  return hit;
};
const waitFor = async (fn, t = 15000, arg = undefined) => {
  const end = Date.now() + t;
  while (Date.now() < end) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true;
    await sleep(400);
  }
  return false;
};

async function login() {
  for (let i = 0; i < 3; i++) {
    try {
      await page.goto(`${BASE}/?login=1`, { waitUntil: "domcontentloaded", timeout: T });
      await waitSel('[data-testid="login-email"]', T);
      await page.type('[data-testid="login-email"]', OWNER.email);
      await page.type('[data-testid="login-password"]', OWNER.pw);
      await page.click('[data-testid="login-submit"]');
      await waitSel('[data-testid="nav-sidebar"]', T);
      return true;
    } catch {
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      await sleep(3000);
    }
  }
  return false;
}

const STAMP = Date.now().toString().slice(-7);
const CUST_NAME = `TEST-SUI Buyer ${STAMP}`;
const ITEM_NAME = `TEST-SUI Material ${STAMP}`;

async function purge() {
  await client.query(`DELETE FROM inventory_items WHERE name LIKE 'TEST-SUI%'`).catch(() => {});
  await client.query(`DELETE FROM customers WHERE name LIKE 'TEST-SUI%'`).catch(() => {});
}

try {
  await purge();
  console.log("══ A. Sales & Payments ══");
  ok("owner session", await login());
  await sleep(3500);

  // Open the Sales & Payments module from the sidebar (executive scope).
  const openedSales = await clickTid("sidebar-tab-sales", 25000).then(() => true).catch(() => false);
  ok("A1. Sales & Payments opens", openedSales);
  await waitFor(() => !!document.querySelector('[data-testid="bm-tab-newsale"],[data-testid^="bm-tab-"]'), 25000);
  await sleep(800);

  const tabLabels = await page.$$eval('[data-testid^="bm-tab-"]', (els) => els.map((e) => (e.textContent || "").trim()));
  ok("A2. duplicate Financial Report tab is gone", !tabLabels.some((l) => /financial report/i.test(l)), tabLabels.join(", "));
  ok("A3. the real sales tabs are still present", tabLabels.some((l) => /new sale/i.test(l)) && tabLabels.some((l) => /customers/i.test(l)) && tabLabels.some((l) => /inventory/i.test(l)));

  // ── Customers sub-tab → shared quick-add form ──
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('[data-testid^="bm-tab-"]')].find((x) => /customers/i.test(x.textContent || ""));
    b?.click();
  });
  await waitSel('[data-testid="custq-name"]', 25000);
  ok("A4. Customers sub-tab renders the shared quick-add form (custq-*)", true);
  ok("A5. quick-add keeps the name/phone/type contract", !!(await page.$('[data-testid="custq-phone"]')) && !!(await page.$('[data-testid="custq-type"]')));

  await setVal('[data-testid="custq-name"]', CUST_NAME);
  await setVal('[data-testid="custq-phone"]', "+233 24 555 0001");
  await clickTid("custq-submit");
  const created = await waitFor(
    (name) => !!document.querySelector("main")?.innerText.includes(name),
    20000, CUST_NAME
  );
  ok("A6. customer created through the shared form appears immediately", created);
  const custRow = await q1(`SELECT id, business_id, type, phone FROM customers WHERE name = $1`, [CUST_NAME]);
  ok("A7. row persisted to the DATABASE", !!custRow?.id);
  ok("A8. row is tenant-bound (business_id set)", !!custRow?.business_id, String(custRow?.business_id));
  ok("A9. type + phone from the shared payload contract", custRow?.type === "RETAIL" && String(custRow?.phone || "").includes("555 0001"), JSON.stringify(custRow));

  // ── Deep links into the canonical modules ──
  ok("A10. \"Full Customers & CRM\" shortcut offered to the owner", !!(await page.$('[data-testid="bm-open-crm"]')));
  await clickTid("bm-open-crm");
  const inCrm = await waitFor(() => {
    const t = document.querySelector("main")?.innerText || "";
    return /Customers & CRM/i.test(t) || !!document.querySelector('[data-testid="cust-name"]');
  }, 25000);
  ok("A11. shortcut lands on the real Customers & CRM module", inCrm);

  // Back to Sales & Payments → Inventory shortcut
  await clickTid("sidebar-tab-sales", 25000).catch(() => {});
  await waitFor(() => !!document.querySelector('[data-testid^="bm-tab-"]'), 25000);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('[data-testid^="bm-tab-"]')].find((x) => /inventory/i.test(x.textContent || ""));
    b?.click();
  });
  await sleep(1200);
  ok("A12. \"Inventory & Stock\" shortcut offered to the owner", !!(await page.$('[data-testid="bm-open-inventory"]')));
  await clickTid("bm-open-inventory");
  const inInv = await waitFor(() => !!document.querySelector('[data-testid^="inv-row-"]'), 25000);
  ok("A13. shortcut lands on the real Inventory & Stock module", inInv);

  // ── B. the five module item forms ──
  console.log("══ B. module \"new stock item\" forms ══");
  const MODULES = [
    { code: "HARDWARE-01", tab: "Stock & Materials", button: "New Material", btnTid: "hw-stock-new-item" },
    { code: "TECH-01", tab: "Products & Stock", button: "New Product" },
    { code: "FOOD-01", tab: "Stock, Cost & Waste", button: "New Item" },
    { code: "BLOCK-01", tab: "Inventory", button: "New Item" },
  ];
  for (const m of MODULES) {
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: T }).catch(() => {});
    await waitSel('[data-testid="nav-sidebar"]', T);
    await sleep(1500);
    await revealAllUnits(page);
    await clickTid(`sidebar-biz-${m.code}`, 20000).catch(() => {});
    await sleep(2600);
    await clickByText(m.tab).catch(() => {});
    await sleep(1200);
    const opened = m.btnTid
      ? await clickTid(m.btnTid, 15000).then(() => true).catch(() => false)
      : await clickByText(m.button).catch(() => false);
    if (!opened) await clickByText(m.button).catch(() => {});
    await sleep(900);
    const grid = !!(await page.$('[data-testid="inv-item-fields"]'));
    ok(`B.${m.code} renders the shared item-field grid`, grid);
    if (m.code === "HARDWARE-01") {
      ok("B.HARDWARE-01 keeps its hwf-* field ids", !!(await page.$('[data-testid="hwf-name"]')) && !!(await page.$('[data-testid="hwf-category"]')));
      await setVal('[data-testid="hwf-name"]', ITEM_NAME);
      await setVal('[data-testid="hwf-category"]', "Cement & Mortar");
      await setVal('[data-testid="hwf-quantity"]', "7");
      await setVal('[data-testid="hwf-costPriceGhs"]', "10");
      await setVal('[data-testid="hwf-sellingPriceGhs"]', "14.5");
      await clickTid("hwf-submit", 20000).catch(() => {});
      // The shared entry-confirmation gate asks once before stock moves.
      await clickTid("hw-confirm-entry-confirm", 8000).catch(() => {});
      const saved = await waitFor((n) => !!document.querySelector('[data-testid^="inv-row-"]') && (document.querySelector("main")?.innerText || "").includes(n), 25000, ITEM_NAME);
      const row = await q1(`SELECT id, business_id, quantity, category, subcategory, cost_price_ghs, selling_price_ghs FROM inventory_items WHERE name = $1`, [ITEM_NAME]);
      ok("B.HARDWARE-01 item saved through the shared form", !!row?.id, saved ? "ui" : "no ui echo");
      ok("B.HARDWARE-01 posted the expected numbers", Number(row?.quantity) === 7 && Number(row?.cost_price_ghs) === 10 && Number(row?.selling_price_ghs) === 14.5, JSON.stringify(row));
      ok("B.HARDWARE-01 category normalized by the shared taxonomy", row?.category === "Building Materials" && row?.subcategory === "Cement & Mortar", `${row?.category} / ${row?.subcategory}`);
    }
    if (m.code === "FOOD-01") {
      ok("B.FOOD-01 keeps its restaurant-specific expiry field", !!(await page.$('[data-testid="inv-item-fields"] input[type="date"]')));
      const labels = await page.$$eval('[data-testid="inv-item-fields"] label', (els) => els.map((e) => (e.textContent || "").trim()));
      ok("B.FOOD-01 hides the retail selling price", !labels.some((l) => /selling price/i.test(l)), labels.join(" | "));
    }
    await page.screenshot({ path: `${OUT}shared-ui-${m.code}.png` }).catch(() => {});
    // close the modal before the next module
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(400);
  }

  // ── C. anti-duplication guard (the point of the phase) ──
  console.log("══ C. no re-duplication in the source tree ══");
  const fsx = fs;
  const gridDefs = [];
  const formPairDefs = [];
  const quickAddDefs = [];
  const walk = (dir) => {
    for (const e of fsx.readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) {
        const t = fsx.readFileSync(p, "utf8");
        if (t.includes('data-testid="inv-item-fields"')) gridDefs.push(p);
        // the old duplicate: each module owned the number-coercion + input markup
        if (!p.includes("/shared/") && t.includes('set(k, t === "number"')) formPairDefs.push(p);
        if (t.includes("@client.gh")) quickAddDefs.push(p);
      }
    }
  };
  walk("src");
  ok("C1. exactly one item-field grid definition", gridDefs.length === 1 && /InventoryItemFields/.test(gridDefs[0]), gridDefs.join(", "));
  const MODULE_FILES = ["HardwareStoreModule", "ElectronicsShopModule", "RestaurantKitchenModule", "BlockFactoryModule", "BusinessDashboardModule"];
  const wired = MODULE_FILES.filter((m) => fsx.readFileSync(`src/components/${m}.tsx`, "utf8").includes("InventoryItemFields"));
  ok("C2. all five module item forms use it", wired.length === 5, wired.join(", "));
  ok("C3. the five modules no longer hand-roll the field pair", formPairDefs.length === 0, formPairDefs.join(", "));
  const FIELD_MODULES = [...MODULE_FILES, "CarWashModule", "TelecomServicesModule", "PoultryFarmModule", "AquacultureModule"];
  const fieldWired = FIELD_MODULES.filter((m) => /ModuleFormFields/.test(fsx.readFileSync(`src/components/${m}.tsx`, "utf8")));
  ok("C4. every module routes through the shared field pair", fieldWired.length === 9, `${fieldWired.length}/9`);
  ok("C5. only ONE customer quick-add implementation exists", quickAddDefs.length === 1 && /CustomerQuickAddForm/.test(quickAddDefs[0]), quickAddDefs.join(", "));

  console.log("══ D. hygiene ══");
  const realErrors = pageErrors.filter((e) => !/ResizeObserver/.test(e));
  ok("D1. no page errors during the run", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));
} finally {
  await purge();
  await browser.close();
  await client.end();
}

console.log(`\n══ verify-shared-ui (P2): ${pass} passed, ${fail} failed ══`);
process.exit(fail ? 1 : 0);
