#!/usr/bin/env node
/**
 * assess-login-registration-entry.mjs — READ-ONLY assessment probe for the
 * brief "hide or remove the login page's Register-it entry".
 *
 * Measures the login page's registration entry (presence, size, position) and
 * records the baseline of the Order Page HELP entry that must stay working:
 * HELP block + CTA → /join + storefront footer line.
 *
 * Screenshots: /home/user/shot-login-current.png
 *              /home/user/shot-order-help-join-baseline.png
 * Run: bash dev-tooling/run-suite.sh dev-tooling/assess-login-registration-entry.mjs
 */
// Assessment probe (read-only): measure the login page's registration entry
// and capture it for the record. No application change.
import { createRequire } from "node:module";
const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");
const BASE = "http://127.0.0.1:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: "/tmp/al2023/chromium", headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"], defaultViewport: { width: 1100, height: 950 } });
const page = await browser.newPage();
await page.goto(BASE, { waitUntil: "networkidle0", timeout: 90000 });
await page.waitForSelector('[data-testid="login-screen"]', { timeout: 30000 });
await sleep(600);

const m = await page.evaluate(() => {
  const el = document.querySelector('[data-testid="login-join-link"]');
  const form = document.querySelector("form");
  const r = el?.getBoundingClientRect();
  const fr = form?.getBoundingClientRect();
  const style = el ? getComputedStyle(el) : null;
  return {
    exists: !!el,
    href: el?.getAttribute("href") || null,
    text: (el?.textContent || "").trim(),
    heightPx: r ? Math.round(r.height) : null,
    formHeightPx: fr ? Math.round(fr.height) : null,
    shareOfFormPct: r && fr ? Math.round((r.height / fr.height) * 1000) / 10 : null,
    borderColor: style?.borderColor || null,
    background: style?.backgroundColor || null,
    // element order inside the card, for the "what would move up" picture
    childOrder: form ? [...form.children].map((c) => c.getAttribute("data-testid") || c.tagName.toLowerCase() + (c.tagName === "P" ? ":text" : "")).slice(-7) : null,
    footerNote: [...(form?.querySelectorAll("p") || [])].map((p) => (p.textContent || "").trim()).slice(-2),
  };
});
console.log(JSON.stringify(m, null, 2));
await page.screenshot({ path: "/home/user/shot-login-current.png" });
console.log("shot: /home/user/shot-login-current.png");

// ── the OTHER entry that must stay: Order Page → HELP → "Join GoMina 360" ──
const op = await browser.newPage();
await op.setViewport({ width: 1280, height: 1000 });
await op.goto(`${BASE}/order`, { waitUntil: "networkidle0", timeout: 90000 });
await op.waitForSelector('[data-testid="oo-help"]', { timeout: 30000 });
await op.click('[data-testid="oo-help"]');
await op.waitForSelector('[data-testid="oo-help-modal"]', { timeout: 15000 });
await sleep(700);
const help = await op.evaluate(() => {
  const block = document.querySelector('[data-testid="oo-help-join"]');
  const cta = document.querySelector('[data-testid="oo-help-join-cta"]');
  return {
    helpBlockPresent: !!block,
    ctaHref: cta?.getAttribute("href") || null,
    headline: block?.querySelector("p")?.textContent || null,
    footerJoinPresent: !!document.querySelector('[data-testid="oo-footer-join"]'),
  };
});
console.log("order HELP join baseline:", JSON.stringify(help));
await op.evaluate(() => {
  const el = document.querySelector('[data-testid="oo-help-join"]');
  el?.scrollIntoView({ block: "center" });
});
await sleep(400);
await op.screenshot({ path: "/home/user/shot-order-help-join-baseline.png" });
console.log("shot: /home/user/shot-order-help-join-baseline.png");
await browser.close();
