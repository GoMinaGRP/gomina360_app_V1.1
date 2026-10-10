// Chart probe — measures every recharts surface in the running app.
// Usage: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/probe-charts.mjs
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.OWNER_PW || "Owner@GoMina26" };
const SHOTS = process.env.SHOTS === "1";
const OUT = "/home/user/gomina360_app_V1.1/reports/screenshots/charts";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (SHOTS) mkdirSync(OUT, { recursive: true });

const pageErrors = [];
const browser = await puppeteer.launch({
  executablePath: "/tmp/al2023/chromium",
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--window-size=1500,950"],
});
const page = await browser.newPage();
await page.setViewport({ width: Number(process.env.VW || 1500), height: 950 });
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") {
    const t = m.text();
    if (!/401|Failed to load resource|net::ERR_/.test(t)) pageErrors.push(t);
  }
});

const waitSel = (sel, t = 20000) => page.waitForSelector(sel, { timeout: t });
const setTid = async (tid, val) => {
  await waitSel(`[data-testid="${tid}"]`);
  await page.evaluate((s, v) => {
    const el = document.querySelector(s);
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
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
await sleep(4000);

/** Measure every recharts plot surface (the SVG that actually holds the data). */
const measure = () =>
  page.evaluate(() => {
    const out = [];
    document.querySelectorAll(".recharts-responsive-container").forEach((el) => {
      const r = el.getBoundingClientRect();
      const wrapper = el.querySelector(".recharts-wrapper");
      const wr = wrapper ? wrapper.getBoundingClientRect() : null;
      // The PLOT surface is the wrapper's own svg (legend icons are separate).
      const surface = wrapper ? wrapper.querySelector(":scope > svg") : null;
      const sr = surface ? surface.getBoundingClientRect() : null;
      // How much ink is actually painted?
      let painted = 0;
      if (surface) {
        surface.querySelectorAll("path,rect,line,circle,polygon").forEach((n) => {
          const b = n.getBBox ? n.getBBox() : null;
          if (b && b.width > 1 && b.height > 1 && (n.getAttribute("d") || n.getAttribute("width") || "")) painted++;
        });
      }
      out.push({
        box: { w: Math.round(r.width), h: Math.round(r.height) },
        wrapper: wr ? { w: Math.round(wr.width), h: Math.round(wr.height) } : null,
        surface: sr ? { w: Math.round(sr.width), h: Math.round(sr.height) } : null,
        surfaceAttrs: surface ? { w: surface.getAttribute("width"), h: surface.getAttribute("height") } : null,
        painted,
        marks: surface ? surface.querySelectorAll(".recharts-bar-rectangle, .recharts-pie-sector, .recharts-line-curve, .recharts-area-area, .recharts-dot").length : 0,
        axes: surface ? surface.querySelectorAll(".recharts-cartesian-axis, .recharts-polar-angle-axis").length : 0,
        title: (el.closest("div")?.previousElementSibling?.textContent || "").trim().slice(0, 40),
      });
    });
    return out;
  });

const results = {};
const probe = async (label, fn) => {
  try {
    await fn();
    await sleep(2800);
    const m = await measure();
    results[label] = m;
    console.log(`\n### ${label} — ${m.length} chart(s)`);
    m.forEach((c, i) =>
      console.log(
        `  [${i}] box=${c.box.w}x${c.box.h} wrapper=${c.wrapper ? c.wrapper.w + "x" + c.wrapper.h : "NONE"} surface=${c.surface ? c.surface.w + "x" + c.surface.h : "NONE"} attrs=${JSON.stringify(c.surfaceAttrs)} painted=${c.painted} marks=${c.marks} axes=${c.axes}`,
      ),
    );
    if (!m.length) console.log("  (no recharts containers found)");
    if (SHOTS) await page.screenshot({ path: `${OUT}/${label.replace(/[^\w-]/g, "_")}.png`, fullPage: false });
  } catch (e) {
    console.log(`\n### ${label} — ERROR ${e.message}`);
  }
};

const gotoTab = async (tab) => {
  await page.goto(`${BASE}/?tab=${tab}`, { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(3200);
};

const tabs = (process.env.TABS || "COMMAND_CENTER,FINANCE,POULTRY-01,BLOCK-01,AQUA-01,WASH-01,HARDWARE-01,TECH-01,FOOD-01,LIVESTOCK-01,BOUTIQUE-01,AUDIT").split(",");
for (const tab of tabs) await probe(tab, () => gotoTab(tab));

const broken = Object.entries(results).flatMap(([tab, m]) =>
  m.map((c, i) => ({ tab, i, ...c })),
).filter((c) => !c.surface || c.surface.w < 20 || c.painted === 0);
console.log(`\n### BROKEN SURFACES: ${broken.length}`);
for (const b of broken) console.log(`  ${b.tab}[${b.i}] surface=${JSON.stringify(b.surface)} painted=${b.painted} marks=${b.marks}`);

console.log("\n### PAGE ERRORS");
console.log(pageErrors.length ? [...new Set(pageErrors)].slice(0, 25).join("\n") : "  (none)");

await browser.close();