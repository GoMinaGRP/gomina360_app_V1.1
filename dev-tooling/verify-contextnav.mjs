// Live verification of the restored right-side Navigation & Location panel:
// "you are here" (Section / Business / Branch / Page) on every destination,
// context-sensitive quick navigation, sibling-unit jump chips, collapsible
// rail on wide desktop, slide-in drawer + compact context bar on tablet and
// phone — tested with real data (incl. a TEST business created & purged),
// across desktop, tablet and phone viewports, with zero page errors.
// Run: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-contextnav.mjs

import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");
const pg = req("pg");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const SHOT = (n) => `/home/user/ctx-${n}.png`;
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.OWNER_PW || "Owner@GoMina26" };
const AKUA = { email: "akua.donkor@gomina360.com", pw: process.env.AKUA_PW || "GoMina@User10" };

const checks = [];
let failures = 0;
const ok = (name, cond, extra = "") => { checks.push({ name, pass: !!cond }); if (!cond) failures++; console.log(`${cond ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`); };

const client = new pg.Client(process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db");
await client.connect();
const q = async (sql) => (await client.query(sql)).rows;
const q1 = async (sql) => (await q(sql))[0];

// Owner API session for TEST business create/delete
const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: OWNER.email, password: OWNER.pw }),
}).then((r) => r.json());
const H = { "Content-Type": "application/json", "x-gomina-session": loginRes.sessionToken };
const api = async (path, method = "GET", body) => {
  const r = await fetch(`${BASE}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};

const pageErrors = [];
const browser = await puppeteer.launch({ executablePath: "/tmp/al2023/chromium", headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--window-size=1500,950"] });
const page = await browser.newPage();
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") { const t = m.text(); if (!/401|Failed to load resource|net::ERR_/.test(t)) pageErrors.push(t); } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitSel = (sel, timeout = 15000) => page.waitForSelector(sel, { timeout });
const textOf = async (sel) => page.$eval(sel, (e) => e.textContent || "").catch(() => "");
const has = async (sel, needle) => (await textOf(sel)).toLowerCase().includes(needle.toLowerCase());
const visible = async (sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0 && r.height > 0; }).catch(() => false);
const widthOf = async (sel) => page.$eval(sel, (el) => el.getBoundingClientRect().width).catch(() => 0);
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
const clickBizButton = async (nameFrag) => page.evaluate((t) => {
  const el = [...document.querySelectorAll("aside button")].find((b) => (b.textContent || "").includes(t));
  if (!el) throw new Error("biz button not found: " + t);
  el.click();
}, nameFrag);
async function login(cred) {
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 45000 });
  await waitSel('[data-testid="login-email"]');
  await setVal('[data-testid="login-email"]', cred.email);
  await setVal('[data-testid="login-password"]', cred.pw);
  await clickTid("login-submit");
  await page.waitForFunction(() => !document.querySelector('[data-testid="login-screen"]'), { timeout: 30000 });
  await sleep(1600);
}
async function logout() {
  const hasBtn = await page.$('[data-testid="user-menu-btn"]');
  if (hasBtn) await clickTid("user-menu-btn");
  else await page.evaluate(() => { const el = document.querySelector("header .w-7.h-7.rounded-full"); (el?.closest("button") || el)?.click(); });
  await waitSel('[data-testid="logout-btn"]');
  await clickTid("logout-btn");
  await waitSel('[data-testid="login-screen"]');
  await sleep(400);
}
const noOverflow = async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
// The ctx drawer slides off-screen (translate-x-full) rather than unmounting,
// so "closed" = its left edge is at/beyond the viewport's right edge.
const drawerOff = async () => page.$eval('[data-testid="ctx-drawer"]', (el) => {
  const r = el.getBoundingClientRect();
  return getComputedStyle(el).display === "none" || r.left >= window.innerWidth - 2;
});

const base0 = await q1("SELECT (SELECT count(*) FROM businesses) biz, (SELECT count(*) FROM transactions) txn, (SELECT count(*) FROM inventory_items) inv, (SELECT count(*) FROM checklist_templates) tpl, (SELECT count(*) FROM business_metrics) met, (SELECT count(*) FROM audit_trail) trl");
const sessionMax0 = (await q1("SELECT COALESCE(max(id),0) m FROM user_sessions")).m;
let TESTBIZ = null;

try {
  // ══ A. Desktop (≥xl): persistent right rail + live location rows ════════
  console.log("── A. Desktop rail: you-are-here on every destination ──");
  await page.setViewport({ width: 1500, height: 950 });
  await login(OWNER);
  await waitSel('[data-testid="ctx-panel"]');
  ok("A1 right rail visible on wide desktop", (await widthOf('[data-testid="ctx-panel"]')) > 200, `w=${await widthOf('[data-testid="ctx-panel"]')}`);
  ok("A2 Command Center → Executive HQ", (await textOf('[data-testid="ctx-section"]')) === "Executive HQ" &&
    (await textOf('[data-testid="ctx-page"]')) === "Enterprise Command Center" &&
    (await has('[data-testid="ctx-business"]', "Group-wide")) && (await textOf('[data-testid="ctx-branch"]')) === "Enterprise HQ",
    `${await textOf('[data-testid="ctx-page"]')}`);
  await clickBizButton("Mina Akuafo Poultry Farm");
  await sleep(900);
  ok("A3 business unit → Business/Branch/Page tracked", (await has('[data-testid="ctx-business"]', "Mina Akuafo Poultry Farm")) &&
    (await has('[data-testid="ctx-business"]', "POULTRY-01")) && (await has('[data-testid="ctx-branch"]', "Nsawam")) &&
    (await textOf('[data-testid="ctx-page"]')) === "Management Dashboard" && (await textOf('[data-testid="ctx-section"]')) === "Ghana Businesses",
    await textOf('[data-testid="ctx-branch"]'));
  const bizChips = await page.$$eval('[data-testid^="ctx-quick-"]', (n) => n.map((x) => x.getAttribute("data-testid")));
  ok("A4 quick navigation lists all business units", bizChips.filter((t) => t.includes("-01")).length >= 9 && bizChips.includes("ctx-quick-COMMAND_CENTER"),
    `${bizChips.length} chips`);
  await clickTid("ctx-quick-BLOCK-01");
  await sleep(900);
  ok("A5 quick-navigation chip jumps to Concrete & Blocks", await has('[data-testid="ctx-business"]', "Mina Concrete & Blocks"));
  await clickTid("sidebar-tab-finance");
  await sleep(900);
  ok("A6 Finance → Shared Enterprise Modules", (await textOf('[data-testid="ctx-section"]')) === "Shared Enterprise Modules" &&
    (await textOf('[data-testid="ctx-page"]')) === "Finance & Reports" && (await has('[data-testid="ctx-branch"]', "All branches")));
  const modChips = await page.$$eval('[data-testid^="ctx-quick-"]', (n) => n.map((x) => x.getAttribute("data-testid")));
  ok("A7 shared-module quick nav has all 8 modules", ["SALES_CENTER", "FINANCE", "CUSTOMERS", "SUPPLIERS", "EMPLOYEES", "ASSETS", "INVENTORY", "TRANSACTIONS"].every((t) => modChips.includes(`ctx-quick-${t}`)), `${modChips.length}`);
  await clickTid("audit-tab");
  await sleep(900);
  ok("A8 Audit & Review → Oversight & Assurance", (await textOf('[data-testid="ctx-section"]')) === "Oversight & Assurance");
  await clickTid("ctx-quick-COMMAND_CENTER");
  await sleep(700);
  ok("A9 Back-to-Command-Center chip works", (await textOf('[data-testid="ctx-section"]')) === "Executive HQ");
  const wExp = await widthOf('[data-testid="ctx-panel"]');
  await clickTid("ctx-collapse");
  await sleep(400);
  const wCol = await widthOf('[data-testid="ctx-panel"]');
  await clickTid("ctx-collapse");
  await sleep(400);
  const wBack = await widthOf('[data-testid="ctx-panel"]');
  ok("A10 rail collapses to icon strip & expands back", wCol < 100 && wBack > 200, `${Math.round(wExp)}→${Math.round(wCol)}→${Math.round(wBack)}`);
  ok("A11 no horizontal overflow on desktop with rail", await noOverflow());
  await page.screenshot({ path: SHOT("1-desktop-rail-business") });

  // ══ B. Sibling-unit jump chips (TEST business, fully purged after) ══════
  console.log("── B. Sibling unit chips within a business family ──");
  const prevP = await q(`SELECT code FROM businesses WHERE code ~ '^POULTRY-[0-9]+$'`);
  const expectedCode = `POULTRY-${String(Math.max(0, ...prevP.map((r) => parseInt(r.code.split("-")[1], 10))) + 1).padStart(2, "0")}`;
  const created = await api("/api/businesses", "POST", {
    name: "TEST Context Unit", category: "Poultry Farm", branchLocation: "TEST Site, Accra",
    region: "Greater Accra", managerName: "TEST Manager", contactPhone: "+233 55 000 0000",
    initialCapitalGhs: 1000, monthlyTargetRevenueGhs: 2000,
  });
  TESTBIZ = created.body?.business;
  ok("B1 TEST sibling unit created", created.status === 200 && TESTBIZ?.code === expectedCode, TESTBIZ?.code);
  await page.reload({ waitUntil: "networkidle0" });
  await sleep(1800);
  await clickBizButton("TEST Context Unit");
  await sleep(900);
  const unitChips = await page.$$eval('[data-testid^="ctx-unit-"]', (n) => n.map((x) => x.getAttribute("data-testid")));
  ok("B2 family chips show both Poultry units", unitChips.includes("ctx-unit-POULTRY-01") && unitChips.includes(`ctx-unit-${TESTBIZ.code}`), unitChips.join(","));
  await clickTid("ctx-unit-POULTRY-01");
  await sleep(900);
  ok("B3 family chip jumps to the sibling unit", await has('[data-testid="ctx-business"]', "Mina Akuafo Poultry Farm"));

  // ══ C. Tablet (between lg and xl): context bar + right drawer ═══════════
  console.log("── C. Tablet: compact bar + slide-in drawer ──");
  await page.setViewport({ width: 1000, height: 800 });
  await page.reload({ waitUntil: "networkidle0" });
  await sleep(2000);
  // Reload resets to HQ — navigate via the STATIC left menu (always visible).
  await clickBizButton("Mina Akuafo Poultry Farm");
  await sleep(900);
  ok("C1 rail hidden on tablet, compact bar shown", !(await visible('[data-testid="ctx-panel"]')) && (await visible('[data-testid="ctx-bar"]')));
  ok("C2 crumb trail readable on tablet", await has('[data-testid="ctx-bar"]', "Ghana Businesses"));
  await clickTid("ctx-open-btn");
  await sleep(500);
  ok("C3 drawer opens from the right", await visible('[data-testid="ctx-drawer"]'));
  ok("C4 drawer shows location rows", (await textOf('[data-testid="ctx-drawer"] [data-testid="ctx-page"]')) === "Management Dashboard");
  await clickTid("ctx-quick-BLOCK-01");
  await sleep(900);
  ok("C5 drawer quick chip navigates AND auto-closes", (await has('[data-testid="ctx-bar"]', "Concrete & Blocks")) && (await drawerOff()));
  await clickTid("ctx-open-btn");
  await sleep(400);
  await clickTid("ctx-drawer-close");
  await sleep(400);
  ok("C6 X button closes the drawer", await drawerOff());
  await page.screenshot({ path: SHOT("2-tablet-bar") });
  ok("C7 no horizontal overflow on tablet", await noOverflow());

  // ══ D. Phone: bar fits, no overflow anywhere, drawer works ══════════════
  console.log("── D. Phone (375px) ──");
  await page.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true });
  await page.reload({ waitUntil: "networkidle0" });
  await sleep(2000);
  ok("D1 compact bar fits the phone", (await visible('[data-testid="ctx-bar"]')) && (await noOverflow()));
  await clickTid("ctx-open-btn");
  await sleep(500);
  ok("D2 drawer opens on phone & X closes it", (await visible('[data-testid="ctx-drawer"]')) && (await clickTid("ctx-drawer-close"), await sleep(400), await drawerOff()));
  // Navigate into a business first (the HQ shortcut only renders off-HQ).
  await clickBizButton("Mina Akuafo Poultry Farm");
  await sleep(900);
  await clickTid("ctx-open-btn");
  await sleep(400);
  await clickTid("ctx-quick-COMMAND_CENTER");
  await sleep(900);
  ok("D3 Back-to-HQ chip navigates & auto-closes on phone", (await has('[data-testid="ctx-bar"]', "Command Center")) && (await drawerOff()));
  ok("D4 no horizontal overflow at HQ on phone", await noOverflow());
  await page.screenshot({ path: SHOT("3-phone-bar") });

  // ══ E. Worker role: scoped location ═════════════════════════════════════
  console.log("── E. Worker scope (Akua Donkor → Poultry) ──");
  await page.setViewport({ width: 1500, height: 950, isMobile: false, hasTouch: false });
  await sleep(600);
  await logout();
  await login(AKUA);
  await waitSel('[data-testid="ctx-panel"]');
  ok("E1 worker sees scoped location", (await textOf('[data-testid="ctx-section"]')) === "My Sales Workspace" &&
    (await has('[data-testid="ctx-business"]', "Mina Akuafo Poultry Farm")) && (await has('[data-testid="ctx-branch"]', "Nsawam")),
    `${await textOf('[data-testid="ctx-section"]')} / ${await textOf('[data-testid="ctx-business"]')}`);
  const wQuick = await page.$$eval('[data-testid^="ctx-quick-"]', (n) => n.length);
  ok("E2 worker panel shows no enterprise quick nav", wQuick === 0, `${wQuick}`);
  await page.screenshot({ path: SHOT("4-worker-scoped") });
  await logout();
} catch (e) {
  ok("FATAL suite error", false, String(e?.message || e));
  try { await page.screenshot({ path: SHOT("error") }); } catch {}
} finally {
  console.log("── Z. TEST-data purge + forensics ──");
  if (TESTBIZ) {
    const del = await api(`/api/businesses/${TESTBIZ.id}`, "DELETE", { confirmCode: TESTBIZ.code });
    console.log(`   delete ${TESTBIZ.code}: ${del.status} ${del.body?.success ? "ok" : JSON.stringify(del.body)}`);
  }
  await client.query(`DELETE FROM user_sessions WHERE id > ${sessionMax0}`);
  const z = await q1("SELECT (SELECT count(*) FROM businesses) biz, (SELECT count(*) FROM transactions) txn, (SELECT count(*) FROM inventory_items) inv, (SELECT count(*) FROM checklist_templates) tpl, (SELECT count(*) FROM business_metrics) met, (SELECT count(*) FROM audit_trail) trl");
  ok("Z1 forensics back to pre-test baseline",
    Number(z.biz) === Number(base0.biz) && Number(z.txn) === Number(base0.txn) && Number(z.inv) === Number(base0.inv) &&
    Number(z.tpl) === Number(base0.tpl) && Number(z.met) === Number(base0.met) && Number(z.trl) === Number(base0.trl), JSON.stringify(z));
  ok("Z2 zero page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  console.log(`\n═══ RESULT: ${checks.filter((c) => c.pass).length}/${checks.length} passed, ${failures} failed ═══`);
  await browser.close();
  await client.end();
  process.exit(failures ? 1 : 0);
}
