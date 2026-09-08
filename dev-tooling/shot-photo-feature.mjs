/* One-off: capture the profile-photo feature (menu entry + manager dialog). */
import { createRequire } from "module";
const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");

const BASE = "http://127.0.0.1:3000";
const EMAIL = "kwame.owner@gomina360.com";
const PASS = process.env.GOMINA_OWNER_PW || "Owner@GoMina26";

const browser = await puppeteer.launch({
  executablePath: "/tmp/al2023/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 960 });

await page.goto(`${BASE}/`, { waitUntil: "networkidle0", timeout: 60000 });
await page.waitForSelector('[data-testid="login-email"]', { timeout: 60000 });
await page.type('[data-testid="login-email"]', EMAIL);
await page.type('[data-testid="login-password"]', PASS);
await page.click('[data-testid="login-submit"]');
await page.waitForSelector('[data-testid="user-menu-photo"], [data-testid="user-menu-btn"]', { timeout: 60000 });
await new Promise(r => setTimeout(r, 1500));

// 1) open the staff menu
const btn = await page.$('[data-testid="user-menu-btn"]') || await page.$('[data-testid="user-menu-photo"]');
await btn.click();
await new Promise(r => setTimeout(r, 800));
await page.screenshot({ path: "/home/user/photo-1-staff-menu.png" });
console.log("menu shot ok");

// 2) open the photo manager
await page.click('[data-testid="open-profile-photo"]');
await page.waitForSelector('[data-testid="ppm-root"]', { timeout: 15000 });
await new Promise(r => setTimeout(r, 700));
await page.screenshot({ path: "/home/user/photo-2-manager.png" });
console.log("manager shot ok");

await browser.close();
console.log("DONE");
