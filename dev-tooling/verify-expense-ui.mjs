#!/usr/bin/env node
/**
 * Shared "Record Expense Information" UI acceptance test.
 *
 * Verifies in a real headless Chromium that the Poultry-Farm-style expense
 * form is wired into EVERY business module and branch, with the same fields
 * and functionality everywhere:
 *
 *   A. The shared expense dialog opens in every specialized module with the
 *      full field set (category dropdown + "+ Add New", amount, payment,
 *      date, vendor, description, receipt upload, take-photo, auto-tracking,
 *      submit/cancel).
 *   B. End-to-end submit: a Car Wash expense flows through /api/transactions
 *      and lands in the DB with the right category/amount/branch linkage.
 *   C. "+ Add New" category creation works and persists per business/branch.
 *   D. The Worker dashboard uses the same shared form (worker gate honored).
 *   E. A NEWLY created business (Telecom) automatically gets the shared form.
 *
 * Run with: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-expense-ui.mjs
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
const clickSidebarButton = async (text) => {
  const clicked = await page.evaluate((want) => {
    const btns = [...document.querySelectorAll('[data-testid="nav-sidebar"] button')];
    const b = btns.find((x) => (x.textContent || "").includes(want));
    if (b) { b.click(); return true; }
    return false;
  }, text);
  return clicked;
};

async function apiLogin(cred) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: cred.email, password: cred.pw }),
  });
  const j = await r.json();
  if (!r.ok || !j.success) throw new Error(`api login failed ${cred.email}: ${j.error}`);
  return j.sessionToken;
}

async function uiLogin(cred) {
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 45000 });
  // Drop any prior session (httpOnly cookie + sessionStorage bridge) so the
  // sign-in wall shows instead of booting straight into the previous user.
  const cookies = await page.cookies();
  for (const c of cookies) await page.deleteCookie(c);
  await page.evaluate(() => {
    try { sessionStorage.clear(); localStorage.clear(); } catch { /* ignore */ }
  });
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 45000 });
  await waitSel('[data-testid="login-email"]');
  await page.type('[data-testid="login-email"]', cred.email);
  await page.type('[data-testid="login-password"]', cred.pw);
  await clickTid("login-submit");
  await page.waitForFunction(() => !document.querySelector('[data-testid="login-screen"]'), { timeout: 30000 });
  await sleep(2000);
}

/** Assert the full shared expense field set exists for a given testid prefix. */
async function assertSharedFormFields(prefix) {
  const fields = ["category", "amount", "payment", "date", "vendor", "description",
    "receipt-upload", "receipt-photo", "add-category", "submit", "cancel"];
  let all = true, missing = [];
  for (const f of fields) {
    const present = !!(await page.$(`[data-testid="${prefix}-${f}"]`));
    if (!present) { all = false; missing.push(`${prefix}-${f}`); }
  }
  const tracking = await page.evaluate(() =>
    [...document.querySelectorAll("div")].some((d) => (d.textContent || "").includes("Automatic tracking")));
  return { all, missing, tracking };
}

/** Open a module's expense dialog via its sidebar label + open-button testid. */
async function openModuleExpense(bizLabel, openTid, prefix) {
  const opened = await clickSidebarButton(bizLabel);
  ok(`opened "${bizLabel}" dashboard`, opened, "sidebar button not found");
  await sleep(1200);
  await clickTid(openTid);
  await waitSel(`[data-testid="${prefix}-modal"]`, 20000);
}

async function main() {
  const ownerToken = await apiLogin(OWNER);

  // ═══ E (setup). Create a NEW Telecom business so we can prove new units ══
  // automatically receive the shared expense form.
  let newBizId = null, newBizCode = `TEST-${TAG}`;
  const newBizRes = await fetch(`${BASE}/api/businesses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({
      name: `${TAG} Telecom Unit`,
      code: newBizCode,
      category: "Telecom & Digital Services",
      region: "Greater Accra",
      district: "Accra Metropolitan",
      town: "Accra",
      managerName: "Test Telecom Manager",
      contactPhone: "+233 24 000 0000",
      initialCapitalGhs: 50000,
      monthlyTargetRevenueGhs: 20000,
    }),
  });
  const newBizJson = await newBizRes.json();
  newBizId = newBizJson?.business?.id;
  ok("E1. New Telecom business created via API", newBizRes.status === 200 && !!newBizId, JSON.stringify(newBizJson));

  // ═══ A. Shared form opens with full field set in every specialized module ══
  await uiLogin(OWNER);

  const MODULES = [
    { biz: "Mina Concrete & Blocks", open: "bf-open-expense", prefix: "bf-expense", key: "BlockFactory" },
    { biz: "Mina Tech & Electronics Hub", open: "tec-open-expense", prefix: "tec-expense", key: "ElectronicsShop" },
    { biz: "Mina Heritage Kitchen", open: "kit-open-expense", prefix: "kit-expense", key: "RestaurantKitchen" },
    { biz: "Mina Express Auto Wash", open: "cw-open-expense", prefix: "cw-expense", key: "CarWash" },
    { biz: "GoMina Hardware & Building Materials Depot", open: "hw-open-expense", prefix: "hw-expense", key: "HardwareStore" },
    { biz: "Mina Volta Tilapia & Catfish", open: "aqua-open-expense", prefix: "aqua-expense", key: "Aquaculture" },
    { biz: "Mina Cattle & Small Ruminants", open: "lk-open-expense", prefix: "lk-expense", key: "Livestock" },
  ];

  for (const m of MODULES) {
    await openModuleExpense(m.biz, m.open, m.prefix);
    const { all, missing, tracking } = await assertSharedFormFields(m.prefix);
    ok(`A. ${m.key} shared expense form has all fields`, all, `missing ${missing.join(", ")}`);
    ok(`A. ${m.key} shows Automatic tracking info`, tracking);
    await clickTid(`${m.prefix}-cancel`);
    await sleep(400);
  }

  // ═══ E2. New Telecom business → TelecomServicesModule shared form ═══
  if (newBizId) {
    await openModuleExpense(`${TAG} Telecom Unit`, "tel-open-expense", "tel-expense");
    const { all, missing } = await assertSharedFormFields("tel-expense");
    ok("E2. Newly created Telecom business uses the shared expense form", all, `missing ${missing.join(", ")}`);
    await clickTid("tel-expense-cancel");
    await sleep(400);
  }

  // ═══ B. End-to-end submit (Car Wash) flows to /api/transactions ═══
  await openModuleExpense("Mina Express Auto Wash", "cw-open-expense", "cw-expense");
  await page.select('[data-testid="cw-expense-category"]', "Detergents & Chemicals");
  await page.type('[data-testid="cw-expense-amount"]', "123.45");
  await page.type('[data-testid="cw-expense-vendor"]', "Chemico E2E Vendor");
  await page.type('[data-testid="cw-expense-description"]', `${TAG} shared form e2e`);
  await clickTid("cw-expense-submit");
  await sleep(2500); // wait for POST + refresh
  const washBiz = (await q(`SELECT id, code FROM businesses WHERE code='WASH-01'`)).rows[0];
  const row = (await q(
    `SELECT * FROM transactions WHERE description LIKE '%' || $1 || '%' AND type='EXPENSE' ORDER BY id DESC LIMIT 1`,
    [TAG]
  )).rows[0];
  ok("B1. Expense POSTed to /api/transactions (row exists)", !!row);
  if (row) {
    ok("B2. Expense linked to WASH-01 branch", row.branch_code === washBiz.code, `got ${row.branch_code}`);
    ok("B3. Category persisted", row.category === "Detergents & Chemicals", `got ${row.category}`);
    ok("B4. Amount persisted", Number(row.amount_ghs) === 123.45, `got ${row.amount_ghs}`);
    ok("B5. receipt_images column present (null when no photos)", row.receipt_images === null, `got ${JSON.stringify(row.receipt_images)}`);
    // cleanup this test row
    await q(`DELETE FROM transactions WHERE id = $1`, [row.id]);
  }

  // ═══ C. "+ Add New" category creation persists per business/branch ═══
  const catName = `${TAG} Category`;
  await openModuleExpense("GoMina Hardware & Building Materials Depot", "hw-open-expense", "hw-expense");
  await clickTid("hw-expense-add-category");
  await waitSel('[data-testid="hw-expense-cat-modal"]', 10000);
  await page.type('[data-testid="hw-expense-cat-name"]', catName);
  await clickTid("hw-expense-cat-save");
  await sleep(1500);
  const catRow = (await q(`SELECT * FROM expense_categories WHERE name = $1`, [catName])).rows[0];
  ok("C1. New category persisted to expense_categories", !!catRow);
  if (catRow) {
    ok("C2. Category scoped to the Hardware business", Number(catRow.business_id) === (await q(`SELECT id FROM businesses WHERE code='HARDWARE-01'`)).rows[0].id);
    const inDropdown = await page.evaluate((name) => {
      const sel = document.querySelector('[data-testid="hw-expense-category"]');
      return sel ? [...sel.options].some((o) => o.value === name) : false;
    }, catName);
    ok("C3. New category appears in the dropdown", inDropdown);
    await q(`DELETE FROM expense_categories WHERE id = $1`, [catRow.id]);
  }
  await clickTid("hw-expense-cancel");
  await sleep(400);

  // ═══ D. Worker dashboard uses the same shared expense form ═══
  const worker = (await q(
    `SELECT id, email FROM users WHERE role='WORKER' AND can_record_expenses = true AND is_worker_enabled = true ORDER BY id LIMIT 1`
  )).rows[0];
  ok("D1. Found a worker with canRecordExpenses", !!worker);
  if (worker) {
    await uiLogin({ email: worker.email, pw: `GoMina@User${worker.id}` });
    await waitSel('[data-testid="worker-open-expense"]', 30000);
    ok("D2. Worker sees Record Expense button", true);
    await clickTid("worker-open-expense");
    await waitSel('[data-testid="worker-expense-modal"]', 20000);
    const { all, missing } = await assertSharedFormFields("worker-expense");
    ok("D3. Worker expense form has the full shared field set", all, `missing ${missing.join(", ")}`);
    await clickTid("worker-expense-cancel");
  }

  // ═══ Cleanup ═══
  if (newBizId) {
    const del = await fetch(`${BASE}/api/businesses/${newBizId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ confirmCode: newBizCode }),
    });
    const dj = await del.json().catch(() => ({}));
    ok("Cleanup. New Telecom test business removed", del.status === 200 || dj?.success, `status ${del.status}`);
  }
  const leftover = (await q(`SELECT id FROM transactions WHERE description LIKE '%' || $1 || '%'`, [TAG])).rows;
  ok("Cleanup. No E2E transactions remain", leftover.length === 0);

  await browser.close();
  await client.end();
  console.log(`\n────────────────────────────────────────`);
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log(`────────────────────────────────────────`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error("FATAL:", e);
  try { await browser.close(); } catch { /* ignore */ }
  try { await client.end(); } catch { /* ignore */ }
  process.exit(2);
});
