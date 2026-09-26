// Live verification of the FISH BATCH PERFORMANCE BENCHMARKING system
// (the aquatic mirror of verify-benchmark.mjs):
//   • API lifecycle (profile CRUD, validation, permissions, batch pinning,
//     batch-form fields)
//   • Engine math cross-checked against the database (age-matched actuals,
//     variance vs profile target, SGR derivation, FCR incl. harvested kg,
//     feeding rate, survival, production costs, age-matched history medians,
//     closed-batch end-of-cycle age, SGR-path harvest projection)
//   • Dashboard panel rendering (KPI rows, chips, grade, trend chart with
//     farm-history band, projection, CSV, live-price recalc)
//   • Growth Analytics overlays (benchmark target line replaces the species
//     standard when a profile resolves)
//   • Alert integration (benchmark alerts ride the AI Smart Alerts grid)
//   • Manager drawer (list, editor, curve grid, template copy, derive)
// All TEST profiles/batches are purged at the end. Demo data (FB-DEMO-*) is
// left untouched.
// Run: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-fish-benchmark.mjs

import { createRequire } from "node:module";
const req = createRequire("/home/user/pgtooling/package.json");
const puppeteer = req("puppeteer-core");
const pg = req("pg");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.OWNER_PW || "Owner@GoMina26" };
const AQUA_BIZ = 3; // AQUA-01 — Mina Volta Tilapia & Catfish

const checks = [];
let failures = 0;
const ok = (name, cond, extra = "") => { checks.push({ name, pass: !!cond }); if (!cond) failures++; console.log(`${cond ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`); };

const client = new pg.Client(process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db");
await client.connect();
const q = async (sql, params) => (await client.query(sql, params)).rows;
const q1 = async (sql, params) => (await q(sql, params))[0];

const pageErrors = [];
const browser = await puppeteer.launch({ executablePath: "/tmp/al2023/chromium", headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--window-size=1500,950"] });
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") { const t = m.text(); if (!/401|Failed to load resource|net::ERR_/.test(t)) pageErrors.push(t); } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tid = (t) => `[data-testid="${t}"]`;
const exists = async (sel) => !!(await page.$(sel));
const textOf = async (sel) => page.$eval(sel, (e) => e.textContent || "").catch(() => "");
const waitSel = (sel, t = 20000) => page.waitForSelector(sel, { timeout: t });
const setVal = async (sel, val) => page.evaluate((s, v) => {
  const el = document.querySelector(s);
  const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}, sel, val);
const setTid = (t, val) => setVal(tid(t), val);
const clickTid = async (t) => { await waitSel(tid(t)); await page.$eval(tid(t), (e) => e.click()); };
const lines = async (t) => page.$$eval(`[data-testid="${t}"] .recharts-line-curve`, (n) => n.length).catch(() => 0);

let cookie = "";
const api = async (path, body, method = "POST") => {
  const res = await fetch(`${BASE}${path}`, { method, headers: { "Content-Type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const d = await res.json().catch(() => ({}));
  return { status: res.status, d };
};

// ── self-healing pre-cleanup (leftovers from crashed runs) ──────────────
await q("DELETE FROM aquaculture_weight_logs WHERE batch_number LIKE 'FISH-TEST-%'");
await q("DELETE FROM aquaculture_feed_logs WHERE batch_id IN (SELECT id FROM aquaculture_batches WHERE batch_number LIKE 'FISH-TEST-%')");
await q("DELETE FROM aquaculture_batches WHERE batch_number LIKE 'FISH-TEST-%'");
await q("DELETE FROM aquaculture_benchmark_profiles WHERE name LIKE 'FISH-TEST-%'");

// ── baseline snapshot (for purge) ───────────────────────────────────────
const B = {
  testProfiles: Number((await q1("SELECT count(*) c FROM aquaculture_benchmark_profiles WHERE name LIKE 'FISH-TEST-%'")).c),
  testBatches: Number((await q1("SELECT count(*) c FROM aquaculture_batches WHERE batch_number LIKE 'FISH-TEST-%'")).c),
};

// ═══ 1. API LIFECYCLE ════════════════════════════════════════════════════
{
  let login = null;
  for (let i = 0; i < 3; i++) {
    login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: OWNER.email, password: OWNER.pw }) });
    if (login.ok && login.headers.get("set-cookie")) break;
    await sleep(1500);
  }
  cookie = login.headers.get("set-cookie")?.split(";")[0] || "";
  ok("A0 owner login", login.status === 200 && !!cookie);

  let r = await api("/api/aquaculture/benchmarks?businessId=3", null, "GET");
  ok("A1 GET profiles + templates", r.status === 200 && r.d.success && Array.isArray(r.d.templates) && r.d.templates.length === 2, `${r.d.templates?.length} templates`);

  r = await api("/api/aquaculture?businessId=3", null, "GET");
  ok("A2 module GET returns benchmarkProfiles", r.status === 200 && (r.d.benchmarkProfiles || []).length >= 2, `${(r.d.benchmarkProfiles || []).length} profiles`);

  // create test profile (simple linear weight curve for deterministic math)
  r = await api("/api/aquaculture/benchmarks", { entity: "PROFILE", data: {
    businessId: AQUA_BIZ, name: "FISH-TEST-Profile", species: "VOLTA_TILAPIA", toleranceWarnPct: 5, toleranceCritPct: 10,
    curves: { AVG_WEIGHT_G: { by: "ageDays", points: [[0, 5], [84, 300], [196, 600]] }, _meta: { harvestAgeDays: 196, livePricePerKgGhs: 62 } },
    createdByName: "fish-bench-verify", createdByRole: "OWNER",
  } });
  ok("A3 POST profile", r.status === 200 && r.d.success && r.d.item.id > 0);
  const pid = r.d.item.id;

  r = await api("/api/aquaculture/benchmarks", { entity: "PROFILE", data: { businessId: AQUA_BIZ, name: "FISH-TEST-Bad", species: "VOLTA_TILAPIA", curves: { AVG_WEIGHT_G: { by: "ageDays", points: [[1, 1]] } } } });
  ok("A4 single-point curve rejected (400)", r.status === 400 && /at least 2 points/.test(r.d.error || ""));

  r = await api("/api/aquaculture/benchmarks", { entity: "PROFILE", data: { businessId: AQUA_BIZ, name: "FISH-TEST-BadSpecies", species: "TILAPIA_MAGICA" } });
  ok("A5 unknown species rejected (400)", r.status === 400 && /species must be one of/.test(r.d.error || ""));

  r = await api("/api/aquaculture/benchmarks", { entity: "PROFILE", id: pid, data: { name: "FISH-TEST-Profile v2", toleranceCritPct: 12 } }, "PATCH");
  ok("A6 PATCH profile (rename + tolerance)", r.status === 200 && r.d.item?.name === "FISH-TEST-Profile v2" && r.d.item?.toleranceCritPct === 12, `${r.status} ${JSON.stringify(r.d).slice(0, 120)}`);

  // batch pinning round-trip (PATCH /api/aquaculture entity BATCH)
  const t01 = await q1("SELECT id FROM aquaculture_batches WHERE batch_number = 'FB-DEMO-T01'");
  r = await api("/api/aquaculture", { entity: "BATCH", id: t01.id, data: { benchmarkProfileId: pid } }, "PATCH");
  ok("A7 batch pin profile", r.status === 200 && r.d.item.benchmarkProfileId === pid);
  r = await api("/api/aquaculture", { entity: "BATCH", id: t01.id, data: { benchmarkProfileId: null } }, "PATCH");
  ok("A8 batch unpin (auto-match)", r.status === 200 && r.d.item.benchmarkProfileId === null);
  r = await api("/api/aquaculture", { entity: "BATCH", id: t01.id, data: { benchmarkProfileId: 999999 } }, "PATCH");
  ok("A9 cross-business profile rejected (404)", r.status === 404);
  r = await api("/api/aquaculture", { entity: "BATCH", id: t01.id, data: { costPerFingerlingGhs: 1.10 } }, "PATCH");
  ok("A10 batch PATCH costPerFingerlingGhs", r.status === 200 && r.d.item.costPerFingerlingGhs === 1.10);

  // BATCH POST accepts benchmarkProfileId + costPerFingerlingGhs
  r = await api("/api/aquaculture", { entity: "BATCH", data: {
    businessId: AQUA_BIZ, batchNumber: "FISH-TEST-B01", species: "VOLTA_TILAPIA", hatchDate: "2026-08-01",
    initialCount: 500, currentCount: 490, mortalityTotal: 10, costPerFingerlingGhs: 2.5, benchmarkProfileId: pid,
    createdByName: "fish-bench-verify",
  } });
  ok("A11 BATCH POST accepts profile pin + fingerling cost", r.status === 200 && r.d.item.benchmarkProfileId === pid && Number(r.d.item.costPerFingerlingGhs) === 2.5);
  const testBatchId = r.d.item.id;

  // delete-blocked while a batch still pins the profile, then unpin → delete
  r = await api("/api/aquaculture/benchmarks", { entity: "PROFILE", id: pid }, "DELETE");
  ok("A12 DELETE blocked while batch pinned (409)", r.status === 409 && /FISH-TEST-B01/.test(r.d.error || ""));
  await api("/api/aquaculture", { entity: "BATCH", id: testBatchId, data: { benchmarkProfileId: null } }, "PATCH");
  r = await api("/api/aquaculture/benchmarks", { entity: "PROFILE", id: pid }, "DELETE");
  ok("A13 DELETE profile after unpin", r.status === 200 && r.d.success);

  // permission gate: worker cannot mutate
  const wl = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "akua.donkor@gomina360.com", password: "GoMina@User10" }) });
  const wc = wl.headers.get("set-cookie").split(";")[0];
  const wr = await fetch(`${BASE}/api/aquaculture/benchmarks`, { method: "POST", headers: { "Content-Type": "application/json", cookie: wc }, body: JSON.stringify({ entity: "PROFILE", data: { businessId: AQUA_BIZ, name: "FISH-TEST-Nope", species: "VOLTA_TILAPIA" } }) });
  ok("A14 worker POST forbidden (403)", wr.status === 403);
}

// ═══ 2. ENGINE MATH vs DATABASE (FB-DEMO-*, age-matched) ═════════════════
{
  const t01 = await q1("SELECT * FROM aquaculture_batches WHERE batch_number = 'FB-DEMO-T01'");
  const ageDays = Math.round((Date.now() - new Date(t01.hatch_date).getTime()) / 86400000);
  const lastW = await q1("SELECT avg_weight_g FROM aquaculture_weight_logs WHERE batch_id = $1 ORDER BY recorded_date DESC LIMIT 1", [t01.id]);
  const firstW = await q1("SELECT avg_weight_g FROM aquaculture_weight_logs WHERE batch_id = $1 ORDER BY recorded_date ASC LIMIT 1", [t01.id]);
  const feed = await q1("SELECT sum(quantity_kg) kg, sum(total_cost_ghs) cost FROM aquaculture_feed_logs WHERE batch_id = $1 AND entry_type = 'CONSUMPTION'", [t01.id]);
  const prof = await q1("SELECT * FROM aquaculture_benchmark_profiles WHERE name = 'Volta Tilapia — GoMina Farm Target'");
  ok("M0 demo batch age ~120d", Math.abs(ageDays - 120) <= 1, `age=${ageDays}`);
  ok("M1 last weight sample 247g (first 16g)", Math.abs(lastW.avg_weight_g - 247) < 1 && Math.abs(firstW.avg_weight_g - 16) < 1, `${firstW.avg_weight_g}→${lastW.avg_weight_g}g`);

  // curve interpolation: tilapia template target at day 120
  const pts = prof.curves.AVG_WEIGHT_G.points;
  const interp = (d) => { for (let i = 1; i < pts.length; i++) { if (d <= pts[i][0]) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; return y0 + ((y1 - y0) * (d - x0)) / (x1 - x0); } } return pts[pts.length - 1][1]; };
  const target120 = interp(120);
  ok("M2 profile target at day 120 ≈ 268.57g", Math.abs(target120 - 268.5714) < 0.01, `${target120.toFixed(3)}g`);

  const gainKg = ((lastW.avg_weight_g - firstW.avg_weight_g) / 1000) * t01.current_count;
  const expected = {
    weightDrift: ((lastW.avg_weight_g - target120) / target120) * 100,          // ≈ -8.0% → WATCH
    sgr: (Math.log(lastW.avg_weight_g / firstW.avg_weight_g) / 92) * 100,        // ≈ 2.97 %/day
    sgrTarget: (Math.log(interp(120) / interp(28)) / 92) * 100,                  // ≈ 3.14 %/day
    fcr: Number(feed.kg) / gainKg,                                               // ≈ 1.59
    survival: 100 - (t01.mortality_total / t01.initial_count) * 100,             // 95.2%
    costPerKg: (t01.initial_count * Number(t01.cost_per_fingerling_ghs) + Number(feed.cost)) / gainKg, // ≈ 14.7
  };
  ok("M3 expected weight drift ≈ -8% (WATCH band -5..-10)", expected.weightDrift > -10 && expected.weightDrift <= -5, `${expected.weightDrift.toFixed(1)}%`);
  ok("M4 expected SGR 2.97 vs derived target 3.14 (WATCH)", Math.abs(expected.sgr - 2.97) < 0.05 && Math.abs(expected.sgrTarget - 3.14) < 0.05 && expected.sgrTarget - expected.sgr > 0.1, `${expected.sgr.toFixed(2)} vs ${expected.sgrTarget.toFixed(2)}`);
  ok("M5 expected calc FCR ≈ 1.59 (OFF_TRACK vs 1.23 target)", expected.fcr > 1.5 && expected.fcr < 1.7, `${expected.fcr.toFixed(2)}`);
  ok("M6 expected survival 95.2% (ahead of 90.7 target)", Math.abs(expected.survival - 95.2) < 0.1, `${expected.survival.toFixed(1)}%`);
  ok("M7 expected cost/kg fish ≈ 14.7 (fingerling + feed)", expected.costPerKg > 14 && expected.costPerKg < 15.5, `GH₵${expected.costPerKg.toFixed(2)}`);

  // comparable-history matching: T01 (growing tilapia) ↔ T02 + T03 (closed tilapia)
  const hist = await q("SELECT batch_number, status FROM aquaculture_batches WHERE species = 'VOLTA_TILAPIA' AND id <> $1 AND (status IN ('HARVESTED','SOLD','CULLED','CLOSED') OR (status = 'GROWING' AND hatch_date < $2))", [t01.id, t01.hatch_date]);
  ok("M8 comparable batches = 2 (T02 + T03)", hist.length === 2, hist.map((h) => h.batch_number).join(","));

  // age-matched history median: each comparable's latest sample at age ≤ 125d
  const wk17 = await q("SELECT DISTINCT ON (w.batch_number) w.batch_number, w.avg_weight_g FROM aquaculture_weight_logs w JOIN aquaculture_batches b ON b.id = w.batch_id WHERE w.batch_number IN ('FB-DEMO-T02','FB-DEMO-T03') AND (w.recorded_date::date - b.hatch_date::date) <= 125 ORDER BY w.batch_number, w.recorded_date DESC");
  const byBatch = {};
  for (const row of wk17) byBatch[row.batch_number] = row.avg_weight_g;
  const sorted = Object.values(byBatch).sort((a, b) => a - b);
  const med = (sorted[0] + sorted[1]) / 2;
  ok("M9 age-matched history median at wk17 ≈ 237.5g (not end-of-cycle ~500g)", Math.abs(med - 237.5) < 1, `median=${med} (${JSON.stringify(byBatch)})`);

  // closed batch: end-of-cycle age + FCR incl. harvested kg (harvest term, no double count)
  const t02 = await q1("SELECT * FROM aquaculture_batches WHERE batch_number = 'FB-DEMO-T02'");
  const t02feed = await q1("SELECT sum(quantity_kg) kg FROM aquaculture_feed_logs WHERE batch_id = $1 AND entry_type = 'CONSUMPTION'", [t02.id]);
  const t02harv = await q1("SELECT sum(total_weight_kg) kg, sum(harvested_count) n FROM aquaculture_harvests WHERE batch_id = $1", [t02.id]);
  const t02first = await q1("SELECT avg_weight_g FROM aquaculture_weight_logs WHERE batch_id = $1 ORDER BY recorded_date ASC LIMIT 1", [t02.id]);
  const t02gain = Number(t02harv.kg) - (Number(t02harv.n) * t02first.avg_weight_g) / 1000;
  const t02fcr = Number(t02feed.kg) / t02gain;
  ok("M10 closed T02 FCR ≈ 1.33 (harvest-term gain, no double count)", t02fcr > 1.25 && t02fcr < 1.42, `${t02fcr.toFixed(2)}`);
  const t02ageAtClose = Math.round((new Date((await q1("SELECT max(sale_date) d FROM aquaculture_harvests WHERE batch_id = $1", [t02.id])).d).getTime() - new Date(t02.hatch_date).getTime()) / 86400000);
  ok("M11 closed batch benchmarks at END-OF-CYCLE age (196d, not today)", t02ageAtClose === 196, `age=${t02ageAtClose}`);

  // SGR-path projection: currentW × (targetHarvest/targetNow)^relPerf
  const relPerf = expected.sgr / expected.sgrTarget;
  const projected = (lastW.avg_weight_g / 1000) * Math.pow(interp(196) / interp(120), relPerf);
  ok("M12 projected harvest weight ≈ 0.46kg (SGR-path compounded)", Math.abs(projected - 0.462) < 0.02, `${projected.toFixed(3)}kg`);
}

// ═══ 3. UI — DASHBOARD PANEL ════════════════════════════════════════════
{
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 45000 });
  await waitSel(tid("login-email"));
  await setTid("login-email", OWNER.email);
  await setTid("login-password", OWNER.pw);
  await clickTid("login-submit");
  await page.waitForFunction(() => !document.querySelector('[data-testid="login-screen"]'), { timeout: 30000 });
  await sleep(1800);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("aside button")].find((b) => (b.textContent || "").includes("Mina Volta Tilapia"));
    if (el) el.click();
  });
  await waitSel(tid("fib-root"), 25000);
  await sleep(1500);
  ok("U0 navigated to AQUA-01 dashboard", await exists(tid("fib-root")));

  // benchmark panel sits before the growth analytics section
  ok("U1 benchmark panel present", await exists(tid("fib-root")));
  const panelOrder = await page.evaluate(() => {
    const fib = document.querySelector('[data-testid="fib-root"]');
    const fga = document.querySelector('[data-testid="fga-root"]');
    if (!fib || !fga) return "missing";
    return fib.compareDocumentPosition(fga) & Node.DOCUMENT_POSITION_FOLLOWING ? "fib-before-fga" : "fga-before-fib";
  });
  ok("U2 benchmark panel renders above Fish Growth Analytics", panelOrder === "fib-before-fga", panelOrder);

  const selectBatch = async (re) => {
    const v = await page.$eval(tid("fib-batch-select"), (e, rx) => {
      const opt = [...e.options].find((o) => new RegExp(rx).test(o.textContent || ""));
      return opt ? opt.value : e.value;
    }, re);
    await setVal(tid("fib-batch-select"), v);
    await sleep(900);
  };

  await selectBatch("FB-DEMO-T01");
  const grade = await textOf(tid("fib-grade"));
  ok("U3 T01 story batch scorecard grade D", grade.trim() === "D", `grade=${grade.trim()}`);

  const weightRow = await textOf(tid("fib-row-avg_weight_g"));
  ok("U4 weight row shows actual 247g + target ~268.6g", /247/.test(weightRow) && /268\.57/.test(weightRow), weightRow.slice(0, 90));
  const weightChip = await textOf(tid("fib-chip-avg_weight_g-target"));
  ok("U5 weight variance chip ≈ -8.0% (WATCH)", /-8\.0/.test(weightChip), weightChip.trim());

  const fcrChip = await textOf(tid("fib-chip-fcr-target"));
  ok("U6 FCR chip ≈ -29% (OFF_TRACK)", /-29\.\d/.test(fcrChip), fcrChip.trim());

  const sgrRow = await textOf(tid("fib-row-sgr_pct"));
  ok("U7 SGR row shows derived target 3.14%/day", /3\.14/.test(sgrRow) && /2\.97/.test(sgrRow), sgrRow.slice(0, 90));

  ok("U8 history meta lists 2 comparable batches", (await textOf(tid("fib-history-meta"))).includes("2 past batch"), (await textOf(tid("fib-history-meta"))).slice(0, 70));

  // weekly trend chart: actual + target + median + p25/p75
  const trendLines = await lines("fib-trends");
  ok("U9 trend chart: actual + target + farm median + p25/p75 (5 lines)", trendLines === 5, `${trendLines} lines`);

  ok("U10 close-out projection present", await exists(tid("fib-projection")));
  const projText = await textOf(tid("fib-projection"));
  ok("U11 projection: harvest age 196 + projected ~0.46kg + margin", projText.includes("196") && /0\.46/.test(projText) && /Margin/.test(projText), projText.replace(/\s+/g, " ").slice(0, 110));

  ok("U12 CSV export button present", await exists(tid("fib-export-btn")));

  // benchmark alerts merged into the AI Smart Alerts grid
  const bodyText = await page.evaluate(() => document.body.textContent || "");
  ok("U13 benchmark alert in AI Smart Alerts grid (FCR critical)", /FCR Above Benchmark/.test(bodyText));

  // switch to the on-target catfish batch → grade A
  await selectBatch("FB-DEMO-C01");
  const gradeC = (await textOf(tid("fib-grade"))).trim();
  ok("U14 catfish on-target batch grade A", gradeC === "A", `grade=${gradeC}`);
  const cRow = await textOf(tid("fib-row-avg_weight_g"));
  ok("U15 catfish auto-matched its own species profile", (await textOf(tid("fib-root"))).includes("African Catfish — GoMina Farm Target"), cRow.slice(0, 60));

  // live-price edit recalculates the projection
  await selectBatch("FB-DEMO-T01");
  const priceBefore = await textOf(tid("fib-projection"));
  await page.evaluate(() => { const el = document.querySelector('[data-testid="fib-live-price"]'); if (el) { const p = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; p.call(el, "80"); el.dispatchEvent(new Event("input", { bubbles: true })); } });
  await sleep(500);
  const priceAfter = await textOf(tid("fib-projection"));
  ok("U16 live-price edit recalculates projection", priceBefore !== priceAfter);

  // trend metric selector switches series
  await setTid("fib-trend-metric", "FCR");
  await sleep(700);
  const fcrTrendLines = await lines("fib-trends");
  ok("U17 trend metric selector switches to FCR series", fcrTrendLines >= 2, `${fcrTrendLines} lines`);
  await setTid("fib-trend-metric", "AVG_WEIGHT_G");
  await sleep(400);
}

// ═══ 4. UI — GROWTH ANALYTICS OVERLAY ═══════════════════════════════════
{
  // with profiles resolving, the growth charts relabel the target line
  const legend = await page.evaluate(() => document.body.textContent || "");
  ok("G1 growth analytics target line relabelled 'Benchmark target (g)'", /Benchmark target \(g\)/.test(legend));
  const growthLines = await lines("fga-chart-growth");
  ok("G2 daily growth trend: actual + benchmark target (2 lines)", growthLines === 2, `${growthLines} lines`);
  const ageLines = await lines("fga-chart-weight-age");
  ok("G3 weight-by-age chart renders target overlay", ageLines === 1, `${ageLines} lines`);

  // fallback parity: template weight curve = built-in species standard
  const r = await api("/api/aquaculture/benchmarks?businessId=3", null, "GET");
  const tilapiaTpl = r.d.templates.find((t) => t.species === "VOLTA_TILAPIA");
  const d196 = tilapiaTpl.curves.AVG_WEIGHT_G.points.find((p) => p[0] === 196);
  ok("G4 tilapia template d196 = 520g (species-standard parity)", Math.abs(d196[1] - 520) < 0.001, `${d196[1]}g`);
  ok("G5 templates carry no SGR curve (engine derives it from weight)", tilapiaTpl.curves.SGR_PCT == null);
}

// ═══ 5. MANAGER DRAWER ═══════════════════════════════════════════════════
{
  await selectBatchViaPanel(page);
  await clickTid("fib-manage-btn");
  await sleep(900);
  ok("D1 manager drawer opens", await exists(tid("fibm-root")));
  ok("D2 profile list shows seeded profiles", (await textOf(tid("fibm-list"))).includes("Volta Tilapia"), (await textOf(tid("fibm-list"))).slice(0, 60));

  // open editor on the tilapia profile
  const editBtn = await page.$$eval('[data-testid^="fibm-edit-"]', (ns) => {
    const n = ns[0];
    if (n) { n.click(); return true; }
    return false;
  });
  ok("D3 editor opens with curve grid", editBtn && await exists(tid("fibm-editor")));
  const nameVal = await page.$eval(tid("fibm-name"), (e) => e.value);
  ok("D4 editor prefilled (name)", /Tilapia|Catfish/i.test(nameVal), nameVal);
  ok("D5 curve grid rows present (weight curve ≥ 8 points)", (await page.$$('[data-testid^="fibm-pt-AVG_WEIGHT_G-"]')).length >= 16); // 8 points × 2 inputs
  ok("D6 species + strain fields present", await exists(tid("fibm-species")) && await exists(tid("fibm-strain")));
  await clickTid("fibm-back");
  ok("D7 back to list", !(await exists(tid("fibm-editor"))));

  // template picker
  await clickTid("fibm-template");
  ok("D8 template picker lists 2 species templates", (await page.$$eval('[data-testid^="fibm-use-template-"]', (n) => n.length)) === 2);
  await clickTid("fibm-use-template-0");
  ok("D9 template prefills editor", await exists(tid("fibm-editor")) && (await page.$eval(tid("fibm-name"), (e) => e.value)).length > 0);
  await page.evaluate(() => { const el = document.querySelector('[data-testid="fibm-name"]'); const p = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; p.call(el, "FISH-TEST-TplCopy"); el.dispatchEvent(new Event("input", { bubbles: true })); });
  await clickTid("fibm-save");
  await sleep(900);
  const tplCount = await q1("SELECT count(*) c FROM aquaculture_benchmark_profiles WHERE name = 'FISH-TEST-TplCopy'");
  ok("D10 template copy saved via API", Number(tplCount.c) === 1);

  // derive-from-batch
  await clickTid("fibm-derive");
  await sleep(500);
  const deriveCount = await page.$$eval('[data-testid^="fibm-derive-"]', (n) => n.length);
  ok("D11 derive picker lists batches", deriveCount >= 3, `${deriveCount} batches`);
  const preDeriveMax = await q1("SELECT max(id) m FROM aquaculture_benchmark_profiles");
  const t02id = await q1("SELECT id FROM aquaculture_batches WHERE batch_number = 'FB-DEMO-T02'");
  await page.evaluate((id) => { const el = document.querySelector(`[data-testid="fibm-derive-${id}"]`); if (el) el.click(); }, t02id.id);
  await sleep(1100);
  const derived = await q1("SELECT count(*) c FROM aquaculture_benchmark_profiles WHERE source = 'FARM_HISTORY' AND name LIKE 'FB-DEMO-T02%'");
  ok("D12 derive-from-batch created FARM_HISTORY profile", Number(derived.c) >= 1);
  ok("D13 success message shown", /derived/i.test(await textOf(tid("fibm-root"))));
  await clickTid("fibm-close");
  await sleep(400);
  ok("D14 drawer closed", !(await exists(tid("fibm-root"))));
  // remove the FARM_HISTORY profile this run derived (keep pre-existing ones)
  await q(`DELETE FROM aquaculture_benchmark_profiles WHERE id > ${Number(preDeriveMax.m)}`);
}

// helper used by §5 (select T01 so the manage button state is stable)
async function selectBatchViaPanel(pg2) {
  await pg2.waitForSelector('[data-testid="fib-batch-select"]', { timeout: 15000 });
  await pg2.evaluate(() => {
    const sel = document.querySelector('[data-testid="fib-batch-select"]');
    const opt = [...sel.options].find((o) => /FB-DEMO-T01/.test(o.textContent || ""));
    if (opt) {
      const p = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
      p.call(sel, opt.value);
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await sleep(700);
}

// ═══ 6. PURGE TEST ARTIFACTS ════════════════════════════════════════════
{
  await q("DELETE FROM aquaculture_weight_logs WHERE batch_number LIKE 'FISH-TEST-%'");
  await q("DELETE FROM aquaculture_feed_logs WHERE batch_id IN (SELECT id FROM aquaculture_batches WHERE batch_number LIKE 'FISH-TEST-%')");
  await q("DELETE FROM aquaculture_batches WHERE batch_number LIKE 'FISH-TEST-%'");
  await q("DELETE FROM aquaculture_benchmark_profiles WHERE name LIKE 'FISH-TEST-%'");
  const leftP = Number((await q1("SELECT count(*) c FROM aquaculture_benchmark_profiles WHERE name LIKE 'FISH-TEST-%'")).c);
  const leftB = Number((await q1("SELECT count(*) c FROM aquaculture_batches WHERE batch_number LIKE 'FISH-TEST-%'")).c);
  ok("P1 test profiles + batches purged", leftP === 0 && leftB === 0 && leftP === B.testProfiles && leftB === B.testBatches, `${leftP} profiles, ${leftB} batches`);
  const demo = Number((await q1("SELECT count(*) c FROM aquaculture_benchmark_profiles WHERE name IN ('Volta Tilapia — GoMina Farm Target','African Catfish — GoMina Farm Target')")).c);
  ok("P2 demo profiles intact", demo === 2);
  const demoBatches = Number((await q1("SELECT count(*) c FROM aquaculture_batches WHERE batch_number LIKE 'FB-DEMO-%'")).c);
  ok("P3 demo batches intact (4)", demoBatches === 4, `${demoBatches}`);
}

// page errors
ok("X0 no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

await browser.close();
await client.end();
console.log(`\n${failures === 0 ? "✅ ALL FISH BENCHMARK CHECKS PASSED" : `❌ ${failures} FAILURE(S)`} (${checks.length} checks)`);
process.exit(failures === 0 ? 0 : 1);
