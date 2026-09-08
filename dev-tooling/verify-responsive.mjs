// Live responsiveness verification of the entire GoMina 360 interface in
// real headless Chromium across phone / tablet / laptop / desktop viewports:
// no horizontal page overflow on any page, the restored STATIC left navigation
// menu on every screen (compact on phones, always pinned, no hamburger drawer), all module pages, modals and the worker view —
// with zero page errors everywhere.
// Run: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-responsive.mjs

import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.OWNER_PW || "Owner@GoMina26" };
const AKUA = { email: "akua.donkor@gomina360.com", pw: process.env.AKUA_PW || "GoMina@User10" };

const checks = [];
let failures = 0;
const ok = (name, cond, extra = "") => { checks.push({ name, pass: !!cond }); if (!cond) failures++; console.log(`${cond ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`); };

const pageErrors = [];
const browser = await puppeteer.launch({ executablePath: "/tmp/al2023/chromium", headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") { const t = m.text(); if (!/401|Failed to load resource|net::ERR_/.test(t)) pageErrors.push(t); } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitSel = (sel, timeout = 15000) => page.waitForSelector(sel, { timeout });
const exists = async (sel) => !!(await page.$(sel));
const setVal = async (sel, val) => {
  await waitSel(sel);
  await page.evaluate((s, v) => {
    const el = document.querySelector(s);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, sel, val);
};
const setTid = (tid, val) => setVal(`[data-testid="${tid}"]`, val);
const clickTid = async (tid) => { await waitSel(`[data-testid="${tid}"]`); await page.$eval(`[data-testid="${tid}"]`, (e) => e.click()); };
const clickText = async (text) => page.evaluate((t) => {
  const el = [...document.querySelectorAll("button, a")].find((b) => (b.textContent || "").replace(/\s+/g, " ").trim().toLowerCase().includes(t.toLowerCase()));
  if (el) { el.click(); return true; }
  return false;
}, text);
const noOverflow = async () => page.evaluate(() => {
  const de = document.documentElement;
  return { ok: de.scrollWidth <= window.innerWidth + 1, sw: de.scrollWidth, iw: window.innerWidth };
});
/** Elements visibly poking past the right viewport edge (offenders list). */
const offenders = async () => page.evaluate(() => {
  const iw = window.innerWidth;
  const bad = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > iw + 2 && r.left < iw) {
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      const tid = el.getAttribute?.("data-testid");
      bad.push(tid || `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}`);
      if (bad.length >= 4) break;
    }
  }
  return bad;
});
const visible = async (sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return false;
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0;
}, sel);
const geoOf = async (sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left), w: Math.round(r.width) };
}, sel);

async function login(cred) {
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 45000 });
  if (await exists('[data-testid="login-email"]')) {
    await setTid("login-email", cred.email);
    await setTid("login-password", cred.pw);
    await clickTid("login-submit");
    await page.waitForFunction(() => !document.querySelector('[data-testid="login-screen"]'), { timeout: 30000 });
  }
  await sleep(2000);
}
async function logoutIfNeeded() {
  await page.evaluate(() => { try { sessionStorage.clear(); localStorage.clear(); } catch {} });
  const cookies = await page.cookies(BASE);
  if (cookies.length) await page.deleteCookie(...cookies);
}

let shotN = 0;
const shot = async (name) => { shotN++; await page.screenshot({ path: `/home/user/rsp-${String(shotN).padStart(2, "0")}-${name}.png` }); };

try {
  // ══ A. Login screen on a phone ════════════════════════════════════════
  console.log("── A. Phone: login ──");
  await page.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true });
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 45000 });
  await sleep(1200);
  let r = await noOverflow();
  ok("A1 login screen fits 375px", r.ok, `sw=${r.sw}`);
  await shot("phone-login");
  await login(OWNER);

  // ══ B. Phone: drawer navigation ═══════════════════════════════════════
  console.log("── B. Phone: static left menu ──");
  ok("B1 STATIC left menu always visible on phones (no hamburger needed)", (await visible('[data-testid="nav-sidebar"]')) && !(await exists('[data-testid="nav-menu-btn"]')));
  const sbGeo = await geoOf('[data-testid="nav-sidebar"]');
  ok("B2 menu compact on phones (≤170px — content keeps room)", sbGeo && sbGeo.w <= 170, `w=${sbGeo?.w}`);
  ok("B3 menu docked flush at the left edge", sbGeo && sbGeo.x === 0, `x=${sbGeo?.x}`);
  await shot("phone-static-menu");
  ok("B4 menu navigates to a business (no drawer)", await clickText("Mina Akuafo Poultry Farm"));
  await sleep(2500);
  ok("B5 poultry module mounted", await exists('[data-testid="pltry-root"]') || (await page.evaluate(() => document.body.innerText.includes("Poultry"))), "");
  r = await noOverflow();
  ok("B6 content column fits beside the static menu", r.ok, `sw=${r.sw}`);

  // ══ C. Phone: every major page fits without horizontal overflow ════════
  console.log("── C. Phone: page-by-page overflow sweep ──");
  const pages = [
    ["Command Center", "Command Center"],
    ["Mina Concrete & Blocks", "Block Factory"],
    ["Mina Volta Tilapia", "Aquaculture"],
    ["Mina Heritage Kitchen", "Restaurant"],
    ["Mina Tech & Electronics", "Electronics"],
    ["GoMina Hardware", "Hardware"],
    ["Mina Express Auto Wash", "Car Wash"],
    ["Sales & Payments", "Sales"],
    ["Finance & Reports", "Finance"],
    ["Customers & CRM", "Customers"],
    ["Suppliers & Vendors", "Suppliers"],
    ["Employees & Payroll", "Employees"],
    ["Assets & Equipment", "Assets"],
    ["Inventory & Stock", "Inventory"],
    ["Transactions & MoMo", "Transactions"],
  ];
  let allFit = true;
  const badPages = [];
  for (const [label, name] of pages) {
    const clicked = await clickText(label);
    await sleep(2400);
    const res = await noOverflow();
    const offs = res.ok ? [] : await offenders();
    if (!clicked || !res.ok) { allFit = false; badPages.push(`${name}${clicked ? "" : " (missing)"} sw=${res.sw} ${offs.join(",")}`); }
  }
  ok("C1 all 15 module pages fit 375px (no h-overflow)", allFit, badPages.slice(0, 4).join(" | ") || "clean");
  await shot("phone-transactions");
  // back to command center for a stable screenshot
  await clickText("Command Center");
  await sleep(2200);
  await shot("phone-command-center");

  // ══ D. Phone: modal forms fit ═════════════════════════════════════════
  console.log("── D. Phone: modal forms ──");
  await clickText("Mina Express Auto Wash");
  await sleep(2400);
  await clickTid("cw-open-wash");
  await sleep(900);
  const modalFit = await page.evaluate(() => {
    const f = document.querySelector("form.fixed, .fixed form");
    if (!f) return { found: false };
    const r = f.getBoundingClientRect();
    return { found: true, w: r.width, iw: window.innerWidth, fits: r.width <= window.innerWidth + 1 };
  });
  ok("D1 car-wash form modal fits the phone", modalFit.found && modalFit.fits, `w=${modalFit.w}/${modalFit.iw}`);
  await shot("phone-carwash-form");
  await page.keyboard.press("Escape").catch(() => {});
  await page.evaluate(() => { const b = document.querySelector('[data-testid="telf-close"], .fixed button'); });
  // close via the X in the modal header
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll(".fixed button")];
    const x = btns.find((b) => (b.getAttribute("aria-label") || "").toLowerCase().includes("close") || b.querySelector("svg.lucide-x"));
    if (x) x.click();
  });
  await sleep(600);

  // Payroll center on a phone (dense data UI)
  await clickText("Employees & Payroll");
  await sleep(2400);
  await clickTid("emp-payroll-open");
  await sleep(2400);
  r = await noOverflow();
  ok("D2 payroll center fits the phone", r.ok, `sw=${r.sw}`);
  await shot("phone-payroll");

  // ══ E. Worker view on a phone ═════════════════════════════════════════
  console.log("── E. Phone: worker role ──");
  await logoutIfNeeded();
  await login(AKUA);
  r = await noOverflow();
  ok("E1 worker dashboard fits the phone", r.ok, `sw=${r.sw}`);
  await shot("phone-worker");
  await logoutIfNeeded();

  // ══ F. Tablet (834×1194) ══════════════════════════════════════════════
  console.log("── F. Tablet ──");
  await page.setViewport({ width: 834, height: 1194, isMobile: true, hasTouch: true });
  await login(OWNER);
  ok("F1 static left menu present on tablets (no hamburger)", (await visible('[data-testid="nav-sidebar"]')) && !(await exists('[data-testid="nav-menu-btn"]')));
  r = await noOverflow();
  ok("F2 command center fits tablet", r.ok, `sw=${r.sw}`);
  await shot("tablet-command-center");
  await clickText("Mina Tech & Electronics");
  await sleep(2400);
  r = await noOverflow();
  ok("F3 electronics module fits tablet", r.ok, `sw=${r.sw}`);
  await shot("tablet-tech");
  await clickText("Finance & Reports");
  await sleep(2400);
  r = await noOverflow();
  ok("F4 finance fits tablet", r.ok, `sw=${r.sw}`);

  // ══ G. Laptop (1280×800) ══════════════════════════════════════════════
  console.log("── G. Laptop ──");
  await page.setViewport({ width: 1280, height: 800 });
  await page.reload({ waitUntil: "networkidle0", timeout: 45000 });
  await sleep(2500);
  ok("G1 sidebar static on laptop (no hamburger shown)", !(await visible('[data-testid="nav-menu-btn"]')));
  const sideRect = await page.evaluate(() => {
    const a = document.querySelector('[data-testid="nav-sidebar"]');
    const r = a?.getBoundingClientRect();
    return r ? { x: r.x, w: r.width } : null;
  });
  ok("G2 sidebar docked at left edge", !!sideRect && sideRect.x === 0, JSON.stringify(sideRect));
  r = await noOverflow();
  ok("G3 command center fits laptop", r.ok, `sw=${r.sw}`);
  await shot("laptop-command-center");

  // ══ H. Desktop (1500×950) ═════════════════════════════════════════════
  console.log("── H. Desktop ──");
  await page.setViewport({ width: 1500, height: 950 });
  await page.reload({ waitUntil: "networkidle0", timeout: 45000 });
  await sleep(2500);
  ok("H1 sidebar static on desktop (no hamburger shown)", !(await visible('[data-testid="nav-menu-btn"]')));
  r = await noOverflow();
  ok("H2 desktop command center clean", r.ok, `sw=${r.sw}`);
  await shot("desktop-command-center");

  // ══ I. Collapsible static menu ════════════════════════════════════════
  console.log("── I. Collapsible menu (toggle → icon rail → persists) ──");
  let g = await geoOf('[data-testid="nav-sidebar"]');
  ok("I1 menu starts expanded on desktop", g && g.w >= 250, `w=${g?.w}`);
  await clickTid("sidebar-collapse-toggle");
  await sleep(500);
  g = await geoOf('[data-testid="nav-sidebar"]');
  ok("I2 toggle collapses menu to icon rail", g && g.w <= 60, `w=${g?.w}`);
  ok("I3 page still clean beside the rail", (await noOverflow()).ok);
  await shot("desktop-menu-collapsed");
  await page.reload({ waitUntil: "networkidle0", timeout: 45000 });
  await sleep(2200);
  g = await geoOf('[data-testid="nav-sidebar"]');
  ok("I4 collapse persists across reload", g && g.w <= 60, `w=${g?.w}`);
  await clickTid("sidebar-collapse-toggle");
  await sleep(500);
  g = await geoOf('[data-testid="nav-sidebar"]');
  ok("I5 toggle re-expands the menu", g && g.w >= 250, `w=${g?.w}`);
  // Icon rail still navigates: icon-only buttons remain clickable
  const navOk = await clickText("Finance & Reports").catch(() => false);
  await sleep(2200);
  ok("I6 expanded menu navigates after restore", navOk === true, String(navOk));

  // Phone: same collapse behavior with the compact menu
  await page.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true });
  await page.reload({ waitUntil: "networkidle0", timeout: 45000 });
  await sleep(2200);
  await clickTid("sidebar-collapse-toggle");
  await sleep(500);
  g = await geoOf('[data-testid="nav-sidebar"]');
  ok("I7 phone menu collapses to icon rail", g && g.w <= 52, `w=${g?.w}`);
  ok("I8 collapsed phone menu keeps page clean", (await noOverflow()).ok);
  await shot("phone-menu-collapsed");
  await clickTid("sidebar-collapse-toggle");
  await sleep(500);
  g = await geoOf('[data-testid="nav-sidebar"]');
  ok("I9 phone menu re-expands", g && g.w === 160, `w=${g?.w}`);
} catch (err) {
  console.error("FATAL", err);
  failures++;
} finally {
  await browser.close();
}

console.log(`\n══ verify-responsive: ${checks.filter((c) => c.pass).length}/${checks.length} passed, ${failures} failed ══`);
const pe = pageErrors.filter((e) => !/ResizeObserver/.test(e));
if (pe.length) { console.log("PAGE ERRORS:"); pe.slice(0, 10).forEach((e) => console.log(" •", e.slice(0, 240))); }
else console.log("Page errors: none");
process.exit(failures || pe.length ? 1 : 0);
