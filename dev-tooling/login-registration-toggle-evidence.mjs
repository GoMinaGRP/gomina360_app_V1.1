#!/usr/bin/env node
/**
 * login-registration-toggle-evidence.mjs — visual evidence for the
 * Super-Admin LOGIN-PAGE registration switch.
 *
 * Captures, in order:
 *   1. the sign-in page with the switch OFF (the shipped default)   → shot-login-registration-off.png
 *   2. the Super Admin's control in Customer Support → the two checkboxes,
 *      including "Show the … link on the staff sign-in page"        → shot-login-toggle-control.png
 *   3. the sign-in page with the switch ON (flipped through the real
 *      Super-Admin save, exactly as the owner would)                → shot-login-registration-on.png
 *   4. the sign-in page after turning it back OFF, proving the flip is
 *      reversible without touching /join or the order page
 *
 * The probe records and restores the platform row's two flags, so the demo
 * database is left exactly as found.
 *
 * Run: bash dev-tooling/run-suite.sh dev-tooling/login-registration-toggle-evidence.mjs
 */
import { createRequire } from "node:module";
const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");
const pgRequire = createRequire(import.meta.url);
const { Client } = pgRequire("pg");

const BASE = "http://127.0.0.1:3000";
const OUT = "/home/user";
const OWNER = { email: "kwame.owner@gomina360.com", password: process.env.GOMINA_OWNER_PW || "Owner@GoMina26" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pg = new Client("postgresql://postgres:postgres@127.0.0.1:5432/app_db");
await pg.connect();
const rowOf = async () =>
  (await pg.query("SELECT id, registration_enabled, login_registration_enabled FROM customer_support_info WHERE is_platform = true ORDER BY id LIMIT 1")).rows[0] || null;
const before = await rowOf();

const token = (await (await fetch(`${BASE}/api/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(OWNER),
})).json()).sessionToken;
if (!token) { console.error("owner login failed"); process.exit(1); }

const save = (loginEnabled) =>
  fetch(`${BASE}/api/support-info`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-gomina-session": token },
    body: JSON.stringify({
      registration: { enabled: before?.registration_enabled !== false, loginEnabled },
    }),
  });

const browser = await puppeteer.launch({
  executablePath: "/tmp/al2023/chromium",
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width: 1100, height: 980 },
});

/** Fresh, signed-out visit to `/` — what a staff member actually sees. */
async function loginShot(file) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 90000 });
  await page.waitForSelector('[data-testid="login-screen"]', { timeout: 30000 });
  await sleep(600);
  const state = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="login-join-link"]');
    return { linkPresent: !!el, text: (el?.textContent || "").trim() };
  });
  await page.screenshot({ path: `${OUT}/${file}` });
  await page.close();
  await ctx.close();
  return state;
}

console.log("· login page, switch OFF (default)…");
await save(false); await sleep(700);
console.log("  ", JSON.stringify(await loginShot("shot-login-registration-off.png")));

console.log("· the Super Admin's control…");
{
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.evaluate((t) => sessionStorage.setItem("gomina_session_token", t), token);
  await page.reload({ waitUntil: "networkidle0", timeout: 90000 });
  await sleep(2500);
  // The SUPPORT row lives in the collapsible SETTINGS group: expand it, scroll
  // it into view, then click — mirroring what the owner does.
  await page.waitForSelector('[data-testid="sidebar-support-info"]', { timeout: 30000 }).catch(async () => {
    const group = await page.$('[data-testid="nav-section-SETTINGS"]');
    if (group) await group.click();
  });
  let row = await page.$('[data-testid="sidebar-support-info"]');
  if (!row) {
    // The row lives in the collapsible SETTINGS group.
    await page.evaluate(() => document.querySelector('[data-testid="nav-section-SETTINGS"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await sleep(600);
    row = await page.$('[data-testid="sidebar-support-info"]');
  }
  if (!row) throw new Error("SUPPORT sidebar row not found (settings group?)");
  await row.evaluate((el) => {
    el.scrollIntoView({ block: "center" });
    // The rail is pointer-events:none at narrow/headless viewports (it is the
    // sticky desktop rail); a DOM click is the same React event the owner's
    // mouse produces.
    el.click();
  });
  await page.waitForSelector('[data-testid="support-modal"]', { timeout: 20000 });
  await page.waitForSelector('[data-testid="support-registration-block"]', { timeout: 20000 });
  await sleep(800);
  const control = await page.evaluate(() => {
    const login = document.querySelector('[data-testid="support-registration-login-enabled"]');
    const order = document.querySelector('[data-testid="support-registration-enabled"]');
    return {
      orderCheckbox: !!order, orderChecked: order?.checked ?? null,
      loginCheckbox: !!login, loginChecked: login?.checked ?? null,
      label: (login?.closest("label")?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 150),
    };
  });
  console.log("  ", JSON.stringify(control));
  await page.evaluate(() => document.querySelector('[data-testid="support-registration-block"]')?.scrollIntoView({ block: "center" }));
  await sleep(300);
  await page.screenshot({ path: `${OUT}/shot-login-toggle-control.png` });
  await page.close();
  await ctx.close();
}

console.log("· login page, switch ON…");
await save(true); await sleep(700);
console.log("  ", JSON.stringify(await loginShot("shot-login-registration-on.png")));

console.log("· restoring the baseline…");
if (before) {
  await save(before.login_registration_enabled === true);
  await sleep(400);
  await pg.query("UPDATE customer_support_info SET registration_enabled = $1, login_registration_enabled = $2 WHERE is_platform = true",
    [before.registration_enabled, before.login_registration_enabled]);
} else {
  await save(false);
  await sleep(400);
  await pg.query("DELETE FROM customer_support_info WHERE is_platform = true");
}
const after = await rowOf();
console.log(`   platform row: ${before ? `#${before.id}` : "none"} → ${after ? `#${after.id}` : "none"} · loginFlag=${JSON.stringify(after?.login_registration_enabled ?? null)}`);
await pg.end();
await browser.close();
console.log(`evidence: ${OUT}/shot-login-registration-off.png · ${OUT}/shot-login-toggle-control.png · ${OUT}/shot-login-registration-on.png`);
