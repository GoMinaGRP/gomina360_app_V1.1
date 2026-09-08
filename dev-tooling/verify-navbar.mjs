#!/usr/bin/env node
/**
 * Top Navigation Bar — "Staff/Account menu & controls always visible" suite.
 *
 * The page enforces `overflow-x: clip`, so any navbar overflow used to make
 * the account menu physically unreachable (verified: off-screen by 294px at
 * 768px, and the attendance panel flew 130px off the LEFT edge at 320px).
 *
 *   A. Viewport sweep 320→1920: page never h-scrolls/clips; brand chip and
 *      ALL controls (currency, attendance clock, online toggle, bell,
 *      account) fully inside the viewport and displayed.
 *   B. Real puppeteer CLICKS (throws if off-screen = "not clickable"):
 *      account menu / clock panel / currency menu / bell panel open fully
 *      inside the viewport at 320 / 768 / 1280 — incl. Escape & outside-click
 *      close, and currency menu still functions.
 *   C. Sticky guarantee: after a deep scroll the navbar stays pinned at top
 *      and the account menu still opens inside the viewport (768px — the
 *      original failure width).
 *   D. WORKER persona at 360px: same guarantees (clock widget present, no
 *      privileged branch picker, account menu reachable).
 *   E. Zero page errors across every persona/viewport.
 *   Z. Session forensics purge (only writes this suite makes are logins).
 *
 * Usage: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-navbar.mjs
 */
import { createRequire } from "module";

const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");
const { Client } = require("pg");

const BASE = "http://127.0.0.1:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: "Owner@GoMina26" };
const WORKER = { email: "kwabena.mensah@gomina360.com", pw: "GoMina@User11" };
const WIDTHS = [320, 360, 390, 768, 834, 1024, 1280, 1920];
const MENU_WIDTHS = [320, 768, 1280];
const CONTROLS = ["currency-switcher", "att-clock-btn", "notif-bell", "user-menu-btn", "navbar-controls", "top-navbar"];

let passed = 0, failed = 0;
const results = [];
function check(name, cond, detail = "") {
  if (cond) { passed++; results.push(`✅ ${name}`); }
  else { failed++; results.push(`❌ ${name} — ${detail}`); console.error(`❌ ${name} — ${detail}`); }
}
const pg = new Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const allErrors = [];

async function loginPersona(browser, creds) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => allErrors.push(`PAGEERROR: ${String(e).slice(0, 300)}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/Failed to load resource:.*status of (401|400|403|404|409)/.test(t)) return;
    if (/Failed to load resource: net::/.test(t)) return; // transport noise (presence beacon on context close / unreachable legacy avatar URLs)
    allErrors.push(t.slice(0, 300));
  });
  await page.goto(BASE, { waitUntil: "networkidle0" });
  await page.type("[data-testid='login-email']", creds.email);
  await page.type("[data-testid='login-password']", creds.pw);
  await page.click("[data-testid='login-submit']");
  await page.waitForSelector("[data-testid='user-menu-btn']", { timeout: 25000 });
  await sleep(1200);
  return { ctx, page };
}

/** rect of a testid, or null */
const rectOf = (page, testid) => page.evaluate((t) => {
  const el = document.querySelector(`[data-testid='${t}']`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom, vw: window.innerWidth, vh: window.innerHeight, displayed: !!(el.offsetWidth || el.offsetHeight) };
}, testid);

const inside = (r) => r && r.displayed && r.x >= -1 && r.y >= -1 && r.right <= r.vw + 1.5 && r.bottom <= r.vh + 1.5;

async function openAndAssertMenu(page, btnTestid, panelTestid, label, widthLabel, closeBy = "escape") {
  await page.click(`[data-testid='${btnTestid}']`); // REAL click — throws if the control is off-screen
  await sleep(350);
  const r = await rectOf(page, panelTestid);
  check(`${label} opens fully inside viewport @${widthLabel}`, inside(r), JSON.stringify(r));
  if (closeBy === "escape") {
    await page.keyboard.press("Escape");
    await sleep(250);
    const gone = await page.$(`[data-testid='${panelTestid}']`);
    check(`${label} closes on Escape @${widthLabel}`, !gone, "panel still mounted");
  } else {
    await page.click(`[data-testid='${btnTestid}']`);
    await sleep(250);
  }
  return r;
}

async function main() {
  await pg.connect();
  const baseSess = (await pg.query("SELECT COALESCE(MAX(id),0) AS m FROM user_sessions")).rows[0].m;

  const browser = await puppeteer.launch({
    executablePath: "/tmp/al2023/chromium",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    headless: "new",
  });

  // ---------- A+B: OWNER sweep ----------
  const { page } = await loginPersona(browser, OWNER);
  // Make sure the dashboard actually rendered (business data present).
  await page.waitForSelector("aside", { timeout: 20000 });

  for (const w of WIDTHS) {
    await page.setViewport({ width: w, height: 900 });
    await sleep(450);
    const hOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`no page-x-clipping @${w}px`, hOverflow <= 1, `overflow=${hOverflow}`);
    let allIn = true, bad = [];
    for (const t of CONTROLS) {
      const r = await rectOf(page, t);
      if (!inside(r)) { allIn = false; bad.push(`${t}@${JSON.stringify(r)}`); }
    }
    check(`brand + all 5 controls inside viewport @${w}px`, allIn, bad.join(" | "));
  }

  for (const w of MENU_WIDTHS) {
    await page.setViewport({ width: w, height: 900 });
    await sleep(400);
    await openAndAssertMenu(page, "user-menu-btn", "user-account-menu", "Staff/Account menu", `${w}px`);
    // account menu still functional (both actions visible)
    const actions = await page.evaluate(() => {
      const m = document.querySelector("[data-testid='user-account-menu']");
      return m ? { pw: !!m.querySelector("[data-testid='open-change-password']"), out: !!m.querySelector("[data-testid='logout-btn']") } : null;
    }).catch(() => null);
    // menu just closed via Escape — reopen for the assertions below
    await page.click("[data-testid='user-menu-btn']");
    await sleep(300);
    const act2 = await page.evaluate(() => {
      const m = document.querySelector("[data-testid='user-account-menu']");
      return m ? { pw: !!m.querySelector("[data-testid='open-change-password']"), out: !!m.querySelector("[data-testid='logout-btn']") } : null;
    });
    check(`Staff/Account menu exposes Change Password + Sign out @${w}px`, !!(act2 && act2.pw && act2.out), JSON.stringify(act2));
    await page.keyboard.press("Escape");
    await sleep(200);

    await openAndAssertMenu(page, "att-clock-btn", "att-clock-panel", "Attendance clock panel", `${w}px`);
    await openAndAssertMenu(page, "notif-bell", "notif-panel", "Notification panel", `${w}px`, "toggle");

    // currency menu: open, inside viewport, click the ACTIVE currency (no state change) → closes
    await page.click("[data-testid='currency-switcher']");
    await sleep(300);
    const cr = await rectOf(page, "currency-menu");
    check(`Currency menu opens fully inside viewport @${w}px`, inside(cr), JSON.stringify(cr));
    const curInfo = await page.evaluate(() => {
      const menu = document.querySelector("[data-testid='currency-menu']");
      if (!menu) return null;
      const btns = [...menu.querySelectorAll("button")];
      const active = btns.find((b) => b.className.includes("text-emerald-400"));
      const before = document.querySelector("[data-testid='currency-switcher']")?.textContent || "";
      (active || btns[0]).click();
      return { count: btns.length, before };
    });
    await sleep(300);
    const after = await page.evaluate(() => ({
      menuGone: !document.querySelector("[data-testid='currency-menu']"),
      symbol: document.querySelector("[data-testid='currency-switcher']")?.textContent || "",
    }));
    check(`Currency menu lists all currencies & closes on pick @${w}px`, !!(curInfo && curInfo.count >= 3 && after.menuGone && after.symbol === curInfo.before), JSON.stringify({ curInfo, after }));
  }

  // ---------- C: sticky after deep scroll @768 (original failure width) ----------
  await page.setViewport({ width: 768, height: 900 });
  await sleep(300);
  const scroll = await page.evaluate(() => {
    window.scrollTo(0, 4000);
    return new Promise((res) => setTimeout(() => res({ y: window.scrollY, headerTop: document.querySelector("header")?.getBoundingClientRect().top }), 400));
  });
  check("navbar stays pinned at top after deep scroll", scroll.y > 200 && Math.abs(scroll.headerTop) <= 2, JSON.stringify(scroll));
  await page.click("[data-testid='user-menu-btn']");
  await sleep(350);
  const sr = await rectOf(page, "user-account-menu");
  check("Staff/Account menu inside viewport even after scroll @768px", inside(sr), JSON.stringify(sr));
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(250);

  await page.screenshot({ path: "/home/user/nav-1-fixed-768-account-menu.png" });
  // screenshot with menu open at 320 for the report
  await page.setViewport({ width: 320, height: 700 });
  await sleep(400);
  await page.click("[data-testid='att-clock-btn']");
  await sleep(350);
  await page.screenshot({ path: "/home/user/nav-2-fixed-320-clock.png" });
  await page.click("[data-testid='att-clock-btn']");
  await sleep(200);
  await page.setViewport({ width: 1440, height: 800 });
  await sleep(400);
  await page.click("[data-testid='user-menu-btn']");
  await sleep(350);
  await page.screenshot({ path: "/home/user/nav-3-fixed-1440-account-menu.png" });
  await page.keyboard.press("Escape");

  // ---------- D: WORKER persona @360 ----------
  const w = await loginPersona(browser, WORKER);
  await w.page.setViewport({ width: 360, height: 800 });
  await sleep(400);
  let allInWorker = true; const badW = [];
  for (const t of CONTROLS) {
    const r = await rectOf(w.page, t);
    if (!inside(r)) { allInWorker = false; badW.push(`${t}@${JSON.stringify(r)}`); }
  }
  check("WORKER: brand + all controls inside viewport @360px", allInWorker, badW.join(" | "));
  await w.page.click("[data-testid='user-menu-btn']");
  await sleep(300);
  const wr = await rectOf(w.page, "user-account-menu");
  check("WORKER: Staff/Account menu opens inside viewport @360px", inside(wr), JSON.stringify(wr));
  await w.page.keyboard.press("Escape");
  await sleep(200);
  await w.page.click("[data-testid='att-clock-btn']");
  await sleep(350);
  const wc = await rectOf(w.page, "att-clock-panel");
  const wcIn = await w.page.$("[data-testid='att-clockin'], [data-testid='att-clockout']");
  const noBizPicker = await w.page.$("[data-testid='att-clock-biz']");
  check("WORKER: clock panel inside viewport @360px", inside(wc), JSON.stringify(wc));
  check("WORKER: clock action button present, privileged picker hidden", !!wcIn && !noBizPicker, `btn=${!!wcIn} picker=${!!noBizPicker}`);
  await w.page.keyboard.press("Escape");
  await w.ctx.close();

  // ---------- E: zero page errors ----------
  check("zero page/console errors across all personas & viewports", allErrors.length === 0, allErrors.slice(0, 3).join(" || "));

  await browser.close();

  // ---------- Z: forensics purge (logins only) ----------
  await pg.query("DELETE FROM user_sessions WHERE id > $1", [baseSess]);
  const leaked = (await pg.query("SELECT COUNT(*)::int AS c FROM user_sessions WHERE id > $1", [baseSess])).rows[0].c;
  check(`session forensics clean (purged ${leaked === 0 ? "all" : "FAIL"} login sessions above baseline ${baseSess})`, leaked === 0, `${leaked} leftover`);

  await pg.end();

  console.log("\n================ verify-navbar ================");
  results.forEach((r) => console.log(r));
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("SUITE CRASH:", e); process.exit(2); });
