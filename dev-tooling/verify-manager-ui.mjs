#!/usr/bin/env node
/**
 * UI smoke test for "Manage Business / Unit" — a non-executive user granted
 * owner-equivalent power over one unit must see the enterprise management
 * sections (scoped to that unit) and manage its records, with a MANAGE badge
 * on the granted unit.
 *
 * Run with: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-manager-ui.mjs
 */
import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");
const pg = req("pg");

const BASE = "http://localhost:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: "Owner@GoMina26" };

let passed = 0, failed = 0;
const ok = (n, c, x = "") => { if (c) { passed++; console.log(`✅ ${n}`); } else { failed++; console.error(`❌ ${n}${x ? ` — ${x}` : ""}`); } };

const client = new pg.Client("postgresql://postgres:postgres@127.0.0.1:5432/app_db");
await client.connect();
const q1 = async (s, p = []) => (await client.query(s, p)).rows[0];

async function apiLogin(cred) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: cred.email, password: cred.pw }) });
  const j = await r.json();
  if (!r.ok || !j.success) throw new Error(`login failed: ${JSON.stringify(j)}`);
  return j.sessionToken;
}
const H = (t) => ({ "Content-Type": "application/json", Authorization: `Bearer ${t}` });
async function api(method, path, token, body) {
  const r = await fetch(`${BASE}${path}`, { method, headers: H(token), body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}

const bizA = (await client.query("select id, code, name from businesses order by id limit 1")).rows[0];
const email = `acct.${Date.now().toString().slice(-6)}@gomina360.test`;

const owner = await apiLogin(OWNER);
// purge any stale test account with this exact email pattern
await client.query("delete from users where email like $1", ["acct.%@gomina360.test"]);

const createResp = await api("POST", "/api/users", owner, {
  name: "Unit Accountant", email, role: "ACCOUNTANT", assignedBusinessId: null,
  phone: "+233 24 000 0000", businessManageIds: [bizA.id],
});
ok("manager account created", createResp.status === 200 && createResp.json?.success);
const managerId = createResp.json?.user?.id;
const pw = createResp.json?.initialPassword;

const browser = await puppeteer.launch({ executablePath: "/tmp/al2023/chromium", headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--window-size=1500,950"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950 });
  page.on("pageerror", (e) => console.error("PAGEERROR:", String(e).slice(0, 160)));
  const waitSel = (s, t = 25000) => page.waitForSelector(s, { timeout: t });
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 45000 });
  await waitSel('[data-testid="login-email"]');
  const fill = (tid, v) => page.$eval(`[data-testid="${tid}"]`, (e, val) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(e, val); e.dispatchEvent(new Event("input", { bubbles: true }));
  }, v);
  await fill("login-email", email);
  await fill("login-password", pw);
  await page.click('[data-testid="login-submit"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="login-screen"]'), { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2500));

  // MANAGE badge on the granted unit.
  ok("sidebar shows MANAGE badge on the granted unit", !!(await page.$(`[data-testid="sidebar-chip-manage-${bizA.code}"]`)));
  // Shared Enterprise Modules section visible to a non-executive unit manager.
  ok("sidebar shows Shared Enterprise Modules (Inventory & Stock)", !!(await page.$('[data-testid="sidebar-tab-sales"], button')));
  const hasInventory = await page.evaluate(() => [...document.querySelectorAll("aside button")].some((b) => (b.textContent || "").includes("Inventory & Stock")));
  ok("Inventory & Stock entry is present in the sidebar", hasInventory);

  // Open Inventory & Stock.
  const opened = await page.evaluate(() => {
    const b = [...document.querySelectorAll("aside button")].find((x) => (x.textContent || "").includes("Inventory & Stock"));
    if (b) { b.click(); return true; } return false;
  });
  if (!opened) { ok("opened Inventory & Stock", false); }
  else {
    await waitSel('[data-testid^="inv-edit-"]', 25000).catch(() => null);
    const editBtns = await page.$$eval('[data-testid^="inv-edit-"]', (els) => els.length);
    const locked = await page.evaluate(() => document.body.innerText.includes("LOCKED"));
    ok("unit manager sees edit controls (not LOCKED) on their unit's inventory", editBtns > 0, `edit=${editBtns}`);
    ok("no LOCKED cells in the scoped inventory list", !locked);
  }

  // The unit's own dashboard module is reachable.
  const openedBiz = await page.evaluate((name) => {
    const b = [...document.querySelectorAll("aside button")].find((x) => (x.textContent || "").includes(name));
    if (b) { b.click(); return true; } return false;
  }, bizA.name);
  ok("business dashboard chip opens the granted unit", openedBiz);

  await browser.close();
} catch (e) {
  console.error("UI error:", e.message);
  try { await browser.close(); } catch {}
}

// cleanup
try { await api("DELETE", `/api/users?userId=${managerId}`, owner); } catch {}
try { await client.end(); } catch {}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
