import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");
const BASE = process.env.BASE_URL || "http://localhost:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: "Owner@GoMina26" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "/tmp/al2023/chromium",
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });
const waitSel = (s, t = 20000) => page.waitForSelector(s, { timeout: t });
const setTid = async (tid, val) => {
  await waitSel(`[data-testid="${tid}"]`);
  await page.evaluate((s, v) => {
    const el = document.querySelector(s);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, `[data-testid="${tid}"]`, val);
};
await page.goto(BASE, { waitUntil: "networkidle0", timeout: 60000 });
await waitSel('[data-testid="login-email"]');
await setTid("login-email", OWNER.email);
await setTid("login-password", OWNER.pw);
await page.evaluate(() => document.querySelector('[data-testid="login-submit"]')?.click());
await waitSel('[data-testid="nav-sidebar"]', 40000);
await sleep(5000);

const dump = await page.evaluate(() => {
  const el = document.querySelector(".recharts-responsive-container");
  if (!el) return { err: "no container" };
  const chain = [];
  let n = el;
  for (let i = 0; i < 6 && n; i++) {
    const cs = getComputedStyle(n);
    chain.push({
      tag: n.tagName,
      cls: n.className && n.className.baseVal !== undefined ? n.className.baseVal : String(n.className || ""),
      rect: (({ width, height }) => ({ width: Math.round(width), height: Math.round(height) }))(n.getBoundingClientRect()),
      display: cs.display,
      position: cs.position,
      width: cs.width,
      height: cs.height,
      maxWidth: cs.maxWidth,
      minWidth: cs.minWidth,
      inlineStyle: n.getAttribute("style") || "",
      overflow: cs.overflow,
      flexBasis: cs.flexBasis,
    });
    n = n.parentElement;
  }
  const wrapper = el.querySelector(".recharts-wrapper");
  const surface = wrapper?.querySelector(":scope > svg");
  return {
    chain,
    wrapper: wrapper && {
      rect: (({ width, height }) => ({ width: Math.round(width), height: Math.round(height) }))(wrapper.getBoundingClientRect()),
      inlineStyle: wrapper.getAttribute("style") || "",
      computed: (() => { const cs = getComputedStyle(wrapper); return { display: cs.display, width: cs.width, maxWidth: cs.maxWidth, position: cs.position }; })(),
    },
    surface: surface && {
      rect: (({ width, height }) => ({ width: Math.round(width), height: Math.round(height) }))(surface.getBoundingClientRect()),
      inlineStyle: surface.getAttribute("style") || "",
      attrs: { width: surface.getAttribute("width"), height: surface.getAttribute("height") },
      computed: (() => { const cs = getComputedStyle(surface); return { display: cs.display, width: cs.width, height: cs.height, position: cs.position, maxWidth: cs.maxWidth }; })(),
    },
  };
});
console.log(JSON.stringify(dump, null, 2));
await browser.close();