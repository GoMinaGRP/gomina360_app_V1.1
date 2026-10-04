// verify-boutique-ui.mjs — real-browser proof of the Boutique experience.
//
//  1. Owner opens the Boutique unit from the sidebar → dedicated module.
//  2. Sizes & Stock: the variant editor adds a size + stock and it persists.
//  3. Sales tab: POS sale picks a size/colour, records it and deducts stock.
//  4. Customer storefront (/order): size/colour chips, out-of-stock combos are
//     not orderable, the Add button requires a selection, and the cart line
//     shows the chosen size/colour. Lightbox picker gates the Add button too.
//
// Fixtures are restored/purged in the finally block.
// Run: bash dev-tooling/run-suite.sh dev-tooling/verify-boutique-ui.mjs
import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");
const fs = req("fs");
const pg = req("pg");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const OUT = new URL("./.verify-out/", import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.OWNER_PW || "Owner@GoMina26" };

let passes = 0;
let failures = 0;
const ql = (ok, msg, extra = "") => {
  if (ok) {
    passes++;
    console.log(`  ✓ ${msg}${extra ? ` — ${extra}` : ""}`);
  } else {
    failures++;
    console.error(`  ✗ ${msg}${extra ? ` — ${extra}` : ""}`);
  }
};

const suiteStart = new Date();
const client = new pg.Client(process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db");
await client.connect();
const q = async (sql, params) => (await client.query(sql, params)).rows;
const q1 = async (sql, params) => (await q(sql, params))[0];

const biz = await q1(`select * from businesses where code = 'BOUTIQUE-01'`);
const kente = await q1(`select * from inventory_items where business_id = $1 and sku = 'BOUTIQUE-01-KENTE-SHIRT'`, [biz.id]);
const originalVariants = await q(
  `select size, color, size_system, quantity, min_stock_threshold from inventory_variants where inventory_id = $1 and is_active = true order by id`,
  [kente.id],
);
const variantIdOf = async (size, color) =>
  (await q1(`select id from inventory_variants where inventory_id = $1 and size = $2 and color = $3 and is_active = true`, [kente.id, size, color]))?.id;

const api = async (cookie, method, path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await r.json();
  } catch {}
  return { status: r.status, data };
};
const loginToken = async () => {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: OWNER.email, password: OWNER.pw }),
  });
  return (r.headers.get("set-cookie") || "").split(";")[0];
};
let ownerCookie = null;
let zeroedVariant = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, timeout = 25000, step = 300) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true;
    await sleep(step);
  }
  return false;
};

const chromium = (await req("@sparticuz/chromium")).default ?? req("@sparticuz/chromium");
const browser = await puppeteer.launch({
  executablePath: await chromium.executablePath(),
  args: [...(chromium.args || []), "--no-sandbox", "--disable-setuid-sandbox"],
});

let page;
try {
  ownerCookie = await loginToken();
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 950 });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message || e).slice(0, 160)));

  // ── 1. Login + open the boutique unit ─────────────────────────────────
  await page.goto(`${BASE}/?login=1`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector('[data-testid="login-email"]', { timeout: 120000 });
  await page.type('[data-testid="login-email"]', OWNER.email);
  await page.type('[data-testid="login-password"]', OWNER.pw);
  await page.click('[data-testid="login-submit"]');
  await waitFor(async () => (await page.$('[data-testid="nav-sidebar"]')) !== null, 45000);
  ql(true, "owner signs in");

  const opened = await waitFor(async () =>
    page.evaluate(() => {
      const sidebar = document.querySelector('[data-testid="nav-sidebar"]') || document;
      const find = (re) => [...sidebar.querySelectorAll("button, a")].find((b) => re.test(b.textContent || ""));
      // The sidebar shows the first few units then a "Show all" expander — the
      // Boutique unit lives behind it.
      const unit = find(/Mina Fashion Boutique/i);
      if (unit) {
        unit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return true;
      }
      const more = find(/Show all \d+ units/i);
      if (more) {
        more.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return false; // next poll finds the unit
      }
      return false;
    }),
  );
  ql(opened, "Boutique unit opens from the sidebar");
  const moduleShown = await waitFor(async () => (await page.$('[data-testid="boutique-module"]')) !== null, 45000);
  ql(moduleShown, "dedicated Boutique module mounts");
  if (!moduleShown) throw new Error("Boutique module did not mount");
  ql(
    (await page.$eval('[data-testid="boutique-title"]', (el) => el.textContent || "")).includes("Mina Fashion Boutique"),
    "module header shows the unit",
  );
  for (const tab of ["DASHBOARD", "PRODUCTS", "SALES", "ORDERS", "FINANCE", "CUSTOMERS", "CHECKLIST"]) {
    ql((await page.$(`[data-testid="boutique-tab-${tab}"]`)) !== null, `tab ${tab} rendered`);
  }
  await page.screenshot({ path: `${OUT}boutique-dashboard.png` });
  const bestSellers = await page.$eval('[data-testid="boutique-best-sellers"]', (el) => el.innerText).catch(() => "");
  ql(bestSellers.length > 0, "dashboard renders the best-seller panel");
  const lowStock = await page.$eval('[data-testid="boutique-low-stock"]', (el) => el.innerText).catch(() => "");
  ql(lowStock.length > 0, "dashboard renders low-stock sizes/colours", lowStock.split("\n")[0] || "");

  // ── 2. Sizes & Stock: add a size + stock through the editor ───────────
  await page.click('[data-testid="boutique-tab-PRODUCTS"]');
  await page.waitForSelector(`[data-testid="boutique-product-${kente.id}"]`, { timeout: 30000 });
  const rowText = await page.$eval(`[data-testid="boutique-product-${kente.id}"]`, (el) => el.innerText);
  ql(/Sizes:.*S/i.test(rowText) && /Colours:.*Black/i.test(rowText), "product row lists its sizes & colours", rowText.replace(/\n/g, " · ").slice(0, 120));
  await page.screenshot({ path: `${OUT}boutique-products.png` });

  await page.click(`[data-testid="boutique-manage-${kente.id}"]`);
  await page.waitForSelector('[data-testid="boutique-variant-editor"]', { timeout: 20000 });
  ql(true, "sizes & colours editor opens");
  await page.click('[data-testid="boutique-size-chip-3XL"]');
  const qtyInputs = await page.$$('[data-testid^="boutique-variant-qty-"]');
  ql(qtyInputs.length > 0, "editor shows a stock row per size × colour", `${qtyInputs.length} rows`);
  // React-controlled number input: set the value through the native setter so
  // the component's onChange sees the edit (a plain .type() appends to "0").
  await qtyInputs[qtyInputs.length - 1].evaluate((el, value) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, String(value));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, 4);
  await page.screenshot({ path: `${OUT}boutique-variant-editor.png` });
  await page.click('[data-testid="boutique-save-variants"]');
  const saved = await waitFor(async () => (await page.$eval('[data-testid="boutique-flash"]', (el) => el.textContent || "").catch(() => "")).includes("Sizes & colours saved"), 25000);
  ql(saved, "editor saves the new size");
  const newRows = await q(
    `select * from inventory_variants where inventory_id = $1 and size = '3XL' and is_active = true order by id`,
    [kente.id],
  );
  ql(newRows.length === 3, "new size persists across the colour axis", `${newRows.length} rows`);
  const newTotal = newRows.reduce((sum, r) => sum + Number(r.quantity), 0);
  ql(newTotal === 4, "new size carries the entered stock", `total ${newTotal}`);
  const stocked3xl = newRows.find((r) => Number(r.quantity) > 0);
  ql(!!stocked3xl, "one combination carries the stock", stocked3xl ? `${stocked3xl.color} ${stocked3xl.quantity}` : "none");
  const aggOk = await q1(
    `select i.quantity item_qty, coalesce((select sum(v.quantity) from inventory_variants v where v.inventory_id = i.id and v.is_active),0) v_qty from inventory_items i where i.id = $1`,
    [kente.id],
  );
  ql(Math.abs(Number(aggOk.item_qty) - Number(aggOk.v_qty)) < 0.001, "product total stays the sum of variants", `${aggOk.item_qty} / ${aggOk.v_qty}`);
  const new3xlVariantId = stocked3xl.id;
  const new3xlColor = stocked3xl.color;

  // ── 3. POS sale from the module ───────────────────────────────────────
  await page.click('[data-testid="boutique-tab-SALES"]');
  await page.waitForSelector('[data-testid="boutique-sale-product"]', { timeout: 20000 });
  const before = await q1(`select quantity from inventory_variants where id = $1`, [new3xlVariantId]);
  await page.select('[data-testid="boutique-sale-product"]', String(kente.id));
  await page.waitForSelector(`[data-testid="boutique-sale-size-${kente.id}-3XL"]`, { timeout: 20000 });
  await page.click(`[data-testid="boutique-sale-size-${kente.id}-3XL"]`);
  await page.click(`[data-testid="boutique-sale-color-${kente.id}-${new3xlColor}"]`);
  const submitDisabled = await page.$eval('[data-testid="boutique-sale-submit"]', (el) => el.disabled);
  ql(submitDisabled === false, "POS submit is enabled with a size/colour chosen");
  await page.click('[data-testid="boutique-sale-submit"]');
  const receiptShown = await waitFor(async () => (await page.$('[data-testid="boutique-sale-receipt"]')) !== null, 25000);
  ql(receiptShown, "POS sale records a receipt");
  if (receiptShown) {
    const receiptText = await page.$eval('[data-testid="boutique-sale-receipt"]', (el) => el.innerText);
    ql(new RegExp(`Size 3XL`, "i").test(receiptText) && receiptText.toLowerCase().includes(new3xlColor.toLowerCase()), "receipt names the size & colour", receiptText.replace(/\n/g, " "));
  }
  await page.screenshot({ path: `${OUT}boutique-pos.png` });
  const after = await q1(`select quantity from inventory_variants where id = $1`, [new3xlVariantId]);
  ql(Number(after.quantity) === Number(before.quantity) - 1, "POS sale deducts the exact size/colour", `${before.quantity} → ${after.quantity}`);

  // ── 4. Customer storefront ────────────────────────────────────────────
  // Exhaust one combination (M / Black) so the storefront must show it as out
  // of stock and non-orderable.
  const mBlackId = await variantIdOf("M", "Black");
  zeroedVariant = { id: mBlackId, quantity: Number((await q1(`select quantity from inventory_variants where id = $1`, [mBlackId])).quantity) };
  await api(ownerCookie, "POST", "/api/boutique", { action: "ADJUST_STOCK", businessId: biz.id, variantId: mBlackId, quantity: 0 });

  await page.goto(`${BASE}/order`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector('[data-testid="oo-root"]', { timeout: 120000 });
  const bizBtn = `[data-testid="oo-biz-${biz.id}"]`;
  await waitFor(async () => (await page.$(bizBtn)) !== null, 30000);
  await page.click(bizBtn);
  await page.waitForSelector(`[data-testid="oo-prod-${kente.id}"]`, { timeout: 30000 });
  ql(true, "storefront lists the boutique product after choosing the unit");

  const addTestId = `[data-testid="oo-add-${kente.id}"]`;
  const addLabelBefore = await page.$eval(addTestId, (el) => el.innerText).catch(() => "");
  const addDisabledBefore = await page.$eval(addTestId, (el) => el.disabled).catch(() => null);
  ql(addDisabledBefore === true && /choose size/i.test(addLabelBefore), "Add to Cart waits for a size/colour", addLabelBefore);
  ql((await page.$(`[data-testid="oo-size-${kente.id}-M"]`)) !== null, "storefront renders size chips");
  ql((await page.$(`[data-testid="oo-color-${kente.id}-Black"]`)) !== null, "storefront renders colour chips");

  // Choose the size axis first: M is out of stock once Black is chosen.
  await page.click(`[data-testid="oo-color-${kente.id}-Black"]`);
  const mDisabled = await page.$eval(`[data-testid="oo-size-${kente.id}-M"]`, (el) => el.disabled).catch(() => null);
  ql(mDisabled === true, "exhausted size/colour is not selectable (M + Black)");
  const mTitle = await page.$eval(`[data-testid="oo-size-${kente.id}-M"]`, (el) => el.getAttribute("title") || "");
  ql(/out of stock/i.test(mTitle), "storefront marks the exhausted combination out of stock", mTitle);
  const gateHint = await page.$eval(`[data-testid="oo-variant-hint-${kente.id}"]`, (el) => el.innerText).catch(() => "");
  ql(/choose a size/i.test(gateHint), "storefront keeps asking for the missing choice", gateHint);
  await page.click(`[data-testid="oo-size-${kente.id}-L"]`);
  const addEnabled = await page.$eval(addTestId, (el) => el.disabled).catch(() => null);
  ql(addEnabled === false, "Add to Cart unlocks once an in-stock size/colour is chosen");
  await page.screenshot({ path: `${OUT}boutique-storefront-variants.png` });
  await page.click(addTestId);
  const cartBadge = await waitFor(async () => (await page.$(`[data-testid="oo-cart-line-variant-${kente.id}"]`)) !== null, 15000);
  ql(cartBadge, "cart line shows the chosen size/colour");
  if (cartBadge) {
    const badge = await page.$eval(`[data-testid="oo-cart-line-variant-${kente.id}"]`, (el) => el.innerText);
    ql(/L/.test(badge) && /Black/.test(badge), "cart badge names size + colour", badge);
  }
  await page.screenshot({ path: `${OUT}boutique-storefront-cart.png` });

  // Lightbox picker also gates the Add button.
  await page.click(`[data-testid="oo-details-${kente.id}"]`);
  const lightbox = await waitFor(async () => (await page.$('[data-testid="oo-lightbox"]')) !== null, 15000);
  ql(lightbox, "product lightbox opens");
  if (lightbox) {
    const lbPicker = await page.$(`[data-testid="oo-lb-variants-${kente.id}"]`);
    ql(!!lbPicker, "lightbox hosts the size/colour picker");
    const lbDisabled = await page.$eval('[data-testid="oo-lightbox-add"]', (el) => el.disabled).catch(() => null);
    ql(lbDisabled === true, "lightbox Add is gated on a selection");
    await page.click(`[data-testid="oo-lb-size-${kente.id}-S"]`).catch(() => {});
    await page.click(`[data-testid="oo-lb-color-${kente.id}-Navy"]`).catch(() => {});
    await sleep(600);
    const lbEnabled = await page.$eval('[data-testid="oo-lightbox-add"]', (el) => el.disabled).catch(() => null);
    ql(lbEnabled === false, "lightbox Add unlocks after choosing size + colour");
    await page.screenshot({ path: `${OUT}boutique-lightbox.png` });
    await page.click('[data-testid="oo-lightbox-close"]').catch(() => {});
  }

  ql(pageErrors.length === 0, "no uncaught page errors", pageErrors.slice(0, 2).join(" | "));
} catch (e) {
  console.error("UI suite error:", e.message);
  failures++;
} finally {
  // Restore the M/Black variant, drop the suite's added 3XL rows, remove the
  // receipts/transactions/tracking rows the POS sale created and re-sync.
  try {
    if (zeroedVariant?.id) {
      await api(ownerCookie, "POST", "/api/boutique", { action: "ADJUST_STOCK", businessId: biz.id, variantId: zeroedVariant.id, quantity: zeroedVariant.quantity });
    }
    await client.query(`delete from inventory_variants where inventory_id = $1 and size = '3XL'`, [kente.id]);
    // Empty grid combinations the editor created for the new size (inactive,
    // zero-stock) are suite residue — drop them too.
    await client.query(
      `delete from inventory_variants where inventory_id = $1 and is_active = false and quantity = 0 and created_at >= $2`,
      [kente.id, suiteStart],
    ).catch(() => {});
    // Rows this suite created during the run (single-writer sandbox: safe to
    // scope by business + creation time).
    await client.query(`delete from transactions where business_id = $1 and created_at >= $2`, [biz.id, suiteStart]).catch(() => {});
    await client.query(`delete from sales_documents where business_id = $1 and created_at >= $2`, [biz.id, suiteStart]).catch(() => {});
    await client.query(`delete from customer_trackings where business_id = $1 and created_at >= $2`, [biz.id, suiteStart]).catch(() => {});
    const matrix = originalVariants.map((v) => ({
      size: v.size,
      color: v.color,
      sizeSystem: v.size_system,
      quantity: Number(v.quantity),
      minStockThreshold: Number(v.min_stock_threshold),
    }));
    await api(ownerCookie, "POST", "/api/boutique", { action: "SET_VARIANTS", businessId: biz.id, inventoryId: kente.id, replace: true, variants: matrix });
  } catch (e) {
    console.error("cleanup warning:", e.message);
  }
  await browser.close().catch(() => {});
  await client.end();
  console.log(`\n${failures === 0 ? "✅ BOUTIQUE UI SUITE PASSED" : `❌ ${failures} boutique UI check(s) FAILED`} (${passes + failures} checks)`);
  process.exit(failures === 0 ? 0 : 1);
}
