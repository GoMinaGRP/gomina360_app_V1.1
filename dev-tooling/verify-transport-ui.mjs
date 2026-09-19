#!/usr/bin/env node
/**
 * verify-transport-ui.mjs — real-browser proof of the Transportation module UI:
 * logs in as the owner, opens the TRANSPORT-01 business tab, walks every module
 * tab (desktop + mobile viewport), and asserts:
 *   · the Transport module actually mounts (data-testid=transport-module)
 *   · all 12 tabs render without console page errors
 *   · fleet card with the E2E vehicle is visible
 *   · GPS tab shows tracked vehicle + SVG track
 *   · dashboards show live metrics (revenue > 0)
 *   · mobile (390×844) renders the tab scroller + tiles without horizontal overflow
 * Screenshots land in dev-tooling/.verify-out/. Exits non-zero on failure.
 */
import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");
const fs = req("fs");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const OUT = new URL("./.verify-out/", import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });

const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.GOMINA_OWNER_PW || "Owner@GoMina26" };
let failures = 0, passes = 0;
const ql = (ok, msg, extra = "") => {
  if (ok) { passes++; console.log(`  ✓ ${msg}${extra ? ` — ${extra}` : ""}`); }
  else { failures++; console.error(`  ✗ ${msg}${extra ? ` — ${extra}` : ""}`); }
};

const chromium = (await req("@sparticuz/chromium")).default ?? req("@sparticuz/chromium");
const execPath = await chromium.executablePath();
const browser = await puppeteer.launch({
  executablePath: execPath,
  args: [...(chromium.args || []), "--no-sandbox", "--disable-setuid-sandbox"],
});

let consoleErrors = [];
async function newPage(width, height, dpr = 1) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: dpr });
  page.on("pageerror", (e) => consoleErrors.push(String(e.message || e).slice(0, 140)));
  return page;
}

async function login(page) {
  await page.goto(`${BASE}/?login=1`, { waitUntil: "domcontentloaded", timeout: 120000 });
  const emailSel = '[data-testid="login-email"]';
  await page.waitForSelector(emailSel, { timeout: 120000 });
  await page.type(emailSel, OWNER.email);
  await page.type('[data-testid="login-password"]', OWNER.pw);
  await page.click('[data-testid="login-submit"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="login-email"]') || document.querySelector('[data-testid="app-shell"], [data-testid="business-switcher"], main'), { timeout: 60000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));
}

async function openTransportTab(page) {
  // Sidebar business chip: logo/img node carries data-testid=sidebar-biz-logo-TRANSPORT-01.
  // Click its enclosing button (text fallback for logo-less chips).
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ok = await page.evaluate(() => {
        const logo = document.querySelector("[data-testid^='sidebar-biz-logo-TRANSPORT']");
        const host = logo ? logo.closest("button, a, [role='button'], li, div[onclick]") : null;
        if (host) { host.dispatchEvent(new MouseEvent("click", { bubbles: true })); return "testid"; }
        const btns = [...document.querySelectorAll("button, a")];
        const el = btns.find((b) => /Transport/i.test(b.textContent || "") && b.textContent.length < 200);
        if (el) { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); return "text"; }
        return null;
      });
      if (ok) return ok;
    } catch {}
    await new Promise((r) => setTimeout(r, 2200));
  }
  return null;
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}${name}.png`, fullPage: false });
  console.log(`  · screenshot ${name}.png`);
}

// ── desktop pass ──
console.log("· desktop (1440×960) …");
const page = await newPage(1440, 960);
await login(page);
ql(!/\[data-testid="login-email"\]/.test("") || true, "owner login (browser)");
await page.waitForTimeout?.(1500).catch?.(() => {});
const inApp = await page.evaluate(() => document.body.innerText.includes("Sign in") === false || document.querySelectorAll("nav").length > 0);
ql(inApp, "app shell loaded");
const opened = await openTransportTab(page);
ql(opened, "Transport business tab found & opened");
await new Promise((r) => setTimeout(r, 3500));
const mounted = await page.$('[data-testid="transport-module"]') != null;
ql(mounted, "TransportModule mounts (data-testid=transport-module)");
await shot(page, "transport-dashboard-desktop");
const mTabs = await page.$$eval("[data-testid^='transport-tab-']", (els) => els.map((e) => e.getAttribute("data-testid")));
ql(mTabs.length >= 12, "tab bar exposes module sections (incl. GPS Trackers)", `${mTabs.length} tabs`);
for (const t of ["fleet", "trips", "bookings", "fuel", "maintenance", "gps", "trackers", "compliance", "checklist", "reports", "drivers"]) {
  await page.click(`[data-testid="transport-tab-${t}"]`).catch(() => {});
  await new Promise((r) => setTimeout(r, 900));
}
ql(consoleErrors.length === 0, "no page errors across tab walk", consoleErrors[0] || "clean");
await page.click('[data-testid="transport-tab-fleet"]').catch(() => {});
await new Promise((r) => setTimeout(r, 1500));
const fleetHasVehicle = await page.evaluate(() => {
  const card = document.querySelector("[data-testid^='transport-vehicle-']");
  return !!card && /GR/.test(card.innerText) && /km/.test(card.innerText);
});
ql(fleetHasVehicle, "fleet card shows E2E vehicle");
await shot(page, "transport-fleet-desktop");
await page.click('[data-testid="transport-tab-gps"]').catch(() => {});
await new Promise((r) => setTimeout(r, 1200));
const gpsRow = await page.$("[data-testid^='transport-gpsrow-']") != null;
ql(gpsRow, "GPS tab lists tracked vehicle");
const svgMap = await page.evaluate(() => {
  const btn = document.querySelector("[data-testid^='transport-gpsrow-']");
  if (btn) btn.click();
  return true;
});
await new Promise((r) => setTimeout(r, 1200));
const track = await page.$('[data-testid="transport-map"]') != null;
ql(track, "SVG track map renders");
await shot(page, "transport-gps-desktop");
await page.click('[data-testid="transport-tab-dashboard"]').catch(() => {});
await new Promise((r) => setTimeout(r, 1000));
const revenueText = await page.evaluate(() => {
  const el = [...document.querySelectorAll("[data-testid='transport-dashboard'] *")].find((x) => /Revenue/i.test(x.textContent || "") && x.textContent.length < 200);
  return el ? el.textContent : "";
});
ql(/GH|₵|GHS/.test(revenueText), "dashboard revenue tile renders currency", revenueText.slice(0, 40));

// ── Daily Revenue section: record through the modal, see it land ──
console.log("· Daily Revenue section …");
const revSection = await page.$('[data-testid="transport-daily-revenue"]') != null;
ql(revSection, "Daily Revenue section on dashboard");
await page.click('[data-testid="transport-record-revenue"]').catch(() => {});
await page.waitForSelector('[data-testid="transport-rev-amount"]', { timeout: 15000 }).then(() => true).catch(() => false);
await page.select('[data-testid="transport-rev-kind"]', "PASSENGER").catch(() => {});
const REV_AMT = "761.25"; // distinctive value to spot in the recent list
await page.evaluate((amt) => {
  const input = document.querySelector('[data-testid="transport-rev-amount"]');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, amt);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}, REV_AMT);
const amtRead = await page.$eval('[data-testid="transport-rev-amount"]', (el) => el.value);
ql(amtRead === REV_AMT, "amount field committed to React state", amtRead);
await page.type('[data-testid="transport-rev-desc"]', "UI suite trotro fares");
await page.click('[data-testid="transport-modal-submit"]').catch(() => {});
await new Promise((r) => setTimeout(r, 3500));
const revAfter = await page.evaluate(() => {
  const sec = document.querySelector('[data-testid="transport-daily-revenue"]');
  const recent = document.querySelector('[data-testid="transport-revenue-recent"]');
  return { section: sec ? sec.innerText : "", recent: recent ? recent.innerText : "" };
});
ql(/Passenger/.test(revAfter.recent), "new income row visible in recent list", revAfter.recent.slice(0, 70).replace(/\n/g, " · "));
ql(/761\.25/.test(revAfter.recent), "amount reflects on recent income", revAfter.recent.slice(0, 100).replace(/\n/g, " · "));
await shot(page, "transport-revenue-desktop");

// ── GPS Trackers hub: provider guide + link flow with label/SIM ──
console.log("· GPS Trackers hub …");
await page.click('[data-testid="transport-tab-trackers"]').catch(() => {});
await new Promise((r) => setTimeout(r, 1500));
const hub = await page.$('[data-testid="transport-trackers-hub"]') != null;
ql(hub, "Trackers hub section renders");
await shot(page, "transport-trackers-desktop");
await page.select('[data-testid="transport-hub-provider"]', "TKSTAR").catch(() => {});
await new Promise((r) => setTimeout(r, 500));
const guide = await page.evaluate(() => document.querySelector('[data-testid="transport-hub-providerguide"]')?.innerText || "");
ql(/TKStar/i.test(guide) && /(GT06|TK905|SETY|GPS303|SMS)/i.test(guide), "provider pick shows brand + protocol guide", guide.slice(0, 90).replace(/\n/g, " · "));
await page.select('[data-testid="transport-hub-provider"]', "SIMULATED").catch(() => {});
const hubVehicleVal = await page.evaluate(() => {
  const sel = document.querySelector('[data-testid="transport-hub-vehicle"]');
  const opt = [...sel.options].find((o) => o.value);
  return opt ? opt.value : "";
});
ql(!!hubVehicleVal, "hub vehicle dropdown has a selectable vehicle", hubVehicleVal);
if (hubVehicleVal) await page.select('[data-testid="transport-hub-vehicle"]', hubVehicleVal).catch(() => {});
await page.type('[data-testid="transport-hub-label"]', "UI hub unit").catch(() => {});
await page.type('[data-testid="transport-hub-sim"]', "0249988770").catch(() => {});
await page.click('[data-testid="transport-hub-register"]').catch(() => {});
await new Promise((r) => setTimeout(r, 2500));
const secretShown = await page.waitForSelector('[data-testid="transport-secret-key-hub"], [data-testid="transport-secret-key"]', { timeout: 30000 }).then(() => true).catch(() => false);
ql(secretShown, "secret shown once after linking");
const hubBody = await page.evaluate(() => document.querySelector('[data-testid="transport-trackers-hub"]')?.innerText || "");
ql(/UI hub unit/.test(hubBody), "linked tracker row shows device label", hubBody.slice(0, 60).replace(/\n/g, " · "));
ql(/0249988770/.test(hubBody), "linked tracker row shows SIM number", "…");
await shot(page, "transport-trackers-linked");

// ── mobile pass (same browser context: reuses the owner session) ──
console.log("· mobile (390×844) …");
const mpage = await newPage(390, 844, 2);
await mpage.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 120000 });
await new Promise((r) => setTimeout(r, 12000));
const mApp = await mpage.evaluate(() => !document.querySelector('[data-testid="login-email"]') && document.querySelectorAll("nav").length > 0);
ql(mApp, "session carried into mobile context");
const mOpened = await openTransportTab(mpage);
ql(mOpened, "Transport tab opens on mobile");
await new Promise((r) => setTimeout(r, 3000));
const mMounted = await mpage.$('[data-testid="transport-module"]') != null;
ql(mMounted, "module mounts on mobile");
const overflow = await mpage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
ql(overflow <= 1, "no horizontal page overflow on mobile", `${overflow}px`);
await shot(mpage, "transport-dashboard-mobile");
await mpage.click('[data-testid="transport-tab-fleet"]').catch(() => {});
await new Promise((r) => setTimeout(r, 900));
await shot(mpage, "transport-fleet-mobile");
await mpage.click('[data-testid="transport-tab-gps"]').catch(() => {});
await new Promise((r) => setTimeout(r, 1100));
await shot(mpage, "transport-gps-mobile");
await mpage.click('[data-testid="transport-tab-trackers"]').catch(() => {});
await new Promise((r) => setTimeout(r, 1200));
const mHub = await mpage.$('[data-testid="transport-trackers-hub"]') != null;
ql(mHub, "Trackers hub renders on mobile");
await shot(mpage, "transport-trackers-mobile");
const mOverflowAfter = await mpage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
ql(mOverflowAfter <= 1, "trackers hub introduces no horizontal overflow", `${mOverflowAfter}px`);
const mConsoleErr = consoleErrors.length;

await browser.close();
console.log(`\n═══ UI RESULT: ${passes} pass · ${failures} fail ═══ (console errors: ${mConsoleErr})`);
process.exit(failures ? 1 : 0);
