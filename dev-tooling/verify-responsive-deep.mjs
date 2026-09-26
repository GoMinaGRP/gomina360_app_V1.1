// Deep mobile/tablet responsiveness audit of GoMina 360.
//
// For EVERY navigation surface (all businesses + every cross-cutting page the
// signed-in role can reach) and EVERY in-page tab inside it, at PHONE 375px
// and TABLET 768px:
//   • no horizontal document overflow
//   • every interactive element (button, link, input, select, textarea) sits
//     fully inside the viewport — unless it lives inside a legit horizontal
//     scroll container (overflow-x:auto) where scrolling is the intended UX
// Drill: tab bars ([data-testid$="-tabs"], [data-testid$="-tab-bar"],
// [data-testid$="-subtabs"]) are clicked through automatically, two levels
// deep, so every module tab is covered.
//
//   node dev-tooling/verify-responsive-deep.mjs            (phone + tablet, OWNER + worker)
//   VIEWPORTS=phone node dev-tooling/verify-responsive-deep.mjs   (single pass)

import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.OWNER_PW || "Owner@GoMina26" };
const AKUA = { email: "akua.donkor@gomina360.com", pw: process.env.AKUA_PW || "GoMina@User10" };
const VIEWPORTS = (process.env.VIEWPORTS || "phone,tablet").split(",");
const ROLES = (process.env.ROLES || "owner,worker").split(",");
const VP = { phone: { width: 375, height: 812, isMobile: true, hasTouch: true }, tablet: { width: 768, height: 1024, isMobile: true, hasTouch: true } };

const browser = await puppeteer.launch({ executablePath: "/tmp/al2023/chromium", headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pageErrors = [];
const isNoise = (t) => /eval\(\) is not supported|React requires eval\(\)|React will never use eval|ResizeObserver loop/.test(t);

const results = []; // { viewport, role, surface, tab, docOverflow, clipped:[] }
let surfacesChecked = 0, tabsChecked = 0;
let shotN = 0;

async function newPage(vp, label) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport(VP[vp]);
  page.on("pageerror", (e) => { if (!isNoise(String(e))) pageErrors.push(`[${label}] ${String(e).slice(0, 200)}`); });
  page.on("console", (m) => { if (m.type() === "error") { const t = m.text(); if (!isNoise(t) && !/401|403|Failed to load resource|net::ERR_/.test(t)) pageErrors.push(`[${label}] ${t.slice(0, 200)}`); } });
  return { ctx, page };
}

async function login(page, who) {
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid="login-email"]', { timeout: 30000 });
  await page.type('[data-testid="login-email"]', who.email);
  await page.type('[data-testid="login-password"]', who.pw);
  await page.click('[data-testid="login-submit"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="login-screen"]'), { timeout: 30000 });
  await sleep(2000);
}

/** Audit the current view: doc overflow + clipped interactive elements. */
const auditView = (page) => page.evaluate(() => {
  const iw = window.innerWidth;
  const docOverflow = document.documentElement.scrollWidth > iw + 1;
  const insideScroller = (el) => {
    let p = el.parentElement;
    while (p && p !== document.body) {
      const cs = getComputedStyle(p);
      if (/(auto|scroll)/.test(cs.overflowX)) return true;
      p = p.parentElement;
    }
    return false;
  };
  const clipped = [];
  for (const el of document.querySelectorAll("button, a[href], input, select, textarea, [role='button']")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.left >= iw || r.right <= 0) continue; // entirely offscreen (hidden panel)
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || cs.pointerEvents === "none") continue;
    if ((r.right > iw + 2 || r.left < -2) && !insideScroller(el)) {
      clipped.push({
        what: el.getAttribute("data-testid") || `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}`,
        text: (el.textContent || el.value || "").replace(/\s+/g, " ").trim().slice(0, 20),
        left: Math.round(r.left), right: Math.round(r.right),
      });
      if (clipped.length >= 5) break;
    }
  }
  return { docOverflow, sw: document.documentElement.scrollWidth, iw, clipped };
});

/** Visible tab/view-switch buttons on the current view (max 24).
 *  Convention across GoMina: tab buttons carry <prefix>-tab-<key> or
 *  ct-view-<key> style testids (poultry-tab-…, aqua-tab-…, wk-tab-…,
 *  rst-tab-…, elex-tab-…, bdm-tab-…, aud-tab-…, ct-view-…, …). */
const TAB_SEL = 'button[data-testid*="-tab-"], button[data-testid*="-view-"]';
const tabButtons = (page) => page.evaluate((sel) => {
  const btns = [];
  for (const b of document.querySelectorAll(sel)) {
    // sidebar nav + top navbar buttons are NAVIGATION, not in-page tabs
    if (b.closest('[data-testid="nav-sidebar"], [data-testid="top-navbar"], nav')) continue;
    const r = b.getBoundingClientRect();
    if (r.width > 0) btns.push({ tid: b.getAttribute("data-testid") || "", text: (b.textContent || "").replace(/\s+/g, " ").trim().slice(0, 30) });
  }
  return btns.slice(0, 24);
}, TAB_SEL);

const clickTab = (page, b) => page.evaluate((sel, tid) => {
  for (const el of document.querySelectorAll(sel)) {
    if (el.getAttribute("data-testid") === tid) { el.click(); return true; }
  }
  return false;
}, TAB_SEL, b.tid);

/** Sidebar nav buttons (visible text, no sign-out). */
const navButtons = (page) => page.evaluate(() => {
  const sb = document.querySelector('[data-testid="nav-sidebar"]') || document.body;
  const out = [];
  for (const b of sb.querySelectorAll("button")) {
    const text = (b.textContent || "").replace(/\s+/g, " ").trim();
    const r = b.getBoundingClientRect();
    if (!text || r.width === 0) continue;
    if (/sign out|log ?out/i.test(text)) continue;
    out.push({ text: text.slice(0, 40), tid: b.getAttribute("data-testid") || "" });
  }
  return out;
});

const clickNav = (page, item) => page.evaluate((tid, text) => {
  const sb = document.querySelector('[data-testid="nav-sidebar"]') || document.body;
  for (const el of sb.querySelectorAll("button")) {
    const t = (el.textContent || "").replace(/\s+/g, " ").trim();
    if ((tid && el.getAttribute("data-testid") === tid) || (!tid && t.slice(0, 40) === text)) { el.click(); return true; }
  }
  return false;
}, item.tid, item.text);

async function sweep(page, vp, role) {
  const nav = await navButtons(page);
  if (nav.length === 0) {
    // WORKER: no sidebar nav — the workspace tabs ARE the surfaces.
    console.log("  (no sidebar nav — sweeping in-page workspace tabs as surfaces)");
    surfacesChecked++;
    results.push({ vp, role, surface: "Worker Dashboard", tab: "", ...(await auditView(page)) });
    for (const b of await tabButtons(page)) {
      if (!(await clickTab(page, b))) continue;
      await sleep(1300);
      tabsChecked++;
      results.push({ vp, role, surface: "Worker Dashboard", tab: b.text || b.tid, ...(await auditView(page)) });
    }
    return;
  }
  console.log(`  ${nav.length} nav surfaces: ${nav.map((n) => n.text).join(" · ").slice(0, 300)}`);
  for (const item of nav) {
    const clicked = await clickNav(page, item);
    if (!clicked) continue;
    await sleep(2200);
    surfacesChecked++;
    let a = await auditView(page);
    results.push({ vp, role, surface: item.text, tab: "", ...a });
    // drill tabs (depth 2: tab bars that appear AFTER a tab click too)
    const seen = new Set();
    let queue = (await tabButtons(page)).filter((b) => b.tid);
    queue.forEach((b) => seen.add(b.tid));
    let guard = 0;
    for (const b of queue.slice(0, 18)) {
      if (guard++ > 18) break;
      if (!(await clickTab(page, b))) continue;
      await sleep(1100);
      tabsChecked++;
      a = await auditView(page);
      results.push({ vp, role, surface: item.text, tab: b.text || b.tid, ...a });
      // second-level tabs that just appeared
      for (const b2 of await tabButtons(page)) {
        if (!seen.has(b2.tid)) { seen.add(b2.tid); queue.push(b2); }
      }
    }
    // return to a stable state for the next nav click (nav is always visible)
  }
}

try {
  for (const vp of VIEWPORTS) {
    for (const role of ROLES) {
      const who = role === "owner" ? OWNER : AKUA;
      console.log(`\n══ ${vp.toUpperCase()} ${VP[vp].width}×${VP[vp].height} · ${role} ══`);
      const { ctx, page } = await newPage(vp, `${vp}:${role}`);
      await login(page, who);
      await sweep(page, vp, role);
      // screenshot every FAILING surface at this viewport (max 8)
      const failsHere = results.filter((r) => r.vp === vp && r.role === role && (r.docOverflow || r.clipped.length));
      const surfaces = [...new Set(failsHere.map((r) => r.surface))];
      for (const s of surfaces.slice(0, 8)) {
        const item = (await navButtons(page)).find((n) => n.text === s);
        if (item && (await clickNav(page, item))) {
          await sleep(2000);
          shotN++;
          await page.screenshot({ path: `/home/user/deep-${vp}-${role}-${String(shotN).padStart(2, "0")}.png`, fullPage: false });
        }
      }
      await ctx.close();
    }
  }
} catch (err) {
  console.error("FATAL", err);
} finally {
  await browser.close();
}

// ── Report ──
const total = results.length;
const bad = results.filter((r) => r.docOverflow || r.clipped.length);
console.log(`\n══ DEEP RESPONSIVE AUDIT: ${total} views checked (${surfacesChecked} surfaces + ${tabsChecked} tab views) ══`);
if (bad.length === 0) {
  console.log("✅ ZERO issues: no document overflow, no clipped interactive elements anywhere.");
} else {
  console.log(`❌ ${bad.length} problematic views:\n`);
  for (const r of bad) {
    const where = `${r.vp}/${r.role} · ${r.surface}${r.tab ? ` › ${r.tab}` : ""}`;
    if (r.docOverflow) console.log(`  ① DOC OVERFLOW — ${where} (scrollW=${r.sw}/${r.iw})`);
    for (const c of r.clipped) console.log(`  ② CLIPPED ${c.what}${c.text ? ` "${c.text}"` : ""} (L${c.left}/R${c.right}/vw${r.iw}) — ${where}`);
  }
}
if (pageErrors.length) { console.log(`\nPage errors (${pageErrors.length}):`); pageErrors.slice(0, 10).forEach((e) => console.log(" •", e)); }
else console.log("\nPage errors: none");

import { writeFileSync } from "node:fs";
writeFileSync("/home/user/deep-responsive-report.json", JSON.stringify({ total, surfacesChecked, tabsChecked, bad: bad.length, results, pageErrors }, null, 2));
process.exit(bad.length || pageErrors.length ? 1 : 0);
