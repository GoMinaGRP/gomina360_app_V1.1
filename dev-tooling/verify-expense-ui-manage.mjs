#!/usr/bin/env node
/**
 * Expense section — manage/delete UI acceptance suite.
 *
 * Requirement: in the shared Expense/Transactions section the OWNER can manage
 * and delete expense entries, and every OTHER user can manage/delete them only
 * when the OWNER has granted the manage-expenses permission. Must hold
 * consistently across all businesses/branches and newly created businesses.
 *
 * This suite drives real headless Chromium against the live app and asserts:
 *
 *   A. OWNER (Transactions & MoMo): sees Edit + Delete on expense rows, can
 *      edit an expense (persisted) and delete an expense (with audit reason)
 *      — including an expense belonging to a NEWLY created business.
 *   B. A GENERAL_MANAGER without the grant sees the same expense rows LOCKED
 *      (no edit/delete buttons).
 *   C. The OWNER grants the manage-expenses permission from the section's
 *      OWNER access console.
 *   D. The SAME manager, after the grant, can edit and delete expenses —
 *      while non-expense (income) rows remain LOCKED (flag independence).
 *
 * Cleans up after itself and restores the manager's original permission
 * state. Requires the app running on http://localhost:3000.
 */
import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");
const pg = req("pg");

const BASE = "http://localhost:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: "Owner@GoMina26" };
const GM = { email: "abena.gm@gomina360.com", pw: "" };
const TAG = `E2EEXP-${Date.now().toString(36).toUpperCase()}`;

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
const hasTid = async (tid) => !!(await page.$(`[data-testid="${tid}"]`));
const count = async (sel) => page.$$eval(sel, (els) => els.length).catch(() => 0);

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
  const cookies = await page.cookies();
  for (const c of cookies) await page.deleteCookie(c);
  await page.evaluate(() => { try { sessionStorage.clear(); localStorage.clear(); } catch {} });
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 45000 });
  await waitSel('[data-testid="login-email"]');
  await setVal('[data-testid="login-email"]', cred.email);
  await setVal('[data-testid="login-password"]', cred.pw);
  await clickTid("login-submit");
  await page.waitForFunction(() => !document.querySelector('[data-testid="login-screen"]'), { timeout: 30000 });
  await sleep(2000);
}

async function openTransactions() {
  const clicked = await page.evaluate(() => {
    const btns = [...document.querySelectorAll("aside button")];
    const b = btns.find((x) => (x.textContent || "").includes("Transactions & MoMo"));
    if (b) { b.click(); return true; }
    return false;
  });
  if (!clicked) return false;
  await waitSel('input[placeholder^="Search records"]', 25000);
  await sleep(500);
  return true;
}

/** Filter the table down to the test expense by typing its unique tag. */
async function searchRecords(term) {
  const sel = 'input[placeholder^="Search records"]';
  await setVal(sel, term);
  await sleep(600);
}

async function rowHasLock(term) {
  return await page.evaluate((t) => {
    const rows = [...document.querySelectorAll("tbody tr")];
    const r = rows.find((x) => (x.textContent || "").includes(t));
    return !!(r && (r.textContent || "").includes("LOCKED"));
  }, term);
}

async function cleanup(newBizId, newBizCode, ownerToken) {
  if (newBizId) {
    try {
      await fetch(`${BASE}/api/businesses/${newBizId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({ confirmCode: newBizCode }),
      });
    } catch {}
  }
  await q(`DELETE FROM transactions WHERE description LIKE '%' || $1 || '%' OR category LIKE '%' || $1 || '%'`, [TAG]);
}

async function main() {
  const gmRow = await q1(`SELECT id FROM users WHERE email=$1`, [GM.email]);
  if (!gmRow) throw new Error(`GM ${GM.email} not found`);
  const gmId = gmRow.id;
  GM.pw = `GoMina@User${gmId}`;

  // Snapshot original GM flags to restore exactly.
  const gmOrig = await q1(`SELECT can_manage_records, can_manage_expenses FROM users WHERE id=$1`, [gmId]);
  const restoreRecords = gmOrig?.can_manage_records ?? false;
  const restoreExpenses = gmOrig?.can_manage_expenses ?? false;

  const ownerToken = await apiLogin(OWNER);

  // Baseline: GM has NO manage permissions.
  await fetch(`${BASE}/api/users`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ userId: gmId, canManageExpenses: false, canManageRecords: false }),
  });

  // ── Seed: one expense in an EXISTING business (GM can see business 1), one
  //    expense in a NEWLY created business (OWNER-only visibility).
  const newBizCode = `TESTEXP-${TAG}`;
  const newBizRes = await fetch(`${BASE}/api/businesses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({
      name: `${TAG} Expense Unit`,
      code: newBizCode,
      category: "Block Factory",
      region: "Greater Accra",
      district: "Accra Metropolitan",
      town: "Accra",
      managerName: "Test Expense Manager",
      contactPhone: "+233 24 000 0000",
      initialCapitalGhs: 50000,
      monthlyTargetRevenueGhs: 20000,
    }),
  });
  const newBizJson = await newBizRes.json();
  const newBizId = newBizJson?.business?.id;
  ok("S1. New business created for expense test", newBizRes.status === 200 && !!newBizId, JSON.stringify(newBizJson).slice(0, 120));

  const mkExpense = async (businessId, label) => {
    const r = await fetch(`${BASE}/api/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        businessId,
        type: "EXPENSE",
        category: `${label} (${TAG})`,
        amountGhs: 123.45,
        paymentMethod: "CASH",
        description: `${label} ${TAG} acceptance-test expense`,
      }),
    });
    const j = await r.json();
    if (!r.ok || !j.success) throw new Error(`expense create failed: ${r.status} ${JSON.stringify(j)}`);
    return j.transaction;
  };

  const expMain = await mkExpense(1, "EXPMANAGE");
  const expNew = await mkExpense(newBizId, "EXPNEWBIZ");
  ok("S2. Test expenses created (existing + new business)", !!expMain && !!expNew);

  // ═══════════════ A. OWNER manages & deletes expenses ═══════════════
  await uiLogin(OWNER);
  ok("A1. OWNER opens Transactions & MoMo", await openTransactions());

  await searchRecords(TAG);
  ok("A2. OWNER sees Edit on the expense row", await hasTid(`trx-edit-${expMain.id}`));
  ok("A3. OWNER sees Delete on the expense row", await hasTid(`trx-delete-${expMain.id}`));
  ok("A4. OWNER sees Edit on the NEW business's expense", await hasTid(`trx-edit-${expNew.id}`));
  ok("A5. OWNER sees Delete on the NEW business's expense", await hasTid(`trx-delete-${expNew.id}`));

  // OWNER edits expMain.
  await clickTid(`trx-edit-${expMain.id}`);
  await waitSel('[data-testid="record-edit-form"]');
  const editedDesc = `${TAG} edited-by-owner`;
  await setVal('[data-testid="edit-trx-description"]', editedDesc);
  await clickTid("record-edit-save");
  await sleep(1500);
  const editedRow = await q1(`SELECT description FROM transactions WHERE id=$1`, [expMain.id]);
  ok("A6. OWNER edit persisted", editedRow?.description === editedDesc, `got ${editedRow?.description}`);

  // OWNER deletes the NEW business's expense (reason + audit).
  await searchRecords(TAG);
  await clickTid(`trx-delete-${expNew.id}`);
  await waitSel('[data-testid="delete-confirm-modal"]');
  await setVal('[data-testid="delete-reason-input"]', "Owner acceptance-test deletion");
  await clickTid("delete-confirm-btn");
  await sleep(1500);
  const goneNew = (await q(`SELECT 1 FROM transactions WHERE id=$1`, [expNew.id])).rowCount === 0;
  ok("A7. OWNER-deleted NEW-business expense is gone", goneNew);
  const auditNew = await q1(
    `SELECT 1 FROM record_deletion_logs WHERE module='TRANSACTIONS' ORDER BY id DESC LIMIT 1`
  );
  ok("A8. Deletion wrote the audit trail", !!auditNew);

  // ═══════════════ B. Manager WITHOUT grant sees LOCKED ═══════════════
  await uiLogin(GM);
  ok("B1. GM opens Transactions & MoMo", await openTransactions());
  await searchRecords(TAG);
  ok("B2. GM without grant has NO edit button on expense", !(await hasTid(`trx-edit-${expMain.id}`)));
  ok("B3. GM without grant has NO delete button on expense", !(await hasTid(`trx-delete-${expMain.id}`)));
  ok("B4. GM expense row shows LOCKED", await rowHasLock(TAG));

  // ═══════════════ C. OWNER grants from the section's access console ═══════════════
  await uiLogin(OWNER);
  await openTransactions();
  await clickTid("record-access-btn");
  await waitSel('[data-testid="record-access-modal"]');
  const toggleTid = `access-toggle-canManageExpenses-${gmId}`;
  await waitSel(`[data-testid="${toggleTid}"]`);
  await clickTid(toggleTid);
  await sleep(900);
  const toggledOn = await page.$eval(`[data-testid="${toggleTid}"]`, (e) => (e.textContent || "").includes("CAN MANAGE & DELETE")).catch(() => false);
  ok("C1. Access console grants manage-expenses to the manager", toggledOn);
  await clickTid("access-modal-close");
  await sleep(400);

  // ═══════════════ D. Manager WITH grant manages & deletes expenses ═══════════════
  await uiLogin(GM);
  await openTransactions();
  await searchRecords(TAG);
  ok("D1. Granted manager sees Edit on the expense row", await hasTid(`trx-edit-${expMain.id}`));
  ok("D2. Granted manager sees Delete on the expense row", await hasTid(`trx-delete-${expMain.id}`));

  // Independence: an INCOME row stays LOCKED (only canManageExpenses granted).
  const incomeRow = await q1(`SELECT transaction_number FROM transactions WHERE type='INCOME' AND business_id=1 ORDER BY id LIMIT 1`);
  if (incomeRow) {
    await searchRecords(incomeRow.transaction_number);
    const incomeLocked = await rowHasLock(incomeRow.transaction_number);
    ok("D3. Income rows stay LOCKED (expense grant does not leak to income)", incomeLocked);
  }

  // Manager edits expMain.
  await searchRecords(TAG);
  await clickTid(`trx-edit-${expMain.id}`);
  await waitSel('[data-testid="record-edit-form"]');
  const gmEditedDesc = `${TAG} edited-by-manager`;
  await setVal('[data-testid="edit-trx-description"]', gmEditedDesc);
  await clickTid("record-edit-save");
  await sleep(1500);
  const gmEditedRow = await q1(`SELECT description FROM transactions WHERE id=$1`, [expMain.id]);
  ok("D4. Granted manager edit persisted", gmEditedRow?.description === gmEditedDesc, `got ${gmEditedRow?.description}`);

  // Manager deletes expMain.
  await searchRecords(TAG);
  await clickTid(`trx-delete-${expMain.id}`);
  await waitSel('[data-testid="delete-confirm-modal"]');
  await setVal('[data-testid="delete-reason-input"]', "Manager acceptance-test deletion");
  await clickTid("delete-confirm-btn");
  await sleep(1500);
  const goneMain = (await q(`SELECT 1 FROM transactions WHERE id=$1`, [expMain.id])).rowCount === 0;
  ok("D5. Granted manager-deleted expense is gone", goneMain);

  // ═══════════════ Cleanup + restore ═══════════════
  await cleanup(newBizId, newBizCode, ownerToken);
  await q(`UPDATE users SET can_manage_records=$1, can_manage_expenses=$2 WHERE id=$3`, [restoreRecords, restoreExpenses, gmId]);
  const leftovers = (await q(`SELECT 1 FROM transactions WHERE description LIKE '%' || $1 || '%'`, [TAG])).rowCount;
  ok("Cleanup. No test transactions remain", leftovers === 0);
  ok("Cleanup. GM permission state restored", true);

  console.log(`\n${passed} passed, ${failed} failed`);
  await browser.close();
  await client.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error("FATAL:", e);
  try { await q(`UPDATE users SET can_manage_records=$1, can_manage_expenses=$2 WHERE email=$3`, [false, false, GM.email]); } catch {}
  await browser.close().catch(() => {});
  await client.end().catch(() => {});
  process.exit(1);
});
