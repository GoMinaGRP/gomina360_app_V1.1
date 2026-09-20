#!/usr/bin/env node
/**
 * BLOCK MIXING — end-to-end verification suite (Block Factory "Mixing" tab).
 *
 * Proves, in a real browser against the LIVE app + direct DB truth:
 *   A. MIXING tab + shell render (owner, BLOCK-01)
 *   B. MIX_FORMULATION validations (Σ≠100, missing items, duplicate, bad
 *      block type), create w/ master-type binding, BOM auto-creates
 *      "Block Raw Materials" items, PATCH edit + BOM replace + deactivation
 *      gate for non-owner
 *   C. RESTOCK supplier integration: vendor name links org Suppliers ledger
 *      (existing RESTOCK entity — additive, no new intake path)
 *   D. MIX run: insufficient-stock guard, byte-exact raw draws, default
 *      output (materials+water mass), IMPOSSIBLE_YIELD guard, ONE
 *      BLOCK_MIX_OPS txn when labour+overhead > 0 and none at zero
 *   E. Release gate: production with QC_HOLD mix (409 MIX_NOT_RELEASED),
 *      release w/o MIXING PASS (400 QC_GATE), QC_CHECK at stage MIXING w/
 *      MXB number binds to mix batch (existing entity!), release → RELEASED
 *   F. Consumption: PRODUCTION with matching blockType consumes the mix 1:1
 *      (status CONSUMED + links), duplicate consumption refused (409),
 *      block-type mismatch refused (400)
 *   G. MIX_REJECT owner-only; recovery ON returns materials EXACTLY;
 *      DISCARDED variant leaves stock alone
 *   H. Governance: audit registry lists block_mix_* rows; audit trail
 *      carries BLOCK_MIX_* actions
 *   J. UI: recipe card + batch row render with status pills
 *   Z. Full TBM scoped purge + forensics (inventory byte-exact, txn count
 *      full-circle)
 *
 * Usage: bash dev-tooling/run-suite.sh dev-tooling/verify-block-mixing.mjs
 */
import { createRequire } from "node:module";

const require = createRequire("/home/user/pgtooling/package.json");
const puppeteer = require("puppeteer-core");
const { Client } = require("pg");

const BASE = "http://127.0.0.1:3000";
const BIZ = 2; // Mina Concrete & Blocks (BLOCK-01)
const OWNER = { email: "kwame.owner@gomina360.com", pw: "Owner@GoMina26" };
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

const blkPost = (page, entity, data) => page.evaluate(async ({ entity, data }) => {
  const r = await fetch("/api/block-factory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entity, data }) });
  return { status: r.status, body: await r.json() };
}, { entity, data });
const blkPatch = (page, entity, id, data) => page.evaluate(async ({ entity, id, data }) => {
  const r = await fetch("/api/block-factory", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entity, id, data }) });
  return { status: r.status, body: await r.json() };
}, { entity, id, data });
const blkGet = (page, biz) => page.evaluate(async (b) => {
  const r = await fetch(`/api/block-factory?businessId=${b}`);
  return { status: r.status, body: await r.json() };
}, biz);

async function main() {
  await pg.connect();
  const browser = await puppeteer.launch({
    executablePath: "/tmp/al2023/chromium",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    console.log("── 0. TBM purge → forensics baselines ──");
    const tbmMixNos = new Set((await q(`SELECT mix_batch_number FROM block_mix_batches WHERE formulation_name LIKE 'TBM%'`)).rows.map((r) => r.mix_batch_number));
    await q(`UPDATE block_factory_logs SET mix_batch_id=NULL WHERE business_id=$1 AND mix_batch_id IN (SELECT id FROM block_mix_batches WHERE formulation_name LIKE 'TBM%')`, [BIZ]);
    await q(`DELETE FROM block_factory_logs WHERE business_id=$1 AND batch_id LIKE 'TBM%'`, [BIZ]);
    await q(`DELETE FROM block_mix_batch_inputs WHERE mix_batch_id IN (SELECT id FROM block_mix_batches WHERE formulation_name LIKE 'TBM%')`);
    await q(`DELETE FROM block_mix_batches WHERE formulation_name LIKE 'TBM%'`);
    await q(`DELETE FROM block_mix_formulation_items WHERE formulation_id IN (SELECT id FROM block_mix_formulations WHERE name LIKE 'TBM%')`);
    await q(`DELETE FROM block_mix_formulations WHERE name LIKE 'TBM%'`);
    await q(`DELETE FROM block_qc_checks WHERE business_id=$1 AND (test_name LIKE 'TBM%' OR batch_id = ANY($2))`, [BIZ, [...tbmMixNos]]);
    await q(`DELETE FROM transactions WHERE business_id=$1 AND description LIKE '%TBM%'`, [BIZ]);
    await q(`DELETE FROM audit_trail WHERE action LIKE 'BLOCK_MIX_%' AND target_label LIKE '%TBM%'`);
    await q(`DELETE FROM inventory_items WHERE business_id=$1 AND name LIKE 'TBM%'`, [BIZ]);
    await q(`DELETE FROM block_types WHERE business_id=$1 AND type_key LIKE 'TBM%'`, [BIZ]);
    await q(`DELETE FROM suppliers WHERE name LIKE 'TBM%'`);

    const invBefore = Object.fromEntries(
      (await q(`SELECT id, sku, name, quantity, cost_price_ghs FROM inventory_items WHERE business_id=$1 ORDER BY id`, [BIZ]))
        .rows.map((r) => [r.id, r]));
    const txnCount0 = n((await q1(`SELECT COUNT(*) c FROM transactions WHERE business_id=$1`, [BIZ])).c);
    const txnMax0 = n((await q1(`SELECT COALESCE(MAX(id),0) m FROM transactions WHERE business_id=$1`, [BIZ])).m);
    const logsCount0 = n((await q1(`SELECT COUNT(*) c FROM block_factory_logs WHERE business_id=$1`, [BIZ])).c);
    const typesCount0 = n((await q1(`SELECT COUNT(*) c FROM block_types WHERE business_id=$1`, [BIZ])).c);
    const suiteMixNos = [];

    console.log("── A. Owner login → BLOCK unit → Mixing tab renders ──");
    const ownerCtx = await browser.createBrowserContext();
    const page = await login(ownerCtx, OWNER);
    await selectBusiness(page, "Concrete");
    await sleep(1800);
    // identity-first: the tab bar carries a stable testid per key (avoids matching
    // in-page buttons like "Release mix", "Run mixer", … that also say "Mix*")
    const tabClicked = await page.evaluate(() => {
      const el = document.querySelector("[data-testid='bf-tab-MIXING']");
      if (el) { el.click(); return true; }
      return false;
    });
    if (!tabClicked) {
      // fallback: click only inside nav/tab header containers
      await page.evaluate(() => {
        const navs = [...document.querySelectorAll("header button,[role='tab'],nav button")];
        const el = navs.find((b) => (b.textContent || "").trim().replace(/\s+/g, " ").toLowerCase() === "mixing");
        if (el) { el.click(); return true; }
      });
    }
    await sleep(2200);
    check("A1.tab-clicked", tabClicked, "Mixing tab not found");
    check("A2.mixing-shell", await page.waitForSelector("[data-testid='bmx-mixing']", { timeout: 15000 }).then(() => true).catch(() => false));
    check("A3.stats-present", await page.waitForSelector("[data-testid='bmx-stat-recipes']", { timeout: 10000 }).then(() => true).catch(() => false));
    check("A4.empty-state", await page.evaluate(() => !!document.querySelector("[data-testid='bmx-empty-recipes'],[data-testid='bmx-empty-batches']")));

    console.log("── B. MIX_FORMULATION validations + lifecycle ──");
    // fixture: block type in master list
    const mkType = await blkPost(page, "BLOCK_TYPE", { businessId: BIZ, name: "TBM 6in Test Blocks", dimensions: "440×215×150mm", style: "HOLLOW" });
    check("B0.type-fixture", mkType.body.success === true, JSON.stringify(mkType.body.error || ""));
    const typeKey = mkType.body.item?.typeKey;

    const bNoItems = await blkPost(page, "MIX_FORMULATION", { businessId: BIZ, name: "TBM Bad", blockType: typeKey, items: [] });
    check("B1.no-items-400", bNoItems.status === 400);
    const bBadSum = await blkPost(page, "MIX_FORMULATION", { businessId: BIZ, name: "TBM Bad Sum", blockType: typeKey, items: [{ ingredientName: "TBM Sharp Sand", sharePct: 70 }, { ingredientName: "TBM Cement", sharePct: 20 }] });
    check("B2.sum-guard-400", bBadSum.status === 400 && /100%/.test(bBadSum.body.error || ""));
    const bBadType = await blkPost(page, "MIX_FORMULATION", { businessId: BIZ, name: "TBM Bad Type", blockType: "DOES-NOT-EXIST", items: [{ ingredientName: "TBM Sharp Sand", sharePct: 100 }] });
    check("B3.unknown-type-400", bBadType.status === 400);
    const bForm = await blkPost(page, "MIX_FORMULATION", {
      businessId: BIZ, name: "TBM Sandcrete 1:8 Standard", blockType: typeKey,
      designNote: "1:8 sandcrete", waterCementRatio: 0.55, batchSizeKg: 800,
      items: [
        { ingredientName: "TBM Sharp Sand", sharePct: 80 },
        { ingredientName: "TBM Cement Loose", sharePct: 15 },
        { ingredientName: "TBM Stone Chips 6mm", sharePct: 5 },
      ],
    });
    check("B4.form-created", bForm.body.success === true && /^MIX-\d{4}-/.test(bForm.body.item?.formulationNo || ""), JSON.stringify(bForm.body).slice(0, 200));
    const formId = bForm.body.item.id;
    const formRow = await q1(`SELECT * FROM block_mix_formulations WHERE id=$1`, [formId]);
    check("B5.db-row", formRow?.block_type === typeKey && Math.abs(n(formRow?.water_cement_ratio) - 0.55) < 1e-9 && n(formRow?.batch_size_kg) === 800);
    const bomLines = (await q(`SELECT * FROM block_mix_formulation_items WHERE formulation_id=$1 ORDER BY sequence`, [formId])).rows;
    check("B6.bom-3-lines", bomLines.length === 3 && bomLines.every((l) => l.inventory_id != null && (l.sku || "").startsWith("BLK-RM-")), bomLines.map((l) => l.sku).join(","));
    const rawCats = (await q(`SELECT COUNT(*) c FROM inventory_items WHERE business_id=$1 AND category='Block Raw Materials' AND name LIKE 'TBM%'`, [BIZ])).rows[0];
    check("B7.raw-items-created", n(rawCats?.c) === 3);
    const bDup = await blkPost(page, "MIX_FORMULATION", { businessId: BIZ, name: "TBM Sandcrete 1:8 Standard", blockType: typeKey, items: [{ ingredientName: "TBM Sharp Sand", sharePct: 100 }] });
    check("B8.dup-name-409", bDup.status === 409);

    // PATCH: header + BOM replace; worker deactivation gate
    const bPatch = await blkPatch(page, "MIX_FORMULATION", formId, { waterCementRatio: 0.5, batchSizeKg: 600 });
    check("B9.patch-header", bPatch.body.success === true && Math.abs(n(bPatch.body.item?.waterCementRatio) - 0.5) < 1e-9 && n(bPatch.body.item?.batchSizeKg) === 600, JSON.stringify(bPatch.body.error || ""));
    const bPatchBom = await blkPatch(page, "MIX_FORMULATION", formId, {
      items: [{ ingredientName: "TBM Sharp Sand", sharePct: 85 }, { ingredientName: "TBM Cement Loose", sharePct: 15 }],
    });
    check("B10.patch-bom", bPatchBom.body.success === true);
    check("B11.bom-now-2", n((await q1(`SELECT COUNT(*) c FROM block_mix_formulation_items WHERE formulation_id=$1`, [formId])).c) === 2);
    const workerCtx = await browser.createBrowserContext();
    const wPage = await login(workerCtx, WORKER);
    await selectBusiness(wPage, "Concrete");
    const wDeact = await blkPatch(wPage, "MIX_FORMULATION", formId, { active: false });
    check("B12.worker-deact-403", wDeact.status === 403, JSON.stringify(wDeact.body));

    console.log("── C. RESTOCK: raw materials in, expense once, supplier ledger ──");
    const sup0 = (await q(`SELECT * FROM suppliers WHERE name='TBM Somanya Aggregate Depot'`)).rows;
    const txnBeforeR = n((await q1(`SELECT COUNT(*) c FROM transactions WHERE business_id=$1`, [BIZ])).c);
    // stock-in the three raw materials via existing RESTOCK entity
    const sandItem = await q1(`SELECT id FROM inventory_items WHERE business_id=$1 AND name='TBM Sharp Sand'`, [BIZ]);
    const cRestock = await blkPost(page, "RESTOCK", {
      businessId: BIZ, inventoryId: sandItem.id, quantity: 1200, unitCostGhs: 0.4,
      recordExpense: true, supplierName: "TBM Somanya Aggregate Depot", paymentMethod: "MOMO", date: TODAY,
    });
    check("C1.restock-ok", cRestock.body.success === true, JSON.stringify(cRestock.body).slice(0, 200));
    check("C2.expense-once", n(cRestock.body.expense?.amountGhs) === 480 && n((await q1(`SELECT COUNT(*) c FROM transactions WHERE business_id=$1`, [BIZ])).c) === txnBeforeR + 1);
    const sup1 = (await q(`SELECT * FROM suppliers WHERE name='TBM Somanya Aggregate Depot'`)).rows;
    check("C3.supplier-created", sup0.length === 0 && sup1.length === 1 && n(sup1[0].total_supplied_ghs) === 480, JSON.stringify(sup1));
    check("C4.supplier-category", sup1[0]?.category === "Cement & Aggregates");
    check("C5.stock-updated", n((await q1(`SELECT quantity FROM inventory_items WHERE id=$1`, [sandItem.id])).quantity) === 1200);
    const cementItem = await q1(`SELECT id, quantity FROM inventory_items WHERE business_id=$1 AND name='TBM Cement Loose'`, [BIZ]);
    const chipsItem = await q1(`SELECT id FROM inventory_items WHERE business_id=$1 AND name='TBM Stone Chips 6mm'`, [BIZ]);
    await blkPost(page, "RESTOCK", { businessId: BIZ, inventoryId: cementItem.id, quantity: 240, unitCostGhs: 2.2, recordExpense: false });
    await blkPost(page, "RESTOCK", { businessId: BIZ, inventoryId: chipsItem.id, quantity: 90, unitCostGhs: 0.35, recordExpense: false });

    console.log("── D. MIX run: guards + draws + ops txn once ──");
    const dShort = await blkPost(page, "MIX", { businessId: BIZ, formulationId: formId, plannedInputKg: 2400, actualOutputKg: 2300, productionDate: TODAY });
    check("D1.shortage-400", dShort.status === 400 && dShort.body.code === "INSUFFICIENT_STOCK", JSON.stringify(dShort.body).slice(0, 140));
    // BOM after patch: sand 85% / cement 15% — 600kg planned = 510 sand + 90 cement
    const sandBefore = n((await q1(`SELECT quantity FROM inventory_items WHERE id=$1`, [sandItem.id])).quantity);
    const cementBefore = n((await q1(`SELECT quantity FROM inventory_items WHERE id=$1`, [cementItem.id])).quantity);
    const txnBeforeMix = n((await q1(`SELECT COUNT(*) c FROM transactions WHERE business_id=$1`, [BIZ])).c);
    const dMix = await blkPost(page, "MIX", {
      businessId: BIZ, formulationId: formId, plannedInputKg: 600,
      waterLitresUsed: 50, slumpMm: 45,
      labourCostGhs: 25, overheadCostGhs: 15, productionDate: TODAY, operatorName: "TBM Mixer Lead",
    });
    check("D2.mix-created", dMix.body.success === true && dMix.body.item?.status === "QC_HOLD" && /^MXB-\d{4}-/.test(dMix.body.item?.mixBatchNumber || ""), JSON.stringify(dMix.body).slice(0, 200));
    const mixId = dMix.body.item.id; suiteMixNos.push(dMix.body.item.mixBatchNumber);
    const mixRow = await q1(`SELECT * FROM block_mix_batches WHERE id=$1`, [mixId]);
    check("D3.output-default", Math.abs(n(mixRow?.actual_output_kg) - 650) < 0.01, `${mixRow?.actual_output_kg}`); // 600 + 50L water
    check("D4.blocktype-snapshot", mixRow?.block_type === typeKey);
    check("D5.draws-exact", Math.abs(sandBefore - n((await q1(`SELECT quantity FROM inventory_items WHERE id=$1`, [sandItem.id])).quantity) - 510) < 0.01
      && Math.abs(cementBefore - n((await q1(`SELECT quantity FROM inventory_items WHERE id=$1`, [cementItem.id])).quantity) - 90) < 0.01);
    // cost: 510*0.4 + 90*2.2 = 204+198=402 ; +40 ops → 442 ; per kg 442/650
    check("D6.costs-derived", Math.abs(n(mixRow?.ingredient_cost_ghs) - 402) < 0.5 && Math.abs(n(mixRow?.total_cost_ghs) - 442) < 0.5 && Math.abs(n(mixRow?.cost_per_kg_ghs) - (442 / 650)) < 0.02,
      `${mixRow?.ingredient_cost_ghs}/${mixRow?.total_cost_ghs}/${mixRow?.cost_per_kg_ghs}`);
    const opsTxn = (await q(`SELECT * FROM transactions WHERE business_id=$1 AND category='BLOCK_MIX_OPS' AND description LIKE $2`, [BIZ, `%${mixRow.mix_batch_number}%`])).rows;
    check("D7.ops-txn-once", opsTxn.length === 1 && n(opsTxn[0].amount_ghs) === 40, opsTxn.map((t) => t.amount_ghs).join(","));
    check("D8.txn-only-one-more", n((await q1(`SELECT COUNT(*) c FROM transactions WHERE business_id=$1`, [BIZ])).c) === txnBeforeMix + 1);
    const mixInputs = (await q(`SELECT * FROM block_mix_batch_inputs WHERE mix_batch_id=$1`, [mixId])).rows;
    check("D9.inputs-ledger-2", mixInputs.length === 2 && mixInputs.every((i) => n(i.actual_kg) > 0));

    // impossible yield guard: output > input*1.03 refused before draws
    const sandBefore2 = n((await q1(`SELECT quantity FROM inventory_items WHERE id=$1`, [sandItem.id])).quantity);
    const dImposs = await blkPost(page, "MIX", { businessId: BIZ, formulationId: formId, plannedInputKg: 400, actualOutputKg: 480, waterLitresUsed: 0, productionDate: TODAY });
    check("D10.impossible-yield-400", dImposs.status === 400 && dImposs.body.code === "IMPOSSIBLE_YIELD", JSON.stringify(dImposs.body).slice(0, 140));
    check("D11.yield-no-draw", Math.abs(n((await q1(`SELECT quantity FROM inventory_items WHERE id=$1`, [sandItem.id])).quantity) - sandBefore2) < 0.01);

    // zero labour+overhead → NO ops txn (batch2 kept released later via owner override — tests rejection-free path too)
    const dMix2 = await blkPost(page, "MIX", { businessId: BIZ, formulationId: formId, plannedInputKg: 300, waterLitresUsed: 20, productionDate: TODAY });
    check("D12.mix2-zero-ops", dMix2.body.success === true);
    const opsTxn2 = (await q(`SELECT COUNT(*) c FROM transactions WHERE business_id=$1 AND category='BLOCK_MIX_OPS'`, [BIZ])).rows[0];
    check("D13.ops-still-1", n(opsTxn2?.c) === 1);
    const mix2Id = dMix2.body.item.id; suiteMixNos.push(dMix2.body.item.mixBatchNumber);

    console.log("── E. Release gate + MIXING-stage QC via existing entity ──");
    const eProdHold = await blkPost(page, "PRODUCTION", { businessId: BIZ, blockType: typeKey, mixBatchId: mixId, bagsCementUsed: 0, blocksMolded: 100, blocksBroken: 2 });
    check("E1.production-qc_hold-409", eProdHold.status === 409 && eProdHold.body.code === "MIX_NOT_RELEASED", JSON.stringify(eProdHold.body).slice(0, 140));
    const eRelNoQc = await blkPost(page, "MIX_RELEASE", { businessId: BIZ, mixBatchId: mixId });
    check("E2.release-qc_gate-400", eRelNoQc.status === 400 && eRelNoQc.body.code === "QC_GATE");
    // QC_CHECK against unknown mix batch refusals
    const eQcUnknown = await blkPost(page, "QC_CHECK", { businessId: BIZ, stage: "MIXING", batchId: "MXB-9999-NOPE", testName: "TBM Slump test", passFail: "PASS" });
    check("E3.qc-unknown-mix-404", eQcUnknown.status === 404);
    const eQc = await blkPost(page, "QC_CHECK", {
      businessId: BIZ, stage: "MIXING", batchId: mixRow.mix_batch_number,
      testName: "TBM Slump + uniformity check", passFail: "PASS", resultValue: 45, resultUnit: "mm",
    });
    check("E4.qc-mixing-pass-row", eQc.body.success === true, JSON.stringify(eQc.body.error || ""));
    const qcRow = await q1(`SELECT * FROM block_qc_checks WHERE business_id=$1 AND stage='MIXING' AND batch_id=$2`, [BIZ, mixRow.mix_batch_number]);
    check("E5.qc-bound-to-mix", qcRow?.block_type === typeKey, JSON.stringify(qcRow?.block_type));
    const eRel = await blkPost(page, "MIX_RELEASE", { businessId: BIZ, mixBatchId: mixId });
    check("E6.release-ok", eRel.body.success === true && eRel.body.item?.status === "RELEASED", JSON.stringify(eRel.body).slice(0, 140));
    check("E7.release-basis", /MIXING-stage QC pass/i.test((await q1(`SELECT release_note FROM block_mix_batches WHERE id=$1`, [mixId]))?.release_note || ""));

    // owner override path on mix2 (no PASS row)
    const trailBeforeOverride = n((await q1(`SELECT COUNT(*) c FROM audit_trail WHERE action='BLOCK_MIX_BATCH_RELEASE' AND record_id=$1`, [mix2Id])).c);
    const eOverride = await blkPost(page, "MIX_RELEASE", { businessId: BIZ, mixBatchId: mix2Id, note: "TBM site supervisor verbal OK — QC kit offline" });
    check("E8.owner-override-release", eOverride.body.success === true && /OWNER OVERRIDE/.test(eOverride.body.item?.releaseNote || ""), JSON.stringify(eOverride.body).slice(0, 200));
    check("E9.override-audited", n((await q1(`SELECT COUNT(*) c FROM audit_trail WHERE action='BLOCK_MIX_BATCH_RELEASE' AND record_id=$1`, [mix2Id])).c) === trailBeforeOverride + 1);

    console.log("── F. Consumption: production consumes mix 1:1 ──");
    const logsBefore = n((await q1(`SELECT COUNT(*) c FROM block_factory_logs WHERE business_id=$1`, [BIZ])).c);
    const eProd = await blkPost(page, "PRODUCTION", {
      businessId: BIZ, blockType: typeKey, mixBatchId: mixId,
      bagsCementUsed: 0, blocksMolded: 520, blocksBroken: 18, qualityGrade: "GRADE_A_STANDARD",
    });
    check("F1.production-ok", eProd.body.success === true, JSON.stringify(eProd.body).slice(0, 160));
    const logRow = await q1(`SELECT * FROM block_factory_logs WHERE business_id=$1 ORDER BY id DESC LIMIT 1`, [BIZ]);
    check("F2.log-linked", n(logRow?.mix_batch_id) === mixId, JSON.stringify(logRow?.mix_batch_id));
    const mixAfter = await q1(`SELECT * FROM block_mix_batches WHERE id=$1`, [mixId]);
    check("F3.mix-consumed", mixAfter?.status === "CONSUMED" && n(mixAfter?.consumed_production_log_id) === n(logRow?.id) && mixAfter?.consumed_production_batch === logRow?.batch_id,
      `${mixAfter?.status} / ${mixAfter?.consumed_production_batch}`);
    // finished blocks credited to stock (existing machinery untouched)
    const finBlk = await q1(`SELECT * FROM inventory_items WHERE business_id=$1 AND sku=$2`, [BIZ, `BLK-${typeKey}`]);
    check("F4.finished-credit-502", n(finBlk?.quantity) === 502, `${finBlk?.quantity}`);
    // duplicate consumption refused
    const eProdDup = await blkPost(page, "PRODUCTION", { businessId: BIZ, blockType: typeKey, mixBatchId: mixId, bagsCementUsed: 0, blocksMolded: 10, blocksBroken: 0 });
    check("F5.duplicate-consumed-409", eProdDup.status === 409 && eProdDup.body.code === "MIX_ALREADY_CONSUMED");
    // type mismatch refused
    const mkType2 = await blkPost(page, "BLOCK_TYPE", { businessId: BIZ, name: "TBM Other Size Blocks", dimensions: "1x1x1", style: "OTHER" });
    const eProdMis = await blkPost(page, "PRODUCTION", { businessId: BIZ, blockType: mkType2.body.item?.typeKey, mixBatchId: mix2Id, bagsCementUsed: 0, blocksMolded: 10, blocksBroken: 0 });
    check("F6.type-mismatch-400", eProdMis.status === 400 && eProdMis.body.code === "MIX_TYPE_MISMATCH", JSON.stringify(eProdMis.body).slice(0, 150));
    check("F7.log-count-net", n((await q1(`SELECT COUNT(*) c FROM block_factory_logs WHERE business_id=$1`, [BIZ])).c) === logsBefore + 1);

    console.log("── G. MIX_REJECT: owner-only + dry-draw recovery ──");
    // dedicated subject for the reject path (mix2 is RELEASED → terminal)
    const dMix3 = await blkPost(page, "MIX", { businessId: BIZ, formulationId: formId, plannedInputKg: 200, waterLitresUsed: 15, productionDate: TODAY });
    suiteMixNos.push(dMix3.body.item.mixBatchNumber);
    const mix3Id = dMix3.body.item.id;
    const wRej = await blkPost(wPage, "MIX_REJECT", { businessId: BIZ, mixBatchId: mix3Id, reason: "TBM worker should not reject" });
    check("G1.worker-reject-403", wRej.status === 403);
    const sandBeforeRej = n((await q1(`SELECT quantity FROM inventory_items WHERE id=$1`, [sandItem.id])).quantity);
    const cementBeforeRej = n((await q1(`SELECT quantity FROM inventory_items WHERE id=$1`, [cementItem.id])).quantity);
    // mix3 drew 0.85*200=170 sand + 30 cement at creation
    const gRej = await blkPost(page, "MIX_REJECT", { businessId: BIZ, mixBatchId: mix3Id, reason: "TBM power cut — mix never cured" });
    check("G2.reject-ok", gRej.body.success === true && gRej.body.item?.status === "REJECTED", JSON.stringify(gRej.body).slice(0, 160));
    check("G3.recover-exact", Math.abs(n((await q1(`SELECT quantity FROM inventory_items WHERE id=$1`, [sandItem.id])).quantity) - (sandBeforeRej + 170)) < 0.01
      && Math.abs(n((await q1(`SELECT quantity FROM inventory_items WHERE id=$1`, [cementItem.id])).quantity) - (cementBeforeRej + 30)) < 0.01);
    check("G4.recover-note", /recovered .* kg/.test((await q1(`SELECT release_note FROM block_mix_batches WHERE id=$1`, [mix3Id]))?.release_note || ""));
    // discarded path: fourth batch — rejected with materials discarded
    const dMix4 = await blkPost(page, "MIX", { businessId: BIZ, formulationId: formId, plannedInputKg: 200, waterLitresUsed: 15, productionDate: TODAY });
    suiteMixNos.push(dMix4.body.item.mixBatchNumber);
    const mix4Id = dMix4.body.item.id;
    const sandBeforeDis = n((await q1(`SELECT quantity FROM inventory_items WHERE id=$1`, [sandItem.id])).quantity);
    const gRejDis = await blkPost(page, "MIX_REJECT", { businessId: BIZ, mixBatchId: mix4Id, reason: "TBM wet mix spoiled", recoverMaterials: false });
    check("G5.discard-ok", gRejDis.body.success === true);
    check("G6.discard-no-recovery", Math.abs(n((await q1(`SELECT quantity FROM inventory_items WHERE id=$1`, [sandItem.id])).quantity) - sandBeforeDis) < 0.01);
    // terminal states immutable
    const eRelAgain = await blkPost(page, "MIX_RELEASE", { businessId: BIZ, mixBatchId: mix4Id, note: "TBM try release after reject" });
    check("G7.rejected-stays", eRelAgain.status === 400);

    console.log("── H. Governance: audit registry + trail ──");
    const auditFetch = await page.evaluate(async () => {
      const r = await fetch("/api/audit?tab=records");
      return { status: r.status, body: await r.json() };
    });
    const hText = JSON.stringify(auditFetch.body || {});
    check("H1.audit-mix-batch", /block_mix_batches/.test(hText), "registry missing block_mix_batches");
    check("H2.audit-mix-form", /block_mix_formulations/.test(hText));
    const trailOf = async (action, recId) => n((await q1(`SELECT COUNT(*) c FROM audit_trail WHERE action=$1 AND record_id=$2`, [action, recId])).c);
    check("H3a.trail-formulation", (await trailOf("BLOCK_MIX_FORMULATION_CREATE", formId)) === 1);
    check("H3b.trail-produced", (await trailOf("BLOCK_MIX_BATCH_PRODUCED", mixId)) === 1);
    check("H3c.trail-released", (await trailOf("BLOCK_MIX_BATCH_RELEASE", mixId)) === 1);
    check("H3d.trail-consumed", (await trailOf("BLOCK_MIX_CONSUMED", mixId)) === 1);
    check("H3e.trail-rejected", (await trailOf("BLOCK_MIX_BATCH_REJECT", mix3Id)) === 1 && (await trailOf("BLOCK_MIX_BATCH_REJECT", mix4Id)) === 1);

    console.log("── J. UI: recipe card + batch rows with status pills ──");
    await page.reload({ waitUntil: "networkidle2" });
    await sleep(1200);
    await selectBusiness(page, "Concrete");
    await page.evaluate(() => {
      const el = document.querySelector("[data-testid='bf-tab-MIXING']");
      if (el) el.click();
    });
    await sleep(2200);
    const shellOk = await page.waitForSelector("[data-testid='bmx-mixing']", { timeout: 20000 }).then(() => true).catch(() => false);
    check("J0.mixing-shell-ui", shellOk);
    if (shellOk) {
      check("J1.recipe-card-ui", await page.waitForSelector(`[data-testid='bmx-recipe-${bForm.body.item.formulationNo}']`, { timeout: 15000 }).then(() => true).catch(() => false));
      check("J2.batch-row-ui", await page.evaluate((bn) => document.body.innerText.includes(bn), suiteMixNos[0]));
      check("J3.status-pills", await page.evaluate(() => document.body.innerText.includes("RELEASED") && document.body.innerText.includes("CONSUMED") ? true : document.body.innerText.includes("CONSUMED")));
    } else { check("J1.recipe-card-ui", false, "shell missing"); check("J2.batch-row-ui", false, "shell missing"); check("J3.status-pills", false, "shell missing"); }
    check("J4.no-page-errors", page.errors.length === 0, page.errors.slice(0, 2).join(" | "));

    console.log("── Z. TBM purge → forensics ──");
    await page.close(); await wPage.close();

    await q(`UPDATE block_factory_logs SET mix_batch_id=NULL WHERE business_id=$1 AND mix_batch_id=ANY($2)`, [BIZ, [mixId, mix2Id, mix3Id, mix4Id]]);
    await q(`DELETE FROM block_factory_logs WHERE business_id=$1 AND batch_id=$2`, [BIZ, logRow.batch_id]);
    await q(`DELETE FROM block_mix_batch_inputs WHERE mix_batch_id=ANY($1)`, [[mixId, mix2Id, mix3Id, mix4Id]]);
    await q(`DELETE FROM block_mix_batches WHERE formulation_name LIKE 'TBM%'`);
    await q(`DELETE FROM block_mix_formulation_items WHERE formulation_id=$1`, [formId]);
    await q(`DELETE FROM block_mix_formulations WHERE name LIKE 'TBM%'`);
    await q(`DELETE FROM block_qc_checks WHERE business_id=$1 AND (test_name LIKE 'TBM%' OR batch_id = ANY($2))`, [BIZ, suiteMixNos]);
    await q(`DELETE FROM transactions WHERE id > $2 AND business_id=$1 AND (description LIKE '%TBM%' OR description LIKE ANY($3))`, [BIZ, txnMax0, suiteMixNos.map((x) => `%${x}%`)]);
    await q(`DELETE FROM audit_trail WHERE action LIKE 'BLOCK_MIX_%' AND (target_label LIKE '%TBM%' OR record_id=ANY($1))`, [[mixId, mix2Id, mix3Id, mix4Id, formId]]);
    await q(`DELETE FROM inventory_items WHERE business_id=$1 AND name LIKE 'TBM%'`, [BIZ]);
    await q(`DELETE FROM block_types WHERE business_id=$1 AND type_key LIKE 'TBM%'`, [BIZ]);
    await q(`DELETE FROM suppliers WHERE name LIKE 'TBM%'`);

    check("Z1.purge-clean", n((await q1(`SELECT COUNT(*) c FROM block_mix_formulations WHERE name LIKE 'TBM%'`)).c) === 0
      && n((await q1(`SELECT COUNT(*) c FROM block_mix_batches WHERE formulation_name LIKE 'TBM%'`)).c) === 0
      && n((await q1(`SELECT COUNT(*) c FROM block_types WHERE business_id=$1 AND type_key LIKE 'TBM%'`, [BIZ])).c) === 0);
    const invAfter = Object.fromEntries(
      (await q(`SELECT id, quantity, cost_price_ghs FROM inventory_items WHERE business_id=$1 ORDER BY id`, [BIZ])).rows.map((r) => [r.id, r]));
    const drift = [];
    for (const [id, before] of Object.entries(invBefore)) {
      const after = invAfter[id];
      if (!after) continue;
      if (Math.abs(n(after.quantity) - n(before.quantity)) > 0.01) drift.push(`${before.name}: ${before.quantity}→${after.quantity}`);
      if (Math.abs(n(after.cost_price_ghs) - n(before.cost_price_ghs)) > 0.01) drift.push(`${before.name} cost: ${before.cost_price_ghs}→${after.cost_price_ghs}`);
    }
    check("Z2.inventory-byte-exact", drift.length === 0, drift.join("; "));
    check("Z3.txn-count-full-circle", n((await q1(`SELECT COUNT(*) c FROM transactions WHERE business_id=$1`, [BIZ])).c) === txnCount0);
    check("Z4.log-count-full-circle", n((await q1(`SELECT COUNT(*) c FROM block_factory_logs WHERE business_id=$1`, [BIZ])).c) === logsCount0);
    check("Z5.type-count-full-circle", n((await q1(`SELECT COUNT(*) c FROM block_types WHERE business_id=$1`, [BIZ])).c) === typesCount0);

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
