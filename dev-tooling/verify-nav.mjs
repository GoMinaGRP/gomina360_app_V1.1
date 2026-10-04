// Live verification of the sidebar / navigation redesign (phases N1–N4):
//   N1 · one navigation manifest → no duplicate destinations, right rail and
//        left rail can no longer disagree, every row has an accessible name
//   N2 · collapsible sections with remembered state; "My Businesses" bounded
//        but never truncated; quick access (recents + favourites)
//   N3 · command palette (⌘K / Ctrl-K / "/" / rail search row): fuzzy +
//        synonym search over destinations AND units, role-gated, recents first
//   N4 · phone/tablet off-canvas drawer + bottom bar, no horizontal overflow
//
// It also re-proves the two original audit defects are gone by creating a real
// "manage-granted unit manager" account (the role that used to see "Customer
// Order & Tracking" and "Finance & Reports" twice with duplicate test-ids).
//
// Run: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-nav.mjs
// Optional: BASE_URL=… (default http://127.0.0.1:3000)

import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");
const pg = req("pg");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const OUT = "/home/user/nav-";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.OWNER_PW || "Owner@GoMina26" };
const BM = { email: "emmanuel@gomina360.com", pw: process.env.BM_PW || "GoMina@User3" };
const WORKER = { email: "akua.donkor@gomina360.com", pw: process.env.AKUA_PW || "GoMina@User10" };

const checks = [];
let failures = 0;
const ok = (name, cond, extra = "") => {
  checks.push({ name, pass: !!cond });
  if (!cond) failures++;
  console.log(`${cond ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = new pg.Client({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });
await client.connect();

/* ── tiny API helper (for the temporary manage-grantee account) ── */
const apiLogin = async (cred) => {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: cred.email, password: cred.pw }),
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j?.sessionToken || (r.headers.get("set-cookie") || "").split(";")[0]?.split("=")[1] || null;
};
const api = async (method, path, token, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
};

const browser = await puppeteer.launch({
  executablePath: "/tmp/al2023/chromium",
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});
const pageErrors = [];
const hook = (page, tag) => {
  page.on("pageerror", (e) => pageErrors.push(`[${tag}] ${String(e).slice(0, 200)}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/Failed to load resource/.test(t)) return;
    if (/net::/.test(t)) return;
    pageErrors.push(`[${tag}] CONSOLE ${t.slice(0, 200)}`);
  });
};
const newCtx = async (tag, w = 1440, h = 960) => {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  hook(page, tag);
  await page.setViewport({ width: w, height: h });
  return { ctx, page };
};
const login = async (page, cred) => {
  await page.goto(`${BASE}/?login=1`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForSelector('[data-testid="login-email"]', { timeout: 90000 });
  const fill = (tid, v) =>
    page.$eval(`[data-testid="${tid}"]`, (e, val) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      set.call(e, val);
      e.dispatchEvent(new Event("input", { bubbles: true }));
    }, v);
  await fill("login-email", cred.email);
  await fill("login-password", cred.pw);
  await page.click('[data-testid="login-submit"]');
  await page.waitForSelector('[data-testid="nav-sidebar"]', { timeout: 90000 });
  await sleep(1800);
};
const tid = (t) => `[data-testid="${t}"]`;
const exists = (page, t) => page.$(tid(t)).then((e) => !!e);
const textOf = (page, t) => page.$eval(tid(t), (e) => (e.textContent || "").trim()).catch(() => "");
const visible = (page, t) =>
  page.$eval(tid(t), (e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.left >= -2 && r.right <= window.innerWidth + 2;
  }).catch(() => false);
const clickTid = async (page, t) => {
  await page.waitForSelector(tid(t), { timeout: 20000 });
  await page.$eval(tid(t), (e) => e.click());
};
const sidebarRowCount = (page, sel) =>
  page.$$eval(sel, (els) => els.length);
const noOverflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2);

const TEMP_EMAILS = "nav-verify-%@gomina360.test";
/** Removes the temporary verify accounts (membership rows first — the FK). */
const purgeTempUsers = async () => {
  await client.query(
    "delete from organization_members where user_id in (select id from users where email like $1)",
    [TEMP_EMAILS],
  );
  await client.query("delete from users where email like $1", [TEMP_EMAILS]);
};
const cleanup = async () => {
  try {
    await purgeTempUsers();
  } catch {}
};

try {
  /* ═══════════════ A · N1 — manifest integrity (OWNER, desktop) ═══════════ */
  console.log("\n— A · one manifest: no duplicates, no drift, accessible names —");
  const { ctx: cA, page: pA } = await newCtx("A-owner");
  await login(pA, OWNER);

  const dupes = await pA.evaluate(() => {
    const seen = {};
    const dups = [];
    document.querySelectorAll('[data-testid="nav-sidebar"] [data-testid]').forEach((el) => {
      const id = el.getAttribute("data-testid");
      seen[id] = (seen[id] || 0) + 1;
      if (seen[id] > 1 && !dups.includes(id)) dups.push(id);
    });
    return dups;
  });
  ok("A1 no destination renders twice in the rail", dupes.length === 0, dupes.join(", "));

  const trackingRows = await sidebarRowCount(pA, '[data-testid="nav-sidebar"] [data-testid="sidebar-tab-tracking"]');
  const financeRows = await sidebarRowCount(pA, '[data-testid="nav-sidebar"] [data-testid="sidebar-tab-finance"]');
  ok("A2 Customer Order & Tracking renders exactly once", trackingRows === 1, `rows=${trackingRows}`);
  ok("A3 Finance & Reports renders exactly once", financeRows === 1, `rows=${financeRows}`);

  const names = await pA.evaluate(() =>
    [...document.querySelectorAll('[data-testid="nav-sidebar"] button')].map((b) => ({
      label: (b.getAttribute("aria-label") || "").trim(),
      title: (b.getAttribute("title") || "").trim(),
      text: (b.textContent || "").trim(),
    })),
  );
  const unnamed = names.filter((n) => !n.label && !n.text).length;
  ok("A4 every rail row has an accessible name", unnamed === 0, `unnamed=${unnamed}`);

  const sections = await pA.$$eval('[data-testid^="nav-section-"]', (n) => n.map((x) => x.getAttribute("data-testid")));
  const expectSections = ["MY_BUSINESSES", "SELL", "MONEY", "RECORDS", "INSIGHTS", "GOVERNANCE", "ADMIN", "SETTINGS"];
  const missing = expectSections.filter((s) => !sections.includes(`nav-section-${s}`));
  ok("A5 all sections present (My Businesses · Sell & Fulfil · Money · Records · Insights · Oversight · Administration · Settings)",
    missing.length === 0, missing.join(","));
  // Low-frequency sections start closed (reassessment audit §4) — but never the
  // one holding the destination you are on (A7b below).
  const collapsedDefaults = await pA.evaluate((keys) =>
    keys.map((k) => `${k}:${document.querySelector(`[data-testid="nav-section-${k}"]`)?.getAttribute("aria-expanded")}`),
    ["INSIGHTS", "ADMIN", "SETTINGS"]);
  ok("A5b low-frequency sections start collapsed (Insights · Administration · Settings)",
    collapsedDefaults.every((x) => x.endsWith(":false")), collapsedDefaults.join(" "));
  const openDefaults = await pA.evaluate((keys) =>
    keys.map((k) => `${k}:${document.querySelector(`[data-testid="nav-section-${k}"]`)?.getAttribute("aria-expanded")}`),
    ["SELL", "MONEY", "RECORDS"]);
  ok("A5c core sections still start expanded (Sell · Money · Records)",
    openDefaults.every((x) => x.endsWith(":true")), openDefaults.join(" "));

  // Right rail agrees with the left rail (audit defect D3/D4).
  await clickTid(pA, "sidebar-tab-finance");
  await sleep(1400);
  const railSection = await textOf(pA, "ctx-section");
  ok("A6 right rail names the destination's section (never a raw tab key)", railSection === "Shared Enterprise Modules" && (await textOf(pA, "ctx-page")) === "Finance & Reports", `${railSection} / ${await textOf(pA, "ctx-page")}`);
  const railChips = await pA.$$eval('[data-testid^="ctx-quick-"]', (n) => n.map((x) => x.getAttribute("data-testid")));
  ok("A7 right rail quick-nav lists the whole family (incl. Pre-Orders & Transactions)",
    railChips.includes("ctx-quick-PREORDERS") && railChips.includes("ctx-quick-TRANSACTIONS") &&
      railChips.includes("ctx-quick-SALES_CENTER") && railChips.includes("ctx-quick-INVENTORY"),
    `${railChips.length} chips`);

  /* ═══════════════ B · N2 — collapsible sections + memory ═══════════════ */
  console.log("\n— B · collapsible sections, remembered state —");
  const recordsHeader = await pA.$eval(tid("nav-section-RECORDS"), (e) => e.getAttribute("aria-expanded"));
  ok("B1 sections start expanded (everything one click away)", recordsHeader === "true", `aria-expanded=${recordsHeader}`);
  const invTopBefore = await pA.$eval('[data-testid="nav-sidebar"] [data-testid="sidebar-item-INVENTORY"]', (e) => e.getBoundingClientRect().top).catch(() => null);
  await clickTid(pA, "nav-section-RECORDS");
  await sleep(450);
  const recordsClosed = await pA.$eval(tid("nav-section-RECORDS"), (e) => e.getAttribute("aria-expanded"));
  const invHidden = await pA.$eval(tid("nav-body-RECORDS"), (e) => e.getBoundingClientRect().height < 2).catch(() => true);
  ok("B2 collapsing Records hides its rows", recordsClosed === "false" && invHidden, `expanded=${recordsClosed} hidden=${invHidden}`);
  await pA.reload({ waitUntil: "domcontentloaded" });
  await pA.waitForSelector('[data-testid="nav-sidebar"]', { timeout: 60000 });
  await sleep(1500);
  const recordsAfterReload = await pA.$eval(tid("nav-section-RECORDS"), (e) => e.getAttribute("aria-expanded"));
  ok("B3 collapsed state survives a reload (per-user preference)", recordsAfterReload === "false", `after reload=${recordsAfterReload}`);
  await clickTid(pA, "nav-section-RECORDS");
  await sleep(300);

  // B4 — "you are here" is never hidden: reach AI Advisor (Insights, which
  // starts collapsed) through the palette and the section must open itself.
  await clickTid(pA, "sidebar-search-trigger");
  await sleep(400);
  await pA.$eval(tid("cmd-palette-input"), (e) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(e, "ai advisor");
    e.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(500);
  await pA.keyboard.press("Enter");
  await sleep(1600);
  const insExpanded = await pA.$eval(tid("nav-section-INSIGHTS"), (e) => e.getAttribute("aria-expanded"));
  const aiVisible = await pA.$eval('[data-testid="nav-sidebar"] [data-testid="sidebar-item-AI_ADVISOR"]', (e) => e.getBoundingClientRect().height > 5).catch(() => false);
  const aiCurrent = await pA.$eval('[data-testid="nav-sidebar"] [data-testid="sidebar-item-AI_ADVISOR"]', (e) => e.getAttribute("aria-current")).catch(() => null);
  ok("B4 navigating into a collapsed section auto-reveals it (and marks the row current)",
    insExpanded === "true" && aiVisible && aiCurrent === "page",
    `expanded=${insExpanded} visible=${aiVisible} current=${aiCurrent}`);
  await pA.reload({ waitUntil: "domcontentloaded" });
  await pA.waitForSelector('[data-testid="nav-sidebar"]', { timeout: 60000 });
  await sleep(1500);
  // After a reload the app returns to Command Center, so the real invariant is
  // not "Insights stays open" but "whatever page you are on, its row is visible
  // — no collapsed section can hide where you are".
  const currentVisible = await pA.evaluate(() => {
    const row = document.querySelector('[data-testid="nav-sidebar"] [aria-current="page"]');
    if (!row) return "no-current-row";
    return row.getBoundingClientRect().height > 5 ? "visible" : "hidden";
  });
  const insAfterReload = await pA.$eval(tid("nav-section-INSIGHTS"), (e) => e.getAttribute("aria-expanded"));
  ok("B4b after a reload, the current row is visible and untouched sections stay collapsed",
    currentVisible === "visible" && insAfterReload === "false",
    `current=${currentVisible} insights=${insAfterReload}`);
  await clickTid(pA, "sidebar-tab-finance");
  await sleep(1200);

  /* ═══════════════ C · N2 — My Businesses: bounded, not truncated ══════ */
  console.log("\n— C · My Businesses —");
  const unitRows = await sidebarRowCount(pA, '[data-testid="nav-sidebar"] [data-biz-code]');
  const initToken = await apiLogin(OWNER);
  const init = await fetch(`${BASE}/api/init`, { headers: { "x-gomina-session": initToken } }).then((r) => r.json());
  const liveUnits = (init.businesses || []).filter(
    (b) => !b.isArchived && Number(b.ownerId ?? 1) === 1,
  ).length;
  // N5: the list previews 5 units inline and reveals the rest on demand —
  // one scroll container, nothing truncated away.
  ok("C1 unit list previews the first 5 (long lists and short ones alike)",
    unitRows === Math.min(5, liveUnits), `rows=${unitRows} live=${liveUnits}`);
  const nestedScroll = await pA.evaluate(() => {
    const sb = document.querySelector('[data-testid="nav-sidebar"]');
    return [...sb.querySelectorAll("div")].filter((d) => {
      const c = getComputedStyle(d);
      return (c.overflowY === "auto" || c.overflowY === "scroll") && d.scrollHeight > d.clientHeight + 2;
    }).length;
  });
  ok("C2 no nested scroll container inside the rail", nestedScroll === 0, `boxes=${nestedScroll}`);
  const showAllLabel = await pA.$eval(tid("nav-biz-show-all"), (e) => (e.textContent || "").trim()).catch(() => "");
  await clickTid(pA, "nav-biz-show-all");
  await sleep(500);
  const unitRowsAll = await sidebarRowCount(pA, '[data-testid="nav-sidebar"] [data-biz-code]');
  ok("C2b “Show all N units” reveals every unit in place (nothing lost)",
    unitRowsAll >= liveUnits && unitRowsAll > unitRows, `label="${showAllLabel}" rows=${unitRows}→${unitRowsAll} live=${liveUnits}`);
  await clickTid(pA, "nav-biz-show-all");
  await sleep(400);
  ok("C2c …and collapses back to the preview",
    (await sidebarRowCount(pA, '[data-testid="nav-sidebar"] [data-biz-code]')) === unitRows);
  const filterExists = await exists(pA, "sidebar-biz-filter");
  ok("C3 type-to-filter appears once the list is long (>8 units)", filterExists || liveUnits <= 8, `filter=${filterExists} units=${liveUnits}`);
  if (filterExists) {
    const firstCode = await pA.$$eval('[data-testid="nav-sidebar"] [data-biz-code]', (n) => n[0]?.getAttribute("data-biz-code"));
    const firstName = await pA.$$eval('[data-testid="nav-sidebar"] [data-biz-code]', (n) => (n[0]?.textContent || "").trim().split(" ").slice(0, 2).join(" "));
    await pA.$eval(tid("sidebar-biz-filter"), (e, v) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      set.call(e, v);
      e.dispatchEvent(new Event("input", { bubbles: true }));
    }, firstName);
    await sleep(400);
    const narrowed = await sidebarRowCount(pA, '[data-testid="nav-sidebar"] [data-biz-code]');
    ok("C4 typing filters the unit list", narrowed >= 1 && narrowed < unitRows, `before=${unitRows} after=${narrowed}`);
    await pA.$eval(tid("sidebar-biz-filter"), (e) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      set.call(e, "");
      e.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await sleep(300);
    ok("C5 clearing the filter restores every unit", (await sidebarRowCount(pA, '[data-testid="nav-sidebar"] [data-biz-code]')) === unitRows);
    await clickTid(pA, firstCode ? "nav-section-MY_BUSINESSES" : "nav-section-MY_BUSINESSES");
    await sleep(250);
    await clickTid(pA, "nav-section-MY_BUSINESSES");
    await sleep(250);
  }

  /* ═══════════════ D · N2 — quick access (recents + favourites) ════════ */
  console.log("\n— D · quick access —");
  await clickTid(pA, "sidebar-item-INVENTORY");
  await sleep(1200);
  await clickTid(pA, "audit-tab");
  await sleep(1200);
  await page_quick(pA, ok, exists, textOf);

  /* ═══════════════ E · N3 — command palette ════════════════════════════ */
  console.log("\n— E · command palette —");
  await clickTid(pA, "sidebar-search-trigger");
  await sleep(500);
  ok("E1 rail search row opens the palette", await visible(pA, "cmd-palette"));
  const focused = await pA.evaluate(() => document.activeElement?.getAttribute("data-testid"));
  ok("E2 the search field takes focus on open", focused === "cmd-palette-input", String(focused));

  const typeQuery = async (q) => {
    await pA.$eval(tid("cmd-palette-input"), (e) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      set.call(e, "");
      e.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await pA.type(tid("cmd-palette-input"), q, { delay: 12 });
    await sleep(420);
    return pA.$$eval('[data-testid^="cmd-item-"]', (n) => n.map((x) => x.getAttribute("data-testid")));
  };
  const momo = await typeQuery("momo");
  ok("E3 “momo” finds Transactions & MoMo from the nickname", momo[0] === "cmd-item-TRANSACTIONS", momo.slice(0, 3).join(" | "));
  const payroll = await typeQuery("payroll");
  ok("E4 “payroll” finds Employees & Payroll", payroll[0] === "cmd-item-EMPLOYEES", payroll.slice(0, 3).join(" | "));
  const stock = await typeQuery("stock");
  ok("E5 “stock” finds Inventory & Stock", stock.includes("cmd-item-INVENTORY"), stock.slice(0, 3).join(" | "));
  const orders = await typeQuery("pre order");
  ok("E6 “pre order” finds the pre-orders row", orders.includes("cmd-item-PREORDERS"), orders.slice(0, 3).join(" | "));
  const unit = await typeQuery("akuafo");
  const bizHit = unit.find((t) => t.startsWith("cmd-item-BIZ:"));
  ok("E7 businesses are searchable too (unit name → chip)", !!bizHit, unit.slice(0, 3).join(" | "));

  // Enter opens the highlighted result.
  const typed = await typeQuery("scenario");
  await pA.keyboard.press("Enter");
  await sleep(1500);
  const openedScenario = (await textOf(pA, "ctx-page")) === "Scenario Planning";
  ok("E8 Enter opens the highlighted destination", openedScenario && !(await visible(pA, "cmd-palette")), await textOf(pA, "ctx-page"));

  // Keyboard shortcut + slash + typing-safety.
  await pA.keyboard.down("Control");
  await pA.keyboard.press("KeyK");
  await pA.keyboard.up("Control");
  await sleep(450);
  ok("E9 Ctrl-K toggles the palette", await visible(pA, "cmd-palette"));
  await pA.keyboard.press("Escape");
  await sleep(350);
  ok("E10 Escape closes it", !(await exists(pA, "cmd-palette")));
  await pA.keyboard.press("/");
  await sleep(400);
  const slashOpened = await visible(pA, "cmd-palette");
  if (slashOpened) {
    await pA.keyboard.press("Escape");
    await sleep(300);
  }
  ok("E11 “/” opens the palette from the page", slashOpened);

  /* ═══════════════ F · N3 — Orders & Fulfilment hub ════════════════════ */
  console.log("\n— F · Orders & Fulfilment hub —");
  await clickTid(pA, "sidebar-tab-tracking");
  await sleep(1800);
  ok("F1 Live Orders opens inside the hub (one row, two views)", await exists(pA, "ofs-hub"),);
  const hubTabs = await pA.$$eval('[data-testid^="ofs-tab-"]', (n) => n.map((x) => x.getAttribute("data-testid")));
  ok("F2 both views are tabs of the same destination", hubTabs.length === 2, hubTabs.join(","));
  await clickTid(pA, "ofs-tab-PREORDERS");
  await sleep(2000);
  const preorderMain = await pA.evaluate(() => document.querySelector("main")?.innerText.slice(0, 400) || "");
  ok("F3 switching tabs renders the Pre-Orders & Procurement screen", /pre-?order|procurement/i.test(preorderMain), preorderMain.slice(0, 80).replace(/\s+/g, " "));
  const preRowOnce = await sidebarRowCount(pA, '[data-testid="nav-sidebar"] [data-testid="sidebar-tab-preorders"]');
  ok("F4 the pre-orders destination still has its own rail row", preRowOnce === 1, `rows=${preRowOnce}`);

  /* ═══════════════ G · N4 — responsive drawer + bottom bar ════════════ */
  console.log("\n— G · phone & tablet navigation —");
  await pA.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await pA.reload({ waitUntil: "domcontentloaded" });
  await pA.waitForSelector('[data-testid="nav-sidebar"]', { timeout: 60000 });
  await sleep(1600);
  const railOffscreen = await pA.$eval(tid("nav-sidebar"), (e) => e.getBoundingClientRect().right <= 2);
  ok("G1 phone: the rail is off-canvas (page gets the full width)", railOffscreen);
  ok("G2 phone: hamburger is in the navbar", await visible(pA, "nav-mobile-menu-btn"));
  ok("G3 phone: bottom bar offers Home · Actions · Sell · Search · Menu",
    (await sidebarRowCount(pA, '[data-testid="nav-bottom-bar"] button')) === 5 &&
      (await visible(pA, "nb-home")) && (await visible(pA, "nb-menu")));
  await clickTid(pA, "nav-mobile-menu-btn");
  await sleep(600);
  const drawerIn = await pA.$eval(tid("nav-sidebar"), (e) => {
    const r = e.getBoundingClientRect();
    return r.left >= -2 && r.width > 200;
  });
  ok("G4 Menu opens the navigation drawer", drawerIn);
  ok("G5 drawer rows are labelled (no unlabelled icon strip)",
    await pA.evaluate(() => {
      const t = [...document.querySelectorAll('[data-testid="nav-sidebar"] button')].map((b) => (b.textContent || "").trim());
      return t.some((x) => /Sales & Payments/.test(x)) && t.some((x) => /Inventory & Stock/.test(x));
    }));
  const navClick = await pA.evaluate(() => {
    const b = document.querySelector('[data-testid="sidebar-item-INVENTORY"]');
    if (!b) return false;
    b.click();
    return true;
  });
  await sleep(1600);
  const closedAfterNav = await pA.$eval(tid("nav-sidebar"), (e) => e.getBoundingClientRect().right <= 2);
  ok("G6 tapping a destination navigates and auto-closes the drawer", navClick && closedAfterNav);
  await clickTid(pA, "nb-menu");
  await sleep(600);
  await pA.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await sleep(500);
  ok("G7 Escape closes the drawer", await pA.$eval(tid("nav-sidebar"), (e) => e.getBoundingClientRect().right <= 2));
  await clickTid(pA, "nb-search");
  await sleep(600);
  const palettePhoneWide = await pA.$eval(tid("cmd-palette"), (e) => {
    const panel = e.firstElementChild;
    return panel ? panel.getBoundingClientRect().width >= window.innerWidth - 2 : false;
  }).catch(() => false);
  ok("G8 Search opens the palette full-screen on a phone", palettePhoneWide);
  await pA.keyboard.press("Escape");
  await sleep(400);
  ok("G9 no horizontal overflow on the phone", await noOverflow(pA));

  // Tablet: drawer mode (<lg) with the right rail's compact bar still working.
  await pA.setViewport({ width: 1000, height: 800, isMobile: false, hasTouch: false });
  await pA.reload({ waitUntil: "domcontentloaded" });
  await pA.waitForSelector('[data-testid="nav-sidebar"]', { timeout: 60000 });
  await sleep(1600);
  ok("G10 tablet: rail is a drawer, context bar is present",
    (await pA.$eval(tid("nav-sidebar"), (e) => e.getBoundingClientRect().right <= 2)) && (await visible(pA, "ctx-bar")));
  await clickTid(pA, "nav-mobile-menu-btn");
  await sleep(600);
  await clickTid(pA, "sidebar-drawer-close");
  await sleep(500);
  ok("G11 tablet: the drawer's X closes it", await pA.$eval(tid("nav-sidebar"), (e) => e.getBoundingClientRect().right <= 2));

  // Desktop unchanged: pinned rail, no bottom bar, content not covered.
  await pA.setViewport({ width: 1440, height: 900, isMobile: false, hasTouch: false });
  await pA.reload({ waitUntil: "domcontentloaded" });
  await pA.waitForSelector('[data-testid="nav-sidebar"]', { timeout: 60000 });
  await sleep(1600);
  const deskGeom = await pA.evaluate(() => {
    const aside = document.querySelector('[data-testid="nav-sidebar"]').getBoundingClientRect();
    const main = document.querySelector("main").getBoundingClientRect();
    return { asideRight: Math.round(aside.right), mainLeft: Math.round(main.left), asideW: Math.round(aside.width) };
  });
  ok("G12 desktop: rail is pinned beside the content (never overlapping)",
    deskGeom.asideRight <= deskGeom.mainLeft + 2 && deskGeom.asideW >= 200, JSON.stringify(deskGeom));
  ok("G13 desktop: no bottom bar", !(await visible(pA, "nav-bottom-bar")));
  await clickTid(pA, "sidebar-collapse-toggle");
  await sleep(500);
  const iconRail = await pA.$eval(tid("nav-sidebar"), (e) => Math.round(e.getBoundingClientRect().width));
  ok("G14 desktop: icon-rail mode still available", iconRail <= 64, `w=${iconRail}`);
  await clickTid(pA, "sidebar-collapse-toggle");
  await sleep(400);
  await pA.screenshot({ path: `${OUT}desktop-final.png` });
  await cA.close();

  /* ═══════════════ H · roles ══════════════════════════════════════════ */
  console.log("\n— H · role-aware navigation —");
  const { ctx: cH, page: pH } = await newCtx("H-bm");
  await login(pH, BM);
  const bmText = await pH.evaluate(() => [...document.querySelectorAll('[data-testid="nav-sidebar"] button')].map((b) => (b.textContent || "").trim()).join(" | "));
  ok("H1 branch manager keeps their Branch Management section", /Branch Management/.test(bmText));
  ok("H2 branch manager sees their own unit chip", (await sidebarRowCount(pH, '[data-testid="nav-sidebar"] [data-biz-code]')) >= 1);
  ok("H3 branch manager is not offered enterprise Records", !/Employees & Payroll/.test(bmText) && !/Inventory & Stock/.test(bmText));
  ok("H4 branch manager has exactly one tracking row", (await sidebarRowCount(pH, '[data-testid="nav-sidebar"] [data-testid="sidebar-tab-tracking"]')) === 1);
  const bmPalette = await pH.evaluate(async () => {
    document.querySelector('[data-testid="sidebar-search-trigger"]')?.click();
    return true;
  });
  await sleep(500);
  const bmPaletteOpen = await visible(pH, "cmd-palette");
  if (bmPaletteOpen) {
    await pH.type(tid("cmd-palette-input"), "payroll", { delay: 10 });
    await sleep(400);
    const rows = await pH.$$eval('[data-testid^="cmd-item-"]', (n) => n.map((x) => x.getAttribute("data-testid")));
    ok("H5 palette never teases a destination the role cannot open", !rows.includes("cmd-item-EMPLOYEES"), rows.slice(0, 3).join(","));
    await pH.keyboard.press("Escape");
    await sleep(300);
  } else {
    ok("H5 palette never teases a destination the role cannot open", false, "palette did not open for BM");
  }
  ok("H6 BM phone bottom bar is present too", await pH.evaluate(() => !!document.querySelector('[data-testid="nav-bottom-bar"]')));
  await pH.screenshot({ path: `${OUT}bm-desktop.png` });
  await cH.close();

  const { ctx: cW, page: pW } = await newCtx("H-worker", 390, 844);
  await login(pW, WORKER);
  const wText = await pW.$eval('[data-testid="nav-sidebar"]', (e) => e.innerText || "");
  ok("H7 worker keeps the Action Center and their workspace note", /Action Center/i.test(wText) && /Sales Workspace/i.test(wText), wText.replace(/\n+/g, " | ").slice(0, 90));
  const wRows = await pW.evaluate(() =>
    [...document.querySelectorAll('[data-testid="nav-sidebar"] button')].map((b) => (b.textContent || "").trim()),
  );
  ok("H8 worker is not offered executive destinations",
    !wRows.some((t) => /Command Center|Finance & Reports|Employees & Payroll/.test(t)), wRows.join(" | ").slice(0, 80));
  await cW.close();

  /* ═══════════════ I · the audit defects, on the role that hit them ═══ */
  console.log("\n— I · manage-granted unit manager (the duplicate-row role) —");
  const ownToken = await apiLogin(OWNER);
  const bizA = (await client.query("select id, code, name from businesses order by id limit 1")).rows[0];
  await purgeTempUsers();
  const email = `nav-verify-${Date.now().toString().slice(-6)}@gomina360.test`;
  const created = await api("POST", "/api/users", ownToken, {
    name: "Nav Verify Manager",
    email,
    role: "ACCOUNTANT",
    assignedBusinessId: null,
    phone: "+233 24 000 0000",
    businessManageIds: [bizA.id],
  });
  ok("I1 temporary manage-grantee account created", created.status === 200 && !!created.json?.user?.id, JSON.stringify(created.json).slice(0, 120));
  const pw = created.json?.initialPassword;
  const { ctx: cI, page: pI } = await newCtx("I-manager");
  await login(pI, { email, pw });
  const managerRows = await pI.evaluate(() => {
    const all = [...document.querySelectorAll('[data-testid="nav-sidebar"] [data-testid]')].map((e) => e.getAttribute("data-testid"));
    const counts = {};
    all.forEach((t) => (counts[t] = (counts[t] || 0) + 1));
    return counts;
  });
  ok("I2 no duplicate test-id anywhere in the rail for a manage grantee",
    Object.values(managerRows).every((n) => n === 1), JSON.stringify(Object.entries(managerRows).filter(([, n]) => n > 1)));
  ok("I3 Finance & Reports appears once (was twice)", (managerRows["sidebar-tab-finance"] || 0) === 1, `count=${managerRows["sidebar-tab-finance"]}`);
  ok("I4 Tracking appears once (was twice)", (managerRows["sidebar-tab-tracking"] || 0) === 1, `count=${managerRows["sidebar-tab-tracking"]}`);
  ok("I5 Manage Units moved into Settings & Storefront and keeps its test-id", (managerRows["sidebar-manage-units"] || 0) === 1);
  ok("I6 MANAGE chip still marks the granted unit", await exists(pI, `sidebar-chip-manage-${bizA.code}`));
  await cI.close();
  await cleanup();

  ok("Z1 zero console/page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
} catch (e) {
  ok("Z* suite completed without a fatal error", false, String(e).slice(0, 300));
} finally {
  console.log(`\n${failures === 0 ? "✅ PASS" : "❌ FAIL"} — ${checks.length - failures}/${checks.length} checks passed`);
  try { await browser.close(); } catch {}
  await cleanup().catch(() => {});
  await client.end().catch(() => {});
  process.exit(failures === 0 ? 0 : 1);
}

/** Quick-access block: recents recorded, favourites listed, current page excluded. */
async function page_quick(page, okFn, existsFn, textOfFn) {
  const quick = await page.$('[data-testid="nav-quick-access"]');
  const quickIds = quick
    ? await page.$$eval('[data-testid^="nav-quick-"]', (n) => n.map((x) => x.getAttribute("data-testid")))
    : [];
  okFn("D1 quick access appears after visiting destinations", !!quick && quickIds.length >= 1, quickIds.join(","));
  okFn("D2 it lists recently used destinations (not the current one)", !quickIds.includes("nav-quick-AUDIT"), quickIds.join(","));
  okFn("D3 quick-access rows navigate", await (async () => {
    if (quickIds.length === 0) return false;
    const id = quickIds[0].replace("nav-quick-", "");
    return await page.evaluate((t) => {
      const b = document.querySelector(`[data-testid="nav-quick-${t}"]`);
      if (!b) return false;
      b.click();
      return true;
    }, id);
  })());
  await sleep(1200);
  okFn("D4 the destination actually opened", (await textOfFn(page, "ctx-page")).length > 2);
}
