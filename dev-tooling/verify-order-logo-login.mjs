/**
 * verify-order-logo-login.mjs — the GoMina 360 logo in the Customer Order page
 * header must be a ONE-CLICK link to the GoMina 360 Login page, on desktop and
 * on mobile, without disturbing the ordering flow.
 *
 *   A · Desktop (1280×900): logo exists, is an <a href="/">, is visible and
 *       accessible (title + aria-label), and ONE click lands on the login
 *       screen (login-screen / login-email / login-submit present).
 *   B · Mobile (390×844, touch): the logo badge is visible, on-screen, has a
 *       usable tap target, and ONE tap lands on the same login screen.
 *   C · Login page → "Order online" link returns to /order (round trip works).
 *   D · Non-regression: the header cart / search / track link still work, a
 *       product can still be added to the cart, and the logo click does NOT
 *       run while the cart is being used (cart state is untouched until the
 *       user actually navigates). Zero page errors throughout.
 *
 * Read-only: nothing is written to the database (no order is placed).
 * Run: bash dev-tooling/run-suite.sh dev-tooling/verify-order-logo-login.mjs
 */
import { createRequire } from "module";
const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const results = [];
const ok = (name, cond, extra = "") => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "✅" : "❌"} ${name}${cond ? "" : " — " + extra}`);
  return !!cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "/tmp/al2023/chromium",
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});

const pageErrors = [];
const newPage = async (viewport, touch = false) => {
  const p = await browser.newPage();
  await p.setViewport({ ...viewport, hasTouch: touch, isMobile: touch, deviceScaleFactor: touch ? 3 : 1 });
  p.on("pageerror", (e) => pageErrors.push(String(e)));
  return p;
};

const onLoginScreen = (p) =>
  p.evaluate(() => ({
    url: location.pathname,
    screen: !!document.querySelector('[data-testid="login-screen"]'),
    email: !!document.querySelector('[data-testid="login-email"]'),
    submit: !!document.querySelector('[data-testid="login-submit"]'),
  }));

try {
  /* ── A · Desktop ───────────────────────────────────────────────────────── */
  const d = await newPage({ width: 1280, height: 900 });
  await d.goto(`${BASE}/order`, { waitUntil: "networkidle2", timeout: 60000 });
  await d.waitForSelector('[data-testid="oo-logo"]', { timeout: 30000 });

  const logo = await d.evaluate(() => {
    const a = document.querySelector('[data-testid="oo-logo"]');
    if (!a) return null;
    const r = a.getBoundingClientRect();
    const cs = getComputedStyle(a);
    return {
      tag: a.tagName,
      href: a.getAttribute("href"),
      resolved: new URL(a.href, location.href).pathname,
      title: a.getAttribute("title") || "",
      aria: a.getAttribute("aria-label") || "",
      w: Math.round(r.width),
      h: Math.round(r.height),
      top: Math.round(r.top),
      left: Math.round(r.left),
      visible: cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0 && r.height > 0,
      hitsSelf: (() => {
        const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!el && (el === a || a.contains(el));
      })(),
    };
  });
  ok("A1 · logo present in the order header", !!logo);
  ok("A2 · logo is a real anchor element", logo?.tag === "A", `tag=${logo?.tag}`);
  ok("A3 · logo href points at the login page (/)", logo?.href === "/" && logo?.resolved === "/", `href=${logo?.href}`);
  ok("A4 · logo is visible", !!logo?.visible, JSON.stringify(logo));
  ok("A5 · logo is top-left of the header", (logo?.left ?? 999) < 200 && (logo?.top ?? 999) < 140, JSON.stringify(logo));
  ok("A6 · logo has title + aria-label for a11y", !!logo?.title && /login/i.test(logo.aria), JSON.stringify(logo));
  ok("A7 · nothing overlaps the logo (click reaches it)", !!logo?.hitsSelf);

  // ONE click → login page.
  await Promise.all([
    d.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }),
    d.click('[data-testid="oo-logo"]'),
  ]);
  await d.waitForSelector('[data-testid="login-screen"]', { timeout: 30000 }).catch(() => {});
  const dState = await onLoginScreen(d);
  ok("A8 · one click navigates to / (login route)", dState.url === "/", JSON.stringify(dState));
  ok("A9 · GoMina 360 Login screen rendered (desktop)", dState.screen && dState.email && dState.submit, JSON.stringify(dState));

  /* ── C · Login → back to the store (round trip) ────────────────────────── */
  const hasBack = await d.$('[data-testid="login-order-link"]');
  ok("C1 · login page offers the storefront link", !!hasBack);
  if (hasBack) {
    await Promise.all([
      d.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }),
      d.click('[data-testid="login-order-link"]'),
    ]);
    const back = await d.evaluate(() => ({
      path: location.pathname,
      catalog: !!document.querySelector('[data-testid="oo-catalog"]'),
    }));
    ok("C2 · storefront link returns to the order page", back.path === "/order" && back.catalog, JSON.stringify(back));
  }

  /* ── D · Non-regression on the order page ──────────────────────────────── */
  await d.goto(`${BASE}/order`, { waitUntil: "networkidle2", timeout: 60000 });
  await d.waitForSelector('[data-testid="oo-catalog"]', { timeout: 30000 });
  const header = await d.evaluate(() => ({
    search: !!document.querySelector('[data-testid="oo-search"]'),
    help: !!document.querySelector('[data-testid="oo-help"]'),
    track: document.querySelector('[data-testid="oo-track-link"]')?.getAttribute("href"),
    cart: !!document.querySelector('[data-testid="oo-header-cart"]'),
    count: document.querySelector('[data-testid="oo-header-cart-count"]')?.textContent?.trim(),
  }));
  ok("D1 · header search/HELP/cart intact", header.search && header.help && header.cart, JSON.stringify(header));
  ok("D2 · track-order link still points at /track", header.track === "/track", JSON.stringify(header));
  ok("D3 · cart starts empty", header.count === "0", JSON.stringify(header));

  // Search still filters, and adding to cart still works (ordering untouched).
  await d.type('[data-testid="oo-search"]', "a", { delay: 30 });
  await sleep(400);
  await d.evaluate(() => {
    const el = document.querySelector('[data-testid="oo-search"]');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    set.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(400);

  const addBtn = await d.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) =>
      /add to cart/i.test(x.textContent || "") && !x.disabled);
    if (!b) return null;
    b.scrollIntoView({ block: "center" });
    b.setAttribute("data-logo-suite-add", "1");
    return true;
  });
  if (addBtn) {
    await sleep(300);
    await d.click('[data-logo-suite-add="1"]');
    await sleep(600);
    const after = await d.evaluate(() =>
      document.querySelector('[data-testid="oo-header-cart-count"]')?.textContent?.trim());
    ok("D4 · add-to-cart still increments the cart badge", after === "1", `count=${after}`);
    const stillLogo = await d.evaluate(() => {
      const a = document.querySelector('[data-testid="oo-logo"]');
      return a ? a.getAttribute("href") : null;
    });
    ok("D5 · logo link unchanged while a cart is active", stillLogo === "/", `href=${stillLogo}`);
  } else {
    ok("D4 · add-to-cart still increments the cart badge", false, "no enabled Add to cart button found");
  }

  /* ── B · Mobile ────────────────────────────────────────────────────────── */
  const m = await newPage({ width: 390, height: 844 }, true);
  await m.goto(`${BASE}/order`, { waitUntil: "networkidle2", timeout: 60000 });
  await m.waitForSelector('[data-testid="oo-logo"]', { timeout: 30000 });
  const mLogo = await m.evaluate(() => {
    const a = document.querySelector('[data-testid="oo-logo"]');
    const r = a.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      href: a.getAttribute("href"),
      w: Math.round(r.width),
      h: Math.round(r.height),
      top: Math.round(r.top),
      left: Math.round(r.left),
      inViewport: r.top >= 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      hitsSelf: !!el && (el === a || a.contains(el)),
    };
  });
  ok("B1 · mobile logo href = / (login)", mLogo.href === "/", JSON.stringify(mLogo));
  ok("B2 · mobile logo fully inside the 390px viewport", mLogo.inViewport, JSON.stringify(mLogo));
  ok("B3 · mobile tap target ≥ 40×40 px", mLogo.w >= 40 && mLogo.h >= 40, JSON.stringify(mLogo));
  ok("B4 · mobile logo not covered by other header controls", mLogo.hitsSelf, JSON.stringify(mLogo));

  await Promise.all([
    m.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }),
    m.tap('[data-testid="oo-logo"]'),
  ]);
  await m.waitForSelector('[data-testid="login-screen"]', { timeout: 30000 }).catch(() => {});
  const mState = await onLoginScreen(m);
  ok("B5 · one tap navigates to / (login route)", mState.url === "/", JSON.stringify(mState));
  ok("B6 · GoMina 360 Login screen rendered (mobile)", mState.screen && mState.email && mState.submit, JSON.stringify(mState));
  const mFits = await m.evaluate(() => {
    const f = document.querySelector('[data-testid="login-email"]').getBoundingClientRect();
    return f.width > 100 && f.right <= innerWidth + 1;
  });
  ok("B7 · login form usable at 390px width", mFits);

  ok("Z1 · zero uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} catch (e) {
  ok("suite completed without throwing", false, e?.stack || String(e));
} finally {
  await browser.close();
}

const pass = results.filter((r) => r.pass).length;
console.log(`\n${pass}/${results.length} checks passed`);
process.exit(pass === results.length ? 0 : 1);
