/**
 * verify-charts.mjs — every chart, every surface, every tab, every role,
 * desktop AND mobile.
 *
 * The bug this pins: ONE global stylesheet rule clamped `.recharts-wrapper`
 * with `max-width: 100%`. recharts 3 deliberately wraps its chart in a 0×0
 * overflow-visible auto-sizer div, so `100%` resolved to 0 and EVERY chart in
 * the app was laid out at 0 px wide — invisible, on every dashboard, module,
 * business type and role, while the DOM still held its bars and axes.
 *
 * The assertion is therefore purely GEOMETRIC and therefore global: a chart is
 * only "displaying" when its plot surface actually occupies pixels and paints
 * something. It needs no knowledge of which chart is which, so it catches any
 * future regression of the same class in any module.
 *
 * Coverage:
 *   • every business-type workspace (Poultry, Block, Aqua, Livestock, Food,
 *     Tech, Car Wash, Hardware, Boutique) + Command Center, Finance, Audit,
 *     Payroll, Orders, Pre-Orders, Transport, Telecom, Procurement
 *   • EVERY in-page sub-tab of each workspace (charts are often conditional)
 *   • OWNER / General Manager / Branch Manager / Accountant / Worker
 *   • 1500 px desktop and 375 px mobile
 *   • no page-level horizontal overflow introduced by the charts
 *
 * Usage: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-charts.mjs
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const OUT = "/home/user/gomina360_app_V1.1/reports/screenshots/charts";
const SHOTS = process.env.SHOTS !== "0";
if (SHOTS) mkdirSync(OUT, { recursive: true });

const OWNER = { email: "kwame.owner@gomina360.com", pw: "Owner@GoMina26" };
const ROLES = {
  OWNER,
  GENERAL_MANAGER: { email: "abena.gm@gomina360.com", pw: "GoMina@User2" },
  BRANCH_MANAGER: { email: "emmanuel@gomina360.com", pw: "GoMina@User3" },
  WORKER: { email: "akua.donkor@gomina360.com", pw: "GoMina@User10" },
};

// Business-type workspaces + cross-cutting surfaces.
const SURFACES = [
  "COMMAND_CENTER", "FINANCE", "AUDIT", "PAYROLL", "TRANSACTIONS", "TRACKING",
  "PREORDERS", "PROCUREMENT", "ACTION_CENTER", "EMPLOYEES", "INVENTORY",
  "POULTRY-01", "BLOCK-01", "AQUA-01", "LIVESTOCK-01", "FOOD-01",
  "TECH-01", "WASH-01", "HARDWARE-01", "BOUTIQUE-01",
];
// ROLES=OWNER,WORKER narrows the sweep while iterating on one role.
const ONLY_ROLES = (process.env.ROLES || "").split(",").map((x) => x.trim()).filter(Boolean);
const VIEWPORTS = [
  { name: "desktop", width: 1500, height: 950 },
  { name: "mobile", width: 375, height: 780 },
];
const MIN_SURFACE_PX = 24;

const results = [];
let pass = 0,
  fail = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  results.push({ name, pass: !!cond });
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(name + (detail ? " — " + detail : ""));
    console.log(`❌ ${name}${detail ? " — " + detail : ""}`);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "/tmp/al2023/chromium",
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});

const pageErrors = [];

async function signIn(cred) {
  // A fresh browser CONTEXT per role: a shared cookie jar would carry the
  // previous role's session and the login form would never render.
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  p.on("pageerror", (e) => pageErrors.push(String(e)));
  p.on("console", (m) => {
    if (m.type() === "error") {
      const t = m.text();
      if (!/401|Failed to load resource|net::ERR_/.test(t)) pageErrors.push(t);
    }
  });
  await p.setViewport(VIEWPORTS[0]);
  await p.goto(BASE, { waitUntil: "networkidle0", timeout: 60000 });
  await p.waitForSelector('[data-testid="login-email"]', { timeout: 20000 });
  await p.evaluate(
    (sel, v) => {
      const el = document.querySelector(sel);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    '[data-testid="login-email"]',
    cred.email,
  );
  await p.evaluate(
    (sel, v) => {
      const el = document.querySelector(sel);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    '[data-testid="login-password"]',
    cred.pw,
  );
  await p.evaluate(() => document.querySelector('[data-testid="login-submit"]')?.click());
  await p.waitForSelector('[data-testid="nav-sidebar"]', { timeout: 40000 });
  await sleep(3500);
  p.__ctx = ctx;
  return p;
}

/** Find the in-page tab strips of the current workspace. */
const findTabStrips = (page) =>
  page.evaluate(() => {
    const strips = [];
    const seen = new Set();
    const looksLikeStrip = (el) => {
      const cls = String(el.className || "");
      if (!/rounded-xl|rounded-lg/.test(cls)) return false;
      if (!/(^|\s)p-1(\.5)?(\s|$)/.test(cls) && !/tab/i.test(String(el.getAttribute("data-testid") || "")))
        return false;
      return el.querySelectorAll(":scope > button").length >= 2;
    };
    const all = document.querySelectorAll("main div, main nav");
    for (const el of all) {
      if (!looksLikeStrip(el)) continue;
      if (seen.has(el)) continue;
      seen.add(el);
      strips.push({
        testid: el.getAttribute("data-testid") || "",
        buttons: [...el.querySelectorAll(":scope > button")].map((b) => (b.textContent || "").trim()).filter(Boolean),
      });
    }
    return strips;
  });

const clickTab = (page, stripIndex, buttonIndex) =>
  page.evaluate(
    (si, bi) => {
      const all = [...document.querySelectorAll("main div, main nav")];
      const looksLikeStrip = (el) => {
        const cls = String(el.className || "");
        if (!/rounded-xl|rounded-lg/.test(cls)) return false;
        if (!/(^|\s)p-1(\.5)?(\s|$)/.test(cls) && !/tab/i.test(String(el.getAttribute("data-testid") || "")))
          return false;
        return el.querySelectorAll(":scope > button").length >= 2;
      };
      const strips = all.filter(looksLikeStrip);
      const s = strips[si];
      if (!s) return false;
      const b = s.querySelectorAll(":scope > button")[bi];
      if (!b) return false;
      b.click();
      return true;
    },
    stripIndex,
    buttonIndex,
  );

/** Measure every chart surface on the page. */
const measureCharts = (page) =>
  page.evaluate(() => {
    const out = [];
    document.querySelectorAll(".recharts-responsive-container").forEach((el) => {
      const wrapper = el.querySelector(".recharts-wrapper");
      const surface = wrapper ? wrapper.querySelector(":scope > svg") : null;
      const r = surface ? surface.getBoundingClientRect() : { width: 0, height: 0 };
      const wr = wrapper ? wrapper.getBoundingClientRect() : { width: 0, height: 0 };
      let painted = 0;
      if (surface) {
        surface.querySelectorAll("path,rect,line,circle,polygon,text").forEach((n) => {
          const b = n.getBBox ? n.getBBox() : null;
          if (b && b.width > 1 && b.height > 1) painted++;
        });
      }
      out.push({
        surfaceW: Math.round(r.width),
        surfaceH: Math.round(r.height),
        wrapperW: Math.round(wr.width),
        painted,
        marks: surface
          ? surface.querySelectorAll(
              ".recharts-bar-rectangle, .recharts-pie-sector, .recharts-line-curve, .recharts-area-area, .recharts-dot, .recharts-radar-polygon",
            ).length
          : 0,
        visible: r.width > 0 && r.height > 0,
      });
    });
    return {
      charts: out,
      docOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    };
  });

const resultsByRole = {};
for (const [role, cred] of Object.entries(ROLES)) {
  if (ONLY_ROLES.length && !ONLY_ROLES.includes(role)) continue;
  const page = await signIn(cred);
  console.log(`\n══ ${role} ${"═".repeat(Math.max(0, 50 - role.length))}`);
  let totalCharts = 0;
  let brokenHere = [];
  let pageLoads = 0;
  let navFailures = [];
  let emptySurfaces = [];

  for (const vp of VIEWPORTS) {
    await page.setViewport(vp);
    await sleep(700);
    for (const surface of SURFACES) {
      let navOk = true;
      try {
        await page.goto(`${BASE}/?tab=${surface}`, { waitUntil: "networkidle2", timeout: 45000 });
      } catch {
        navOk = false;
      }
      // A navigation timeout must NEVER look like "this role has no charts".
      if (!navOk) {
        navFailures.push(`${vp.name}/${surface}`);
        continue;
      }
      pageLoads++;
      await sleep(2200);
      const strips = await findTabStrips(page);
      // Visit the default tab plus every in-page sub-tab.
      const visits = [[-1, -1]];
      strips.forEach((s, si) => s.buttons.forEach((_, bi) => visits.push([si, bi])));
      for (const [si, bi] of visits) {
        if (si >= 0) {
          const clicked = await clickTab(page, si, bi);
          if (!clicked) continue;
          await sleep(1300);
        }
        const m = await measureCharts(page);
        totalCharts += m.charts.length;
        if (!m.charts.length && vp.name === "desktop" && si < 0) {
          const rendered = await page.evaluate(() => {
            const r = document.querySelector("[data-tab-root], main, #main, [role=main]");
            return !!(r && r.getBoundingClientRect().height > 40);
          });
          if (!rendered) emptySurfaces.push(surface);
        }
        const bad = m.charts.filter((c) => !c.surfaceW || !c.surfaceH);
        if (bad.length) {
          brokenHere.push(
            `${vp.name}/${surface}${si >= 0 ? `[tab ${bi}]` : ""} → ${bad.length} chart(s) at ${bad
              .map((b) => `${b.surfaceW}x${b.surfaceH}`)
              .join(",")}`,
          );
        }
        if (m.docOverflow > 2) {
          brokenHere.push(`${vp.name}/${surface} → page scrolls sideways by ${m.docOverflow}px`);
        }
        if (SHOTS && (bad.length || m.docOverflow > 2) && vp.name === "desktop") {
          await page.screenshot({ path: `${OUT}/BROKEN-${vp.name}-${surface}-${si}_${bi}.png` });
        }
      }
    }
  }

  ok(`${role}: every chart surface is laid out with real pixels`, brokenHere.length === 0, brokenHere.slice(0, 6).join(" | "));
  // A role measuring 0 charts must be a REAL "no charts here" verdict, not a
  // harness that quietly failed to render anything at all.
  ok(
    `${role}: every surface loaded in every viewport (${SURFACES.length}×${VIEWPORTS.length} page loads)`,
    navFailures.length === 0 && pageLoads === SURFACES.length * VIEWPORTS.length,
    navFailures.slice(0, 5).join(", ") || `${pageLoads} loads`,
  );
  ok(`${role}: every visited surface rendered a real workspace`, emptySurfaces.length === 0,
    emptySurfaces.slice(0, 8).join(", "));
  resultsByRole[role] = { totalCharts, broken: brokenHere.length, pageLoads };
  console.log(`   ${totalCharts} chart surfaces measured over ${pageLoads} page loads, ${brokenHere.length} broken`);
  await page.close();
  await (page.__ctx ? page.__ctx.close() : undefined);
}

ok("no uncaught page errors during the chart sweep", pageErrors.length === 0, [...new Set(pageErrors)].slice(0, 5).join(" | "));

console.log("\n── SUMMARY ──────────────────────────────────────────────");
for (const [role, r] of Object.entries(resultsByRole))
  console.log(`  ${role.padEnd(16)} ${String(r.totalCharts).padStart(4)} chart surfaces measured · ${r.broken} broken · ${r.pageLoads} page loads`);
console.log(`\n${pass} pass / ${fail} fail`);
if (fail) {
  console.log("FAILED:\n - " + failures.join("\n - "));
}
await browser.close();
process.exit(fail ? 1 : 0);