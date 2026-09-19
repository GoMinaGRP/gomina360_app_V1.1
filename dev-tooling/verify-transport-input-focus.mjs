#!/usr/bin/env node
/**
 * verify-transport-input-focus.mjs — regression test for the data-entry
 * focus bug in the Transportation module. For every input-bearing surface
 * it simulates CONTINUOUS typing (one char at a time, real keystrokes) and
 * asserts that after each character (a) focus remains inside THAT input and
 * (b) the full typed string landed — so users can type whole words/sentences
 * without the caret being dropped by a re-render.
 *
 * Covers desktop (1440px): Register vehicle, Record daily revenue, Daily
 * checklist, Log fuel, Maintenance job, Booking, Trip, Geofence modals and
 * the inline GPS Trackers link form; plus a mobile (390px) pass.
 *
 * Prerequisites: app on BASE_URL with E2E transport fixtures (run
 * dev-tooling/verify-transport.mjs once to provision them).
 * Run: LD_LIBRARY_PATH=/tmp/al2023/lib BASE_URL=http://127.0.0.1:3001 node dev-tooling/verify-transport-input-focus.mjs
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
const browser = await puppeteer.launch({
  executablePath: await chromium.executablePath(),
  args: [...(chromium.args || []), "--no-sandbox", "--disable-setuid-sandbox"],
});

let consoleErrors = [];
async function newPage(w, h, dpr = 1) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: dpr });
  page.on("pageerror", (e) => consoleErrors.push(String(e.message || e).slice(0, 140)));
  return page;
}
async function login(page) {
  await page.goto(`${BASE}/?login=1`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector('[data-testid="login-email"]', { timeout: 120000 });
  await page.type('[data-testid="login-email"]', OWNER.email);
  await page.type('[data-testid="login-password"]', OWNER.pw);
  await page.click('[data-testid="login-submit"]');
  await new Promise((r) => setTimeout(r, 3000));
}
async function openBusiness(page, nameRe) {
  for (let a = 0; a < 3; a++) {
    const ok = await page.evaluate((reSrc) => {
      const re = new RegExp(reSrc, "i");
      const sidebar = document.querySelector('[data-testid="nav-sidebar"]') || document;
      const el = [...sidebar.querySelectorAll("button, a")].find((b) => re.test(b.textContent || "") && (b.textContent || "").length < 160);
      if (el) { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); return true; }
      return false;
    }, nameRe.source);
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 2200));
  }
  return false;
}
async function goTab(page, tab) {
  await page.click(`[data-testid="transport-tab-${tab}"]`).catch(() => {});
  await new Promise((r) => setTimeout(r, 900));
}
/** Type `text` char-by-char into selector; after EACH char assert focus is still inside that input. */
async function typeAssertFocus(page, selector, text, label) {
  await page.waitForSelector(selector, { timeout: 15000 });
  await page.click(selector);
  let droppedAt = -1;
  for (let i = 0; i < text.length; i++) {
    await page.keyboard.type(text[i], { delay: 5 });
    await new Promise((r) => setTimeout(r, 40)); // a full react render cycle worth of slack
    const ok = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return !!el && (document.activeElement === el || el.contains(document.activeElement));
    }, selector);
    if (!ok && droppedAt < 0) { droppedAt = i; break; }
  }
  const value = await page.$eval(selector, (el) => el.value).catch(() => null);
  const clean = (droppedAt < 0) && value === text;
  ql(clean, `${label}: continuous typing keeps focus`, droppedAt >= 0 ? `focus dropped after char ${droppedAt + 1} of "${text}"` : `"${value}"`);
  return clean;
}
async function closeModal(page) {
  await page.click('[data-testid="transport-modal-close"]').catch(() => {});
  await new Promise((r) => setTimeout(r, 400));
}

console.log("· desktop (1440×960) — E2E Transport …");
const page = await newPage(1440, 960);
await login(page);
ql(await openBusiness(page, /E2E Transport/i), "E2E transport business opened");
await page.waitForSelector('[data-testid="transport-module"]', { timeout: 90000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 2500));

// 1 ─ Register vehicle modal (Dashboard tab)
await page.click('[data-testid="transport-add-vehicle"]');
await typeAssertFocus(page, '[data-testid="transport-f-name"]', "Volvo FH16 750 Long Haul", "vehicle name");
await typeAssertFocus(page, '[data-testid="transport-f-plate"]', "GR 4482-25", "license plate");
await typeAssertFocus(page, '[data-testid="transport-modal"] input[placeholder*="Tanker"]', "Refrigerated body, tail lift fitted", "vehicle notes");
await closeModal(page);

// 2 ─ Record daily revenue modal (Dashboard tab)
await page.click('[data-testid="transport-record-revenue"]');
await typeAssertFocus(page, '[data-testid="transport-rev-customer"]', "Accra Mall Logistics Contract", "revenue payer");
await typeAssertFocus(page, '[data-testid="transport-rev-desc"]', "Two round trips of maize from Ejisu market", "revenue description");
await closeModal(page);

// 3 ─ Daily checklist modal (Checklist tab)
await goTab(page, "checklist");
await page.click('[data-testid="transport-add-checklist"]').catch(() => {});
await typeAssertFocus(page, '[data-testid="transport-modal"] input[placeholder*="mechanic"]', "Rear-left tyre losing pressure overnight", "checklist notes");
await closeModal(page);

// 4 ─ Log fuel modal (Fuel tab)
await goTab(page, "fuel");
await page.click('[data-testid="transport-add-fuel"]').catch(() => {});
await typeAssertFocus(page, '[data-testid="transport-f-liters"]', "45.5", "fuel litres");
await closeModal(page);

// 5 ─ Maintenance modal (Maintenance tab)
await goTab(page, "maintenance");
await page.click('[data-testid="transport-add-maint"]').catch(() => {});
await typeAssertFocus(page, '[data-testid="transport-f-title"]', "Replace brake pads and resurface discs", "maintenance title");
await closeModal(page);

// 6 ─ Booking modal (Bookings tab)
await goTab(page, "bookings");
await page.click('[data-testid="transport-add-booking"]').catch(() => {});
await typeAssertFocus(page, '[data-testid="transport-f-cust"]', "Kwabena Mensah — Kasoa Depot", "booking customer");
await typeAssertFocus(page, '[data-testid="transport-f-origin"]', "Tema Harbour Warehouse 12", "booking origin");
await closeModal(page);

// 7 ─ Trip modal (Trips tab)
await goTab(page, "trips");
await page.click('[data-testid="transport-add-trip"]').catch(() => {});
await typeAssertFocus(page, '[data-testid="transport-f-source"]', "Tema Port Gate B", "trip source");
await typeAssertFocus(page, '[data-testid="transport-f-dest"]', "Kumasi Central Market", "trip destination");
await closeModal(page);

// 7b ─ per-row maintenance actual-cost input (inline in tab list)
await goTab(page, "maintenance");
await new Promise((r) => setTimeout(r, 1200)); // rows render after tab data paint
const mcSel = await page.evaluate(() => {
  for (let i = 0; i < 3; i++) {
    const el = document.querySelector('[data-testid^="transport-mcost-"]');
    if (el) return `[data-testid="${el.getAttribute("data-testid")}"]`;
    return null;
  }
  return null;
});
if (mcSel) {
  await typeAssertFocus(page, mcSel, "1250", "maintenance actual cost (inline row)");
} else {
  const dbg = await page.evaluate(() => ({
    tab: document.querySelector('[data-testid="transport-tab-maintenance"]')?.className?.includes("bg-sky") || null,
    rows: [...document.querySelectorAll('[data-testid^="transport-maintrow-"]')].map((e) => e.innerText.replace(/\s+/g, " ").slice(0, 80)),
    mcost: document.querySelectorAll('[data-testid^="transport-mcost-"]').length,
  })).catch((e) => ({ err: String(e).slice(0, 80) }));
  console.log("   · no maintenance rows yet — inline cost input skipped ::", JSON.stringify(dbg));
  await page.screenshot({ path: `${OUT}transport-input-focus-maint-debug.png` }).catch(() => {});
}
await goTab(page, "gps");

// 8 ─ Geofence modal (GPS tab)
await goTab(page, "gps");
await page.click('[data-testid="transport-add-geofence"]').catch(() => {});
await typeAssertFocus(page, '[data-testid="transport-f-fencename"]', "Accra Depot Loading Zone", "geofence name");
await closeModal(page);

// 9 ─ inline GPS Trackers link form (Trackers hub)
await goTab(page, "trackers");
await page.click('[data-testid="transport-tracker-link"]').catch(() => {});
await new Promise((r) => setTimeout(r, 600));
await typeAssertFocus(page, '[data-testid="transport-hub-label"]', "Box Truck TK Unit 10", "tracker device label");
await typeAssertFocus(page, '[data-testid="transport-hub-imei"]', "359684221507777", "tracker IMEI");
await typeAssertFocus(page, '[data-testid="transport-hub-sim"]', "+233 55 000 1111", "tracker SIM");

await page.screenshot({ path: `${OUT}transport-input-focus-desktop.png` });
const dErrs = consoleErrors.filter((e) => !/favicon/i.test(e));
ql(dErrs.length === 0, "no page errors during desktop typing walk", dErrs[0] || "clean");

console.log("· mobile (390×844) …");
const mp = await newPage(390, 844, 2);
await mp.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 120000 });
await new Promise((r) => setTimeout(r, 6000));
await openBusiness(mp, /E2E Transport/i);
await mp.waitForSelector('[data-testid="transport-module"]', { timeout: 90000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 2500));
await mp.click('[data-testid="transport-record-revenue"]').catch(() => {});
await new Promise((r) => setTimeout(r, 700));
await typeAssertFocus(mp, '[data-testid="transport-rev-customer"]', "Mobile User Typing A Long Name", "mobile revenue payer");
await typeAssertFocus(mp, '[data-testid="transport-rev-desc"]', "Typed entirely on a phone-sized screen", "mobile revenue description");
await mp.screenshot({ path: `${OUT}transport-input-focus-mobile.png` });
const mErrs = consoleErrors.filter((e) => !/favicon/i.test(e));
ql(mErrs.length === 0, "no page errors during mobile typing walk", "…");

await browser.close();
console.log(`\n═══ TRANSPORT INPUT FOCUS: ${passes} pass · ${failures} fail ═══`);
process.exit(failures ? 1 : 0);
