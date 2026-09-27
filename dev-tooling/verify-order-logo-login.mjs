// verify-order-logo-login.mjs — the Customer Order page's GoMina 360 logo
// (top-left) must be clickable and take the user DIRECTLY to the GoMina 360
// Login page in one click — on desktop, tablet and phone. The ordering
// process must be unaffected (cart/checkout still work after returning).
// Run: bash dev-tooling/run-suite.sh dev-tooling/verify-order-logo-login.mjs
import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`✅ ${name}${extra ? " — " + extra : ""}`); }
  else { fail++; console.log(`❌ ${name}${extra ? " — " + extra : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "/tmp/al2023/chromium",
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});

// ── A. Logo → Login, one click, at every viewport ──────────────────────────
for (const [label, width, height] of [["desktop", 1440, 900], ["tablet", 768, 1024], ["phone", 375, 720]]) {
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.setViewport({ width, height });
  await page.goto(`${BASE}/order`, { waitUntil: "networkidle0", timeout: 60000 });

  const logo = await page.$('[data-testid="oo-logo"]');
  ok(`A1 ${label}: GoMina 360 logo present in header`, !!logo);
  const visible = logo ? await logo.boundingBox() : null;
  ok(`A2 ${label}: logo is visible & clickable (in-viewport box)`, !!visible && visible.width > 0 && visible.height > 0,
    visible ? `${Math.round(visible.width)}×${Math.round(visible.height)}px @ (${Math.round(visible.x)},${Math.round(visible.y)})` : "no box");
  const inHeader = await page.$('[data-testid="oo-header"] [data-testid="oo-logo"]');
  ok(`A3 ${label}: logo sits in the top-left header block`, !!inHeader);
  const aria = logo ? await page.evaluate((el) => el.getAttribute("aria-label"), logo) : null;
  ok(`A4 ${label}: accessible label names the Login destination`, /login/i.test(aria || ""), aria || "");

  // ONE real click on the logo → the GoMina 360 Login page
  await logo.click();
  await page.waitForSelector('[data-testid="login-screen"]', { timeout: 30000 }).catch(() => {});
  const onLogin = !!(await page.$('[data-testid="login-screen"]'));
  const emailField = !!(await page.$('[data-testid="login-email"]'));
  ok(`A5 ${label}: one click on the logo lands on the GoMina 360 Login page`, onLogin && emailField,
    `${page.url()} | login-screen=${onLogin} email-field=${emailField}`);
  ok(`A6 ${label}: zero page errors during navigation`, errs.length === 0, errs.slice(0, 2).join(" | "));
  await page.close();
}

// ── B. Ordering unaffected ──────────────────────────────────────────────────
{
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${BASE}/order`, { waitUntil: "networkidle0", timeout: 60000 });

  // menu loads
  await page.waitForSelector('[data-testid="oo-search"]', { timeout: 30000 });
  const cards = await page.$$eval('[data-testid^="oo-add-"]', (x) => x.length).catch(() => 0);
  ok("B1 storefront menu renders with add-to-cart buttons", cards > 0, `${cards} buttons`);

  // add first product to the cart
  if (cards > 0) {
    await page.click('[data-testid^="oo-add-"]');
    await sleep(700);
    const badge = await page.$eval('[data-testid="oo-header-cart-count"]', (el) => el.textContent).catch(() => "");
    ok("B2 add-to-cart still works (cart badge shows 1)", (badge || "").trim() === "1", `badge="${(badge || "").trim()}"`);

    // open the cart drawer — checkout flow reachable
    await page.click('[data-testid="oo-header-cart"]').catch(() => {});
    await sleep(700);
    const drawer = await page.$$eval('[data-testid^="oo-"]', (els) => els.some((e) => /checkout|place order|proceed/i.test(e.textContent || ""))).catch(() => false);
    ok("B3 cart/checkout flow reachable after the logo change", drawer);
  }

  // logo still navigates from a cart-active state (no interference)
  const logo = await page.$('[data-testid="oo-logo"]');
  await logo.click();
  await page.waitForSelector('[data-testid="login-screen"]', { timeout: 30000 }).catch(() => {});
  ok("B4 logo click works mid-ordering (navigates to Login)", !!(await page.$('[data-testid="login-screen"]')));
  ok("B5 zero page errors in the ordering probe", errs.length === 0, errs.slice(0, 2).join(" | "));
  await page.close();
}

await browser.close();
console.log(`\n═══ ORDER-LOGO→LOGIN: ${pass} pass · ${fail} fail ═══`);
process.exit(fail ? 1 : 0);
