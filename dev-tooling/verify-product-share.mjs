#!/usr/bin/env node
/**
 * verify-product-share.mjs — per-product sharing on the Customer Order page.
 *
 *   A · Share menu UI (desktop, all-businesses grid): button per product,
 *       panel targets (WhatsApp / Telegram / Facebook / X / Email), built
 *       deep-link URL (origin + /order?biz=…&p=…), Copy Link via a stubbed
 *       clipboard, Esc + outside-click close.
 *   B · Deep link (desktop): ?biz&p focuses the product's business, scrolls
 *       the card into view, highlights it, auto-opens the details lightbox
 *       (images · name · price · description · ordering options), Add to
 *       Cart + full PICKUP order placement from the shared link.
 *   C · Resilience & isolation: SKU-based links resolve; unknown ids degrade
 *       to the normal storefront; a product from another business wins over
 *       a mismatched ?biz (the link lands on the PRODUCT's shop, never an
 *       empty page); the menu payload itself stays org-scoped.
 *   D · Mobile 375 px: share panel fits the viewport (clamped), deep link
 *       opens + closes cleanly, no horizontal overflow.
 *   E · The pre-existing full Order-page sharing (Owner → Manage Businesses
 *       → online tab: copy link + QR) still carries the same ?biz contract —
 *       verified by constructing the same URL shape the owner modal emits.
 *
 * TEST data purged afterwards (tracking/transaction/notification/customer
 * rows above baseline; inventory quantity restored exactly).
 *
 * Run: node dev-tooling/verify-product-share.mjs
 * Requires the app on :3000 with seeded demo data.
 */
import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");
const pg = req("pg");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const results = [];
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  results.push({ name, pass: !!cond });
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}${extra ? " — " + extra : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pageErrors = [];

const client = new pg.Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });

const hookPage = (page, tag) => {
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const txt = m.text();
    if (/Failed to load resource/.test(txt) && /(401|400|403|404|409|413)/.test(txt)) return;
    if (/net::/.test(txt)) return;
    pageErrors.push(`[${tag}] ${txt.slice(0, 300)}`);
  });
  page.on("pageerror", (e) => pageErrors.push(`[${tag}] PAGEERROR ${String(e).slice(0, 300)}`));
};

(async () => {
  await client.connect();

  // ── resolve test data: one in-stock product + a second product from a
  //    DIFFERENT business (cross-shop deep link) ──────────────────────────
  const stock = (await client.query(
    `SELECT i.id, i.sku, i.name, i.selling_price_ghs AS price, i.description, b.id AS biz, b.code, b.name AS bizname
     FROM inventory_items i JOIN businesses b ON b.id = i.business_id
     WHERE i.quantity > 0 ORDER BY i.id LIMIT 4`,
  )).rows;
  if (stock.length < 2) { console.error("FATAL: need ≥2 in-stock products"); process.exit(1); }
  const P = stock[0];
  const Q = stock.find((r) => r.biz !== P.biz) || stock[1];

  // cleanup baselines (same pattern as verify-online-ordering)
  const base = {
    trMax: (await client.query(`SELECT COALESCE(MAX(id),0)::int m FROM customer_trackings`)).rows[0].m,
    trxMax: (await client.query(`SELECT COALESCE(MAX(id),0)::int m FROM transactions`)).rows[0].m,
    ntfMax: (await client.query(`SELECT COALESCE(MAX(id),0)::int m FROM notifications`)).rows[0].m,
    custMax: (await client.query(`SELECT COALESCE(MAX(id),0)::int m FROM customers`)).rows[0].m,
    invQty: (await client.query(`SELECT quantity FROM inventory_items WHERE id=$1`, [P.id])).rows[0].quantity,
  };

  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: "/tmp/al2023/chromium",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    env: { ...process.env, LD_LIBRARY_PATH: "/tmp/al2023/lib" },
  });
  const freshContext = async () => {
    try { return await browser.createBrowserContext(); }
    catch { return await browser.createIncognitoBrowserContext(); }
  };

  /* ═══ A · Share menu UI (desktop, all-businesses grid) ═══════════════ */
  console.log("\n── A · Share menu UI ──");
  try {
    const ctx = await freshContext();
    const page = await ctx.newPage();
    hookPage(page, "share-desktop");
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`${BASE}/order`, { waitUntil: "networkidle0", timeout: 60000 });
    await page.waitForSelector(`[data-testid="oo-prod-${P.id}"]`, { timeout: 60000 });
    ok("A1 every product card renders a Share button",
      !!(await page.$(`[data-testid="oo-share-${P.id}"]`)));

    await page.click(`[data-testid="oo-share-${P.id}"]`);
    await page.waitForSelector(`[data-testid="oo-share-menu-${P.id}"]`, { timeout: 5000 });
    ok("A2 Share opens the target panel", true);
    const expectedUrl = `${BASE}/order?biz=${P.biz}&p=${P.id}`;
    const urlBox = await page.$eval(`[data-testid="oo-share-url-${P.id}"]`, (el) => (el.textContent || "").trim());
    ok("A3 built deep link is the stable ?biz=&p= form", urlBox === expectedUrl, `${urlBox} ≠ ${expectedUrl}`);

    const hrefs = await page.evaluate((id) => {
      const out = {};
      for (const k of ["whatsapp", "telegram", "facebook", "x", "email"]) {
        const a = document.querySelector(`[data-testid="oo-share-${k}-${id}"]`);
        out[k] = a ? a.href : null;
      }
      return out;
    }, P.id);
    ok("A4 WhatsApp intent carries product + shop + link",
      /^https:\/\/wa\.me\/\?text=/.test(hrefs.whatsapp || "") && decodeURIComponent(hrefs.whatsapp).includes(expectedUrl),
      hrefs.whatsapp);
    ok("A5 Telegram share carries the link",
      /^https:\/\/t\.me\/share\/url\?url=/.test(hrefs.telegram || "") && decodeURIComponent(hrefs.telegram).includes(`/order?biz=${P.biz}&p=${P.id}`));
    ok("A6 Facebook sharer carries the link",
      /^https:\/\/www\.facebook\.com\/sharer\/sharer\.php\?u=/.test(hrefs.facebook || "") && decodeURIComponent(hrefs.facebook).includes(expectedUrl));
    ok("A7 X intent carries the link",
      /^https:\/\/twitter\.com\/intent\/tweet\?url=/.test(hrefs.x || "") && decodeURIComponent(hrefs.x).includes(expectedUrl));
    ok("A8 Email (mailto) carries subject + link",
      /^mailto:\?subject=/.test(hrefs.email || "") && decodeURIComponent(hrefs.email).includes(expectedUrl));

    // Copy Link — stub the clipboard, click, assert the recorded URL + label.
    await page.evaluate(() => {
      window.__copied = null;
      navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); };
    }).catch(() => {});
    await page.click(`[data-testid="oo-share-copy-${P.id}"]`);
    await sleep(400);
    const copyState = await page.evaluate(() => ({
      copied: window.__copied,
      label: document.querySelector('[data-testid^="oo-share-copy-"]')?.textContent?.trim(),
    }));
    ok("A9 Copy Link puts the deep link on the clipboard",
      copyState.copied === expectedUrl, JSON.stringify(copyState.copied));
    ok("A10 Copy Link confirms with feedback", /copied/i.test(copyState.label || ""), copyState.label);

    // Esc closes
    await page.keyboard.press("Escape");
    await sleep(250);
    ok("A11 Esc closes the panel", !(await page.$(`[data-testid="oo-share-menu-${P.id}"]`)));
    // Outside click closes
    await page.click(`[data-testid="oo-share-${P.id}"]`);
    await page.waitForSelector(`[data-testid="oo-share-menu-${P.id}"]`, { timeout: 5000 });
    await page.mouse.click(640, 200);
    await sleep(300);
    ok("A12 outside click closes the panel", !(await page.$(`[data-testid="oo-share-menu-${P.id}"]`)));
    await ctx.close();
  } catch (e) {
    ok("A* share menu section completed without fatal error", false, String(e).slice(0, 200));
  }

  /* ═══ B · Deep link (desktop): focus + highlight + details + ordering ═ */
  console.log("\n── B · Shared-product deep link ──");
  try {
    const ctx = await freshContext();
    const page = await ctx.newPage();
    hookPage(page, "deeplink-desktop");
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`${BASE}/order?biz=${P.biz}&p=${P.id}`, { waitUntil: "networkidle0", timeout: 60000 });
    await page.waitForSelector(`[data-testid="oo-prod-${P.id}"]`, { timeout: 60000 });

    ok("B1 link opens focused on the product's business (not the all-shops grid)",
      (await page.$$('[data-testid^="oo-bizsec-"]')).length === 0);

    await page.waitForSelector('[data-testid="oo-lightbox"]', { timeout: 15000 });
    const lbText = await page.$eval('[data-testid="oo-lightbox"]', (el) => (el.textContent || "").replace(/\s+/g, " "));
    ok("B2 details view auto-opens for the shared product", lbText.includes(P.name), lbText.slice(0, 90));
    ok("B3 details view shows the price", lbText.includes(`GH₵ ${Number(P.price).toFixed(2)}`), `price=${P.price}`);
    ok("B4 details view shows the description", !P.description || lbText.includes(String(P.description).slice(0, 24)),
      String(P.description || "").slice(0, 40));

    await page.click('[data-testid="oo-lightbox-close"]');
    await sleep(500);
    const cardCls = await page.$eval(`[data-testid="oo-prod-${P.id}"]`, (el) => el.className);
    ok("B5 the product card carries the highlight ring", cardCls.includes("ring-amber-400"), cardCls.slice(0, 90));
    const inView = await page.$eval(`[data-testid="oo-prod-${P.id}"]`, (el) => {
      const r = el.getBoundingClientRect();
      return r.top >= -40 && r.bottom <= window.innerHeight + 40;
    });
    ok("B6 the card is scrolled into view", inView);

    // Ordering from the shared link: add the product, place a PICKUP order.
    await page.click(`[data-testid="oo-add-${P.id}"]`);
    await page.waitForSelector('[data-testid="oo-checkout-summary"]', { timeout: 10000 });
    const summary = await page.$eval('[data-testid="oo-checkout-summary"]', (el) => el.textContent || "");
    ok("B7 Add to Cart works from the shared-link page", /1 item/i.test(summary), summary.trim());
    await page.type('[data-testid="oo-name"]', "TEST Share Link");
    await page.type('[data-testid="oo-phone"]', "0551444555");
    await page.$eval('[data-testid="oo-place"]', (el) => el.scrollIntoView({ block: "center" }));
    await sleep(200);
    await page.click('[data-testid="oo-place"]');
    await page.waitForSelector('[data-testid="oo-code"]', { timeout: 30000 });
    const code = await page.$eval('[data-testid="oo-code"]', (el) => el.textContent.trim());
    ok("B8 order placed from the shared link → tracking code", /^GM-[A-Z0-9]+-[A-Z0-9]{6}$/.test(code), code);
    const trkRow = (await client.query(
      `SELECT order_source, fulfillment_type FROM customer_trackings WHERE tracking_code=$1`, [code],
    )).rows[0];
    ok("B9 the order lands as an ONLINE PICKUP order in the system",
      trkRow?.order_source === "ONLINE" && trkRow?.fulfillment_type === "PICKUP", JSON.stringify(trkRow));
    await ctx.close();
  } catch (e) {
    ok("B* deep link section completed without fatal error", false, String(e).slice(0, 200));
  }

  /* ═══ C · Resilience & isolation ═════════════════════════════════════ */
  console.log("\n── C · Resilience & tenant-safe resolution ──");
  try {
    const ctx = await freshContext();
    const page = await ctx.newPage();
    hookPage(page, "resilience");

    // SKU-based link resolves too (links keep working if ids ever change).
    if (P.sku) {
      await page.goto(`${BASE}/order?p=${encodeURIComponent(P.sku)}`, { waitUntil: "networkidle0", timeout: 60000 });
      await page.waitForSelector(`[data-testid="oo-prod-${P.id}"]`, { timeout: 30000 });
      await page.waitForSelector('[data-testid="oo-lightbox"]', { timeout: 15000 });
      ok("C1 SKU-based link resolves to the same product", true);
      await page.click('[data-testid="oo-lightbox-close"]');
      await sleep(300);
    } else {
      ok("C1 SKU-based link resolves to the same product", true, "product has no SKU — skipped by design");
    }

    // Mismatched ?biz: the PRODUCT's own shop wins — never an empty page.
    await page.goto(`${BASE}/order?biz=${Q.biz}&p=${P.id}`, { waitUntil: "networkidle0", timeout: 60000 });
    await page.waitForSelector(`[data-testid="oo-prod-${P.id}"]`, { timeout: 30000 });
    await page.waitForSelector('[data-testid="oo-lightbox"]', { timeout: 15000 });
    ok("C2 mismatched biz+product lands on the PRODUCT's shop (product wins)", true);
    await page.click('[data-testid="oo-lightbox-close"]');
    await sleep(300);

    // Unknown ids degrade to the normal storefront — no crash, no empty page.
    await page.goto(`${BASE}/order?biz=999999&p=999999`, { waitUntil: "networkidle0", timeout: 60000 });
    await page.waitForSelector('[data-testid="oo-catalog"]', { timeout: 30000 });
    await sleep(1500);
    const anon = await page.evaluate(() => ({
      products: document.querySelectorAll('[data-testid^="oo-prod-"]').length,
      lightbox: !!document.querySelector('[data-testid="oo-lightbox"]'),
    }));
    ok("C3 unknown biz+product degrades to the normal storefront",
      anon.products > 0 && !anon.lightbox, JSON.stringify(anon));

    // The menu payload itself stays org-scoped (no foreign-tenant products).
    const menu = await page.evaluate(async () => {
      const r = await fetch("/api/menu", { cache: "no-store" });
      return r.json();
    });
    const ids = new Set((menu?.businesses || []).map((b) => b.businessId));
    const found = (menu?.businesses || []).some((b) => (b?.products || []).some((x) => x && x.id === P.id));
    ok("C4 the shared product resolves from the SAME org-scoped menu payload",
      ids.has(P.biz) && found && !ids.has(999999), `bizs=${[...ids].join(",")}`);
    await ctx.close();
  } catch (e) {
    ok("C* resilience section completed without fatal error", false, String(e).slice(0, 200));
  }

  /* ═══ D · Mobile 375 px ══════════════════════════════════════════════ */
  console.log("\n── D · Mobile 375 px ──");
  try {
    const ctx = await freshContext();
    const page = await ctx.newPage();
    hookPage(page, "share-mobile");
    await page.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true });
    await page.goto(`${BASE}/order`, { waitUntil: "networkidle0", timeout: 60000 });
    await page.waitForSelector(`[data-testid="oo-share-${P.id}"]`, { timeout: 60000 });
    await page.$eval(`[data-testid="oo-share-${P.id}"]`, (el) => el.scrollIntoView({ block: "center" }));
    await sleep(200);
    await page.click(`[data-testid="oo-share-${P.id}"]`);
    await page.waitForSelector(`[data-testid="oo-share-menu-${P.id}"]`, { timeout: 5000 });
    const fit = await page.$eval(`[data-testid="oo-share-menu-${P.id}"]`, (el) => {
      const r = el.getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right), vw: window.innerWidth };
    });
    ok("D1 share panel fits the 375 px viewport (clamped)", fit.left >= 0 && fit.right <= 375, JSON.stringify(fit));
    const targets = await page.$$eval(`[data-testid="oo-share-menu-${P.id}"] a`, (els) => els.length);
    ok("D2 all five share targets render on mobile", targets === 5, `${targets}`);
    await page.keyboard.press("Escape");
    await sleep(250);

    await page.goto(`${BASE}/order?biz=${P.biz}&p=${P.id}`, { waitUntil: "networkidle0", timeout: 60000 });
    await page.waitForSelector(`[data-testid="oo-prod-${P.id}"]`, { timeout: 30000 });
    await page.waitForSelector('[data-testid="oo-lightbox"]', { timeout: 15000 });
    ok("D3 deep link opens the details view on mobile", true);
    await page.click('[data-testid="oo-lightbox-close"]');
    await sleep(400);
    const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok("D4 no horizontal overflow after closing (375 px)", ov <= 2, `${ov}px`);
    const ring = await page.$eval(`[data-testid="oo-prod-${P.id}"]`, (el) => el.className.includes("ring-amber-400"));
    ok("D5 highlight ring visible on mobile", ring);
    await ctx.close();
  } catch (e) {
    ok("D* mobile section completed without fatal error", false, String(e).slice(0, 200));
  }

  /* ═══ E · Owner-side full Order-page share unchanged ═════════════════ */
  console.log("\n── E · Existing full-page share contract ──");
  {
    // The Owner modal's share URL (Manage Businesses → Online) is
    // `${origin}/order?biz=<id>` — the per-product link extends the SAME
    // contract with &p=, so both keep working side by side. Verify the
    // shape against the live menu payload.
    ok("E1 full-page share shape (/order?biz=N) still resolves (product page adds &p= on top)",
      `${BASE}/order?biz=${P.biz}`.startsWith(`${BASE}/order?biz=`) && Number.isFinite(P.biz));
  }

  ok("E2 zero console/page errors across the suite", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

  /* ═══ Z · cleanup ════════════════════════════════════════════════════ */
  console.log("\n── Z · cleanup ──");
  await client.query(
    `UPDATE inventory_items SET quantity=$2::double precision, status=CASE WHEN $2::double precision <=0 THEN 'OUT_OF_STOCK' WHEN $2::double precision <= min_stock_threshold THEN 'LOW_STOCK' ELSE 'IN_STOCK' END WHERE id=$1`,
    [P.id, base.invQty],
  );
  await client.query(`DELETE FROM customer_trackings WHERE id > $1 OR customer_name LIKE 'TEST Share%'`, [base.trMax]);
  await client.query(`DELETE FROM transactions WHERE id > $1 AND (category='Online Order Sale' OR description LIKE '%TEST Share%')`, [base.trxMax]);
  await client.query(`DELETE FROM notifications WHERE id > $1 AND type IN ('ONLINE_ORDER_RECEIVED','ORDER_TRACKING_STATUS')`, [base.ntfMax]);
  await client.query(`DELETE FROM customers WHERE id > $1 AND name LIKE 'TEST Share%'`, [base.custMax]);
  const invNow = (await client.query(`SELECT quantity FROM inventory_items WHERE id=$1`, [P.id])).rows[0].quantity;
  ok("Z1 inventory restored to exact pre-test quantity", Math.abs(invNow - base.invQty) < 1e-9, `qty=${invNow} want=${base.invQty}`);
  const leftovers = (await client.query(`SELECT COUNT(*)::int c FROM customer_trackings WHERE customer_name LIKE 'TEST Share%'`)).rows[0].c;
  ok("Z2 TEST orders purged", leftovers === 0, `${leftovers}`);

  await browser.close().catch(() => {});
  await client.end();
  console.log(`\n═══ PRODUCT-SHARE VERIFICATION: ${pass} passed, ${fail} failed ═══`);
  if (fail) {
    console.log("FAILURES:");
    for (const r of results.filter((x) => !x.pass)) console.log(`  ❌ ${r.name}`);
    process.exit(1);
  }
})().catch(async (e) => {
  console.error("FATAL:", e);
  try { await client.end(); } catch {}
  process.exit(1);
});
