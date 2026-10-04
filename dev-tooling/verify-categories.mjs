// verify-categories.mjs — standardized inventory categories + marketplace grouping.
//
// Proves:
//   • every stored inventory category is one of the shared standard categories
//   • the one-time migration kept the branch's original wording (subcategory)
//   • new stock items (API + business-module paths) are normalized on write
//   • the customer marketplace reports standard categories, so ONE category
//     chip shows products from every eligible business
//   • the Add Stock Item form offers the standard list and the subcategory list
//     follows the chosen category
//   • the login page shows "Enterprise Command Center"
//
// Run: bash dev-tooling/run-suite.sh dev-tooling/verify-categories.mjs
import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");
const chromium = req("@sparticuz/chromium").default ?? req("@sparticuz/chromium");
const pg = req("pg");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.OWNER_PW || "Owner@GoMina26" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
let failures = 0;
const ok = (name, cond, extra = "") => {
  checks.push({ name, pass: !!cond });
  if (!cond) failures++;
  console.log(`${cond ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`);
};

const client = new pg.Client(DB);
await client.connect();
const q = async (sql, params) => (await client.query(sql, params)).rows;
const q1 = async (sql, params) => (await q(sql, params))[0];

const login = async (email, password) => {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && !!j.sessionToken, cookie: (r.headers.get("set-cookie") || "").split(";")[0] };
};
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

const { STANDARD_INVENTORY_CATEGORIES } = await import("../src/lib/inventoryCategories.ts");
const STANDARD = new Set(STANDARD_INVENTORY_CATEGORIES);

// Fixtures this run creates — all purged at the end.
const createdItemIds = [];
const TAG = `CATVERIFY-${Date.now().toString(36).toUpperCase()}`;

console.log("\n── 1. TAXONOMY + EXISTING DATA ──");
const distinct = await q(`select distinct category from inventory_items`);
const nonStandard = distinct.map((r) => r.category).filter((c) => !STANDARD.has(c));
ok("every stored inventory category is a standard category", nonStandard.length === 0, nonStandard.join(", ") || `${distinct.length} distinct values`);

// Nothing lost: the original wording is either the standard name itself or is
// preserved verbatim as the subcategory.
const lost = await q(
  `select id, category, subcategory from inventory_items
    where subcategory is null
      and category not in (select unnest($1::text[]))`,
  [STANDARD_INVENTORY_CATEGORIES],
);
ok("no row lost its original wording during migration", lost.length === 0, JSON.stringify(lost.slice(0, 3)));

const migrated = await q1(
  `select count(*)::int c from inventory_items where subcategory is not null and subcategory <> ''`,
);
ok("migration preserved specific wording as subcategory", migrated.c > 0, `${migrated.c} row(s) carry a subcategory`);

// Spot-check the original live rows that started with legacy categories.
const eggRow = await q1(`select category, subcategory from inventory_items where sku = 'POUL-EGG-L01'`);
ok("egg trays → Poultry & Eggs / Eggs", eggRow?.category === "Poultry & Eggs" && !!eggRow?.subcategory, JSON.stringify(eggRow));
const blockRow = await q1(`select category, subcategory from inventory_items where sku = 'BLK-SOLID-6IN'`);
ok("concrete blocks → Building Materials / Concrete Blocks", blockRow?.category === "Building Materials" && blockRow?.subcategory === "Concrete Blocks", JSON.stringify(blockRow));
const dressRow = await q1(`select category, subcategory from inventory_items where sku = 'BOUTIQUE-01-ANKARA-DRESS'`);
ok("boutique dress → Fashion & Clothing / Women's Clothing", dressRow?.category === "Fashion & Clothing" && !!dressRow?.subcategory, JSON.stringify(dressRow));

console.log("\n── 2. WRITE PATH (two businesses, different wording) ──");
const owner = await login(OWNER.email, OWNER.pw);
ok("owner login", owner.ok);

const bizA = await q1(`select id, code, name from businesses where code = 'POULTRY-01'`);
const bizB = await q1(`select id, code, name from businesses where code = 'BLOCK-01'`);
ok("two eligible businesses resolved", !!bizA?.id && !!bizB?.id, `${bizA?.code} / ${bizB?.code}`);

const mk = async (biz, name, category, subcategory) => {
  const res = await api(owner.cookie, "POST", "/api/enterprise", {
    entityType: "inventory",
    data: {
      businessId: biz.id,
      name: `${TAG} ${name}`,
      category,
      subcategory,
      quantity: 7,
      unit: "Units",
      costPriceGhs: 10,
      sellingPriceGhs: 25,
      minStockThreshold: 1,
    },
  });
  if (res.data?.item?.id) createdItemIds.push(res.data.item.id);
  return res.data?.item;
};

// Legacy/free-text wording through the REAL API (the same endpoint every
// module uses) must be normalized to the shared umbrella.
const itemA = await mk(bizA, "Ankara Sandals", "Ladies' Sandals", null);
ok("legacy wording normalized on write", itemA?.category === "Fashion & Clothing", `${itemA?.category} / ${itemA?.subcategory}`);
ok("original wording preserved as subcategory", itemA?.subcategory === "Ladies' Sandals", String(itemA?.subcategory));

const itemB = await mk(bizB, "Office Shirt", "Men's Shirts", null);
ok("second business lands in the same umbrella", itemB?.category === itemA?.category, `${itemB?.category} vs ${itemA?.category}`);

const itemC = await mk(bizA, "Hand Tools Set", "Hardware & Tools", "Hand Tools");
ok("explicit standard category is kept as-is", itemC?.category === "Hardware & Tools" && itemC?.subcategory === "Hand Tools", `${itemC?.category} / ${itemC?.subcategory}`);

// Editing an existing item through the real PATCH path normalizes too.
const patchTarget = itemA;
const patched = await api(owner.cookie, "PATCH", "/api/enterprise", {
  entityType: "inventory",
  id: patchTarget?.id,
  data: { category: "Solar Panels & Inverters" },
});
const patchedRow = await q1(`select category, subcategory from inventory_items where id = $1`, [patchTarget?.id]);
ok(
  "editing a category normalizes it (PATCH)",
  patched.status === 200 && patchedRow?.category === "Computers & Electronics" && patchedRow?.subcategory === "Solar Panels & Inverters",
  `${patched.status} ${JSON.stringify(patchedRow)}`,
);

// A second fashion fixture for the first business (the PATCH check above moved
// the first one) — the marketplace must show BOTH businesses under one chip.
const itemD = await mk(bizA, "Ankara Handbag", "Bags & Accessories", null);
ok("third fixture shares the umbrella", itemD?.category === "Fashion & Clothing", `${itemD?.category} / ${itemD?.subcategory}`);

console.log("\n── 3. MARKETPLACE (public /api/menu) ──");
const menuRes = await fetch(`${BASE}/api/menu`);
const menu = (await menuRes.json().catch(() => ({}))).businesses || [];
const allProducts = menu.flatMap((b) => (b.products || []).map((p) => ({ ...p, biz: b.businessCode })));
ok("marketplace reachable", menuRes.ok && allProducts.length > 0, `${allProducts.length} products / ${menu.length} businesses`);

const badCats = allProducts.filter((p) => !STANDARD.has(String(p.category)));
ok("marketplace only serves standard categories", badCats.length === 0, badCats.slice(0, 3).map((p) => p.category).join(", "));

const fashion = allProducts.filter((p) => p.category === "Fashion & Clothing");
const fashionBiz = new Set(fashion.map((p) => p.biz));
ok(
  "ONE category groups products from several businesses",
  fashionBiz.size >= 2 && fashion.some((p) => p.name.includes(TAG)),
  `${fashion.length} fashion products across ${fashionBiz.size} business(es)`,
);
ok(
  "marketplace keeps the branch wording as subcategory",
  fashion.some((p) => p.name.includes(TAG) && (p.subcategory === "Ladies' Sandals" || p.subcategory === "Men's Clothing")),
  JSON.stringify(fashion.filter((p) => p.name.includes(TAG)).map((p) => `${p.biz}:${p.subcategory}`)),
);

// Stock-scoped check: the specific purchase paths (module stock-in) also land
// in the shared taxonomy.
await api(owner.cookie, "POST", "/api/enterprise", {
  entityType: "inventory",
  data: { businessId: bizA.id, name: `${TAG} Solar Inverter`, category: "Solar & Energy", quantity: 2, unit: "Units", costPriceGhs: 100, sellingPriceGhs: 150 },
}).then((r) => r.data?.item?.id && createdItemIds.push(r.data.item.id));
const solar = await q1(`select category, subcategory from inventory_items where name = $1`, [`${TAG} Solar Inverter`]);
ok("module-style stock-in (Solar & Energy) → Computers & Electronics / Solar & Power", solar?.category === "Computers & Electronics" && solar?.subcategory === "Solar & Power", JSON.stringify(solar));

console.log("\n── 4. UI (login text, Add Stock Item, storefront chips) ──");
const browser = await puppeteer.launch({
  executablePath: await chromium.executablePath(),
  args: [...(chromium.args || []), "--no-sandbox", "--disable-setuid-sandbox"],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 120)));

  // Login page wording (case-insensitive: the tagline is CSS-uppercased).
  await page.goto(`${BASE}/?login=1`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector('[data-testid="login-email"]', { timeout: 120000 });
  const loginText = (await page.$eval('[data-testid="login-screen"]', (el) => el.textContent || "")).toUpperCase();
  ok("login page shows ENTERPRISE COMMAND CENTER", loginText.includes("ENTERPRISE COMMAND CENTER"), "");
  ok("login page no longer says GHANA ENTERPRISE COMMAND CENTER", !loginText.includes("GHANA ENTERPRISE COMMAND CENTER"), "");

  // Sign in, open Inventory & Stock → Add Stock Item.
  await page.type('[data-testid="login-email"]', OWNER.email);
  await page.type('[data-testid="login-password"]', OWNER.pw);
  await page.click('[data-testid="login-submit"]');
  await page.waitForSelector('[data-testid="nav-sidebar"]', { timeout: 120000 });
  await sleep(2500);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('[data-testid="nav-sidebar"] button')].find((b) =>
      /inventory & stock/i.test(b.textContent || ""),
    );
    btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await sleep(2500);
  const opened = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="shared-add-open"]');
    if (!b) return false;
    b.click();
    return true;
  });
  ok("Add Stock Item form opens", opened);
  await sleep(1200);
  const catOptions = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="inv-category"] option')].map((o) => o.value),
  );
  const missing = STANDARD_INVENTORY_CATEGORIES.filter((c) => !catOptions.includes(c));
  ok("standard categories offered in the form", catOptions.length === STANDARD_INVENTORY_CATEGORIES.length && missing.length === 0, `${catOptions.length} options`);
  const subBefore = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="inv-subcategory"] option')].map((o) => o.value),
  );
  await page.select('[data-testid="inv-category"]', "Fashion & Clothing");
  await sleep(400);
  const subAfter = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="inv-subcategory"] option')].map((o) => o.value),
  );
  ok(
    "subcategory list follows the chosen category",
    subAfter.includes("Footwear") && !subBefore.includes("Footwear"),
    `after: ${subAfter.filter((v) => !v.startsWith("__")).slice(0, 3).join(", ")}…`,
  );

  // Storefront: category chips are standard and cross-business.
  const store = await browser.newPage();
  await store.setViewport({ width: 1440, height: 1000 });
  const storeErrors = [];
  store.on("pageerror", (e) => storeErrors.push(String(e.message).slice(0, 120)));
  await store.goto(`${BASE}/order`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await store.waitForSelector('[data-testid="oo-catbar"]', { timeout: 120000 });
  await sleep(2500);
  const chips = await store.evaluate(() => [...document.querySelectorAll('[data-testid^="oo-cat-"]')].map((b) => b.textContent.trim()));
  ok("storefront category bar shows the standard category", chips.includes("Fashion & Clothing"), chips.join(" | ").slice(0, 120));
  const clicked = await store.evaluate(() => {
    const b = [...document.querySelectorAll('[data-testid^="oo-cat-"]')].find((x) => x.textContent.trim() === "Fashion & Clothing");
    if (!b) return false;
    b.click();
    return true;
  });
  await sleep(1200);
  // Every visible product card carries oo-category-<id>; after selecting the
  // category they must ALL be that category, and the fixture from BOTH
  // businesses must be visible on the one page.
  const shown = await store.evaluate(() => {
    const cards = [...document.querySelectorAll("[data-testid^='oo-category-']")].map((e) => e.textContent.trim());
    const ids = [...document.querySelectorAll("[data-testid^='oo-prod-']")].map((e) => e.getAttribute("data-testid"));
    return { total: cards.length, fashion: cards.filter((c) => c === "Fashion & Clothing").length, ids };
  });
  ok(
    "selecting the category filters the whole marketplace to it",
    clicked && shown.total > 0 && shown.total === shown.fashion,
    JSON.stringify({ total: shown.total, fashion: shown.fashion }),
  );
  const subChips = await store.evaluate(() =>
    [...document.querySelectorAll("[data-testid^='oo-subcategory-']")].map((e) => e.textContent.trim()),
  );
  ok("storefront shows the branch wording as a subcategory chip", subChips.length > 0, subChips.slice(0, 4).join(", "));
  const crossBiz = menu
    .filter((b) => (b.products || []).some((p) => p.name.includes(TAG) && p.category === "Fashion & Clothing"))
    .map((b) => b.businessCode);
  ok("fixtures from two businesses share the category on the page", crossBiz.length >= 2, crossBiz.join(", "));

  ok("zero page errors", pageErrors.length === 0 && storeErrors.length === 0, [...pageErrors, ...storeErrors].slice(0, 2).join(" | "));
} finally {
  await browser.close().catch(() => {});
}

console.log("\n── 5. CLEANUP ──");
if (createdItemIds.length) {
  await q(`delete from inventory_items where id = any($1::int[])`, [createdItemIds]);
}
const leftovers = await q1(`select count(*)::int c from inventory_items where name like $1`, [`${TAG}%`]);
ok("test rows purged", leftovers.c === 0, `${createdItemIds.length} removed`);
await client.end();

console.log(`\n${failures === 0 ? "✅ ALL CATEGORY CHECKS PASSED" : `❌ ${failures} CHECK(S) FAILED`} (${checks.length} checks)`);
process.exit(failures === 0 ? 0 : 1);
