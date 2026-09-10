/**
 * shot-address-dropdown.mjs — screenshots of the delivery address
 * autocomplete open over the map (desktop + phone), for visual review.
 * Output: /tmp/shots/addr-*.png
 */
import { createRequire } from "module";
import { mkdirSync } from "fs";
const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const OUT = "/tmp/shots";
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: "/tmp/al2023/chromium",
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});

for (const vp of [
  { name: "desktop", viewport: { width: 1280, height: 800 } },
  { name: "phone", viewport: { width: 390, height: 740, isMobile: true, hasTouch: true } },
]) {
  const page = await browser.newPage();
  await page.setViewport(vp.viewport);
  await page.goto(`${BASE}/order`, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector('[data-testid^="oo-add-"]', { timeout: 30000 });
  await page.click('[data-testid^="oo-add-"]');
  await page.waitForSelector('[data-testid="oo-delivery"]', { timeout: 20000 });
  await page.click('[data-testid="oo-delivery"]');
  await page.waitForSelector('[data-testid="oo-delivery-block"]', { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 1800));

  // Bring the address field into view, then type.
  await page.evaluate(() => {
    document.querySelector('[data-testid="oo-dest-input"]')
      ?.scrollIntoView({ block: "center" });
  });
  await new Promise((r) => setTimeout(r, 400));
  await page.click('[data-testid="oo-dest-input"]');
  await page.type('[data-testid="oo-dest-input"]', "Accra", { delay: 30 });
  await page.waitForSelector('[data-testid="oo-dest-list"]', { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 700));

  await page.screenshot({ path: `${OUT}/addr-${vp.name}.png` });
  console.log(`saved ${OUT}/addr-${vp.name}.png`);
  await page.close();
}

await browser.close();
