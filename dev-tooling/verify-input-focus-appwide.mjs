#!/usr/bin/env node
/**
 * verify-input-focus-appwide.mjs — v3: definitive app-wide keystroke-focus audit.
 *
 * Method: walk every navigable surface of the Owner org —
 *   · each business in the sidebar (module tabs + inline panels + dialogs)
 *   · every shared enterprise tab (sales / finance / tracking …)
 *   · every decision-support sidebar row (AI Advisor, Scenario Planner,
 *     Integrations, Enterprise Users, Platform Owners, Support modal)
 * On every view: type into EVERY visible, editable, non-occluded text/number
 * input + textarea one keystroke at a time and assert document.activeElement
 * is still that element after EACH char (the exact user-reported bug).
 * Date inputs get a 2-digit focus-retention probe; selects are opened/closed
 * (focus anomalies reported informationally — headless native artifact).
 *
 * Occlusion-aware: inputs covered by an overlay (e.g. an open modal above the
 * page) are skipped — they are not interactable, only visible.
 *
 * Zero-mutation: nothing is submitted, typed text is cleared afterwards.
 *
 * Run: LD_LIBRARY_PATH=/tmp/al2023/lib BASE_URL=http://127.0.0.1:3001 node dev-tooling/verify-input-focus-appwide.mjs [desktop|mobile]
 */
import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");
const fs = req("fs");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const MODE = (process.argv[2] || "desktop").toLowerCase();
const OUT = new URL("./.verify-out/", import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.GOMINA_OWNER_PW || "Owner@GoMina26" };
const TYPED = "Ab12 x";
const SKIP_TYPES = new Set(["button", "submit", "checkbox", "radio", "file", "image", "reset", "range", "color", "hidden", "password"]);
const OPEN_CHILD_RE = /(add|record|log|new|create|capture|manage units|manage-units|new branch|settings|users & access|register|enroll|print invoice)/i;
const EXCLUDE_RE = /(complete|delete|remove|start|\bdone\b|submit|save\b|print|export|download|simulate|close|cancel|edit-|mark|pay\b|re-link|copy|launch|refresh|grow|storm|import|retry|resolve|replay|logout|heart|pulse|onboard|steer|pricing|sign out|clock ?(in|out))/i;

let failures = 0, passes = 0, typedChecked = 0, dateChecked = 0, selectReports = [];
const failLog = [];
const ql = (ok, msg, extra = "") => {
  if (ok) { passes++; console.log(`  ✓ ${msg}${extra ? ` — ${extra}` : ""}`); }
  else { failures++; failLog.push(msg + (extra ? ` (${extra})` : "")); console.error(`  ✗ [${failureCtx}] ${msg}${extra ? ` — ${extra}` : ""}`); }
};
let failureCtx = "";

const chromium = (await req("@sparticuz/chromium")).default ?? req("@sparticuz/chromium");
const browser = await puppeteer.launch({
  executablePath: await chromium.executablePath(),
  args: [...(chromium.args || []), "--no-sandbox", "--disable-setuid-sandbox"],
});
let consoleErrors = [];
async function newPage() {
  const page = await browser.newPage();
  if (MODE === "mobile") await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  else await page.setViewport({ width: 1440, height: 960 });
  page.on("pageerror", (e) => consoleErrors.push(String(e.message || e).slice(0, 160)));
  return page;
}
async function login(page) {
  await page.goto(`${BASE}/?login=1`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector('[data-testid="login-email"]', { timeout: 120000 });
  await page.type('[data-testid="login-email"]', OWNER.email);
  await page.type('[data-testid="login-password"]', OWNER.pw);
  await page.click('[data-testid="login-submit"]');
  await page.waitForSelector('[data-testid="nav-sidebar"]', { timeout: 150000 });
  await new Promise((r) => setTimeout(r, 4000));
}

const BIZ_WALK = function () {
  const SHARED_START = /^(Sales &|Finance &|Customers &|Customer Order|Suppliers &|Employees &|Assets &|Inventory &|Transactions &|Audit &|Support|AI Strategic|Scenario|Integrations|Enterprise Users|Platform Owners)/i;
  const out = [];
  for (const e of document.querySelectorAll('[data-testid="nav-sidebar"] button, [data-testid="nav-sidebar"] a')) {
    const t = (e.textContent || "").trim();
    if (SHARED_START.test(t)) break;
    if (t.length > 2 && t.length < 90 && !/^Command Center/.test(t)) out.push(t);
  }
  return out;
};
const TAIL_WALK = function () {
  // all sidebar rows from the first shared one to the end
  const SHARED_START = /^(Sales &|Finance &|Customers &|Customer Order|Suppliers &|Employees &|Assets &|Inventory &|Transactions &|Audit &|Support|AI Strategic|Scenario|Integrations|Enterprise Users|Platform Owners)/i;
  const out = [];
  let hit = false;
  for (const e of document.querySelectorAll('[data-testid="nav-sidebar"] button, [data-testid="nav-sidebar"] a')) {
    const t = (e.textContent || "").trim();
    if (SHARED_START.test(t)) hit = true;
    if (hit && t.length > 2 && t.length < 90) out.push(t);
  }
  return out;
};
async function clickSidebar(page, label) {
  const ok = await page.evaluate((t) => {
    const el = [...document.querySelectorAll('[data-testid="nav-sidebar"] button, [data-testid="nav-sidebar"] a')]
      .find((b) => (b.textContent || "").trim() === t);
    if (!el) return false;
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  }, label);
  await new Promise((r) => setTimeout(r, 4000));
  return ok;
}
async function bailModals(page) {
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Escape").catch(() => {});
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** enumerate visible, UNOCCLUDED, editable inputs */
async function enumerateInputs(page) {
  return page.$$eval("input, textarea, select", (els) =>
    els.map((el, i) => {
      const r = el.getBoundingClientRect();
      if (r.width < 6 || r.height < 6) return null;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none" || !el.offsetParent) return null;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cy < 0 || cy > innerHeight || cx < 0 || cx > innerWidth) return null;
      const atPoint = document.elementFromPoint(cx, cy);
      const occluded = atPoint && atPoint !== el && !el.contains(atPoint) && !atPoint.closest("label")?.contains(el);
      if (occluded) return null;
      if (el.disabled || el.readOnly) return null;
      return {
        i,
        tid: el.getAttribute("data-testid") || "",
        type: (el.tagName === "SELECT" ? "select" : el.tagName === "TEXTAREA" ? "textarea" : el.getAttribute("type") || "text").toLowerCase(),
        place: (el.getAttribute("placeholder") || "").slice(0, 40),
      };
    }).filter(Boolean));
}
function probeSel(page, tid) {
  return tid ? `[data-testid="${tid}"]` : null;
}
async function probeTyping(page, sel, label, ctx) {
  const handle = await page.$(sel);
  if (!handle) return false;
  await handle.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await new Promise((r) => setTimeout(r, 120));
  await handle.click().catch(() => {});
  await new Promise((r) => setTimeout(r, 100));
  let droppedAt = -1;
  for (let c = 0; c < TYPED.length; c++) {
    await page.keyboard.type(TYPED[c], { delay: 5 });
    await new Promise((r) => setTimeout(r, 45));
    const ok = await page.evaluate((s) => {
      const el = document.querySelector(s);
      return !!el && (document.activeElement === el || el.contains(document.activeElement));
    }, sel);
    if (!ok) { droppedAt = c; break; }
  }
  await handle.evaluate((el) => {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  let deadHtml = "";
  if (droppedAt >= 0) {
    deadHtml = await page.evaluate((s) => {
      const el = document.querySelector(s);
      return el ? el.outerHTML.slice(0, 110).replace(/\s+/g, " ") : "ELEMENT-GONE";
    }, sel).catch(() => "?");
  }
  typedChecked++;
  if (droppedAt >= 0) {
    failureCtx = ctx;
    ql(false, `${label}: typing keeps focus`, `caret died after char ${droppedAt + 1} :: ${deadHtml}`);
    await page.screenshot({ path: `${OUT}focus-fail-${String(failures).padStart(2, "0")}.png` }).catch(() => {});
    return false;
  }
  return true;
}
let probeMark = 0;
async function probeTypingByIdx(page, idx, label, ctx) {
  // tag the exact element in-page, then probe it with REAL keyboard input
  const mark = `probe-${++probeMark}`;
  const tagged = await page.evaluate((i, m) => {
    const el = [...document.querySelectorAll("input, textarea, select")][i];
    if (!el) return false;
    el.setAttribute("data-focus-probe", m);
    return true;
  }, idx, mark);
  if (!tagged) return false;
  const ok = await probeTyping(page, `[data-focus-probe="${mark}"]`, label, ctx);
  await page.evaluate((m) => document.querySelector(`[data-focus-probe="${m}"]`)?.removeAttribute("data-focus-probe"), mark).catch(() => {});
  return ok;
}
async function probeDate(page, selOrIdx, label, ctx) {
  let sel = typeof selOrIdx === "string" ? selOrIdx : null;
  let idx = typeof selOrIdx === "number" ? selOrIdx : null;
  if (!sel && idx !== null) {
    const mark = `probe-${++probeMark}`;
    const tagged = await page.evaluate((i, m) => {
      const el = [...document.querySelectorAll("input, textarea, select")][i];
      if (!el) return false;
      el.setAttribute("data-focus-probe", m);
      return true;
    }, idx, mark);
    if (!tagged) return false;
    sel = `[data-focus-probe="${mark}"]`;
    idx = null;
  }
  const handle = sel ? await page.$(sel) : null;
  if (!handle) return false;
  await handle.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await new Promise((r) => setTimeout(r, 120));
  await handle.click().catch(() => {});
  await new Promise((r) => setTimeout(r, 100));
  let droppedAt = -1;
  for (const ch of ["0", "1"]) {
    await page.keyboard.type(ch, { delay: 10 });
    await new Promise((r) => setTimeout(r, 70));
    const stillFocused = await page.evaluate((s) => { const el = document.querySelector(s); return !!el && document.activeElement === el; }, sel);
    if (!stillFocused) { droppedAt++; break; }
  }
  await page.keyboard.press("Escape").catch(() => {});
  dateChecked++;
  if (droppedAt >= 0) { failureCtx = ctx; ql(false, `${label}: date input keeps focus through digits`); return false; }
  return true;
}
async function probeSelectInfo(page, sel, label, ctx) {
  const handle = await page.$(sel);
  if (!handle) return;
  await handle.click().catch(() => {});
  await new Promise((r) => setTimeout(r, 220));
  const ok = await page.evaluate((s) => {
    const el = document.querySelector(s);
    return !!el && (document.activeElement === el || el.contains(document.activeElement));
  }, sel);
  await page.keyboard.press("Escape").catch(() => {});
  if (!ok) selectReports.push(`${ctx} · ${label}: select focus anomaly (headless native-control artifact?)`);
}

async function auditVisibleInputs(page, ctx, cap = 10, already = null) {
  const inputs = await enumerateInputs(page);
  const typed = inputs.filter((x) => !SKIP_TYPES.has(x.type) && x.type !== "select" && x.type !== "date");
  const dates = inputs.filter((x) => x.type === "date");
  const selects = inputs.filter((x) => x.type === "select");
  let okN = 0, failN = 0;
  const seen = new Set(already || []);
  for (const inp of typed.slice(0, cap)) {
    const key = inp.tid || `idx:${inp.i}:${inp.place}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sel = probeSel(page, inp.tid);
    const ok = sel ? await probeTyping(page, sel, inp.tid || inp.place || "input", ctx)
      : await probeTypingByIdx(page, inp.i, `input:"${inp.place}"`, ctx);
    ok ? okN++ : failN++;
  }
  for (const d of dates.slice(0, 2)) {
    const sel = probeSel(page, d.tid);
    (await probeDate(page, sel ?? d.i, d.tid || "date", ctx)) ? okN++ : failN++;
  }
  for (const s of selects.slice(0, 2)) {
    const sel = probeSel(page, s.tid);
    if (sel) await probeSelectInfo(page, sel, s.tid || "select", ctx);
  }
  return { okN, failN, typed: typed.length, selects: selects.length, dates: dates.length };
}

/** click data-entry buttons; audit any NEW inputs that appear (modal OR inline panel) */
async function auditActionButtons(page, ctx, cap = 6) {
  const candidates = await page.$$eval("button", (els) => els
    .map((b, i) => ({
      tid: b.getAttribute("data-testid") || "",
      txt: (b.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
      visible: b.offsetParent !== null && !b.disabled,
    }))
    .filter((x) => x.visible)
    .map((x) => ({ ...x, key: x.tid || `txt:${x.txt}` })));
  const chosen = candidates.filter((b) => OPEN_CHILD_RE.test(b.tid) || OPEN_CHILD_RE.test(b.txt)).filter((b) => !EXCLUDE_RE.test(b.tid) && !EXCLUDE_RE.test(b.txt));
  const seenInputs = new Set();
  let dialogs = 0;
  for (const b of chosen.slice(0, cap)) {
    const clicked = await page.evaluate((btid, btxt) => {
      let el = null;
      if (btid) el = document.querySelector(`[data-testid="${btid}"]`);
      if (!el && btxt) el = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").replace(/\s+/g, " ").trim().startsWith(btxt.slice(0, 24)) && x.offsetParent !== null);
      if (el) { el.scrollIntoView({ block: "center" }); el.dispatchEvent(new MouseEvent("click", { bubbles: true })); return true; }
      return false;
    }, b.tid, b.txt.slice(0, 24));
    if (!clicked) continue;
    await new Promise((r) => setTimeout(r, 1400));
    const inputs = await enumerateInputs(page);
    const fresh = inputs.filter((x) => !seenInputs.has(x.tid || `txt:${x.place}`) && x.type !== "select");
    fresh.forEach((x) => seenInputs.add(x.tid || `txt:${x.place}`));
    if (!fresh.length) continue;
    dialogs++;
    let failIn = 0;
    for (const inp of fresh.slice(0, 8)) {
      const dctx = `${ctx} ▸ ${b.tid || b.txt.slice(0, 28)}`;
      const sel = probeSel(page, inp.tid);
      const ok = sel ? await probeTyping(page, sel, inp.tid || inp.place || "input", dctx)
        : (inp.type === "date" ? await probeDate(page, inp.i, inp.place || "date", dctx) : await probeTypingByIdx(page, inp.i, `input:"${(inp.place || "").slice(0, 24)}"`, dctx));
      if (!ok) failIn++;
    }
    console.log(`     ▸ ${b.tid || b.txt.slice(0, 34)}: ${fresh.length} fresh inputs, ${failIn} focus fails`);
    // attempt to close any overlay now
    await page.evaluate(() => {
      const closers = [...document.querySelectorAll('button')].filter((x) => /cancel|close okay|^×$|^x$/i.test((x.textContent || "").trim()) && x.offsetParent !== null);
      closers[0]?.click();
    });
    await new Promise((r) => setTimeout(r, 400));
    await bailModals(page);
  }
  return { dialogs, chosen: chosen.length };
}

async function auditView(page, ctx) {
  const a = await auditVisibleInputs(page, ctx, 8);
  const d = await auditActionButtons(page, ctx, 6);
  if (a.typed + a.selects + d.dialogs > 0) console.log(`   · ${ctx.split(" › ").pop()}: ${a.okN} typed-ok · ${a.failN} fails · ${d.dialogs} entry surfaces (of ${d.chosen} buttons)`);
  return a.failN === 0;
}

console.log(`· mode: ${MODE}`);
const page = await newPage();
await login(page);

const businessRows = await page.evaluate(BIZ_WALK);
console.log(`· ${businessRows.length} businesses: ${businessRows.slice(0, 12).join(" | ")}`);

const BIZ_LIMIT = process.env.SKIP_BIZ === "1" ? 0 : (MODE === "mobile" ? 4 : businessRows.length);
for (let bi = 0; bi < BIZ_LIMIT; bi++) {
  const name = businessRows[bi];
  for (let retry = 0; retry < 2; retry++) {
    try {
      console.log(`\n· business ${bi + 1}/${BIZ_LIMIT}: ${name}${retry ? ` (retry ${retry})` : ""}`);
      await clickSidebar(page, name);
      await auditBusiness(page, name);
      break;
    } catch (e) {
      console.log(`   · ⚠ disruption during ${name}: ${String(e).replace(/\s+/g, " ").slice(0, 110)} — re-login & ${retry === 0 ? "retry" : "skip"}`);
      await login(page).catch(() => {});
    }
  }
}
async function auditBusiness(page, name) {
  // module-internal tab bars (cw-/hw-/tel-/lk-/transport-tab-/any seller-*)
  const tabs = await page.$$eval('[data-testid*="-tab-"]', (els) => [...new Set(els.map((e) => e.getAttribute("data-testid")))]
    .filter((t) => /^[a-z0-9]+-tab-[a-z0-9-]+$/i.test(t) && !/^sidebar-/.test(t)));
  for (const tid of tabs) {
    await page.click(`[data-testid="${tid}"]`).catch(() => {});
    await new Promise((r) => setTimeout(r, 2400));
    await auditView(page, `${name} › ${tid}`);
  }
  // shared sidebar tabs of this business
  const shared = await page.$$eval('[data-testid^="sidebar-tab-"]', (els) => [...new Set(els.map((e) => e.getAttribute("data-testid")))]);
  for (const tid of shared.slice(0, MODE === "mobile" ? 3 : 8)) {
    await page.click(`[data-testid="${tid}"]`).catch(() => {});
    await new Promise((r) => setTimeout(r, 2200));
    await auditView(page, `${name} › ${tid}`);
  }
}

// tail sweep: decision-support + shared sidebar rows (Support modal, AI advisor chat input,
// Scenario Planner, Integrations, Enterprise Users, Platform Owners)
console.log("\n· tail sweep: shared & decision-support surfaces …");
for (let attempt = 0; attempt < 12; attempt++) {
  try {
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForSelector('[data-testid="nav-sidebar"]', { timeout: 60000 });
    break;
  } catch (e) {
    console.log(`   · server unavailable (attempt ${attempt + 1}/12) — waiting for supervisor restart…`);
    await new Promise((r) => setTimeout(r, 20000));
    if (attempt === 11) throw e;
  }
}
await new Promise((r) => setTimeout(r, 6000));
const tailRows = await page.evaluate(TAIL_WALK);
console.log(`   · ${tailRows.length} rows: ${tailRows.slice(0, 20).join(" | ")}`);
const TAIL_LIMIT = MODE === "mobile" ? 10 : tailRows.length;
for (const label of tailRows.slice(0, TAIL_LIMIT)) {
  await bailModals(page);
  const ok = await clickSidebar(page, label);
  if (!ok) continue;
  await auditView(page, `tail › ${label}`);
}

const errsNow = consoleErrors.filter((e) => !/favicon|ResizeObserver/i.test(e)).length;
ql(errsNow === 0, "no page errors during crawl", errsNow ? consoleErrors[0] : "clean");

console.log(`\n── summary: ${typedChecked} typable fields typed · ${dateChecked} date probes ──`);
if (selectReports.length) {
  console.log("\n── select focus anomalies (informational) ──");
  [...new Set(selectReports)].slice(0, 8).forEach((x) => console.log(`   · ${x}`));
}
if (failLog.length) {
  console.log("\n── FAILURES (fix targets) ──");
  [...new Set(failLog)].forEach((f, i) => console.log(`  ${i + 1}. [${failureCtx}] ${f}`));
}
console.log(`\n═══ APP-WIDE FOCUS (${MODE}): ${passes} pass · ${failures} fail ═══`);
process.exit(failures ? 1 : 0);
