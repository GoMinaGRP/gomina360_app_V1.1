import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");
const BASE = process.env.BASE_URL || "http://localhost:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: "Owner@GoMina26" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: "/tmp/al2023/chromium", headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] });
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

const rules = await page.evaluate(() => {
  const out = [];
  const walk = (sheet) => {
    let list;
    try { list = sheet.cssRules; } catch { return; }
    if (!list) return;
    for (const r of list) {
      if (r.cssRules) { walk(r); continue; }
      if (!r.selectorText) continue;
      if (/recharts/.test(r.selectorText)) out.push({ sel: r.selectorText, css: r.style.cssText });
    }
  };
  for (const s of document.styleSheets) walk(s);
  // Also: any rule with !important width anywhere
  const imp = [];
  const walk2 = (sheet) => {
    let list;
    try { list = sheet.cssRules; } catch { return; }
    if (!list) return;
    for (const r of list) {
      if (r.cssRules) { walk2(r); continue; }
      if (!r.style) continue;
      for (const p of ["width", "min-width", "max-width"]) {
        const v = r.style.getPropertyValue(p);
        if (v && v.includes("important") && /recharts|svg/.test(r.selectorText || "")) imp.push({ sel: r.selectorText, p, v });
      }
    }
  };
  for (const s of document.styleSheets) walk2(s);
  return { out, imp };
});
console.log("=== rules matching 'recharts' ===");
for (const r of rules.out) console.log(`  ${r.sel}  {  ${r.css}  }`);
console.log("=== important width rules on recharts/svg ===");
for (const r of rules.imp) console.log(`  ${r.sel}  ${r.p}: ${r.v}`);
await browser.close();