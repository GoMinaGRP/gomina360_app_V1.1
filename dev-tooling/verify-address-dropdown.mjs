/**
 * verify-address-dropdown.mjs — the delivery ADDRESS AUTOCOMPLETE dropdown on
 * the customer order page must ALWAYS render ABOVE the map and stay fully
 * visible while the customer types.
 *
 * Checks (headless Chromium, real page, desktop + phone viewports):
 *   1. the suggestion list appears while typing;
 *   2. it is painted ON TOP of the map wherever they overlap — every sampled
 *      point inside the list hit-tests to the list (never a Leaflet tile /
 *      pane / control / iframe);
 *   3. no ancestor clips it (the full list rectangle is inside the viewport
 *      and inside every scroll/overflow ancestor);
 *   4. the map itself never covers the input;
 *   5. picking a suggestion still fills the field and moves the pin
 *      (functionality unchanged).
 *
 * Run:  LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-address-dropdown.mjs
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

async function openOrderPage(browser, viewport) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${BASE}/order`, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector('[data-testid="oo-catalog"]', { timeout: 30000 });
  return { page, errors };
}

/** Add the first product to the cart so the checkout section renders. */
async function addFirstProduct(page) {
  await page.waitForSelector('[data-testid^="oo-add-"]', { timeout: 20000 });
  await page.click('[data-testid^="oo-add-"]');
  await page.waitForSelector('[data-testid="oo-checkout"]', { timeout: 20000 });
}

async function chooseDelivery(page) {
  await page.waitForSelector('[data-testid="oo-delivery"]', { timeout: 20000 });
  await page.click('[data-testid="oo-delivery"]');
  await page.waitForSelector('[data-testid="oo-delivery-block"]', { timeout: 20000 });
  // Leaflet needs a tick to mount its panes.
  await new Promise((r) => setTimeout(r, 1500));
}

async function typeAddress(page, text) {
  const input = '[data-testid="oo-dest-input"]';
  await page.waitForSelector(input, { timeout: 20000 });
  await page.click(input);
  await page.type(input, text, { delay: 25 });
  await page.waitForSelector('[data-testid="oo-dest-list"]', { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 400));
}

/**
 * Hit-test a grid of points inside the dropdown: whatever the browser says is
 * the topmost element at each point must belong to the dropdown, never to the
 * map. This is the real "is the map covering my suggestions?" test.
 */
async function inspectOverlap(page) {
  return page.evaluate(() => {
    const list = document.querySelector('[data-testid="oo-dest-list"]');
    const input = document.querySelector('[data-testid="oo-dest-input"]');
    const mapRoot = document.querySelector('[data-testid="oo-pin-root"]');
    if (!list || !input) return { error: "missing list/input" };
    const lr = list.getBoundingClientRect();
    const ir = input.getBoundingClientRect();
    const mr = mapRoot ? mapRoot.getBoundingClientRect() : null;

    const isMapish = (el) =>
      !!el &&
      !!el.closest(
        '.leaflet-container, .leaflet-pane, .leaflet-control-container, [data-testid="oo-pin-root"], iframe',
      );
    const inList = (el) => !!el && !!el.closest('[data-testid="oo-dest-list"]');

    const bad = [];
    const rows = 8;
    const cols = 5;
    let sampled = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = lr.left + ((c + 0.5) * lr.width) / cols;
        const y = lr.top + ((r + 0.5) * lr.height) / rows;
        if (y < 0 || y > window.innerHeight || x < 0 || x > window.innerWidth) continue;
        sampled++;
        const top = document.elementFromPoint(x, y);
        if (!inList(top)) {
          bad.push({
            x: Math.round(x),
            y: Math.round(y),
            tag: top ? top.tagName : "none",
            cls: top ? String(top.className).slice(0, 80) : "",
            mapish: isMapish(top),
          });
        }
      }
    }

    // Clipping: walk up the ancestor chain and make sure no scroll container
    // cuts the list rectangle off.
    const clippers = [];
    let node = list.parentElement;
    while (node && node !== document.body) {
      const cs = getComputedStyle(node);
      const clips = ["hidden", "clip", "auto", "scroll"].some(
        (v) => cs.overflow === v || cs.overflowY === v || cs.overflowX === v,
      );
      if (clips) {
        const nr = node.getBoundingClientRect();
        const cut =
          lr.top < nr.top - 0.5 ||
          lr.bottom > nr.bottom + 0.5 ||
          lr.left < nr.left - 0.5 ||
          lr.right > nr.right + 0.5;
        clippers.push({
          testid: node.getAttribute("data-testid") || null,
          cls: String(node.className).slice(0, 70),
          overflow: `${cs.overflow}/${cs.overflowX}/${cs.overflowY}`,
          cut,
        });
      }
      node = node.parentElement;
    }

    // Does the map cover the INPUT itself?
    const inputCovered = (() => {
      const pts = [
        [ir.left + 12, ir.top + ir.height / 2],
        [ir.left + ir.width / 2, ir.top + ir.height / 2],
        [ir.right - 30, ir.top + ir.height / 2],
      ];
      return pts.some(([x, y]) => {
        if (y < 0 || y > window.innerHeight) return false;
        const el = document.elementFromPoint(x, y);
        return isMapish(el);
      });
    })();

    const cs = getComputedStyle(list);
    return {
      listRect: { top: lr.top, bottom: lr.bottom, left: lr.left, right: lr.right, w: lr.width, h: lr.height },
      inputRect: { top: ir.top, bottom: ir.bottom, h: ir.height },
      mapRect: mr ? { top: mr.top, bottom: mr.bottom } : null,
      overlapsMap: mr ? !(lr.bottom <= mr.top || lr.top >= mr.bottom) : false,
      position: cs.position,
      zIndex: cs.zIndex,
      sampled,
      bad,
      clippers,
      inputCovered,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      inViewport: lr.top >= -0.5 && lr.bottom <= window.innerHeight + 0.5,
      optionCount: list.querySelectorAll('[data-testid^="oo-dest-opt-"]').length,
    };
  });
}

async function run() {
  const browser = await puppeteer.launch({
    executablePath: "/tmp/al2023/chromium",
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    for (const vp of [
      { label: "desktop 1280×800", viewport: { width: 1280, height: 800 } },
      { label: "phone 390×740", viewport: { width: 390, height: 740, isMobile: true, hasTouch: true } },
      { label: "short 1024×560", viewport: { width: 1024, height: 560 } },
    ]) {
      const { page, errors } = await openOrderPage(browser, vp.viewport);
      await addFirstProduct(page);
      await chooseDelivery(page);
      await typeAddress(page, "Accra");

      const info = await inspectOverlap(page);
      if (info.error) {
        ok(`[${vp.label}] dropdown inspected`, false, info.error);
        await page.close();
        continue;
      }

      console.log(
        `   ${vp.label}: list ${Math.round(info.listRect.top)}→${Math.round(info.listRect.bottom)} ` +
          `map ${info.mapRect ? Math.round(info.mapRect.top) + "→" + Math.round(info.mapRect.bottom) : "n/a"} ` +
          `pos=${info.position} z=${info.zIndex} opts=${info.optionCount} overlapsMap=${info.overlapsMap}`,
      );

      ok(`[${vp.label}] suggestions render while typing`, info.optionCount > 0, `options=${info.optionCount}`);
      ok(
        `[${vp.label}] map never covers the suggestions`,
        info.bad.length === 0,
        `${info.bad.length}/${info.sampled} sample points hit ${JSON.stringify(info.bad.slice(0, 3))}`,
      );
      ok(
        `[${vp.label}] nothing clips the dropdown`,
        info.clippers.every((c) => !c.cut),
        JSON.stringify(info.clippers.filter((c) => c.cut)),
      );
      ok(`[${vp.label}] dropdown fully inside the viewport`, info.inViewport,
        `top=${Math.round(info.listRect.top)} bottom=${Math.round(info.listRect.bottom)} vh=${info.viewport.h}`);
      ok(`[${vp.label}] map never covers the address input`, !info.inputCovered);
      ok(`[${vp.label}] zero page errors`, errors.length === 0, errors.slice(0, 2).join(" | "));

      // Functionality unchanged: picking a suggestion fills the field + pins.
      if (info.optionCount > 0) {
        await page.click('[data-testid="oo-dest-opt-0"]');
        await new Promise((r) => setTimeout(r, 900));
        const after = await page.evaluate(() => ({
          value: document.querySelector('[data-testid="oo-dest-input"]')?.value || "",
          coords: document.querySelector('[data-testid="oo-pin-coords"]')?.textContent?.trim() || "",
          listGone: !document.querySelector('[data-testid="oo-dest-list"]'),
        }));
        ok(`[${vp.label}] picking a suggestion fills the address`, after.value.length > 3, after.value);
        ok(
          `[${vp.label}] picking a suggestion drops the pin`,
          /\d+\.\d+,\s*-?\d+\.\d+/.test(after.coords),
          after.coords,
        );
        ok(`[${vp.label}] dropdown closes after picking`, after.listGone);
      }

      await page.close();
    }

    // Scroll robustness: the dropdown must stay glued to the input and above
    // the map after the page scrolls while it is open.
    {
      const { page } = await openOrderPage(browser, { width: 1280, height: 800 });
      await addFirstProduct(page);
      await chooseDelivery(page);
      await typeAddress(page, "Accra");
      await page.evaluate(() => window.scrollBy(0, 120));
      await new Promise((r) => setTimeout(r, 350));
      const info = await inspectOverlap(page);
      if (!info.error) {
        ok("[scrolled] dropdown still anchored to the input",
          Math.abs(info.listRect.top - info.inputRect.bottom) < 24 ||
            Math.abs(info.listRect.bottom - info.inputRect.top) < 24,
          `list.top=${Math.round(info.listRect.top)} input.bottom=${Math.round(info.inputRect.bottom)}`);
        ok("[scrolled] map still never covers the suggestions", info.bad.length === 0,
          JSON.stringify(info.bad.slice(0, 3)));
      } else {
        ok("[scrolled] dropdown inspected", false, info.error);
      }
      await page.close();
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
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
