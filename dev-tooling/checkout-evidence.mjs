#!/usr/bin/env node
/**
 * checkout-evidence.mjs — captures the CURRENT cart/checkout journey:
 * product-first page (top), same page scrolled to the checkout panel, cart
 * bar after adding an item, and the compact action it really reveals. Desktop
 * + mobile personas. Evidence → .evidence/checkout-cart/before/.
 *
 * Run: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/checkout-evidence.mjs
 */
import fs from "node:fs";
import { createRequire } from "module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");

const BASE = process.env.BASE || "http://localhost:3000";
const OUT = ".evidence/checkout-cart/before";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function persona(label, viewport) {
  const browser = await puppeteer.launch({
    executablePath: "/tmp/al2023/chromium",
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    defaultViewport: viewport,
  });
  const page = await browser.newPage();
  try {
    await page.goto(`${BASE}/order`, { waitUntil: "networkidle0", timeout: 90000 });
    await page.waitForSelector("[data-testid^='oo-prod-']", { timeout: 60000 });
    await sleep(600);

    const metrics = await page.evaluate(() => {
      const co = document.querySelector("[data-testid='oo-checkout']");
      return {
        viewportH: window.innerHeight,
        checkoutTop: co ? Math.round(co.getBoundingClientRect().top + window.scrollY) : null,
        cartBarPresent: !!document.querySelector("[data-testid='oo-cart']"),
        placeBtnPresent: !!document.querySelector("[data-testid='oo-place']"),
      };
    });

    // 1. product-first landing (top of page)
    await page.screenshot({ path: `${OUT}/${label}-1-product-first.png` });

    // 2. add the first in-stock product
    const addBtn = await page.evaluateHandle(() => {
      const btns = [...document.querySelectorAll("[data-testid^='oo-add-']")];
      return btns.find((b) => !b.disabled) || null;
    });
    if (addBtn) await addBtn.asElement().click();
    await sleep(800);

    // 3. WITH item in cart — top of page (what the customer now sees instead)
    await page.screenshot({ path: `${OUT}/${label}-2-item-added-top.png` });

    // 4. cart bar expansed (the compact action it reveals)
    await page.click("[data-testid='oo-cart'] button:first-child").catch(() => {});
    await sleep(300);
    await page.screenshot({ path: `${OUT}/${label}-3-cartbar.png` });

    // 5. the checkout panel far below
    await page.evaluate(() => document.querySelector("[data-testid='oo-checkout']")?.scrollIntoView({ block: "start" }));
    await sleep(400);
    await page.screenshot({ path: `${OUT}/${label}-4-checkout-panel.png` });

    console.log(`${label}:`, JSON.stringify(metrics));
  } finally {
    await browser.close().catch(() => {});
  }
}

await persona("desktop", { width: 1366, height: 900 });
await persona("mobile", { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
console.log("evidence captured to", OUT);
