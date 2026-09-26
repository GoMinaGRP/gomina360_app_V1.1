// Acceptance: Audit & Review → Records declutter + ordering.
//   • The most recent 7 days are grouped BY DATE — Today, Yesterday, then
//     dated groups, newest day first — and within each day the most recent
//     activity comes first.
//   • Every record carries a clear date + time stamp (HH:MM) whenever the
//     exact event time is known.
//   • Records older than 7 days live in the collapsible "History / Previous
//     records" section — collapsed by default, search + filters govern both
//     parts, nothing deleted, everything reachable.
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
const isNoise = (t) => /eval\(\) is not supported|React requires eval\(\)|React will never use eval|ResizeObserver loop/.test(t);

async function newCtx(label, w, h) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: w, height: h });
  page.on("pageerror", (e) => { if (!isNoise(String(e))) pageErrors.push(`[${label}] ${String(e).slice(0, 200)}`); });
  page.on("console", (m) => { if (m.type() === "error") { const t = m.text(); if (!isNoise(t) && !/401|403|Failed to load resource|net::ERR_/.test(t)) pageErrors.push(`[${label}] ${t.slice(0, 200)}`); } });
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

/** The local calendar day strings the suite seeds around. */
const dayStr = async (offset) => (await q1(`SELECT to_char(CURRENT_DATE - ${offset}, 'YYYY-MM-DD') AS d`)).d;
const DAYS = { today: await dayStr(0), yest: await dayStr(1), d3: await dayStr(3), d8: await dayStr(8), d40: await dayStr(40) };

// ══ 0. Seed: bulk older batch first, then named fixtures with exact times ══
const TS = Date.now();
{
  const BATCH = 260;
  const values = [];
  const params = [];
  for (let i = 0; i < BATCH; i++) {
    values.push(`($${i + 1}, 1, 'POULTRY-01', 'EXPENSE', 'Feed Expense', ${1 + (i % 9)}, 'CASH', 'AUDHIST bulk older fixture', CURRENT_DATE - ${8 + (i % 30)}, 'COMPLETED', 'Kwame Mina', 'OWNER', 1)`);
    params.push(`AUDHIST-BULK-${TS}-${i}`);
  }
  await q(`INSERT INTO transactions (transaction_number, business_id, branch_code, type, category, amount_ghs, payment_method, description, date, status, recorded_by, recorded_by_role, recorded_by_user_id)
           VALUES ${values.join(",")}`, params);
}
const txnRow = (num, dayOffset, clock, label) => q1(
  `INSERT INTO transactions (transaction_number, business_id, branch_code, type, category, amount_ghs, payment_method, description, date, status, recorded_by, recorded_by_role, recorded_by_user_id, created_at)
   VALUES ($1, 1, 'POULTRY-01', 'EXPENSE', 'Feed Expense', 10, 'CASH', $2, CURRENT_DATE - ${dayOffset}, 'COMPLETED', 'Kwame Mina', 'OWNER', 1, (CURRENT_DATE - ${dayOffset}) + time '${clock}')
   RETURNING id, transaction_number, created_at`,
  [num, label]
);
// TODAY_A inserted first (lower id) but EARLIER clock time — B must render above it.
const txA = await txnRow(`AUDHIST-TODAY-A-${TS}`, 0, "09:15", "AUDHIST today 09:15 fixture");
const txB = await txnRow(`AUDHIST-TODAY-B-${TS}`, 0, "15:40", "AUDHIST today 15:40 fixture");
const txY = await txnRow(`AUDHIST-YDAY-${TS}`, 1, "11:22", "AUDHIST yesterday fixture");
const tx3 = await txnRow(`AUDHIST-D3-${TS}`, 3, "08:05", "AUDHIST 3-days-ago fixture");
const tx8 = await txnRow(`AUDHIST-D8-${TS}`, 8, "10:00", "AUDHIST 8-days-ago fixture (history)");
const tx40 = await txnRow(`AUDHIST-D40-${TS}`, 40, "12:30", "AUDHIST 40-days-ago fixture (history)");
const KEY = (t) => `TRANSACTION:transactions:${t.id}`;
console.log(`seeded around ${JSON.stringify(DAYS)}: A=${txA.transaction_number} B=${txB.transaction_number} yday=${txY.transaction_number} + d3/d8/d40 + bulk=260`);

try {
  // ══ 1. PHONE — 7-day groups, ordering, stamps, history ══
  console.log("\n── 1. PHONE 390×844 · owner — day groups ──");
  {
    const { ctx, page } = await newCtx("phone", 390, 844);
    const H = helpers(page);
    await login(page, OWNER);
    await H.waitSel('[data-testid="nav-sidebar"]', 20000);
    await H.clickTid("audit-tab");
    await H.waitSel('[data-testid="aud-root"]');
    await sleep(2500);

    // Group presence + counts
    ok("G1 Today group renders with a count", !!(await page.$(`[data-testid="aud-day-${DAYS.today}"]`)) && /record/.test(await H.textOf(`aud-day-count-${DAYS.today}`)), await H.textOf(`aud-day-count-${DAYS.today}`));
    ok("G2 Yesterday group renders", !!(await page.$(`[data-testid="aud-day-${DAYS.yest}"]`)));
    ok("G3 3-days-ago group renders", !!(await page.$(`[data-testid="aud-day-${DAYS.d3}"]`)));
    ok("G4 no group for 8-days-ago (outside the 7-day window)", !(await page.$(`[data-testid="aud-day-${DAYS.d8}"]`)));

    // Newest-first within Today: B (15:40) above A (09:15)
    const order = await page.evaluate((a, b) => {
      const rows = [...document.querySelectorAll('section[data-testid^="aud-day-"] [data-testid^="aud-rec-row-"]')];
      const ia = rows.findIndex((r) => (r.getAttribute("data-testid") || "") === `aud-rec-row-TRANSACTION:transactions:${a}`);
      const ib = rows.findIndex((r) => (r.getAttribute("data-testid") || "") === `aud-rec-row-TRANSACTION:transactions:${b}`);
      return { ia, ib };
    }, txA.id, txB.id);
    ok("G5 within Today the newest activity (15:40) renders first", order.ib >= 0 && order.ia > order.ib, JSON.stringify(order));

    // Day groups ordered Today → Yesterday → 3-days-ago in the DOM
    const groupOrder = await page.evaluate((days) => days.map((d) => [...document.querySelectorAll('section[data-testid^="aud-day-"]')].findIndex((s) => s.getAttribute("data-testid") === `aud-day-${d}`)), [DAYS.today, DAYS.yest, DAYS.d3]);
    ok("G6 day groups ordered newest day first", groupOrder[0] >= 0 && groupOrder[0] < groupOrder[1] && groupOrder[1] < groupOrder[2], JSON.stringify(groupOrder));

    // Time stamps
    const stampB = await H.textOf(`aud-rec-stamp-TRANSACTION:transactions:${txB.id}`);
    const stampA = await H.textOf(`aud-rec-stamp-TRANSACTION:transactions:${txA.id}`);
    const stampY = await H.textOf(`aud-rec-stamp-TRANSACTION:transactions:${txY.id}`);
    ok("G7 today 15:40 fixture shows its time", /15:40/.test(stampB), stampB);
    ok("G8 today 09:15 fixture shows its time", /09:15/.test(stampA), stampA);
    ok("G9 yesterday fixture shows date + 11:22", stampY.includes(DAYS.yest) && /11:22/.test(stampY), stampY);
    const allStamped = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('section[data-testid^="aud-day-"] [data-testid^="aud-rec-row-TRANSACTION:"]')];
      const stamped = rows.filter((r) => { const s = r.querySelector('[data-testid^="aud-rec-stamp-"]'); return s && /\d{2}:\d{2}/.test(s.textContent || ""); });
      return { total: rows.length, stamped: stamped.length };
    });
    ok("G10 every transaction row in the day groups carries a HH:MM stamp", allStamped.total > 0 && allStamped.total === allStamped.stamped, JSON.stringify(allStamped));

    // History: collapsed by default, holds the >7-day records
    ok("G11 History collapsed by default", await page.$eval('[data-testid="aud-history-toggle"]', (b) => b.getAttribute("aria-expanded") === "false") && !(await page.$('[data-testid="aud-history-body"]')));
    ok("G12 history count reports older records loaded so far", parseInt(await H.textOf("aud-history-count"), 10) >= 150, await H.textOf("aud-history-count"));
    ok("G13 8-day fixture NOT in the 7-day groups", !(await page.$(`[data-testid="aud-day-${DAYS.d8}"] [data-testid="aud-rec-row-TRANSACTION:transactions:${tx8.id}"], [data-testid="aud-rec-row-TRANSACTION:transactions:${tx8.id}"]`)));

    await H.clickTid("aud-history-toggle");
    await H.waitSel('[data-testid="aud-history-body"]');
    await sleep(500);
    ok("G14 opening History reveals the 8-day fixture", !!(await page.$(`[data-testid="aud-history-body"] [data-testid="aud-rec-row-TRANSACTION:transactions:${tx8.id}"]`)));
    ok("G15 History contains NO records from the 7-day groups (clean split)", await page.evaluate((key) => !document.querySelector(`[data-testid="aud-history-body"] [data-testid="aud-rec-row-${key}"]`), KEY(txB)));

    // Search governs both parts
    await H.setTid("aud-f-q", tx40.transaction_number);
    await sleep(1400);
    ok("G16 search finds the 40-day fixture in History", !!(await page.$(`[data-testid="aud-history-body"] [data-testid="aud-rec-row-TRANSACTION:transactions:${tx40.id}"]`)));
    ok("G17 search empties the 7-day groups", await page.evaluate(() => document.querySelectorAll('section[data-testid^="aud-day-"] [data-testid^="aud-rec-row-"]').length === 0));
    await H.setTid("aud-f-q", "");
    await sleep(1400);

    // Type filter governs both parts
    await H.setTid("aud-f-type", "TRANSACTION");
    await sleep(1400);
    const txnOnly = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid^="aud-rec-row-"]')];
      const today = document.querySelectorAll('section[data-testid^="aud-day-"] [data-testid^="aud-rec-row-TRANSACTION:"]').length;
      const hist = document.querySelectorAll('[data-testid="aud-history-body"] [data-testid^="aud-rec-row-TRANSACTION:"]').length;
      return { all: rows.length > 0 && rows.every((r) => (r.getAttribute("data-testid") || "").startsWith("aud-rec-row-TRANSACTION:")), today, hist };
    });
    ok("G18 type filter applies to day groups AND history", txnOnly.all && txnOnly.today >= 1 && txnOnly.hist >= 1, JSON.stringify(txnOnly));
    await H.setTid("aud-f-type", "");
    await sleep(1400);

    // Load older records until the end
    ok("G19 load-more offered while more history exists", !!(await page.$('[data-testid="aud-history-load-more"]')));
    let clicks = 0;
    while (await page.$('[data-testid="aud-history-load-more"]')) {
      await H.clickTid("aud-history-load-more");
      await sleep(2200);
      if (++clicks > 8) break;
    }
    const histRows = await page.evaluate(() => document.querySelectorAll('[data-testid="aud-history-body"] [data-testid^="aud-rec-row-"]').length);
    ok("G20 load-more pages through the 250-cap until the end", clicks >= 1 && histRows >= 262 && !!(await page.$('[data-testid="aud-history-end"]')), `${clicks} clicks → ${histRows} history rows`);

    // Collapse + overflow
    await H.clickTid("aud-history-toggle");
    await sleep(300);
    ok("G21 collapsing hides the history rows again", !(await page.$('[data-testid="aud-history-body"]')));
    ok("G22 no horizontal overflow on phone", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `scrollW=${await page.evaluate(() => document.documentElement.scrollWidth)}`);
    await ctx.close();
  }

  // ══ 2. DESKTOP — same groups, table layout, stamps in the table ══
  console.log("\n── 2. DESKTOP 1440×900 · owner — table layout ──");
  {
    const { ctx, page } = await newCtx("desktop", 1440, 900);
    const H = helpers(page);
    await login(page, OWNER);
    await H.waitSel('[data-testid="nav-sidebar"]', 20000);
    await H.clickTid("audit-tab");
    await H.waitSel('[data-testid="aud-root"]');
    await sleep(2500);

    const layoutToday = await page.evaluate((d) => document.querySelector(`[data-testid="aud-day-${d}"] [data-testid="aud-rec-rows"]`)?.tagName, DAYS.today);
    ok("G23 desktop: Today group renders the classic TABLE", layoutToday === "TBODY", layoutToday);
    const stampB = await H.textOf(`aud-rec-stamp-TRANSACTION:transactions:${txB.id}`);
    ok("G24 desktop: time stamp visible in the table row", /15:40/.test(stampB), stampB);
    ok("G25 desktop: history collapsed by default", !(await page.$('[data-testid="aud-history-body"]')));
    await H.clickTid("aud-history-toggle");
    await H.waitSel('[data-testid="aud-history-body"]');
    await sleep(2200);
    const layoutHist = await page.evaluate(() => document.querySelector('[data-testid="aud-history-body"] [data-testid="aud-rec-rows"]')?.tagName);
    ok("G26 desktop: History renders the classic TABLE too", layoutHist === "TBODY", layoutHist);
    // The 40-day fixture sits beyond the first 250 records — page to it.
    let d40Found = !!(await page.$(`[data-testid="aud-history-body"] [data-testid="aud-rec-row-TRANSACTION:transactions:${tx40.id}"]`));
    let dClicks = 0;
    while (!d40Found && (await page.$('[data-testid="aud-history-load-more"]')) && dClicks < 8) {
      await H.clickTid("aud-history-load-more");
      await sleep(2200);
      d40Found = !!(await page.$(`[data-testid="aud-history-body"] [data-testid="aud-rec-row-TRANSACTION:transactions:${tx40.id}"]`));
      dClicks++;
    }
    ok("G27 desktop: 40-day fixture reachable in History (via load-more)", d40Found, `${dClicks} load-more clicks`);
    await ctx.close();
  }

  // ══ 3. TIMEZONE — a viewer far from UTC (America/Regina, UTC-6, no DST):
  //    day grouping must follow the VIEWER's calendar ("Today" is their
  //    today), stamps show local times, and nothing leaks between zones ══
  console.log("\n── 3. PHONE 390×844 · America/Regina viewer — local-day coherence ──");
  {
    const { ctx, page } = await newCtx("tz-phone", 390, 844);
    await page.emulateTimezone("America/Regina");
    const H = helpers(page);
    await login(page, OWNER);
    await H.waitSel('[data-testid="nav-sidebar"]', 20000);
    await H.clickTid("audit-tab");
    await H.waitSel('[data-testid="aud-root"]');
    await sleep(2500);

    const reginaDay = (v) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Regina", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(v));
    const expDayA = reginaDay(txA.created_at);
    const expDayB = reginaDay(txB.created_at);

    // Both today-fixtures group by the viewer's local day of their timestamps
    const tzGroups = await page.evaluate((da, db) => {
      const inGroup = (key) => {
        const rows = [...document.querySelectorAll('section[data-testid^="aud-day-"]')];
        for (const s of rows) {
          const row = s.querySelector(`[data-testid="aud-rec-row-${key}"]`);
          if (row) return s.getAttribute("data-testid").replace("aud-day-", "");
        }
        return null;
      };
      return { a: inGroup(`TRANSACTION:transactions:${da}`), b: inGroup(`TRANSACTION:transactions:${db}`) };
    }, txA.id, txB.id);
    ok("T1 fixtures group by the viewer's LOCAL day (not the server's UTC day)", tzGroups.a === expDayA && tzGroups.b === expDayB && !!expDayA, JSON.stringify({ tzGroups, expDayA }));

    // Local times on the stamps: 09:15Z → 03:15 Regina, 15:40Z → 09:40 Regina
    const stampA = await H.textOf(`aud-rec-stamp-TRANSACTION:transactions:${txA.id}`);
    const stampB = await H.textOf(`aud-rec-stamp-TRANSACTION:transactions:${txB.id}`);
    ok("T2 stamps show the viewer's LOCAL times (03:15 / 09:40)", /03:15/.test(stampA) && /09:40/.test(stampB), `${stampA} | ${stampB}`);

    // Local coherence: every row's stamp date equals its group's date
    const coherence = await page.evaluate(() => {
      const groups = [...document.querySelectorAll('section[data-testid^="aud-day-"]')];
      let rows = 0, mismatches = 0;
      for (const g of groups) {
        const gday = g.getAttribute("data-testid").replace("aud-day-", "");
        for (const r of g.querySelectorAll('[data-testid^="aud-rec-row-"]')) {
          rows++;
          const stamp = r.querySelector('[data-testid^="aud-rec-stamp-"]');
          const stampDay = (stamp?.textContent || "").split(" · ")[0].trim();
          if (stampDay !== gday) mismatches++;
        }
      }
      return { groups: groups.length, rows, mismatches };
    });
    ok("T3 every record's stamp date matches its day group (locally coherent)", coherence.rows > 0 && coherence.mismatches === 0, JSON.stringify(coherence));

    // Split still clean under a non-UTC viewer: history holds none of the
    // 7-day records, and no record appears twice on the page.
    await H.clickTid("aud-history-toggle");
    await H.waitSel('[data-testid="aud-history-body"]');
    await sleep(600);
    const split = await page.evaluate((db) => {
      const inHist = !!document.querySelector(`[data-testid="aud-history-body"] [data-testid="aud-rec-row-TRANSACTION:transactions:${db}"]`);
      const keys = [...document.querySelectorAll('[data-testid^="aud-rec-row-"]')].map((r) => r.getAttribute("data-testid"));
      const dupes = keys.length - new Set(keys).size;
      return { inHist, dupes, total: keys.length };
    }, txB.id);
    ok("T4 History holds no 7-day records; no record rendered twice", !split.inHist && split.dupes === 0 && split.total > 0, JSON.stringify(split));
    await ctx.close();
  }

  ok("G28 zero page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
} finally {
  // ══ Z. Purge every seeded row ══
  const del = await q1(`WITH d AS (DELETE FROM transactions WHERE transaction_number LIKE 'AUDHIST-%' RETURNING 1) SELECT count(*)::int AS n FROM d`);
  console.log(`\ncleanup: purged ${del.n} AUDHIST rows`);
  await client.end();
  await browser.close();
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed · ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
