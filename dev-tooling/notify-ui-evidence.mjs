#!/usr/bin/env node
/**
 * notify-ui-evidence.mjs — visual + behavioural evidence for the activity
 * notification system, end to end through the real UI:
 *
 *   1. a sale is recorded by the unit's branch manager through the API,
 *   2. the OWNER's bell shows the rolled-up row with its "Sales Activity" chip
 *      (screenshot: /home/user/shot-notif-bell.png),
 *   3. clicking the row marks it read and lands on the unit's workspace — the
 *      record's own home — not a dead end
 *      (screenshot: /home/user/shot-notif-clicked.png),
 *   4. everything the probe created (ledger row + its day's roll-up rows) is
 *      removed again, so the demo database is left untouched.
 *
 * Run: bash dev-tooling/run-suite.sh dev-tooling/notify-ui-evidence.mjs
 */
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");

const BASE = "http://127.0.0.1:3000";
const OUT = "/home/user";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (path, method = "GET", body = null, token = null) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { "x-gomina-session": token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = JSON.parse(await res.text()); } catch {}
  return { status: res.status, json };
};

const bm = (await call("/api/auth/login", "POST", { email: "emmanuel@gomina360.com", password: "GoMina@User3" })).json?.sessionToken;
const owner = (await call("/api/auth/login", "POST", { email: "kwame.owner@gomina360.com", password: "Owner@GoMina26" })).json?.sessionToken;
if (!bm || !owner) { console.error("login failed"); process.exit(1); }

const probe = await call("/api/transactions", "POST", {
  businessId: 1, type: "INCOME", category: "General Sales", amountGhs: 480,
  paymentMethod: "CASH", description: "UI evidence sale — notification click-through",
  date: new Date().toISOString().slice(0, 10),
}, bm);
console.log("probe sale:", probe.status, probe.json?.transaction?.transactionNumber);
await sleep(1500);

const browser = await puppeteer.launch({ executablePath: "/tmp/al2023/chromium", headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"], defaultViewport: { width: 1500, height: 1000 } });
const page = await browser.newPage();
await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.evaluate((t) => sessionStorage.setItem("gomina_session_token", t), owner);
await page.reload({ waitUntil: "networkidle0", timeout: 90000 });
await sleep(2500);
await page.click("[data-testid='notif-bell']");
await page.waitForSelector("[data-testid='notif-panel']", { timeout: 20000 });
await sleep(900);
const row = await page.evaluate(() => {
  const rows = [...document.querySelectorAll("[data-testid^='notif-item-']")];
  const money = rows.find((r) => /sales/i.test(r.textContent || ""));
  return money ? {
    id: money.getAttribute("data-testid"),
    numericId: Number(String(money.getAttribute("data-testid")).replace("notif-item-", "")),
    text: (money.textContent || "").replace(/\s+/g, " ").slice(0, 130),
    chip: money.querySelector("[data-testid='notification-target-tag']")?.textContent || null,
  } : null;
});
console.log("bell row:", JSON.stringify(row));
await page.screenshot({ path: `${OUT}/shot-notif-bell.png` });
if (row) {
  await page.click(`[data-testid='${row.id}']`);
  await sleep(3500);
}
const landed = await page.evaluate(() => ({
  url: location.href,
  financeVisible: !!document.querySelector("[data-testid='central-finance']"),
  unitWorkspaceVisible: !!document.querySelector("[data-testid='bd-open-expense']") || !!document.querySelector("[data-testid^='bdm-tab-']"),
  unitName: document.querySelector("[data-testid^='bdm-tab-']") ? "unit-dashboard" : null,
  commandCenterVisible: !!document.querySelector("[data-testid='command-center-root']"),
  panelOpen: !!document.querySelector("[data-testid='notif-panel']"),
  activeNav: [...document.querySelectorAll("nav button, nav a")].filter((b) => /bg-|active|text-teal|border-teal/.test(b.className) && (b.textContent || "").trim()).map((b) => (b.textContent || "").trim().slice(0, 24)).slice(0, 6),
  bodyHead: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 200),
  testids: [...document.querySelectorAll("[data-testid]")].map((e) => e.getAttribute("data-testid")).filter((x) => !/^nav|^sidebar|^navb|^notif|^user-menu|^att-clock|^org-lens|^top-navbar/.test(x)).slice(0, 24),
}));
console.log("landed:", JSON.stringify(landed));
await page.screenshot({ path: `${OUT}/shot-notif-clicked.png` });
await browser.close();

const { Client } = require("/home/user/gomina360_app_V1.1/node_modules/pg");
const pg = new Client("postgresql://postgres:postgres@127.0.0.1:5432/app_db");
await pg.connect();
if (row?.numericId) {
  const r = await pg.query("SELECT is_read, record_type, record_id, record_ref, business_id, branch_code FROM notifications WHERE id = $1", [row.numericId]);
  console.log("row after click:", JSON.stringify(r.rows[0]));
}
const today = new Date().toISOString().slice(0, 10);
if (probe.json?.transaction?.id) await pg.query("DELETE FROM transactions WHERE id = $1", [Number(probe.json.transaction.id)]);
await pg.query("DELETE FROM notifications WHERE record_ref LIKE $1 OR record_ref LIKE $2", [`money-day:1:%:${today}`, `ops-money-day:1:%:${today}`]);
console.log("notifications left:", (await pg.query("SELECT count(*)::int AS c FROM notifications")).rows[0].c);
await pg.end();
console.log("evidence: /home/user/shot-notif-bell.png, /home/user/shot-notif-clicked.png");
