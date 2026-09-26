// Acceptance: Audit & Review → Records declutter.
//   • Default view shows ONLY today's activities (Today section).
//   • All older records live in a collapsible "History / Previous records"
//     section — collapsed by default, nothing deleted, everything reachable.
//   • The search box + every filter above the list govern BOTH sections.
//   • "Load older records" pages through the 250-per-request API cap until
//     the end of history for the current filters.
//   • Works identically on phone (cards) and desktop (table).
//
//   node dev-tooling/verify-audit-history.mjs

import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const pg = req("pg");
const puppeteer = req("puppeteer-core");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.OWNER_PW || "Owner@GoMina26" };

const client = new pg.Client(process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db");
await client.connect();
const q = async (sql, params) => (await client.query(sql, params)).rows;
const q1 = async (sql, params) => (await q(sql, params))[0] || null;

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ""}`); }
};

const browser = await puppeteer.launch({ executablePath: "/tmp/al2023/chromium", headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pageErrors = [];
const isNoise = (t) => /eval\(\) is not supported|React requires eval\(\)|React will never use eval/.test(t);

async function newCtx(label, w, h) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: w, height: h });
  page.on("pageerror", (e) => { if (!isNoise(String(e))) pageErrors.push(`[${label}] ${e}`); });
  page.on("console", (m) => { if (m.type() === "error") { const t = m.text(); if (!isNoise(t) && !/401|403|Failed to load resource|net::ERR_/.test(t)) pageErrors.push(`[${label}] ${t}`); } });
  return { ctx, page };
}

async function login(page, who) {
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid="login-email"]', { timeout: 30000 });
  await page.type('[data-testid="login-email"]', who.email);
  await page.type('[data-testid="login-password"]', who.pw);
  await page.click('[data-testid="login-submit"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="login-screen"]'), { timeout: 30000 });
  await sleep(1800);
}

const helpers = (page) => {
  const tid = (t) => `[data-testid="${t}"]`;
  const textOf = async (t) => page.$eval(tid(t), (e) => e.textContent || "").catch(() => "");
  const waitSel = (sel, t = 20000) => page.waitForSelector(sel, { timeout: t });
  const setVal = async (sel, val) => page.evaluate((s, v) => {
    const el = document.querySelector(s);
    if (!el) throw new Error(`no element ${s}`);
    const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, sel, val);
  const setTid = (t, val) => setVal(tid(t), val);
  const clickTid = async (t) => { await waitSel(tid(t)); await page.$eval(tid(t), (e) => e.click()); };
  return { tid, textOf, waitSel, setVal, setTid, clickTid };
};

// ══ 0. Seed fixtures: a 260-row older batch FIRST, then today / 3-days-ago /
//      40-days-ago named fixtures (seeded last → highest ids, matching how
//      real data accumulates inside the API's per-table id windows) ══
const TS = Date.now();
{
  const BATCH = 260;
  const values = [];
  const params = [];
  for (let i = 0; i < BATCH; i++) {
    values.push(`($${i + 1}, 1, 'POULTRY-01', 'EXPENSE', 'Feed Expense', ${1 + (i % 9)}, 'CASH', 'AUDHIST bulk older fixture', CURRENT_DATE - ${5 + (i % 30)}, 'COMPLETED', 'Kwame Mina', 'OWNER', 1)`);
    params.push(`AUDHIST-BULK-${TS}-${i}`);
  }
  await q(`INSERT INTO transactions (transaction_number, business_id, branch_code, type, category, amount_ghs, payment_method, description, date, status, recorded_by, recorded_by_role, recorded_by_user_id)
           VALUES ${values.join(",")}`, params);
}
const txnRow = (num, dateExpr, label) => q1(
  `INSERT INTO transactions (transaction_number, business_id, branch_code, type, category, amount_ghs, payment_method, description, date, status, recorded_by, recorded_by_role, recorded_by_user_id)
   VALUES ($1, 1, 'POULTRY-01', 'EXPENSE', 'Feed Expense', 10, 'CASH', $2, ${dateExpr}, 'COMPLETED', 'Kwame Mina', 'OWNER', 1) RETURNING id, transaction_number`,
  [num, label]
);
const txToday = await txnRow(`AUDHIST-TODAY-${TS}`, "CURRENT_DATE", "AUDHIST today fixture");
const txOld3 = await txnRow(`AUDHIST-OLD3-${TS}`, "CURRENT_DATE - 3", "AUDHIST 3-days-ago fixture");
const txOld40 = await txnRow(`AUDHIST-OLD40-${TS}`, "CURRENT_DATE - 40", "AUDHIST 40-days-ago fixture");
console.log(`seeded: today=${txToday.transaction_number} old3=${txOld3.transaction_number} old40=${txOld40.transaction_number} bulk=260`);

try {
  // ══ 1. PHONE — default view = today only, history collapsed ══
  console.log("\n── 1. PHONE 390×844 · owner — default view = today only ──");
  {
    const { ctx, page } = await newCtx("phone", 390, 844);
    const H = helpers(page);
    await login(page, OWNER);
    await H.waitSel('[data-testid="nav-sidebar"]', 20000);
    await H.clickTid("audit-tab");
    await H.waitSel('[data-testid="aud-root"]');
    await sleep(2500);

    ok("H1 Today section renders with a count", !!(await H.waitSel('[data-testid="aud-today-section"]')) && /record/.test(await H.textOf("aud-today-count")), await H.textOf("aud-today-count"));
    ok("H2 today fixture visible in the default view", await page.evaluate((n) => [...document.querySelectorAll('[data-testid^="aud-rec-row-"]')].some((r) => (r.textContent || "").includes(n)), txToday.transaction_number));
    ok("H3 today's records all dated today", await page.evaluate(() => {
      const today = new Date().toLocaleDateString("en-CA");
      const rows = [...document.querySelectorAll('[data-testid="aud-today-section"] [data-testid^="aud-rec-row-"]')];
      return rows.length > 0 && rows.every((r) => (r.textContent || "").includes(today));
    }), "");

    ok("H4 History section present, COLLAPSED by default", await page.$eval('[data-testid="aud-history-toggle"]', (b) => b.getAttribute("aria-expanded") === "false") && !(await page.$('[data-testid="aud-history-body"]')));
    ok("H5 history count reports the older records loaded so far", parseInt(await H.textOf("aud-history-count"), 10) >= 150, await H.textOf("aud-history-count"));
    ok("H6 old fixtures NOT in the DOM while collapsed", await page.evaluate((a, b) => ![...document.querySelectorAll('[data-testid^="aud-rec-row-"]')].some((r) => (r.textContent || "").includes(a) || (r.textContent || "").includes(b)), txOld3.transaction_number, txOld40.transaction_number));

    // Open History
    await H.clickTid("aud-history-toggle");
    await H.waitSel('[data-testid="aud-history-body"]');
    await sleep(400);
    ok("H7 opening History reveals the 3-day-old fixture", await page.evaluate((n) => [...document.querySelectorAll('[data-testid^="aud-rec-row-"]')].some((r) => (r.textContent || "").includes(n)), txOld3.transaction_number));
    ok("H8 History contains NO today records (split is clean)", await page.evaluate(() => {
      const today = new Date().toLocaleDateString("en-CA");
      const rows = [...document.querySelectorAll('[data-testid="aud-history-body"] [data-testid^="aud-rec-row-"]')];
      return rows.length > 0 && rows.every((r) => !(r.textContent || "").includes(today));
    }), "");
    ok("H9 today fixture NOT duplicated into History", await page.evaluate((n) => {
      const rows = [...document.querySelectorAll('[data-testid="aud-history-body"] [data-testid^="aud-rec-row-"]')];
      return rows.filter((r) => (r.textContent || "").includes(n)).length === 0;
    }, txToday.transaction_number));

    // Search governs both sections
    await H.setTid("aud-f-q", txOld40.transaction_number);
    await sleep(1400);
    ok("H10 search narrows History to the 40-day-old fixture", await page.evaluate((n) => [...document.querySelectorAll('[data-testid^="aud-rec-row-"]')].some((r) => (r.textContent || "").includes(n)), txOld40.transaction_number));
    ok("H11 search leaves Today section empty (no old record up there)", await page.evaluate(() => document.querySelectorAll('[data-testid="aud-today-section"] [data-testid^="aud-rec-row-"]').length === 0), "");
    await H.setTid("aud-f-q", "");
    await sleep(1400);

    // Type filter governs both sections
    await H.setTid("aud-f-type", "TRANSACTION");
    await sleep(1400);
    const txnOnly = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid^="aud-rec-row-"]')];
      const today = document.querySelectorAll('[data-testid="aud-today-section"] [data-testid^="aud-rec-row-TRANSACTION:"]').length;
      const hist = document.querySelectorAll('[data-testid="aud-history-body"] [data-testid^="aud-rec-row-TRANSACTION:"]').length;
      return { all: rows.length > 0 && rows.every((r) => (r.getAttribute("data-testid") || "").startsWith("aud-rec-row-TRANSACTION:")), today, hist };
    });
    ok("H12 type filter applies to both sections", txnOnly.all && txnOnly.today >= 1 && txnOnly.hist >= 1, JSON.stringify(txnOnly));
    await H.setTid("aud-f-type", "");
    await sleep(1400);

    // Load older records until the end
    ok("H13 load-more offered while more history exists", !!(await page.$('[data-testid="aud-history-load-more"]')));
    let clicks = 0;
    while (await page.$('[data-testid="aud-history-load-more"]')) {
      await H.clickTid("aud-history-load-more");
      await sleep(2200);
      if (++clicks > 8) break;
    }
    const histRows = await page.evaluate(() => document.querySelectorAll('[data-testid="aud-history-body"] [data-testid^="aud-rec-row-"]').length);
    ok("H14 load-more pages through the 250-cap until the end", clicks >= 1 && histRows >= 262 && !!(await page.$('[data-testid="aud-history-end"]')), `${clicks} clicks → ${histRows} history rows`);

    // Collapse again
    await H.clickTid("aud-history-toggle");
    await sleep(300);
    ok("H15 collapsing hides the history rows again", !(await page.$('[data-testid="aud-history-body"]')) && await page.evaluate((n) => ![...document.querySelectorAll('[data-testid^="aud-rec-row-"]')].some((r) => (r.textContent || "").includes(n)), txOld40.transaction_number));
    ok("H16 no horizontal overflow on phone", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `scrollW=${await page.evaluate(() => document.documentElement.scrollWidth)}`);
    await ctx.close();
  }

  // ══ 2. DESKTOP — same split, table layout in both sections ══
  console.log("\n── 2. DESKTOP 1440×900 · owner — same split, table layout ──");
  {
    const { ctx, page } = await newCtx("desktop", 1440, 900);
    const H = helpers(page);
    await login(page, OWNER);
    await H.waitSel('[data-testid="nav-sidebar"]', 20000);
    await H.clickTid("audit-tab");
    await H.waitSel('[data-testid="aud-root"]');
    await sleep(2500);

    const layoutToday = await page.evaluate(() => document.querySelector('[data-testid="aud-today-section"] [data-testid="aud-rec-rows"]')?.tagName);
    ok("H17 desktop: Today renders the classic TABLE", layoutToday === "TBODY", layoutToday);
    ok("H18 desktop: history collapsed by default", !(await page.$('[data-testid="aud-history-body"]')));
    await H.clickTid("aud-history-toggle");
    await H.waitSel('[data-testid="aud-history-body"]');
    await sleep(2200);
    const layoutHist = await page.evaluate(() => document.querySelector('[data-testid="aud-history-body"] [data-testid="aud-rec-rows"]')?.tagName);
    ok("H19 desktop: History renders the classic TABLE too", layoutHist === "TBODY", layoutHist);
    ok("H20 desktop: old fixture reachable in History", await page.evaluate((n) => [...document.querySelectorAll('[data-testid^="aud-rec-row-"]')].some((r) => (r.textContent || "").includes(n)), txOld3.transaction_number));
    await ctx.close();
  }

  ok("H21 zero page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
} finally {
  // ══ Z. Purge every seeded row ══
  const del = await q1(`WITH d AS (DELETE FROM transactions WHERE transaction_number LIKE 'AUDHIST-%' RETURNING 1) SELECT count(*)::int AS n FROM d`);
  console.log(`\ncleanup: purged ${del.n} AUDHIST rows (0 expected to remain after this line)`);
  await client.end();
  await browser.close();
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed · ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
