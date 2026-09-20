import { createRequire } from "node:module";
const require = createRequire("/home/user/pgtooling/");
const puppeteer = require("puppeteer-core");
const BASE = process.env.BASE_URL || "http://localhost:3000";
const browser = await puppeteer.launch({ executablePath: "/tmp/al2023/chromium", headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
for (const [name, vp] of [["mobile", { width: 390, height: 844, isMobile: true, hasTouch: true }], ["desktop", { width: 1440, height: 900 }]]) {
  const page = await browser.newPage();
  await page.setViewport(vp);
  page.on("dialog", (d) => d.accept());
  await page.goto(`${BASE}/order?biz=1`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid="oo-help"]', { timeout: 30000 });
  await page.evaluate(() => document.querySelector('[data-testid="oo-help"]').click());
  await page.waitForSelector('[data-testid="oo-howto-steps"]', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: `/home/user/gomina360_app_V1.1/dev-tooling/backups/help-${name}-top.png` });
  await page.evaluate(() => {
    const steps = document.querySelector('[data-testid="oo-howto"]');
    steps?.scrollIntoView({ block: "start" });
  });
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: `/home/user/gomina360_app_V1.1/dev-tooling/backups/help-${name}-steps.png` });
  await page.close();
}
await browser.close();
console.log("screens saved");
