#!/usr/bin/env node
/**
 * checkout-product-details.mjs — full Inventory → Product Details → Cart →
 * Checkout → Order verification, desktop + mobile:
 *
 *  A. INVENTORY DETAILS: storefront cards/lightbox auto-render the rich
 *     product details registered at stock-in (brand, model, description,
 *     size/weight specs, variants) — read from /api/menu, NO duplicate entry.
 *  B. GUIDED STICKY BAR: first Add-to-Cart auto-opens the cart summary, the
 *     bar's "Proceed to Checkout ▼" scrolls to the details form with a pulse,
 *     and the real "Place order" sits at the END of the form.
 *  C. STOCK ORDER E2E through that exact flow (pickup), incl. GM- code.
 *  D. PRE-ORDER: pre-order chips + deposit lines still appear and can be
 *     added to the cart (preserved flow).
 *
 * Run: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/checkout-product-details.mjs
 */
import fs from "node:fs";
import { createRequire } from "module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");

const BASE = process.env.BASE || "http://localhost:3000";
const OUT = ".verify-out";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const failures = [];
const ok = (n, c, d = "") => { console.log(`${c ? "✅" : "❌"} ${n}${d ? ` — ${d}` : ""}`); if (c) pass++; else { fail++; failures.push(`${n}: ${d}`); } };
const t = (id) => `[data-testid='${id}']`;
const vis = async (page, id) => page.evaluate((s) => { const el = document.querySelector(s); return !!el && el.offsetParent !== null; }, t(id));

async function run(label, viewport) {
  const browser = await puppeteer.launch({
    executablePath: "/tmp/al2023/chromium", headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"], defaultViewport: viewport,
  });
  const page = await browser.newPage();
  try {
    await page.goto(`${BASE}/order`, { waitUntil: "networkidle0", timeout: 90000 });
    await page.waitForSelector(t("oo-prod-1"), { timeout: 60000 });

    // ── A1. Product card carries brand + details hint from inventory ──
    ok(`cpd.${label}.card-brand-chip`, await vis(page, "oo-brand-1"));
    ok(`cpd.${label}.card-details-btn`, await vis(page, "oo-details-1"));

    // ── A2. Lightbox is the product-details surface (auto from inventory) ──
    await page.click(t("oo-details-1"));
    await page.waitForSelector(t("oo-lightbox-details"), { timeout: 20000 });
    const desc = await page.$eval(t("oo-lightbox-desc"), (n) => n.textContent || "");
    ok(`cpd.${label}.lightbox-desc`, /cold-chain/i.test(desc), desc.slice(0, 40));
    ok(`cpd.${label}.lightbox-brandchips`, await vis(page, "oo-lightbox-brand"));
    const specCount = await page.$$eval("[data-testid^='oo-lightbox-spec-']", (l) => l.length);
    ok(`cpd.${label}.lightbox-specs`, specCount >= 3, `${specCount} spec rows`);
    const sizeRow = await page.evaluate(() => document.querySelector("[data-testid='oo-lightbox-spec-0']")?.textContent || "");
    ok(`cpd.${label}.lightbox-size-weight`, /Size/.test(sizeRow) && /30 eggs/i.test(sizeRow), sizeRow.slice(0, 40));
    const variantCount = await page.$$eval("[data-testid^='oo-lightbox-variant-']", (l) => l.length);
    ok(`cpd.${label}.lightbox-variants`, variantCount >= 3, `${variantCount} variants`);
    await page.screenshot({ path: `${OUT}/cpd-${label}-1-details.png` });
    await page.keyboard.press("Escape");
    await sleep(400);

    // ── B1. First add → cart bar with AUTO-OPEN summary + guided CTA ──
    ok(`cpd.${label}.cartbar-absent-before`, !(await page.$(t("oo-cart"))));
    await page.evaluate(() => document.querySelector("[data-testid='oo-add-1']")?.scrollIntoView({ block: "center" }));
    await sleep(300);
    await page.click(t("oo-add-1"));
    await sleep(700);
    ok(`cpd.${label}.cartbar-appears`, !!(await page.$(t("oo-cart"))));
    ok(`cpd.${label}.summary-auto-open`, await vis(page, "oo-cart-lines"), "line list open without tapping ▴");
    ok(`cpd.${label}.proceed-cta`, await vis(page, "oo-proceed-checkout"));
    // OLD behaviour is gone: the bar has no submit anymore
    const barText = await page.$eval(t("oo-cart"), (n) => n.textContent || "");
    ok(`cpd.${label}.bar-no-submit`, !/Place order/i.test(barText), barText.replace(/\s+/g, " ").slice(0, 80));
    await page.screenshot({ path: `${OUT}/cpd-${label}-2-guided-bar.png` });

    // ── B2. Proceed smooth-scrolls; pulse + live summary appear ──
    await page.click(t("oo-proceed-checkout"));
    await sleep(1400); // smooth-scroll duration
    const checkoutInView = await page.evaluate(() => {
      const el = document.querySelector("[data-testid='oo-checkout']");
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.top >= -40 && r.top < window.innerHeight * 0.6;
    });
    ok(`cpd.${label}.scrolls-to-checkout`, checkoutInView);
    const ringing = await page.evaluate(() => (document.querySelector("[data-testid='oo-checkout']")?.className || "").includes("ring-2"));
    ok(`cpd.${label}.pulse-ring`, ringing);
    const summary = await page.$eval(t("oo-checkout-summary"), (n) => n.textContent || "").catch(() => "");
    ok(`cpd.${label}.heading-summary`, /1 item/.test(summary) && /55\.00/.test(summary), summary.trim());
    ok(`cpd.${label}.form-submit-visible`, await vis(page, "oo-submit-card") && await vis(page, "oo-place"));
    await page.screenshot({ path: `${OUT}/cpd-${label}-3-checkout-arrival.png` });

    // ── C. STOCK ORDER E2E through the form-end Place order ──
    await page.type(t("oo-name"), "Abena Details", { delay: 10 });
    await page.type(t("oo-phone"), "0244112233", { delay: 10 });
    await page.click(t("oo-pickup"));
    await sleep(800);
    const pts = await page.$$eval("[data-testid^='oo-pickpoint-']", (l) => l.length).catch(() => 0);
    if (pts > 0) { await page.click("[data-testid^='oo-pickpoint-']"); await sleep(600); }
    await page.click(t("oo-pay-ondelivery"));
    await sleep(300);
    await page.evaluate(() => document.querySelector("[data-testid='oo-place']")?.scrollIntoView({ block: "center" }));
    await sleep(300);
    await page.click(t("oo-place"));
    await sleep(3500);
    const code = await page.evaluate(() => (document.body.innerText.match(/GM-[A-Z-]*[A-Z0-9]{4,}/) || [""])[0]);
    ok(`cpd.${label}.stock-order-placed`, /^GM-/.test(code), code || "no code");
    await page.screenshot({ path: `${OUT}/cpd-${label}-4-placed.png` });

    // ── D. PRE-ORDER preserved: chips + add-to-cart through pre-order ──
    await page.goto(`${BASE}/order`, { waitUntil: "networkidle0", timeout: 90000 });
    await page.waitForSelector(t("oo-prod-1"), { timeout: 60000 });
    const preChip = await page.evaluate(() => document.body.innerText.includes("Air Freight Import"));
    ok(`cpd.${label}.preorder-chip`, preChip, "Air Freight Import option visible");
    const preBtn = await page.evaluateHandle(() => [...document.querySelectorAll("button")].find((b) => /Pre-order/i.test(b.innerText || "")) || null);
    if (preBtn && preBtn.asElement()) {
      await preBtn.asElement().click();
      await sleep(700);
      const lines = await page.evaluate(() => document.querySelector("[data-testid='oo-cart-lines']")?.innerText || "");
      ok(`cpd.${label}.preorder-in-cart`, /PRE-ORDER/i.test(lines), lines.replace(/\s+/g, " ").slice(0, 60));
    } else {
      ok(`cpd.${label}.preorder-in-cart`, false, "no Pre-order button found");
    }
    await page.screenshot({ path: `${OUT}/cpd-${label}-5-preorder.png` });
  } finally {
    await browser.close().catch(() => {});
  }
}

await run("desktop", { width: 1366, height: 900 });
await run("mobile", { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

console.log(`\n${pass} pass / ${fail} fail`);
if (failures.length) { console.log("FAILURES:"); failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
