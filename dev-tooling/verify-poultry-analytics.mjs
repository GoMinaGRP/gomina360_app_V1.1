// Live verification of the Poultry Production & Growth Analytics panel:
// 8 charts (daily growth vs target, weight-by-age, feed, FCR, mortality,
// broiler harvests, lay target-vs-actual, egg output) + KPI chips, driven
// by Batch / Flock / Branch filters + the dashboard date/product filters.
// A dense TEST flock/batch dataset is injected (SQL, zero transaction side-
// effects), every chart value is cross-checked against the database, then
// all TEST rows are purged and forensics must match the captured baseline.
// Run: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-poultry-analytics.mjs

import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");
const pg = req("pg");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.OWNER_PW || "Owner@GoMina26" };

const checks = [];
let failures = 0;
const ok = (name, cond, extra = "") => { checks.push({ name, pass: !!cond }); if (!cond) failures++; console.log(`${cond ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`); };

const client = new pg.Client(process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db");
await client.connect();
const q = async (sql) => (await client.query(sql)).rows;
const q1 = async (sql) => (await q(sql))[0];

const D = (offsetDays) => { const d = new Date(); d.setDate(d.getDate() + offsetDays); return d.toISOString().split("T")[0]; };

const pageErrors = [];
const browser = await puppeteer.launch({ executablePath: "/tmp/al2023/chromium", headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--window-size=1500,950"] });
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") { const t = m.text(); if (!/401|Failed to load resource|net::ERR_/.test(t)) pageErrors.push(t); } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitSel = (sel, t = 15000) => page.waitForSelector(sel, { timeout: t });
const exists = async (sel) => !!(await page.$(sel));
const textOf = async (sel) => page.$eval(sel, (e) => e.textContent || "").catch(() => "");
const setVal = async (sel, val) => page.evaluate((s, v) => {
  const el = document.querySelector(s);
  const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}, sel, val);
const setTid = (tid, val) => setVal(`[data-testid="${tid}"]`, val);
const clickTid = async (tid) => { await waitSel(`[data-testid="${tid}"]`); await page.$eval(`[data-testid="${tid}"]`, (e) => e.click()); };
// series probes inside a chart card
const bars = async (tid) => page.$$eval(`[data-testid="${tid}"] .recharts-rectangle`, (n) => n.length).catch(() => 0);
const lines = async (tid) => page.$$eval(`[data-testid="${tid}"] .recharts-line-curve`, (n) => n.length).catch(() => 0);
const emptyShown = async (name) => !!(await page.$(`[data-testid="poa-empty-${name}"]`));

const B = {
  flocks: Number((await q1("SELECT count(*) c FROM poultry_flocks")).c),
  feed: Number((await q1("SELECT count(*) c FROM poultry_feed_logs")).c),
  health: Number((await q1("SELECT count(*) c FROM poultry_health_records")).c),
  prod: Number((await q1("SELECT count(*) c FROM poultry_production")).c),
  txn: Number((await q1("SELECT count(*) c FROM transactions")).c),
  sessionMax: (await q1("SELECT COALESCE(max(id),0) m FROM user_sessions")).m,
};

const BROILER_WEIGHTS = [1.05, 1.15, 1.25, 1.36, 1.47, 1.6, 1.75, 1.9];  // ages 28–35 d (8 daily samples)
const BROILER_FCR = [1.3, 1.35, 1.42, 1.48, 1.55, 1.58, 1.62, 1.65];
const FEED_KG = [92, 95, 98, 101, 104, 107, 110, 113];
const LAY = [76.8, 78.8, 79.8, 80.8, 81.8];
const EGGS = [380, 390, 395, 400, 405];

try {
  // ══ A. Dense TEST dataset (SQL; no transactions are created) ══════════
  console.log("── A. Inject TEST broiler + layer analytics dataset ──");
  const fb = await q1(`INSERT INTO poultry_flocks (business_id, branch_code, branch_name, batch_number, flock_name, bird_type, breed, initial_count, current_count, mortality_total, arrival_date, age_weeks, status, created_by_name, created_by_role)
    VALUES (1,'POULTRY-01','Nsawam','TEST-AN-B01','TEST Analytics Broilers','BROILERS','Ross 308',1000,960,40,'${D(-35)}',5,'ACTIVE','TEST Analytics','OWNER') RETURNING id`);
  const fl = await q1(`INSERT INTO poultry_flocks (business_id, branch_code, branch_name, batch_number, flock_name, bird_type, breed, initial_count, current_count, mortality_total, arrival_date, age_weeks, status, created_by_name, created_by_role)
    VALUES (1,'POULTRY-01','Nsawam','TEST-AN-L01','TEST Analytics Layers','LAYERS','Isa Brown',500,494,6,'${D(-196)}',28,'ACTIVE','TEST Analytics','OWNER') RETURNING id`);
  for (let i = 0; i < 8; i++) {
    const date = D(-7 + i); // today-7 .. today
    await client.query(`INSERT INTO poultry_feed_logs (business_id, branch_code, flock_id, batch_number, feed_type, quantity_kg, cost_per_kg_ghs, total_cost_ghs, entry_type, recorded_date, recorded_by_name, recorded_by_role)
      VALUES (1,'POULTRY-01',$1,'TEST-AN-B01','FINISHER',$2,0,0,'CONSUMPTION',$3,'TEST Analytics','OWNER')`, [fb.id, FEED_KG[i], date]);
    await client.query(`INSERT INTO poultry_production (business_id, branch_code, flock_id, batch_number, production_type, eggs_collected, trays_produced, birds_harvested, total_weight_kg, avg_weight_kg, lay_percentage, fcr, revenue_ghs, recorded_date, recorded_by_name)
      VALUES (1,'POULTRY-01',$1,'TEST-AN-B01','BROILER_WEIGHT',0,0,$2,$3,$4,0,$5,0,$6,'TEST Analytics')`,
      [fb.id, i >= 6 ? (i === 6 ? 100 : 200) : 0, i >= 6 ? (i === 6 ? 175 : 380) : 0, BROILER_WEIGHTS[i], BROILER_FCR[i], date]);
  }
  for (const [off, deaths] of [[-6, 3], [-4, 4], [-2, 2], [0, 2]]) {
    await client.query(`INSERT INTO poultry_health_records (business_id, branch_code, flock_id, batch_number, record_type, disease_or_condition, birds_affected, mortality_count, cost_ghs, recorded_date, recorded_by_name)
      VALUES (1,'POULTRY-01',$1,'TEST-AN-B01','MORTALITY','TEST natural losses',0,$2,0,$3,'TEST Analytics')`, [fb.id, deaths, D(off)]);
  }
  for (let i = 0; i < 5; i++) {
    const date = D(-4 + i);
    await client.query(`INSERT INTO poultry_production (business_id, branch_code, flock_id, batch_number, production_type, eggs_collected, trays_produced, birds_harvested, total_weight_kg, avg_weight_kg, lay_percentage, fcr, revenue_ghs, recorded_date, recorded_by_name)
      VALUES (1,'POULTRY-01',$1,'TEST-AN-L01','EGGS',$2,$3,0,0,0,$4,0,0,$5,'TEST Analytics')`,
      [fl.id, EGGS[i], +(EGGS[i] / 30).toFixed(1), LAY[i], date]);
  }
  ok("A1 TEST broiler + layer flocks & logs injected", true, `${fb.id}/${fl.id}`);

  // ══ B. Panel renders with every chart live ════════════════════════════
  console.log("── B. Dashboard analytics panel ──");
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 45000 });
  await waitSel('[data-testid="login-email"]');
  await setTid("login-email", OWNER.email);
  await setTid("login-password", OWNER.pw);
  await clickTid("login-submit");
  await page.waitForFunction(() => !document.querySelector('[data-testid="login-screen"]'), { timeout: 30000 });
  await sleep(1600);
  await page.evaluate(() => { const el = [...document.querySelectorAll("aside button")].find((b) => (b.textContent || "").includes("Mina Akuafo Poultry Farm")); el.click(); });
  await waitSel('[data-testid="poa-root"]', 25000);
  ok("B1 analytics panel mounted on the dashboard", await exists('[data-testid="poa-root"]'));
  ok("B2 batch/flock/branch filters present", (await exists('[data-testid="poa-filter-batch"]')) && (await exists('[data-testid="poa-filter-flock"]')) && (await exists('[data-testid="poa-filter-branch"]')));
  await sleep(1200);
  ok("B3 daily growth trend (actual + target) rendered", (await lines("poa-chart-growth")) >= 2, `${await lines("poa-chart-growth")} lines`);
  const b4Bars = await bars("poa-chart-weight-age"), b4Lines = await lines("poa-chart-weight-age");
  ok("B4 average weight by age chart rendered (W4/W5 buckets + target line)", b4Bars >= 2 && b4Lines >= 1, `${b4Bars} bars/${b4Lines} lines`);
  ok("B5 daily feed consumption chart rendered", (await bars("poa-chart-feed")) >= 8, `${await bars("poa-chart-feed")} bars`);
  ok("B6 FCR trend rendered", (await lines("poa-chart-fcr")) >= 1);
  ok("B7 mortality rate chart rendered (deaths + cumulative %)", (await lines("poa-chart-mortality")) >= 2);
  ok("B8 broiler production trend rendered (bars + weight line)", (await bars("poa-chart-broiler")) >= 2 && (await lines("poa-chart-broiler")) >= 1);
  ok("B9 production targets vs actual (lay %) rendered", (await lines("poa-chart-targets")) >= 2);
  ok("B10 egg output trend rendered", (await bars("poa-chart-eggs")) >= 5);
  await page.$eval('[data-testid="poa-root"]', (e) => e.scrollIntoView({ block: "start" }));
  await sleep(700);
  await page.screenshot({ path: "/home/user/poa-1-desktop-analytics.png", fullPage: false });
  await page.$eval('[data-testid="poa-chart-mortality"]', (e) => e.scrollIntoView({ block: "start" }));
  await sleep(700);
  await page.screenshot({ path: "/home/user/poa-3-desktop-charts.png", fullPage: false });

  // ══ C. KPI chips truth-checked against the database ═══════════════════
  console.log("── C. KPI chips vs database ──");
  await setTid("poa-filter-batch", "TEST-AN-B01");
  await sleep(1200);
  const feedExp = FEED_KG.reduce((a, b) => a + b, 0); // 840
  const fcrExp = (BROILER_FCR.reduce((a, b) => a + b, 0) / BROILER_FCR.length).toFixed(2); // 1.50
  const livExp = (100 - (11 / 1000) * 100).toFixed(2); // 98.90
  const gainExp = (((1.9 - 1.05) * 1000) / 7).toFixed(1); // 121.4
  ok("C1 batch scope: feed + birds placed chips", (await textOf('[data-testid="poa-kpi-placed"]')).includes("1,000") && (await textOf('[data-testid="poa-kpi-feed-bird"]')).includes(`${feedExp} kg`), await textOf('[data-testid="poa-kpi-feed-bird"]'));
  ok("C2 batch scope: avg FCR chip", (await textOf('[data-testid="poa-kpi-fcr"]')).includes(fcrExp), fcrExp);
  ok("C3 batch scope: livability chip (11 deaths)", (await textOf('[data-testid="poa-kpi-livability"]')).includes(livExp), livExp);
  ok("C4 batch scope: avg daily gain chip", (await textOf('[data-testid="poa-kpi-gain"]')).includes(`${gainExp} g`), `${gainExp} g`);
  ok("C5 batch scope: harvested chip (100+200)", (await textOf('[data-testid="poa-kpi-harvest"]')).includes("300"));
  ok("C6 batch scope hides lay charts (empty states)", (await emptyShown("targets")) && (await emptyShown("eggs")));
  ok("C7 batch scope keeps 8 days of feed bars", (await bars("poa-chart-feed")) === 8, `${await bars("poa-chart-feed")}`);
  const dbMort = await q1("SELECT sum(mortality_count) m FROM poultry_health_records WHERE batch_number='TEST-AN-B01'");
  ok("C8 DB cross-check: 11 deaths", Number(dbMort.m) === 11);

  // ══ D. Layer batch scope ═══════════════════════════════════════════════
  console.log("── D. Layer batch scope ──");
  await setTid("poa-filter-batch", "TEST-AN-L01");
  await sleep(1200);
  const eggsExp = EGGS.reduce((a, b) => a + b, 0); // 1970
  const henDayExp = (eggsExp / (494 * 5)).toFixed(2); // 0.80
  ok("D1 layer scope: eggs/hen/day chip", (await textOf('[data-testid="poa-kpi-eggs-hen"]')).includes(henDayExp), henDayExp);
  ok("D2 layer scope: peak lay chip", (await textOf('[data-testid="poa-kpi-peaklay"]')).includes("81.8"));
  ok("D3 layer scope: growth chart empty-state", await emptyShown("growth"));
  ok("D4 lay target chart live on layer batch", (await lines("poa-chart-targets")) >= 2);
  await clickTid("poa-filter-reset");
  await sleep(1000);

  // ══ E. Flock & branch + dashboard date/product filters ════════════════
  console.log("── E. Flock / branch / date / product filters ──");
  await setTid("poa-filter-flock", String(fb.id));
  await sleep(1200);
  ok("E1 flock filter isolates the TEST broiler flock", (await textOf('[data-testid="poa-kpi-placed"]')).includes("1,000") && !(await emptyShown("growth")));
  await setTid("poa-filter-flock", "ALL");
  await setTid("poa-filter-branch", "POULTRY-01");
  await sleep(1000);
  ok("E2 branch filter keeps POULTRY-01 data", (await bars("poa-chart-feed")) >= 8);
  const branchOpts = await page.$$eval('[data-testid="poa-filter-branch"] option', (n) => n.map((o) => o.value));
  ok("E3 branch filter lists real branches", branchOpts.includes("POULTRY-01"), branchOpts.join(","));
  await setTid("poa-filter-branch", "ALL");
  // dashboard date filter: TODAY leaves only today's feed bar
  await setTid("dash-date-filter", "TODAY");
  await sleep(1200);
  ok("E4 date filter TODAY narrows feed chart to 1 day", (await bars("poa-chart-feed")) === 1, `${await bars("poa-chart-feed")}`);
  await setTid("dash-date-filter", "ALL");
  await sleep(1000);
  // product filter: BROILERS hides egg/lay charts
  await setTid("dash-product-filter", "BROILERS");
  await sleep(1200);
  ok("E5 product BROILERS hides lay-target & egg charts", (await emptyShown("targets")) && (await emptyShown("eggs")) && !(await emptyShown("growth")));
  await setTid("dash-product-filter", "ALL");
  await sleep(1000);

  // ══ F. Phone rendering ════════════════════════════════════════════════
  console.log("── F. Phone ──");
  await page.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true });
  await page.reload({ waitUntil: "networkidle0", timeout: 45000 });
  await sleep(2200);
  // reload lands on the default business — navigate back to the Poultry Farm
  await page.evaluate(() => { const el = [...document.querySelectorAll("aside button")].find((b) => (b.textContent || "").includes("Mina Akuafo Poultry Farm")); el.click(); });
  await waitSel('[data-testid="poa-root"]', 25000);
  await sleep(1500);
  ok("F1 analytics panel on phone, no h-overflow", (await exists('[data-testid="poa-root"]')) &&
    (await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)),
    `scrollW=${await page.evaluate(() => document.documentElement.scrollWidth)} innerW=375`);
  await page.$eval('[data-testid="poa-root"]', (e) => e.scrollIntoView({ block: "start" }));
  await sleep(700);
  await page.screenshot({ path: "/home/user/poa-2-phone.png" });
} catch (e) {
  ok("FATAL suite error", false, String(e?.message || e));
  try { await page.screenshot({ path: "/home/user/poa-error.png" }); } catch {}
} finally {
  console.log("── Z. TEST purge + forensics ──");
  await client.query("DELETE FROM poultry_feed_logs WHERE batch_number LIKE 'TEST-AN-%'");
  await client.query("DELETE FROM poultry_health_records WHERE batch_number LIKE 'TEST-AN-%'");
  await client.query("DELETE FROM poultry_production WHERE batch_number LIKE 'TEST-AN-%'");
  await client.query("DELETE FROM poultry_flocks WHERE batch_number LIKE 'TEST-AN-%'");
  await client.query(`DELETE FROM user_sessions WHERE id > ${B.sessionMax}`);
  const F = {
    flocks: Number((await q1("SELECT count(*) c FROM poultry_flocks")).c),
    feed: Number((await q1("SELECT count(*) c FROM poultry_feed_logs")).c),
    health: Number((await q1("SELECT count(*) c FROM poultry_health_records")).c),
    prod: Number((await q1("SELECT count(*) c FROM poultry_production")).c),
    txn: Number((await q1("SELECT count(*) c FROM transactions")).c),
  };
  ok("Z1 poultry tables back to baseline", F.flocks === B.flocks && F.feed === B.feed && F.health === B.health && F.prod === B.prod, JSON.stringify(F));
  ok("Z2 transactions untouched", F.txn === B.txn, `${F.txn}/${B.txn}`);
  ok("Z3 zero page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  console.log(`\n═══ RESULT: ${checks.filter((c) => c.pass).length}/${checks.length} passed, ${failures} failed ═══`);
  await browser.close();
  await client.end();
  process.exit(failures ? 1 : 0);
}
