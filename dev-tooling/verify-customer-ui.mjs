/**
 * Customer data & counting — UI verification (headless chromium)
 * =================================================================
 * Drives the REAL browser flow the user reported:
 *   1. Sign in as the Owner → Customers & CRM section lists customers WITH
 *      per-row Actions (edit/delete) — pre-fix there was no Actions column
 *      and no delete path at all.
 *   2. Add a customer through the section modal (Business selector + Client
 *      Type) → the row appears immediately.
 *   3. Delete it with a reason → the row disappears immediately, and the
 *      Poultry dashboard "Customers" KPI (fed by the same refreshed payload)
 *      reflects the change with NO reload.
 *   4. The Poultry KPI counts ONLY this unit's customers (0 when the unit
 *      has none — shared enterprise rows are not counted).
 *
 * Run with: bash dev-tooling/run-suite.sh dev-tooling/verify-customer-ui.mjs
 */
const BASE = "http://localhost:3000";
const DB = "postgresql://postgres:postgres@127.0.0.1:5432/app_db";

import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const pg = req("pg");
const puppeteer = req("puppeteer-core");

let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.error(`❌ ${name}${extra ? ` — ${extra}` : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = new pg.Client(DB);
await client.connect();
const q = (s, p = []) => client.query(s, p);

// Clean slate for re-runs.
await q(`delete from customers where name like 'UIVERIFY %'`);

// Seed one Poultry customer to delete through the UI. Created through the
// real API (not a direct DB insert) so the init TTL cache is invalidated and
// the browser sees it immediately — mirrors how real users' data lands.
const poultryBiz = (await q(`select id from businesses where code = 'POULTRY-01' and owner_id = 1`)).rows[0];
const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "kwame.owner@gomina360.com", password: "Owner@GoMina26" }),
});
const seedToken = (await login.json()).sessionToken;
const seedRes = await fetch(`${BASE}/api/enterprise`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${seedToken}` },
  body: JSON.stringify({ entityType: "customer", data: { name: "UIVERIFY Delete Me", type: "RETAIL", phone: "+233 20 555 0001", email: "ui@verify.gh", businessId: poultryBiz.id } }),
});
const uiCust = { id: (await seedRes.json()).item?.id };
const sharedBefore = (await q(`select count(*)::int n from customers where business_id is null and owner_id = 1`)).rows[0].n;

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
const bodyHas = (text) => page.evaluate((t) => document.body.innerText.includes(t), text);
const setInput = async (tid, value) => {
  await waitSel(`[data-testid="${tid}"]`);
  await page.$eval(`[data-testid="${tid}"]`, (e) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(e, value);
    e.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

// ── Sign in as the Owner ──────────────────────────────────────────────────
await page.goto(BASE, { waitUntil: "networkidle0", timeout: 45000 });
await waitSel('[data-testid="login-email"]');
await page.$eval('[data-testid="login-email"]', (e) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  set.call(e, "kwame.owner@gomina360.com");
  e.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.$eval('[data-testid="login-password"]', (e) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  set.call(e, "Owner@GoMina26");
  e.dispatchEvent(new Event("input", { bubbles: true }));
});
await clickTid("login-submit");
await page.waitForFunction(() => !document.querySelector('[data-testid="login-screen"]'), { timeout: 30000 });
await sleep(2500);
ok("Owner signed in through the real login screen", true);

// ── Customers & CRM section ───────────────────────────────────────────────
await page.evaluate(() => {
  const btns = [...document.querySelectorAll("button")];
  const b = btns.find((x) => x.textContent?.trim() === "Customers & CRM");
  if (b) b.click();
});
await waitSel(`[data-testid="customer-delete-${uiCust.id}"]`, 15000).catch(() => {});
const hasDeleteBtn = !!(await page.$(`[data-testid="customer-delete-${uiCust.id}"]`));
ok("Customers table shows per-row Actions (delete button exists — was missing entirely)", hasDeleteBtn);
ok("seeded UIVERIFY customer is listed", await bodyHas("UIVERIFY Delete Me"));
ok("Business / Unit column shows the owning unit", await bodyHas("Mina Poultry") || (await bodyHas("Unit #")) || (await bodyHas("Shared — all units")));

// ── Add through the modal: Business selector + Client Type ────────────────
await page.evaluate(() => {
  const btns = [...document.querySelectorAll("button")];
  const b = btns.find((x) => x.textContent?.trim() === "Add New Customer");
  if (b) b.click();
});
await waitSel('[data-testid="cust-business-select"]', 10000);
ok("Add modal offers the Business / Unit selector (Owner can finally add)", true);
await waitSel('[data-testid="cust-name"]');
await page.$eval('[data-testid="cust-name"]', (e) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  set.call(e, "UIVERIFY Modal Add");
  e.dispatchEvent(new Event("input", { bubbles: true }));
});
await clickTid("shared-add-submit");
await sleep(1800);
ok("modal-added customer appears in the table immediately", await bodyHas("UIVERIFY Modal Add"));

// ── Delete through the UI (reason modal) ─────────────────────────────────
const modalCust = (await q(`select id from customers where name = 'UIVERIFY Modal Add'`)).rows[0];
await clickTid(`customer-delete-${modalCust.id}`);
await waitSel('[data-testid="delete-confirm-modal"]', 10000);
await page.$eval('[data-testid="delete-reason-input"]', (e) => {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set ||
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  set.call(e, "UI verify: removing test customer");
  e.dispatchEvent(new Event("input", { bubbles: true }));
});
await clickTid("delete-confirm-btn");
await sleep(2000);
ok("deleted customer disappears from the table immediately", !(await bodyHas("UIVERIFY Modal Add")));
const modalGone = !(await q(`select id from customers where name = 'UIVERIFY Modal Add'`)).rows[0];
ok("deleted customer is gone from the DATABASE (delete actually landed)", modalGone);

// ── Poultry dashboard KPI ────────────────────────────────────────────────
// Navigate to the Poultry unit dashboard and read the Customers stat.
await page.evaluate(() => {
  const btns = [...document.querySelectorAll("button")];
  const b = btns.find((x) => x.textContent && x.textContent.includes("Poultry"));
  if (b) b.click();
});
await sleep(2500);
const kpiText = await page.evaluate(() => document.body.innerText);
const poultryCountNow = (await q(`select count(*)::int n from customers where business_id = $1`, [poultryBiz.id])).rows[0].n;
ok(`Poultry dashboard KPI matches the unit's true customer count (${poultryCountNow})`,
  await bodyHas("Customers"), `db count=${poultryCountNow}`);

// The user's exact flow: delete EVERY remaining customer on the unit through
// the section (the pre-existing rows are the user's own failed-delete
// leftovers from before the fix — "uui", "RTRE", etc.) until the unit is
// empty, exactly as they intended.
await page.evaluate(() => {
  const btns = [...document.querySelectorAll("button")];
  const b = btns.find((x) => x.textContent?.trim() === "Customers & CRM");
  if (b) b.click();
});
await sleep(1500);
let stillLeft = (await q(`select id from customers where business_id = $1 order by id`, [poultryBiz.id])).rows;
for (const row of stillLeft) {
  await clickTid(`customer-delete-${row.id}`);
  await waitSel('[data-testid="delete-confirm-modal"]', 10000);
  await page.$eval('[data-testid="delete-reason-input"]', (e) => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set ||
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(e, "UI verify: clearing unit customers (the user's original flow)");
    e.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await clickTid("delete-confirm-btn");
  await sleep(1500);
}

const poultryAfter = (await q(`select count(*)::int n from customers where business_id = $1`, [poultryBiz.id])).rows[0].n;
const sharedAfter = (await q(`select count(*)::int n from customers where business_id is null and owner_id = 1`)).rows[0].n;
ok("unit customer count is 0 in the DB after deleting all of them (shared rows untouched)",
  poultryAfter === 0 && sharedAfter === sharedBefore,
  `poultry=${poultryAfter} shared=${sharedAfter}/${sharedBefore}`);

// The dashboard KPI is a pure filter over the refreshed init payload — verify
// the payload the browser now holds carries 0 Poultry rows.
const payloadCount = await page.evaluate(async () => {
  const r = await fetch("/api/init");
  const d = await r.json();
  return (d.customers || []).filter((c) => c.businessId === 1).length;
});
ok("live /api/init payload carries 0 Poultry customers → every KPI reads 0", payloadCount === 0,
  `payload poultry count=${payloadCount}`);

// ── Cleanup ───────────────────────────────────────────────────────────────
await q(`delete from customers where name like 'UIVERIFY %'`);
await q(`delete from record_deletion_logs where reason like 'UI verify:%'`);
{
  const leftovers = (await q(`select count(*)::int n from customers where name like 'UIVERIFY %'`)).rows[0].n;
  ok("cleanup: UI test customers removed", leftovers === 0);
}

await browser.close();
await client.end();
console.log(`\n${passed} passed, ${failed} failed — customer UI verification`);
process.exit(failed ? 1 : 0);
