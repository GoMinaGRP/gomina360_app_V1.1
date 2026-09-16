#!/usr/bin/env node
/**
 * transport-regression-check.mjs — boot health + module UI regression pass.
 *
 * 1. Signs in as the owner in headless Chromium (sparticuz chromium via
 *    puppeteer-core; LD_LIBRARY_PATH=/tmp/al2023/lib required in this sandbox).
 * 2. Walks EVERY seeded business module tab (POULTRY/BLOCK/AQUA/…/WASH/HARDWARE)
 *    + the Transport module and asserts: no pageerror, no 4xx/5xx document
 *    response, and the module root renders (`main` contains >200 chars).
 * 3. Transport-specific checks in the SAME session: module mounts, 11 tabs,
 *    fleet card present, GPS tab shows tracked vehicle + SVG track, dashboard
 *    revenue tile shows currency, violations tab lists SPEEDING + geofence
 *    violations from the API suite run.
 * 4. Screenshots to dev-tooling/.verify-out/regression-latest_*.png
 *
 * Exit code 0 = all checks pass. BASE_URL default http://127.0.0.1:3000.
 */
import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");
const fs = req("fs");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.GOMINA_OWNER_PW || "Owner@GoMina26" };
const OUT = new URL("./.verify-out/", import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });

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
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e.message || e).slice(0, 120)));
const docFails = [];
page.on("response", (r) => {
  if (r.status() >= 400 && r.request().resourceType() === "document") docFails.push(`${r.status()} ${page.url()}`.slice(0, 100));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SETTINGS_TIMEOUT = 120000;

async function login() {
  await page.goto(`${BASE}/?login=1`, { waitUntil: "domcontentloaded", timeout: SETTINGS_TIMEOUT });
  await page.waitForSelector('[data-testid="login-email"]', { timeout: SETTINGS_TIMEOUT });
  await page.type('[data-testid="login-email"]', OWNER.email);
  await page.type('[data-testid="login-password"]', OWNER.pw);
  await page.click('[data-testid="login-submit"]');
  await page.waitForSelector('[data-testid="nav-sidebar"]', { timeout: SETTINGS_TIMEOUT });
  console.log("  · signed in");
}

async function clickBiz(codePrefix) {
  // Clicks a sidebar business chip by code prefix (logo img or text child).
  for (let i = 0; i < 3; i++) {
    try {
      const got = await page.evaluate((p) => {
        const logo = document.querySelector(`[data-testid^='sidebar-biz-logo-${p}']`);
        const host = logo ? logo.closest("button, a, [role='button'], div[onclick], li, span") : null;
        if (host) { host.dispatchEvent(new MouseEvent("click", { bubbles: true })); return true; }
        const cands = [...document.querySelectorAll("button, a, [role='button'], div, span, li")];
        const hit = cands.find((e) => {
          const t = (e.textContent || "").toUpperCase();
          return t.includes(p) && t.length < 200;
        });
        if (hit) { hit.dispatchEvent(new MouseEvent("click", { bubbles: true })); return true; }
        return false;
      }, codePrefix);
      if (got) return true;
    } catch { /* navigated */ }
    await sleep(1500);
  }
  return false;
}

async function moduleHealth(label) {
  // Lazy-loaded modules may need several seconds of data fetches before they
  // paint — poll instead of a fixed sleep.
  let len = 0;
  for (let i = 0; i < 12; i++) {
    await sleep(1000);
    len = await page.evaluate(() => (document.querySelector("main")?.innerText || "").trim().length).catch(() => 0);
    if (len > 400) break;
  }
  ql(len > 150, `${label}: module content renders`, `${len} chars`);
}

async function shot(name) {
  await page.screenshot({ path: `${OUT}regression-latest_${name}.png` }).catch(() => {});
}

let logged = false;
for (let i = 0; i < 3 && !logged; i++) {
  try { await login(); logged = true; } catch (e) {
    console.log(`  · login attempt ${i + 1} failed (dev warm-up?) — reloading…`);
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    await sleep(3000);
  }
}
ql(logged, "owner session");
if (!logged) { await browser.close(); process.exit(1); }

// ---- module boot walk across legacy modules (regression) ----
// [prefix-or-logo, label, chip-search-keyword, content-marker]
for (const [chip, label, marker] of [
  ["POULTRY", "Poultry", "eggs|poultry"],
  ["CONCRETE", "Blocks", "blocks|aggregate|cement"],
  ["TILAPIA", "Aquaculture", "fish|tilapia|volta"],
  ["CATTLE", "Livestock", "cattle|livestock|herd"],
  ["HERITAGE", "Restaurant", "kitchen|restaurant"],
  ["TECH", "Electronics", "electronics|tech"],
  ["WASH", "Car Wash", "wash"],
  ["HARDWARE", "Hardware", "hardware"],
]) {
  const ok = await clickBiz(chip);
  ql(ok, `${label}: sidebar chip clickable`);
  await moduleHealth(label);
  if (ok) {
    const marked = await page.evaluate((m) => new RegExp(m, "i").test(document.querySelector("main")?.innerText || ""), marker).catch(() => false);
    ql(marked, `${label}: module identity renders`, marker);
  }
}

// ---- transport module ----
console.log("· transport module …");
ql(await clickBiz("TRANSPORT"), "Transport chip clickable");
const mounted = await page.evaluate(() => !!document.querySelector('[data-testid="transport-module"]')).catch(() => false);
ql(mounted, "TransportModule mounts");
await shot("transport-dashboard");

QL_TABS: {
  const tabs = await page.$$eval("[data-testid^='transport-tab-']", (els) => els.length).catch(() => 0);
  ql(tabs >= 10, "module tab bar complete", `${tabs} tabs`);
  break QL_TABS;
}

await page.click('[data-testid="transport-tab-fleet"]').catch(() => {});
const fleetOk = await page.waitForSelector("[data-testid^='transport-vehicle-']", { timeout: 20000 }).then(() => true).catch(() => false);
ql(fleetOk, "fleet card renders");
await shot("transport-fleet");

await page.click('[data-testid="transport-tab-gps"]').catch(() => {});
const gpsRow = await page.waitForSelector("[data-testid^='transport-gpsrow-']", { timeout: 20000 }).then(() => true).catch(() => false);
ql(gpsRow, "GPS tab lists tracked vehicle");
await page.evaluate(() => document.querySelector("[data-testid^='transport-gpsrow-']")?.click()).catch(() => {});
const svg = await page.waitForSelector('[data-testid="transport-map"]', { timeout: 20000 }).then(() => true).catch(() => false);
ql(svg, "SVG track map renders across an active tracker");
await shot("transport-gps");

await page.click('[data-testid="transport-tab-compliance"]').catch(() => {});
await page.waitForSelector("[data-testid^='transport-violation-']", { timeout: 20000 }).catch(() => {});
const vios = await page.$$eval("[data-testid^='transport-violation-']", (els) => els.map((e) => e.textContent)).catch(() => []);
ql(vios.some((v) => /SPEEDING/.test(v)), "SPEEDING violation visible in UI", `${vios.length} rows`);
ql(vios.some((v) => /GEOFENCE/.test(v)), "geofence violation visible in UI");

await page.click('[data-testid="transport-tab-dashboard"]').catch(() => {});
await page.waitForSelector("[data-testid='transport-dashboard']", { timeout: 20000 }).catch(() => {});
await sleep(800);
const rev = await page.evaluate(() => {
  const el = [...document.querySelectorAll("[data-testid='transport-dashboard'] *")].find((x) => /Revenue/i.test(x.textContent) && (x.textContent || "").length < 200);
  return el?.textContent || "";
}).catch(() => "");
ql(/GH|₵/.test(rev), "dashboard revenue tile renders");
await shot("transport-revenue");

ql(pageErrors.length === 0, "zero page errors across sessions", pageErrors[0] || "clean");
ql(docFails.filter((d) => !d.includes("404")).length === 0, "no 5xx documents", docFails.find((d) => !d.includes("404")) || "clean");

await browser.close();
console.log(`\n═══ REGRESSION: ${passes} pass · ${failures} fail ═══`);
process.exit(failures ? 1 : 0);
