/* Fish Feed Mill + Block Mixing — safe DEMO seeds through production API paths.
 *
 * AQUA-01 (biz 3) — Fish Feed Mill:
 *   formulations → "DEMO · …" tilapia extruded floating grower + starter crumbles
 *   raw intake   → DEMO fishmeal/soya/maize bran/premix… **recordExpense:false**
 *   2 batches    → labour+overhead 0 → zero finance bookings
 *   QC           → batch1 full PASS incl. FLOATING floatPct ≥90 → RELEASE →
 *                  pond feed-out (own-mill link, no re-expense); batch 2 stays
 *                  on QC_HOLD with a FLOATING FAIL (sink-test demo + bell)
 *
 * BLOCK-01 (biz 2) — Mixing tab:
 *   1 MIX formulation "DEMO · …" (Σ=100, bound to a master block type)
 *   raw materials auto-created in "Block Raw Materials" + stocked via RESTOCK
 *   (recordExpense:false — NO finance)
 *   1 mix run (zero ops costs) → MIXING-stage QC PASS → RELEASED (left
 *   ready-to-consume), + 1 mix left on QC_HOLD with a FAIL for the gate demo
 *
 * Guards: finance transactions snapshot + existing-inventory byte forensics;
 * idempotent (skips when DEMO · rows exist). Nothing existing mutated/deleted.
 * Run: bash dev-tooling/run-suite.sh dev-tooling/seed-fish-mixing-demo.mjs
 */
import { createRequire } from "node:module";
const require = createRequire("/home/user/pgtooling/package.json");
const { Client } = require("pg");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: "Owner@GoMina26" };
const pg = new Client("postgresql://postgres:postgres@127.0.0.1:5432/app_db");
await pg.connect();

const note = (m) => console.log("  · " + m);
let cookie = "";
async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method || "GET",
    headers: { "content-type": "application/json", cookie },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, json: j };
}
const postAqua = (entity, data) => api("/api/aquaculture/feed-mill", { method: "POST", body: { entity, data } });
const postBlk = (entity, data) => api("/api/block-factory", { method: "POST", body: { entity, data } });

const login = await fetch(BASE + "/api/auth/login", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: OWNER.email, password: OWNER.pw }),
});
if (!login.ok) { console.error("owner login failed:", login.status); process.exit(1); }
cookie = (login.headers.get("set-cookie") || "").split(";")[0];
note("logged in as GoMina OWNER");

/* ── finance + existing-inventory snapshots (BOTH businesses) ── */
const finBefore = await pg.query("select count(*)::int n, coalesce(sum(amount_ghs),0)::numeric t from transactions where business_id in (2,3)");
const invBefore = await pg.query("select id, quantity from inventory_items where business_id in (2,3)");
const invQ = new Map(invBefore.rows.map((r) => [r.id, Number(r.quantity)]));

async function guards(role) {
  const finAfter = await pg.query("select count(*)::int n, coalesce(sum(amount_ghs),0)::numeric t from transactions where business_id in (2,3)");
  if (finBefore.rows[0].n !== finAfter.rows[0].n || Number(finBefore.rows[0].t) !== Number(finAfter.rows[0].t)) {
    console.error(`FINANCE GUARD TRIPPED after ${role}:`, { before: finBefore.rows[0], after: finAfter.rows[0] });
    process.exit(2);
  }
  const invAfter = await pg.query("select id, quantity from inventory_items where business_id in (2,3)");
  const changedReal = invAfter.rows.filter((r) => invQ.has(r.id) && Number(r.quantity) !== invQ.get(r.id));
  if (changedReal.length) { console.error(`EXISTING INVENTORY TOUCHED after ${role}:`, changedReal); process.exit(2); }
  note(`guards ✓ after ${role} — finance unchanged (n=${finAfter.rows[0].n}, Σ GH₵ ${Number(finAfter.rows[0].t).toLocaleString()}), ${invQ.size} pre-existing items untouched`);
}

/* ═══════════════ 1 · FISH FEED MILL (AQUA-01, biz 3) ═══════════════ */
const aqua = await pg.query("select id, business_id, name from fish_feed_formulations where business_id=3");
if (!aqua.rows.some((r) => r.name.startsWith("DEMO ·"))) {
  const RAW_F = [
    { name: "DEMO Fishmeal 60%CP (Anchovy)", qty: 300, unit: "KG", unitCostGhsPerUnit: 14.5, supplierName: "DEMO · Tema Fishing Harbour Suppliers", minStockThreshold: 50 },
    { name: "DEMO Soya Bean Meal 46%", qty: 400, unit: "KG", unitCostGhsPerUnit: 8.9, supplierName: "DEMO · Yedent Agro Accra", minStockThreshold: 60 },
    { name: "DEMO Maize Bran", qty: 350, unit: "KG", unitCostGhsPerUnit: 2.4, supplierName: "DEMO · Nsawam Millers", minStockThreshold: 50 },
    { name: "DEMO Rice Bran (Stabilised)", qty: 200, unit: "KG", unitCostGhsPerUnit: 2.1, supplierName: "DEMO · Nsawam Millers", minStockThreshold: 40 },
    { name: "DEMO Fish Oil", qty: 40, unit: "KG", unitCostGhsPerUnit: 18.0, supplierName: "DEMO · Tema Cold Stores", minStockThreshold: 8 },
    { name: "DEMO Aqua Vitamin Premix", qty: 25, unit: "KG", unitCostGhsPerUnit: 26.0, supplierName: "DEMO · Trouw Ghana Tema", minStockThreshold: 5 },
    { name: "DEMO Binder (Wheat Gluten)", qty: 30, unit: "KG", unitCostGhsPerUnit: 9.5, supplierName: "DEMO · Yedent Agro Accra", minStockThreshold: 6 },
  ];
  for (const r of RAW_F) {
    const res = await postAqua("INTAKE", {
      businessId: 3, branchCode: "AQUA-01",
      itemName: r.name, qty: r.qty, unit: r.unit,
      unitCostGhs: r.unitCostGhsPerUnit, totalCostGhs: r.qty * r.unitCostGhsPerUnit,
      supplierName: r.supplierName, recordExpense: false,
      minStockThreshold: r.minStockThreshold, date: "2026-09-18",
    });
    if (!res.json.success) { console.error("fish intake failed:", r.name, res.json); process.exit(1); }
    note(`aqua intake ${r.name}: +${r.qty} kg (stock-only) · ${r.supplierName}`);
  }

  const join = (name, share) => ({ ingredientName: name, sharePct: share });
  const mkFormA = async (body) => {
    const res = await postAqua("FORMULATION", { businessId: 3, branchCode: "AQUA-01", ...body });
    if (!res.json.success) { console.error("fish formulation failed:", res.json); process.exit(1); }
    return res.json.item;
  };
  const FF1 = await mkFormA({
    name: "DEMO · Volta Tilapia Grower 32%CP Floating", species: "NILE_TILAPIA", feedClass: "FLOATING", feedStage: "GROWER",
    pelletMm: 4.5, batchSizeKg: 300, cpPctTarget: 32, commercialRefPriceGhs: 12.80,
    notes: "DEMO seed — extruded floating feed for earthen pond tilapia",
    items: [join("DEMO Fishmeal 60%CP (Anchovy)", 22), join("DEMO Soya Bean Meal 46%", 34), join("DEMO Maize Bran", 24), join("DEMO Rice Bran (Stabilised)", 12), join("DEMO Fish Oil", 3), join("DEMO Aqua Vitamin Premix", 2), join("DEMO Binder (Wheat Gluten)", 3)],
  });
  note(`fish formulation ${FF1.formulationNo} — 7 BOM lines, Σ=100% · FLOATING 4.5mm`);
  const FF2 = await mkFormA({
    name: "DEMO · Volta Tilapia Starter 38%CP Sinking", species: "NILE_TILAPIA", feedClass: "SINKING", feedStage: "STARTER",
    pelletMm: 1.5, batchSizeKg: 200, cpPctTarget: 38, commercialRefPriceGhs: 16.40,
    notes: "DEMO seed — sinking starter crumbles for nursery cages",
    items: [join("DEMO Fishmeal 60%CP (Anchovy)", 42), join("DEMO Soya Bean Meal 46%", 36), join("DEMO Rice Bran (Stabilised)", 10), join("DEMO Fish Oil", 6), join("DEMO Aqua Vitamin Premix", 3), join("DEMO Binder (Wheat Gluten)", 3)],
  });
  note(`fish formulation ${FF2.formulationNo} — 6 BOM lines, Σ=100% · SINKING 1.5mm`);

  const mkBatchA = async (formulationId, planned, actualOutput, notes, date) => {
    const res = await postAqua("BATCH", {
      businessId: 3, branchCode: "AQUA-01",
      formulationId, plannedInputKg: planned, actualOutputKg: actualOutput, outputUnit: "KG",
      labourCostGhs: 0, overheadCostGhs: 0, paymentMethod: "CASH",
      operatorName: "DEMO Miller Y. Adjei", productionDate: date, notes,
    });
    if (!res.json.success) { console.error("fish batch failed:", res.json); process.exit(1); }
    return res.json.item;
  };
  const FB1 = await mkBatchA(FF1.id, 300, 291, "DEMO seed batch — release-side walkthrough", "2026-09-17");
  note(`fish batch ${FB1.batchNumber}: 300 → 291 kg (97.0%) on QC HOLD`);
  const FB2 = await mkBatchA(FF2.id, 200, 196, "DEMO seed batch — gate-side walkthrough (left on hold)", "2026-09-18");
  note(`fish batch ${FB2.batchNumber}: 200 → 196 kg on QC HOLD (kept held for demo)`);

  const mkQcA = async (body) => {
    const res = await postAqua("QC", { businessId: 3, branchCode: "AQUA-01", ...body });
    if (!res.json.success) { console.error("fish qc failed:", res.json); process.exit(1); }
    return res.json.item;
  };
  for (const q of [
    { stage: "RAW_MATERIAL", testName: "Incoming fishmeal moisture", testResult: "9.8% — within spec", resultValue: 9.8, resultUnit: "%", passFail: "PASS" },
    { stage: "PRE_BLEND", testName: "Grind fineness (mesh 20)", testResult: "92% passes — spec ≥90%", resultValue: 92, resultUnit: "%", passFail: "PASS" },
    { stage: "POST_BLEND", testName: "Mix uniformity (CV)", testResult: "CV 5.8% — uniform", resultValue: 5.8, resultUnit: "%", passFail: "PASS" },
    { stage: "FLOATING", testName: "10-min float test + water stability", testResult: "96% floating after 10 min; pellets intact 24 min", resultValue: 96, resultUnit: "%", passFail: "PASS", floatPct: 96, waterStabilityMinutes: 24 },
    { stage: "FINISHED_FEED", testName: "Pellet durability (PDI)", testResult: "PDI 93 — spec ≥90", resultValue: 93, resultUnit: "PDI", passFail: "PASS" },
  ]) await mkQcA({ batchId: FB1.id, testerName: "DEMO QC A. Boakye", ...q });
  note(`fish batch ${FB1.batchNumber}: 5-stage QC PASSED (incl. FLOATING 96% float)`);
  await mkQcA({
    batchId: FB2.id, stage: "FLOATING", testName: "10-min float test (sinking class run)",
    testResult: "34% floated — starter extruder over-expanded; batch mis-cured",
    resultValue: 34, resultUnit: "%", passFail: "FAIL", floatPct: 34, waterStabilityMinutes: 6,
    contaminantsNote: "steam pressure dip during run", testerName: "DEMO QC A. Boakye",
  });
  note(`fish batch ${FB2.batchNumber}: FLOATING FAIL (34%) → bell alert fanned out`);

  const relA = await postAqua("RELEASE", { businessId: 3, batchId: FB1.id, note: "DEMO walkthrough release — float test passed" });
  if (!relA.json.success) { console.error("fish release failed:", relA.json); process.exit(1); }
  note(`fish batch ${FB1.batchNumber} RELEASED through the aquatic QC gate`);

  const pond = await pg.query("select id from aquaculture_ponds where business_id=3 and status='ACTIVE' order by id limit 1");
  const fishB = await pg.query("select id from aquaculture_batches where business_id=3 and status='ACTIVE' order by id limit 1");
  const cons = await postAqua("CONSUMPTION", {
    businessId: 3, branchCode: "AQUA-01",
    batchId: FB1.id, pondId: pond.rows[0]?.id || null, fishBatchId: fishB.rows[0]?.id || null,
    qty: 62, unit: "KG", recordedDate: "2026-09-19", notes: "DEMO morning feed-out — own mill ration",
  });
  if (!cons.json.success) { console.error("fish consume failed:", cons.json); process.exit(1); }
  note(`fed 62 kg own-mill grower → pond feed log (no re-expense)`);
  await guards("fish feed mill");
} else {
  note(`fish mill already seeded (found “${aqua.rows.find((r) => r.name.startsWith("DEMO ·")).name}”)`);
}

/* ═══════════════ 2 · BLOCK MIXING (BLOCK-01, biz 2) ═══════════════ */
const blk = await pg.query("select id, name from block_mix_formulations where business_id=2");
if (!blk.rows.some((r) => r.name.startsWith("DEMO ·"))) {
  // master block type for binding (org-level, additive)
  const mkType = await postBlk("BLOCK_TYPE", { businessId: 2, name: "DEMO 8in Sandcrete Test Blocks", dimensions: "440×215×200mm", style: "HOLLOW" });
  if (!mkType.json.success) { console.error("block type failed:", mkType.json); process.exit(1); }
  const typeKey = mkType.json.item.typeKey;
  note(`master block type DEMO 8in‥ → ${typeKey}`);

  const join = (name, share) => ({ ingredientName: name, sharePct: share });
  const form = await postBlk("MIX_FORMULATION", {
    businessId: 2, name: "DEMO · Lab 8in Sandcrete 1:9", blockType: typeKey,
    designNote: "1:9 lean sandcrete for demo", waterCementRatio: 0.58, batchSizeKg: 800,
    items: [join("DEMO Pit Sand (Sharp)", 82), join("DEMO Cement Loose 42.5R", 13), join("DEMO Quarry Dust", 5)],
  });
  if (!form.json.success) { console.error("mix formulation failed:", form.json); process.exit(1); }
  const formId = form.json.item.id;
  note(`mix formulation ${form.json.item.formulationNo} — 3 BOM lines, Σ=100%, w/c 0.58`);

  const raws = await pg.query("select id, name from inventory_items where business_id=2 and name like 'DEMO %'");
  const rawCosts = { "DEMO Pit Sand (Sharp)": 0.32, "DEMO Cement Loose 42.5R": 2.15, "DEMO Quarry Dust": 0.18 };
  const rawQty = { "DEMO Pit Sand (Sharp)": 1400, "DEMO Cement Loose 42.5R": 260, "DEMO Quarry Dust": 120 };
  for (const r of raws.rows) {
    if (!rawCosts[r.name]) continue;
    const res = await postBlk("RESTOCK", {
      businessId: 2, inventoryId: r.id, quantity: rawQty[r.name], unitCostGhs: rawCosts[r.name],
      recordExpense: false, supplierName: "DEMO · Somanya Aggregate Depot", date: "2026-09-18",
    });
    if (!res.json.success) { console.error("restock failed:", r.name, res.json); process.exit(1); }
    note(`restock ${r.name}: +${rawQty[r.name]} kg (stock-only)`);
  }

  const mkMix = async (planned, water, notes) => {
    const res = await postBlk("MIX", {
      businessId: 2, formulationId: formId, plannedInputKg: planned, waterLitresUsed: water,
      labourCostGhs: 0, overheadCostGhs: 0, operatorName: "DEMO Mixer 6 Gang", productionDate: "2026-09-18", notes,
    });
    if (!res.json.success) { console.error("mix failed:", res.json); process.exit(1); }
    return res.json.item;
  };
  const M1 = await mkMix(800, 55, "DEMO seed mix — release-side walkthrough");
  note(`mix ${M1.mixBatchNumber}: 800 kg + 55 L water → ${M1.actualOutputKg} kg on QC HOLD`);
  const M2 = await mkMix(400, 30, "DEMO seed mix — gate-side walkthrough (left on hold)");
  note(`mix ${M2.mixBatchNumber}: 400 kg + 30 L water on QC HOLD (kept held for demo)`);

  const qc = await postBlk("QC_CHECK", {
    businessId: 2, stage: "MIXING", batchId: M1.mixBatchNumber,
    testName: "DEMO Slump + uniformity (mix ID " + M1.mixBatchNumber + ")", passFail: "PASS", resultValue: 47, resultUnit: "mm slump",
  });
  if (!qc.json.success) { console.error("mix qc failed:", qc.json); process.exit(1); }
  note(`mix ${M1.mixBatchNumber}: MIXING-stage QC PASS (47 mm slump)`);
  const qc2 = await postBlk("QC_CHECK", {
    businessId: 2, stage: "MIXING", batchId: M2.mixBatchNumber,
    testName: "DEMO Slump check (mix " + M2.mixBatchNumber + ")", passFail: "FAIL", resultValue: 74, resultUnit: "mm slump",
  });
  if (!qc2.json.success) { console.error("mix qc2 failed:", qc2.json); process.exit(1); }
  note(`mix ${M2.mixBatchNumber}: MIXING-stage QC FAIL (74 mm slump — over-wet) — stays on hold`);

  const relB = await postBlk("MIX_RELEASE", { businessId: 2, mixBatchId: M1.id });
  if (!relB.json.success) { console.error("mix release failed:", relB.json); process.exit(1); }
  note(`mix ${M1.mixBatchNumber} RELEASED through the MIXING QC gate`);
  await guards("block mixing");
} else {
  note(`block mixing already seeded (found “${blk.rows.find((r) => r.name.startsWith("DEMO ·")).name}”)`);
}

/* ── final forensics + summary ── */
const sum = await pg.query(`select
  (select count(*) from fish_feed_formulations where business_id=3 and name like 'DEMO ·%') fforms,
  (select count(*) from fish_feed_batches b join fish_feed_formulations f on f.id=b.formulation_id where f.name like 'DEMO ·%') fbatches,
  (select count(*) from block_mix_formulations where business_id=2 and name like 'DEMO ·%') mforms,
  (select count(*) from block_mix_batches where formulation_name like 'DEMO ·%') mbatches`);
note(`seeded: ${sum.rows[0].fforms} fish formulations · ${sum.rows[0].fbatches} fish batches · ${sum.rows[0].mforms} mix recipes · ${sum.rows[0].mbatches} mix batches`);
await pg.end();
console.log(`
══ FISH-MILL + BLOCK-MIXING DEMO SEED COMPLETE ══
  Fish Feed Mill → Units → Volta Cage Tilapia Farm (AQUA-01) → Feed Mill tab
    OVERVIEW KPIs + mill alerts · FORMULAS 2 DEMO recipes (FLOATING 4.5mm / SINKING 1.5mm)
    BATCHES one RELEASED (float 96%) one QC_HOLD (float FAIL 34%) · STOCK 7 DEMO ingredients + finished feed
    FEED OUT pond feed-out linked to own mill (no re-expense)
  Block Mixing → Units → Mina Concrete & Blocks (BLOCK-01) → Mixing tab (NEW, between Inventory and Finance)
    Recipe DEMO · Lab 8in Sandcrete 1:9 · one RELEASED mix (47 mm slump, ready for a Production run)
    one QC_HOLD mix (74 mm slump FAIL) · raw batches in "Block Raw Materials" inventory category`);
