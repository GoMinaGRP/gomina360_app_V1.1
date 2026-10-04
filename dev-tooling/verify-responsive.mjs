// verify-responsive.mjs — responsive / overflow audit across GoMina 360.
//
// Walks every shared page and every business unit (all business types) at
// desktop / tablet / mobile widths and reports elements that
//   • extend past the viewport without a horizontal scroller around them
//     (content pushed off-screen), or
//   • are clipped inside an overflow:hidden box with content wider than the box
//     (content cut off), or
//   • are tables/charts that cannot be reached on a phone.
//
// Usage:
//   bash dev-tooling/run-suite.sh dev-tooling/verify-responsive.mjs
//   VIEWPORTS=mobile bash dev-tooling/run-suite.sh dev-tooling/verify-responsive.mjs
//   PAGES=inventory,orders bash dev-tooling/run-suite.sh dev-tooling/verify-responsive.mjs
import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");
const fs = req("fs");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const OUT = new URL("./.verify-out/", import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.OWNER_PW || "Owner@GoMina26" };
const REPORT = process.env.REPORT || `${OUT}responsive-report.json`;

const VIEWPORTS = (process.env.VIEWPORTS || "desktop,tablet,mobile").split(",").map((v) => v.trim());
const VP = {
  desktop: { width: 1440, height: 900, label: "desktop 1440" },
  laptop: { width: 1280, height: 800, label: "laptop 1280" },
  tablet: { width: 820, height: 1180, label: "tablet 820" },
  mobile: { width: 390, height: 844, label: "mobile 390" },
  narrow: { width: 320, height: 720, label: "narrow 320" },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, timeout = 25000, step = 250) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true;
    await sleep(step);
  }
  return false;
};

// ── In-page probes ──────────────────────────────────────────────────────────
const probeOverflow = (opts = {}) => {
  // Reference width = the app's content column (main), not the window: the
  // sidebar takes part of the window, and main is the box users perceive as
  // "the page". Anything sticking out of main is invisible/cut off on screen
  // even when main itself can scroll.
  // Modal pass: scan only the top-most overlay so the (dimmed) page underneath
  // is not re-reported for the same defects.
  const overlays = [...document.querySelectorAll('main div.fixed, main [role="dialog"]')].filter((el) => el.getClientRects().length);
  const scopeEl =
    opts.scope === "modal" && overlays.length ? overlays[overlays.length - 1] : document.querySelector("main");
  const mainEl = document.querySelector("main");
  const vw = scopeEl && opts.scope === "modal" ? scopeEl.clientWidth : mainEl ? mainEl.clientWidth : document.documentElement.clientWidth;
  const seen = new Set();
  const out = [];
  const path = (el) => {
    const bits = [];
    let n = el;
    for (let i = 0; i < 4 && n && n !== document.body; i++) {
      const cls = (n.className && typeof n.className === "string" ? n.className : "")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 3)
        .join(".");
      bits.unshift(`${n.tagName.toLowerCase()}${n.dataset?.testid ? `[${n.dataset.testid}]` : ""}${cls ? `.${cls}` : ""}`);
      n = n.parentElement;
    }
    return bits.join(" > ");
  };
  const scroller = (el) => {
    let p = el.parentElement;
    while (p && p !== document.documentElement && p !== mainEl) {
      const cs = getComputedStyle(p);
      if (cs.overflowX === "auto" || cs.overflowX === "scroll") return p;
      p = p.parentElement;
    }
    return null;
  };
  const mainLeft = mainEl ? mainEl.getBoundingClientRect().left : 0;
  const limit = mainLeft + vw;
  const winRight = document.documentElement.clientWidth;
  // An element that is not actually painted (opacity 0 / visibility hidden /
  // display none ancestor) cannot clip anything — ignore it.
  const visible = (el) => {
    try {
      if (typeof el.checkVisibility === "function" && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    } catch {}
    let n = el;
    while (n && n !== document.body) {
      const cs = getComputedStyle(n);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
      n = n.parentElement;
    }
    return true;
  };
  for (const el of (scopeEl || document).querySelectorAll(opts.scope === "modal" ? "*" : "main *")) {
    if (el.closest('[data-printchrome="true"]')) continue;
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    // Fixed overlays (modals/drawers) are positioned against the WINDOW, not
    // the content column — only flag them when they exceed the window itself.
    const isFixed = getComputedStyle(el).position === "fixed";
    if (r.right <= (isFixed ? winRight : limit) + 1) continue;
    const sc = scroller(el);
    if (sc) continue;
    const sig = `${path(el)}|${Math.round(r.width)}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push({
      kind: "pushed-off",
      tag: el.tagName.toLowerCase(),
      testid: el.getAttribute("data-testid") || null,
      path: path(el),
      right: Math.round(r.right),
      width: Math.round(r.width),
      text: (el.textContent || "").trim().slice(0, 60),
    });
    if (out.length >= 14) break;
  }
  // Clipped content (cut off): scrollWidth materially wider than clientWidth
  // inside a box that cannot scroll.
  for (const el of (scopeEl || document).querySelectorAll(opts.scope === "modal" ? "div, section, table" : "main div, main section, main table")) {
    if (el.closest('[data-printchrome="true"]')) continue;
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.overflowX !== "hidden" && cs.overflowX !== "clip") continue;
    if (el.scrollWidth <= el.clientWidth + 2 || el.clientWidth < 40) continue;
    const sig = `clip|${path(el)}|${el.scrollWidth}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push({
      kind: "clipped",
      tag: el.tagName.toLowerCase(),
      testid: el.getAttribute("data-testid") || null,
      path: path(el),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      text: (el.textContent || "").trim().slice(0, 60),
    });
    if (out.length >= 22) break;
  }
  // Positive assertion: every table that is wider than its box must sit inside
  // a horizontally scrollable ancestor, otherwise its columns are unreachable.
  const tables = [...(scopeEl || document).querySelectorAll(opts.scope === "modal" ? "table" : "main table")];
  const wideTablesWithoutScroller = tables
    .filter((t) => t.scrollWidth > t.clientWidth + 2 && !scroller(t))
    .map((t) => (t.textContent || "").trim().slice(0, 40));
  return {
    viewportWidth: document.documentElement.clientWidth,
    contentWidth: vw,
    pageScrollWidth: document.documentElement.scrollWidth,
    // The document must never scroll sideways: window width is the budget.
    pageOverflows: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    tables: tables.length,
    wideTablesWithoutScroller,
    offenders: out,
  };
};

const probeCounts = () => ({
  tables: document.querySelectorAll("main table").length,
  tablesWithoutScroller: [...document.querySelectorAll("main table")].filter((t) => {
    let p = t.parentElement;
    while (p && p !== document.documentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX === "auto" || cs.overflowX === "scroll") return false;
      p = p.parentElement;
    }
    return true;
  }).length,
  cards: document.querySelectorAll("main [class*='rounded-2xl'], main [class*='rounded-xl']").length,
});

// ── Navigation helpers ──────────────────────────────────────────────────────
async function login(page) {
  await page.goto(`${BASE}/?login=1`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector('[data-testid="login-email"]', { timeout: 120000 });
  await page.type('[data-testid="login-email"]', OWNER.email);
  await page.type('[data-testid="login-password"]', OWNER.pw);
  await page.click('[data-testid="login-submit"]');
  await waitFor(async () => (await page.$('[data-testid="nav-sidebar"]')) !== null, 60000);
}

/** Click an element in the sidebar by its visible label. */
async function clickSidebar(page, text) {
  return page.evaluate((label) => {
    const sidebar = document.querySelector('[data-testid="nav-sidebar"]');
    if (!sidebar) return false;
    const els = [...sidebar.querySelectorAll("button, a")];
    const el = els.find((b) => new RegExp(label, "i").test(b.textContent || ""));
    if (!el) return false;
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  }, text);
}

/** Click a tab-like button inside main (never the sidebar / top bar). */
async function clickTab(page, re) {
  return page.evaluate((src) => {
    const rx = new RegExp(src, "i");
    const els = [...document.querySelectorAll("main button, main [role='tab']")];
    const el = els.find((b) => {
      const t = (b.textContent || "").trim();
      return t.length > 1 && t.length < 40 && rx.test(t);
    });
    if (!el) return false;
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  }, re);
}

const results = [];
const push = (entry) => {
  results.push(entry);
  const off = entry.offenders?.length || 0;
  const flag = off === 0 && !entry.pageOverflows ? "OK " : "!! ";
  console.log(
    `${flag}${entry.viewportLabel.padEnd(13)} ${entry.page.padEnd(34)}${entry.tab ? `[${entry.tab}]` : ""} ${
      entry.pageOverflows ? `PAGE-SCROLL(${entry.pageScrollWidth}) ` : ""
    }${off} offender(s)`,
  );
  for (const o of (entry.offenders || []).slice(0, 4)) {
    console.log(`      · ${o.kind} ${o.tag}${o.testid ? `#${o.testid}` : ""} w=${o.width ?? o.scrollWidth} right=${o.right ?? "-"} :: ${o.text.slice(0, 50)}`);
  }
};

const chromium = (await req("@sparticuz/chromium")).default ?? req("@sparticuz/chromium");
const browser = await puppeteer.launch({
  executablePath: await chromium.executablePath(),
  args: [...(chromium.args || []), "--no-sandbox", "--disable-setuid-sandbox"],
});

const SHARED_PAGES = [
  { label: "Command Center", nav: "Command Center", tabs: [] },
  { label: "Inventory & Stock", nav: "Inventory & Stock", tabs: [] },
  { label: "Sales & Transactions", nav: "Transactions", tabs: [] },
  { label: "Assets", nav: "Assets", tabs: [] },
  { label: "Customers", nav: "Customers", tabs: [] },
  { label: "Suppliers", nav: "Suppliers", tabs: [] },
  { label: "Employees", nav: "Employees", tabs: [] },
  { label: "Finance & Reports", nav: "Finance", tabs: [] },
  { label: "Customer Orders", nav: "Orders", tabs: [] },
  { label: "Audit Center", nav: "Audit", tabs: [] },
];

const MODULE_TABS = /^(Dashboard|Overview|Products?|Products? & Stock|Stock|Stock & .*|Inventory|Sales|Orders?|Orders? & .*|Finance.*|Reports?.*|Customers?.*|Staff.*|Checklist|Deliveries|Serials|Warranty|Bookings|Services|Washes|Lines|Expenses|Payments|Menu|Kitchen|Fleet|Trips|Tracking|Sizes.*|Benchmark|Insights|Jobs|Bookings.*|Attendance|Payroll)$/i;

/** Candidate "open a form" buttons, with a skip-list for in-form mutators. */
const OPENER_SKIP = /(?:^|-)(?:add-(?:row|item|metric|line|column)|new-(?:row|item|line|error|result|total|submit|cancel|done|pin|customer|dest|discount|fulfillment|note|phone|copy|code|biz|btn|root|maplink)|open-(?:since|btn|console)|save|submit)(?:-|$)/;
const MODALS = process.env.MODALS === "1";

async function collectOpeners(page) {
  return page.evaluate(() => {
    const out = [];
    for (const b of document.querySelectorAll("main button[data-testid], main a[data-testid]")) {
      const id = b.getAttribute("data-testid") || "";
      if (!/(?:^|-)(?:open|new|add)(?:-|$)/.test(id)) continue;
      const t = (b.textContent || "").trim();
      if (!/(new|add|register|record|log|open|create|offer|method|order|sale|expense|asset|supplier|customer|employee|shift|booking|wash|service|package|vehicle|trip|formula|recipe|plan|note)/i.test(`${id} ${t}`)) continue;
      out.push({ id, text: t.slice(0, 30) });
    }
    // De-duplicate by testid, keep order.
    const seen = new Set();
    return out.filter((o) => (seen.has(o.id) ? false : (seen.add(o.id), true)));
  });
}

async function closeOverlay(page) {
  await page.keyboard.press("Escape");
  await sleep(500);
  const still = await page.evaluate(() => !!document.querySelector('main div.fixed, main [role="dialog"]'));
  if (!still) return true;
  const clicked = await page.evaluate(() => {
    const overlay = document.querySelector('main div.fixed, main [role="dialog"]');
    if (!overlay) return false;
    const btns = [...overlay.querySelectorAll("button")];
    const closeBtn = btns.find((b) => /^(close|cancel|✕|×|x)$/i.test((b.textContent || "").trim()) || /close|cancel/i.test(b.getAttribute("aria-label") || "") || /-(close|cancel)$/.test(b.getAttribute("data-testid") || ""));
    if (!closeBtn) return false;
    closeBtn.click();
    return true;
  });
  await sleep(600);
  const gone = await page.evaluate(() => !document.querySelector('main div.fixed, main [role="dialog"]'));
  return clicked && gone;
}

const filterPages = process.env.PAGES ? process.env.PAGES.split(",").map((s) => s.trim().toLowerCase()) : null;
const keep = (label) => !filterPages || filterPages.some((f) => label.toLowerCase().includes(f));

let page;
let testedTabs = 0;
try {
  page = await browser.newPage();
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e.message || e).slice(0, 160)));
  await login(page);

  // N5: the rail previews 5 units and reveals the rest with "Show all N units"
  // (one scroll container instead of a nested scroll box). Expand it first so
  // this suite still scans EVERY unit page, exactly as before.
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="nav-biz-show-all"]');
    if (btn && btn.textContent.includes("Show all")) btn.click();
  });
  await sleep(600);
  const units = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="nav-sidebar"] [data-biz-code]')].map((b) => ({
      code: b.getAttribute("data-biz-code"),
      name: (b.textContent || "").trim().split("\n")[0].slice(0, 60),
    })),
  );
  if (units.length === 0) console.log("   (no business chips found in the sidebar — unit pages skipped)");

  for (const vpName of VIEWPORTS) {
    const vp = VP[vpName];
    if (!vp) continue;
    await page.setViewport({ width: vp.width, height: vp.height });
    await sleep(400);

    for (const p of SHARED_PAGES) {
      if (!keep(p.label)) continue;
      const clicked = await clickSidebar(page, p.nav);
      if (!clicked) {
        console.log(`   (skip ${p.label}: nav not found)`);
        continue;
      }
      await sleep(1600);
      const probe = await page.evaluate(probeOverflow);
      push({ viewport: vpName, viewportLabel: vp.label, page: p.label, tab: null, ...probe });
      await page.screenshot({ path: `${OUT}resp-${vpName}-${p.label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png` });
    }

    // Business units (all business types) + their module tabs.
    for (const unit of units) {
      const clean = unit.name.replace(/\s+/g, " ").trim();
      if (!keep(clean)) continue;
      const clicked = await page.evaluate((code) => {
        const btn = document.querySelector(`[data-testid="nav-sidebar"] [data-biz-code="${code}"]`);
        if (!btn || btn.disabled) return false;
        btn.click();
        return true;
      }, unit.code);
      if (!clicked) continue;
      await sleep(2200);
      const mainProbe = await page.evaluate(probeOverflow);
      push({ viewport: vpName, viewportLabel: vp.label, page: clean, tab: "default", ...mainProbe });
      await page.screenshot({ path: `${OUT}resp-${vpName}-${clean.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png` });

      // Click through the module's tabs (generic, text-matched).
      const tabLabels = await page.evaluate(() =>
        [
          ...new Set(
            [...document.querySelectorAll("main button, main [role='tab']")]
              .map((b) => (b.textContent || "").trim())
              .filter((t) => t.length > 1 && t.length < 26),
          ),
        ],
      );
      const wanted = tabLabels.filter((t) => MODULE_TABS.test(t)).slice(0, 12);
      for (const tab of wanted) {
        const ok = await clickTab(page, `^${tab.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
        if (!ok) continue;
        await sleep(1400);
        const probe = await page.evaluate(probeOverflow);
        testedTabs++;
        if (probe.offenders.length === 0 && !probe.pageOverflows && !probe.wideTablesWithoutScroller.length) continue; // keep the report focused
        push({ viewport: vpName, viewportLabel: vp.label, page: clean, tab, ...probe });
      }
    }
  }

  // ── Modal / drawer pass: form dialogs are fixed overlays, so they are
  // measured against the window. Run after the page sweep to keep it stable.
  if (MODALS) {
    const targets = [
      ...SHARED_PAGES.filter((p) => keep(p.label)).map((p) => ({ kind: "nav", label: p.label, nav: p.nav })),
      ...units.filter((u) => keep(u.name)).map((u) => ({ kind: "unit", label: u.name, code: u.code })),
    ];
    for (const vpName of VIEWPORTS) {
      const vp = VP[vpName];
      if (!vp) continue;
      await page.setViewport({ width: vp.width, height: vp.height });
      await sleep(400);
      for (const t of targets) {
        const go = async () => {
          if (t.kind === "nav") return clickSidebar(page, t.nav);
          return page.evaluate((code) => {
            const btn = document.querySelector(`[data-testid="nav-sidebar"] [data-biz-code="${code}"]`);
            if (!btn || btn.disabled) return false;
            btn.click();
            return true;
          }, t.code);
        };
        if (!(await go())) continue;
        await sleep(2200);
        const openers = (await collectOpeners(page)).filter((o) => !OPENER_SKIP.test(o.id)).slice(0, 4);
        for (const opener of openers) {
          const clicked = await page.evaluate((id) => {
            const b = document.querySelector(`main [data-testid="${id}"]`);
            if (!b || b.disabled) return false;
            b.click();
            return true;
          }, opener.id);
          if (!clicked) continue;
          await sleep(1200);
          const opened = await page.evaluate(() => !!document.querySelector('main div.fixed, main [role="dialog"]'));
          if (!opened) continue;
          testedTabs++;
          const probe = await page.evaluate(probeOverflow, { scope: "modal" });
          const entry = { viewport: vpName, viewportLabel: vp.label, page: t.label, tab: `modal:${opener.id}`, ...probe };
          if (probe.offenders.length || probe.pageOverflows || probe.wideTablesWithoutScroller.length) push(entry);
          await page.screenshot({
            path: `${OUT}resp-${vpName}-modal-${opener.id.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`,
          });
          await closeOverlay(page);
        }
        await closeOverlay(page);
      }
    }
  }

  const counts = await page.evaluate(probeCounts);
  console.log(`\ntables on last page=${counts.tables} without scroller=${counts.tablesWithoutScroller} cards=${counts.cards}`);
  const tablesScanned = results.reduce((n, r) => n + (r.tables || 0), 0);
  const wideTableIssues = results.flatMap((r) => r.wideTablesWithoutScroller || []);
  console.log(`tables checked=${tablesScanned}  wide-without-scroller=${wideTableIssues.length}`);
  fs.writeFileSync(
    REPORT,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), coverage: { pageViews: results.length + testedTabs, testedTabs }, results, consoleErrors },
      null,
      1,
    ),
  );
  const bad = results.filter((r) => (r.offenders?.length || 0) > 0 || r.pageOverflows || (r.wideTablesWithoutScroller?.length || 0) > 0);
  console.log(`\n${bad.length === 0 ? "✅ responsive audit clean" : `⚠️  ${bad.length} page/viewport combination(s) with issues`} — report: ${REPORT}`);
  console.log(`page views scanned: ${results.length} clean + ${testedTabs} module tabs clicked`);
} finally {
  await browser.close().catch(() => {});
}
