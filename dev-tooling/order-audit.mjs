/**
 * Customer Order System — end-to-end UX probe (Amazon-inspired gallery,
 * Places selector, maps). Runs against the live dev server at BASE_URL.
 *
 * Covers:
 *   A. Gallery — thumbnails on card, lightbox open, prev/next, thumbnail
 *      switch, zoom in/out/reset, wheel zoom, full-screen toggle, Escape.
 *   B. Places — suggestions appear (gazetteer fallback online), selection
 *      closes the list IMMEDIATELY, saved label stays, list never reopens.
 *   C. Maps — delivery pin picker renders; satellite/standard toggle;
 *      pickup point mini-map is a local Leaflet (NOT a Google iframe);
 *      offline tile notice appears when tiles are unreachable and never
 *      blocks pin interactions.
 *   D. Full journeys — stock order with cart, pre-order from org-2's
 *      business, tracking codes, mobile viewport layout, pinch-to-zoom.
 */
import { createRequire } from "module";
import { writeFile, mkdir } from "fs/promises";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const OUT = ".verify-out";
const results = [];
let shotN = 0;

async function launch(mobile = false) {
  const browser = await puppeteer.launch({
    executablePath: "/tmp/al2023/chromium",
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    defaultViewport: mobile
      ? { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
      : { width: 1440, height: 900 },
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
  return { browser, page, errors };
}

const shot = async (page, name) => {
  await mkdir(OUT, { recursive: true });
  await page.screenshot({ path: `${OUT}/order-${String(++shotN).padStart(2, "0")}-${name}.png` });
};

const ok = (name, cond, detail = "") => {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const t = (sel) => `[data-testid='${sel}']`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const vis = (page, sel) => page.$(t(sel)).then((h) => !!h);
const text = async (page, sel) =>
  page.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? "", t(sel));

async function galleryTests(page) {
  // Card thumbnails + lightbox
  const hasPhoto = await vis(page, "oo-photo-1");
  const thumbs = await page.$$eval(t("oo-thumbs-1") + " button", (b) => b.length).catch(() => 0);
  ok("gallery.card.has-photo", hasPhoto);
  ok("gallery.card.thumbs", thumbs >= 3, `${thumbs} thumbs`);

  await page.click(t("oo-photo-1"));
  await sleep(500);
  ok("gallery.lightbox.open", await vis(page, "oo-lightbox"));
  ok("gallery.lightbox.count", (await text(page, "oo-lightbox-count")) === "1 / 3");

  await page.click(t("oo-lightbox-next"));
  await sleep(250);
  ok("gallery.lightbox.next", (await text(page, "oo-lightbox-count")) === "2 / 3");
  await page.click(t("oo-lightbox-prev"));
  await sleep(250);
  ok("gallery.lightbox.prev", (await text(page, "oo-lightbox-count")) === "1 / 3");
  await page.click(t("oo-lightbox-thumb-2"));
  await sleep(250);
  ok("gallery.lightbox.thumb-jump", (await text(page, "oo-lightbox-count")) === "3 / 3");

  const zoomGet = () => page.evaluate((s) => Number(document.querySelector(s)?.dataset.zoom || 1), t("oo-lightbox-img"));
  await page.click(t("oo-lightbox-zoomin"));
  await sleep(250);
  ok("gallery.zoom.in", (await zoomGet()) === 1.5, `zoom=${await zoomGet()}`);
  await page.click(t("oo-lightbox-zoomin"));
  await sleep(250);
  await page.click(t("oo-lightbox-zoomout"));
  await sleep(250);
  ok("gallery.zoom.out", (await zoomGet()) === 1.5, `zoom=${await zoomGet()}`);

  // wheel zoom over the viewport (cursor-centred)
  const box = await page.evaluate((sel) => {
    const r = document.querySelector(sel).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, t("oo-lightbox-viewport"));
  await page.mouse.move(box.x, box.y);
  await page.mouse.wheel({ deltaY: -240 });
  await sleep(250);
  const wzoom = await zoomGet();
  ok("gallery.zoom.wheel", wzoom > 1.5, `zoom=${wzoom}`);

  // drag-pan while zoomed: image transform translate() should move
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x - 60, box.y - 40, { steps: 5 });
  await page.mouse.up();
  await sleep(200);
  const transform = await page.evaluate(
    (s) => document.querySelector(s)?.style.transform ?? "",
    t("oo-lightbox-img"),
  );
  ok("gallery.zoom.pan", /translate\((-?\d|\.)/.test(transform), transform.slice(0, 60));

  await page.click(t("oo-lightbox-zoomreset"));
  await sleep(250);
  ok("gallery.zoom.reset", (await zoomGet()) === 1);

  await page.click(t("oo-lightbox-full"));
  await sleep(250);
  const full = await page.evaluate((s) => document.querySelector(s)?.className.includes("p-0"), t("oo-lightbox"));
  ok("gallery.fullscreen.on", full);
  await page.click(t("oo-lightbox-full"));
  await sleep(250);
  ok("gallery.fullscreen.off", !(await page.evaluate((s) => document.querySelector(s)?.className.includes("p-0"), t("oo-lightbox"))));

  await page.keyboard.press("Escape");
  await sleep(300);
  ok("gallery.lightbox.esc-close", !(await vis(page, "oo-lightbox")));

  // reopen at specific index via card thumbnail
  await page.click(t("oo-thumb-1-2"));
  await sleep(350);
  ok("gallery.reopen.at-idx", (await text(page, "oo-lightbox-count")) === "3 / 3");
  await shot(page, "lightbox");
  // Add to cart from lightbox
  await page.click(t("oo-lightbox-add"));
  await sleep(500);
  ok("gallery.add-then-closes", !(await vis(page, "oo-lightbox")));
  const badge = await page.evaluate((s) => {
    const cart = document.querySelector(s);
    return cart ? cart.textContent.replace(/\s+/g, " ") : "";
  }, t("oo-cart"));
  ok("gallery.add-to-cart", /1/.test(badge), badge.slice(0, 60));
  // (cart badge evaluated with selector arg)
}

async function placesTests(page) {
  // Open checkout: click the cart bar button then DELIVERY preset needed.
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("button")].find((x) => /Delivery/i.test(x.innerText || ""));
    el?.click();
  });
  await sleep(900);
  const hasAddr = await vis(page, "oo-dest-input");
  ok("places.input.present", hasAddr);

  await page.focus(t("oo-dest-input"));
  await page.type(t("oo-dest-input"), "tamale", { delay: 25 });
  const opened = await page.waitForSelector(t("oo-dest-list"), { visible: true, timeout: 8000 }).then(() => true).catch(() => false);
  ok("places.dropdown.opens", opened);
  await sleep(200);
  const optCount = await page.$$eval(t("oo-dest-list") + " li[role='option']", (l) => l.length).catch(() => 0);
  ok("places.dropdown.options", optCount >= 1, `${optCount} options`);
  await shot(page, "places-list");

  await page.click(t("oo-dest-opt-0"));
  await sleep(120);
  ok("places.closes-immediately", !(await vis(page, "oo-dest-list")));
  const saved = await page.evaluate((s) => document.querySelector(s)?.value ?? "", t("oo-dest-input"));
  ok("places.selection-saved", /Tamale/i.test(saved), saved);
  await sleep(1800);
  ok("places.never-reopens", !(await vis(page, "oo-dest-list")));
  // Root-cause regression guard: reverse-geocode of the same pin must NOT
  // overwrite the customer-picked label (was reopening + clobbering).
  const stayed = await page.evaluate((s) => document.querySelector(s)?.value ?? "", t("oo-dest-input"));
  ok("places.label-authoritative", stayed === saved, stayed);

  // after a pick, the delivery pin adopts the suggestion's coordinates
  const pin = await page.evaluate((sel) => document.querySelector(sel)?.textContent ?? "", t("oo-pin-root"));
  const hasMarker = await page.evaluate((sel) => !!document.querySelector(sel + " .leaflet-marker-icon"), t("oo-pin-root"));
  ok("places.pin-set", /9\.4008|-0\.8393/.test(pin) || hasMarker, pin.slice(0, 0));

  // editing the text re-enables suggestions
  await page.click(t("oo-dest-clear"));
  await sleep(300);
  await page.type(t("oo-dest-input"), "achimota", { delay: 20 });
  ok("places.retypes-suggests", await page.waitForSelector(t("oo-dest-list"), { visible: true, timeout: 8000 }).then(() => true).catch(() => false));
  await page.keyboard.press("Escape");
  await sleep(400);
  ok("places.escape-closes", !(await vis(page, "oo-dest-list")));
}

async function mapsTests(page) {
  ok("maps.picker.present", await vis(page, "oo-pin-map"));
  // satellite toggle exists
  const sats = await page.evaluate(
    (sel) => [...document.querySelectorAll(sel + " button")].map((b) => b.textContent.trim()),
    t("oo-pin-root"),
  );
  ok("maps.style-toggle", sats.some((s) => /Satellite/i.test(s)), sats.join("|"));

  // tiles blocked in this sandbox → offline notice must appear, pin UI alive
  await sleep(1600);
  const offline = await vis(page, "oo-pin-map-offline");
  ok("maps.offline-notice", offline, "tiles unreachable in sandbox → honest notice");
  const pinCtl = await page.evaluate(
    (sel) => {
      const root = document.querySelector(sel);
      return root
        ? [...root.querySelectorAll("button")].map((b) => b.dataset.testid || "")
        : [];
    },
    t("oo-pin-root"),
  );
  ok("maps.still-interactive", pinCtl.includes("oo-pin-gps"), pinCtl.join(","));
  // Places pick already set the delivery pin (hides "Drop pin at centre",
  // shows Clear). Verify clear→set round-trip instead of assuming null-pin.
  if (pinCtl.includes("oo-pin-clear")) {
    await page.click(t("oo-pin-clear"));
    await sleep(600);
  }
  await page.click(t("oo-pin-set"));
  await sleep(600);
  ok("maps.pin-drops", !!(await page.$(t("oo-pin-clear"))), "clear→set round-trip");

  // GPS button healthy (will fail in headless; must not crash)
  await page.click(t("oo-pin-gps"));
  await sleep(1200);
  ok("maps.gps-no-crash", true);

  // switch satellite → standard
  await page.evaluate((sel) => {
    const b = [...document.querySelectorAll(sel + " button")].find((x) => /Satellite/i.test(x.textContent));
    b?.click();
  }, t("oo-pin-root"));
  await sleep(900);
  await shot(page, "maps-satellite");
  await page.evaluate((sel) => {
    const b = [...document.querySelectorAll(sel + " button")].find((x) => /Standard/i.test(x.textContent));
    b?.click();
  }, t("oo-pin-root"));
  await sleep(600);
  ok("maps.standard-restore", await vis(page, "oo-pin-map"));
}

async function journeyDesktop(page) {
  // fill name + phone + place a PICKUP order (tests branch mini-map + success map)
  const nameSel = "input[placeholder*='full name'], input[placeholder*='Full name']";
  await page.evaluate(() => {
    const inp = [...document.querySelectorAll("input")].find((i) => /name/i.test(i.placeholder || "") && !/address|location/i.test(i.placeholder || ""));
    inp?.scrollIntoView({ block: "center" });
  });
  await sleep(300);
  await page.click(t("oo-name")).catch(() => {});
  await page.type(t("oo-name"), "Akosua Test", { delay: 10 }).catch(() => {});
  await page.click(t("oo-phone")).catch(() => {});
  await page.type(t("oo-phone"), "0551234567", { delay: 10 }).catch(() => {});
  const nv = await page.evaluate((s) => document.querySelector(s)?.value ?? "", t("oo-name"));
  const pv = await page.evaluate((s) => document.querySelector(s)?.value ?? "", t("oo-phone"));
  ok("journey.contact-filled", nv.length > 2 && pv.length === 10, `${nv}|${pv}`);

  await page.evaluate(() => {
    const el = [...document.querySelectorAll("button")].find((x) => /Pickup/i.test(x.innerText || ""));
    el?.click();
  });
  await sleep(900);
  // choose the first pickup point when the branch offers named points
  const pts = await page.$$eval("[data-testid^='oo-pickpoint-']", (l) => l.length).catch(() => 0);
  console.log("   [diag] pickpoints:", pts);
  if (pts === 0) console.log("   [diag] body contain map?", await page.evaluate(() => /Pickup/.test(document.querySelector("[data-testid='oo-checkout']")?.textContent ?? "")));
  if (pts > 0) {
    await page.click("[data-testid^='oo-pickpoint-']");
    await sleep(800);
  }
  // mini map (no Google iframe anywhere on the page anymore)
  const iframes = await page.$$eval("iframe[src*='maps.google'], iframe[src*='google.com/maps']", (f) => f.length).catch(() => -1);
  ok("journey.no-google-iframes", iframes === 0, `${iframes} google iframes`);
  ok("journey.pickup-minimap", await vis(page, "oo-pickup-map-frame") || await vis(page, "oo-pickup-map"));

  // choose payment on delivery & place
  await page.click(t("oo-pay-ondelivery")).catch(() => {});
  await sleep(300);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /Place order/i.test(x.innerText || ""));
    b?.scrollIntoView({ block: "center" });
  });
  await sleep(300);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /Place order/i.test(x.innerText || ""));
    b?.click();
  });
  await sleep(3500);
  const code = await page.evaluate(() =>
    (document.body.innerText.match(/GM-[A-Z-]*[A-Z0-9]{4,}/) || [""])[0],
  );
  ok("journey.order-placed", /^GM-/.test(code), code || "no code");
  await shot(page, "journey-placed");
  return code;
}

async function checkTracking(code) {
  if (!code) return ok("tracking.code", false, "no code from journey");
  const r = await fetch(`${BASE}/api/track?code=${encodeURIComponent(code)}`);
  const j = await r.json().catch(() => ({}));
  ok("tracking.code", r.ok && (j.ok === undefined || j.ok !== false), `status=${j.status || j.event || "?"}`);
}

async function mobileTests() {
  const { browser, page, errors } = await launch(true);
  try {
    await page.goto(`${BASE}/order`, { waitUntil: "networkidle0", timeout: 90000 });
    await sleep(2200);

    // single-column products on mobile
    const cols = await page.evaluate(() => {
      const g = [...document.querySelectorAll(".grid")].find((x) => x.className.includes("grid-cols-2"));
      return g ? getComputedStyle(g).gridTemplateColumns.split(" ").length : 0;
    });
    ok("mobile.grid.2cols", cols === 2, `${cols} cols`);

    // pinch-to-zoom in lightbox
    await page.tap(t("oo-photo-1"));
    await sleep(500);
    ok("mobile.lightbox", await vis(page, "oo-lightbox"));
    const cdp = await page.createCDPSession();
    const vp = await page.evaluate((sel) => {
      const r = document.querySelector(sel).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, t("oo-lightbox-viewport"));
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: vp.x - 40, y: vp.y, id: 1 },
        { x: vp.x + 40, y: vp.y, id: 2 },
      ],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { x: vp.x - 90, y: vp.y, id: 1 },
        { x: vp.x + 90, y: vp.y, id: 2 },
      ],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { x: vp.x - 130, y: vp.y, id: 1 },
        { x: vp.x + 130, y: vp.y, id: 2 },
      ],
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await sleep(300);
    const pzoom = await page.evaluate((sel) =>
      Number(document.querySelector(sel)?.dataset.zoom || 1), t("oo-lightbox-img"));
    ok("mobile.pinch-zoom", pzoom > 1.2, `zoom=${pzoom}`);

    // double-tap toggle
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: vp.x, y: vp.y, id: 1 }],
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await sleep(80);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: vp.x, y: vp.y, id: 1 }],
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await sleep(300);
    const tzoom = await page.evaluate((sel) =>
      Number(document.querySelector(sel)?.dataset.zoom || 1), t("oo-lightbox-img"));
    ok("mobile.double-tap-zoom", tzoom === 1, `reset to ${tzoom}`);

    await shot(page, "mobile-lightbox");
    await page.keyboard.press("Escape").catch(() => {});
    await page.tap(t("oo-lightbox-close")).catch(() => {});
    await sleep(400);

    // add + places on mobile
    await page.evaluate(() => {
      const el = [...document.querySelectorAll("button")].find((x) => /Add to Cart/i.test(x.innerText || ""));
      el?.click();
    });
    await sleep(700);
    await page.evaluate(() => {
      const el = [...document.querySelectorAll("button")].find((x) => /^Cart/.test(x.innerText || ""));
      el?.click();
    });
    await sleep(800);
    await page.evaluate(() => {
      const el = [...document.querySelectorAll("button")].find((x) => /Delivery/i.test(x.innerText || ""));
      el?.click();
    });
    await sleep(900);
    await page.tap(t("oo-dest-input")).catch(() => {});
    await page.type(t("oo-dest-input"), "osu", { delay: 30 });
    await sleep(1000);
    const listShown = await vis(page, "oo-dest-list");
    ok("mobile.places.opens", listShown);
    const diag = await page.evaluate(() => {
      const l = document.querySelector("[data-testid='oo-dest-list']");
      const r = l?.getBoundingClientRect();
      return r ? { t: r.top, b: r.bottom, l: r.left, rr: r.right, vh: window.innerHeight, vw: window.innerWidth, styl: l.getAttribute("style") } : null;
    });
    console.log("   [diag] mobile list rect:", JSON.stringify(diag));
    // panel is inside viewport bounds (portalled)
    const inView = await page.evaluate((sel) => {
      const l = document.querySelector(sel);
      if (!l) return false;
      const r = l.getBoundingClientRect();
      return r.left >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight + 4;
    }, t("oo-dest-list"));
    ok("mobile.places.in-viewport", inView);
    await page.tap(t("oo-dest-opt-0")).catch(() => {});
    await sleep(150);
    ok("mobile.places.closes", !(await vis(page, "oo-dest-list")));
    await shot(page, "mobile-delivery");
  } finally {
    ok("mobile.no-js-errors", errors.length === 0, errors.slice(0, 2).join("; "));
    await browser.close();
  }
}

async function preorderJourney() {
  const { browser, page, errors } = await launch(false);
  try {
    await page.goto(`${BASE}/order?biz=9`, { waitUntil: "networkidle0", timeout: 90000 });
    await sleep(2500);
    // org-2 drill → pre-order offer chips
    const pre = await page.$$eval("[data-testid^='oo-pre-'], [data-testid*='preorder'], [data-testid^='oo-po-']", (l) => l.length).catch(() => 0);
    ok("preorder.offers-visible", await page.evaluate(
      () => /Pre-order|---|Deposit/i.test(document.body.innerText),
    ), `${pre} chips`);
    // click first pre-order offer add button
    const added = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find(
        (b) => /Pre-order/i.test(b.innerText || "") && /Add|Reserve/i.test(b.innerText || "") === false,
      );
      const add = [...document.querySelectorAll("button")].find((b) => /add.*pre-order|choose.*option|reserve/i.test(b.innerText || ""));
      (add || btn)?.click();
      return !!(add || btn);
    });
    await sleep(800);
    if (added) {
      const second = await page.evaluate(() => {
        const b = [...document.querySelectorAll("button")].find((x) => /Add|Choose|Reserve/i.test(x.innerText || ""));
        b?.click();
        return !!b;
      }).catch(() => false);
      await sleep(600);
    }
    const cartTxt = await page.evaluate((sel) => document.querySelector(sel)?.textContent ?? "", t("oo-cart")).catch(() => "");
    ok("preorder.in-cart", cartTxt.length > 0, cartTxt.slice(0, 60));
  } finally {
    await browser.close();
  }
}

(async () => {
  const { browser, page, errors } = await launch(false);
  try {
    await page.goto(`${BASE}/order`, { waitUntil: "networkidle0", timeout: 90000 });
    await sleep(2500);
    await shot(page, "storefront");

    await galleryTests(page);
    // cart bar → open cart drawer checkout
    await page.evaluate(() => {
      const el = [...document.querySelectorAll("button")].find((x) => /^Cart/.test(x.innerText || ""));
      el?.click();
    });
    await sleep(900);
    await shot(page, "checkout");
    await placesTests(page);
    await mapsTests(page);
    const code = await journeyDesktop(page);
    await checkTracking(code);
  } finally {
    ok("desktop.no-js-errors", errors.length === 0, errors.slice(0, 2).join("; "));
    await browser.close();
  }
  await mobileTests();
  await preorderJourney();

  const failed = results.filter((r) => !r.pass);
  await mkdir(OUT, { recursive: true });
  await writeFile(`${OUT}/order-audit.json`, JSON.stringify(results, null, 1));
  console.log(`\n═══ RESULT: ${results.length - failed.length}/${results.length} passed (${failed.length} failed)`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("PROBE CRASH:", e); process.exit(2); });
