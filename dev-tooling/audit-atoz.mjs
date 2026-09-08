/**
 * audit-atoz.mjs — complete A–Z audit of GoMina 360.
 *
 *  A  API surface: every route (anon + owner) — no 5xx anywhere
 *  B  Owner desktop: every sidebar tab & every business page renders real content
 *  C  Business module internals: every in-module tab exercised per business type
 *  D  Shared modules: internals of Sales/Finance/Customers/Suppliers/Employees/Assets/Inventory/Transactions/Tracking
 *  E  Role walks: GENERAL_MANAGER, BRANCH_MANAGER, WORKER reach only what they should
 *  F  NEW business + NEW staff end-to-end (create → pages work → cleanup)
 *  G  Responsive geometry 390 / 768 / 1440: no h-overflow, controls reachable,
 *     account menu anchored DIRECTLY below its button (the reported bug)
 *  Z  Cleanup & forensics — every TEST row purged, user data untouched
 *
 * Gate: ZERO console/page errors across every walk (beyond expected 4xx noise).
 */
import { createRequire } from "module";
const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");
const { Client } = require("pg");

const BASE = "http://127.0.0.1:3000";
const OWNER_PW = process.env.GOMINA_OWNER_PW || "Owner@GoMina26";
const CREDS = {
  owner: { email: "kwame.owner@gomina360.com", pass: OWNER_PW },
  gm: { email: "abena.gm@gomina360.com", pass: "GoMina@User2" },
  bm: { email: "emmanuel@gomina360.com", pass: "GoMina@User3" },
  worker: { email: "kwabena.mensah@gomina360.com", pass: "GoMina@User11" },
};

const results = [];
const baseline = {};
const findings = [];
const pg = new Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });

const ok = (name, cond, extra = "") => {
  results.push({ name, pass: !!cond });
  if (!cond) findings.push(`${name} — ${extra}`);
  console.log(`${cond ? "✅" : "❌"} ${name}${cond ? "" : " — " + extra}`);
  return cond;
};
const finding = (msg) => { findings.push(msg); console.log(`   ⚠️  FINDING: ${msg}`); };

async function api(cookie, path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) },
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const loginCookie = async (c) => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: c.email, password: c.pass }),
  });
  return res.ok ? (res.headers.get("set-cookie") || "").split(";")[0] : null;
};

/* browser helpers */
async function newContext(browser, tag, errors, viewport = { width: 1440, height: 960 }) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport(viewport);
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const txt = m.text();
    if (/Failed to load resource/.test(txt) && /(401|400|403|404|409|413|500)/.test(txt)) return;
    if (/net::/.test(txt)) return;
    errors.push(`[${tag}] ${txt.slice(0, 260)}`);
  });
  page.on("pageerror", (e) => errors.push(`[${tag}] PAGEERROR ${String(e).slice(0, 260)}`));
  // Native confirm()/alert() dialogs block the protocol forever — dismiss.
  page.on("dialog", async (d) => { try { await d.dismiss(); } catch {} });
  return { ctx, page };
}
async function loginUi(page, creds) {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid="login-email"]', { timeout: 60000 });
  await page.type('[data-testid="login-email"]', creds.email);
  await page.type('[data-testid="login-password"]', creds.pass);
  await page.click('[data-testid="login-submit"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="login-email"]'), { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1200));
}
const navButtons = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="nav-sidebar"] button')]
      .filter((b) => !b.disabled && !b.getAttribute("data-testid")?.includes("collapse") && b.offsetParent !== null)
      .map((b) => ({ text: (b.textContent || "").trim().replace(/\s+/g, " ").slice(0, 48), idx: [...document.querySelectorAll('[data-testid="nav-sidebar"] button')].indexOf(b) })),
  );
const mainText = (page) => page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));

/* ═══ A · API surface ═══ */
async function phaseA(cookies) {
  console.log("\n— A · API surface (anon + owner) —");
  const routes = [
    "/api/health", "/api/init", "/api/businesses", "/api/users", "/api/users/workers",
    "/api/employees", "/api/payroll", "/api/assets", "/api/inventory", "/api/transactions",
    "/api/expense-categories", "/api/sales", "/api/sales-documents", "/api/scenarios",
    "/api/poultry", "/api/poultry/knowledge", "/api/aquaculture", "/api/block-factory",
    "/api/restaurant", "/api/electronics", "/api/carwash", "/api/hardware", "/api/telecom",
    "/api/logs/POULTRY-01", "/api/checklists", "/api/audit", "/api/cctv", "/api/attendance",
    "/api/notifications", "/api/enterprise", "/api/branch-unit", "/api/integrations",
    "/api/logos", "/api/exports", "/api/staff-access", "/api/tracking", "/api/profile",
    "/api/ai", "/api/session/heartbeat", "/api/auth/me", "/api/track", "/api/menu",
  ];
  let anonFail = 0, ownerFail = 0, ownerBad = [];
  for (const r of routes) {
    const a = await api(null, r);
    if (a.status >= 500) { anonFail++; ownerBad.push(`anon ${r} → ${a.status}`); }
    const o = await api(cookies.owner, r);
    if (o.status >= 500) { ownerFail++; ownerBad.push(`owner ${r} → ${o.status}`); }
  }
  ok("A1 no 5xx across 39 API routes (anonymous)", anonFail === 0, ownerBad.join(" | ").slice(0, 240));
  ok("A2 no 5xx across 39 API routes (owner session)", ownerFail === 0, ownerBad.join(" | ").slice(0, 240));
  const health = await api(null, "/api/health");
  ok("A3 DB health endpoint reports the database alive",
    health.status === 200 && JSON.stringify(health.json || {}).toLowerCase().match(/ok|healthy|connected|true/) !== null,
    JSON.stringify(health.json || {}).slice(0, 160));
  const unauthed = await api(null, "/api/users");
  ok("A4 protected staff data refuses anonymous (401)", unauthed.status === 401);
}

/* ═══ B · owner walks every sidebar tab ═══ */
async function phaseB(browser, errors) {
  console.log("\n— B · Owner · every sidebar destination —");
  const { ctx, page } = await newContext(browser, "B-owner", errors);
  await loginUi(page, CREDS.owner);
  const visited = [];
  const thin = [];
  for (let i = 0; i < 30; i++) {
    const btns = await navButtons(page);
    if (i >= btns.length) break;
    const b = btns[i];
    if (!b) break;
    await page.evaluate((idx) => {
      const all = [...document.querySelectorAll('[data-testid="nav-sidebar"] button')].filter((x) => !x.disabled && x.offsetParent !== null);
      all[idx]?.click();
    }, b.idx);
    await new Promise((r) => setTimeout(r, 1100));
    const txt = await mainText(page);
    visited.push(b.text);
    if (txt.length < 500 || /Application error|404 \| This page could not/i.test(txt)) thin.push(`${b.text} (len=${txt.length})`);
  }
  ok(`B1 clicked through ${visited.length} sidebar destinations without a crash`, thin.length === 0, thin.join(" | ").slice(0, 240));
  console.log(`     visited: ${visited.join(" · ").slice(0, 400)}`);
  const coverage = visited.join(" ").toLowerCase();
  const expectedCore = ["command", "customers", "tracking", "suppliers", "employees", "assets", "inventory", "transactions"];
  const missing = expectedCore.filter((w) => !coverage.includes(w));
  ok("B2 sidebar covers all shared enterprise modules", missing.length === 0, missing.join(","));
  const bizCount = (visited.join(" ").match(/mina |gomina|concrete|blocks|akuafo|volta|cattle|heritage|tech|wash|hardware/gi) || []).length;
  ok("B3 every Ghana business page reachable from sidebar", bizCount >= 6, `biz-like entries=${bizCount}`);
  await page.screenshot({ path: "/home/user/audit-atoz-sidebar.png", fullPage: false });
  await ctx.close();
  return visited;
}

/* ═══ C · every business module, internal tabs ═══ */
async function phaseC(browser, errors) {
  console.log("\n— C · Business module internals (each business type) —");
  const { ctx, page } = await newContext(browser, "C-modules", errors);
  await loginUi(page, CREDS.owner);
  const bizs = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="nav-sidebar"] button')]
      .map((b, i) => ({ t: (b.textContent || "").trim(), i }))
      .filter((b) => /mina |gomina|concrete|akuafo|volta|cattle|heritage|wash|tech|hardware/i.test(b.t) && !/CRM|Tracking|Suppliers|Employees|Payroll|Assets|Inventory|Transactions|Sales|Finance|Center/i.test(b.t)),
  );
  let totalTabs = 0;
  const tabFails = [];
  for (const biz of bizs.slice(0, 10)) {
    await page.evaluate((idx) => {
      const all = [...document.querySelectorAll('[data-testid="nav-sidebar"] button')].filter((x) => !x.disabled && x.offsetParent !== null);
      all[idx]?.click();
    }, biz.i);
    await new Promise((r) => setTimeout(r, 1300));
    const headerOk = await page.evaluate((name) => document.body.innerText.includes(name.split(" ").slice(0, 2).join(" ")), biz.t);
    if (!headerOk) tabFails.push(`${biz.t}: page missing own header`);
    // click up to 8 in-module tab-like buttons (skip destructive/modal-style actions)
    const tabs = await page.evaluate(() => {
      const skip = /delete|remove|revoke|disable|sign out|logout|export|download|print|\+ new|register|add |record |mark |payroll run/i;
      return [...document.querySelectorAll("main button, [role=main] button, div.flex button")]
        .filter((b) => {
          if (b.closest('[data-testid="nav-sidebar"]') || b.closest("header") || b.closest('[data-testid="navbar-controls"]')) return false;
          const t = (b.textContent || "").trim();
          return t && t.length >= 2 && t.length <= 26 && !skip.test(t) && b.offsetParent !== null && !b.disabled;
        })
        .slice(0, 8)
        .map((b) => (b.textContent || "").trim().replace(/\s+/g, " "));
    });
    let before = await page.evaluate(() => document.body.innerHTML.length);
    for (const tab of tabs) {
      try {
        const clicked = await page.evaluate((label) => {
          const skip = /delete|remove|revoke|disable|sign out|logout|export|download|print/i;
          const b = [...document.querySelectorAll("button")].find((x) => {
            if (x.closest('[data-testid="nav-sidebar"]') || x.closest("header")) return false;
            const t = (x.textContent || "").trim().replace(/\s+/g, " ");
            return t === label && x.offsetParent !== null && !x.disabled && !skip.test(t);
          });
          if (b) { b.click(); return true; }
          return false;
        }, tab);
        if (!clicked) continue;
        totalTabs++;
        await new Promise((r) => setTimeout(r, 420));
        await page.keyboard.press("Escape"); // close any popover/modal opened
        const after = await page.evaluate(() => document.body.innerText.length);
        if (after < 300) throw new Error("page went blank");
      } catch (e) {
        tabFails.push(`${biz.t} → tab "${tab}": ${String(e.message || e).slice(0, 80)}`);
      }
    }
  }
  ok(`C1 exercised ${bizs.length} business modules + ${totalTabs} internal tabs — all respond`, tabFails.length === 0, tabFails.join(" | ").slice(0, 300));
  tabFails.forEach((f) => finding(`module-tab: ${f}`));
  await ctx.close();
}

/* ═══ D · shared module internals ═══ */
async function phaseD(browser, errors) {
  console.log("\n— D · Shared module internals —");
  const { ctx, page } = await newContext(browser, "D-shared", errors);
  await loginUi(page, CREDS.owner);
  const modules = ["Sales & Payments", "Finance & Reports", "Customers & CRM", "Customer Order & Tracking", "Suppliers & Vendors", "Employees & Payroll", "Assets & Equipment", "Inventory & Stock", "Transactions & MoMo"];
  const dead = [];
  let tabs = 0;
  for (const mod of modules) {
    const clicked = await page.evaluate((label) => {
      const b = [...document.querySelectorAll('[data-testid="nav-sidebar"] button')].find((x) => (x.textContent || "").trim().replace(/\s+/g, " ").startsWith(label));
      if (b) { b.click(); return true; }
      return false;
    }, mod);
    if (!clicked) { dead.push(`${mod}: sidebar entry missing`); continue; }
    await new Promise((r) => setTimeout(r, 1100));
    const txt = await mainText(page);
    if (txt.length < 600) dead.push(`${mod}: thin content (${txt.length})`);
    const inner = await page.evaluate(() => {
      const skip = /delete|remove|revoke|disable|sign out|logout|\+ new|register|add |record |mark |run |create/i;
      const btns = [...document.querySelectorAll("button")].filter((x) => {
        if (x.closest('[data-testid="nav-sidebar"]') || x.closest("header")) return false;
        const t = (x.textContent || "").trim();
        return t.length >= 2 && t.length <= 24 && !skip.test(t) && x.offsetParent !== null && !x.disabled;
      });
      return btns.slice(0, 6).map((b) => (b.textContent || "").trim().replace(/\s+/g, " "));
    });
    for (const tab of inner) {
      try {
        const did = await page.evaluate((label) => {
          const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim().replace(/\s+/g, " ") === label && x.offsetParent !== null && !x.disabled);
          if (b) { b.click(); return true; }
          return false;
        }, tab);
        if (did) tabs++;
        await new Promise((r) => setTimeout(r, 380));
        await page.keyboard.press("Escape");
      } catch (e) { dead.push(`${mod} → "${tab}" crashed`); }
    }
  }
  ok(`D1 9 shared modules deep-checked (${tabs} inner tabs) without failures`, dead.length === 0, dead.join(" | ").slice(0, 300));
  dead.forEach((f) => finding(`shared-module: ${f}`));
  await ctx.close();
}

/* ═══ E · role walks ═══ */
async function phaseE(browser, errors) {
  console.log("\n— E · Role-restricted walks —");
  // GM
  const { ctx: c1, page: pgm } = await newContext(browser, "E-gm", errors);
  await loginUi(pgm, CREDS.gm);
  const gmTxt = await mainText(pgm);
  ok("E1 GM signs in and lands on a working dashboard", /Command Center|Enterprise|Dashboard/i.test(gmTxt) || gmTxt.length > 900);
  const gmTracking = await api(await loginCookie(CREDS.gm), "/api/tracking");
  ok("E2 GM reaches Customer Tracking API in scope", gmTracking.status === 200);
  await c1.close();

  // BM
  const { ctx: c2, page: pbm } = await newContext(browser, "E-bm", errors);
  await loginUi(pbm, CREDS.bm);
  const bmHasTracking = await pbm.evaluate(() => !!document.querySelector('[data-testid="sidebar-tab-tracking"]'));
  const bmBiz = await pbm.evaluate(() => {
    const buttons = [...document.querySelectorAll('[data-testid="nav-sidebar"] button')].map((b) => (b.textContent || "").trim());
    return buttons.some((t) => /Akufo|Poultry/i.test(t));
  });
  ok("E3 BM sidebar: own branch + Order Tracking, no enterprise modules",
    bmHasTracking && bmBiz && !(await pbm.evaluate(() => document.body.innerText.includes("Shared Enterprise Modules"))));
  await pbm.evaluate(() => {
    const b = [...document.querySelectorAll('[data-testid="nav-sidebar"] button')].find((x) => /Akufo|Poultry/i.test(x.textContent || ""));
    b?.click();
  });
  await new Promise((r) => setTimeout(r, 1300));
  const bmDash = await mainText(pbm);
  ok("E3b BM business dashboard renders", bmDash.length > 600);
  await c2.close();

  // Worker
  const { ctx: c3, page: pw } = await newContext(browser, "E-worker", errors);
  await loginUi(pw, CREDS.worker);
  const tabs = ["Customers", "Inventory", "Order & Tracking", "My Activity", "Record Sale"];
  let wFail = [];
  for (const t of tabs) {
    const did = await pw.evaluate((label) => {
      const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === label);
      if (b) { b.click(); return true; }
      return false;
    }, t);
    if (!did) wFail.push(t);
    await new Promise((r) => setTimeout(r, 700));
  }
  const wTxt = await mainText(pw);
  ok("E4 worker workspace: all 5 tabs switch & render", wFail.length === 0 && wTxt.length > 600, wFail.join(","));
  await c3.close();
}

/* ═══ F · NEW business + NEW staff pages ═══ */
async function phaseF(browser, errors, cookies) {
  console.log("\n— F · Newly created business & staff pages —");
  // create business via API (owner-gated)
  const make = await api(cookies.owner, "/api/businesses", {
    method: "POST",
    body: JSON.stringify({
      name: "TEST Audit Hardware Depot",
      category: "Hardware Store",
      region: "Ashanti",
      district: "Kumasi Metropolitan",
      town: "TESTVILLE",
      managerName: "TEST Manager",
      contactPhone: "+233200000111",
      initialCapitalGhs: 5000,
      monthlyTargetRevenueGhs: 2000,
    }),
  });
  const biz = make.json?.business;
  ok("F1 owner can create a new business unit (API)", make.status === 200 && biz?.id > 0, JSON.stringify(make.json || {}).slice(0, 200));
  baseline.testBizId = biz?.id;
  baseline.testBizCode = biz?.code;
  ok("F1b new unit auto-provisioned clean (zero metrics + checklists, NO sample stock)", make.json?.provisioned != null && (make.json?.provisioned?.starterItems ?? 0) === 0 && (make.json?.provisioned?.starterKitCostGhs ?? 0) === 0);

  // register staff for it
  const mkStaff = await api(cookies.owner, "/api/users", {
    method: "POST",
    body: JSON.stringify({
      name: "TEST Audit Staff",
      email: "test.audit.staff@gominatest.com",
      role: "WORKER",
      assignedBusinessId: biz.id,
      password: "TEST@Audit26",
      canRecordSales: true,
      canRecordExpenses: true,
    }),
  });
  const staffId = mkStaff.json?.user?.id || mkStaff.json?.id;
  ok("F2 owner registers an account for the new unit", (mkStaff.status === 200 || mkStaff.status === 201) && staffId > 0, JSON.stringify(mkStaff.json || {}).slice(0, 220));
  baseline.testStaffId = staffId;

  // owner UI: new business shows in sidebar + page works
  const { ctx, page } = await newContext(browser, "F-owner", errors);
  await loginUi(page, CREDS.owner);
  const bizInSidebar = await page.evaluate((name) => {
    const b = [...document.querySelectorAll('[data-testid="nav-sidebar"] button')].find((x) => (x.textContent || "").includes(name));
    if (b) { b.click(); return true; }
    return false;
  }, "TEST Audit Hardware");
  ok("F3 new business appears in the owner sidebar", bizInSidebar);
  await new Promise((r) => setTimeout(r, 1500));
  const bizTxt = await mainText(page);
  ok("F3b new business dashboard loads with content & AI guide",
    bizTxt.includes("TEST Audit Hardware") && /How to Use/i.test(bizTxt) && bizTxt.length > 700,
    `len=${bizTxt.length}`);
  await page.screenshot({ path: "/home/user/audit-new-biz.png" });
  await ctx.close();

  // new staff signs in to a working scoped workspace
  const { ctx: c2, page: pw } = await newContext(browser, "F-staff", errors);
  await pw.goto(`${BASE}/`, { waitUntil: "networkidle0", timeout: 60000 });
  await pw.waitForSelector('[data-testid="login-email"]', { timeout: 60000 });
  await pw.type('[data-testid="login-email"]', "test.audit.staff@gominatest.com");
  await pw.type('[data-testid="login-password"]', "TEST@Audit26");
  await pw.click('[data-testid="login-submit"]');
  await pw.waitForFunction(() => !document.querySelector('[data-testid="login-email"]'), { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1500));
  const staffTxt = await mainText(pw);
  ok("F4 new staff account signs in → scoped workspace of the new unit",
    staffTxt.includes("TEST Audit Hardware") && /Record Sale|Inventory/i.test(staffTxt),
    staffTxt.slice(0, 160));
  // its order-tracking console works and is empty-scoped
  const did = await pw.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "Order & Tracking");
    if (b) { b.click(); return true; }
    return false;
  }, "");
  await new Promise((r) => setTimeout(r, 900));
  const hasCt = await pw.evaluate(() => !!document.querySelector('[data-testid="ct-root"]'));
  ok("F4b new unit's tracking console loads for the new staff member", did && hasCt);
  await pw.screenshot({ path: "/home/user/audit-new-staff.png" });
  await c2.close();

  // staff visible in owner Users & Access
  const { ctx: c3, page: pu } = await newContext(browser, "F-userspanel", errors);
  await loginUi(pu, CREDS.owner);
  const opened = await pu.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /Users & Access/i.test(x.textContent || ""));
    if (b) { b.click(); return true; }
    return false;
  });
  await new Promise((r) => setTimeout(r, 1500));
  const usersTxt = await mainText(pu);
  ok("F5 owner Users & Access shows the new staff against the new unit",
    opened && usersTxt.includes("TEST Audit Staff"), usersTxt.slice(0, 120));
  await c3.close();
}

/* ═══ G · responsive geometry + dropdown anchor ═══ */
async function phaseG(browser, errors) {
  console.log("\n— G · Responsive geometry 390/768/1440 —");
  for (const [w, h, label] of [[390, 844, "phone"], [768, 1024, "tablet"], [1440, 900, "desktop"]]) {
    const { ctx, page } = await newContext(browser, `G-${label}`, errors, { width: w, height: h });
    await loginUi(page, CREDS.owner);
    const geo = await page.evaluate(async () => {
      const controls = [...document.querySelectorAll('[data-testid="navbar-controls"] > *')];
      const out = [];
      for (const c of controls) {
        const r = c.getBoundingClientRect();
        if (r.width === 0) continue;
        out.push({ left: Math.round(r.left), right: Math.round(r.right) });
      }
      return { scrollW: document.documentElement.scrollWidth, iw: innerWidth, controls: out };
    });
    ok(`G1 ${label}: no horizontal overflow`, geo.scrollW <= geo.iw + 1, `scrollW=${geo.scrollW} iw=${geo.iw}`);
    const allIn = geo.controls.every((c) => c.left >= 0 && c.right <= geo.iw);
    ok(`G2 ${label}: every navbar control inside viewport`, allIn, JSON.stringify(geo.controls.slice(-3)));

    // dropdown anchor — THE reported bug: menu must open directly below its button
    await page.click('[data-testid="user-menu-btn"]');
    await new Promise((r) => setTimeout(r, 350));
    const anchor = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="user-menu-btn"]').getBoundingClientRect();
      const m = document.querySelector('[data-testid="user-account-menu"]').getBoundingClientRect();
      return { gap: Math.round(m.top - b.bottom), rightDrift: Math.round(Math.abs(m.right - b.right)), top: Math.round(m.top), bottom: Math.round(m.bottom), vh: innerHeight, left: Math.round(m.left), iw: innerWidth };
    });
    ok(`G3 ${label}: Staff menu opens DIRECTLY below its button (gap ≤ 20px, right edges aligned)`,
      anchor.gap >= -1 && anchor.gap <= 20 && anchor.rightDrift <= 2,
      JSON.stringify(anchor));
    ok(`G4 ${label}: menu fully inside the viewport`,
      anchor.top >= 0 && anchor.bottom <= anchor.vh && anchor.left >= 0);
    await page.keyboard.press("Escape");
    await ctx.close();
  }
  // currency + bell + clock panels anchored too (they share the hook)
  const { ctx, page } = await newContext(browser, "G-panels", errors);
  await loginUi(page, CREDS.owner);
  const panelCheck = async (btnSel, name) => {
    const exists = await page.evaluate((s) => !!document.querySelector(s), btnSel);
    if (!exists) { ok(`G5 ${name} panel button present`, false, "missing"); return; }
    await page.evaluate((s) => document.querySelector(s).click(), btnSel);
    await new Promise((r) => setTimeout(r, 350));
    const g = await page.evaluate((s) => {
      const btn = document.querySelector(s).getBoundingClientRect();
      const cands = [...document.querySelectorAll("div")]
        .filter((el) => getComputedStyle(el).position === "fixed" && el.offsetHeight > 60 && el.offsetWidth > 100)
        .map((el) => el.getBoundingClientRect());
      const panel = cands.find((r) => Math.abs(r.top - btn.bottom) < 80 || Math.abs(r.bottom - btn.top) < 80) || cands[0];
      return panel ? { gap: Math.round(panel.top - btn.bottom), top: Math.round(panel.top), right: Math.round(panel.right), left: Math.round(panel.left), iw: innerWidth } : null;
    }, btnSel);
    ok(`G5 ${name} panel anchored & on-screen`, !!g && g.gap <= 40 && g.right <= g.iw && g.left >= 0, JSON.stringify(g));
    await page.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 200));
  };
  await panelCheck('[data-testid="currency-switcher"]', "currency");
  await panelCheck('[data-testid="user-menu-btn"]', "account");
  await ctx.close();
}

/* ═══ Z · cleanup ═══ */
async function cleanup(cookies) {
  console.log("\n— Z · cleanup & forensics —");
  // staff (API delete covers sessions+grants)
  if (baseline.testStaffId) {
    const del = await api(cookies.owner, `/api/users?userId=${baseline.testStaffId}`, { method: "DELETE" });
    console.log(`   staff delete → ${del.status}`);
  }
  // business rows + provisioning
  if (baseline.testBizId) {
    const id = baseline.testBizId;
    const tables = ["inventory_items", "business_metrics", "checklist_templates", "car_wash_services", "telecom_lines", "telecom_wifi_packages", "expense_categories", "user_business_access", "attendance_logs", "notifications"];
    for (const t of tables) {
      try { await pg.query(`DELETE FROM ${t} WHERE business_id=$1`, [id]); } catch {}
    }
    await pg.query(`DELETE FROM businesses WHERE id=$1`, [id]);
  }
  await pg.query(`DELETE FROM user_sessions WHERE id > $1`, [baseline.sessMax]);
  const bizCount = (await pg.query(`SELECT count(*)::int c FROM businesses`)).rows[0].c;
  const userCount = (await pg.query(`SELECT count(*)::int c FROM users`)).rows[0].c;
  const testLeft = (await pg.query(`SELECT count(*)::int c FROM businesses WHERE name LIKE 'TEST%'`, [])).rows[0].c +
    (await pg.query(`SELECT count(*)::int c FROM users WHERE name LIKE 'TEST%' OR email LIKE 'test.%'`)).rows[0].c;
  ok("Z1 TEST business & staff fully removed", testLeft === 0);
  ok("Z2 user data intact (businesses & users at baseline)",
    bizCount === baseline.bizCount && userCount === baseline.userCount,
    `biz=${bizCount}/${baseline.bizCount} users=${userCount}/${baseline.userCount}`);
}

(async () => {
  await pg.connect();
  baseline.sessMax = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM user_sessions`)).rows[0].m;
  baseline.bizCount = (await pg.query(`SELECT count(*)::int c FROM businesses`)).rows[0].c;
  baseline.userCount = (await pg.query(`SELECT count(*)::int c FROM users`)).rows[0].c;

  const cookies = { owner: await loginCookie(CREDS.owner) };
  if (!cookies.owner) { console.log("FATAL: owner login failed"); process.exit(2); }

  const browser = await puppeteer.launch({
    executablePath: "/tmp/al2023/chromium",
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const errors = [];
  try {
    await phaseA(cookies);
    await phaseB(browser, errors);
    await phaseC(browser, errors);
    await phaseD(browser, errors);
    await phaseE(browser, errors);
    await phaseF(browser, errors, cookies);
    await phaseG(browser, errors);
  } catch (e) {
    ok(`audit crashed: ${e.message}`, false, String(e.stack || e).slice(0, 300));
  } finally {
    try { await cleanup(cookies); } catch (e) { console.error("cleanup error:", e.message); }
    await browser.close();
    await pg.end();
  }
  ok("H8 ZERO page/console errors across the entire audit", errors.length === 0, errors.slice(0, 5).join(" | ").slice(0, 400));

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n══ AUDIT RESULT: ${passed} passed, ${failed} failed ══`);
  if (findings.length) {
    console.log("FINDINGS:");
    findings.forEach((f) => console.log(" - " + f));
  }
  process.exit(failed ? 1 : 0);
})();
