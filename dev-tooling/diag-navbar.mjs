// Diagnose navbar visibility/overflow across viewports (read-only).
import { createRequire } from "module";
const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");

const BASE = "http://localhost:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "/tmp/al2023/chromium",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  headless: "new",
});

const page = await browser.newPage();
await page.goto(BASE, { waitUntil: "networkidle0" });
await page.type("[data-testid='login-email']", "kwame.owner@gomina360.com");
await page.type("[data-testid='login-password']", "Owner@GoMina26");
await page.click("[data-testid='login-submit']");
await page.waitForSelector("[data-testid='user-menu-btn']", { timeout: 20000 });
await sleep(1500);

const widths = [320, 360, 390, 768, 1024, 1440];
for (const w of widths) {
  await page.setViewport({ width: w, height: 800 });
  await sleep(400);
  const m = await page.evaluate(() => {
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom), displayed: !!(el.offsetWidth || el.offsetHeight) };
    };
    return {
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      header: rect("header"),
      inner: rect("header > div"),
      currency: rect("[data-testid='currency-switcher']"),
      clock: rect("[data-testid='att-clock-btn']"),
      userBtn: rect("[data-testid='user-menu-btn']"),
    };
  });
  const overflowX = m.scrollWidth - m.innerWidth;
  const offRight = (r) => (r && r.right > m.innerWidth ? `OFF-RIGHT by ${r.right - m.innerWidth}px` : "");
  console.log(`W=${w} hOverflow=${overflowX} userBtn=${JSON.stringify(m.userBtn)} ${offRight(m.userBtn)} clock=${offRight(m.clock)} currency=${offRight(m.currency)} headerH=${m.header?.h}`);

  // dropdown containment checks at small & mid widths
  if ([320, 360, 768].includes(w)) {
    await page.click("[data-testid='user-menu-btn']");
    await sleep(200);
    const um = await page.evaluate(() => {
      const el = document.querySelector("[data-testid='user-account-menu']");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), right: Math.round(r.right), w: Math.round(r.width), vw: window.innerWidth };
    });
    console.log(`   user-menu: ${JSON.stringify(um)} ${um && (um.x < 0 || um.right > um.vw) ? "❌ OUT OF VIEWPORT" : "ok"}`);
    await page.click("[data-testid='user-menu-btn']");
    await sleep(150);
    await page.click("[data-testid='att-clock-btn']");
    await sleep(200);
    const cp = await page.evaluate(() => {
      const el = document.querySelector("[data-testid='att-clock-panel']");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), right: Math.round(r.right), w: Math.round(r.width), vw: window.innerWidth };
    });
    console.log(`   clock-panel: ${JSON.stringify(cp)} ${cp && (cp.x < 0 || cp.right > cp.vw) ? "❌ OUT OF VIEWPORT" : "ok"}`);
    await page.click("[data-testid='att-clock-btn']");
    await sleep(150);
  }
}
await browser.close();
console.log("DIAG DONE");
