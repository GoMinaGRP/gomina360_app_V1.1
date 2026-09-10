#!/usr/bin/env node
/**
 * Focus/typing regression + expense-permission UI smoke test.
 *
 * Verifies in a real headless Chromium that:
 *   A. Text fields that previously lost cursor/focus after every keystroke
 *      (the inline <I>/<S> component bug) now keep their value AND focus while
 *      the user types — tested on the Car Wash expense form's "Category" and
 *      "Description" fields (rendered by the now-stable FormField/FormSelect).
 *   B. The OWNER's Users & Access console exposes the new
 *      "Manage, edit & delete expenses" permission toggle.
 *
 * Run with: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-focus-ui.mjs
 * (requires the app running on http://localhost:3000)
 */
import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");
const pg = req("pg");

const BASE = "http://localhost:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: "Owner@GoMina26" };

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

async function login(cred) {
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 45000 });
  await waitSel('[data-testid="login-email"]');
  await page.type('[data-testid="login-email"]', cred.email);
  await page.type('[data-testid="login-password"]', cred.pw);
  await clickTid("login-submit");
  await page.waitForFunction(() => !document.querySelector('[data-testid="login-screen"]'), { timeout: 30000 });
  await sleep(2000);
}

/** Type into a field one keystroke at a time and assert value + focus survive. */
async function assertTypingSurvives(testid, text, label) {
  await waitSel(`[data-testid="${testid}"]`);
  await page.$eval(`[data-testid="${testid}"]`, (el) => {
    el.focus();
    // Clear any existing value first (React controlled inputs need a real input event).
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.type(`[data-testid="${testid}"]`, text, { delay: 30 });
  const state = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return {
      value: el?.value,
      isActive: document.activeElement === el,
      testid: el?.getAttribute("data-testid"),
    };
  }, `[data-testid="${testid}"]`);
  ok(`${label}: full text kept (value matches typed)`, state.value === text, `got "${state.value}"`);
  ok(`${label}: cursor/focus retained after typing`, state.isActive === true, `activeElement=${state.testid}`);
}

async function main() {
  const gmRow = await q1(`SELECT id FROM users WHERE role='GENERAL_MANAGER' ORDER BY id LIMIT 1`);
  const gmId = gmRow?.id;

  // ═══ A. Typing keeps value + focus (Car Wash shared expense form) ═════════
  await login(OWNER);
  const openedCarWash = await clickSidebarButton("Express Auto Wash");
  ok("A1. Owner opened the Car Wash business dashboard", openedCarWash, "sidebar button not found");
  await waitSel('[data-testid="carwash-module"]', 30000);
  await clickTid("cw-open-expense");
  await waitSel('[data-testid="cw-expense-description"]', 20000);
  ok("A2. Car Wash shared expense form opened (Description field present)", true);

  await assertTypingSurvives("cw-expense-description", "Fuel for generator service", "A3. Expense Description");
  await assertTypingSurvives("cw-expense-vendor", "Shell filling station", "A4. Expense Vendor / Payee");

  // "+ Add New" category flow — the new-category input must also keep focus.
  await clickTid("cw-expense-add-category");
  await waitSel('[data-testid="cw-expense-cat-modal"]', 10000);
  ok("A5. Add New Expense Category modal opened", true);
  await assertTypingSurvives("cw-expense-cat-name", "Generator Maintenance", "A6. New Category Name");

  // ═══ B. Users & Access console exposes the expense permission toggle ════
  // Back to Command Center, then open Users & Access.
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('[data-testid="nav-sidebar"] button')];
    const b = btns.find((x) => (x.textContent || "").includes("Command Center"));
    if (b) b.click();
  });
  await sleep(1200);
  await waitSel('[data-testid="open-user-access"]', 20000);
  await clickTid("open-user-access");
  await waitSel('[data-testid="user-access-console"]', 20000);
  ok("B1. Users & Access console opened", true);

  // Open a non-owner user's edit form and assert the new toggle is present.
  let toggleSeen = false;
  if (gmId) {
    await waitSel(`[data-testid="user-edit-${gmId}"]`, 20000);
    await clickTid(`user-edit-${gmId}`);
    await waitSel('[data-testid="user-edit-form"]', 20000);
    toggleSeen = !!(await page.$('[data-testid="perm-expense-manage"]'));
    ok("B2. 'Manage, edit & delete expenses' toggle present in user edit form", toggleSeen);
  } else {
    ok("B2. 'Manage, edit & delete expenses' toggle present in user edit form", false, "no GM found to edit");
  }

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
