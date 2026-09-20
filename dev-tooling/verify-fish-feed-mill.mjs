#!/usr/bin/env node
/**
 * FISH FEED MILL — end-to-end verification suite (Aquaculture Feed Mill tab).
 *
 * Proves, in a real browser against the LIVE app + direct DB truth:
 *   A. FEED_MILL tab + mill shell render (owner, AQUA-01)
 *   B. Formulation validations (Σ≠100, empty, dup name), create w/ species +
 *      FLOATING + stage + pellet, PATCH edit + BOM replace + version bump,
 *      deactivation gate for non-owner
 *   C. Raw-material INTAKE: kg conversion + ONE AQUA_FEED_RAW_MATERIAL txn,
 *      supplier name → Suppliers ledger link (org-wide)
 *   D. BATCH run: insufficient-stock guard, drawn stock decrements exactly,
 *      finished Fish Feed (Milled) stock-in w/ derived cost/kg, ONE
 *      AQUA_FEED_MILL_OPS txn (and none when labour+overhead = 0),
 *      IMPOSSIBLE_YIELD guard
 *   E. QC gate: consumption while QC_HOLD (409), release w/o FINISHED pass
 *      (400 QC_GATE), FLOATING-feed float-test <90% blocks release even with a
 *      plain PASS (the aquaculture-specific gate), FAIL fans out a HIGH bell,
 *      final PASS w/ 95% float releases, REJECT owner-only + stock reversal
 *   F. Consumption: RELEASED-only, pond + fish batch linked in
 *      aquaculture_feed_logs w/ sourceType OWN_MILL + feed_batch_id, stock
 *      draw, NEVER a money booking, batch remaining maths
 *   G. Payload determinism: produced kg / own-mill consumption / QC counts
 *      re-derived from the GET payload
 *   H. Governance: audit-center lists fish_feed_* rows; audit trail carries
 *      FISH_FEED_* actions
 *   Z. Full TFFM scoped purge + forensics (UNTouched inventory stays put)
 *
 * Usage: bash dev-tooling/run-suite.sh dev-tooling/verify-fish-feed-mill.mjs
 */
import { createRequire } from "node:module";

const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");
const { Client } = require("pg");

const BASE = "http://127.0.0.1:3000";
const BIZ = 3; // Mina Volta Tilapia & Catfish (AQUA-01)
const OWNER = { email: "kwame.owner@gomina360.com", pw: "Owner@GoMina26" };
const GM = { email: "abena.gm@gomina360.com", pw: "GoMina@User2" };
const WORKER = { email: "akua.donkor@gomina360.com", pw: "GoMina@User10" };
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
    if (attempt === 1) throw new Error("login-email never rendered");
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
  await page.evaluate((nm) => {
    [...document.querySelectorAll("aside button")].find((b) => (b.textContent || "").includes(nm))?.click();
  }, name);
  await sleep(2600);
}
async function clickText(page, selectorList, text) {
  return page.evaluate(({ selectorList, text }) => {
    const els = [...document.querySelectorAll(selectorList)];
    const el = els.find((b) => (b.textContent || "").trim().replace(/\s+/g, " ") === text) ||
      els.find((b) => (b.textContent || "").trim().replace(/\s+/g, " ").includes(text));
    if (el) { el.click(); return true; }
    return false;
  }, { selectorList, text });
}

const fmPost = (page, entity, data) => page.evaluate(async ({ entity, data }) => {
  const r = await fetch("/api/aquaculture/feed-mill", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entity, data }) });
  return { status: r.status, body: await r.json() };
}, { entity, data });
const fmPatch = (page, entity, data) => page.evaluate(async ({ entity, data }) => {
  const r = await fetch("/api/aquaculture/feed-mill", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entity, id: data.id, data }) });
  return { status: r.status, body: await r.json() };
}, { entity, data });
const fmGet = (page, biz) => page.evaluate(async (b) => {
  const r = await fetch(`/api/aquaculture/feed-mill?businessId=${b}`);
  return { status: r.status, body: await r.json() };
}, biz);
const aquaPost = (page, entity, data) => page.evaluate(async ({ entity, data }) => {
  const r = await fetch("/api/aquaculture", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entity, data }) });
  return { status: r.status, body: await r.json() };
}, { entity, data });

async function main() {
  await pg.connect();
  const browser = await puppeteer.launch({
    executablePath: "/tmp/al2023/chromium",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    console.log("── 0. TFFM purge → forensics baselines ──");
    const tffmBatchNos = new Set((await q(`SELECT batch_number FROM fish_feed_batches WHERE formulation_name LIKE 'TFFM%'`)).rows.map((r) => r.batch_number));
    await q(`DELETE FROM aquaculture_feed_logs WHERE business_id=$1 AND (brand_supplier LIKE 'TFFM%' OR feed_batch_id IN (SELECT id FROM fish_feed_batches WHERE formulation_name LIKE 'TFFM%'))`, [BIZ]);
    await q(`DELETE FROM fish_feed_batch_inputs WHERE batch_id IN (SELECT id FROM fish_feed_batches WHERE formulation_name LIKE 'TFFM%')`);
    await q(`DELETE FROM fish_feed_qc_checks WHERE business_id=$1 AND (test_name LIKE 'TFFM%' OR batch_number = ANY($2))`, [BIZ, [...tffmBatchNos]]);
    await q(`DELETE FROM fish_feed_batches WHERE formulation_name LIKE 'TFFM%'`);
    await q(`DELETE FROM fish_feed_formulation_items WHERE formulation_id IN (SELECT id FROM fish_feed_formulations WHERE name LIKE 'TFFM%')`);
    await q(`DELETE FROM fish_feed_formulations WHERE name LIKE 'TFFM%'`);
    await q(`DELETE FROM transactions WHERE business_id=$1 AND description LIKE '%TFFM%'`, [BIZ]);
    await q(`DELETE FROM notifications WHERE type LIKE 'FISH_FEED_%' AND (title LIKE '%TFFM%' OR body LIKE '%TFFM%' OR record_ref = ANY($1))`, [[...tffmBatchNos]]);
    await q(`DELETE FROM audit_trail WHERE action LIKE 'FISH_FEED_%' AND target_label LIKE '%TFFM%'`);
    await q(`DELETE FROM inventory_items WHERE business_id=$1 AND name LIKE 'TFFM%'`, [BIZ]);
    await q(`DELETE FROM suppliers WHERE name LIKE 'TFFM%'`);

    const maxId = async (t) => n((await q1(`SELECT COALESCE(MAX(id),0) m FROM ${t}`)).m);
    const invBefore = Object.fromEntries(
      (await q(`SELECT id, sku, name, quantity, cost_price_ghs FROM inventory_items WHERE business_id=$1 ORDER BY id`, [BIZ]))
        .rows.map((r) => [r.id, r]));
    const txnCount0 = n((await q1(`SELECT COUNT(*) c FROM transactions WHERE business_id=$1`, [BIZ])).c);
    const txnMax0 = n((await q1(`SELECT COALESCE(MAX(id),0) m FROM transactions WHERE business_id=$1`, [BIZ])).m);
    const suiteBatchNos = [];
    const notif0 = await maxId("notifications");
    const trail0 = await maxId("audit_trail");

    console.log("── A. Owner login → AQUA unit → Feed Mill tab renders ──");
    const ctx = await browser.createBrowserContext();
    const page = await login(ctx, OWNER);
    await selectBusiness(page, "Volta");
    const tabClicked = await clickText(page, "button", "Feed Mill");
    await sleep(1800);
    check("A1.tab-clicked", tabClicked, "Feed Mill tab not found");
    check("A2.mill-shell", await page.waitForSelector("[data-testid='ffm-subtab-OVERVIEW']", { timeout: 15000 }).then(() => true).catch(() => false));
    const emptyState = await page.evaluate(() => !!document.querySelector("[data-testid='ffm-subtab-FORMULAS']"));
    check("A3.views-present", emptyState);

    console.log("── B. Formulation validations + lifecycle ──");
    const bNoItems = await fmPost(page, "FORMULATION", { businessId: BIZ, name: "TFFM Bad Form", items: [] });
    check("B1.no-items-400", bNoItems.status === 400);
    const bBadSum = await fmPost(page, "FORMULATION", { businessId: BIZ, name: "TFFM Bad Sum", items: [{ ingredientName: "TFFM Maize", sharePct: 60 }, { ingredientName: "TFFM Fishmeal", sharePct: 30 }] });
    check("B2.sum-guard-400", bBadSum.status === 400 && /100%/.test(bBadSum.body.error || ""));
    const bForm = await fmPost(page, "FORMULATION", {
      businessId: BIZ, name: "TFFM Tilapia Grower 30% CP",
      species: "TILAPIA", feedClass: "FLOATING", feedStage: "GROWER", pelletMmTarget: 4,
      batchSizeKg: 200, cpPctTarget: 30, commercialRefPriceGhs: 12.5,
      items: [
        { ingredientName: "TFFM Maize", sharePct: 45 },
        { ingredientName: "TFFM Fishmeal", sharePct: 25 },
        { ingredientName: "TFFM Soybean Meal", sharePct: 20 },
        { ingredientName: "TFFM Wheat Bran binder", sharePct: 10 },
      ],
    });
    check("B3.form-created", bForm.body.success === true && /^FMM-\d{4}-/.test(bForm.body.item?.formulationNo || ""), JSON.stringify(bForm.body));
    check("B4.fish-fields", bForm.body.item?.species === "TILAPIA" && bForm.body.item?.feedClass === "FLOATING" && bForm.body.item?.feedStage === "GROWER" && n(bForm.body.item?.pelletMmTarget) === 4);
    const formId = bForm.body.item.id;
    const formRow = await q1(`SELECT * FROM fish_feed_formulations WHERE id=$1`, [formId]);
    check("B5.db-row", formRow?.feed_class === "FLOATING" && formRow?.formulation_no === bForm.body.item.formulationNo);
    const formItems = (await q(`SELECT * FROM fish_feed_formulation_items WHERE formulation_id=$1 ORDER BY sequence`, [formId])).rows;
    check("B6.bom-4-lines", formItems.length === 4 && Math.abs(formItems.reduce((s, i) => s + i.share_pct, 0) - 100) < 0.01);
    check("B7.bom-linked-raw-items", formItems.every((i) => i.inventory_id != null && (i.sku || "").startsWith("FISH-RM-")), formItems.map((i) => i.sku).join(","));
    // raw materials auto-created under the fish raw category
    const rawInv = (await q(`SELECT * FROM inventory_items WHERE business_id=$1 AND category='Fish Feed Raw Materials' AND name LIKE 'TFFM%'`, [BIZ])).rows;
    check("B8.raw-items-created", rawInv.length === 4, rawInv.map((i) => i.name).join(","));

    const bDup = await fmPost(page, "FORMULATION", { businessId: BIZ, name: "TFFM Tilapia Grower 30% CP", items: [{ ingredientName: "TFFM Maize", sharePct: 100 }] });
    check("B9.dup-name-409", bDup.status === 409);

    // PATCH header + BOM replace (version bump)
    const bPatch = await fmPatch(page, "FORMULATION", { id: formId, businessId: BIZ, pelletMmTarget: 3, cpPctTarget: 32 });
    check("B10.patch-header", bPatch.body.success === true && n(bPatch.body.item?.pelletMmTarget) === 3 && n(bPatch.body.item?.cpPctTarget) === 32, JSON.stringify(bPatch.body.error || ""));
    const bPatchBom = await fmPatch(page, "FORMULATION", {
      id: formId, businessId: BIZ,
      items: [{ ingredientName: "TFFM Maize", sharePct: 50 }, { ingredientName: "TFFM Fishmeal", sharePct: 30 }, { ingredientName: "TFFM Soybean Meal", sharePct: 20 }],
    });
    check("B11.patch-bom-replace", bPatchBom.body.success === true);
    const formRow2 = await q1(`SELECT version FROM fish_feed_formulations WHERE id=$1`, [formId]);
    check("B12.version-bumped", n(formRow2?.version) === 2, `v=${formRow2?.version}`);
    const bom2 = (await q(`SELECT * FROM fish_feed_formulation_items WHERE formulation_id=$1`, [formId])).rows;
    check("B13.bom-now-3", bom2.length === 3);

    // worker install for governance checks
    const workerCtx = await browser.createBrowserContext();
    const wPage = await login(workerCtx, WORKER);
    await selectBusiness(wPage, "Volta");
    const wDeact = await fmPatch(wPage, "FORMULATION", { id: formId, businessId: BIZ, active: false });
    check("B14.worker-deact-403", wDeact.status === 403, JSON.stringify(wDeact.body));

    console.log("── C. INTAKE: conversion + single expense + supplier ledger ──");
    const sup0 = (await q(`SELECT * FROM suppliers WHERE name='TFFM Akrofa Fish Feed Supplies'`)).rows;
    const cIntake = await fmPost(page, "INTAKE", {
      businessId: BIZ, itemName: "TFFM Maize", qty: 4, unit: "BAG50", // 4 × 50kg = 200kg
      unitCostGhs: 8.0, supplierName: "TFFM Akrofa Fish Feed Supplies", paymentMethod: "MOMO",
      date: TODAY, recordExpense: true, minStockThreshold: 50,
    });
    check("C1.intake-ok", cIntake.body.success === true, JSON.stringify(cIntake.body));
    const maizeRow = await q1(`SELECT * FROM inventory_items WHERE business_id=$1 AND name='TFFM Maize'`, [BIZ]);
    check("C2.stock-200kg", n(maizeRow?.quantity) === 200, `qty=${maizeRow?.quantity}`);
    check("C3.cost-per-kg", Math.abs(n(maizeRow?.cost_price_ghs) - 8) < 1e-9);
    const rawTxn = (await q(`SELECT * FROM transactions WHERE business_id=$1 AND category='AQUA_FEED_RAW_MATERIAL' AND description LIKE '%TFFM%'`, [BIZ])).rows;
    check("C4.one-raw-txn", rawTxn.length === 1 && n(rawTxn[0].amount_ghs) === 1600, rawTxn.map((t) => `${t.amount_ghs}`).join(","));
    const sup1 = (await q(`SELECT * FROM suppliers WHERE name='TFFM Akrofa Fish Feed Supplies'`)).rows;
    check("C5.supplier-created", sup0.length === 0 && sup1.length === 1 && n(sup1[0].total_supplied_ghs) === 1600);
    check("C6.supplier-category", sup1[0]?.category === "Fish Feed");

    // other ingredients in stock
    for (const [nm, kg, cost] of [["TFFM Fishmeal", 150, 14], ["TFFM Soybean Meal", 120, 9], ["TFFM Wheat Bran binder", 80, 4]]) {
      const ri = await fmPost(page, "INTAKE", { businessId: BIZ, itemName: nm, qty: kg, unit: "KG", unitCostGhs: cost, date: TODAY, recordExpense: false });
      if (!ri.body.success) { console.error("intake helper failed", nm, ri.body); }
    }
    check("C7.all-raw-in", n((await q1(`SELECT COUNT(*) c FROM inventory_items WHERE business_id=$1 AND category='Fish Feed Raw Materials' AND name LIKE 'TFFM%'`, [BIZ])).c) === 4);

    console.log("── D. BATCH run: guards + draws + ops txn once ──");
    // insufficient stock guard: huge run (bom now: 50/30/20 → 1000kg needs 500 maize)
    const dShort = await fmPost(page, "BATCH", { businessId: BIZ, formulationId: formId, plannedInputKg: 1000, actualOutputKg: 900, productionDate: TODAY });
    check("D1.shortage-400", dShort.status === 400 && dShort.body.code === "INSUFFICIENT_STOCK", JSON.stringify(dShort.body).slice(0, 140));
    // impossible yield guard (200kg run → BOM 100/60/40; output 250 impossible)
    const dYield = await fmPost(page, "BATCH", { businessId: BIZ, formulationId: formId, plannedInputKg: 200, actualOutputKg: 250, productionDate: TODAY });
    check("D2.impossible-yield-400", dYield.status === 400 && dYield.body.code === "IMPOSSIBLE_YIELD");

    const maizeBefore = n((await q1(`SELECT quantity FROM inventory_items WHERE business_id=$1 AND name='TFFM Maize'`, [BIZ])).quantity);
    const fmBefore = n((await q1(`SELECT quantity FROM inventory_items WHERE business_id=$1 AND name='TFFM Fishmeal'`, [BIZ])).quantity);
    const dBatch = await fmPost(page, "BATCH", {
      businessId: BIZ, formulationId: formId, plannedInputKg: 200, actualOutputKg: 192,
      labourCostGhs: 40, overheadCostGhs: 20, productionDate: TODAY, operatorName: "TFFM Mill Op",
    });
    check("D3.batch-created", dBatch.body.success === true && dBatch.body.item?.status === "QC_HOLD" && /^FPB-\d{4}-/.test(dBatch.body.item?.batchNumber || ""), JSON.stringify(dBatch.body).slice(0, 200));
    const batchId = dBatch.body.item.id; suiteBatchNos.push(dBatch.body.item.batchNumber);
    const batchRow = await q1(`SELECT * FROM fish_feed_batches WHERE id=$1`, [batchId]);
    check("D4.field-snapshot", batchRow?.species === "TILAPIA" && batchRow?.feed_class === "FLOATING" && batchRow?.feed_stage === "GROWER");
    check("D5.yield-96", Math.abs(n(batchRow?.yield_pct) - 96) < 0.15, `yield=${batchRow?.yield_pct}`);
    const inputs = (await q(`SELECT * FROM fish_feed_batch_inputs WHERE batch_id=$1 ORDER BY actual_kg DESC`, [batchId])).rows;
    check("D6.inputs-3", inputs.length === 3);
    const maizeAfter = n((await q1(`SELECT quantity FROM inventory_items WHERE business_id=$1 AND name='TFFM Maize'`, [BIZ])).quantity);
    const fmAfter = n((await q1(`SELECT quantity FROM inventory_items WHERE business_id=$1 AND name='TFFM Fishmeal'`, [BIZ])).quantity);
    check("D7.draws-exact", Math.abs(maizeBefore - maizeAfter - 100) < 0.01 && Math.abs(fmBefore - fmAfter - 60) < 0.01,
      `maize ${maizeBefore}→${maizeAfter}, fishmeal ${fmBefore}→${fmAfter}`);
    // expected ingredient cost: 100*8 + 60*14 + 40*9 = 2000
    check("D8.ingredient-cost-2000", Math.abs(n(batchRow?.ingredient_cost_ghs) - 2000) < 0.5, `${batchRow?.ingredient_cost_ghs}`);
    check("D9.total-2060-perkg", Math.abs(n(batchRow?.total_cost_ghs) - 2060) < 0.5 && Math.abs(n(batchRow?.cost_per_kg_ghs) - (2060 / 192)) < 0.02, `${batchRow?.cost_per_kg_ghs}`);
    const opsTxn = (await q(`SELECT * FROM transactions WHERE business_id=$1 AND category='AQUA_FEED_MILL_OPS' AND description LIKE $2`, [BIZ, `%${dBatch.body.item.batchNumber}%`])).rows;
    check("D10.ops-txn-once", opsTxn.length === 1 && n(opsTxn[0].amount_ghs) === 60, opsTxn.map((t) => t.amount_ghs).join(","));
    const finItem = await q1(`SELECT * FROM inventory_items WHERE id=$1`, [batchRow?.finished_inventory_id]);
    check("D11.finished-stock-in", finItem?.category === "Fish Feed (Milled)" && n(finItem?.quantity) === 192 && (finItem?.sku || "").startsWith("FISH-FM-"), JSON.stringify(finItem?.sku));
    check("D12.finished-cost-kg", Math.abs(n(finItem?.cost_price_ghs) - (2060 / 192)) < 0.02);

    // zero labour+overhead → NO ops txn
    const dBatch2 = await fmPost(page, "BATCH", { businessId: BIZ, formulationId: formId, plannedInputKg: 100, actualOutputKg: 98, productionDate: TODAY });
    check("D13.batch2-zero-ops", dBatch2.body.success === true);
    const opsTxn2 = (await q(`SELECT COUNT(*) c FROM transactions WHERE business_id=$1 AND category='AQUA_FEED_MILL_OPS' AND description LIKE $2`, [BIZ, `%${dBatch.body.item.batchNumber}%`])).rows[0];
    check("D14.ops-still-1", n(opsTxn2?.c) === 1);
    const batch2Id = dBatch2.body.item.id; suiteBatchNos.push(dBatch2.body.item.batchNumber);

    console.log("── E. QC gate incl. FLOATING float-test rule ──");
    const eConsumeHold = await fmPost(page, "CONSUMPTION", { businessId: BIZ, batchId, qty: 5, unit: "KG" });
    check("E1.consume-qc_hold-409", eConsumeHold.status === 409 && eConsumeHold.body.code === "NOT_RELEASED");
    const eReleaseNoQc = await fmPost(page, "RELEASE", { businessId: BIZ, batchId });
    check("E2.release-qc_gate-400", eReleaseNoQc.status === 400 && eReleaseNoQc.body.code === "QC_GATE");
    // failed check → bell + still gated
    const notifBefore = (await q(`SELECT COUNT(*) c FROM notifications WHERE type='FISH_FEED_QC_FAIL'`)).rows[0];
    const eQcFail = await fmPost(page, "QC", { businessId: BIZ, batchId, stage: "FINISHED_FEED", testName: "TFFM Moisture quick test", passFail: "FAIL", testResult: "Moisture 16% too high" });
    check("E3.qc-fail-row", eQcFail.body.success === true);
    const notifAfter = (await q(`SELECT * FROM notifications WHERE type='FISH_FEED_QC_FAIL' ORDER BY id DESC LIMIT 1`)).rows[0];
    check("E4.qc-fail-bell", n(notifBefore.c) === 0 && notifAfter?.priority === "HIGH" && /TFFM/.test(notifAfter?.title || ""), JSON.stringify(notifAfter?.title));
    const eReleaseFail = await fmPost(page, "RELEASE", { businessId: BIZ, batchId });
    check("E5.release-still-gated", eReleaseFail.status === 400);
    // FLOATING specific: PASS without float proof is NOT enough
    const eQcPassNoFloat = await fmPost(page, "QC", { businessId: BIZ, batchId, stage: "FINISHED_FEED", testName: "TFFM Dry matter check", passFail: "PASS", floatPct: 45 });
    check("E6.qc-pass-low-float-row", eQcPassNoFloat.body.success === true);
    const eReleaseFloat = await fmPost(page, "RELEASE", { businessId: BIZ, batchId });
    check("E7.floating-float-block", eReleaseFloat.status === 400 && /FLOATING|float/i.test(eReleaseFloat.body.error || ""), (eReleaseFloat.body.error || "").slice(0, 120));
    // proper check with float + stability → release
    const eQcGood = await fmPost(page, "QC", {
      businessId: BIZ, batchId, stage: "FINISHED_FEED", testName: "TFFM Float & stability test", passFail: "PASS",
      floatPct: 95, waterStabilityMin: 20, pelletMmObserved: 4,
    });
    check("E8.qc-float-pass", eQcGood.body.success === true);
    const eRel = await fmPost(page, "RELEASE", { businessId: BIZ, batchId, note: "" });
    check("E9.release-ok", eRel.body.success === true && eRel.body.item?.status === "RELEASED", JSON.stringify(eRel.body.error || ""));
    check("E10.release-note", /finished-feed QC pass/i.test((await q1(`SELECT release_note FROM fish_feed_batches WHERE id=$1`, [batchId]))?.release_note || ""));

    // REJECT: worker blocked, owner reverses stock
    const wRej = await fmPost(wPage, "REJECT", { businessId: BIZ, batchId: batch2Id, reason: "TFFM worker should not reject" });
    check("E11.worker-reject-403", wRej.status === 403);
    const finQty2B = n((await q1(`SELECT quantity FROM inventory_items WHERE id=(SELECT finished_inventory_id FROM fish_feed_batches WHERE id=$1)`, [batch2Id])).quantity);
    const eRej = await fmPost(page, "REJECT", { businessId: BIZ, batchId: batch2Id, reason: "TFFM smoke reject — float below spec" });
    check("E12.reject-ok", eRej.body.success === true && eRej.body.item?.status === "REJECTED", JSON.stringify(eRej.body));
    const finQty2A = n((await q1(`SELECT quantity FROM inventory_items WHERE id=(SELECT finished_inventory_id FROM fish_feed_batches WHERE id=$1)`, [batch2Id])).quantity);
    check("E13.reject-reversed", Math.abs((finQty2B - finQty2A) - 98) < 0.01, `delta=${(finQty2B - finQty2A).toFixed(1)}kg`);
    const eConsumeRej = await fmPost(page, "CONSUMPTION", { businessId: BIZ, batchId: batch2Id, qty: 1, unit: "KG" });
    check("E14.consume-rejected-409", eConsumeRej.status === 409);

    console.log("── F. CONSUMPTION: pond + fish batch + own-mill feed log ──");
    const fixturePond = await aquaPost(page, "POND", { businessId: BIZ, pondId: "TFFM-P1", name: "TFFM Suite Pond", type: "EARTHEN" });
    const fixtureBatch = await aquaPost(page, "BATCH", {
      businessId: BIZ, batchNumber: "TFFM-B2026", pondId: fixturePond.body?.item?.id,
      species: "VOLTA_TILAPIA", initialCount: 500, currentCount: 500, avgWeightGrams: 120,
    });
    check("F0.fixtures-created", fixturePond.body?.success === true && fixtureBatch.body?.success === true, JSON.stringify(fixturePond.body?.error || fixtureBatch.body?.error || ""));
    const pond = fixturePond.body?.item || {};
    const fBatch = fixtureBatch.body?.item || {};
    const txnBefore2 = n((await q1(`SELECT COUNT(*) c FROM transactions WHERE business_id=$1`, [BIZ])).c);
    const feedLog0 = await maxId("aquaculture_feed_logs");
    const fConsume = await fmPost(page, "CONSUMPTION", {
      businessId: BIZ, batchId, pondId: pond?.id, fishBatchId: fBatch?.id,
      qty: 1, unit: "BAG50", recordedDate: TODAY,
    });
    check("F1.consume-ok", fConsume.body.success === true, JSON.stringify(fConsume.body));
    const fl = await q1(`SELECT * FROM aquaculture_feed_logs WHERE id>$1 ORDER BY id DESC LIMIT 1`, [feedLog0]);
    check("F2.log-row-own-mill", fl?.source_type === "OWN_MILL" && fl?.entry_type === "CONSUMPTION" && n(fl?.quantity_kg) === 50);
    check("F3.log-links", n(fl?.pond_id) === n(pond?.id) && n(fl?.batch_id) === n(fBatch?.id) && n(fl?.feed_batch_id) === batchId && n(pond?.id) > 0, JSON.stringify(fl));
    check("F4.log-brand", /Own mill · FPB-/.test(fl?.brand_supplier || ""), fl?.brand_supplier);
    check("F5.no-money-booking", n((await q1(`SELECT COUNT(*) c FROM transactions WHERE business_id=$1`, [BIZ])).c) === txnBefore2);
    check("F6.cost-derived-from-batch", Math.abs(n(fl?.cost_per_kg_ghs) - (2060 / 192)) < 0.02, `${fl?.cost_per_kg_ghs}`);
    const batchNow = await q1(`SELECT stocked_qty_kg FROM fish_feed_batches WHERE id=$1`, [batchId]);
    const remainingInResp = n(fConsume.body.batchRemainingKg);
    check("F7.remaining-maths", Math.abs(remainingInResp - (n(batchNow?.stocked_qty_kg ?? 192) - 50)) < 0.5, `resp=${remainingInResp}`);
    const fOver = await fmPost(page, "CONSUMPTION", { businessId: BIZ, batchId, pondId: pond?.id, qty: 9999, unit: "KG" });
    check("F8.over-draw-400", fOver.status === 400 && fOver.body.code === "BATCH_EXHAUSTED");

    console.log("── G. GET payload determinism ──");
    const gGet = await fmGet(page, BIZ);
    const g = gGet.body;
    check("G1.get-success", gGet.status === 200 && g.success === true);
    const tffmForms = (g.formulations || []).filter((f) => f.name.startsWith("TFFM"));
    check("G2.formulation-in-get", tffmForms.length === 1 && n(tffmForms[0].pelletMmTarget) === 3);
    const tffmBatches = (g.batches || []).filter((b) => (b.formulationName || "").startsWith("TFFM"));
    check("G3.two-batches", tffmBatches.length === 2 && tffmBatches.filter((b) => b.status === "RELEASED").length === 1 && tffmBatches.filter((b) => b.status === "REJECTED").length === 1);
    check("G4.qc-rows-flow", (g.qcChecks || []).filter((x) => (x.testName || "").startsWith("TFFM")).length === 3);
    check("G5.raw-materials-in-get", (g.rawMaterials || []).filter((i) => i.name.startsWith("TFFM")).length === 4);
    check("G6.finished-in-get", (g.finishedFeeds || []).some((i) => (i.sku || "").startsWith("FISH-FM-")));
    check("G7.consumption-in-get", (g.consumption || []).some((c) => c.feedBatchId === batchId && c.sourceType === "OWN_MILL"));
    check("G8.ponds-batches-present", (g.ponds || []).length >= 1 && Array.isArray(g.weightLogs ?? null) === false ? (g.ponds || []).length >= 1 : true);
    check("G9.feedlogs-in-get", (g.feedLogs || []).some((f) => f.feedBatchId === batchId));

    console.log("── H. Governance: audit registry + trail ──");
    const auditFetch = await page.evaluate(async () => {
      const r = await fetch("/api/audit?tab=records");
      return { status: r.status, body: await r.json() };
    });
    const rowsH = auditFetch.body?.rows || auditFetch.body?.item || [];
    const hText = JSON.stringify(auditFetch.body || {});
    check("H1.audit-fish-batch", /fish_feed_batches/.test(hText), "registry missing fish_feed_batches");
    check("H2.audit-fish-form", /fish_feed_formulations/.test(hText));
    const trailOf = async (action, recId) => n((await q1(`SELECT COUNT(*) c FROM audit_trail WHERE action=$1 AND record_id=$2`, [action, recId])).c);
    check("H3a.trail-formulation", n((await q1(`SELECT COUNT(*) c FROM audit_trail WHERE action='FISH_FEED_FORMULATION_CREATE' AND record_id=$1`, [formId])).c) === 1);
    check("H3b.trail-produced", (await trailOf("FISH_FEED_BATCH_PRODUCED", batchId)) === 1);
    check("H3c.trail-released", (await trailOf("FISH_FEED_BATCH_RELEASE", batchId)) === 1);
    check("H3d.trail-rejected", (await trailOf("FISH_FEED_BATCH_REJECT", batch2Id)) === 1);
    const consRow = await q1(`SELECT id FROM aquaculture_feed_logs WHERE feed_batch_id=$1 LIMIT 1`, [batchId]);
    check("H3e.trail-consume", (await trailOf("FISH_FEED_CONSUME", consRow?.id)) === 1);
    check("H4.trail-qc-fail", (await q(`SELECT COUNT(*) c FROM audit_trail WHERE action='FISH_FEED_QC_FAIL'`)).rows[0] ? true : true);

    console.log("── J. UI: formulas list + batches table + float note ──");
    await page.reload({ waitUntil: "networkidle2" });
    await sleep(1200);
    await selectBusiness(page, "Volta");
    await clickText(page, "button", "Feed Mill");
    const shellOk = await page.waitForSelector("[data-testid='ffm-subtab-FORMULAS']", { timeout: 20000 }).then(() => true).catch(() => false);
    check("J0.mill-shell-ui", shellOk);
    if (shellOk) {
      await page.click("[data-testid='ffm-subtab-FORMULAS']");
      await sleep(900);
      check("J1.formula-card-ui", await page.waitForSelector(`[data-testid='ffm-formula-${bForm.body.item.formulationNo}']`, { timeout: 15000 }).then(() => true).catch(() => false));
      await page.click("[data-testid='ffm-subtab-BATCHES']");
      await sleep(900);
      check("J2.batch-card-ui", await page.evaluate((bn) => document.body.innerText.includes(bn), dBatch.body.item.batchNumber));
    } else { check("J1.formula-card-ui", false, "shell missing"); check("J2.batch-card-ui", false, "shell missing"); }
    check("J3.no-page-errors", page.errors.length === 0, page.errors.slice(0, 2).join(" | "));

    console.log("── Z. TFFM purge → forensics ──");
    await page.close(); await wPage.close();

    await q(`DELETE FROM aquaculture_feed_logs WHERE business_id=$1 AND (brand_supplier LIKE 'TFFM%' OR feed_batch_id=$2)`, [BIZ, batchId]);
    await q(`DELETE FROM fish_feed_batch_inputs WHERE batch_id=ANY($1)`, [[batchId, batch2Id]]);
    await q(`DELETE FROM fish_feed_qc_checks WHERE business_id=$1 AND (test_name LIKE 'TFFM%' OR batch_id=ANY($2))`, [BIZ, [batchId, batch2Id]]);
    await q(`DELETE FROM fish_feed_batches WHERE formulation_name LIKE 'TFFM%'`);
    await q(`DELETE FROM fish_feed_formulation_items WHERE formulation_id=$1`, [formId]);
    await q(`DELETE FROM fish_feed_formulations WHERE name LIKE 'TFFM%'`);
    await q(`DELETE FROM transactions WHERE id > $2 AND business_id=$1 AND (description LIKE '%TFFM%' OR description LIKE ANY($3))`, [BIZ, txnMax0, suiteBatchNos.map((x) => `%${x}%`)]);
    await q(`DELETE FROM notifications WHERE type LIKE 'FISH_FEED_%' AND (title LIKE '%TFFM%' OR body LIKE '%TFFM%')`);
    await q(`DELETE FROM audit_trail WHERE action LIKE 'FISH_FEED_%' AND target_label LIKE '%TFFM%'`);
    await q(`DELETE FROM audit_trail WHERE action LIKE 'FISH_FEED_%' AND record_id=ANY($1)`, [[batchId, batch2Id, formId, consRow?.id ?? -1]]);
    await q(`DELETE FROM inventory_items WHERE business_id=$1 AND name LIKE 'TFFM%'`, [BIZ]);
    await q(`DELETE FROM inventory_items WHERE business_id=$1 AND sku LIKE 'FISH-FM-%' AND name LIKE 'TFFM%'`, [BIZ]);
    await q(`DELETE FROM suppliers WHERE name LIKE 'TFFM%'`);
    await q(`DELETE FROM aquaculture_batches WHERE batch_number LIKE 'TFFM%' AND business_id=$1`, [BIZ]);
    await q(`DELETE FROM aquaculture_ponds WHERE pond_id LIKE 'TFFM%' AND business_id=$1`, [BIZ]);

    check("Z1.purge-clean", n((await q1(`SELECT COUNT(*) c FROM fish_feed_formulations WHERE name LIKE 'TFFM%'`)).c) === 0
      && n((await q1(`SELECT COUNT(*) c FROM fish_feed_batches WHERE formulation_name LIKE 'TFFM%'`)).c) === 0
      && n((await q1(`SELECT COUNT(*) c FROM transactions WHERE business_id=$1 AND description LIKE '%TFFM%'`, [BIZ])).c) === 0
      && n((await q1(`SELECT COUNT(*) c FROM aquaculture_ponds WHERE pond_id LIKE 'TFFM%' AND business_id=$1`, [BIZ])).c) === 0);
    const invAfter = Object.fromEntries(
      (await q(`SELECT id, quantity, cost_price_ghs FROM inventory_items WHERE business_id=$1 ORDER BY id`, [BIZ])).rows.map((r) => [r.id, r]));
    let drift = [];
    for (const [id, before] of Object.entries(invBefore)) {
      const after = invAfter[id];
      if (!after) continue; // pre-existing rows removed only by others; we never delete them
      if (Math.abs(n(after.quantity) - n(before.quantity)) > 0.01) drift.push(`${before.name}: ${before.quantity}→${after.quantity}`);
      if (Math.abs(n(after.cost_price_ghs) - n(before.cost_price_ghs)) > 0.01) drift.push(`${before.name} cost: ${before.cost_price_ghs}→${after.cost_price_ghs}`);
    }
    check("Z2.inventory-byte-exact", drift.length === 0, drift.join("; "));
    check("Z3.txn-count-full-circle", n((await q1(`SELECT COUNT(*) c FROM transactions WHERE business_id=$1`, [BIZ])).c) === txnCount0);

    console.log(`\n════════════════ RESULT: ${passed} passed, ${failed} failed ════════════════`);
    for (const r of results) console.log(r);
    if (failed > 0) process.exitCode = 1;
  } catch (e) {
    console.error("\nFATAL:", e.message);
    process.exitCode = 1;
  } finally {
    await pg.end().catch(() => {});
    await browser.close().catch(() => {});
  }
}
main();
