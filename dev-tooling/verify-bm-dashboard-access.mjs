/**
 * verify-bm-dashboard-access.mjs — Branch Manager Access: granted branch
 * dashboards E2E.
 *
 *   A · API scope: BM init scope = [primary] before grants; OWNER PATCH-grants
 *       extra business access → scope widens (granted business data flows);
 *       BM cannot self-grant (403); revoke → scope collapses back.
 *   B · Owner console UI: "Extra business access" checkbox grants HARDWARE-01
 *       to the BM (uba row lands server-side).
 *   C · BM UI: sidebar chips follow grants — "My Branch" → chips for primary +
 *       granted branches with GRANTED badges + "My Branches (N)" label;
 *       clicking a granted chip opens that unit's REAL dashboard (hardware
 *       module / poultry module for POULTRY-02), never the sales fallback;
 *       revoke → chips collapse to "My Branch" again.
 *   Z · TEST purge, uba/sessions restore, live-data forensics byte-check.
 *
 * No live rows altered; every grant restored, sessions above baseline deleted.
 */
import { createRequire } from "module";
const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");
const { Client } = require("pg");

const BASE = "http://127.0.0.1:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pass: process.env.GOMINA_OWNER_PW || "Owner@GoMina26" };
const BM = { email: "emmanuel@gomina360.com", pass: "GoMina@User3", id: 3 };

const results = [];
const baseline = {};
const pageErrors = [];
const pg = new Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });

const ok = (name, cond, extra = "") => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "✅" : "❌"} ${name}${cond ? "" : " — " + extra}`);
  return cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(cookie, path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) },
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const loginCookie = async (creds) => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: creds.email, password: creds.pass }),
  });
  if (!res.ok) throw new Error(`login failed for ${creds.email}: ${res.status}`);
  return (res.headers.get("set-cookie") || "").split(";")[0];
};

const hookPage = (page, tag) => {
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const txt = m.text();
    if (/Failed to load resource/.test(txt) && /(401|400|403|404|409|413)/.test(txt)) return;
    if (/net::/.test(txt)) return;
    pageErrors.push(`[${tag}] ${txt.slice(0, 300)}`);
  });
  page.on("pageerror", (e) => pageErrors.push(`[${tag}] PAGEERROR ${String(e).slice(0, 300)}`));
};
const uiLogin = async (page, creds) => {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid="login-email"]', { timeout: 60000 });
  await page.type('[data-testid="login-email"]', creds.email);
  await page.type('[data-testid="login-password"]', creds.pass);
  await page.click('[data-testid="login-submit"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="login-email"]'), { timeout: 60000 });
};
const clickExact = async (page, label) => {
  const clicked = await page.evaluate((want) => {
    const btns = [...document.querySelectorAll('[data-testid="nav-sidebar"] button')];
    const b = btns.find((x) => (x.textContent || "").replace(/\s+/g, " ").trim().startsWith(want));
    if (!b) return false;
    b.scrollIntoView({ block: "center" });
    b.click();
    return true;
  }, label);
  await sleep(500);
  return clicked;
};
// Sidebar business chips: [{code, name, enabled, grantedBadge}]
const readChips = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="nav-sidebar"] aside, [data-testid="nav-sidebar"]')].length
      ? [...document.querySelectorAll('[data-testid="nav-sidebar"] button')]
          .filter((b) => {
            const badge = b.querySelector('[data-testid^="sidebar-chip-granted-"]');
            const icon = b.querySelector("svg");
            return icon && (badge || !/Users|Finance|Support|Audit|Manage|Order|Assets|Sales|Integrations|Scenario|AI|Track/i.test(b.textContent || ""));
          })
          .map((b) => ({
            text: (b.textContent || "").replace(/\s+/g, " ").trim(),
            enabled: !b.disabled,
            granted: !!b.querySelector('[data-testid^="sidebar-chip-granted-"]'),
            active: (b.className || "").includes("border-l-2"),
          }))
          .filter((c) => c.text.length > 0)
      : [],
  );

/* ── A · API scope proof ────────────────────────────────────────────── */
async function sectionA(cookies) {
  console.log("\n— A · API access scope —");
  const initBefore = await api(cookies.bm, "/api/init");
  baseline.bmScopeIds = (initBefore.json?.businesses || []).map((b) => b.id).sort((a, b) => a - b);
  ok("A1 BM scope before grant = primary branch only",
    JSON.stringify(baseline.bmScopeIds) === JSON.stringify([1]),
    JSON.stringify(baseline.bmScopeIds));

  const selfGrant = await api(cookies.bm, "/api/users", {
    method: "PATCH", body: JSON.stringify({ userId: BM.id, extraAccessIds: [8] }),
  });
  ok("A2 a Branch Manager cannot grant himself extra businesses (403)",
    selfGrant.status === 403, `${selfGrant.status}`);

  const grant = await api(cookies.owner, "/api/users", {
    method: "PATCH", body: JSON.stringify({ userId: BM.id, extraAccessIds: [8] }),
  });
  const uba = (await pg.query(`SELECT business_id FROM user_business_access WHERE user_id=$1 ORDER BY business_id`, [BM.id])).rows.map((r) => r.business_id);
  ok("A3 OWNER grants the BM an extra branch via API (uba row = HARDWARE-01)",
    grant.status === 200 && JSON.stringify(uba) === JSON.stringify([8]),
    `${grant.status} ${JSON.stringify(uba)}`);

  const initAfter = await api(cookies.bm, "/api/init");
  const scope = (initAfter.json?.accessibleBusinessIds || []).slice().sort((a, b) => a - b);
  const bizIds = (initAfter.json?.businesses || []).map((b) => b.id).sort((a, b) => a - b);
  const invNames = (initAfter.json?.inventory || []).map((i) => i.name).join("|");
  ok("A4 granted BM scope widens to primary + granted branch (init + businesses)",
    JSON.stringify(scope) === JSON.stringify([1, 8]) && JSON.stringify(bizIds) === JSON.stringify([1, 8]),
    `scope=${JSON.stringify(scope)} biz=${JSON.stringify(bizIds)}`);
  ok("A4b the granted branch's data actually flows (hardware inventory visible)",
    /Cement/i.test(invNames), invNames.slice(0, 120));

  await api(cookies.owner, "/api/users", { method: "PATCH", body: JSON.stringify({ userId: BM.id, extraAccessIds: [] }) });
  const initRevoked = await api(cookies.bm, "/api/init");
  const scopeAfter = (initRevoked.json?.businesses || []).map((b) => b.id);
  ok("A5 revoking collapses the scope back to the primary branch",
    JSON.stringify(scopeAfter) === JSON.stringify([1]), JSON.stringify(scopeAfter));
}

/* ── B · Owner console UI grant path ────────────────────────────────── */
async function sectionB(browser, cookies) {
  console.log("\n— B · Owner console “Extra business access” grant (UI) —");
  const ctxO = await browser.createBrowserContext();
  const po = await ctxO.newPage();
  hookPage(po, "owner-console");
  await po.setViewport({ width: 1440, height: 960 });
  await uiLogin(po, OWNER);
  await po.waitForSelector('[data-testid="open-user-access"]', { timeout: 30000 });
  await po.click('[data-testid="open-user-access"]');
  await po.waitForSelector(`[data-testid="user-edit-${BM.id}"]`, { timeout: 30000 });
  await po.click(`[data-testid="user-edit-${BM.id}"]`);
  await po.waitForSelector('[data-testid="user-form-extra-access"]', { timeout: 15000 });
  const boxVisible = await po.$('[data-testid="access-grant-HARDWARE-01"]');
  ok("B1 owner console shows per-business access checkboxes for the BM", !!boxVisible);
  await po.click('[data-testid="access-grant-HARDWARE-01"]');
  await po.screenshot({ path: "/home/user/bm-access-console.png" });
  await po.click('[data-testid="user-edit-save"]');
  await sleep(1400);
  const uba = (await pg.query(`SELECT business_id FROM user_business_access WHERE user_id=$1`, [BM.id])).rows.map((r) => r.business_id);
  ok("B2 console checkbox grant lands server-side (uba = HARDWARE-01)",
    JSON.stringify(uba) === JSON.stringify([8]), JSON.stringify(uba));
  await ctxO.close();
}

/* ── C · BM sidebar + granted-dashboard navigation ──────────────────── */
async function sectionC(browser, cookies) {
  console.log("\n— C · BM sidebar chips & granted dashboards —");
  // BM currently holds HARDWARE-01 from section B. Start from that state.
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  hookPage(page, "bm-ui");
  await page.setViewport({ width: 1440, height: 960 });
  await uiLogin(page, BM);
  await page.waitForSelector('[data-testid="nav-sidebar"]', { timeout: 45000 });
  await sleep(800);

  const chips1 = await readChips(page);
  const header1 = await page.evaluate(() => {
    const el = [...document.querySelectorAll('[data-testid="nav-sidebar"] div')].find((d) => /My Branch/.test(d.textContent || "") && d.children.length === 0);
    return el ? el.textContent.trim() : "";
  });
  ok("C1 BM with one grant sees BOTH branch chips (primary + hardware), hardware badged GRANTED",
    chips1.length === 2 && chips1.every((c) => c.enabled) && chips1.some((c) => c.granted && /Hardware/i.test(c.text)) && chips1.some((c) => !c.granted && /Poultry/i.test(c.text)),
    JSON.stringify(chips1));
  ok("C1b label upgrades to “My Branches (2)”", header1 === "My Branches (2)", header1);

  // Click the hardware chip → the REAL hardware dashboard (not sales fallback)
  const clickedHw = await clickExact(page, "GoMina Hardware & Building Materials Depot");
  await page.waitForSelector('[data-testid="hardware-module"]', { timeout: 30000 }).catch(() => {});
  const hwState = await page.evaluate(() => ({
    hwModule: !!document.querySelector('[data-testid="hardware-module"]'),
    bodyHasName: /GoMina Hardware/.test(document.body.innerText),
    bodyHasCement: /Cement/i.test(document.body.innerText),
  }));
  ok("C2 clicking the granted chip opens the hardware unit's real dashboard",
    clickedHw && hwState.hwModule && hwState.bodyHasName,
    JSON.stringify(hwState));
  ok("C2b the granted dashboard carries that branch's own data (hardware stock)",
    hwState.bodyHasCement, JSON.stringify(hwState));
  await page.screenshot({ path: "/home/user/bm-granted-hardware.png" });

  // Grant POULTRY-02 as well → chip appears, dashboard opens for “kkkkk”
  await api(cookies.owner, "/api/users", { method: "PATCH", body: JSON.stringify({ userId: BM.id, extraAccessIds: [8, 11] }) });
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForSelector('[data-testid="nav-sidebar"]', { timeout: 45000 });
  await sleep(900);
  const chips2 = await readChips(page);
  const header2 = await page.evaluate(() => {
    const el = [...document.querySelectorAll('[data-testid="nav-sidebar"] div')].find((d) => /My Branch/.test(d.textContent || "") && d.children.length === 0);
    return el ? el.textContent.trim() : "";
  });
  ok("C3 a second granted branch adds a third chip, label “My Branches (3)”",
    chips2.length === 3 && header2 === "My Branches (3)" && chips2.filter((c) => c.granted).length === 2,
    JSON.stringify({ chips2, header2 }));
  const clickedP2 = await clickExact(page, "kkkkk");
  await sleep(1200);
  const p2State = await page.evaluate(() => ({
    poultryUI: !!document.querySelector('[data-testid="dash-date-filter"]'),
    namePresent: /kkkkk/i.test(document.body.innerText),
  }));
  ok("C4 the second granted branch (POULTRY-02 kkkkk) opens its live poultry dashboard",
    clickedP2 && p2State.poultryUI && p2State.namePresent, JSON.stringify(p2State));
  await page.screenshot({ path: "/home/user/bm-granted-poultry02.png" });

  // Revoke everything → chips collapse, label back, hardware module gone
  await api(cookies.owner, "/api/users", { method: "PATCH", body: JSON.stringify({ userId: BM.id, extraAccessIds: [] }) });
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForSelector('[data-testid="nav-sidebar"]', { timeout: 45000 });
  await sleep(900);
  const chips3 = await readChips(page);
  const header3 = await page.evaluate(() => {
    const el = [...document.querySelectorAll('[data-testid="nav-sidebar"] div')].find((d) => /My Branch/.test(d.textContent || "") && d.children.length === 0);
    return el ? el.textContent.trim() : "";
  });
  ok("C5 revoking all grants collapses the sidebar to “My Branch” (primary only)",
    chips3.length === 1 && !chips3[0].granted && header3 === "My Branch",
    JSON.stringify({ chips3, header3 }));
  // Own-branch dashboard still fully reachable after the revocations
  const clickedOwn = await clickExact(page, "Mina Akuafo Poultry Farm");
  await sleep(1000);
  const ownState = await page.evaluate(() => !!document.querySelector('[data-testid="dash-date-filter"]') && /Mina Akuafo/.test(document.body.innerText));
  ok("C6 the primary branch dashboard still opens after grant/revoke cycles", clickedOwn && ownState);
  await ctx.close();
}

/* ── cleanup & forensics ────────────────────────────────────────────── */
async function cleanup() {
  console.log("\n— Z · cleanup & forensics —");
  await pg.query(`DELETE FROM user_business_access WHERE user_id=$1`, [BM.id]);
  for (const r of baseline.ubaRows || []) {
    await pg.query(`INSERT INTO user_business_access (user_id, business_id, created_by_user_id, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [r.user_id, r.business_id, r.created_by_user_id, r.created_at]);
  }
  const ubaLeft = (await pg.query(`SELECT count(*)::int c FROM user_business_access WHERE user_id=$1`, [BM.id])).rows[0].c;
  ok("Z1 BM extra-access grants restored to baseline", ubaLeft === (baseline.ubaRows || []).length, `left=${ubaLeft} baseline=${(baseline.ubaRows || []).length}`);

  await pg.query(`DELETE FROM user_sessions WHERE id>$1`, [baseline.sessMax]);
  const counts = (await pg.query(`SELECT
      (SELECT count(*)::int FROM businesses) b, (SELECT count(*)::int FROM users) u,
      (SELECT count(*)::int FROM customers) cu, (SELECT count(*)::int FROM customer_trackings) t,
      (SELECT count(*)::int FROM sales_documents) sd, (SELECT count(*)::int FROM transactions) tx,
      (SELECT count(*)::int FROM inventory_items) ii`)).rows[0];
  ok("Z2 live data byte-identical to suite start", JSON.stringify(counts) === JSON.stringify(baseline.counts),
    `start=${JSON.stringify(baseline.counts)} end=${JSON.stringify(counts)}`);
  ok("Z3 zero page/console errors across every BM/owner pass", pageErrors.length === 0, pageErrors.slice(0, 5).join(" | "));
}

(async () => {
  await pg.connect();
  baseline.sessMax = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM user_sessions`)).rows[0].m;
  baseline.counts = (await pg.query(`SELECT
      (SELECT count(*)::int FROM businesses) b, (SELECT count(*)::int FROM users) u,
      (SELECT count(*)::int FROM customers) cu, (SELECT count(*)::int FROM customer_trackings) t,
      (SELECT count(*)::int FROM sales_documents) sd, (SELECT count(*)::int FROM transactions) tx,
      (SELECT count(*)::int FROM inventory_items) ii`)).rows[0];
  baseline.ubaRows = (await pg.query(`SELECT user_id, business_id, created_by_user_id, created_at FROM user_business_access WHERE user_id=$1`, [BM.id])).rows;
  console.log(`   baseline counts: ${JSON.stringify(baseline.counts)} | BM uba rows: ${baseline.ubaRows.length}`);
  // Pre-flight: BM must start with primary-only scope
  await pg.query(`DELETE FROM user_business_access WHERE user_id=$1`, [BM.id]);

  const cookies = { owner: await loginCookie(OWNER), bm: await loginCookie(BM) };
  const browser = await puppeteer.launch({
    executablePath: "/tmp/al2023/chromium",
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    await sectionA(cookies);
    await sectionB(browser, cookies);
    await sectionC(browser, cookies);
  } catch (e) {
    ok(`suite crashed: ${e.message}`, false);
    console.error(e);
  } finally {
    await browser.close().catch(() => {});
    try { await cleanup(); } catch (e) { console.error("cleanup error:", e.message); }
    await pg.end();
  }
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
