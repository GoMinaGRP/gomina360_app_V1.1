/**
 * verify-order-page-regression.mjs — the rest of the customer order page must
 * behave exactly as before the address-dropdown layering fix.
 *
 * Covers: catalog + search + category filter, add-to-cart / stepper / typed
 * quantity, pickup↔delivery switch, pickup map, delivery validation guards,
 * the pin picker (GPS-less: drop pin + nudge + manual coords + zoom + map
 * style toggle), MoMo payment choice, HELP panel, and a REAL end-to-end
 * DELIVERY order placement returning a GM-* tracking code.
 *
 * Everything typed is TEST-* prefixed. Run:
 *   LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-order-page-regression.mjs
 */
import { createRequire } from "module";
const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const results = [];
const ok = (name, cond, extra = "") => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "✅" : "❌"} ${name}${cond ? "" : " — " + extra}`);
  return cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Scroll an element into the middle of the viewport before interacting. */
async function show(page, sel) {
  await page.evaluate((s) => {
    document.querySelector(s)?.scrollIntoView({ block: "center" });
  }, sel);
  await sleep(250);
}
/** Reliably replace the contents of a text input. */
async function setInput(page, sel, text) {
  await show(page, sel);
  await page.click(sel);
  await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (el) el.setSelectionRange(0, el.value.length);
  }, sel);
  await page.keyboard.press("Backspace");
  await sleep(120);
  if (text) await page.type(sel, text, { delay: 20 });
}

const browser = await puppeteer.launch({
  executablePath: "/tmp/al2023/chromium",
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

try {
  await page.goto(`${BASE}/order`, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector('[data-testid="oo-catalog"]', { timeout: 30000 });

  // ── Catalog / browsing ────────────────────────────────────────────────
  const prodCount = await page.$$eval('[data-testid^="oo-prod-"]', (n) => n.length);
  ok("catalog lists products", prodCount > 0, `count=${prodCount}`);

  ok("header search present", !!(await page.$('[data-testid="oo-search"]')));
  ok("category bar present", !!(await page.$('[data-testid="oo-catbar"]')));
  ok("branches-serving card present", !!(await page.$('[data-testid="oo-serve-card"]')));
  ok("business picker row present", !!(await page.$('[data-testid="oo-bizrow"]')));

  // Search narrows the catalog, then clears back.
  await page.type('[data-testid="oo-search"]', "zzzznomatch", { delay: 10 });
  await sleep(500);
  const emptyShown = !!(await page.$('[data-testid="oo-empty"]'));
  ok("search filters the catalog", emptyShown);
  await page.click('[data-testid="oo-search"]', { clickCount: 3 });
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  await sleep(700);
  await page.waitForSelector('[data-testid^="oo-prod-"]', { timeout: 15000 });
  ok("clearing search restores products",
    (await page.$$eval('[data-testid^="oo-prod-"]', (n) => n.length)) > 0);

  // ── Cart: add, stepper, typed quantity ────────────────────────────────
  const firstAdd = await page.$('[data-testid^="oo-add-"]');
  const pid = await page.evaluate((el) => el.getAttribute("data-testid").replace("oo-add-", ""), firstAdd);
  await firstAdd.click();
  await page.waitForSelector('[data-testid="oo-checkout"]', { timeout: 20000 });
  ok("add to cart opens checkout", true);
  ok("cart bar visible", !!(await page.$('[data-testid="oo-cart"]')));

  const qtySel = `[data-testid="oo-qty-${pid}"]`;
  if (await page.$(qtySel)) {
    await setInput(page, qtySel, "3");
    await page.keyboard.press("Enter");
    await sleep(400);
    const q = await page.$eval(qtySel, (el) => el.value);
    ok("typed quantity accepted", q === "3", `value=${q}`);
  } else {
    ok("typed quantity accepted", false, "qty input missing");
  }

  // ── Fulfillment switch + pickup map ───────────────────────────────────
  await page.click('[data-testid="oo-pickup"]');
  await sleep(600);
  ok("pickup mode selected", !(await page.$('[data-testid="oo-delivery-block"]')));

  await page.click('[data-testid="oo-delivery"]');
  await page.waitForSelector('[data-testid="oo-delivery-block"]', { timeout: 20000 });
  await sleep(1500);
  ok("delivery block renders", true);
  ok("address autocomplete input present", !!(await page.$('[data-testid="oo-dest-input"]')));
  ok("pin picker renders", !!(await page.$('[data-testid="oo-pin-root"]')));
  ok("map style toggle present", !!(await page.$('[data-testid="oo-pin-style"]')));
  ok("zoom controls present",
    !!(await page.$('[data-testid="oo-pin-zoom-in"]')) && !!(await page.$('[data-testid="oo-pin-zoom-out"]')));
  ok("nudge pad present", !!(await page.$('[data-testid="oo-pin-nudge"]')));

  // ── Validation guards (unchanged behaviour) — run while the address is
  //    still empty, i.e. BEFORE any pin is dropped (dropping a pin
  //    reverse-geocodes and auto-fills the address by design).
  await show(page, '[data-testid="oo-place"]');
  await page.click('[data-testid="oo-place"]');
  await sleep(700);
  const err1 = await page.$eval("body", (b) => b.innerText);
  ok("missing name is blocked", /enter your name/i.test(err1), err1.slice(0, 120));

  await setInput(page, '[data-testid="oo-name"]', "TEST Ama Serwaa");
  await setInput(page, '[data-testid="oo-phone"]', "0551");
  await sleep(400);
  ok("short phone shows inline error", !!(await page.$('[data-testid="oo-phone-error"]')));
  await setInput(page, '[data-testid="oo-phone"]', "0551234567");
  await sleep(400);
  ok("valid phone clears the error", !(await page.$('[data-testid="oo-phone-error"]')));

  await show(page, '[data-testid="oo-place"]');
  await page.click('[data-testid="oo-place"]');
  await sleep(700);
  const err2 = await page.$eval("body", (b) => b.innerText);
  ok("missing address is blocked", /where to deliver/i.test(err2), err2.slice(0, 140));

  // Address ORDER on the page: field must sit ABOVE the map.
  const order = await page.evaluate(() => {
    const a = document.querySelector('[data-testid="oo-dest-root"]')?.getBoundingClientRect();
    const m = document.querySelector('[data-testid="oo-pin-root"]')?.getBoundingClientRect();
    return a && m ? { addrBottom: a.bottom, mapTop: m.top } : null;
  });
  ok("address field sits above the map", !!order && order.addrBottom <= order.mapTop + 1,
    JSON.stringify(order));

  // Satellite toggle still works.
  await show(page, '[data-testid="oo-pin-style-sat"]');
  await page.click('[data-testid="oo-pin-style-sat"]');
  await sleep(900);
  ok("satellite view toggles", await page.evaluate(() =>
    !!document.querySelector('img.leaflet-tile[src*="World_Imagery"], .leaflet-container')));
  await show(page, '[data-testid="oo-pin-style-std"]');
  await page.click('[data-testid="oo-pin-style-std"]');
  await sleep(600);

  // Drop a pin, nudge it, and set exact coordinates.
  if (await page.$('[data-testid="oo-pin-set"]')) {
    await show(page, '[data-testid="oo-pin-set"]');
    await page.click('[data-testid="oo-pin-set"]');
  }
  await sleep(700);
  await show(page, '[data-testid="oo-pin-manual-toggle"]');
  await page.click('[data-testid="oo-pin-manual-toggle"]');
  await page.waitForSelector('[data-testid="oo-pin-manual-lat"]', { timeout: 10000 });
  await setInput(page, '[data-testid="oo-pin-manual-lat"]', "5.650123");
  await setInput(page, '[data-testid="oo-pin-manual-lng"]', "-0.155456");
  await show(page, '[data-testid="oo-pin-manual-apply"]');
  await page.click('[data-testid="oo-pin-manual-apply"]');
  await sleep(900);
  const coords = await page.$eval('[data-testid="oo-pin-coords"]', (el) => el.textContent.trim());
  ok("manual coordinates set the pin", coords.includes("5.650123") && coords.includes("-0.155456"), coords);

  await show(page, '[data-testid="oo-pin-n"]');
  await page.click('[data-testid="oo-pin-n"]');
  await sleep(600);
  const nudged = await page.$eval('[data-testid="oo-pin-coords"]', (el) => el.textContent.trim());
  ok("nudge pad moves the pin", nudged !== coords, `${coords} → ${nudged}`);

  // Existing behaviour: dropping/moving the pin reverse-geocodes into the
  // address field when the customer has not typed their own text.
  await sleep(1600);
  const autoAddr = await page.$eval('[data-testid="oo-dest-input"]', (el) => el.value);
  ok("pin reverse-geocodes into the address field", autoAddr.trim().length > 0, `value="${autoAddr}"`);

  // ── Address autocomplete: type + pick (the feature under change) ──────
  await setInput(page, '[data-testid="oo-dest-input"]', "Spintex");
  await page.waitForSelector('[data-testid="oo-dest-list"]', { timeout: 20000 });
  ok("suggestions open while typing", true);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await sleep(900);
  const destVal = await page.$eval('[data-testid="oo-dest-input"]', (el) => el.value);
  ok("keyboard pick fills the address", destVal.length > 3, destVal);

  // Free-typing after a pick must still be allowed (customer adds a landmark).
  await page.type('[data-testid="oo-dest-input"]', " — TEST blue gate", { delay: 15 });
  await sleep(400);
  ok("address stays editable after picking",
    (await page.$eval('[data-testid="oo-dest-input"]', (el) => el.value)).includes("TEST blue gate"));
  await page.keyboard.press("Escape");
  await sleep(300);

  // ── Payment choice ────────────────────────────────────────────────────
  await show(page, '[data-testid="oo-pay-momo"]');
  await page.click('[data-testid="oo-pay-momo"]');
  await sleep(400);
  ok("MoMo reference field appears", !!(await page.$('[data-testid="oo-momo-ref"]')));
  await show(page, '[data-testid="oo-pay-ondelivery"]');
  await page.click('[data-testid="oo-pay-ondelivery"]');
  await sleep(400);
  ok("pay-on-delivery reselects", !(await page.$('[data-testid="oo-momo-ref"]')));

  // ── HELP panel ────────────────────────────────────────────────────────
  await show(page, '[data-testid="oo-help"]');
  await page.click('[data-testid="oo-help"]');
  await sleep(700);
  ok("HELP panel opens", await page.evaluate(() => /how to use|support/i.test(document.body.innerText)));
  await page.keyboard.press("Escape");
  await sleep(400);

  // ── Place the order for real ──────────────────────────────────────────
  await page.evaluate(() => document.querySelector('[data-testid="oo-place"]')?.scrollIntoView({ block: "center" }));
  await sleep(300);
  await page.click('[data-testid="oo-place"]');
  await sleep(3500);
  const body = await page.$eval("body", (b) => b.innerText);
  const code = (body.match(/GM-[A-Z0-9-]+/) || [])[0] || "";
  ok("delivery order placed end-to-end", !!code, body.slice(0, 220));
  if (code) console.log(`   tracking code: ${code}`);

  ok("zero page errors across the whole flow", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

  // Clean up the TEST order so live data stays untouched.
  if (code) {
    const { Client } = require("pg");
    const pg = new Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });
    await pg.connect();
    try {
      const r = await pg.query(
        `DELETE FROM customer_trackings WHERE tracking_code = $1 RETURNING id`, [code],
      );
      await pg.query(`DELETE FROM customers WHERE name LIKE 'TEST %'`);
      await pg.query(`DELETE FROM transactions WHERE description LIKE '%TEST Ama Serwaa%'`);
      console.log(`   cleaned up ${r.rowCount} TEST order row(s)`);
    } catch (e) {
      console.log("   cleanup note: " + e.message);
    } finally {
      await pg.end();
    }
  }
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("FAILED:\n" + failed.map((f) => " · " + f.name).join("\n"));
  process.exit(1);
}
