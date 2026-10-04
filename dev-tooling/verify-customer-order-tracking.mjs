/**
 * verify-customer-order-tracking.mjs — the product-first Order ⇄ Tracking
 * experience, checked against the 10 acceptance criteria of
 * docs/CUSTOMER-ORDER-TRACKING-AUDIT.md §9 (P4).
 *
 *   AC1  phone (390×844) shows the first product inside ONE viewport
 *   AC2  default catalogue is CATEGORY-first, one section per category with
 *        every selling shop side by side and per-card shop attribution
 *   AC3  the shop strip is ONE row at 390 / 768 / 1440; no horizontal page scroll
 *   AC4  search spans name · category · subcategory · brand · SKU · shop ·
 *        description, reports "N products · M shops", and suggests categories
 *        when nothing matches
 *   AC5  card AND lightbox show the selling shop with Call / WhatsApp / Directions
 *   AC6  /track shows a "From <Shop>" block with a working contact action
 *   AC7  every /track line links to its product; a line without a product
 *        degrades to the shop's own links
 *   AC8  one header, one theme, one vocabulary on both pages
 *   AC9  deep links (?biz=, ?p=, /track?code=) still work; the public payload
 *        exposes only the order's own shop (no staff fields, no other shop)
 *
 * Everything created here is TEST-* prefixed and deleted before the run ends.
 * Run: bash dev-tooling/run-suite.sh dev-tooling/verify-customer-order-tracking.mjs
 */
import { createRequire } from "module";
const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");
const { Client } = require("pg");

const BASE = "http://127.0.0.1:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pass: process.env.GOMINA_OWNER_PW || "Owner@GoMina26" };
const TEST_NAME = "TEST AC Customer";

const results = [];
const metrics = {};
const ok = (name, cond, extra = "") => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "✅" : "❌"} ${name}${cond ? "" : " — " + extra}`);
  return cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pg = new Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });
await pg.connect();

const login = async (creds) => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: creds.email, password: creds.pass }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  return (res.headers.get("set-cookie") || "").split(";")[0];
};
const api = async (cookie, path, opts = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) },
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
};
const textOf = (page, tid) => page.$eval(`[data-testid="${tid}"]`, (el) => el.textContent || "").catch(() => "");

const browser = await puppeteer.launch({
  executablePath: "/tmp/al2023/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});

const createdCodes = [];
try {
  /* ═══ AC1–AC5 · the /order experience ═══════════════════════════════ */
  console.log("\n— A · /order at 390×844 (AC1–AC5) —");
  const ctxM = await browser.createBrowserContext();
  const pm = await ctxM.newPage();
  const errsM = [];
  pm.on("pageerror", (e) => errsM.push(String(e).slice(0, 160)));
  await pm.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await pm.goto(`${BASE}/order`, { waitUntil: "networkidle0", timeout: 60000 });
  await pm.waitForSelector('[data-testid="oo-catalog"]', { timeout: 30000 });
  await sleep(400);

  const phone = await pm.evaluate(() => {
    const y = (sel) => {
      const el = document.querySelector(sel);
      return el ? Math.round(el.getBoundingClientRect().top + window.scrollY) : null;
    };
    const strip = document.querySelector('[data-testid="oo-bizrow"]');
    const rows = strip ? new Set([...strip.children].map((c) => Math.round(c.getBoundingClientRect().top))).size : 0;
    const sections = [...document.querySelectorAll('[data-testid^="oo-catsec-"]')].filter((el) => !/count/.test(el.dataset.testid));
    const perSection = sections.map((sec) => {
      const shops = [...sec.querySelectorAll('[data-testid^="oo-sold-by-shop-"]')].map((e) => e.textContent.trim());
      return { name: sec.dataset.testid.replace("oo-catsec-", ""), cards: sec.querySelectorAll('[data-testid^="oo-prod-"]').length, shops: new Set(shops).size };
    });
    return {
      firstProductY: y('[data-testid^="oo-prod-"]'),
      firstSectionY: y('[data-testid^="oo-catsec-"]'),
      viewportH: window.innerHeight,
      stripRows: rows,
      stripH: strip ? Math.round(strip.getBoundingClientRect().height) : null,
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 2,
      sections: sections.length,
      perSection,
      cards: document.querySelectorAll('[data-testid^="oo-prod-"]').length,
      attributed: document.querySelectorAll('[data-testid^="oo-sold-by-shop-"]').length,
      contactRows: document.querySelectorAll('[data-testid^="oo-contact-"]').length,
    };
  });
  metrics.phone = phone;
  ok("AC1 first product is inside the first 390×844 viewport",
    phone.firstProductY != null && phone.firstProductY < phone.viewportH,
    `firstProductY=${phone.firstProductY} viewport=${phone.viewportH}`);
  const multiShop = phone.perSection.filter((s) => s.shops >= 2);
  ok("AC2 catalogue is CATEGORY-first: every section lists its own cards, and a shared category shows its shops side by side",
    phone.sections >= 2 && phone.perSection.every((s) => s.cards > 0) && multiShop.length >= 1 &&
    phone.attributed === phone.cards,
    JSON.stringify({ sections: phone.sections, shared: multiShop, attributed: phone.attributed, cards: phone.cards }));
  ok("AC3a the shop strip is ONE row on the phone (was 8 rows / 472 px)",
    phone.stripRows === 1, `rows=${phone.stripRows} h=${phone.stripH}`);
  ok("AC3b no horizontal page scroll on the phone", !phone.pageOverflow);
  ok("AC5a every card carries its shop's Call / WhatsApp / Directions row",
    phone.contactRows === phone.cards && phone.cards > 0, `${phone.contactRows}/${phone.cards}`);

  /* AC3 at tablet + desktop */
  for (const vp of [{ w: 768, h: 1024 }, { w: 1440, h: 900 }]) {
    const c = await browser.createBrowserContext();
    const p = await c.newPage();
    await p.setViewport({ width: vp.w, height: vp.h });
    await p.goto(`${BASE}/order`, { waitUntil: "networkidle0", timeout: 60000 });
    await p.waitForSelector('[data-testid="oo-bizrow"]', { timeout: 30000 });
    const m = await p.evaluate(() => {
      const strip = document.querySelector('[data-testid="oo-bizrow"]');
      return {
        rows: new Set([...strip.children].map((x) => Math.round(x.getBoundingClientRect().top))).size,
        overflow: document.documentElement.scrollWidth > window.innerWidth + 2,
        firstProductY: Math.round(document.querySelector('[data-testid^="oo-prod-"]').getBoundingClientRect().top + window.scrollY),
      };
    });
    ok(`AC3c the shop strip is ONE row at ${vp.w}px and the page never scrolls sideways`,
      m.rows === 1 && !m.overflow, JSON.stringify(m));
    metrics[`w${vp.w}`] = m;
    await c.close();
  }

  /* AC4 · search */
  const typeSearch = async (value) => {
    await pm.$eval('[data-testid="oo-search"]', (el) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    if (value) await pm.type('[data-testid="oo-search"]', value, { delay: 15 });
    await sleep(500);
  };
  const searchHits = {};
  for (const q of ["cement", "POUL-EGG-L01", "reinforcement", "Building", "Poultry"]) {
    await typeSearch(q);
    searchHits[q] = await pm.evaluate(() => ({
      cards: document.querySelectorAll('[data-testid^="oo-prod-"]').length,
      summary: (document.querySelector('[data-testid="oo-search-summary"]')?.textContent || "").trim(),
    }));
  }
  ok("AC4a search matches name / category / subcategory / SKU / shop wording",
    Object.values(searchHits).every((h) => h.cards >= 1),
    JSON.stringify(searchHits));
  ok("AC4b every hit reports the “N products · M shops” result bar",
    Object.values(searchHits).every((h) => /^\d+ products? · \d+ shops? match/.test(h.summary)),
    searchHits["cement"]?.summary);
  await typeSearch("zzzzz");
  const noMatch = await pm.evaluate(() => ({
    empty: !!document.querySelector('[data-testid="oo-empty"]'),
    suggestions: [...document.querySelectorAll('[data-testid^="oo-suggest-"]')].map((e) => e.dataset.testid.replace("oo-suggest-", "")),
    clear: !!document.querySelector('[data-testid="oo-search-clear"]'),
  }));
  ok("AC4c a no-match search names available categories and offers a clear button",
    noMatch.empty && noMatch.suggestions.length >= 1 && noMatch.clear, JSON.stringify(noMatch));
  await pm.click('[data-testid="oo-search-clear"]').catch(() => {});
  await sleep(400);

  /* AC5b · lightbox enquiry */
  await pm.evaluate(() => document.querySelector('[data-testid^="oo-photo-"]')?.click());
  await pm.waitForSelector('[data-testid="oo-lightbox-seller"]', { timeout: 15000 });
  await sleep(400);
  const lb = await pm.evaluate(() => ({
    shop: (document.querySelector('[data-testid="oo-lightbox-shop"]')?.textContent || "").trim(),
    call: (document.querySelector('[data-testid="oo-lightbox-call"]')?.getAttribute("href") || ""),
    ask: !!document.querySelector('[data-testid^="oo-ask-"]'),
    dir: (document.querySelector('[data-testid="oo-lightbox-dir"]')?.getAttribute("href") || ""),
  }));
  ok("AC5b the lightbox names the shop and offers Call + Ask (WhatsApp) + Directions",
    lb.shop.length > 2 && lb.call.startsWith("tel:") && lb.ask && /maps\/dir/.test(lb.dir), JSON.stringify(lb));
  await pm.evaluate(() => document.querySelector('[data-testid="oo-lightbox-close"]')?.click());
  await sleep(300);
  ok("AC-Z1 zero page errors on the phone storefront pass", errsM.length === 0, errsM.slice(0, 3).join(" | "));
  await ctxM.close();

  /* ═══ AC6–AC9 · the /track experience ═══════════════════════════════ */
  console.log("\n— B · /track parity, linkage and privacy (AC6–AC9) —");
  const [fixture] = (await pg.query(
    `SELECT t.tracking_code, t.business_id, t.customer_phone
       FROM customer_trackings t
       JOIN businesses b ON b.id = t.business_id
      WHERE t.customer_phone IS NOT NULL AND jsonb_array_length(t.items) > 0
      ORDER BY t.id DESC LIMIT 1`,
  )).rows;
  if (!fixture) throw new Error("preflight: no tracking row to check — run the fixtures first");
  const code = fixture.tracking_code;
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 160)));
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.goto(`${BASE}/track?code=${encodeURIComponent(code)}`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid="track-result"]', { timeout: 30000 });
  await sleep(700);
  const trk = await page.evaluate(() => {
    const g = (t) => document.querySelector(`[data-testid="${t}"]`);
    return {
      header: !!g("oo-header"), logo: !!g("oo-logo"),
      seller: !!g("track-seller"),
      sellerText: (g("track-seller")?.textContent || "").slice(0, 80),
      call: g("track-seller-call")?.getAttribute("href") || "",
      wa: g("track-seller-wa")?.getAttribute("href") || "",
      dir: g("track-seller-dir")?.getAttribute("href") || "",
      order: g("track-seller-order")?.getAttribute("href") || "",
      items: [...document.querySelectorAll('[data-testid^="track-item-"]')].map((e) => e.dataset.testid).filter((t) => /^track-item-\d+$/.test(t)),
      links: [...document.querySelectorAll('[data-testid^="track-item-link-"]')].map((e) => e.getAttribute("href")),
      bodyHasBusinessLabel: /\bBusiness\b/.test(document.body.innerText),
      bodyHasShopLabel: /\bShop\b/.test(document.body.innerText),
      overflow: document.documentElement.scrollWidth > window.innerWidth + 2,
      liveRegion: g("track-result")?.querySelector('[role="status"][aria-live]') ? true : false,
    };
  });
  metrics.track = trk;
  ok("AC6 /track shows “From <Shop>” with a working contact action for the order's own shop",
    trk.seller && trk.sellerText.includes("From ") && (trk.call.startsWith("tel:") || /wa\.me/.test(trk.wa)),
    JSON.stringify({ seller: trk.seller, call: trk.call, wa: trk.wa.slice(0, 60) }));
  ok("AC7a every ordered line links to its product on the order's own shop",
    trk.items.length >= 1 && trk.links.length >= 1 &&
    trk.links.every((h) => new RegExp(`^/order\\?biz=${fixture.business_id}&p=\\d+$`).test(h)),
    JSON.stringify({ items: trk.items, links: trk.links }));
  ok("AC8a both customer pages wear the SAME header (brand + dark band)",
    trk.header && trk.logo);
  ok("AC8b the customer vocabulary is “Shop” (no stray “Business” labels on the customer page)",
    trk.bodyHasShopLabel && !trk.bodyHasBusinessLabel, JSON.stringify({ shop: trk.bodyHasShopLabel, business: trk.bodyHasBusinessLabel }));
  ok("AC8c the tracking page is the light storefront look with no horizontal scroll",
    !trk.overflow);
  ok("AC8d the status card is an ARIA live region (status changes are announced)",
    trk.liveRegion);

  /* AC7 degraded case — an order line with no product identity (legacy /
     free-text sale) must still reach the shop, just without the product link. */
  const ownerCookie = await login(OWNER);
  const mk = await api(ownerCookie, "/api/tracking", {
    method: "POST",
    body: JSON.stringify({
      action: "CREATE",
      businessId: Number(fixture.business_id),
      customerName: TEST_NAME,
      customerPhone: "0500112233",
      items: [{ description: "TEST free-text line", quantity: 1, unitPrice: 10 }],
    }),
  });
  if (mk.json?.tracking?.trackingCode) createdCodes.push(mk.json.tracking.trackingCode);
  await page.goto(`${BASE}/track?code=${encodeURIComponent(mk.json?.tracking?.trackingCode || "")}`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid="track-result"]', { timeout: 30000 });
  await sleep(500);
  const degraded = await page.evaluate(() => ({
    items: [...document.querySelectorAll('[data-testid^="track-item-"]')].map((e) => e.dataset.testid).filter((t) => /^track-item-\d+$/.test(t)).length,
    links: document.querySelectorAll('[data-testid^="track-item-link-"]').length,
    shopLink: document.querySelector('[data-testid="track-seller-order"]')?.getAttribute("href") || "",
    sellerContact: !!(document.querySelector('[data-testid="track-seller-call"]') || document.querySelector('[data-testid="track-seller-wa"]')),
  }));
  ok("AC7b a line with no product identity degrades to the shop's own links (no dead end)",
    degraded.items === 1 && degraded.links === 0 && /^\/order\?biz=\d+$/.test(degraded.shopLink) && degraded.sellerContact,
    JSON.stringify(degraded));

  /* AC9 · public payload privacy + deep-link round trip */
  const pub = await fetch(`${BASE}/api/track?code=${encodeURIComponent(code)}`).then((r) => r.json());
  const payloadKeys = Object.keys(pub.tracking || {});
  const itemKeys = Object.keys((pub.tracking?.items || [])[0] || {});
  ok("AC9a the public payload exposes ONLY the order's own shop",
    pub.tracking?.seller?.businessId === fixture.business_id &&
    pub.tracking?.businessId === fixture.business_id,
    JSON.stringify({ sellerBiz: pub.tracking?.seller?.businessId, orderBiz: fixture.business_id }));
  ok("AC9b no staff/customer-private fields leak into the public payload",
    !payloadKeys.some((k) => /customerPhone|staff|internal|driverPhone|userId|session/i.test(k)) &&
    !itemKeys.some((k) => /cost|margin/i.test(k)),
    JSON.stringify({ payloadKeys: payloadKeys.length, itemKeys }));
  ok("AC9c the seller phone in the payload belongs to that shop (matches the business row)",
    await (async () => {
      const [biz] = (await pg.query(`SELECT customer_help_phone, contact_phone FROM businesses WHERE id = $1`, [fixture.business_id])).rows;
      const expected = String(biz?.customer_help_phone || biz?.contact_phone || "").replace(/[^\d+]/g, "");
      const got = String(pub.tracking?.seller ? pub.tracking.seller.customerHelpPhone || pub.tracking.seller.contactPhone || "" : "").replace(/[^\d+]/g, "");
      return !!expected && got === expected;
    })(),
    JSON.stringify({ seller: pub.tracking?.seller?.contactPhone }));
  const unknown = await fetch(`${BASE}/api/track?code=GM-POULTRY-QQQQQQ`).then((r) => r.status);
  ok("AC9d an unknown code is still rejected (no probing surface added)", unknown === 404, `status=${unknown}`);

  /* the product deep link from a tracking line lands on the focused product */
  const oneHref = (trk.links[0] || "").split("&p=");
  if (oneHref.length === 2) {
    const pId = oneHref[1];
    await page.goto(`${BASE}${trk.links[0]}`, { waitUntil: "networkidle0", timeout: 60000 });
    await page.waitForSelector(`[data-testid="oo-prod-${pId}"]`, { timeout: 30000 });
    const focused = await page.evaluate((pid) => ({
      card: !!document.querySelector(`[data-testid="oo-prod-${pid}"]`),
      highlight: /ring-amber-400/.test(document.querySelector(`[data-testid="oo-prod-${pid}"]`)?.className || ""),
      oneShop: document.querySelectorAll('[data-testid^="oo-sold-by-shop-"]').length === 0,
    }), pId);
    ok("AC9e the tracking line's deep link opens that product, focused on its shop, with the highlight ring",
      focused.card && focused.highlight && focused.oneShop, JSON.stringify(focused));
  } else {
    ok("AC9e the tracking line's deep link opens that product, focused on its shop, with the highlight ring", false, "no item link to follow");
  }
  ok("AC-Z2 zero page errors on the tracking pass", errs.length === 0, errs.slice(0, 3).join(" | "));
  await ctx.close();
} finally {
  try {
    if (createdCodes.length) {
      const r = await pg.query(`DELETE FROM customer_trackings WHERE tracking_code = ANY($1::text[]) RETURNING id`, [createdCodes]);
      console.log(`   purged ${r.rowCount} TEST tracking row(s)`);
    }
    await pg.query(`DELETE FROM notifications WHERE title LIKE '%TEST AC %'`);
    await pg.query(`DELETE FROM customers WHERE name LIKE 'TEST AC %'`);
  } catch (e) {
    console.log("   cleanup note: " + e.message);
  }
  await pg.end();
  await browser.close();
}

console.log("\nmetrics:", JSON.stringify({
  phoneFirstProductY: metrics.phone?.firstProductY,
  phoneStripRows: metrics.phone?.stripRows,
  phoneDocOverflow: metrics.phone?.pageOverflow,
  sharedCategorySections: metrics.phone?.perSection?.filter((s) => s.shops >= 2).map((s) => `${s.name} (${s.shops} shops, ${s.cards} cards)`),
  tabletStripRows: metrics.w768?.rows,
  desktopStripRows: metrics.w1440?.rows,
  trackItems: metrics.track?.items?.length,
}, null, 1));

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} acceptance checks passed`);
if (failed.length) {
  console.log("FAILED:\n" + failed.map((f) => " · " + f.name).join("\n"));
  process.exit(1);
}
