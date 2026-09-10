#!/usr/bin/env node
/**
 * Inventory & Stock — UI smoke test for the delete-inventory permission.
 *
 * Confirms in a real headless Chromium that:
 *   A. The OWNER sees per-row Edit + Delete buttons in Inventory & Stock and
 *      the "Manage Access" console button; both the edit modal and the delete
 *      confirmation modal open correctly.
 *   B. A manager WITHOUT the permission sees the same table with LOCKED
 *      badges instead of edit/delete buttons, and no Manage Access button.
 *   C. After the OWNER grants the permission via the module's access console,
 *      the manager's LOCKED badges flip to working Edit/Delete buttons.
 *
 * Run with: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-inventory-ui.mjs
 * (requires the app running on http://localhost:3000)
 */
import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");
const pg = req("pg");

const BASE = "http://localhost:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: "Owner@GoMina26" };
const GM = { email: "abena.gm@gomina360.com", pw: "" };

let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.error(`❌ ${name}${extra ? ` — ${extra}` : ""}`); }
};

const client = new pg.Client("postgresql://postgres:postgres@127.0.0.1:5432/app_db");
await client.connect();
const q1 = async (s) => (await client.query(s)).rows[0];

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
const setVal = async (sel, val) => {
  await waitSel(sel);
  await page.evaluate((s, v) => {
    const el = document.querySelector(s);
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, sel, val);
};
const clickTid = async (tid) => { await waitSel(`[data-testid="${tid}"]`); await page.$eval(`[data-testid="${tid}"]`, (e) => e.click()); };
const count = async (sel) => page.$$eval(sel, (els) => els.length).catch(() => 0);

async function login(cred) {
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 45000 });
  await waitSel('[data-testid="login-email"]');
  await setVal('[data-testid="login-email"]', cred.email);
  await setVal('[data-testid="login-password"]', cred.pw);
  await clickTid("login-submit");
  await page.waitForFunction(() => !document.querySelector('[data-testid="login-screen"]'), { timeout: 30000 });
  await sleep(2000);
}
async function logout() {
  await page.evaluate(() => {
    const el = document.querySelector("header .w-7.h-7.rounded-full");
    (el?.closest("button") || el)?.click();
  });
  await waitSel('[data-testid="logout-btn"]');
  await clickTid("logout-btn");
  await waitSel('[data-testid="login-screen"]');
  await sleep(500);
}
async function openInventory() {
  await page.evaluate(() => {
    [...document.querySelectorAll("aside button")].find((b) => (b.textContent || "").includes("Inventory & Stock"))?.click();
  });
  // Wait for the inventory table (rows carry the inv-row-* testid).
  await page.waitForFunction(
    () => document.querySelector('[data-testid^="inv-row-"]'),
    { timeout: 25000 }
  );
  await sleep(600);
}

// ── Resolve GM credentials ────────────────────────────────────────────────
const gmRow = await q1(`SELECT id, can_delete_inventory FROM users WHERE email='${GM.email}'`);
GM.pw = `GoMina@User${gmRow.id}`;
const gmOriginalFlag = gmRow.can_delete_inventory;

try {
  // ═══ A. OWNER sees edit/delete + Manage Access ════════════════════════
  await login(OWNER);
  await openInventory();

  const editBtns = await count('[data-testid^="inv-edit-"]');
  const delBtns = await count('[data-testid^="inv-delete-"]');
  ok("A1. OWNER sees Edit buttons on inventory rows", editBtns > 0, `${editBtns} edit buttons`);
  ok("A2. OWNER sees Delete buttons on inventory rows", delBtns > 0, `${delBtns} delete buttons`);
  ok("A3. OWNER sees the Manage Access button", (await count('[data-testid="record-access-btn"]')) === 1);

  // Edit modal opens with inventory fields.
  await clickTid(`inv-edit-${(await page.$eval('[data-testid^="inv-edit-"]', (e) => e.getAttribute("data-testid"))).split("-")[2]}`);
  await waitSel('[data-testid="record-edit-form"]');
  ok("A4. Edit modal opens for a stock item", !!(await page.$('[data-testid="edit-inventory-name"]')));
  await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => (b.textContent || "").trim() === "Cancel")?.click(); });
  await sleep(300);

  // Delete confirmation modal opens with the reason field.
  const delTid = await page.$eval('[data-testid^="inv-delete-"]', (e) => e.getAttribute("data-testid"));
  await clickTid(delTid);
  await waitSel('[data-testid="delete-confirm-modal"]');
  ok("A5. Delete confirmation modal opens", !!(await page.$('[data-testid="delete-reason-input"]')));
  await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => (b.textContent || "").trim() === "Cancel")?.click(); });
  await sleep(300);
  await logout();

  // ═══ B. Manager WITHOUT permission sees LOCKED ════════════════════════
  await login(GM);
  await openInventory();
  const gmEdit = await count('[data-testid^="inv-edit-"]');
  const gmDel = await count('[data-testid^="inv-delete-"]');
  const lockedCount = await page.$$eval('span', (els) => els.filter((e) => (e.textContent || "").includes("LOCKED")).length).catch(() => 0);
  ok("B1. Non-permitted manager sees NO edit buttons", gmEdit === 0, `${gmEdit}`);
  ok("B2. Non-permitted manager sees NO delete buttons", gmDel === 0, `${gmDel}`);
  ok("B3. Non-permitted manager sees LOCKED badges", lockedCount > 0, `${lockedCount}`);
  ok("B4. Non-permitted manager has no Manage Access button", (await count('[data-testid="record-access-btn"]')) === 0);

  // ═══ C. OWNER grants permission → LOCKED flips to actions ══════════════
  await logout();
  await login(OWNER);
  await openInventory();
  await clickTid("record-access-btn");
  await waitSel('[data-testid="record-access-modal"]');
  // Toggle the GM (find their row and flip the delete-inventory switch).
  const gmToggleTid = `access-toggle-canDeleteInventory-${gmRow.id}`;
  await waitSel(`[data-testid="${gmToggleTid}"]`);
  await clickTid(gmToggleTid);
  await sleep(800);
  const toggledOn = await page.$eval(`[data-testid="${gmToggleTid}"]`, (e) => (e.textContent || "").includes("CAN MANAGE & DELETE")).catch(() => false);
  ok("C1. Access console toggles delete-inventory permission ON", toggledOn);
  await clickTid("access-modal-close");
  await logout();

  await login(GM);
  await openInventory();
  const gmEdit2 = await count('[data-testid^="inv-edit-"]');
  const gmDel2 = await count('[data-testid^="inv-delete-"]');
  ok("C2. Granted manager now sees Edit buttons", gmEdit2 > 0, `${gmEdit2}`);
  ok("C3. Granted manager now sees Delete buttons", gmDel2 > 0, `${gmDel2}`);
} finally {
  // Restore the GM's original permission and close everything.
  try {
    await q1(`UPDATE users SET can_delete_inventory=${gmOriginalFlag ? "true" : "false"} WHERE id=${gmRow.id}`);
  } catch (e) { console.error("restore error", e.message); }
  await browser.close();
  await client.end();
}

console.log(`\n────────────────────────────────────────`);
console.log(`UI RESULT: ${passed} passed, ${failed} failed`);
console.log(`────────────────────────────────────────`);
process.exit(failed ? 1 : 0);
