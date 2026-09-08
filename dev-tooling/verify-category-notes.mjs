/**
 * verify-category-notes — E2E proof for the three-part upgrade:
 *
 *   C · Customer Order Page — products GROUPED BY PRODUCT CATEGORY (section
 *       headers + counts) while every existing ordering behaviour is intact
 *       (search, category chips, typed qty, stepper, checkout both viewports).
 *   B · New-business auto-provisioning — a freshly created unit instantly has
 *       its tailored dashboard, zero-based KPIs, type-appropriate daily
 *       checklist templates and Daily Notes ready — on desktop AND mobile,
 *       for a KNOWN type (Hardware Store) and a CUSTOM type (Bakery).
 *   N · Daily Notes + GoMina AI — workers file notes under the Daily
 *       Checklist; the AI flags issues/severity, spots recurring trends,
 *       writes daily summaries and keeps the business history & insights
 *       continuously updated. Withdrawals rebuild history truthfully.
 *   G · Cleanup + forensics — all TEST artifacts removed, live data intact,
 *       zero page errors tolerated across every surface.
 */
import { createRequire } from "module";
import { execFileSync } from "child_process";
const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");
const { Client } = require("pg");

const BASE = "http://127.0.0.1:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pass: process.env.GOMINA_OWNER_PW || "Owner@GoMina26" };
const WORKER_B1 = { email: "akua.donkor@gomina360.com", pass: "GoMina@User10", id: 10 };
const DESKTOP = { width: 1440, height: 960 };
const MOBILE = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
const today = new Date().toISOString().split("T")[0];
const d = (n) => new Date(Date.now() - n * 86400000).toISOString().split("T")[0];

const results = [];
const pg = new Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });
const created = { codes: [], phones: [], businesses: [], noteSeedIds: [] };

const ok = (name, cond, extra = "") => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "✅" : "❌"} ${name}${cond ? "" : " — " + String(extra).slice(0, 220)}`);
  return cond;
};
async function api(cookie, path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) },
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const login = async (email, password) => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status}`);
  return (res.headers.get("set-cookie") || "").split(";")[0];
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ─── browser harness ─── */
let browser;
const errors = [];
function hookPage(page, tag) {
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const txt = m.text();
    if (/Failed to load resource/.test(txt) && /(401|400|403|404|409|413)/.test(txt)) return;
    if (/net::/.test(txt)) return;
    errors.push(`[${tag}] ${txt.slice(0, 300)}`);
  });
  page.on("pageerror", (e) => errors.push(`[${tag}] PAGEERROR ${String(e).slice(0, 300)}`));
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
}
async function newPage(tag, viewport = DESKTOP) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  hookPage(page, tag);
  await page.setViewport(viewport);
  return { ctx, page };
}
async function loginUi(page, creds) {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid="login-email"]', { timeout: 60000 });
  await page.type('[data-testid="login-email"]', creds.email);
  await page.type('[data-testid="login-password"]', creds.pass);
  await page.click('[data-testid="login-submit"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="login-email"]'), { timeout: 60000 });
  await sleep(1200);
}
const clickByText = (page, text, tag = "button") =>
  page.evaluate((txt, tg) => {
    const el = [...document.querySelectorAll(tg)].find((e) => (e.textContent || "").trim().includes(txt));
    if (el) { el.click(); return true; }
    return false;
  }, text, tag);
const clickT = async (page, testid) => {
  await page.evaluate((tid) => document.querySelector(`[data-testid="${tid}"]`)?.scrollIntoView({ block: "center" }), testid);
  await sleep(250);
  await page.click(`[data-testid="${testid}"]`);
};
async function fillField(page, testid, value) {
  await page.evaluate((tid) => {
    const el = document.querySelector(`[data-testid="${tid}"]`);
    if (!el) return;
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, testid);
  await page.type(`[data-testid="${testid}"]`, value);
}

/* ═══ C · category-grouped catalog (desktop + mobile) ═══ */
let catOrderCode;
async function sectionC() {
  console.log("\n— C · storefront catalog grouped by PRODUCT CATEGORY —");
  // — mobile profile first (most demanding) —
  const { ctx: ctxM, page: m } = await newPage("catalog-mobile", MOBILE);
  await m.goto(`${BASE}/order?biz=1`, { waitUntil: "networkidle0", timeout: 60000 });
  await m.waitForSelector('[data-testid="oo-catalog"]', { timeout: 30000 });
  const secM = await m.evaluate(() => ({
    catalog: !!document.querySelector('[data-testid="oo-catalog"]'),
    sections: [...document.querySelectorAll('[data-testid^="oo-catsec-"]')].filter((el) => !el.dataset.testid.includes("count")).length,
    counts: [...document.querySelectorAll('[data-testid^="oo-catsec-count-"]')].length,
    cards: [...document.querySelectorAll('[data-testid^="oo-prod-"]')].length,
    branchPicker: [...document.querySelectorAll('[data-testid^="oo-biz-"]')].filter((el) => !/-(area|dist|out)-/.test(el.dataset.testid)).length,
  }));
  ok("C1 mobile: catalog renders as CATEGORY sections (≥1) with equal product count",
    secM.catalog && secM.sections >= 1 && secM.counts === secM.sections, JSON.stringify(secM));
  ok("C2 mobile: branch picker UNTOUCHED (all six online-selling businesses still selectable)", secM.branchPicker >= 6, secM.branchPicker);
  const overflowM = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
  ok("C3 mobile: no horizontal overflow with sections", !overflowM);

  // — desktop profile: hardware depot has many categories —
  const { ctx, page: p } = await newPage("catalog-desktop");
  await p.goto(`${BASE}/order?biz=8`, { waitUntil: "networkidle0", timeout: 60000 });
  await p.waitForSelector('[data-testid="oo-catalog"]', { timeout: 30000 });
  const secs = await p.evaluate(() => {
    const names = [...document.querySelectorAll('[data-testid^="oo-catsec-"]')]
      .filter((el) => !el.dataset.testid.includes("count"))
      .map((el) => el.dataset.testid.replace("oo-catsec-", ""));
    const counts = {};
    for (const el of document.querySelectorAll('[data-testid^="oo-catsec-count-"]')) {
      counts[el.dataset.testid.replace("oo-catsec-count-", "")] = Number((el.textContent || "").match(/\d+/)?.[0] || 0);
    }
    return { names, counts, cards: [...document.querySelectorAll('[data-testid^="oo-prod-"]')].length };
  });
  const sumCounts = Object.values(secs.counts).reduce((a, b) => a + b, 0);
  ok("C4 desktop: ≥3 category sections for the hardware depot", secs.names.length >= 3, secs.names.join("|"));
  ok("C5 desktop: section item-counts add up to every product card", sumCounts === secs.cards && secs.cards === 6,
    `counts=${sumCounts} cards=${secs.cards}`);
  ok("C6 desktop: 'Cement & Mortar' section labelled with its count", secs.names.includes("Cement & Mortar") && secs.counts["Cement & Mortar"] === 1,
    JSON.stringify(secs.counts));

  // category chips still filter down to a single section
  await p.click('[data-testid="oo-cat-Steel & Reinforcement"]');
  await sleep(300);
  const onlyOne = await p.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="oo-catsec-"]')].filter((el) => !el.dataset.testid.includes("count")).length);
  ok("C7 category chip still filters to a single section", onlyOne === 1, onlyOne);
  await p.click('[data-testid="oo-cat-ALL"]');
  await sleep(300);

  // search narrows sections
  await p.type('[data-testid="oo-search"]', "cement");
  await sleep(300);
  const afterSearch = await p.evaluate(() => ({
    sections: [...document.querySelectorAll('[data-testid^="oo-catsec-"]')].filter((el) => !el.dataset.testid.includes("count")).length,
    cards: [...document.querySelectorAll('[data-testid^="oo-prod-"]')].length,
  }));
  ok("C8 search narrows catalog to matching sections only", afterSearch.sections === 1 && afterSearch.cards === 1, JSON.stringify(afterSearch));
  await fillField(p, "oo-search", "");
  await sleep(300);

  // full ordering flow still works (typed qty + checkout)
  await p.click('[data-testid="oo-add-6"]');
  await p.waitForSelector('[data-testid="oo-qty-6"]', { timeout: 5000 });
  await fillField(p, "oo-qty-6", "3");
  await sleep(300);
  const total = await p.$eval('[data-testid="oo-cart-total"]', (el) => el.textContent || "");
  ok("C9 typed quantity in the grouped catalog updates cart total (3 × 118)", /354\.00/.test(total), total);
  await fillField(p, "oo-name", "TEST Category Buyer");
  await fillField(p, "oo-phone", "0554445566");
  await p.click('[data-testid="oo-place"]');
  await p.waitForSelector('[data-testid="oo-code"]', { timeout: 30000 });
  catOrderCode = (await p.$eval('[data-testid="oo-code"]', (el) => el.textContent || "")).trim();
  created.codes.push(catOrderCode); created.phones.push("0554445566");
  ok("C10 end-to-end order placed from the category-grouped catalog", /^GM-HARDWARE-/.test(catOrderCode), catOrderCode);
  await ctx.close(); await ctxM.close();
}

/* ═══ B · new-business auto-dashboard ═══ */
let bizA, bizB;
async function sectionB(ownerCookie) {
  console.log("\n— B · new business → instant tailored dashboard + connected modules —");
  const mkA = await api(ownerCookie, "/api/businesses", {
    method: "POST",
    body: JSON.stringify({ name: "TEST North Hardware Depot", category: "Hardware Store", branchLocation: "TEST Industrial Area", initialCapitalGhs: 50000 }),
  });
  bizA = mkA.json?.business;
  created.businesses.push(bizA?.id);
  ok("B1 TEST Hardware unit created", mkA.status === 200 && bizA?.id > 0, JSON.stringify(mkA.json || {}).slice(0, 200));
  const prov = mkA.json?.provisioned || {};
  ok("B2 provisioning ran: zero-KPI metrics + full checklist template set",
    prov.metricsCreated === true && prov.checklistTemplates >= 8, JSON.stringify(prov));
  ok("B3 sequential branch code issued (HARDWARE-02)", bizA?.code === "HARDWARE-02", bizA?.code);

  const chk = await api(ownerCookie, `/api/checklists?businessId=${bizA.id}`);
  ok("B4 hardware-type checklist template live (cement count task)",
    (chk.json?.templates || []).some((t) => /cement bags/i.test(t.taskLabel || "")),
    (chk.json?.templates || []).map((t) => t.taskLabel).slice(0, 3).join("|"));

  // custom / unknown category → generic enterprise dashboard + generic tasks
  const mkB = await api(ownerCookie, "/api/businesses", {
    method: "POST",
    body: JSON.stringify({ name: "TEST Sunrise Bakery", category: "Bakery & Pastry", initialCapitalGhs: 20000 }),
  });
  bizB = mkB.json?.business;
  created.businesses.push(bizB?.id);
  ok("B5 custom-category unit created with safe code + icon fallbacks",
    mkB.status === 200 && !!bizB?.id && !!bizB?.code && !!bizB?.iconName, JSON.stringify(mkB.json?.business || {}).slice(0, 160));
  const chkB = await api(ownerCookie, `/api/checklists?businessId=${bizB.id}`);
  ok("B6 custom unit gets a generic-but-complete daily checklist",
    (chkB.json?.templates || []).length >= 4, (chkB.json?.templates || []).length);

  // daily notes ready instantly on the new unit
  const noteA = await api(ownerCookie, "/api/daily-notes", {
    method: "POST",
    body: JSON.stringify({ businessId: bizA.id, content: "TEST Opening day — arranged the yard, working smoothly, no problems at all." }),
  });
  ok("B7 Daily Notes live on the brand-new unit instantly", noteA.status === 200 && noteA.json?.success === true,
    JSON.stringify(noteA.json || {}).slice(0, 160));

  // desktop: open the new hardware unit's dashboard
  const { ctx, page } = await newPage("newbiz-desktop");
  await loginUi(page, OWNER);
  const opened = await clickByText(page, "TEST North Hardware Depot");
  ok("B8 new unit appears in the sidebar instantly", opened);
  await sleep(2000);
  const dashTxt = await page.evaluate(() => document.body.innerText || "");
  ok("B9 tailored hardware dashboard renders (KPIs + module tabs)",
    /TEST North Hardware Depot/.test(dashTxt) && (/(Revenue|Sales|Stock|Dashboard)/i.test(dashTxt)),
    dashTxt.slice(0, 140).replace(/\n/g, " "));
  const chkTab = await clickByText(page, "Daily Checklist");
  await sleep(1200);
  ok("B10 checklist tab connected with Daily Notes underneath",
    chkTab && !!(await page.$('[data-testid="dn-section"]')), `tab=${chkTab}`);
  await ctx.close();

  // mobile: open the custom-category unit's generic dashboard
  const { ctx: ctxM, page: m } = await newPage("newbiz-mobile", MOBILE);
  await loginUi(m, OWNER);
  // the mobile nav may need scrolling into view
  const openedM = await m.evaluate(() => {
    const el = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("TEST Sunrise Bakery"));
    if (!el) return false;
    el.scrollIntoView({ block: "center" });
    el.click();
    return true;
  });
  ok("B11 custom unit visible in mobile sidebar", openedM);
  await sleep(2000);
  const dashTxtM = await m.evaluate(() => document.body.innerText || "");
  ok("B12 generic enterprise dashboard renders for the custom category (mobile)",
    /TEST Sunrise Bakery/.test(dashTxtM), dashTxtM.slice(0, 120).replace(/\n/g, " "));
  await clickByText(m, "Daily Checklist");
  await sleep(1200);
  ok("B13 mobile daily-notes editor present inside the new unit", !!(await m.$('[data-testid="dn-input"]')));
  // file a note from the phone — AI must answer inline
  await m.click('[data-testid="dn-input"]');
  await m.type('[data-testid="dn-input"]', "TEST First baking day — mixer jammed once but repaired, sales busy.");
  await m.click('[data-testid="dn-save"]');
  await m.waitForSelector('[data-testid="dn-last-analysis"]', { timeout: 20000 });
  const lastAi = await m.$eval('[data-testid="dn-last-analysis"]', (el) => el.textContent || "");
  ok("B14 AI analyses the mobile note inline (machine issue flagged)",
    /equipment breakdown/i.test(lastAi) && /WATCH|URGENT/.test(lastAi), lastAi.slice(0, 160));
  await ctxM.close();
}

/* ═══ N · daily notes + AI insight engine ═══ */
let noteWorkerId, noteOwnerRoutineId, noteRecurringId;
async function sectionN(ownerCookie) {
  console.log("\n— N · Daily Notes + AI issues/trends/summary/history —");
  // auth edges
  const anon = await api(null, "/api/daily-notes", { method: "POST", body: JSON.stringify({ businessId: 1, content: "x".repeat(20) }) });
  ok("N1 unauthenticated note rejected (401)", anon.status === 401, anon.status);
  const tooShort = await api(ownerCookie, "/api/daily-notes", { method: "POST", body: JSON.stringify({ businessId: 1, content: "short" }) });
  ok("N2 empty/rushed note rejected with guidance (400)", tooShort.status === 400 && /sentence/i.test(tooShort.json?.error || ""), tooShort.status);

  // worker files the day's problem note on their own business
  const wCookie = await login(WORKER_B1.email, WORKER_B1.pass);
  const w = await api(wCookie, "/api/daily-notes", {
    method: "POST",
    body: JSON.stringify({
      businessId: 1,
      content: "TEST Fed birds morning and evening, collected 30 crates. 2 birds died in house 2 and one drinker is leaking badly. Feed running low.",
    }),
  });
  noteWorkerId = w.json?.note?.id;
  const wIss = (w.json?.analysis?.issues || []).map((i) => i.category);
  ok("N3 WORKER's note accepted & stamped (name+role)",
    w.status === 200 && w.json?.note?.userRole === "WORKER" && !!noteWorkerId, JSON.stringify(w.json?.note || {}).slice(0, 160));
  ok("N4 AI flags health + water as URGENT issues",
    w.json?.analysis?.severity === "URGENT" && wIss.includes("HEALTH") && wIss.includes("WATER"),
    JSON.stringify({ sev: w.json?.analysis?.severity, iss: wIss }));
  // worker cannot post into a business they have no access to
  const wrong = await api(wCookie, "/api/daily-notes", { method: "POST", body: JSON.stringify({ businessId: 8, content: "x".repeat(20) }) });
  ok("N5 cross-business posting blocked (403)", wrong.status === 403, wrong.status);

  // owner files a routine note the same day
  const r = await api(ownerCookie, "/api/daily-notes", {
    method: "POST",
    body: JSON.stringify({ businessId: 1, content: "TEST Routine second shift — fed birds, refilled drinkers, cleaned houses. All normal, good sales." }),
  });
  noteOwnerRoutineId = r.json?.note?.id;
  ok("N6 routine note stays INFO (no false alarms)", r.json?.analysis?.severity === "INFO" && (r.json?.analysis?.flags || []).length === 0,
    JSON.stringify(r.json?.analysis || {}).slice(0, 200));
  const day = await api(ownerCookie, `/api/daily-notes?businessId=1&date=${today}`);
  ok("N7 AI daily summary merges the day: still URGENT from the worker's note",
    day.json?.daySummary?.severity === "URGENT" && (day.json?.notes || []).length === 2,
    JSON.stringify(day.json?.daySummary || {}));

  // seed two older days (same production code path) → today's note must be flagged RECURRING
  for (const [ds, body] of [
    [d(1), "TEST Mortality — 3 birds died, vet called. Drinkers leaking again."],
    [d(2), "TEST 1 bird died today. Suspect the feed batch. Leak in drinker line fixed."],
  ]) {
    execFileSync("npx", ["tsx", "dev-tooling/seed-notes-history.mts", "1", ds, body, "10", "TEST Akua D.", "WORKER"], { env: { ...process.env, DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/app_db" }, stdio: "pipe" });
  }
  const rec = await api(ownerCookie, "/api/daily-notes", {
    method: "POST",
    body: JSON.stringify({ businessId: 1, content: "TEST Another bird died this morning — same house. Vet says watch the flock closely." }),
  });
  noteRecurringId = rec.json?.note?.id;
  const healthIss = (rec.json?.analysis?.issues || []).find((i) => i.category === "HEALTH");
  ok("N8 AI marks the 3rd-day health issue as a RECURRING trend",
    healthIss?.recurring === true && (rec.json?.analysis?.flags || []).some((f) => /recurring/.test(f)),
    JSON.stringify(rec.json?.analysis?.issues || []));
  const ins = await api(ownerCookie, `/api/daily-notes?businessId=1&date=${today}`);
  const reg = ins.json?.insights?.issueRegister || [];
  const healthReg = reg.find((r) => r.category === "HEALTH");
  ok("N9 insights register counts the health issue across all days (3×, flagged recurring)",
    healthReg?.count >= 3, JSON.stringify(reg.map((r) => `${r.category}:${r.count}`)));
  ok("N10 rolling narrative summaries the unit (recurring pattern called out)",
    /recurring patterns/i.test(ins.json?.insights?.rollingSummary || "") && /URGENT/i.test(ins.json?.insights?.rollingSummary || ""),
    (ins.json?.insights?.rollingSummary || "").slice(0, 200));
  ok("N11 business history grows with every note (3+ day entries, newest first)",
    (ins.json?.insights?.history || []).length >= 3 && ins.json?.insights?.history?.[0]?.date === today,
    JSON.stringify((ins.json?.insights?.history || []).map((h) => h.date)));
  ok("N12 scoped manager (biz-1 BM login TBD) — owner sees the complete AI state",
    ins.status === 200 && ins.json?.insights?.notesAnalyzed >= 5, ins.json?.insights?.notesAnalyzed);

  // withdrawal: owner removes their routine note → register/history rebuilt truthfully
  const del = await api(ownerCookie, `/api/daily-notes?id=${noteOwnerRoutineId}`, { method: "DELETE" });
  ok("N13 note withdrawal allowed for author/manager", del.status === 200 && del.json?.deleted === true, del.status);
  const ins2 = await api(ownerCookie, `/api/daily-notes?businessId=1&date=${today}`);
  ok("N14 insights rebuilt after withdrawal (note count −1, day still flagged)",
    (ins2.json?.insights?.notesAnalyzed || 0) === (ins.json?.insights?.notesAnalyzed || 0) - 1 &&
    ins2.json?.daySummary?.severity === "URGENT",
    `${ins.json?.insights?.notesAnalyzed}->${ins2.json?.insights?.notesAnalyzed}`);
}

/* ═══ U · UI: checklist → Daily Notes on mobile + desktop (live poultry unit) ═══ */
async function sectionU() {
  console.log("\n— U · Daily Notes UI inside the Daily Checklist (mobile + desktop) —");
  const { ctx: ctxM, page: m } = await newPage("notes-mobile", MOBILE);
  await loginUi(m, OWNER);
  await clickByText(m, "Mina Akuafo Poultry Farm");
  await sleep(2000);
  await clickByText(m, "Daily Checklist");
  await m.waitForSelector('[data-testid="dn-section"]', { timeout: 20000 });
  ok("U1 mobile: Daily Notes section lives under the Daily Checklist", true);
  // wait for the notes fetch to settle, then assert the AI day card + chip
  const dayCard = await m.waitForSelector('[data-testid="dn-day-summary"]', { timeout: 15000 }).catch(() => null);
  const dayTxt = dayCard ? await dayCard.evaluate((el) => el.textContent || "") : "";
  ok("U2 mobile: AI daily summary of the seeded TEST day renders with URGENT chip",
    !!dayCard && /Urgent/i.test(dayTxt), dayTxt.slice(0, 140));
  const notesOnPage = await m.$$('[data-testid^="dn-note-"]');
  ok("U3 mobile: today's notes listed with authors/flags", notesOnPage.length >= 2, notesOnPage.length);
  // file one more note from the phone UI
  await m.click('[data-testid="dn-input"]');
  await m.type('[data-testid="dn-input"]', "TEST Mobile UI note — generator broke down at noon, repaired by 4pm. All cleared now.");
  await m.click('[data-testid="dn-save"]');
  await m.waitForSelector('[data-testid="dn-last-analysis"]', { timeout: 20000 });
  const uiAi = await m.$eval('[data-testid="dn-last-analysis"]', (el) => el.textContent || "");
  ok("U4 mobile UI: AI analysis shown inline right after saving (machine flagged)", /equipment breakdown/i.test(uiAi), uiAi.slice(0, 140));
  const roll = await m.$eval('[data-testid="dn-rolling"]', (el) => el.textContent || "").catch(() => "");
  ok("U5 mobile UI: rolling AI business-insights narrative visible", /logged day/.test(roll), roll.slice(0, 120));
  await m.click('[data-testid="dn-history-toggle"]');
  await sleep(400);
  const histItems = await m.$$('[data-testid^="dn-history-item-"]');
  ok("U6 mobile UI: history list expands with analysed days (incl. backfilled)", histItems.length >= 3, histItems.length);
  await m.screenshot({ path: "/home/user/catnotes-mobile-notes.png" });
  await ctxM.close();

  // desktop: livestock module — the NEW connected checklist tab (req ②)
  const { ctx, page: p } = await newPage("notes-desktop");
  await loginUi(p, OWNER);
  await clickByText(p, "Mina Cattle & Small Ruminants");
  await sleep(2000);
  const hasChkTab = await p.$('[data-testid="lk-tab-CHECKLIST"]');
  ok("U7 desktop: Livestock now HAS the Daily Checklist module-tab connected", !!hasChkTab);
  await p.click('[data-testid="lk-tab-CHECKLIST"]');
  await sleep(1500);
  ok("U8 desktop: checklist + notes render inside Livestock on first open",
    !!(await p.$('[data-testid="dn-input"]')), "dn-input missing");
  await ctx.close();
}

/* ═══ G · cleanup + forensics ═══ */
async function sectionG(ownerCookie, base) {
  console.log("\n— G · cleanup + forensics —");
  // TEST businesses deleted through the API (owner + code echo gate)
  for (const b of [bizA, bizB].filter(Boolean)) {
    const del = await api(ownerCookie, `/api/businesses/${b.id}`, { method: "DELETE", body: JSON.stringify({ confirmCode: b.code }) });
    ok(`G: TEST unit ${b.code} deleted via API`, del.status === 200 && del.json?.success === true, JSON.stringify(del.json || {}).slice(0, 140));
  }
  // stragglers of those units (any dependent rows the cascade left)
  await pg.query(`DELETE FROM business_metrics WHERE business_id = ANY($1)`, [created.businesses]);
  await pg.query(`DELETE FROM checklist_templates WHERE business_id = ANY($1)`, [created.businesses]);
  await pg.query(`DELETE FROM checklist_entries WHERE business_id = ANY($1)`, [created.businesses]);
  await pg.query(`DELETE FROM daily_notes WHERE business_id = ANY($1)`, [created.businesses]);
  await pg.query(`DELETE FROM business_insights WHERE business_id = ANY($1)`, [created.businesses]);
  // TEST notes on the live poultry unit + its insights row (all biz-1 notes were TEST)
  const goneNotes = await pg.query(`DELETE FROM daily_notes WHERE business_id=1 AND content LIKE 'TEST%' RETURNING id`);
  await pg.query(`DELETE FROM business_insights WHERE business_id=1`);
  ok("G1 every TEST daily note purged from the live unit", goneNotes.rowCount >= 5, goneNotes.rowCount);
  // category-catalog TEST order
  if (created.codes.length) {
    await pg.query(`DELETE FROM notifications WHERE record_ref = ANY($1)`, [created.codes]);
    await pg.query(`DELETE FROM customer_trackings WHERE tracking_code = ANY($1)`, [created.codes]);
  }
  if (created.phones.length) {
    await pg.query(`DELETE FROM customers WHERE phone = ANY($1) AND name LIKE 'TEST%'`, [created.phones]);
  }
  await pg.query(`DELETE FROM user_sessions WHERE id > $1`, [base.maxSessionId]);

  const counts = {};
  for (const t of Object.keys(base.counts)) counts[t] = (await pg.query(`SELECT count(*)::int c FROM ${t}`)).rows[0].c;
  const mismatches = Object.entries(base.counts).filter(([t, c]) => counts[t] !== c).map(([t, c]) => `${t}:${c}→${counts[t]}`);
  ok("G2 ALL live-data counts restored exactly", mismatches.length === 0, mismatches.join(", "));
  const eggs = (await pg.query(`SELECT quantity FROM inventory_items WHERE id=1`)).rows[0];
  ok("G3 live stock untouched (eggs = 873.63)", Number(eggs?.quantity) === 873.63, eggs?.quantity);
  const stray = (await pg.query(`SELECT count(*)::int c FROM daily_notes WHERE content LIKE 'TEST%'`)).rows[0].c
    + (await pg.query(`SELECT count(*)::int c FROM businesses WHERE name LIKE 'TEST%'`)).rows[0].c;
  ok("G4 zero TEST strays anywhere", stray === 0, stray);
}

/* ═══ main ═══ */
console.log("══ verify-category-notes — category catalog + auto-dashboard + AI daily notes ══");
await pg.connect();
const ownerCookie = await login(OWNER.email, OWNER.pass);
const base = {
  maxSessionId: (await pg.query(`SELECT COALESCE(max(id),0)::int m FROM user_sessions`)).rows[0].m,
  counts: Object.fromEntries((await pg.query(`
    SELECT 'businesses' t, count(*)::int c FROM businesses
    UNION ALL SELECT 'users', count(*)::int FROM users
    UNION ALL SELECT 'customers', count(*)::int FROM customers
    UNION ALL SELECT 'customer_trackings', count(*)::int FROM customer_trackings
    UNION ALL SELECT 'sales_documents', count(*)::int FROM sales_documents
    UNION ALL SELECT 'transactions', count(*)::int FROM transactions
    UNION ALL SELECT 'inventory_items', count(*)::int FROM inventory_items
    UNION ALL SELECT 'daily_notes', count(*)::int FROM daily_notes
    UNION ALL SELECT 'business_insights', count(*)::int FROM business_insights
    UNION ALL SELECT 'notifications', count(*)::int FROM notifications`)).rows.map((r) => [r.t, r.c])),
};
console.log(`baseline: ${JSON.stringify(base.counts)}`);

browser = await puppeteer.launch({
  executablePath: "/tmp/al2023/chromium",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  headless: "new",
});

await sectionC();
await sectionB(ownerCookie);
await sectionN(ownerCookie);
await sectionU();
await browser.close().catch(() => {});
await sectionG(ownerCookie, base);

const passed = results.filter((r) => r.pass).length;
console.log(`\n══ ${passed}/${results.length} checks passed ══`);
if (errors.length) {
  console.log(`\n⚠ ${errors.length} page error(s):`);
  errors.slice(0, 10).forEach((e) => console.log("  " + e));
} else {
  console.log("page errors: 0");
}
if (results.some((r) => !r.pass)) {
  console.log("FAILED:", results.filter((r) => !r.pass).map((r) => r.name).join(" | "));
}
await pg.end();
process.exit(results.some((r) => !r.pass) || errors.length ? 1 : 0);
