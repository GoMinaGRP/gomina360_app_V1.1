// Live verification of poultry DAILY WEIGHT RECORDING (broiler/layer birds +
// eggs) and its automatic linkage into the growth analytics: batch, branch,
// age, feed, production, mortality, FCR, biomass. One REAL UI weighing is
// saved per kind; dense analytic series are injected over SQL; every chart
// and KPI is cross-checked against the database; all TEST rows are purged.
// Run: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-poultry-weights.mjs

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
  flocks: Number((await q1("SELECT count(*) c FROM poultry_flocks")).c),
  feed: Number((await q1("SELECT count(*) c FROM poultry_feed_logs")).c),
  health: Number((await q1("SELECT count(*) c FROM poultry_health_records")).c),
  prod: Number((await q1("SELECT count(*) c FROM poultry_production")).c),
  wlogs: Number((await q1("SELECT count(*) c FROM poultry_weight_logs")).c),
  txn: Number((await q1("SELECT count(*) c FROM transactions")).c),
};

// Dense TEST series for the analytic linkage checks (SQL, zero side-effects)
const W_G = [1050, 1150, 1250, 1360, 1470, 1600, 1750, 1900];   // broiler samples (g)
const FEED_KG = [92, 95, 98, 101, 104, 107, 110, 113];          // 8 days
const EGG_G = [60, 62, 63.5];                                   // 3 egg weighings
const layFlockArrive = "-196";                                  // 28 wks

let fb = null, fl = null;
try {
  console.log("── A. TEST flocks + dense weigh/feed/mortality/egg series ──");
  fb = await q1(`INSERT INTO poultry_flocks (business_id, branch_code, branch_name, batch_number, flock_name, bird_type, breed, initial_count, current_count, mortality_total, arrival_date, age_weeks, status, created_by_name, created_by_role)
    VALUES (1,'POULTRY-01','Nsawam','TEST-W-B01','TEST Weigh Broilers','BROILERS','Ross 308',1000,985,15,'${D(-35)}',5,'ACTIVE','TEST Weights','OWNER') RETURNING id`);
  fl = await q1(`INSERT INTO poultry_flocks (business_id, branch_code, branch_name, batch_number, flock_name, bird_type, breed, initial_count, current_count, mortality_total, arrival_date, age_weeks, status, created_by_name, created_by_role)
    VALUES (1,'POULTRY-01','Nsawam','TEST-W-L01','TEST Weigh Layers','LAYERS','Isa Brown',500,494,6,'${D(layFlockArrive)}',28,'ACTIVE','TEST Weights','OWNER') RETURNING id`);
  for (let i = 0; i < 8; i++) {
    const date = D(-7 + i);
    await client.query(`INSERT INTO poultry_weight_logs (business_id, branch_code, flock_id, batch_number, weight_kind, sample_size, avg_weight_g, recorded_date, notes, recorded_by_name, recorded_by_role)
      VALUES (1,'POULTRY-01',$1,'TEST-W-B01','BIRD',25,$2,$3,'TEST dense sample','TEST Weights','OWNER')`, [fb.id, W_G[i], date]);
    await client.query(`INSERT INTO poultry_feed_logs (business_id, branch_code, flock_id, batch_number, feed_type, quantity_kg, cost_per_kg_ghs, total_cost_ghs, entry_type, recorded_date, recorded_by_name, recorded_by_role)
      VALUES (1,'POULTRY-01',$1,'TEST-W-B01','FINISHER',$2,0,0,'CONSUMPTION',$3,'TEST Weights','OWNER')`, [fb.id, FEED_KG[i], date]);
  }
  for (const [off, deaths] of [[-3, 5], [0, 3]]) {
    await client.query(`INSERT INTO poultry_health_records (business_id, branch_code, flock_id, batch_number, record_type, disease_or_condition, birds_affected, mortality_count, cost_ghs, recorded_date, recorded_by_name)
      VALUES (1,'POULTRY-01',$1,'TEST-W-B01','MORTALITY','TEST losses',0,$2,0,$3,'TEST Weights')`, [fb.id, deaths, D(off)]);
  }
  for (let i = 0; i < 3; i++) {
    const date = D(-2 + i);
    await client.query(`INSERT INTO poultry_weight_logs (business_id, branch_code, flock_id, batch_number, weight_kind, sample_size, avg_weight_g, recorded_date, notes, recorded_by_name, recorded_by_role)
      VALUES (1,'POULTRY-01',$1,'TEST-W-L01','EGG',15,$2,$3,'TEST egg sample','TEST Weights','OWNER')`, [fl.id, EGG_G[i], date]);
    await client.query(`INSERT INTO poultry_production (business_id, branch_code, flock_id, batch_number, production_type, eggs_collected, trays_produced, birds_harvested, total_weight_kg, avg_weight_kg, lay_percentage, fcr, revenue_ghs, recorded_date, recorded_by_name)
      VALUES (1,'POULTRY-01',$1,'TEST-W-L01','EGGS',400,13.3,0,0,0,80,0,0,$2,'TEST Weights')`, [fl.id, date]);
  }
  ok("A1 TEST broiler+layer flocks with 8 bird weighings, 8 feed days, 2 mortality events, 3 egg weighings + egg collections injected", true, `${fb.id}/${fl.id}`);

  // ══ B. UI: record bird weight (broiler) — auto-linkage ═══════════════
  console.log("── B. UI: Record Daily Weight — BIRD ──");
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 45000 });
  await waitSel('[data-testid="login-email"]');
  await setTid("login-email", OWNER.email);
  await setTid("login-password", OWNER.pw);
  await clickTid("login-submit");
  await page.waitForFunction(() => !document.querySelector('[data-testid="login-screen"]'), { timeout: 30000 });
  await sleep(1800);
  await page.evaluate(() => { const el = [...document.querySelectorAll("aside button")].find((b) => (b.textContent || "").includes("Mina Akuafo Poultry Farm")); el.click(); });
  await waitSel('[data-testid="poa-root"]', 25000);
  await sleep(1200);
  ok("B1 dashboard shows the analytics panel with Record Daily Weight button", await exists('[data-testid="poa-record-weight"]'));
  await clickTid("poa-record-weight");
  await waitSel('[data-testid="poaw-modal"]');
  // flock select should contain BOTH test flocks for BIRD kind
  const birdOpts = await page.$$eval('[data-testid="poaw-flock"] option', (n) => n.map((o) => o.textContent || ""));
  ok("B2 BIRD weighing offers broiler AND layer flocks", birdOpts.some((t) => t.includes("TEST-W-B01")) && birdOpts.some((t) => t.includes("TEST-W-L01")), "options include both TEST flocks");
  await setTid("poaw-flock", String(fb.id));
  await sleep(400);
  const info = await textOf('[data-testid="poaw-info"]');
  ok("B3 auto-link shows batch + branch + age + live birds", info.includes("TEST-W-B01") && info.includes("POULTRY-01") && info.includes("W5") && info.includes("985"), info.slice(0, 90));
  await setTid("poaw-sample", "25");
  await setTid("poaw-avg", "1905");
  await setTid("poaw-notes", "TEST UI bird weighing");
  await clickTid("poaw-save");
  await page.waitForFunction(() => (document.querySelector('[data-testid="poaw-status"]')?.textContent || "").includes("Saved"), { timeout: 15000 });
  ok("B4 bird weighing saved via UI", true);
  const wrow2 = await q1(`SELECT weight_kind, sample_size, avg_weight_g, recorded_date, branch_code, batch_number, notes FROM poultry_weight_logs WHERE notes='TEST UI bird weighing' ORDER BY id DESC LIMIT 1`);
  ok("B5 DB row auto-linked to flock/batch/branch (kind BIRD, 1905g)", wrow2?.weight_kind === "BIRD" && Number(wrow2?.sample_size) === 25 && Number(wrow2?.avg_weight_g) === 1905 && wrow2?.batch_number === "TEST-W-B01" && wrow2?.branch_code === "POULTRY-01", JSON.stringify(wrow2));
  await sleep(900);

  // ══ C. UI: record egg weight — layer-only selector ═══════════════════
  console.log("── C. UI: Record Daily Weight — EGG ──");
  await sleep(1200);
  await clickTid("poa-record-weight");
  await waitSel('[data-testid="poaw-modal"]');
  await clickTid("poaw-kind-egg");
  await sleep(400);
  const eggOpts = await page.$$eval('[data-testid="poaw-flock"] option', (n) => n.map((o) => o.textContent || ""));
  ok("C1 EGG weighing restricts flock list to LAYERS", eggOpts.some((t) => t.includes("TEST-W-L01")) && !eggOpts.some((t) => t.includes("TEST-W-B01")), "broiler hidden, layer listed");
  await setTid("poaw-flock", String(fl.id));
  await sleep(400);
  ok("C2 egg auto-link shows layer batch + age in weeks", (await textOf('[data-testid="poaw-info"]')).includes("TEST-W-L01") && (await textOf('[data-testid="poaw-info"]')).includes("W28"));
  await setTid("poaw-sample", "15");
  await setTid("poaw-avg", "63.8");
  await setTid("poaw-notes", "TEST UI egg weighing");
  await clickTid("poaw-save");
  await page.waitForFunction(() => (document.querySelector('[data-testid="poaw-status"]')?.textContent || "").includes("Saved"), { timeout: 15000 });
  ok("C3 egg weighing saved via UI", true);
  ok("C4 egg row in DB with grams + sample", Number((await q1(`SELECT avg_weight_g FROM poultry_weight_logs WHERE notes='TEST UI egg weighing'`))?.avg_weight_g) === 63.8);
  // API hard rule: no egg weight on a broiler flock
  const apiNeg = await page.evaluate(async (args) => {
    const r = await fetch("/api/poultry", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entity: "WEIGHT", data: { businessId: 1, flockId: args.bid, weightKind: "EGG", sampleSize: 5, avgWeightG: 60, recordedDate: args.today } }) });
    return { status: r.status, body: await r.json() };
  }, { bid: fb.id, today: D(0) });
  ok("C5 API rejects egg weight on a BROILER flock", apiNeg.status === 400 && !apiNeg.body.success, JSON.stringify(apiNeg.body?.error || apiNeg.body).slice(0, 60));

  // ══ D. Analytics auto-connection (batch scope) ════════════════════════
  console.log("── D. Analytics: weight logs merged with feed/mortality/production ──");
  await sleep(1500);
  ok("D1 growth trend line count (actual + target)", (await lines("poa-chart-growth")) === 2);
  ok("D2 egg weight vs output chart live (bars + 2 lines)", (await bars("poa-chart-eggweight")) >= 3 && (await lines("poa-chart-eggweight")) === 2, `${await bars("poa-chart-eggweight")} bars`);
  ok("D3 biomass chart rendered", (await lines("poa-chart-biomass")) === 1);
  await setTid("poa-filter-batch", "TEST-W-B01");
  await sleep(1200);
  // Expectations derived from the DB rows themselves (the UI weighing and the
  // injected sample on the same day average together in the analytics).
  const wl = await q(`SELECT recorded_date, avg_weight_g FROM poultry_weight_logs WHERE batch_number='TEST-W-B01' AND weight_kind='BIRD'`);
  const wDates = [...new Set(wl.map((r) => r.recorded_date))].sort();
  const wAt = (d) => { const xs = wl.filter((r) => r.recorded_date === d).map((r) => Number(r.avg_weight_g)); return xs.reduce((a, b) => a + b, 0) / xs.length; };
  const dFirst = wDates[0], dLast = wDates[wDates.length - 1];
  const feedTotal = FEED_KG.reduce((a, b) => a + b, 0);                     // 820
  const gainKg = (wAt(dLast) - wAt(dFirst)) / 1000;
  const aliveMid = ((985 + 8) + 985) / 2;                                   // deaths after first date: 993; after last: 985
  const calcFcrExp = (feedTotal / (gainKg * aliveMid)).toFixed(2);
  ok("D4 batch scope: calc FCR from weighings × feed", (await textOf('[data-testid="poa-kpi-calcfcr"]')).includes(calcFcrExp), `expect ${calcFcrExp} (feed ${feedTotal} / gain ${gainKg.toFixed(4)}kg × ${aliveMid})`);
  const bioExp = ((wAt(dLast) / 1000) * 985).toFixed(1);
  ok("D5 batch scope: biomass chip = latest sample × live birds", (await textOf('[data-testid="poa-kpi-biomass"]')).includes(Number(bioExp).toLocaleString()), `expect ${bioExp}`);
  ok("D6 batch scope: growth bars by age W4+W5 present", (await bars("poa-chart-weight-age")) >= 2 && (await lines("poa-chart-weight-age")) === 1);
  ok("D7 batch scope: egg charts show empty states for a broiler batch", (await exists('[data-testid="poa-empty-eggweight"]')) && (await exists('[data-testid="poa-empty-eggs"]')));
  await setTid("poa-filter-batch", "TEST-W-L01");
  await sleep(1200);
  const el = await q(`SELECT recorded_date, avg_weight_g FROM poultry_weight_logs WHERE batch_number='TEST-W-L01' AND weight_kind='EGG'`);
  const eLastDate = [...new Set(el.map((r) => r.recorded_date))].sort().pop();
  const eggExp = (el.filter((r) => r.recorded_date === eLastDate).reduce((s, r) => s + Number(r.avg_weight_g), 0) / el.filter((r) => r.recorded_date === eLastDate).length).toFixed(1);
  ok("D8 layer scope: avg egg weight chip = latest egg weighing mean", (await textOf('[data-testid="poa-kpi-eggwt"]')).includes(eggExp), `expect ${eggExp} on ${eLastDate}`);
  ok("D9 layer scope: egg weight chart links eggs-collected bars", (await bars("poa-chart-eggweight")) >= 3);
  await clickTid("poa-filter-reset");
  await sleep(800);
  await page.$eval('[data-testid="poa-root"]', (e) => e.scrollIntoView({ block: "start" }));
  await sleep(600);
  await page.screenshot({ path: "/home/user/pw-1-desktop-weights.png", fullPage: false });
} catch (e) {
  ok("FATAL suite error", false, String(e?.message || e));
  try { await page.screenshot({ path: "/home/user/pw-error.png" }); } catch {}
} finally {
  console.log("── Z. TEST purge + forensics ──");
  await client.query("DELETE FROM poultry_weight_logs WHERE batch_number LIKE 'TEST-W-%' OR notes LIKE 'TEST%'");
  await client.query("DELETE FROM poultry_feed_logs WHERE batch_number LIKE 'TEST-W-%'");
  await client.query("DELETE FROM poultry_health_records WHERE batch_number LIKE 'TEST-W-%'");
  await client.query("DELETE FROM poultry_production WHERE batch_number LIKE 'TEST-W-%'");
  await client.query("DELETE FROM poultry_flocks WHERE batch_number LIKE 'TEST-W-%'");
  await client.query(`DELETE FROM user_sessions WHERE id > ${B.sessionMax}`);
  const F = {
    flocks: Number((await q1("SELECT count(*) c FROM poultry_flocks")).c),
    feed: Number((await q1("SELECT count(*) c FROM poultry_feed_logs")).c),
    health: Number((await q1("SELECT count(*) c FROM poultry_health_records")).c),
    prod: Number((await q1("SELECT count(*) c FROM poultry_production")).c),
    wlogs: Number((await q1("SELECT count(*) c FROM poultry_weight_logs")).c),
    txn: Number((await q1("SELECT count(*) c FROM transactions")).c),
  };
  ok("Z1 all poultry + weight tables back to baseline", F.flocks === B.flocks && F.feed === B.feed && F.health === B.health && F.prod === B.prod && F.wlogs === B.wlogs, JSON.stringify(F));
  ok("Z2 transactions untouched (no financial side-effects)", F.txn === B.txn, `${F.txn}/${B.txn}`);
  ok("Z3 zero page errors", pageErrors.length === 0, pageErrors[0] || "");
  await browser.close();
  await client.end();
  console.log(`\n═══ RESULT: ${checks.length - failures}/${checks.length} passed, ${failures} failed ═══`);
  process.exit(failures ? 1 : 0);
}
