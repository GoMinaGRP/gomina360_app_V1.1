// Pre-order multi-tenant verification probe (puppeteer-core, AL2 extract).
// Run: node dev-tooling/preorder-multitenant.mjs
// Requires: dev server on :3001, credentials kwame.owner@gomina360.com / Owner@GoMina26,
// org-2 owner ama.owner@baanoo.com with pre-orders enabled on biz 23.
import fs from "fs";
import { createRequire } from "module";
// puppeteer-core is provisioned in /home/user/pgtooling (browser itself is the
// Amazon Linux 2023 Chromium extract at /tmp/al2023/chromium).
const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");

const BASE = "http://127.0.0.1:3001";
const OUTDIR = new URL("./.verify-out/", import.meta.url).pathname;
fs.mkdirSync(OUTDIR, { recursive: true });

const results = [];

async function run(mobile) {
  const browser = await puppeteer.launch({
    executablePath: "/tmp/al2023/chromium",
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    defaultViewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
  });
  try {
    const page = await browser.newPage();
    if (mobile) await page.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1");
    const tag = mobile ? "MOBILE" : "DESKTOP";

    // 1. login is fine / reachable
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle0", timeout: 60000 });
    results.push({ tag, step: "login-page", ok: true });

    // 2. storefront for org-2 unit (global marketplace view filtered to biz 23 in URL)
    await page.goto(`${BASE}/order?biz=23`, { waitUntil: "networkidle0", timeout: 60000 });
    // product card, "Pre-order only" badge, indigo option card, business pre-order chip
    await page.waitForSelector('[data-testid="oo-biz-preorder-badge"]', { timeout: 15000 }).catch(() => null);
    const found = await page.evaluate(() => ({
      badge: !!document.querySelector('[data-testid="oo-biz-preorder-badge"]'),
      badgeText: document.querySelector('[data-testid="oo-biz-preorder-badge"]')?.textContent?.trim() || "",
      preOnly: document.body.innerText.includes("Pre-order only"),
      preCard: !!document.querySelector("[data-testid^='po-pre-card']") || !!document.querySelector("[id^='po-card-']"),
      preCards: document.querySelectorAll("[data-testid^='po-pre-card']").length,
    }));
    results.push({ tag, step: "storefront-biz23", ...found });
    await page.screenshot({ path: `${OUTDIR}/storefront-biz23-${tag.toLowerCase()}.png`, fullPage: false });

    // 3. option card must render (indigo) with explicit deposit text
    const cardInfo = await page.evaluate(() => {
      const text = document.body.innerText;
      return {
        hasDepositText: /30%/.test(text),
        hasMethod: /Air Freight Import|Air/i.test(text),
        hasPrice: /520/.test(text),
      };
    });
    results.push({ tag, step: "option-card-content", ...cardInfo });

    // 4. org-1 classic flow still reachable
    await page.goto(`${BASE}/order?biz=15`, { waitUntil: "networkidle0", timeout: 60000 });
    const org1 = await page.evaluate(() => ({
      hasProductEgg: document.body.innerText.includes("Egg"),
      hasAir: document.body.innerText.includes("Air"),
      badge: !!document.querySelector('[data-testid="oo-biz-preorder-badge"]'),
    }));
    results.push({ tag, step: "storefront-biz15-classic", ...org1 });

    // 5. public tracking page for org-2 preorder
    await page.goto(`${BASE}/track?code=GM-HARDWARE-VF59M5`, { waitUntil: "networkidle0", timeout: 60000 });
    await new Promise((r) => setTimeout(r, groupAutoSearchDelay()));
    function groupAutoSearchDelay() { return 2500; }
    const track = await page.evaluate(() => ({
      hasCode: document.body.innerText.includes("GM-HARDWARE"),
      hasJourney: document.body.innerText.includes("Supplier Procurement") || document.body.innerText.includes("PROCUREMENT"),
    }));
    results.push({ tag, step: "track-org2", ...track });
    await page.screenshot({ path: `${OUTDIR}/track-org2-${tag.toLowerCase()}.png` });
  } finally {
    await browser.close();
  }
}

(async () => {
  await run(false);
  await run(true);
  const out = `${OUTDIR}/preorder-multitenant.json`;
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
})();
