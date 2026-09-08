// Live verification of the Fish Farm (aquaculture) growth & production
// tracking: daily fish weighing by pond/batch/species via the real UI modal,
// auto-linkage to batch age/species/pond/branch (+ live batch avg weight),
// and the analytics panel charts/KPIs: growth vs species standard, weight by
// age, feed consumption, calculated FCR, survival/mortality, harvest
// production, estimated biomass — with pond/batch/species/branch/date
// filters. All TEST data purged at the end; forensics must match baseline.
// Run: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-fish-analytics.mjs

import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");
const pg = req("pg");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.OWNER_PW || "Owner@GoMina26" };
const AQUA_BIZ = 3; // Mina Volta Tilapia & Catfish

const checks = [];
let failures = 0;
const ok = (name, cond, extra = "") => { checks.push({ name, pass: !!cond }); if (!cond) failures++; console.log(`${cond ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`); };

const client = new pg.Client(process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db");
await client.connect();
const q = async (sql) => (await client.query(sql)).rows;
const q1 = async (sql) => (await q(sql))[0];
const D = (offsetDays) => { const d = new Date(); d.setDate(d.getDate() + Number(offsetDays)); return d.toISOString().split("T")[0]; };

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
const bars = async (tid) => page.$$eval(`[data-testid="${tid}"] .recharts-rectangle`, (n) => n.length).catch(() => 0);
const lines = async (tid) => page.$$eval(`[data-testid="${tid}"] .recharts-line-curve`, (n) => n.length).catch(() => 0);

const B = {
  sessionMax: (await q1("SELECT COALESCE(max(id),0) m FROM user_sessions")).m,
  ponds: Number((await q1("SELECT count(*) c FROM aquaculture_ponds")).c),
  batches: Number((await q1("SELECT count(*) c FROM aquaculture_batches")).c),
  feed: Number((await q1("SELECT count(*) c FROM aquaculture_feed_logs")).c),
  harv: Number((await q1("SELECT count(*) c FROM aquaculture_harvests")).c),
  wlogs: Number((await q1("SELECT count(*) c FROM aquaculture_weight_logs")).c),
  txn: Number((await q1("SELECT count(*) c FROM transactions")).c),
};

const WT = [270, 278, 286, 295, 304, 312, 320, 330];               // 8 tilapia samples (g)
const FEED_T = [17.0, 17.2, 17.4, 17.6, 17.8, 18.0, 18.2, 18.4];   // kg/day (tilapia)
const FEED_C = 12.5;                                                // catfish flat kg/day

let pond = null, bt = null, bc = null;
try {
  console.log("── A. Login owner + create TEST pond & batches via the real API ──");
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 45000 });
  await waitSel('[data-testid="login-email"]');
  await setTid("login-email", OWNER.email);
  await setTid("login-password", OWNER.pw);
  await clickTid("login-submit");
  await page.waitForFunction(() => !document.querySelector('[data-testid="login-screen"]'), { timeout: 30000 });
  await sleep(1500);
  const api = (body) => page.evaluate(async (b) => {
    const r = await fetch("/api/aquaculture", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    return { status: r.status, body: await r.json() };
  }, body);
  ok("A1 owner signed in", true);

  const pondRes = await api({ entity: "POND", data: { businessId: AQUA_BIZ, pondId: "POND-TEST-01", name: "TEST Tilapia Cage", type: "CAGE", capacityLiters: 50000, status: "STOCKED" } });
  pond = pondRes.body.item;
  ok("A2 TEST pond created through the API", pondRes.body.success && pond?.id > 0, pond?.pondId);
  const btRes = await api({ entity: "BATCH", data: { businessId: AQUA_BIZ, batchNumber: "TEST-F-T01", pondId: pond.id, species: "VOLTA_TILAPIA", hatchDate: D(-140), initialCount: 2000, currentCount: 1950, targetHarvestDate: D(56) } });
  const bcRes = await api({ entity: "BATCH", data: { businessId: AQUA_BIZ, batchNumber: "TEST-F-C01", species: "AFRICAN_CATFISH", hatchDate: D(-84), initialCount: 1500, currentCount: 1470 } });
  bt = btRes.body.item; bc = bcRes.body.item;
  ok("A3 TEST tilapia (pond) + catfish batches created", bt?.id > 0 && bc?.id > 0, `${bt?.batchNumber}/${bc?.batchNumber}`);

  // dense series over SQL (zero transaction/inventory side-effects)
  for (let i = 0; i < 8; i++) {
    const date = D(-7 + i);
    await client.query(`INSERT INTO aquaculture_weight_logs (business_id, branch_code, batch_id, batch_number, pond_id, species, sample_size, avg_weight_g, recorded_date, notes, recorded_by_name)
      VALUES ($1,'AQUA-01',$2,'TEST-F-T01',$3,'VOLTA_TILAPIA',30,$4,$5,'TEST dense sample','TEST Fish')`, [AQUA_BIZ, bt.id, pond.id, WT[i], date]);
    await client.query(`INSERT INTO aquaculture_feed_logs (business_id, branch_code, batch_id, pond_id, feed_type, quantity_kg, cost_per_kg_ghs, total_cost_ghs, entry_type, recorded_date, recorded_by_name)
      VALUES ($1,'AQUA-01',$2,$3,'FLOATING',$4,0,0,'CONSUMPTION',$5,'TEST Fish')`, [AQUA_BIZ, bt.id, pond.id, FEED_T[i], date]);
    await client.query(`INSERT INTO aquaculture_feed_logs (business_id, branch_code, batch_id, pond_id, feed_type, quantity_kg, cost_per_kg_ghs, total_cost_ghs, entry_type, recorded_date, recorded_by_name)
      VALUES ($1,'AQUA-01',$2,NULL,'STARTER',$3,0,0,'CONSUMPTION',$4,'TEST Fish')`, [AQUA_BIZ, bc.id, FEED_C, date]);
  }
  await client.query(`INSERT INTO aquaculture_harvests (business_id, branch_code, batch_id, pond_id, species, harvested_count, total_weight_kg, avg_weight_kg, revenue_ghs, sale_date, buyer_name, recorded_by_name)
    VALUES ($1,'AQUA-01',$2,$3,'VOLTA_TILAPIA',100,32,0.32,0,$4,'TEST buyer','TEST Fish')`, [AQUA_BIZ, bt.id, pond.id, D(-2)]);
  await client.query(`INSERT INTO aquaculture_harvests (business_id, branch_code, batch_id, pond_id, species, harvested_count, total_weight_kg, avg_weight_kg, revenue_ghs, sale_date, buyer_name, recorded_by_name)
    VALUES ($1,'AQUA-01',$2,$3,'VOLTA_TILAPIA',150,48,0.32,0,$4,'TEST buyer','TEST Fish')`, [AQUA_BIZ, bt.id, pond.id, D(-1)]);
  ok("A4 8 weight samples, 16 feed days, 2 harvests injected (SQL)", true);

  // ══ B. Analytics panel on the dashboard ════════════════════════════
  console.log("── B. Fish dashboard analytics panel ──");
  await page.evaluate(() => { const el = [...document.querySelectorAll("aside button")].find((b) => (b.textContent || "").includes("Mina Volta Tilapia")); el.click(); });
  await waitSel('[data-testid="fga-root"]', 25000);
  await sleep(1500);
  ok("B1 analytics panel mounted on the fish dashboard", true);
  ok("B2 pond/batch/species/branch/date filters present", (await exists('[data-testid="fga-filter-pond"]')) && (await exists('[data-testid="fga-filter-batch"]')) && (await exists('[data-testid="fga-filter-species"]')) && (await exists('[data-testid="fga-filter-branch"]')) && (await exists('[data-testid="fga-filter-date"]')));
  ok("B3 daily growth trend (actual + species standard) rendered", (await lines("fga-chart-growth")) === 2);
  ok("B4 average weight by age chart (W19+W20 buckets + standard)", (await bars("fga-chart-weight-age")) >= 2 && (await lines("fga-chart-weight-age")) === 1, `${await bars("fga-chart-weight-age")} bars`);
  ok("B5 daily feed consumption chart rendered", (await bars("fga-chart-feed")) >= 8, `${await bars("fga-chart-feed")} bars`);
  ok("B6 survival & mortality by batch chart (2 batches)", (await bars("fga-chart-survival")) === 2, `${await bars("fga-chart-survival")} bars`);
  ok("B7 harvest production trend (bars + weight line)", (await bars("fga-chart-harvest")) === 2 && (await lines("fga-chart-harvest")) === 1);
  ok("B8 estimated biomass chart rendered", (await lines("fga-chart-biomass")) === 1);
  const survExp = (((1950 + 1470) / (2000 + 1500)) * 100).toFixed(1); // 97.7
  ok("B9 KPI survival % across stocked batches", (await textOf('[data-testid="fga-kpi-survival"]')).includes(survExp), `expect ${survExp}`);
  ok("B10 KPI stocked count 3,500", (await textOf('[data-testid="fga-kpi-stocked"]')).includes("3,500"));

  // ══ C. UI: record a fish weighing — auto-linkage ═══════════════════
  console.log("── C. UI: Record Fish Weight ──");
  await clickTid("fga-record-weight");
  await waitSel('[data-testid="fgaw-modal"]');
  await setTid("fgaw-pond", String(pond.id));
  await sleep(500);
  const batchOpts = await page.$$eval('[data-testid="fgaw-batch"] option', (n) => n.map((o) => o.textContent || ""));
  ok("C1 pond selection narrows batches to that pond (tilapia only)", batchOpts.some((t) => t.includes("TEST-F-T01")) && !batchOpts.some((t) => t.includes("TEST-F-C01")), batchOpts.join("|").slice(0, 80));
  await setTid("fgaw-batch", String(bt.id));
  await sleep(400);
  const info = await textOf('[data-testid="fgaw-info"]');
  ok("C2 auto-link shows species + pond + branch + age + fish alive", info.includes("VOLTA TILAPIA") && info.includes("TEST Tilapia Cage") && info.includes("AQUA-01") && info.includes("W20") && info.includes("1,950"), info.slice(0, 100));
  await setTid("fgaw-sample", "30");
  await setTid("fgaw-avg", "335");
  await setTid("fgaw-notes", "TEST UI fish weighing");
  await clickTid("fgaw-save");
  await page.waitForFunction(() => (document.querySelector('[data-testid="fgaw-status"]')?.textContent || "").includes("Saved"), { timeout: 15000 });
  ok("C3 fish weighing saved via UI", true);
  const wrow = await q1(`SELECT batch_number, pond_id, species, avg_weight_g, sample_size FROM aquaculture_weight_logs WHERE notes='TEST UI fish weighing' ORDER BY id DESC LIMIT 1`);
  ok("C4 DB row auto-linked to batch/pond/species (335 g)", wrow?.batch_number === "TEST-F-T01" && Number(wrow?.pond_id) === pond.id && wrow?.species === "VOLTA_TILAPIA" && Number(wrow?.avg_weight_g) === 335, JSON.stringify(wrow));
  const batchRow = await q1(`SELECT avg_weight_grams FROM aquaculture_batches WHERE id=${bt.id}`);
  ok("C5 batch live avg weight auto-refreshed to 335 g", Number(batchRow?.avg_weight_grams) === 335, `avg=${batchRow?.avg_weight_grams}`);
  const apiNeg = await page.evaluate(async (biz) => {
    const r = await fetch("/api/aquaculture", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entity: "WEIGHT", data: { businessId: biz, batchId: 999999, avgWeightG: 100 } }) });
    return { status: r.status, body: await r.json() };
  }, AQUA_BIZ);
  ok("C6 API rejects weighing for an unknown batch", apiNeg.status === 404 && !apiNeg.body.success);

  // ══ D. Filters + KPIs vs database ══════════════════════════════════
  console.log("── D. Filters + KPI cross-check ──");
  await sleep(1500);
  await setTid("fga-filter-batch", "TEST-F-T01");
  await sleep(1200);
  // expectations derived from the SQL rows (same formulas the lib documents)
  const wl = await q(`SELECT recorded_date, avg_weight_g FROM aquaculture_weight_logs WHERE batch_number='TEST-F-T01'`);
  const wDates = [...new Set(wl.map((r) => r.recorded_date))].sort();
  const wAt = (d) => { const xs = wl.filter((r) => r.recorded_date === d).map((r) => Number(r.avg_weight_g)); return xs.reduce((a, b) => a + b, 0) / xs.length; };
  const dFirst = wDates[0], dLast = wDates[wDates.length - 1];
  const gainKg = (wAt(dLast) - wAt(dFirst)) / 1000;
  const harvAfterFirst = 250; // both TEST harvests fall after the first sample
  const aliveMid = ((1950 + harvAfterFirst) + 1950) / 2;
  const feedTotal = FEED_T.reduce((a, b) => a + b, 0);
  const calcFcrExp = (feedTotal / (gainKg * aliveMid)).toFixed(2);
  ok("D1 batch scope: calc FCR = feed ÷ biomass gain", (await textOf('[data-testid="fga-kpi-calcfcr"]')).includes(calcFcrExp), `expect ${calcFcrExp} (${feedTotal}kg / ${gainKg.toFixed(4)}kg × ${aliveMid})`);
  const bioExp = ((wAt(dLast) / 1000) * 1950).toFixed(1);
  ok("D2 batch scope: biomass chip = sample × fish alive", (await textOf('[data-testid="fga-kpi-biomass"]')).includes(Number(bioExp).toLocaleString()), `expect ${bioExp}`);
  ok("D3 batch scope: survival chart shows only TEST-F-T01", (await bars("fga-chart-survival")) === 1);
  ok("D4 batch scope: harvested chip 250 fish / 80 kg", (await textOf('[data-testid="fga-kpi-harvest"]')).includes("250") && (await textOf('[data-testid="fga-kpi-harvest"]')).includes("80"));
  await setTid("fga-filter-batch", "ALL");
  await setTid("fga-filter-species", "AFRICAN_CATFISH");
  await sleep(1200);
  ok("D5 species filter: catfish scope has no weight samples (empty states)", (await exists('[data-testid="fga-empty-growth"]')) && (await exists('[data-testid="fga-empty-biomass"]')) && !(await exists('[data-testid="fga-empty-feed"]')));
  await setTid("fga-filter-species", "ALL");
  await setTid("fga-filter-pond", String(pond.id));
  await sleep(1200);
  ok("D6 pond filter keeps the pond's tilapia data only", (await bars("fga-chart-feed")) === 8 && (await bars("fga-chart-survival")) === 1, `${await bars("fga-chart-feed")} feed bars, ${await bars("fga-chart-survival")} survival bars`);
  await setTid("fga-filter-pond", "ALL");
  await setTid("fga-filter-date", "TODAY");
  await sleep(1200);
  ok("D7 date TODAY narrows feed chart to today (2 rows: tilapia+catfish)", (await bars("fga-chart-feed")) === 1, `${await bars("fga-chart-feed")}`);
  await clickTid("fga-filter-reset");
  await sleep(800);
  const feedBarsAfterReset = await bars("fga-chart-feed");
  ok("D8 reset restores full feed history", feedBarsAfterReset === 8, `${feedBarsAfterReset}`);
  await page.$eval('[data-testid="fga-root"]', (e) => e.scrollIntoView({ block: "start" }));
  await sleep(600);
  await page.screenshot({ path: "/home/user/fga-1-desktop-analytics.png", fullPage: false });

  // ══ E. Phone ═══════════════════════════════════════════════════════
  console.log("── E. Phone ──");
  await page.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true });
  await page.reload({ waitUntil: "networkidle0", timeout: 45000 });
  await sleep(2200);
  await page.evaluate(() => { const el = [...document.querySelectorAll("aside button")].find((b) => (b.textContent || "").includes("Mina Volta Tilapia")); el.click(); });
  await waitSel('[data-testid="fga-root"]', 25000);
  await sleep(1200);
  ok("E1 fish analytics on phone, no h-overflow", (await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)));
  await page.$eval('[data-testid="fga-root"]', (e) => e.scrollIntoView({ block: "start" }));
  await sleep(600);
  await page.screenshot({ path: "/home/user/fga-2-phone.png" });
} catch (e) {
  ok("FATAL suite error", false, String(e?.message || e));
  try { await page.screenshot({ path: "/home/user/fga-error.png" }); } catch {}
} finally {
  console.log("── Z. TEST purge + forensics ──");
  await client.query("DELETE FROM aquaculture_weight_logs WHERE batch_number LIKE 'TEST-F-%' OR notes LIKE 'TEST%'");
  await client.query("DELETE FROM aquaculture_feed_logs WHERE batch_id = ANY($1::int[])", [[bt?.id, bc?.id].filter(Boolean)]);
  await client.query("DELETE FROM aquaculture_harvests WHERE batch_id = ANY($1::int[])", [[bt?.id].filter(Boolean)]);
  await client.query("DELETE FROM aquaculture_batches WHERE batch_number LIKE 'TEST-F-%'");
  await client.query("DELETE FROM aquaculture_ponds WHERE pond_id LIKE 'POND-TEST-%'");
  await client.query(`DELETE FROM user_sessions WHERE id > ${B.sessionMax}`);
  const F = {
    ponds: Number((await q1("SELECT count(*) c FROM aquaculture_ponds")).c),
    batches: Number((await q1("SELECT count(*) c FROM aquaculture_batches")).c),
    feed: Number((await q1("SELECT count(*) c FROM aquaculture_feed_logs")).c),
    harv: Number((await q1("SELECT count(*) c FROM aquaculture_harvests")).c),
    wlogs: Number((await q1("SELECT count(*) c FROM aquaculture_weight_logs")).c),
    txn: Number((await q1("SELECT count(*) c FROM transactions")).c),
  };
  ok("Z1 all aquaculture tables back to baseline", F.ponds === B.ponds && F.batches === B.batches && F.feed === B.feed && F.harv === B.harv && F.wlogs === B.wlogs, JSON.stringify(F));
  ok("Z2 transactions untouched (zero financial side-effects)", F.txn === B.txn, `${F.txn}/${B.txn}`);
  ok("Z3 zero page errors", pageErrors.length === 0, pageErrors[0] || "");
  await browser.close();
  await client.end();
  console.log(`\n═══ RESULT: ${checks.length - failures}/${checks.length} passed, ${failures} failed ═══`);
  process.exit(failures ? 1 : 0);
}
