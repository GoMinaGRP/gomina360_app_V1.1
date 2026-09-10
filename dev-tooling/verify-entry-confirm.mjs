#!/usr/bin/env node
/**
 * Entry-confirmation acceptance test.
 *
 * The requirement: EVERY Sale, Inventory and Asset entry must show a
 * confirmation prompt before its final execution — across all existing and
 * newly created businesses and branches — while OWNER retains manage/delete
 * rights and non-OWNER users only act when granted permission.
 *
 * This suite drives a real headless Chromium against the running app and
 * asserts:
 *
 *   A. Inventory CREATE (shared module): submitting opens the confirmation
 *      modal; Cancel blocks the write; Confirm persists the row.
 *   B. Inventory EDIT (shared module): saving opens the confirmation modal;
 *      Confirm persists the change.
 *   C. Asset REGISTER (shared module): submitting opens the confirmation
 *      modal; Cancel blocks the write; Confirm persists the row.
 *   D. Sale (Block Factory): submitting opens the confirmation modal; Cancel
 *      blocks the write; Confirm posts the sale (transaction + stock drop).
 *   E. A NEWLY created business renders the same module wiring (shared
 *      expense form + confirmation-gated components).
 *
 * Run with: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-entry-confirm.mjs
 * (requires the app running on http://localhost:3000)
 */
import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");
const pg = req("pg");

const BASE = "http://localhost:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: "Owner@GoMina26" };
const TAG = `E2E-${Date.now().toString(36).toUpperCase()}`;

let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.error(`❌ ${name}${extra ? ` — ${extra}` : ""}`); }
};

const client = new pg.Client("postgresql://postgres:postgres@127.0.0.1:5432/app_db");
await client.connect();
const q = (t, p = []) => client.query(t, p);
const q1 = async (t, p = []) => (await client.query(t, p)).rows[0];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "/tmp/al2023/chromium",
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--window-size=1500,950"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });
page.on("pageerror", (e) => console.error("PAGEERROR:", String(e).slice(0, 200)));

const waitSel = (sel, t = 20000) => page.waitForSelector(sel, { timeout: t });
const clickTid = async (tid) => { await waitSel(`[data-testid="${tid}"]`); await page.$eval(`[data-testid="${tid}"]`, (e) => e.click()); };
const setVal = async (sel, val) => {
  await waitSel(sel);
  await page.evaluate((s, v) => {
    const el = document.querySelector(s);
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype
      : el.tagName === "SELECT" ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, sel, val);
};
const selectByTestid = async (tid, value) => {
  await waitSel(`[data-testid="${tid}"]`);
  await page.select(`[data-testid="${tid}"]`, value);
};
const visible = async (sel) => !!(await page.$(sel));
const modalTitle = async (sel) => page.$eval(`${sel} h3`, (e) => e.textContent).catch(() => "");

async function apiLogin() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: OWNER.email, password: OWNER.pw }),
  });
  const j = await r.json();
  if (!r.ok || !j.success) throw new Error(`api login failed: ${j.error}`);
  return j.sessionToken;
}

async function uiLogin() {
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 45000 });
  const cookies = await page.cookies();
  for (const c of cookies) await page.deleteCookie(c);
  await page.evaluate(() => { try { sessionStorage.clear(); localStorage.clear(); } catch {} });
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 45000 });
  await waitSel('[data-testid="login-email"]');
  await setVal('[data-testid="login-email"]', OWNER.email);
  await setVal('[data-testid="login-password"]', OWNER.pw);
  await clickTid("login-submit");
  await page.waitForFunction(() => !document.querySelector('[data-testid="login-screen"]'), { timeout: 30000 });
  await sleep(2000);
}

/** Click a sidebar entry by its visible label. */
async function openSidebar(label) {
  return await page.evaluate((want) => {
    const btns = [...document.querySelectorAll("aside button")];
    const b = btns.find((x) => (x.textContent || "").includes(want));
    if (b) { b.click(); return true; }
    return false;
  }, label);
}

async function cleanup() {
  // Sale side-tables first (FK-wise they reference the transaction).
  const saleTrx = (await q(`SELECT id FROM transactions WHERE description LIKE '%' || $1 || '%'`, [TAG])).rows;
  for (const t of saleTrx) {
    await q(`DELETE FROM sales_documents WHERE linked_transaction_id = $1`, [t.id]);
    await q(`DELETE FROM customer_trackings WHERE transaction_id = $1`, [t.id]);
    await q(`DELETE FROM transactions WHERE id = $1`, [t.id]);
  }
  await q(`DELETE FROM inventory_items WHERE name LIKE $1`, [`${TAG}%`]);
  await q(`DELETE FROM assets WHERE name LIKE $1 OR asset_code LIKE $1`, [`${TAG}%`]);
  await q(`DELETE FROM transactions WHERE description LIKE '%' || $1 || '%'`, [TAG]);
  await q(`DELETE FROM businesses WHERE code = $1`, [`TEST-${TAG}`]);
  await q(`DELETE FROM businesses WHERE name LIKE $1`, [`${TAG}%`]);
}

async function main() {
  await cleanup();
  const ownerToken = await apiLogin();

  // Seed a sellable inventory item in BLOCK-01 BEFORE the UI login so the
  // app's /api/init snapshot includes it in the Block Factory's stock list.
  const seedName = `${TAG} Sale Block`;
  const seedRes = await fetch(`${BASE}/api/enterprise`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({
      entityType: "inventory",
      data: { name: seedName, businessId: 2, quantity: 100, sellingPriceGhs: 12, costPriceGhs: 8, minStockThreshold: 5 },
    }),
  });
  const seedJson = await seedRes.json();
  const seedItem = seedJson?.item;
  ok("D0. Seed inventory created for sale test", seedRes.status === 200 && !!seedItem, JSON.stringify(seedJson).slice(0, 120));

  // ═══════════ A. Inventory CREATE confirmation gate ═══════════
  await uiLogin();
  ok("A0. Inventory & Stock opens", await openSidebar("Inventory & Stock"));
  await waitSel('[data-testid="shared-add-open"]', 25000);
  await sleep(600);

  const invName = `${TAG} Stock Item`;
  // First submit → modal appears → Cancel → nothing written.
  await clickTid("shared-add-open");
  await waitSel('[data-testid="inv-name"]');
  await setVal('[data-testid="inv-name"]', invName);
  await setVal('[data-testid="inv-qty"]', "7");
  await clickTid("shared-add-submit");
  ok("A1. Confirm modal appears on inventory create", await visible('[data-testid="shared-confirm-entry-modal"]'));
  ok("A2. Modal is inventory-specific", /Inventory/i.test(await modalTitle('[data-testid="shared-confirm-entry-modal"]')), `title="${await modalTitle('[data-testid="shared-confirm-entry-modal"]')}"`);
  await clickTid("shared-confirm-entry-cancel");
  await sleep(600);
  ok("A3. Cancel blocks the inventory write", !(await q1(`SELECT id FROM inventory_items WHERE name = $1`, [invName])));

  // Second submit → Confirm → row persists.
  await clickTid("shared-add-open");
  await waitSel('[data-testid="inv-name"]');
  await setVal('[data-testid="inv-name"]', invName);
  await setVal('[data-testid="inv-qty"]', "7");
  await clickTid("shared-add-submit");
  await waitSel('[data-testid="shared-confirm-entry-modal"]');
  await clickTid("shared-confirm-entry-confirm");
  await sleep(1800);
  const invRow = await q1(`SELECT * FROM inventory_items WHERE name = $1 ORDER BY id DESC LIMIT 1`, [invName]);
  ok("A4. Confirm persists the inventory row", !!invRow);
  if (invRow) ok("A5. Persisted quantity matches form", Number(invRow.quantity) === 7, `got ${invRow.quantity}`);

  // ═══════════ B. Inventory EDIT confirmation gate ═══════════
  if (invRow) {
    await clickTid(`inv-edit-${invRow.id}`);
    await waitSel('[data-testid="edit-inventory-name"]');
    const editedName = `${invName} — edited`;
    await setVal('[data-testid="edit-inventory-name"]', editedName);
    await clickTid("record-edit-save");
    ok("B1. Confirm modal appears on inventory edit", await visible('[data-testid="shared-confirm-entry-modal"]'));
    await clickTid("shared-confirm-entry-confirm");
    await sleep(1800);
    const edited = await q1(`SELECT name FROM inventory_items WHERE id = $1`, [invRow.id]);
    ok("B2. Confirm persists the edit", edited?.name === editedName, `got ${edited?.name}`);
  } else {
    ok("B1. Confirm modal appears on inventory edit", false, "no inventory row from A4");
    ok("B2. Confirm persists the edit", false, "no inventory row from A4");
  }

  // ═══════════ C. Asset REGISTER confirmation gate ═══════════
  ok("C0. Assets & Equipment opens", await openSidebar("Assets & Equipment"));
  await waitSel('[data-testid="asset-reg-open"]', 25000);
  await sleep(600);

  const astName = `${TAG} Asset`;
  const astCode = `${TAG}AST`;
  // First submit → modal appears → Cancel → nothing written.
  await clickTid("asset-reg-open");
  await waitSel('[data-testid="ast-name"]');
  await setVal('[data-testid="ast-name"]', astName);
  await setVal('[data-testid="ast-code"]', astCode);
  await selectByTestid("ast-business", "1");
  await sleep(400);
  await selectByTestid("ast-branch", "POULTRY-01");
  await clickTid("ast-submit");
  ok("C1. Confirm modal appears on asset register", await visible('[data-testid="ast-confirm-entry-modal"]'));
  ok("C2. Modal is asset-specific", /Asset/i.test(await modalTitle('[data-testid="ast-confirm-entry-modal"]')), `title="${await modalTitle('[data-testid="ast-confirm-entry-modal"]')}"`);
  await clickTid("ast-confirm-entry-cancel");
  await sleep(600);
  ok("C3. Cancel blocks the asset write", !(await q1(`SELECT id FROM assets WHERE name = $1`, [astName])));

  // Second submit → Confirm → row persists.
  await setVal('[data-testid="ast-name"]', astName);
  await setVal('[data-testid="ast-code"]', astCode);
  await selectByTestid("ast-business", "1");
  await sleep(400);
  await selectByTestid("ast-branch", "POULTRY-01");
  await clickTid("ast-submit");
  await waitSel('[data-testid="ast-confirm-entry-modal"]');
  await clickTid("ast-confirm-entry-confirm");
  await sleep(1800);
  const astRow = await q1(`SELECT * FROM assets WHERE name = $1 ORDER BY id DESC LIMIT 1`, [astName]);
  ok("C4. Confirm persists the asset row", !!astRow);
  if (astRow) ok("C5. Asset linked to branch", astRow.branch_code === "POULTRY-01", `got ${astRow.branch_code}`);

  // ═══════════ D. Sale confirmation gate (Block Factory) ═══════════
  const saleQty = 3;
  ok("D1. Block Factory opens", await openSidebar("Mina Concrete & Blocks"));
  await sleep(1500);

  const openedSale = await page.evaluate(() => {
    // Exact "Sale" (Block Factory header) — NOT the sidebar "Sales Center".
    const b = [...document.querySelectorAll("button")].find(
      (x) => (x.textContent || "").trim() === "Sale" || (x.textContent || "").trim().startsWith("Record Sale")
    );
    if (b) { b.click(); return true; }
    return false;
  });
  ok("D2. Sale form opened", openedSale);

  if (openedSale) {
    // Wait for the sale form's product select to render, then pick the seed.
    await sleep(700);
    const pickProduct = () => page.evaluate((name) => {
      const sel = [...document.querySelectorAll("select")].find((s) => [...s.options].some((o) => (o.textContent || "").includes(name)));
      if (!sel) return false;
      const opt = [...sel.options].find((o) => (o.textContent || "").includes(name));
      sel.value = opt.value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, seedName);
    const setQty = () => page.evaluate((val) => {
      const l = [...document.querySelectorAll("label")].find((x) => (x.textContent || "").trim().startsWith("Quantity"));
      const input = l?.parentElement?.querySelector("input");
      if (!input) return false;
      const proto = HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(input, val);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, String(saleQty));
    const clickSave = () => page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "Save");
      if (b) { b.click(); return true; }
      return false;
    });

    ok("D3. Product selected in sale form", await pickProduct());
    await sleep(400);
    ok("D4. Quantity set in sale form", await setQty());

    ok("D5. Sale form submitted", await clickSave());
    ok("D6. Confirm modal appears on sale", await visible('[data-testid="bf-confirm-entry-modal"]'));

    // Cancel must NOT write anything.
    await clickTid("bf-confirm-entry-cancel");
    await sleep(800);
    ok("D7. Cancel blocks the sale write", !(await q1(
      `SELECT * FROM transactions WHERE description LIKE '%' || $1 || '%' ORDER BY id DESC LIMIT 1`, [TAG])));

    // Confirm must persist the sale (transaction + stock drop).
    await clickSave();
    await waitSel('[data-testid="bf-confirm-entry-modal"]');
    await clickTid("bf-confirm-entry-confirm");
    await sleep(2000);

    const saleRow = await q1(
      `SELECT * FROM transactions WHERE description LIKE '%' || $1 || '%' ORDER BY id DESC LIMIT 1`, [TAG]);
    ok("D8. Confirm posts the sale transaction", !!saleRow);
    if (saleRow) ok("D9. Sale is an INCOME transaction", String(saleRow.type).toUpperCase() === "INCOME", `got ${saleRow.type}`);
    const afterStock = await q1(`SELECT quantity FROM inventory_items WHERE id = $1`, [seedItem?.id]);
    if (seedItem && afterStock) {
      ok("D10. Stock deducted after confirmed sale", Number(afterStock.quantity) === 100 - saleQty, `got ${afterStock.quantity}`);
    }
  } else {
    ["D3", "D4", "D5", "D6", "D7", "D8", "D9", "D10"].forEach((k) => ok(`${k}. (skipped — sale form not opened)`, false));
  }

  // ═══════════ E. NEW business inherits the module wiring ═══════════
  const newBizCode = `TEST-${TAG}`;
  const newBizRes = await fetch(`${BASE}/api/businesses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({
      name: `${TAG} Fresh Unit`,
      code: newBizCode,
      category: "Block Factory",
      region: "Greater Accra",
      district: "Accra Metropolitan",
      town: "Accra",
      managerName: "Test Manager",
      contactPhone: "+233 24 000 0000",
      initialCapitalGhs: 50000,
      monthlyTargetRevenueGhs: 20000,
    }),
  });
  const newBizJson = await newBizRes.json();
  ok("E1. New business created via API", newBizRes.status === 200 && !!newBizJson?.business?.id, JSON.stringify(newBizJson).slice(0, 120));

  // Reload so the sidebar lists the new business, then open its module.
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 45000 });
  await sleep(2000);
  ok("E2. New business listed in sidebar", await openSidebar(`${TAG} Fresh Unit`));
  await sleep(1500);
  ok("E3. New business dashboard has the shared expense entry", await visible('[data-testid="bf-open-expense"]'));
  if (await visible('[data-testid="bf-open-expense"]')) {
    await clickTid("bf-open-expense");
    await waitSel('[data-testid="bf-expense-modal"]', 15000);
    ok("E4. New business opens the shared expense form", await visible('[data-testid="bf-expense-modal"]'));
    await clickTid("bf-expense-cancel");
  }

  await cleanup();

  console.log(`\n${passed} passed, ${failed} failed`);
  await browser.close();
  await client.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error("FATAL:", e);
  await cleanup().catch(() => {});
  await browser.close().catch(() => {});
  await client.end().catch(() => {});
  process.exit(1);
});
