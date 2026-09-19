/* Feed Mill — safe DEMO seed for the REAL Poultry Farm feed mill.
 * Seeds realistic, clearly-marked demo data through the production API paths
 * (the same calls the UI makes), so every feature can be viewed/tested live:
 *
 *   formulations  → "DEMO · …" layer mash + broiler finisher (Σ share = 100)
 *   raw intake    → DEMO maize/soya/bran/oyster/premix/concentrate…
 *                   **recordExpense:false — NO finance transactions**
 *                   supplier ledger rows are created ("DEMO · …" vendors)
 *   batches       → 2 runs, labour+overhead = 0 (zero finance bookings)
 *   QC            → all stages PASS on batch 1 → RELEASE → 2 flock feed-outs
 *                   batch 2 stays on QC_HOLD + one FINISHED_FEED FAIL to demo
 *                   the gate + the alert bell. Never releases.
 *   stock check   → asserts no txn row was written by any of it
 *
 * Finance guard: the script snapshots `transactions` (count + sum) before and
 * after and ABORTS LOUDLY if they differ. Existing farm data is read-only:
 * only new rows are inserted; nothing existing is updated or deleted
 * (except supplier.totalSuppliedGhs accrual for DEMO vendors only).
 *
 * Idempotent: skip if "DEMO ·" formulations already exist for the business.
 * Run: bash dev-tooling/run-suite.sh dev-tooling/seed-feed-mill-demo.mjs
 */
import { createRequire } from "node:module";
const require = createRequire("/home/user/pgtooling/package.json");
const { Client } = require("pg");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const BIZ = 1;
const OWNER = { email: "kwame.owner@gomina360.com", pw: "Owner@GoMina26" };
const pg = new Client("postgresql://postgres:postgres@127.0.0.1:5432/app_db");
await pg.connect();

const log = [];
const note = (m) => { console.log("  · " + m); log.push(m); };
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
const post = (entity, data) => api("/api/poultry/feed-mill", { method: "POST", body: { entity, data } });

/* ── login ── */
const login = await fetch(BASE + "/api/auth/login", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: OWNER.email, password: OWNER.pw }),
});
if (!login.ok) { console.error("owner login failed:", login.status); process.exit(1); }
cookie = (login.headers.get("set-cookie") || "").split(";")[0];
note("logged in as farm OWNER");

/* ── finance snapshot BEFORE ── */
const finBefore = await pg.query("select count(*)::int n, coalesce(sum(amount_ghs),0)::numeric t from transactions");
const invBefore = await pg.query("select id, quantity from inventory_items where business_id=$1", [BIZ]);
const invQ = new Map(invBefore.rows.map((r) => [r.id, Number(r.quantity)]));

/* ── idempotency ── */
const existing = await pg.query("select id, name from poultry_feed_formulations where business_id=$1", [BIZ]);
if (existing.rows.some((r) => r.name.startsWith("DEMO ·"))) {
  console.log(`\nFM DEMO: already seeded (found “${existing.rows.find((r) => r.name.startsWith("DEMO ·")).name}”). Nothing to do — forensics unchanged.`);
  await pg.end(); process.exit(0);
}

/* ── 1 · raw-material intakes (NO expense booking) ── */
const RAW = [
  { name: "DEMO Maize (Grade 1)", qty: 1200, unit: "KG", unitCostGhsPerUnit: 4.2, supplierName: "DEMO · Olam Grains Koforidua", minStockThreshold: 150 },
  { name: "DEMO Soya Bean Meal 46%", qty: 600, unit: "KG", unitCostGhsPerUnit: 8.9, supplierName: "DEMO · Yedent Agro Accra", minStockThreshold: 80 },
  { name: "DEMO Wheat Bran", qty: 350, unit: "KG", unitCostGhsPerUnit: 2.6, supplierName: "DEMO · Irani Bros Kumasi", minStockThreshold: 60 },
  { name: "DEMO Oyster Shell Grit", qty: 200, unit: "KG", unitCostGhsPerUnit: 1.8, supplierName: "DEMO · Seaside Shells Tema", minStockThreshold: 40 },
  { name: "DEMO Layer Premix", qty: 60, unit: "KG", unitCostGhsPerUnit: 22.0, supplierName: "DEMO · Trouw Ghana Tema", minStockThreshold: 10 },
  { name: "DEMO Broiler Concentrate 35%", qty: 120, unit: "KG", unitCostGhsPerUnit: 14.0, supplierName: "DEMO · Trouw Ghana Tema", minStockThreshold: 15 },
  { name: "DEMO DCP Granules", qty: 30, unit: "KG", unitCostGhsPerUnit: 6.0, supplierName: "DEMO · Yedent Agro Accra", minStockThreshold: 5 },
  { name: "DEMO Iodized Salt", qty: 25, unit: "KG", unitCostGhsPerUnit: 1.2, supplierName: "DEMO · Dangote Salt", minStockThreshold: 5 },
];
const rawByName = new Map();
for (const r of RAW) {
  const res = await post("INTAKE", {
    businessId: BIZ, branchCode: "POULTRY-01", branchName: "Mina Akuafo Poultry Farm",
    itemName: r.name, qty: r.qty, unit: r.unit,
    unitCostGhs: r.unitCostGhsPerUnit, // kg is the unit here (qty is in KG)
    totalCostGhs: r.qty * r.unitCostGhsPerUnit,
    supplierName: r.supplierName, recordExpense: false,   // ← finance guard
    minStockThreshold: r.minStockThreshold, date: "2026-09-18",
  });
  if (!res.json.success) { console.error("intake failed:", r.name, res.json); process.exit(1); }
  rawByName.set(r.name, res.json.item);
  note(`intake ${r.name}: +${r.qty} kg (stock-only, no expense) · ${r.supplierName}`);
}

/* ── 2 · formulations ── */
const mkForm = async (body) => {
  const res = await post("FORMULATION", { businessId: BIZ, branchCode: "POULTRY-01", ...body });
  if (!res.json.success) { console.error("formulation failed:", res.json); process.exit(1); }
  return res.json.item;
};
const join = (name, share) => ({ ingredientName: name, sharePct: share });
const F1 = await mkForm({
  name: "DEMO · Nsawam Layer Mash 17%CP", feedType: "LAYER_MASH", birdType: "LAYERS",
  batchSizeKg: 500, cpPctTarget: 17, commercialRefPriceGhs: 8.60, notes: "DEMO seed — ignore in real-planning numbers",
  items: [join("DEMO Maize (Grade 1)", 58), join("DEMO Soya Bean Meal 46%", 20), join("DEMO Wheat Bran", 9.5), join("DEMO Oyster Shell Grit", 9), join("DEMO Layer Premix", 1.5), join("DEMO DCP Granules", 1.2), join("DEMO Iodized Salt", 0.8)],
});
note(`formulation ${F1.formulationNo} — 7 BOM lines, Σ=100%`);
const F2 = await mkForm({
  name: "DEMO · Volta Broiler Finisher 20%CP", feedType: "FINISHER", birdType: "BROILERS",
  batchSizeKg: 400, cpPctTarget: 20, commercialRefPriceGhs: 9.40, notes: "DEMO seed — ignore in real-planning numbers",
  items: [join("DEMO Maize (Grade 1)", 60), join("DEMO Soya Bean Meal 46%", 26), join("DEMO Broiler Concentrate 35%", 10), join("DEMO Wheat Bran", 2), join("DEMO Layer Premix", 1), join("DEMO Iodized Salt", 1)],
});
note(`formulation ${F2.formulationNo} — 6 BOM lines, Σ=100%`);

/* ── 3 · batches (labour/overhead 0 → no finance) ── */
const mkBatch = async (formulationId, planned, actualOutput, note0, date) => {
  const res = await post("BATCH", {
    businessId: BIZ, branchCode: "POULTRY-01", branchName: "Mina Akuafo Poultry Farm",
    formulationId, plannedInputKg: planned, actualOutputKg: actualOutput, outputUnit: "KG",
    labourCostGhs: 0, overheadCostGhs: 0, paymentMethod: "CASH",
    operatorName: "DEMO Operator K. Tettey", productionDate: date, notes: note0,
  });
  if (!res.json.success) { console.error("batch failed:", res.json); process.exit(1); }
  return res.json.item;
};
const B1 = await mkBatch(F1.id, 500, 492, "DEMO seed batch — release-side walkthrough", "2026-09-17");
note(`batch ${B1.batchNumber}: 500 → 492 kg (yield 98.4%) on QC HOLD`);
const B2 = await mkBatch(F2.id, 400, 395, "DEMO seed batch — gate-side walkthrough (left on hold)", "2026-09-18");
note(`batch ${B2.batchNumber}: 400 → 395 kg on QC HOLD (kept held for demo)`);

/* ── 4 · QC: batch 1 full PASS; batch 2 a FAIL to demo the bell/gate ── */
const mkQc = async (body) => {
  const res = await post("QC", { businessId: BIZ, branchCode: "POULTRY-01", ...body });
  if (!res.json.success) { console.error("qc failed:", res.json); process.exit(1); }
  return res.json.item;
};
for (const [stage, testName, result, value, unit] of [
  ["RAW_MATERIAL", "Raw intake moisture", "12.1% — within spec", 12.1, "%"],
  ["PRE_BLEND", "Sieve inspection (residue)", "Screens clear, mesh intact", null, null],
  ["POST_BLEND", "Uniformity check", "CV 4.8% — blend uniform", 4.8, "%"],
  ["FINISHED_FEED", "Finished feed moisture + fines", "11.6% moisture, fines <6%", 11.6, "%"],
]) {
  await mkQc({ batchId: B1.id, stage, testName, testResult: result, resultValue: value, resultUnit: unit, passFail: "PASS", testerName: "DEMO Lab E. Awuah" });
}
note(`batch ${B1.batchNumber}: 4-stage QC PASSED (incl. FINISHED_FEED)`);
await mkQc({ batchId: B2.id, stage: "FINISHED_FEED", testName: "Finished feed moisture", testResult: "14.8% — above the 13% spec", resultValue: 14.8, resultUnit: "%", passFail: "FAIL", testerName: "DEMO Lab E. Awuah", contaminantsNote: "caking spots at bin 2" });
note(`batch ${B2.batchNumber}: FINISHED_FEED FAIL (14.8% moisture) → bell alert fanned out`);

/* ── 5 · release batch 1 through the real gate, then feed two flocks ── */
const rel = await post("RELEASE", { businessId: BIZ, batchId: B1.id, note: "DEMO walkthrough release — all QC stages passed" });
if (!rel.json.success) { console.error("release failed:", rel.json); process.exit(1); }
note(`batch ${B1.batchNumber} RELEASED through the QC gate`);
const consume = async (flockId, qty, date) => {
  const res = await post("CONSUMPTION", {
    businessId: BIZ, branchCode: "POULTRY-01", branchName: "Mina Akuafo Poultry Farm",
    batchId: B1.id, flockId, qty, unit: "KG", recordedDate: date, notes: "DEMO feed-out",
  });
  if (!res.json.success) { console.error("consume failed:", res.json); process.exit(1); }
  return res.json;
};
await consume(1, 185, "2026-09-18");
note("fed 185 kg → Nsawam Isa Brown Layer Flock (feed log written, no re-expense)");
await consume(1, 190, "2026-09-19");
note("fed 190 kg → same layers today (batch now ≈117 kg remaining)");

/* ── finance + inventory forensics AFTER ── */
const finAfter = await pg.query("select count(*)::int n, coalesce(sum(amount_ghs),0)::numeric t from transactions");
assertFin: {
  const same = finBefore.rows[0].n === finAfter.rows[0].n && Number(finBefore.rows[0].t) === Number(finAfter.rows[0].t);
  if (!same) {
    console.error("FINANCE GUARD TRIPPED: transactions changed!", {
      before: finBefore.rows[0], after: finAfter.rows[0],
    });
    process.exit(2);
  }
}
note(`finance guard ✓ transactions unchanged (n=${finAfter.rows[0].n}, Σ GH₵ ${Number(finAfter.rows[0].t).toLocaleString()})`);
const invAfter = await pg.query("select id, quantity from inventory_items where business_id=$1", [BIZ]);
const changedReal = invAfter.rows.filter((r) => invQ.has(r.id) && Number(r.quantity) !== invQ.get(r.id));
if (changedReal.length) {
  console.error("EXISTING INVENTORY TOUCHED:", changedReal); process.exit(2);
}
note(`inventory guard ✓ all ${invQ.size} pre-existing items untouched — only DEMO rows added`);
const demoSummary = await pg.query(`select
  (select count(*) from poultry_feed_formulations where business_id=1 and name like 'DEMO ·%') forms,
  (select count(*) from poultry_feed_batches b join poultry_feed_formulations f on f.id=b.formulation_id where f.name like 'DEMO ·%') batches,
  (select count(*) from poultry_feed_qc_checks) qc`);
note(`seeded: ${demoSummary.rows[0].forms} DEMO formulations · ${demoSummary.rows[0].batches} batches · ${demoSummary.rows[0].qc} QC checks`);

await pg.end();
console.log(`\n══ FM DEMO SEED COMPLETE ══
View: app → Units → Mina Akuafo Poultry Farm (POULTRY-01) → Feed Mill tab.
  OVERVIEW   KPIs + mill alerts (raw cover, hold count, savings vs GH₵ 8.60 ref)
  FORMULAS   2 DEMO recipes with full BOM-share chips
  BATCHES    ${B1?.batchNumber} RELEASED (~117 kg left) · ${B2?.batchNumber} QC_HOLD with a moisture FAIL
  STOCK      8 DEMO raw ingredients + finished milled feed
  FEEDOUT    2 feed-outs to the layer flock + 30-day conversion insight`);
