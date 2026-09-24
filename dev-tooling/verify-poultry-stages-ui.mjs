// UI verification of the POULTRY AGE/STAGE-AWARE DAILY CHECKLIST rendering:
// stage chips on the Flock & Batch table, the STAGE PLAN ON badge, farm
// routine vs per-flock sections with stage headers, stage compliance strip,
// CRITICAL / frequency chips, and the completion toggle — zero page errors.
// Requires the stage plan ENABLED on POULTRY-01 (verify-poultry-stages.mjs
// leaves it on; the seed ships it on for fresh bootstraps).
// Run: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-poultry-stages-ui.mjs

import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.OWNER_PW || "Owner@GoMina26" };
let fails = 0;
const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "✅" : "❌"} ${n}${x ? " — " + x : ""}`); };

const browser = await puppeteer.launch({ executablePath: "/tmp/al2023/chromium", headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--window-size=1500,950"] });
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") { const t = m.text(); if (!/401|Failed to load resource|net::ERR_/.test(t)) pageErrors.push(t); } });

await page.goto(BASE, { waitUntil: "networkidle0", timeout: 45000 });
await page.waitForSelector('[data-testid="login-email"]');
await page.type('[data-testid="login-email"]', OWNER.email);
await page.type('[data-testid="login-password"]', OWNER.pw);
await page.click('[data-testid="login-submit"]');
await page.waitForFunction(() => !document.querySelector('[data-testid="login-screen"]'), { timeout: 30000 });

// open the poultry module (wait for the sidebar to carry businesses)
await page.waitForFunction(() => {
  const btns = [...document.querySelectorAll("aside button")];
  return btns.some((b) => /poultry/i.test(b.textContent || ""));
}, { timeout: 30000 });
await page.evaluate(() => {
  const btns = [...document.querySelectorAll("aside button")];
  const el = btns.find((b) => /poultry/i.test(b.textContent || ""));
  if (el) el.click();
});
await new Promise((r) => setTimeout(r, 3500));

// flock table stage chips (FLOCKS tab)
await page.evaluate(() => { const el = [...document.querySelectorAll("button")].find((b) => /flock & batch/i.test(b.textContent || "")); if (el) el.click(); });
await new Promise((r) => setTimeout(r, 2000));
const flockBody = await page.evaluate(() => document.body.innerText);
ok("FLOCKS tab shows stage chips + age/eta", /Finisher/i.test(flockBody) && /Mid Lay/i.test(flockBody) && /Day \d+/.test(flockBody));

// open the CHECKLIST tab
await page.evaluate(() => { const el = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim().toLowerCase().includes("checklist")); if (el) el.click(); });
await new Promise((r) => setTimeout(r, 2500));
const body = await page.evaluate(() => document.body.innerText);
ok("checklist tab shows STAGE PLAN ON badge", body.includes("STAGE PLAN ON"));
ok("checklist shows FARM ROUTINE & CUSTOM section", body.includes("FARM ROUTINE & CUSTOM"));
ok("checklist shows flock section for BENCH-DEMO-B01 with stage", body.includes("BENCH-DEMO-B01") && /Finisher/i.test(body));
ok("checklist shows layer flock section (MID_LAY wk)", /BATCH-2026-L01/.test(body) && /Mid Lay/i.test(body));
ok("checklist shows stage compliance strip", /stage compliance/i.test(body));
ok("critical chip visible", body.includes("CRITICAL"));
ok("weekly/once frequency chip visible", body.includes("WEEKLY") || body.includes("ONCE/STAGE"));

// toggle the first incomplete task
const toggled = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => b.className.includes("rounded-xl") && (b.textContent || "").includes("Morning house walk"));
  if (!btn) return false; btn.click(); return true;
});
await new Promise((r) => setTimeout(r, 1500));
const doneStamp = await page.evaluate(() => document.body.innerText.includes("Done by Kwame Mina"));
ok("task completion toggle works (owner stamp)", toggled && doneStamp);
if (toggled) { // revert
  await page.evaluate(() => { const btn = [...document.querySelectorAll("button")].find((b) => b.className.includes("rounded-xl") && (b.textContent || "").includes("Morning house walk")); if (btn) btn.click(); });
  await new Promise((r) => setTimeout(r, 1200));
}

ok("zero page/console errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
await browser.close();
console.log(fails === 0 ? "UI SMOKE: ALL PASS" : `UI SMOKE: ${fails} FAILURES`);
process.exit(fails ? 1 : 0);
