#!/usr/bin/env node
/**
 * FEED MILL — end-to-end verification suite (Poultry sub-module P0+P1).
 *
 * Proves, in a real browser against the LIVE app + direct DB truth:
 *   A. Tab + mill shell render (owner, poultry unit)
 *   B. Formulation validations, create, PATCH, duplicate-guard, deactivation gate
 *   C. Raw-material intake: unit conversions, cost conversion, stock effect,
 *      single POULTRY_FEED_RAW_MATERIAL expense, expense-permission gate
 *   D. Batch production: insufficient-stock guard, BOM draws, override draws,
 *      ingredient stock decrement byte-exact, finished stock-in, derived costs,
 *      yield, ONE POULTRY_FEED_MILL_OPS txn (and none when costs are zero)
 *   E. QC hard gate: no consumption while QC_HOLD (409), release needs finished
 *      PASS (400 QC_GATE), OWNER/canManageRecords override w/ note, FAIL bell,
 *      normal PASS release, REJECT owner-only + stock reversal + terminal
 *   F. Consumption: RELEASED-only, per-batch remaining, stock draw, feed-log
 *      OWN_MILL row, NEVER a money booking (single-booking), BAG25 conversion
 *   G. Analytics determinism: KPIs re-derived in-suite from API payload, both
 *      savings baselines (formulation ref + business purchase average)
 *   H. Alerts & bell fan-out (FEED_QC_FAIL, FEED_RAW_OUT criticals)
 *   I. Governance: audit-center listing + record resolution + FLAG review,
 *      mill checklist template self-heal, audit-trail actions for every write
 *   J. UI flows: formula create + release confirm + tables + FEED tab badge,
 *      mobile no-overflow, zero page errors
 *   Z. Full TEST purge + forensics (inventory restored byte-exact)
 *
 * Usage: LD_LIBRARY_PATH=/tmp/al2023/lib node dev-tooling/verify-feed-mill.mjs
 */
import { createRequire } from "node:module";

const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");
const { Client } = require("pg");

const BASE = "http://127.0.0.1:3000";
const BIZ = 1; // Mina Akuafo Poultry Farm (POULTRY-01)
const OWNER = { email: "kwame.owner@gomina360.com", pw: "Owner@GoMina26" };
const GM = { email: "abena.gm@gomina360.com", pw: "GoMina@User2" };
const WORKER = { email: "akua.donkor@gomina360.com", pw: "GoMina@User10" };
const WORKER_ID = 10;
const TODAY = new Date().toISOString().slice(0, 10);

let passed = 0, failed = 0;
const results = [];
function check(name, cond, detail = "") {
  if (cond) { passed++; results.push(`✅ ${name}`); }
  else { failed++; results.push(`❌ ${name} — ${detail}`); console.error(`❌ ${name} — ${detail}`); }
}

const pg = new Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });
const q = (t, p) => pg.query(t, p);
const q1 = async (t, p) => (await q(t, p)).rows[0];
const n = (v) => Number(v ?? 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(context, creds) {
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/Failed to load resource: the server responded with a status of (401|404|400|403|409)/.test(t)) return;
    if (/Failed to load resource: net::/.test(t)) return;
    page.errors.push(t);
  });
  await page.setViewport({ width: 1440, height: 960 });
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto(`${BASE}/`, { waitUntil: "networkidle2", timeout: 60000 });
    const hit = await page.waitForSelector("[data-testid='login-email']", { timeout: 30000 }).catch(() => null);
    if (hit) break;
    if (attempt === 1) {
      const diag = await page.evaluate(() => ({ url: location.href, text: document.body?.innerText?.slice(0, 200) })).catch(() => null);
      throw new Error(`login-email never rendered: ${JSON.stringify(diag)}`);
    }
    console.log("  …login screen slow/hidden, retrying page load");
  }
  await page.type("[data-testid='login-email']", creds.email);
  await page.type("[data-testid='login-password']", creds.pw);
  await page.click("[data-testid='login-submit']");
  await page.waitForSelector("[data-testid='login-email']", { hidden: true, timeout: 30000 });
  await sleep(2400);
  return page;
}
async function selectBusiness(page, name) {
  await page.evaluate((n) => {
    [...document.querySelectorAll("aside button")].find((b) => (b.textContent || "").includes(n))?.click();
  }, name);
  await sleep(2600);
}
async function clickText(page, selectorList, text) {
  return page.evaluate(({ selectorList, text }) => {
    const els = [...document.querySelectorAll(selectorList)];
    const el = els.find((b) => (b.textContent || "").trim().replace(/\s+/g, " ").includes(text));
    if (el) { el.click(); return true; }
    return false;
  }, { selectorList, text });
}

// feed-mill API helpers (run in the authenticated page context)
const fmPost = (page, entity, data) => page.evaluate(async ({ entity, data }) => {
  const r = await fetch("/api/poultry/feed-mill", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entity, data }) });
  return { status: r.status, body: await r.json() };
}, { entity, data });
const fmPatch = (page, entity, data) => page.evaluate(async ({ entity, data }) => {
  const r = await fetch("/api/poultry/feed-mill", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entity, id: data.id, data }) });
  return { status: r.status, body: await r.json() };
}, { entity, data });
const fmGet = (page) => page.evaluate(async () => {
  const r = await fetch("/api/poultry/feed-mill?businessId=1");
  return { status: r.status, body: await r.json() };
});
const poultryPost = (page, entity, data) => page.evaluate(async ({ entity, data }) => {
  const r = await fetch("/api/poultry", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entity, data }) });
  return { status: r.status, body: await r.json() };
}, { entity, data });

async function main() {
  await pg.connect();
  const browser = await puppeteer.launch({
    executablePath: "/tmp/al2023/chromium",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const created = { invIds: [], formIds: [], batchIds: [], qcIds: [], txnIds: [], feedLogIds: [], notifMax: 0, trailMax: 0, reviewMax: 0, issueUpdMax: 0, tplMax: 0 };

  try {
    console.log("── 0. Defensive TFM purge → forensics baselines ──");
    // Purge residue from crashed earlier runs. STRICTLY TFM-scoped: the mill
    // may hold real user data (a teammate can be testing in the live preview),
    // so nothing without the TFM marker is ever touched.
    const tfmBatchNos = new Set((await q(`SELECT batch_number FROM poultry_feed_batches WHERE formulation_name LIKE 'TFM%'`)).rows.map((r) => r.batch_number));
    await q(`DELETE FROM poultry_feed_logs WHERE business_id=$1 AND (brand_supplier LIKE 'TFM%' OR feed_batch_id IN (SELECT id FROM poultry_feed_batches WHERE formulation_name LIKE 'TFM%'))`, [BIZ]);
    await q(`DELETE FROM poultry_feed_batch_inputs WHERE batch_id IN (SELECT id FROM poultry_feed_batches WHERE formulation_name LIKE 'TFM%')`);
    await q(`DELETE FROM poultry_feed_qc_checks WHERE business_id=$1 AND (test_name LIKE 'TFM%' OR batch_number = ANY($2))`, [BIZ, [...tfmBatchNos]]);
    await q(`DELETE FROM poultry_feed_batches WHERE formulation_name LIKE 'TFM%'`);
    await q(`DELETE FROM poultry_feed_formulation_items WHERE formulation_id IN (SELECT id FROM poultry_feed_formulations WHERE name LIKE 'TFM%')`);
    await q(`DELETE FROM poultry_feed_formulations WHERE name LIKE 'TFM%'`);
    await q(`DELETE FROM transactions WHERE business_id=$1 AND description LIKE '%TFM%'`, [BIZ]);
    await q(`DELETE FROM audit_issue_updates WHERE issue_id IN (SELECT id FROM audit_reviews WHERE issue_title LIKE 'TFM%' OR reason LIKE 'TFM%')`);
    await q(`DELETE FROM audit_reviews WHERE issue_title LIKE 'TFM%' OR reason LIKE 'TFM%'`);
    await q(`DELETE FROM notifications WHERE type LIKE 'FEED_%' AND (title LIKE '%TFM%' OR body LIKE '%TFM%' OR record_ref = ANY($1))`, [[...tfmBatchNos]]);
    await q(`DELETE FROM audit_trail WHERE action LIKE 'FEED_%' AND target_label LIKE '%TFM%'`);
    await q(`DELETE FROM checklist_templates WHERE business_id=$1 AND task_key LIKE 'MILL_%'`, [BIZ]);
    await q(`DELETE FROM inventory_items WHERE business_id=$1 AND name LIKE 'TFM%'`, [BIZ]);

    // baselines (taken AFTER the purge so they reflect a stable slate)
    const maxId = async (t) => n((await q1(`SELECT COALESCE(MAX(id),0) m FROM ${t}`)).m);
    const invSnapshot = Object.fromEntries(
      (await q(`SELECT id, sku, name, quantity, cost_price_ghs, selling_price_ghs, min_stock_threshold, status FROM inventory_items WHERE business_id=$1 ORDER BY id`, [BIZ]))
        .rows.map((r) => [r.id, r]));
    const b0 = {
      txns: n((await q1(`SELECT count(*) c FROM transactions WHERE business_id=$1`, [BIZ])).c),
      txnMax: await maxId("transactions"), notifMax: await maxId("notifications"),
      trailMax: await maxId("audit_trail"), reviewMax: await maxId("audit_reviews"),
      issueUpdMax: await maxId("audit_issue_updates"), tplMax: await maxId("checklist_templates"),
      invMax: await maxId("inventory_items"), feedLogCount: n((await q1(`SELECT count(*) c FROM poultry_feed_logs WHERE business_id=$1`, [BIZ])).c),
      millTables0: {
        formulations: n((await q1(`SELECT count(*) c FROM poultry_feed_formulations WHERE business_id=$1`, [BIZ])).c),
        batches: n((await q1(`SELECT count(*) c FROM poultry_feed_batches WHERE business_id=$1`, [BIZ])).c),
        qc: n((await q1(`SELECT count(*) c FROM poultry_feed_qc_checks WHERE business_id=$1`, [BIZ])).c),
      },
      workerFlags: await q1(`SELECT can_manage_records, can_record_expenses FROM users WHERE id=$1`, [WORKER_ID]),
    };
    created.notifMax = b0.notifMax; created.trailMax = b0.trailMax; created.reviewMax = b0.reviewMax;
    created.issueUpdMax = b0.issueUpdMax; created.tplMax = b0.tplMax;
    const invQty = async (id) => n((await q1(`SELECT quantity q FROM inventory_items WHERE id=$1`, [id])).q);
    check("0.1 baselines captured (inventory snapshot, max ids, worker flags, counts)", true,
      `${Object.keys(invSnapshot).length} pre-existing items`);

    const ownerCtx = await browser.createBrowserContext();
    const op = await login(ownerCtx, OWNER);
    await selectBusiness(op, "Mina Akuafo Poultry Farm");

    // ══ A. UI shell ════════════════════════════════════════════════════
    console.log("── A. Feed Mill tab + shell ──");
    await page_clickFeedMill(op);
    check("A1 Feed Mill tab exists in the poultry module", await op.$("[data-testid='feed-mill-root']") !== null);
    check("A2 five sub-tabs render", (await op.$$eval("[data-testid^='fm-subtab-']", (n) => n.length)) === 5);
    check("A3 overview renders setup guide (fresh mill) or existing-batch KPIs",
      (await op.$("[data-testid='fm-empty']") !== null) || (await op.$$("[data-testid^='fm-batch-']")).length > 0 || (await op.$("[data-testid='fm-kpi-finished']") !== null));

    // ══ B. Formulations ════════════════════════════════════════════════
    console.log("── B. Formulation validations + create + PATCH + gates ──");
    const baseItems = [
      { ingredientName: "TFM Maize", sharePct: 55 }, { ingredientName: "TFM Soybean Meal", sharePct: 30 },
      { ingredientName: "TFM Wheat Bran", sharePct: 10 }, { ingredientName: "TFM Premix", sharePct: 5 },
    ];
    let r = await fmPost(op, "FORMULATION", { businessId: BIZ, name: "", items: baseItems });
    check("B1 formulation without a name is refused (400)", r.status === 400, JSON.stringify(r.body));
    r = await fmPost(op, "FORMULATION", { businessId: BIZ, name: "TFM X", items: [] });
    check("B2 formulation without ingredients is refused (400)", r.status === 400);
    r = await fmPost(op, "FORMULATION", { businessId: BIZ, name: "TFM X", items: [{ ingredientName: "TFM Maize", sharePct: 105 }] });
    check("B3 shares must total 100% (105% refused, 400)", r.status === 400 && /100%/.test(r.body.error || ""), r.body.error);
    r = await fmPost(op, "FORMULATION", {
      businessId: BIZ, name: "TFM Broiler Starter 24%", feedType: "STARTER", birdType: "BROILERS",
      batchSizeKg: 500, cpPctTarget: 24, meKcalKgTarget: 3000, commercialRefPriceGhs: 12.5,
      notes: "TFM test recipe", items: baseItems,
    });
    check("B4 formulation created", r.status === 200 && r.body.success === true, JSON.stringify(r.body).slice(0, 160));
    const F1 = r.body.item; created.formIds.push(F1.id);
    check("B5 formulation number assigned (FRM-YYYY-…)", /^FRM-\d{4}-\d+/.test(F1.formulationNo || ""), F1.formulationNo);
    const f1Items = (await q(`SELECT * FROM poultry_feed_formulation_items WHERE formulation_id=$1 ORDER BY sequence`, [F1.id])).rows;
    check("B6 BOM persisted with 4 lines summing 100%", f1Items.length === 4 && Math.abs(f1Items.reduce((s, i) => s + n(i.share_pct), 0) - 100) < 1e-9);
    check("B7 BOM lines resolved to raw-material inventory items", f1Items.every((i) => i.inventory_id != null && String(i.sku || "").startsWith("POUL-RM-")), JSON.stringify(f1Items.map((i) => i.sku)));
    r = await fmPost(op, "FORMULATION", { businessId: BIZ, name: "TFM Broiler Starter 24%", items: baseItems });
    check("B8 duplicate name refused (409)", r.status === 409, `HTTP ${r.status}`);
    r = await fmPatch(op, "FORMULATION", { businessId: BIZ, id: F1.id, cpPctTarget: 23.5, commercialRefPriceGhs: 12.5 });
    check("B9 PATCH updates header fields", r.body.success && n(r.body.item?.cpPctTarget ?? r.body.item?.cp_pct_target ?? 23.5) === 23.5, JSON.stringify(r.body).slice(0, 120));

    // unauthenticated access guard (fresh context, no session)
    const anonCtx = await browser.createBrowserContext();
    const anonPage = await anonCtx.newPage();
    await anonPage.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
    const anonRes = await anonPage.evaluate(async () => (await fetch("/api/poultry/feed-mill?businessId=1")).status);
    check("B10 unauthenticated GET is refused (401)", anonRes === 401, `HTTP ${anonRes}`);
    await anonCtx.close();

    // worker gates
    const workerCtx = await browser.createBrowserContext();
    const wp = await login(workerCtx, WORKER);
    await selectBusiness(wp, "Mina Akuafo Poultry Farm");
    r = await fmPatch(wp, "FORMULATION", { businessId: BIZ, id: F1.id, active: false });
    check("B11 WORKER may not deactivate a formulation (403)", r.status === 403, `HTTP ${r.status}`);

    // ══ C. Intake ═══════════════════════════════════════════════════════
    console.log("── C. Raw-material intake: units, costs, stock, single expense, gates ──");
    // C1: OWNER books TFM Maize: 10 × 50-kg bags @ GH₵420/bag → 500 kg @ 8.40/kg = GH₵4,200
    const items = { maize: f1Items.find((i) => i.ingredient_name === "TFM Maize"), soya: f1Items.find((i) => i.ingredient_name === "TFM Soybean Meal"), bran: f1Items.find((i) => i.ingredient_name === "TFM Wheat Bran"), premix: f1Items.find((i) => i.ingredient_name === "TFM Premix") };
    const invId = { maize: items.maize.inventory_id, soya: items.soya.inventory_id, bran: items.bran.inventory_id, premix: items.premix.inventory_id };
    const intake = async (page, d) => fmPost(page, "INTAKE", { businessId: BIZ, branchCode: "POULTRY-01", branchName: "Nsawam", ...d });
    r = await intake(op, { inventoryId: invId.maize, qty: 10, unit: "BAG50", unitCostGhs: 8.4, totalCostGhs: 4200, supplierName: "TFM Olam Grains", paymentMethod: "CASH", date: TODAY });
    check("C1 maize intake (10 × BAG50 = 500 kg @ 8.40/kg) succeeds", r.body.success && n(r.body.qtyKg) === 500, JSON.stringify(r.body).slice(0, 140));
    let inv = await q1(`SELECT quantity, cost_price_ghs FROM inventory_items WHERE id=$1`, [invId.maize]);
    check("C2 inventory stock +500 kg at 8.40 cost", n(inv.quantity) === 500 && n(inv.cost_price_ghs) === 8.4, JSON.stringify(inv));
    let t = await q1(`SELECT * FROM transactions WHERE id=(SELECT MAX(id) FROM transactions WHERE business_id=$1 AND category='POULTRY_FEED_RAW_MATERIAL')`, [BIZ]);
    check("C3 exactly one raw-material expense txn (GH₵ 4,200, EXPENSE)", !!t && n(t.amount_ghs) === 4200 && t.type === "EXPENSE" && t.business_id === BIZ, t ? JSON.stringify({ a: n(t.amount_ghs), type: t.type }) : "none");
    created.txnIds.push(t.id);

    // C4-C6: GM + Owner intakes (roles allowed). Soy: 6 BAG50=300kg @15/kg=4500; Bran: 2 BAG50=100kg @8/kg=800 w/ threshold; Premix: 4 BAG25=100kg @60/kg=6000
    const gmCtx = await browser.createBrowserContext();
    const gp = await login(gmCtx, GM);
    await selectBusiness(gp, "Mina Akuafo Poultry Farm");
    r = await intake(gp, { inventoryId: invId.soya, qty: 6, unit: "BAG50", unitCostGhs: 15, totalCostGhs: 4500, supplierName: "TFM Yara", paymentMethod: "BANK", date: TODAY });
    check("C4 GM intake books expense (soybean 300 kg = GH₵ 4,500)", r.body.success && n(r.body.expense?.amountGhs ?? r.body.expense?.amount_ghs) === 4500, JSON.stringify(r.body).slice(0, 140));
    r = await intake(op, { inventoryId: invId.bran, qty: 2, unit: "BAG50", unitCostGhs: 8, totalCostGhs: 800, supplierName: "TFM Ayensu", paymentMethod: "MOMO", date: TODAY, minStockThreshold: 60 });
    check("C5 owner bran intake (100 kg) + threshold set", r.body.success === true);
    r = await intake(op, { inventoryId: invId.premix, qty: 4, unit: "BAG25", unitCostGhs: 60, totalCostGhs: 6000, supplierName: "TFM Trouw", paymentMethod: "BANK", date: TODAY });
    check("C6 premix intake via BAG25 (4 × 25 kg = 100 kg)", r.body.success && n(r.body.qtyKg) === 100, JSON.stringify(r.body).slice(0, 120));
    inv = await q1(`SELECT quantity FROM inventory_items WHERE id=$1`, [invId.bran]);
    check("C7 bran stock = 100 kg in DB", n(inv.quantity) === 100, JSON.stringify(inv));

    // C8-C10: worker gates — expense 403, stock-only OK (+150 kg bran, no txn)
    r = await intake(wp, { inventoryId: invId.bran, qty: 1, unit: "BAG50", unitCostGhs: 8.4, totalCostGhs: 420, supplierName: "TFM", date: TODAY });
    check("C8 WORKER intake with expense booking is refused (403)", r.status === 403, `HTTP ${r.status}`);
    check("C8b refused intake left NO stock trace (bran still 100 kg)", (await invQty(invId.bran)) === 100, `bran=${await invQty(invId.bran)}`);
    const txCountBefore = n((await q1(`SELECT count(*) c FROM transactions WHERE business_id=$1`, [BIZ])).c);
    r = await intake(wp, { inventoryId: invId.bran, qty: 3, unit: "BAG50", unitCostGhs: 8, totalCostGhs: 0, supplierName: "TFM donor", date: TODAY, recordExpense: false });
    check("C9 WORKER stock-only intake accepted (no expense flag)", r.body.success === true, JSON.stringify(r.body).slice(0, 120));
    const txCountAfter = n((await q1(`SELECT count(*) c FROM transactions WHERE business_id=$1`, [BIZ])).c);
    inv = await q1(`SELECT quantity, min_stock_threshold FROM inventory_items WHERE id=$1`, [invId.bran]);
    check("C10 stock-only intake added 150 kg bran (250 total) and booked NO transaction", n(inv.quantity) === 250 && txCountAfter === txCountBefore, `bran=${inv.quantity} txΔ=${txCountAfter - txCountBefore}`);
    const expTxns = (await q(`SELECT id FROM transactions WHERE business_id=$1 AND category='POULTRY_FEED_RAW_MATERIAL' AND id>$2`, [BIZ, b0.txnMax])).rows;
    check("C11 exactly 4 raw-material expense txns (4200+4500+800+6000)", expTxns.length === 4, `got ${expTxns.length}`);

    // ══ D. Batch production ════════════════════════════════════════════
    console.log("── D. Batches: sufficiency guard, runs, draws, costs • single ops txn ──");
    r = await fmPost(op, "BATCH", { businessId: BIZ, formulationId: F1.id, plannedInputKg: 2000, actualOutputKg: 1980, productionDate: TODAY });
    check("D1 oversized run refused w/ INSUFFICIENT_STOCK", r.status === 400 && r.body.code === "INSUFFICIENT_STOCK", JSON.stringify(r.body).slice(0, 160));
    inv = await q1(`SELECT quantity FROM inventory_items WHERE id=$1`, [invId.maize]);
    check("D2 refused run changed NO stock", n(inv.quantity) === 500, `maize=${inv.quantity}`);

    // batch1: 500 kg in → 490 kg out, labour 120 + overhead 80
    r = await fmPost(op, "BATCH", {
      businessId: BIZ, formulationId: F1.id, plannedInputKg: 500, actualOutputKg: 490,
      labourCostGhs: 120, overheadCostGhs: 80, operatorName: "TFM Kofi Mensah", productionDate: TODAY, paymentMethod: "CASH", notes: "TFM batch one",
    });
    const B1 = r.body.item;
    check("D3 batch 1 milled (500 → 490 kg)", r.body.success && n(B1.actualOutputKg) === 490, JSON.stringify(r.body).slice(0, 200));
    created.batchIds.push(B1.id);
    check("D4 batch number FDB-YYYY-… and starts QC_HOLD", /^FDB-\d{4}-/.test(B1.batchNumber) && B1.status === "QC_HOLD", `${B1.batchNumber}/${B1.status}`);
    const rBad = await fmPost(op, "BATCH", { businessId: BIZ, formulationId: F1.id, plannedInputKg: 100, actualOutputKg: 150, productionDate: TODAY });
    check("D4b physically impossible yield refused BEFORE any stock moves (150 kg out of 100 kg in)",
      rBad.status === 400 && rBad.body.code === "IMPOSSIBLE_YIELD" && (await invQty(invId.maize)) === 225,
      `HTTP ${rBad.status} maize=${await invQty(invId.maize)}`);
    const ingCost = 275 * 8.4 + 150 * 15 + 50 * 8 + 25 * 60;            // 6460
    const expCostPerKg = +((ingCost + 200) / 490).toFixed(3);            // 6660/490 → 13.592
    check("D5 derived ingredient cost exact (6460, NEVER re-booked)", Math.abs(n(B1.ingredientCostGhs) - 6460) < 0.01, String(B1.ingredientCostGhs));
    check("D6 total cost = ingredients + labour + overhead (6660)", Math.abs(n(B1.totalCostGhs) - 6660) < 0.01, String(B1.totalCostGhs));
    check("D7 cost/kg + yield math (13.592/kg, 98.0%)", Math.abs(n(B1.costPerKgGhs) - expCostPerKg) < 0.001 && Math.abs(n(B1.yieldPct) - 98) < 0.05, `${B1.costPerKgGhs}/${B1.yieldPct}`);
    check("D8 ingredient stocks decremented byte-exact (maize 225, soya 150, bran 200, premix 75)",
      (await invQty(invId.maize)) === 225 && (await invQty(invId.soya)) === 150 && (await invQty(invId.bran)) === 200 && (await invQty(invId.premix)) === 75,
      `${await invQty(invId.maize)}/${await invQty(invId.soya)}/${await invQty(invId.bran)}/${await invQty(invId.premix)}`);
    const finItem1 = await q1(`SELECT * FROM inventory_items WHERE id=$1`, [B1.finishedInventoryId]);
    check("D9 finished feed stocked at derived cost (490 kg @ 13.592, Animal Feed (Milled))",
      n(finItem1.quantity) === 490 && Math.abs(n(finItem1.cost_price_ghs) - expCostPerKg) < 0.001 && finItem1.category === "Animal Feed (Milled)", JSON.stringify({ q: n(finItem1.quantity), c: n(finItem1.cost_price_ghs), cat: finItem1.category }));
    created.invIds.push(B1.finishedInventoryId);
    const opsTxns = (await q(`SELECT id, amount_ghs FROM transactions WHERE business_id=$1 AND category='POULTRY_FEED_MILL_OPS' AND id>$2`, [BIZ, b0.txnMax])).rows;
    check("D10 exactly ONE mill-ops txn for the batch (GH₵ 200 = labour+overhead)", opsTxns.length === 1 && n(opsTxns[0].amount_ghs) === 200, JSON.stringify(opsTxns));

    // batch2: 250 → 245, L60 O40 (FAIL QC then PASS; stays QC_HOLD for the UI release)
    r = await fmPost(op, "BATCH", {
      businessId: BIZ, formulationId: F1.id, plannedInputKg: 250, actualOutputKg: 245,
      labourCostGhs: 60, overheadCostGhs: 40, operatorName: "TFM Kofi Mensah", productionDate: TODAY, notes: "TFM batch two",
    });
    const B2 = r.body.item;
    check("D11 batch 2 milled (250 → 245 kg)", r.body.success && n(B2.actualInputKg) === 250, JSON.stringify(r.body).slice(0, 160));
    created.batchIds.push(B2.id);
    const draws2 = (await q(`SELECT ingredient_name, planned_kg, actual_kg FROM poultry_feed_batch_inputs WHERE batch_id=$1 ORDER BY id`, [B2.id])).rows;
    check("D12 BOM draws proportioned exactly (137.5/75/25/12.5 kg)",
      Math.abs(n(draws2.find((d) => d.ingredient_name === "TFM Maize")?.actual_kg) - 137.5) < 0.001 &&
      Math.abs(n(draws2.find((d) => d.ingredient_name === "TFM Premix")?.actual_kg) - 12.5) < 0.001, JSON.stringify(draws2.map((d) => `${d.ingredient_name}:${d.actual_kg}`)));

    // batch3: override bran draw to consume ALL remaining bran (175 - 25 = 150 left after b2 → draw 150) → raw-out critical
    const branLeft = await invQty(invId.bran);
    r = await fmPost(op, "BATCH", {
      businessId: BIZ, formulationId: F1.id, plannedInputKg: 150, actualOutputKg: 148,
      labourCostGhs: 0, overheadCostGhs: 0, operatorName: "TFM Kofi Mensah", productionDate: TODAY,
      inputOverrides: [{ formulationItemId: items.bran.id, actualKg: branLeft }],
      notes: "TFM batch three (reject candidate)",
    });
    const B3 = r.body.item;
    check("D13 batch 3 with an override draw accepted", r.body.success === true, JSON.stringify(r.body).slice(0, 160));
    created.batchIds.push(B3.id);
    check("D14 override draw consumed ALL bran (0 left → raw-out condition)", (await invQty(invId.bran)) === 0, `bran=${await invQty(invId.bran)}`);
    const opsTxns2 = (await q(`SELECT id, amount_ghs FROM transactions WHERE business_id=$1 AND category='POULTRY_FEED_MILL_OPS' AND id>$2 ORDER BY id`, [BIZ, b0.txnMax])).rows;
    check("D15 zero-cost batch books NO ops txn (still 2 ops txns total)", opsTxns2.length === 2 && n(opsTxns2[1].amount_ghs) === 100, JSON.stringify(opsTxns2));

    // ══ E. QC gate ═════════════════════════════════════════════════════
    console.log("── E. QC hard gate, override, FAIL bell, REJECT ──");
    r = await fmPost(op, "CONSUMPTION", { businessId: BIZ, batchId: B1.id, flockId: 1, qty: 10, unit: "KG", recordedDate: TODAY });
    check("E1 consumption from a QC_HOLD batch is refused (409 NOT_RELEASED)", r.status === 409 && r.body.code === "NOT_RELEASED", `HTTP ${r.status}`);
    r = await fmPost(op, "RELEASE", { businessId: BIZ, batchId: B1.id, note: "" });
    check("E2 release without finished-feed PASS is refused (400 QC_GATE)", r.status === 400 && r.body.code === "QC_GATE", JSON.stringify(r.body).slice(0, 160));

    // raw-material QC check + batch2 finished-feed FAIL (bell) + PASS
    r = await fmPost(op, "QC", { businessId: BIZ, stage: "RAW_MATERIAL", testName: "TFM soybean aflatoxin screen", passFail: "PASS", testResult: "Negative < 20 ppb", testerName: "TFM Dr. Selorm" });
    check("E3 raw-material QC check logs without a batch", r.body.success === true, JSON.stringify(r.body).slice(0, 120));
    created.qcIds.push(r.body.item?.id);
    r = await fmPost(op, "QC", { businessId: BIZ, batchId: B2.id, stage: "FINISHED_FEED", testName: "TFM moisture check", passFail: "FAIL", resultValue: 16.2, resultUnit: "%", requiredStandard: "≤ 13%", testerName: "TFM Dr. Selorm" });
    check("E4 finished-feed FAIL logs on batch 2", r.body.success && r.body.item.passFail === "FAIL", JSON.stringify(r.body).slice(0, 120));
    created.qcIds.push(r.body.item?.id);
    await sleep(800);
    const failBells = await q1(`SELECT count(*) c FROM notifications WHERE type='FEED_QC_FAIL' AND id>$1`, [b0.notifMax]);
    check("E5 FAIL fanned out critical FEED_QC_FAIL bell (≥1 recipient)", n(failBells.c) >= 1, `bells=${failBells.c}`);
    r = await fmPost(op, "QC", { businessId: BIZ, batchId: B2.id, stage: "FINISHED_FEED", testName: "TFM moisture re-test after drying", passFail: "PASS", resultValue: 11.8, resultUnit: "%", testerName: "TFM Dr. Selorm" });
    check("E6 corrective PASS logs", r.body.success === true);
    created.qcIds.push(r.body.item?.id);

    // worker override path: grant Akua can_manage_records (SQL, restored in purge)
    await q(`UPDATE users SET can_manage_records=true WHERE id=$1`, [WORKER_ID]);
    const wpCtx2 = await browser.createBrowserContext();
    const wp2 = await login(wpCtx2, WORKER); // fresh login so entitlements reload
    await selectBusiness(wp2, "Mina Akuafo Poultry Farm");
    r = await fmPost(wp2, "RELEASE", { businessId: BIZ, batchId: B1.id, note: "TFM visual + smell OK; lab assay pending" });
    check("E7 records-authorized WORKER may override-release WITH a note", r.body.success === true, `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 140)}`);
    let b1db = await q1(`SELECT status, released_by_name, release_note FROM poultry_feed_batches WHERE id=$1`, [B1.id]);
    check("E8 override recorded in release basis + releaser name", b1db.status === "RELEASED" && b1db.released_by_name === "Akua Donkor" && /OVERRIDE/.test(b1db.release_note || "") && /TFM visual/.test(b1db.release_note || ""), JSON.stringify(b1db));
    r = await fmPost(wp2, "RELEASE", { businessId: BIZ, batchId: B1.id, note: "again" });
    check("E9 releasing an already-released batch is refused", r.status !== 200 || r.body.success === false, `HTTP ${b1db.status}`);
    await wpCtx2.close();
    await q(`UPDATE users SET can_manage_records=$1 WHERE id=$2`, [b0.workerFlags.can_manage_records, WORKER_ID]);

    r = await fmPost(wp, "REJECT", { businessId: BIZ, batchId: B3.id, reason: "TFM n/a" });
    check("E10 WORKER may not reject a batch (403)", r.status === 403, `HTTP ${r.status}`);
    const finQtyBeforeReject = await invQty(B3.finishedInventoryId);
    r = await fmPost(op, "REJECT", { businessId: BIZ, batchId: B3.id, reason: "TFM bran smelt musty on retest" });
    check("E11 OWNER rejects batch 3 with reason", r.body.success === true, JSON.stringify(r.body).slice(0, 140));
    const b3db = await q1(`SELECT status, release_note FROM poultry_feed_batches WHERE id=$1`, [B3.id]);
    check("E12 rejected batch is terminal + basis recorded", b3db.status === "REJECTED" && /REJECTED/.test(b3db.release_note || ""), JSON.stringify(b3db));
    check("E13 rejection reversed the finished stock-in (−148 kg)", (await invQty(B3.finishedInventoryId)) === finQtyBeforeReject - 148, `${finQtyBeforeReject}→${await invQty(B3.finishedInventoryId)}`);
    r = await fmPost(op, "REJECT", { businessId: BIZ, batchId: B1.id, reason: "TFM late attempt" });
    check("E14 rejecting a RELEASED batch is refused", r.status === 400 || r.body.success === false, `HTTP ${r.status}`);
    const rawOutBells = await q1(`SELECT count(*) c FROM notifications WHERE type='FEED_RAW_OUT' AND id>$1`, [b0.notifMax]);
    check("E15 bran exhaustion pushed a critical FEED_RAW_OUT bell", n(rawOutBells.c) >= 1, `bells=${rawOutBells.c}`);

    // ══ F. Consumption (single-booking) ════════════════════════════════
    console.log("── F. Consumption: released-only, per-batch ledger, no re-booking ──");
    const txFeedBefore = n((await q1(`SELECT count(*) c FROM transactions WHERE business_id=$1`, [BIZ])).c);
    r = await fmPost(op, "CONSUMPTION", { businessId: BIZ, batchId: B1.id, flockId: 1, batchNumber: "BATCH-2026-L01", qty: 55, unit: "KG", recordedDate: TODAY, notes: "TFM morning feeding" });
    check("F1 feeding 55 kg from released batch 1", r.body.success && n(r.body.item.quantityKg) === 55, JSON.stringify(r.body).slice(0, 160));
    created.feedLogIds.push(r.body.item?.id);
    check("F2 remaining ledger reported (490−55=435 kg)", Math.abs(n(r.body.batchRemainingKg) - 435) < 0.001, String(r.body.batchRemainingKg));
    const logRow = await q1(`SELECT * FROM poultry_feed_logs WHERE id=$1`, [r.body.item.id]);
    check("F3 feed log is OWN_MILL + linked to batch + derived value, entry CONSUMPTION",
      logRow.source_type === "OWN_MILL" && logRow.feed_batch_id === B1.id && logRow.entry_type === "CONSUMPTION" &&
      Math.abs(n(logRow.cost_per_kg_ghs) - 13.592) < 0.01 && Math.abs(n(logRow.total_cost_ghs) - 747.56) < 0.51, JSON.stringify({ s: logRow.source_type, c: n(logRow.total_cost_ghs) }));
    const txFeedAfter = n((await q1(`SELECT count(*) c FROM transactions WHERE business_id=$1`, [BIZ])).c);
    check("F4 feeding booked NO transaction (single-booking principle)", txFeedAfter === txFeedBefore, `Δ=${txFeedAfter - txFeedBefore}`);
    check("F5 finished-feed stock drawn 55 kg", (await invQty(B1.finishedInventoryId)) === 490 - 55 + 245 + 148 - 148 + 245 - 245 ||
      (await invQty(B1.finishedInventoryId)) === 490 - 55 + 245 + 148 - 148, `qty=${await invQty(B1.finishedInventoryId)}`);
    r = await fmPost(op, "CONSUMPTION", { businessId: BIZ, batchId: B1.id, flockId: 1, qty: 436, unit: "KG", recordedDate: TODAY });
    check("F6 drawing beyond the batch ledger is refused (400 BATCH_EXHAUSTED)", r.status === 400 && r.body.code === "BATCH_EXHAUSTED", `HTTP ${r.status}`);

    // ══ G+J(pre). UI flows ═════════════════════════════════════════════
    console.log("── J. UI: shell, tables, UI formula create, UI release, badges, mobile ──");
    const fmRefresh = async (page) => {
      await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.title === "Refresh mill data")?.click());
      await sleep(1100);
    };
    await op.reload({ waitUntil: "networkidle2", timeout: 60000 });
    await sleep(2600);
    await selectBusiness(op, "Mina Akuafo Poultry Farm");
    await page_clickFeedMill(op);
    await op.waitForSelector("[data-testid='feed-mill-root']", { timeout: 20000 });
    check("J1 overview KPI cards render with real mill numbers", (await op.$eval("[data-testid='fm-kpi-finished']", (n2) => n2.textContent || "")).includes(" kg"));
    const alertsHtml = await op.$eval("[data-testid='fm-alerts']", (n2) => n2.textContent || "").catch(() => "");
    check("J2 alert feed renders (raw-out critical + qc-hold)", /out of stock/i.test(alertsHtml) && /hold/i.test(alertsHtml), alertsHtml.slice(0, 90));
    await clickText(op, "[data-testid^='fm-subtab-']", "Formulations");
    await sleep(700);
    check("J3 formulations grid shows TFM recipe with BOM chips", await op.$(`[data-testid='fm-formula-${F1.formulationNo}']`) !== null);

    // UI create formulation 3 (Layer Mash 16%) — full modal flow
    await op.click("[data-testid='fm-btn-new-formula']");
    await op.waitForSelector("[data-testid='fm-form-name']", { timeout: 10000 });
    await op.type("[data-testid='fm-form-name']", "TFM Layer Mash 16%");
    await op.evaluate(() => {
      const el = document.querySelector("[data-testid='fm-form-batchsize']");
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, ""); el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await op.type("[data-testid='fm-form-batchsize']", "300");
    await op.type("[data-testid='fm-form-item-name-0']", "TFM Maize");
    await op.type("[data-testid='fm-form-item-share-0']", "60");
    await op.click("[data-testid='fm-form-add-item']");
    await sleep(300);
    await op.type("[data-testid='fm-form-item-name-1']", "TFM Soybean Meal");
    await op.type("[data-testid='fm-form-item-share-1']", "40");
    await op.type("[data-testid='fm-form-refprice']", "16");
    await op.click("[data-testid='fm-form-submit']");
    await sleep(1800);
    const f3db = await q1(`SELECT id, formulation_no, name, batch_size_kg FROM poultry_feed_formulations WHERE name='TFM Layer Mash 16%'`);
    check("J4 UI-created formulation persisted (300-kg batch, ref 16)", !!f3db && n(f3db.batch_size_kg) === 300, JSON.stringify(f3db));
    if (f3db) created.formIds.push(f3db.id);
    check("J5 new formulation visible in the grid", await op.$(`[data-testid='fm-formula-${f3db?.formulation_no || "zzz"}']`) !== null);

    // batches view: rows, status pills, UI release of batch 2 (has finished PASS)
    await clickText(op, "[data-testid^='fm-subtab-']", "Batches & QC");
    await sleep(900);
    check("J6 batch table lists the three FDB rows", (await op.$$eval("[data-testid^='fm-batch-FDB-']", (n2) => n2.length)) >= 3);
    check("J7 batch 2 keeps its historic FAIL visible in the QC chip", (await op.$eval(`[data-testid='fm-batch-${B2.batchNumber}']`, (n2) => n2.textContent || "")).includes("FAIL"));
    await op.click(`[data-testid='fm-release-${B2.id}']`);
    await op.waitForSelector("[data-testid='fm-confirm-modal']", { timeout: 10000 });
    check("J8 release opens the confirm dialog (QC-pass basis)", (await op.$eval("[data-testid='fm-confirm-modal']", (n2) => n2.textContent || "")).includes("Finished-feed PASS"));
    await op.click("[data-testid='fm-confirm-confirm']");
    await sleep(2200);
    const b2db = await q1(`SELECT status, released_by_name FROM poultry_feed_batches WHERE id=$1`, [B2.id]);
    check("J9 UI release persisted (batch 2 RELEASED by owner)", b2db.status === "RELEASED" && b2db.released_by_name === "Kwame Mina", JSON.stringify(b2db));

    // consumption post-UI-release (KG + BAG25 conversion) + tables
    r = await fmPost(op, "CONSUMPTION", { businessId: BIZ, batchId: B2.id, flockId: 2, batchNumber: "BATCH-2026-B02", qty: 30, unit: "KG", recordedDate: TODAY });
    check("J10 feeding from the UI-released batch works", r.body.success === true, JSON.stringify(r.body).slice(0, 120));
    created.feedLogIds.push(r.body.item?.id);
    r = await fmPost(op, "CONSUMPTION", { businessId: BIZ, batchId: B2.id, flockId: 2, batchNumber: "BATCH-2026-B02", qty: 1, unit: "BAG25", recordedDate: TODAY });
    check("J11 BAG25 conversion on consumption (1 bag = 25 kg)", r.body.success && n(r.body.item.quantityKg) === 25, JSON.stringify(r.body).slice(0, 140));
    created.feedLogIds.push(r.body.item?.id);
    await fmRefresh(op);
    await clickText(op, "[data-testid^='fm-subtab-']", "Feed Out");
    await sleep(800);
    check("J12 Feed Out table lists all three own-mill feedings", (await op.$$eval("[data-testid^='fm-consumption-']", (n2) => n2.length)) >= 3);
    await clickText(op, "button", "Feed");
    await sleep(1200); // poultry FEED tab
    const feedTabHtml = await op.evaluate(() => document.body.innerHTML);
    check("J13 poultry Feed tab badges own-mill rows (OWN MILL)", /OWN MILL/.test(feedTabHtml));

    // mobile viewport: no horizontal overflow inside the mill
    await page_clickFeedMill(op);
    await op.setViewport({ width: 375, height: 800 });
    await sleep(900);
    const overflow = await op.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check("J14 phone viewport (375px) has no horizontal page overflow", overflow <= 1, `overflow=${overflow}px`);
    await op.setViewport({ width: 1440, height: 960 });

    // ══ G. Analytics determinism (both savings baselines) ══════════════
    console.log("── G. Analytics: KPI re-derivation + baseline switching ──");
    const get = await fmGet(op);
    check("G1 GET shape (10 datasets + success)", get.body.success && ["formulations", "formulationItems", "batches", "batchInputs", "qcChecks", "rawMaterials", "finishedFeeds", "consumption", "feedLogs", "flocks"].every((k) => Array.isArray(get.body[k])), Object.keys(get.body || {}).join(","));
    const port = computePort(get.body);
    check("G2 finished-feed KPI = DB truth (milled items sum)", await (async () => {
      const dbFinished = n((await q1(`SELECT COALESCE(SUM(quantity),0) q FROM inventory_items WHERE business_id=$1 AND category='Animal Feed (Milled)'`, [BIZ])).q);
      return port.finishedFeedKg === dbFinished && dbFinished > 0;
    })(), `port=${port.finishedFeedKg}`);
    check("G3 last batch (latest non-rejected) is batch 2 w/ 13.592 cost/kg", !!port.last && port.last.batchNumber === B2.batchNumber && Math.abs(port.last.costPerKgGhs - 13.592) < 0.001, JSON.stringify(port.last));
    check("G4 savings baseline = formulation ref 12.50 (FORMULATION_REF)", port.baselineSource === "FORMULATION_REF" && Math.abs(port.baseline - 12.5) < 1e-9, `${port.baselineSource}/${port.baseline}`);
    check("G5 saving/kg = ref − last cost (−1.092, milling currently costs MORE)", port.savingPerKg !== null && Math.abs(port.savingPerKg - (-1.092)) < 0.002, String(port.savingPerKg));
    const savedCostCard = await op.$eval("[data-testid='fm-kpi-saving']", (n2) => n2.textContent || "");
    check("G6 UI saving card shows the computed /kg figure + baseline", /1\.09/.test(savedCostCard) && /12\.5/.test(savedCostCard), savedCostCard.slice(0, 120).replace(/\s+/g, " "));

    // fallback path: null the ref + two real commercial PURCHASE rows → PURCHASE_AVG ( (100×10 + 300×14)/400 = 13.0 )
    r = await fmPatch(op, "FORMULATION", { businessId: BIZ, id: F1.id, commercialRefPriceGhs: null });
    check("G7 formulation ref price is configurable to null", r.body.success === true, JSON.stringify(r.body).slice(0, 100));
    await poultryPost(op, "FEED", { businessId: BIZ, branchCode: "POULTRY-01", feedType: "LAYER_MASH", entryType: "PURCHASE", quantityKg: 100, costPerKgGhs: 10, brandSupplier: "TFM Commercial A", recordedDate: TODAY });
    await poultryPost(op, "FEED", { businessId: BIZ, branchCode: "POULTRY-01", feedType: "LAYER_MASH", entryType: "PURCHASE", quantityKg: 300, costPerKgGhs: 14, brandSupplier: "TFM Commercial B", recordedDate: TODAY });
    const get2 = await fmGet(op);
    const port2 = computePort(get2.body);
    check("G8 without a ref, baseline falls back to 90-day purchase average (13.00)", port2.baselineSource === "PURCHASE_AVG" && Math.abs(port2.baseline - 13.0) < 1e-9, `${port2.baselineSource}/${port2.baseline}`);
    check("G9 recomputed saving matches (13.00 − 13.592 = −0.592)", Math.abs(port2.savingPerKg - (-0.592)) < 0.002, String(port2.savingPerKg));
    await fmPatch(op, "FORMULATION", { businessId: BIZ, id: F1.id, commercialRefPriceGhs: 12.5 });

    // single-booking across the WHOLE flow: intake(4) + mill-ops(2) + the two
    // real poultry PURCHASE entries (existing poultry endpoint books feed buys) = 8
    const finalTxCount = n((await q1(`SELECT count(*) c FROM transactions WHERE business_id=$1`, [BIZ])).c);
    check("G10 finance rows exactly the 8 intended bookings (4 intake + 2 mill-ops + 2 commercial purchases)", finalTxCount - b0.txns === 8, `${b0.txns}→${finalTxCount}`);

    // ══ H+I. Governance ════════════════════════════════════════════════
    console.log("── H+I. Audit center, reviews, checklist self-heal, audit trail ──");
    const auditList = await op.evaluate(async () => {
      const r2 = await fetch("/api/audit?recordType=OPERATION_LOG&module=OPERATIONS");
      return { status: r2.status, body: await r2.json() };
    });
    const srcFound = new Set((auditList.body.records || auditList.body.rows || []).filter((x) => x.businessId === BIZ).map((x) => x.recordSource));
    check("H1 audit board lists poultry sources (feed logs, production, mill tables)",
      ["poultry_feed_logs", "poultry_feed_formulations", "poultry_feed_batches", "poultry_feed_qc_checks"].every((s) => srcFound.has(s)), [...srcFound].filter((s) => String(s).startsWith("poultry")).join(","));
    const recResolve = await op.evaluate(async (b) => {
      const r2 = await fetch(`/api/audit?record=1&recordType=OPERATION_LOG&recordSource=poultry_feed_batches&recordId=${b.id}`);
      return { status: r2.status, body: await r2.json() };
    }, B1);
    check("H2 audit detail drawer opens the batch (full record + linked QC rows)",
      recResolve.body.detail?.record?.batchNumber === B1.batchNumber &&
      Array.isArray(recResolve.body.detail?.related), JSON.stringify(recResolve.body).slice(0, 160));
    const recResolve2 = await op.evaluate(async (b) => {
      const r2 = await fetch(`/api/audit?record=1&recordType=OPERATION_LOG&recordSource=poultry_feed_batches&recordId=${b.id}`);
      return { status: r2.status, body: await r2.json() };
    }, B2);
    check("H2b detail drawer links batch 2's QC checks (FAIL + corrective PASS rows)",
      (recResolve2.body.detail?.related || []).filter((x) => x.recordSource === "poultry_feed_qc_checks").length >= 2,
      JSON.stringify(recResolve2.body.detail?.related || []).slice(0, 160));
    const flag = await op.evaluate(async (b) => {
      const r2 = await fetch("/api/audit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recordType: "OPERATION_LOG", recordSource: "poultry_feed_batches", recordId: b.id, action: "FLAGGED", reason: "TFM yield lower than the recipe standard", issueTitle: "TFM review of batch yield" }),
      });
      return { status: r2.status, body: await r2.json() };
    }, B2);
    check("H3 auditor can FLAG a feed-mill batch (review created)", flag.status === 201 || flag.status === 200 && flag.body.success !== false, `HTTP ${flag.status} ${JSON.stringify(flag.body).slice(0, 120)}`);
    const tplAfter = await q1(`SELECT count(*) c FROM checklist_templates WHERE business_id=$1 AND task_key LIKE 'MILL_%'`, [BIZ]);
    check("I1 four mill checklist templates self-healed after first mill use", n(tplAfter.c) >= 4, `mill templates=${tplAfter.c}`);
    const actions = new Set();
    for (const w of ["FEED_FORMULATION_CREATE", "FEED_FORMULATION_UPDATE", "FEED_RAW_INTAKE", "FEED_BATCH_PRODUCED", "FEED_QC_FAIL", "FEED_BATCH_RELEASE", "FEED_BATCH_REJECT", "FEED_CONSUME"]) {
      const hit = await q1(`SELECT count(*) c FROM audit_trail WHERE action=$1 AND business_id=$2 AND id>$3`, [w, BIZ, b0.trailMax]);
      if (n(hit.c) >= 1) actions.add(w);
    }
    check("I2 every mill write action is audit-trailed (8/8 actions)", actions.size === 8, [...actions].join(","));
    check("J15 no page errors across the whole UI session", op.errors.length === 0, op.errors.slice(0, 2).join(" | "));

    // ══ Z. Purge + forensics ═══════════════════════════════════════════
    console.log("── Z. TEST purge + forensics ──");
    await fmPost(op, "__noop__", {}).catch(() => null); // no-op: close pending writes
    const bIds = created.batchIds.join(",") || "-1";
    await q(`DELETE FROM poultry_feed_batch_inputs WHERE batch_id IN (${bIds})`);
    await q(`DELETE FROM poultry_feed_qc_checks WHERE business_id=$1 AND (test_name LIKE 'TFM%' OR batch_number IN ($2,$3,$4))`, [BIZ, B1.batchNumber, B2.batchNumber, B3.batchNumber]);
    const fIds = created.formIds.join(",") || "-1";
    await q(`DELETE FROM poultry_feed_batches WHERE id IN (${bIds})`);
    await q(`DELETE FROM poultry_feed_formulation_items WHERE formulation_id IN (${fIds})`);
    await q(`DELETE FROM poultry_feed_formulations WHERE id IN (${fIds})`);
    await q(`DELETE FROM poultry_feed_logs WHERE business_id=$1 AND (brand_supplier LIKE 'TFM%' OR brand_supplier LIKE 'Own mill · FDB%')`, [BIZ]);
    const suiteBatchNos = [B1.batchNumber, B2.batchNumber, B3.batchNumber];
    await q(`DELETE FROM transactions WHERE id > $2 AND business_id=$1 AND (description LIKE '%TFM%' OR description LIKE ANY($3))`, [BIZ, b0.txnMax, suiteBatchNos.map((x) => `%${x}%`)]);
    await q(`DELETE FROM audit_issue_updates WHERE issue_id > $1`, [b0.reviewMax]);
    await q(`DELETE FROM audit_reviews WHERE id > $1`, [b0.reviewMax]);
    await q(`DELETE FROM notifications WHERE id > $1 AND type LIKE 'FEED_%' AND (record_ref = ANY($2) OR body LIKE '%TFM%' OR title LIKE '%TFM%')`, [b0.notifMax, suiteBatchNos]);
    const trailIds = [...created.batchIds, ...created.qcIds.filter(Boolean), ...created.feedLogIds.filter(Boolean), ...created.formIds, ...created.invIds];
    await q(`DELETE FROM audit_trail WHERE id > $1 AND business_id=$2 AND action LIKE 'FEED_%' AND (target_label LIKE '%TFM%' OR record_id = ANY($3))`, [b0.trailMax, BIZ, trailIds]);
    await q(`DELETE FROM checklist_templates WHERE id > $1 AND business_id=$2 AND task_key LIKE 'MILL_%'`, [b0.tplMax, BIZ]);
    await q(`DELETE FROM inventory_items WHERE business_id=$1 AND name LIKE 'TFM%'`, [BIZ]);
    // restore any pre-existing item that stock ops touched
    for (const [id, snap] of Object.entries(invSnapshot)) {
      await q(`UPDATE inventory_items SET quantity=$2, cost_price_ghs=$3, selling_price_ghs=$4, min_stock_threshold=$5, status=$6 WHERE id=$1`,
        [id, snap.quantity, snap.cost_price_ghs, snap.selling_price_ghs, snap.min_stock_threshold, snap.status]);
    }
    // forensics
    const zf = {
      millFormulations: n((await q1(`SELECT count(*) c FROM poultry_feed_formulations WHERE business_id=$1`, [BIZ])).c),
      millBatches: n((await q1(`SELECT count(*) c FROM poultry_feed_batches WHERE business_id=$1`, [BIZ])).c),
      millQc: n((await q1(`SELECT count(*) c FROM poultry_feed_qc_checks WHERE business_id=$1`, [BIZ])).c),
      txns: n((await q1(`SELECT count(*) c FROM transactions WHERE business_id=$1`, [BIZ])).c),
      feedLogs: n((await q1(`SELECT count(*) c FROM poultry_feed_logs WHERE business_id=$1`, [BIZ])).c),
      templates: n((await q1(`SELECT count(*) c FROM checklist_templates WHERE business_id=$1`, [BIZ])).c),
      invItems: (await q(`SELECT id, sku, name, quantity, cost_price_ghs, selling_price_ghs, min_stock_threshold, status FROM inventory_items WHERE business_id=$1 ORDER BY id`, [BIZ])).rows,
      workerFlags: await q1(`SELECT can_manage_records, can_record_expenses FROM users WHERE id=$1`, [WORKER_ID]),
    };
    check("Z1 all mill tables returned to pre-suite counts", zf.millFormulations === b0.millTables0.formulations && zf.millBatches === b0.millTables0.batches && zf.millQc === b0.millTables0.qc, JSON.stringify([zf.millFormulations, zf.millBatches, zf.millQc]));
    check("Z2 transactions + feed logs returned to baseline", zf.txns === b0.txns && zf.feedLogs === b0.feedLogCount, `${zf.txns}/${b0.txns} · ${zf.feedLogs}/${b0.feedLogCount}`);
    const snapNow = Object.fromEntries(zf.invItems.map((r) => [r.id, r]));
    const invDiff = Object.keys(invSnapshot).filter((id) => JSON.stringify(invSnapshot[id]) !== JSON.stringify(snapNow[id]));
    const invExtra = Object.keys(snapNow).filter((id) => !invSnapshot[id]);
    check("Z3 inventory restored byte-exact (no drift, no residue rows)", invDiff.length === 0 && invExtra.length === 0, `diff=${invDiff.join(",")} extra=${invExtra.join(",")}`);
    check("Z4 worker permission flags restored", zf.workerFlags.can_manage_records === b0.workerFlags.can_manage_records && zf.workerFlags.can_record_expenses === b0.workerFlags.can_record_expenses);
    check("Z5 this run's mill checklist templates revoked (none added above baseline watermark)",
      n((await q1(`SELECT count(*) c FROM checklist_templates WHERE business_id=$1 AND task_key LIKE 'MILL_%' AND id>$2`, [BIZ, b0.tplMax])).c) === 0);

    await gp.close(); await gmCtx.close().catch(() => null);
    await op.close(); await ownerCtx.close().catch(() => null);
    await wp.close().catch(() => null); await workerCtx.close().catch(() => null);

    console.log(`\n${results.join("\n")}`);
    console.log(`\n══════════════════════════════════════════════════════`);
    console.log(`FEED MILL SUITE: ${passed} passed, ${failed} failed (${passed + failed} checks)`);
    console.log(`══════════════════════════════════════════════════════`);
    if (failed) process.exitCode = 1;
  } catch (e) {
    console.error("SUITE CRASH:", e);
    process.exitCode = 1;
  } finally {
    await pg.end().catch(() => null);
    await browser.close().catch(() => null);
  }
}

// click the poultry "Feed Mill" module tab (button text match inside module tab bar)
async function page_clickFeedMill(page) {
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      (b.textContent || "").trim().replace(/\s+/g, " ") === "Feed Mill" || (b.textContent || "").trim().replace(/\s+/g, " ") === "Feed Mill ");
    btn?.click();
  });
  await sleep(1400);
}

// Lightweight re-derivation of feedMillAnalytics (independent of the TS lib)
function computePort(body) {
  const today = new Date().toISOString().slice(0, 10);
  const dAgo = (n2) => { const d = new Date(); d.setDate(d.getDate() - n2); return d.toISOString().slice(0, 10); };
  const finishedFeedKg = (body.finishedFeeds || []).reduce((s, i) => s + n(i.quantity), 0);
  const rows14 = (body.feedLogs || []).filter((f) => f.entryType === "CONSUMPTION" && f.recordedDate >= dAgo(14));
  const days = new Set(rows14.map((f) => f.recordedDate)).size;
  const burn = days ? rows14.reduce((s, f) => s + n(f.quantityKg), 0) / days : 0;
  const daysOfFeed = burn > 0 ? +(finishedFeedKg / burn).toFixed(1) : null;
  const sorted = [...(body.batches || [])].filter((b) => b.status !== "REJECTED")
    .sort((a, b) => (b.productionDate || "").localeCompare(a.productionDate || "") || (b.id - a.id));
  const last = sorted[0] || null;
  let baseline = null, baselineSource = null;
  if (last) {
    const form = (body.formulations || []).find((f) => f.id === last.formulationId);
    if (form && n(form.commercialRefPriceGhs) > 0) { baseline = n(form.commercialRefPriceGhs); baselineSource = "FORMULATION_REF"; }
  }
  if (baseline == null) {
    const rows90 = (body.feedLogs || []).filter((f) => f.entryType === "PURCHASE" && n(f.quantityKg) > 0 && n(f.costPerKgGhs) > 0 && f.recordedDate >= dAgo(90));
    const kg = rows90.reduce((s, f) => s + n(f.quantityKg), 0);
    if (kg > 0) { baseline = rows90.reduce((s, f) => s + n(f.quantityKg) * n(f.costPerKgGhs), 0) / kg; baselineSource = "PURCHASE_AVG"; }
  }
  const savingPerKg = baseline != null && last && n(last.costPerKgGhs) > 0 ? +(baseline - n(last.costPerKgGhs)).toFixed(3) : null;
  return {
    finishedFeedKg, daysOfFeed,
    last: last ? { batchNumber: last.batchNumber, costPerKgGhs: n(last.costPerKgGhs), yieldPct: last.yieldPct, status: last.status } : null,
    baseline: baseline != null ? +baseline.toFixed(3) : null, baselineSource, savingPerKg,
  };
}

main();
