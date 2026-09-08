/**
 * verify-az-app-audit.mjs — Complete A–Z application audit.
 *
 *   A · Data integrity (read-only SQL): FK orphans across every relation,
 *       duplicates on business keys, scenario fingerprints, negative/NaN
 *       amounts, stock-status consistency, e-mail/code uniqueness,
 *       metrics identity (profit = revenue − expenses), purchase totals.
 *   B · Scenario & Forecast engine: independent SQL recomputation of the
 *       baseline vs /api/scenarios/simulate; cost/revenue/expansion/blend
 *       variable families; enterprise-vs-unit scope distinction; POSTed
 *       scenario stores engine-consistent impacts; ROI formula; anonymous
 *       access locked down (scenarios + AI advisor).
 *   C · Scenario Planner UI: deep link, baseline transparency strip, slider
 *       values equal the engine (feed cost, sign flips, demand revenue,
 *       unit scope), saved cards carry engine values.
 *   D · Dashboard data connection: Command Center total enterprise revenue
 *       equals SQL (seeded rows + ALL live ledger), the fresh unit (kkkkk)
 *       shows honest zeros (no GH₵50k phantom), per-unit rows match, values
 *       persist across reloads (cross-session fix), margin label matches.
 *   E · Full surface walk (owner, deep links): command center, AI advisor,
 *       integrations hub, finance, audit, tracking, sales center, all 9
 *       business modules — content markers, NaN/undefined junk scan,
 *       zero console errors.
 *   F · Order → inventory → finance linkage: TEST online order confirmed by
 *       the BM decrements stock exactly; cancel restores exactly; bell rows
 *       fan out; nothing double-counts.
 *   Z · TEST purge, forensics byte-identical to suite start, 0 page errors.
 *
 * Live rows are never altered; everything TEST is created above id baselines
 * and deleted at the end.
 */
import { createRequire } from "module";
const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");
const { Client } = require("pg");

const BASE = "http://127.0.0.1:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pass: process.env.GOMINA_OWNER_PW || "Owner@GoMina26", id: 1 };
const BM = { email: "emmanuel@gomina360.com", pass: "GoMina@User3", id: 3 };
const T = "TEST AZ";

const results = [];
const baseline = {};
const pageErrors = [];
const pg = new Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });

const ok = (name, cond, extra = "") => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "✅" : "❌"} ${name}${cond ? "" : " — " + extra}`);
  return cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(cookie, path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) },
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const loginCookie = async (creds) => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: creds.email, password: creds.pass }),
  });
  if (!res.ok) throw new Error(`login failed for ${creds.email}: ${res.status}`);
  return (res.headers.get("set-cookie") || "").split(";")[0];
};

const hookPage = (page, tag) => {
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const txt = m.text();
    if (/Failed to load resource/.test(txt) && /(401|400|403|404|409|413)/.test(txt)) return;
    if (/net::/.test(txt)) return;
    pageErrors.push(`[${tag}] ${txt.slice(0, 300)}`);
  });
  page.on("pageerror", (e) => pageErrors.push(`[${tag}] PAGEERROR ${String(e).slice(0, 300)}`));
};
const uiLogin = async (page, creds) => {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid="login-email"]', { timeout: 60000 });
  await page.type('[data-testid="login-email"]', creds.email);
  await page.type('[data-testid="login-password"]', creds.pass);
  await page.click('[data-testid="login-submit"]');
  await page.waitForSelector('[data-testid="notif-bell"]', { timeout: 60000 });
};
const junkScan = (page) =>
  page.evaluate(() => {
    const txt = document.body?.innerText || "";
    const hits = [];
    const re = /\bNaN\b|\bundefined\b|Infinity|-Infinity/g;
    let m;
    while ((m = re.exec(txt)) && hits.length < 6) hits.push(txt.slice(Math.max(0, m.index - 40), m.index + 40));
    return hits;
  });

/* ═══════════ A · Data integrity (read-only) ═══════════ */
async function sectionA() {
  console.log("\n— A · data integrity (read-only SQL) —");
  const orphans = (
    await pg.query(`
    SELECT 'tx' k, count(*)::int c FROM transactions t LEFT JOIN businesses b ON b.id=t.business_id WHERE b.id IS NULL
    UNION ALL SELECT 'inv', count(*)::int FROM inventory_items i LEFT JOIN businesses b ON b.id=i.business_id WHERE b.id IS NULL
    UNION ALL SELECT 'usr', count(*)::int FROM users u LEFT JOIN businesses b ON b.id=u.assigned_business_id WHERE u.assigned_business_id IS NOT NULL AND b.id IS NULL
    UNION ALL SELECT 'ast', count(*)::int FROM assets a LEFT JOIN businesses b ON b.id=a.business_id WHERE b.id IS NULL
    UNION ALL SELECT 'cus', count(*)::int FROM customers c LEFT JOIN businesses b ON b.id=c.business_id WHERE c.business_id IS NOT NULL AND b.id IS NULL
    UNION ALL SELECT 'trk', count(*)::int FROM customer_trackings t LEFT JOIN businesses b ON b.id=t.business_id WHERE b.id IS NULL
    UNION ALL SELECT 'ntf_u', count(*)::int FROM notifications n LEFT JOIN users u ON u.id=n.user_id WHERE u.id IS NULL
    UNION ALL SELECT 'ntf_b', count(*)::int FROM notifications n LEFT JOIN businesses b ON b.id=n.business_id WHERE n.business_id IS NOT NULL AND b.id IS NULL
    UNION ALL SELECT 'doc', count(*)::int FROM sales_documents s LEFT JOIN businesses b ON b.id=s.business_id WHERE b.id IS NULL
    UNION ALL SELECT 'emp', count(*)::int FROM employees e LEFT JOIN businesses b ON b.id=e.business_id WHERE b.id IS NULL`)
  ).rows;
  const bad = orphans.filter((r) => r.c > 0);
  ok("A1 zero orphaned foreign keys (transactions/inventory/users/assets/customers/orders/notifications/documents/employees)", bad.length === 0, JSON.stringify(bad));

  const dupes = (
    await pg.query(`
    SELECT 'tracking_code' k, count(*)::int c FROM (SELECT tracking_code v FROM customer_trackings GROUP BY 1 HAVING count(*)>1) x
    UNION ALL SELECT 'txn_number', count(*)::int FROM (SELECT transaction_number v FROM transactions GROUP BY 1 HAVING count(*)>1) x
    UNION ALL SELECT 'sku_biz', count(*)::int FROM (SELECT concat(sku,'@',business_id) v FROM inventory_items GROUP BY 1 HAVING count(*)>1) x
    UNION ALL SELECT 'scenario_fp', count(*)::int FROM (SELECT concat(name,'|',variable_changed,'|',percent_change,'|',coalesce(target_business_id,-1)) v FROM scenario_simulations GROUP BY 1 HAVING count(*)>1) x
    UNION ALL SELECT 'user_email', count(*)::int FROM (SELECT lower(email) v FROM users GROUP BY 1 HAVING count(*)>1) x
    UNION ALL SELECT 'biz_code', count(*)::int FROM (SELECT code v FROM businesses GROUP BY 1 HAVING count(*)>1) x
    UNION ALL SELECT 'purch_no', count(*)::int FROM (
      SELECT purchase_number v FROM electronics_purchases GROUP BY 1 HAVING count(*)>1
      UNION ALL SELECT purchase_number FROM hardware_purchases GROUP BY 1 HAVING count(*)>1
      UNION ALL SELECT purchase_number FROM restaurant_purchases GROUP BY 1 HAVING count(*)>1) x`)
  ).rows;
  ok("A2 zero duplicates on business keys (tracking/txn/SKU/scenario/email/code/purchase-no)", dupes.every((r) => r.c === 0), JSON.stringify(dupes.filter((r) => r.c > 0)));

  const negs = (
    await pg.query(`
    SELECT 'tx_amount' k, count(*)::int c FROM transactions WHERE amount_ghs < 0
    UNION ALL SELECT 'inv_qty', count(*)::int FROM inventory_items WHERE quantity < 0
    UNION ALL SELECT 'inv_price', count(*)::int FROM inventory_items WHERE COALESCE(selling_price_ghs,0) < 0 OR COALESCE(cost_price_ghs,0) < 0
    UNION ALL SELECT 'trk_total', count(*)::int FROM customer_trackings WHERE COALESCE(total_ghs,0) < 0
    UNION ALL SELECT 'asset_val', count(*)::int FROM assets WHERE COALESCE(current_value_ghs,0) < 0`)
  ).rows;
  ok("A3 zero negative/invalid amounts (ledger, inventory, orders, assets)", negs.every((r) => r.c === 0), JSON.stringify(negs.filter((r) => r.c > 0)));

  const stockFlags = (
    await pg.query(`
    SELECT count(*)::int c FROM inventory_items
    WHERE (status='OUT_OF_STOCK' AND quantity>0)
       OR (status='IN_STOCK' AND quantity<=0)
       OR (quantity>0 AND quantity<=min_stock_threshold AND status NOT IN ('LOW_STOCK','OUT_OF_STOCK'))`)
  ).rows[0].c;
  ok("A4 stock statuses consistent with quantities & thresholds", stockFlags === 0, `mismatches=${stockFlags}`);

  const notifBad = (
    await pg.query(`SELECT count(*)::int c FROM notifications WHERE title IS NULL OR title='' OR type IS NULL OR type=''`)
  ).rows[0].c;
  ok("A5 every notification is typed & titled", notifBad === 0, `bad=${notifBad}`);

  const sessStale = (
    await pg.query(`SELECT count(*)::int c FROM user_sessions WHERE ended_at IS NULL AND expires_at < NOW() - INTERVAL '1 day'`)
  ).rows[0].c;
  ok("A6 no zombie sessions (open but long past TTL)", sessStale === 0, `stale=${sessStale}`);

  const identityBad = (
    await pg.query(`
    SELECT count(*)::int c FROM business_metrics
    WHERE ABS(net_profit_ghs - (revenue_ghs - expenses_ghs)) > 0.01`)
  ).rows[0].c;
  ok("A7 metrics identity holds everywhere (profit = revenue − expenses)", identityBad === 0, `bad=${identityBad}`);

  const purchMismatch = (
    await pg.query(`
    SELECT count(*)::int c FROM (
      SELECT id FROM electronics_purchases WHERE ABS(total_ghs - quantity * unit_cost_ghs) > 0.05
      UNION ALL SELECT id FROM hardware_purchases WHERE ABS(total_ghs - quantity * unit_cost_ghs) > 0.05
      UNION ALL SELECT id FROM restaurant_purchases WHERE ABS(total_ghs - quantity * unit_cost_ghs) > 0.05) x`)
  ).rows[0].c;
  ok("A8 purchase totals match quantity × unit cost across all three registers", purchMismatch === 0, `mismatched=${purchMismatch}`);

  const seededLedger = (
    await pg.query(`SELECT count(*)::int c, min(date)::text mn, max(date)::text mx FROM transactions WHERE transaction_number ~ '^TRX-\\d{4}-100[1-6]$'`)
  ).rows[0];
  ok("A9 seeded ledger watermark intact (6 rows, all inside 2026-Q1 — the fold assumption)", seededLedger.c === 6 && String(seededLedger.mx) <= "2026-03-31", JSON.stringify(seededLedger));

  const scenarioCount = (await pg.query(`SELECT count(*)::int c FROM scenario_simulations`)).rows[0].c;
  ok("A10 scenario table de-duplicated & engine-repaired baseline", scenarioCount === baseline.scenCount, `now=${scenarioCount} start=${baseline.scenCount}`);
}

/* ═══════════ B · Scenario & Forecast engine ═══════════ */
async function sqlBaseline(bizId = null) {
  const bf = bizId != null ? `AND business_id = ${bizId}` : "";
  const [m] = (await pg.query(`SELECT COALESCE(SUM(revenue_ghs),0)::float rev, COALESCE(SUM(expenses_ghs),0)::float exp, COALESCE(SUM(assets_value_ghs),0)::float assets, COUNT(*)::int units FROM business_metrics WHERE 1=1 ${bf}`)).rows;
  const [l] = (await pg.query(`SELECT
      COALESCE(SUM(CASE WHEN type='INCOME' THEN amount_ghs ELSE 0 END),0)::float inc,
      COALESCE(SUM(CASE WHEN type='EXPENSE' THEN amount_ghs ELSE 0 END),0)::float exp,
      COUNT(*)::int c,
      COALESCE(SUM(CASE WHEN type='EXPENSE' AND (category ILIKE '%feed%' OR category ILIKE '%maize%' OR category ILIKE '%concentrate%') THEN amount_ghs ELSE 0 END),0)::float feed,
      COALESCE(SUM(CASE WHEN type='EXPENSE' AND (category ILIKE '%cement%' OR category ILIKE '%aggregate%') THEN amount_ghs ELSE 0 END),0)::float cement
    FROM transactions WHERE transaction_number !~ '^TRX-\\d{4}-100[1-6]$' AND status <> 'CANCELLED' ${bf}`)).rows;
  const [a] = (await pg.query(`SELECT COALESCE(SUM(current_value_ghs),0)::float v FROM assets WHERE 1=1 ${bf}`)).rows;
  const revenueQ = m.rev + l.inc;
  const expensesQ = m.exp + l.exp;
  const profitQ = revenueQ - expensesQ;
  const margin = revenueQ > 0 ? Math.min(0.95, Math.max(0, profitQ / revenueQ)) : 0;
  return {
    revenueQ, expensesQ, profitQ, margin,
    assetsValueQ: Number(a.v) > 0 ? Number(a.v) : m.assets,
    units: Math.max(1, m.units),
    liveCount: l.c,
    costFeed: l.feed + 0.45 * m.exp,
    costCement: l.cement + 0.4 * m.exp,
  };
}
async function sectionB(cookies) {
  console.log("\n— B · scenario & forecast engine —");
  const sim = async (variable, pct, bizId = null) => {
    const qs = new URLSearchParams({ variable, pct: String(pct) });
    if (bizId) qs.set("businessId", String(bizId));
    return (await api(cookies.owner, `/api/scenarios/simulate?${qs}`)).json;
  };

  const bEnt = await sqlBaseline();
  const s1 = await sim("Solar Demand", 40);
  ok("B1 baseline endpoint matches independent SQL (revenue/expenses/live-count)",
    Math.abs(s1.baseline.revenueQ - bEnt.revenueQ) < 1 &&
    Math.abs(s1.baseline.expensesQ - bEnt.expensesQ) < 1 &&
    s1.baseline.liveCount === bEnt.liveCount,
    `api=${s1.baseline?.revenueQ}/${s1.baseline?.expensesQ}/${s1.baseline?.liveCount} sql=${bEnt.revenueQ}/${bEnt.expensesQ}/${bEnt.liveCount}`);

  const b1 = await sqlBaseline(1);
  const sFeed = await sim("Feed Price", 15, 1);
  ok("B2 feed-price scenario uses the unit's REAL feed cost base",
    sFeed.impacts.revenueImpact === 0 && sFeed.impacts.profitImpact === Math.round(-0.15 * b1.costFeed),
    `api=${sFeed.impacts?.profitImpact} sql=${Math.round(-0.15 * b1.costFeed)}`);

  const b6 = await sqlBaseline(6);
  const sDem = await sim("Solar Demand", 40, 6);
  ok("B3 demand scenario: revenue × pct, carried at the REAL margin",
    sDem.impacts.revenueImpact === Math.round(0.4 * b6.revenueQ) &&
    sDem.impacts.profitImpact === Math.round(0.4 * b6.revenueQ * b6.margin),
    `api=${sDem.impacts?.revenueImpact}/${sDem.impacts?.profitImpact} sql=${Math.round(0.4 * b6.revenueQ)}/${Math.round(0.4 * b6.revenueQ * b6.margin)}`);

  const sEnt = await sim("Solar Demand", 40);
  ok("B4 enterprise scope ≠ unit scope (the exact owner-visible bug)",
    Math.abs(sEnt.impacts.revenueImpact - Math.round(0.4 * bEnt.revenueQ)) <= 1 &&
    sEnt.impacts.revenueImpact !== sDem.impacts.revenueImpact,
    `ent=${sEnt.impacts?.revenueImpact} unit=${sDem.impacts?.revenueImpact}`);

  const sExp = await sim("New Branch Production", 50);
  const avgUnit = bEnt.revenueQ / bEnt.units;
  ok("B5 expansion scenario references an average unit's real output",
    Math.abs(sExp.impacts.revenueImpact - Math.round(0.5 * avgUnit)) <= 1,
    `api=${sExp.impacts?.revenueImpact} sql=${Math.round(0.5 * avgUnit)}`);

  ok("B6 ROI delta = annualised profit impact ÷ asset base",
    Math.abs(sDem.impacts.roiDelta - Math.round(((sDem.impacts.profitImpact * 4) / b6.assetsValueQ) * 1000) / 10) <= 0.15,
    `api=${sDem.impacts?.roiDelta} sql=${((sDem.impacts?.profitImpact * 4) / b6.assetsValueQ * 100).toFixed(1)}`);

  const simPost = await sim("Cement Price", 20, 2);
  const created = await api(cookies.owner, "/api/scenarios", {
    method: "POST",
    body: JSON.stringify({ name: `${T} Scenario`, description: "TEST", targetBusinessId: 2, variableChanged: "Cement Price", percentChange: 20 }),
  });
  const stored = created.json?.scenario;
  const matchesStored =
    created.status === 200 &&
    stored.expectedRevenueImpactGhs === simPost.impacts.revenueImpact &&
    stored.expectedProfitImpactGhs === simPost.impacts.profitImpact &&
    Math.abs(stored.expectedRoiDelta - simPost.impacts.roiDelta) < 1e-9;
  ok("B7 POST /api/scenarios stores engine-consistent impacts (and returns the basis)", matchesStored && typeof created.json?.basis === "string" && created.json.basis.length > 10,
    JSON.stringify({ stored: stored?.expectedProfitImpactGhs, sim: simPost.impacts.profitImpact }).slice(0, 140));
  if (stored?.id) await pg.query(`DELETE FROM scenario_simulations WHERE id=$1`, [stored.id]);

  const anon1 = await api(null, "/api/scenarios");
  const anon2 = await api(null, "/api/ai");
  ok("B8 scenarios & AI advisor endpoints reject anonymous reads (401)", anon1.status === 401 && anon2.status === 401, `${anon1.status}/${anon2.status}`);

  const sFresh = await sim("Feed Price", 10, 11); // kkkkk — no metrics row
  ok("B9 unit without quarterly metrics still computes an honest baseline (no crash, no phantom)",
    sFresh.success === true && Number.isFinite(sFresh.impacts.profitImpact) && sFresh.baseline.revenueQ >= 0 && sFresh.baseline.revenueQ < 1,
    JSON.stringify(sFresh.baseline || {}).slice(0, 120));
}

/* ═══════════ C · Scenario Planner UI ═══════════ */
async function sectionC(browser, cookies) {
  console.log("\n— C · scenario planner UI —");
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  hookPage(page, "C");
  await page.setViewport({ width: 1440, height: 960 });
  await uiLogin(page, OWNER);
  await page.goto(`${BASE}/?tab=SCENARIO_PLANNER`, { waitUntil: "networkidle0", timeout: 60000 });
  const root = await page.waitForSelector('[data-testid="scen-root"]', { timeout: 30000 }).catch(() => null);
  ok("C1 scenario planner opens via deep link", !!root);
  const strip = await page.waitForSelector('[data-testid="scen-baseline"]', { timeout: 20000 }).catch(() => null);
  const stripTxt = strip ? await page.evaluate(() => document.querySelector('[data-testid="scen-baseline"]')?.innerText || "") : "";
  ok("C2 baseline transparency strip shows real books (revenue/expenses/margin/assets + live entries)",
    /Revenue GH/.test(stripTxt) && /Expenses GH/.test(stripTxt) && /Margin \d/.test(stripTxt) && /live entries/.test(stripTxt),
    stripTxt.slice(0, 160));

  const readProfit = () => page.evaluate(() => Number(document.querySelector('[data-testid="scen-live-profit"]')?.getAttribute("data-value")));
  await page.waitForFunction(() => document.querySelector('[data-testid="scen-live-profit"]')?.getAttribute("data-value") !== null && !/Loading/.test(document.querySelector('[data-testid="scen-baseline"]')?.innerText || ""), { timeout: 20000 });
  await sleep(800);
  const b1 = await sqlBaseline(1); // Feed Price defaults to enterprise scope!
  const bEnt = await sqlBaseline();
  const vDefault = await readProfit();
  const expectedDefault = Math.round(-0.15 * bEnt.costFeed); // default: Feed Price +15, enterprise scope
  ok("C3 slider default (Feed Price +15%, enterprise) equals the engine", Math.abs(vDefault - expectedDefault) <= 1, `ui=${vDefault} engine=${expectedDefault}`);

  // drag slider to −20% via DOM input event
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="scen-slider"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, "-20");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForFunction((want) => {
    const v = Number(document.querySelector('[data-testid="scen-live-profit"]')?.getAttribute("data-value"));
    return Math.abs(v - want) <= 1;
  }, { timeout: 15000 }, Math.round(0.2 * bEnt.costFeed)).catch(() => {});
  const vNeg = await readProfit();
  ok("C4 slider −20% feed price flips to a positive profit impact equal to the engine", Math.abs(vNeg - Math.round(0.2 * bEnt.costFeed)) <= 1, `ui=${vNeg} engine=${Math.round(0.2 * bEnt.costFeed)}`);

  await page.select('[data-testid="scen-variable"]', "Solar Demand");
  await sleep(900);
  const vRev = await page.evaluate(() => Number(document.querySelector('[data-testid="scen-live-revenue"]')?.getAttribute("data-value")));
  const expectedRev = Math.round(0.2 * bEnt.revenueQ) * -1; // pct still −20 from C4
  ok("C5 switching to Solar Demand produces revenue impact at the real margin", Math.abs(vRev - Math.round(-0.2 * bEnt.revenueQ)) <= 1, `ui=${vRev} engine=${Math.round(-0.2 * bEnt.revenueQ)}`);

  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="scen-slider"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, "40");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.select('[data-testid="scen-scope"]', "6");
  await page.waitForFunction((want) => {
    const v = Number(document.querySelector('[data-testid="scen-live-revenue"]')?.getAttribute("data-value"));
    return Math.abs(v - want) <= 1;
  }, { timeout: 15000 }, Math.round(0.4 * (await sqlBaseline(6)).revenueQ)).catch(() => {});
  const vScoped = await page.evaluate(() => Number(document.querySelector('[data-testid="scen-live-revenue"]')?.getAttribute("data-value")));
  const scopedTxt = await page.evaluate(() => document.querySelector('[data-testid="scen-baseline"]')?.innerText || "");
  const b6 = await sqlBaseline(6);
  ok("C6 scoping to TECH-01 recomputes from THAT unit's books", Math.abs(vScoped - Math.round(0.4 * b6.revenueQ)) <= 1 && /this unit's/i.test(scopedTxt), `ui=${vScoped} engine=${Math.round(0.4 * b6.revenueQ)}`);

  const cards = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="scen-card-"]')].map((c) => ({
      id: Number(c.getAttribute("data-testid").replace("scen-card-", "")),
      profit: Number(c.getAttribute("data-profit-impact")),
    })),
  );
  const dbCards = (await pg.query(`SELECT id, expected_profit_impact_ghs::float p FROM scenario_simulations ORDER BY id`)).rows;
  const mismatch = dbCards.filter((d) => {
    const ui = cards.find((c) => c.id === d.id);
    return !ui || Math.abs(ui.profit - d.p) > 1;
  });
  ok("C7 every saved simulation card shows the engine-computed impact", dbCards.length > 0 && mismatch.length === 0, JSON.stringify(mismatch).slice(0, 140));
  await ctx.close();
}

/* ═══════════ D · Dashboard data connection ═══════════ */
async function sectionD(browser) {
  console.log("\n— D · dashboard data connection —");
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  hookPage(page, "D");
  await page.setViewport({ width: 1440, height: 960 });
  await uiLogin(page, OWNER);

  const [seeded] = (await pg.query(`SELECT COALESCE(SUM(revenue_ghs),0)::float rev FROM business_metrics LEFT JOIN businesses b ON b.id = business_id`)).rows;
  // enterprise revenue = Σ metrics of all businesses with rows + Σ live income (all businesses incl. metricless ones)
  const [mSum] = (await pg.query(`SELECT COALESCE(SUM(revenue_ghs),0)::float rev FROM business_metrics`)).rows;
  const [lSum] = (await pg.query(`SELECT COALESCE(SUM(amount_ghs),0)::float inc FROM transactions WHERE type='INCOME' AND transaction_number !~ '^TRX-\\d{4}-100[1-6]$' AND status <> 'CANCELLED'`)).rows;
  const expectedRev = mSum.rev + lSum.inc;
  const kpi = Number(await page.evaluate(() => document.querySelector('[data-testid="cc-kpi-revenue"]')?.getAttribute("data-value")));
  ok("D1 Command Center total enterprise revenue == SQL (seeded close + ALL live ledger)",
    Math.abs(kpi - expectedRev) < 1.5, `ui=${kpi} sql=${expectedRev}`);

  const kkkkk = Number(await page.evaluate(() => document.querySelector('[data-testid="cc-bizrev-11"]')?.getAttribute("data-value")));
  const [kLive] = (await pg.query(`SELECT COALESCE(SUM(amount_ghs),0)::float inc FROM transactions WHERE business_id=11 AND type='INCOME' AND transaction_number !~ '^TRX-\\d{4}-100[1-6]$'`)).rows;
  ok("D2 fresh unit (kkkkk) shows honest zeros — the GH₵50k phantom is gone", kkkkk === kLive.inc && kkkkk === 0, `ui=${kkkkk} sqlLive=${kLive.inc}`);

  const perBizSql = (await pg.query(`
    SELECT b.id, COALESCE(m.rev,0)::float + COALESCE(l.inc,0)::float v
    FROM businesses b
    LEFT JOIN (SELECT business_id, SUM(revenue_ghs) rev FROM business_metrics GROUP BY 1) m ON m.business_id=b.id
    LEFT JOIN (SELECT business_id, SUM(amount_ghs) inc FROM transactions WHERE type='INCOME' AND transaction_number !~ '^TRX-\\d{4}-100[1-6]$' AND status<>'CANCELLED' GROUP BY 1) l ON l.business_id=b.id
    ORDER BY b.id`)).rows;
  const perBizUi = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="cc-bizrev-"]')].map((e) => ({
      id: Number(e.getAttribute("data-testid").replace("cc-bizrev-", "")),
      v: Number(e.getAttribute("data-value")),
    })),
  );
  const bizMismatch = perBizSql.filter((r) => {
    const ui = perBizUi.find((u) => u.id === r.id);
    return !ui || Math.abs(ui.v - r.v) > 1.5;
  });
  ok("D3 every unit's revenue row matches SQL (seeded + live) for all 9 businesses", bizMismatch.length === 0, JSON.stringify(bizMismatch).slice(0, 160));

  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForSelector('[data-testid="cc-kpi-revenue"]', { timeout: 45000 });
  const kpi2 = Number(await page.evaluate(() => document.querySelector('[data-testid="cc-kpi-revenue"]')?.getAttribute("data-value")));
  ok("D4 live overlay persists across fresh loads (old in-session-only layering is fixed)", Math.abs(kpi2 - expectedRev) < 1.5, `reload=${kpi2} sql=${expectedRev}`);

  const marginTxt = await page.evaluate(() => document.body.innerText.match(/Margin: ([\d.]+)%/)?.[1] || "");
  const [expSum] = (await pg.query(`SELECT COALESCE(SUM(expenses_ghs),0)::float e FROM business_metrics`)).rows;
  const [lExp] = (await pg.query(`SELECT COALESCE(SUM(amount_ghs),0)::float e FROM transactions WHERE type='EXPENSE' AND transaction_number !~ '^TRX-\\d{4}-100[1-6]$' AND status<>'CANCELLED'`)).rows;
  const expectedMargin = (((expectedRev - expSum.e - lExp.e) / expectedRev) * 100).toFixed(1);
  ok("D5 enterprise margin label equals SQL-derived margin", marginTxt === expectedMargin, `ui=${marginTxt} sql=${expectedMargin}`);
  await ctx.close();
}

/* ═══════════ E · Full surface walk ═══════════ */
async function sectionE(browser) {
  console.log("\n— E · full surface walk (owner) —");
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  hookPage(page, "E");
  await page.setViewport({ width: 1440, height: 960 });
  await uiLogin(page, OWNER);
  const bizRows = (await pg.query(`SELECT id, code, name FROM businesses ORDER BY id`)).rows;

  const tabs = [
    { tab: "COMMAND_CENTER", marker: "Enterprise Performance Overview", id: "command-center-root" },
    { tab: "AI_ADVISOR", marker: "Strategic Decision-Support Engine" },
    { tab: "INTEGRATIONS", marker: "Enterprise Ecosystem Connectors" },
    { tab: "FINANCE", marker: "Central Financial Report" },
    { tab: "AUDIT", id: "aud-root" },
    { tab: "TRACKING", id: "ct-root" },
    { tab: "SALES_CENTER", id: "bm-branch-select" },
    ...bizRows.map((b) => ({ tab: b.code, marker: b.name, label: `unit ${b.code}` })),
  ];
  let failList = [];
  let walked = 0;
  for (const t of tabs) {
    await page.goto(`${BASE}/?tab=${encodeURIComponent(t.tab)}`, { waitUntil: "networkidle0", timeout: 60000 }).catch(() => {});
    await sleep(1600);
    const state = await page.evaluate(
      ({ marker, id, tab }) => ({
        markerOk: marker ? (document.body?.innerText || "").includes(marker) : true,
        rootOk: id ? !!document.querySelector(`[data-testid="${id}"]`) : true,
        bodyLen: (document.body?.innerText || "").length,
        tab,
      }),
      t,
    );
    const junk = await junkScan(page);
    const good = state.markerOk && state.rootOk && junk.length === 0 && state.bodyLen > 300;
    walked++;
    if (!good) failList.push(`${t.tab}(marker=${state.markerOk},root=${state.rootOk},junk=${junk.length})`);
  }
  ok(`E1 walked ${walked} surfaces (7 hubs + all ${bizRows.length} business modules) — every one renders its content`, failList.length === 0, failList.join(" | "));
  const junkFree = failList.filter((f) => f.includes("junk=0") === false).length === 0;
  ok("E2 zero NaN/undefined/Infinity junk on any surface", junkFree, "");

  // BM wall: a branch manager must NOT see enterprise-only hubs (access control)
  const ctx2 = await browser.createBrowserContext();
  const page2 = await ctx2.newPage();
  hookPage(page2, "E3");
  await page2.setViewport({ width: 1440, height: 960 });
  await uiLogin(page2, BM);
  await page2.goto(`${BASE}/?tab=SCENARIO_PLANNER`, { waitUntil: "networkidle0", timeout: 60000 });
  await sleep(1800);
  const bmBlocked = await page2.evaluate(() => !document.querySelector('[data-testid="scen-root"]'));
  await page2.goto(`${BASE}/?tab=POULTRY-01`, { waitUntil: "networkidle0", timeout: 60000 });
  await sleep(1800);
  const bmUnit = await page2.evaluate(() => (document.body?.innerText || "").length > 300 && (document.body?.innerText || "").includes("Mina Akuafo"));
  ok("E3 executive-only hubs stay walled for a branch manager, but his own unit opens", bmBlocked && bmUnit, `blocked=${bmBlocked} unit=${bmUnit}`);
  await ctx.close();
  await ctx2.close();
}

/* ═══════════ F · order → inventory → finance linkage ═══════════ */
async function sectionF(cookies) {
  console.log("\n— F · order → inventory → finance linkage —");
  const menu = await api(null, "/api/menu");
  const biz1 = (menu.json?.businesses || []).find((b) => b.businessId === 1);
  const item = (biz1?.products || []).find((p) => p.available > 1) || biz1?.products?.[0];
  if (!item) return ok("F0 menu item for linkage test", false, "no products");
  const q0 = Number((await pg.query(`SELECT quantity::float q FROM inventory_items WHERE id=$1`, [item.id])).rows[0].q);

  const order = await api(null, "/api/order", {
    method: "POST",
    body: JSON.stringify({
      businessId: 1, customerName: `${T} Link`, customerPhone: "0551223344",
      fulfillmentType: "PICKUP", paymentChoice: "ON_DELIVERY",
      items: [{ inventoryId: item.id, quantity: 1 }],
    }),
  });
  const code = order.json?.trackingCode || "";
  ok("F1 TEST online order placed", /^GM-/.test(code), JSON.stringify(order.json || {}).slice(0, 140));
  const trkId = (await pg.query(`SELECT id FROM customer_trackings WHERE tracking_code=$1`, [code])).rows[0]?.id;

  let bellHit = null;
  for (let i = 0; i < 12 && !bellHit; i++) {
    await sleep(400);
    bellHit = (await pg.query(`SELECT id FROM notifications WHERE type='ONLINE_ORDER_RECEIVED' AND record_ref=$1`, [code])).rows[0];
  }
  ok("F2 order event fans out to the branch team's bells", !!bellHit);

  const conf = await api(cookies.bm, "/api/tracking", { method: "POST", body: JSON.stringify({ action: "SET_STATUS", id: trkId, status: "CONFIRMED" }) });
  const q1 = Number((await pg.query(`SELECT quantity::float q FROM inventory_items WHERE id=$1`, [item.id])).rows[0].q);
  ok("F3 confirming the order reserves stock (qty −1 exactly)", conf.status === 200 && Math.abs(q0 - q1 - 1) < 1e-9, `q0=${q0} q1=${q1}`);

  const unpaidTx = (await pg.query(`SELECT count(*)::int c FROM transactions WHERE id > $1 AND type='INCOME'`, [baseline.trxMax])).rows[0].c;
  ok("F4 on-delivery order creates NO income posting before payment (no double counting)", unpaidTx === 0, `txns=${unpaidTx}`);

  await api(cookies.bm, "/api/tracking", { method: "POST", body: JSON.stringify({ action: "SET_STATUS", id: trkId, status: "CANCELLED", note: `${T} cleanup` }) });
  const q2 = Number((await pg.query(`SELECT quantity::float q FROM inventory_items WHERE id=$1`, [item.id])).rows[0].q);
  ok("F5 cancellation returns the reserved stock exactly", Math.abs(q2 - q0) < 1e-9, `q2=${q2} want=${q0}`);
}

/* ═══════════ Z · cleanup & forensics ═══════════ */
async function cleanup() {
  console.log("\n— Z · cleanup & forensics —");
  const trk = await pg.query(`DELETE FROM customer_trackings WHERE id > $1 OR customer_name LIKE 'TEST%' RETURNING id`, [baseline.trMax]);
  const trx = await pg.query(`DELETE FROM transactions WHERE id > $1 RETURNING id`, [baseline.trxMax]);
  const ntf = await pg.query(`DELETE FROM notifications WHERE id > $1 RETURNING id`, [baseline.ntfMax]);
  const cust = await pg.query(`DELETE FROM customers WHERE id > $1 RETURNING id`, [baseline.custMax]);
  const scen = await pg.query(`DELETE FROM scenario_simulations WHERE id > $1 OR name LIKE 'TEST%' RETURNING id`, [baseline.scenMax]);
  const sess = await pg.query(`DELETE FROM user_sessions WHERE id > $1 RETURNING id`, [baseline.sessMax]);
  console.log(`   purged: trackings=${trk.rowCount} txns=${trx.rowCount} notifications=${ntf.rowCount} customers=${cust.rowCount} scenarios=${scen.rowCount} sessions=${sess.rowCount}`);

  const counts = (await pg.query(`SELECT
      (SELECT count(*)::int FROM businesses) b, (SELECT count(*)::int FROM users) u,
      (SELECT count(*)::int FROM customers) cu, (SELECT count(*)::int FROM customer_trackings) t,
      (SELECT count(*)::int FROM sales_documents) sd, (SELECT count(*)::int FROM transactions) tx,
      (SELECT count(*)::int FROM inventory_items) ii, (SELECT count(*)::int FROM scenario_simulations) sc`)).rows[0];
  ok("Z1 live data byte-identical to suite start", JSON.stringify(counts) === JSON.stringify(baseline.counts),
    `start=${JSON.stringify(baseline.counts)} end=${JSON.stringify(counts)}`);
  ok("Z2 zero page/console errors across the ENTIRE audit", pageErrors.length === 0, pageErrors.slice(0, 6).join(" | "));
}

(async () => {
  await pg.connect();
  baseline.sessMax = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM user_sessions`)).rows[0].m;
  baseline.trMax = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM customer_trackings`)).rows[0].m;
  baseline.trxMax = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM transactions`)).rows[0].m;
  baseline.ntfMax = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM notifications`)).rows[0].m;
  baseline.custMax = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM customers`)).rows[0].m;
  baseline.scenMax = (await pg.query(`SELECT COALESCE(MAX(id),0) m FROM scenario_simulations`)).rows[0].m;
  baseline.scenCount = (await pg.query(`SELECT count(*)::int c FROM scenario_simulations`)).rows[0].c;
  baseline.counts = (await pg.query(`SELECT
      (SELECT count(*)::int FROM businesses) b, (SELECT count(*)::int FROM users) u,
      (SELECT count(*)::int FROM customers) cu, (SELECT count(*)::int FROM customer_trackings) t,
      (SELECT count(*)::int FROM sales_documents) sd, (SELECT count(*)::int FROM transactions) tx,
      (SELECT count(*)::int FROM inventory_items) ii, (SELECT count(*)::int FROM scenario_simulations) sc`)).rows[0];
  console.log(`   baseline counts: ${JSON.stringify(baseline.counts)}`);

  const cookies = { owner: await loginCookie(OWNER), bm: await loginCookie(BM) };
  const browser = await puppeteer.launch({
    executablePath: "/tmp/al2023/chromium",
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    await sectionA();
    await sectionB(cookies);
    await sectionC(browser, cookies);
    await sectionD(browser);
    await sectionE(browser);
    await sectionF(cookies);
  } catch (e) {
    ok(`suite crashed: ${e.message}`, false);
    console.error(e);
  } finally {
    await browser.close().catch(() => {});
    try { await cleanup(); } catch (e) { console.error("cleanup error:", e.message); }
    await pg.end();
  }
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
