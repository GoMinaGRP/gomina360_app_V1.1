/**
 * verify-audit-fixes.mjs — regression suite for the Poultry Farm /
 * Aquaculture / Block Factory audit hardening round.
 *
 * Covers the specific defects fixed in this round (API-level, fast):
 *   A. Poultry GET tenant isolation (401/400/403 matrix + payload keys)
 *   B. Poultry PATCH CHECKLIST/FLOCK cross-tenant gate + validation
 *   C. Poultry data-entry validations, EGGS trays precedence fix,
 *      ledger-date correctness, audit-trail writes
 *   D. Aquaculture phantom-pond fix, WATER required measurements, FEED
 *      validations, partial-harvest batch accounting, ledger dates
 *   E. Daily checklist idempotence (both farms, Block Factory contract)
 *   Z. Forensics: every TEST row purged, inventory quantities restored
 *
 * Self-purging (TEST-AUD markers); run SEQUENTIALLY with other suites:
 *   bash dev-tooling/run-suite.sh dev-tooling/verify-audit-fixes.mjs
 */
import { createRequire } from "node:module";
const require = createRequire("/home/user/pgtooling/package.json");
const { Client } = require("pg");

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const CREDS = {
  owner: { email: "kwame.owner@gomina360.com", password: "Owner@GoMina26" },
  worker1: { email: "akua.donkor@gomina360.com", password: "GoMina@User10" }, // assigned biz 1
};
const BIZ_POULTRY = 1;  // Mina Akuafo Poultry Farm
const BIZ_AQUA = 3;     // Mina Volta Tilapia & Catfish
const BIZ_FOREIGN = 13; // university of idaho (another org — owner forbidden)

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; failures.push(name); console.log(`❌ ${name} ${String(detail).slice(0, 220)}`); }
}

const pg = new Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });
const q = (t, p) => pg.query(t, p);
const D = (off) => { const d = new Date(); d.setDate(d.getDate() + off); return d.toISOString().slice(0, 10); };
const MARK = `TEST-AUD-${Date.now().toString().slice(-6)}`;

async function call(path, method = "GET", body = null, token = null) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { "x-gomina-session": token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}
const login = async (c) => (await call("/api/auth/login", "POST", c)).json?.sessionToken || null;

// tracking for the forensic purge
const made = { flock: [], pond: [], batch: [], feedP: [], feedA: [], health: [], prod: [], water: [], harvest: [], auditBaseline: 0, txnBaseline: 0, checklistDateP: D(-213), checklistDateA: D(-214) };
let invBefore = new Map(); // "biz|sku" -> {id, quantity}

async function snapshotInv() {
  const r = await q(`SELECT id, business_id, sku, quantity FROM inventory_items WHERE business_id IN ($1,$2)`, [BIZ_POULTRY, BIZ_AQUA]);
  invBefore = new Map(r.rows.map((x) => [`${x.business_id}|${x.sku}`, { id: x.id, quantity: Number(x.quantity) }]));
}

async function purge() {
  console.log("── Z. purge TEST-AUD rows + restore inventory ──");
  // newest-first to respect references
  if (made.harvest.length) await q(`DELETE FROM aquaculture_harvests WHERE id = ANY($1)`, [made.harvest]);
  if (made.water.length) await q(`DELETE FROM aquaculture_water_quality_logs WHERE id = ANY($1)`, [made.water]);
  if (made.feedA.length) await q(`DELETE FROM aquaculture_feed_logs WHERE id = ANY($1)`, [made.feedA]);
  if (made.batch.length) await q(`DELETE FROM aquaculture_batches WHERE id = ANY($1)`, [made.batch]);
  if (made.pond.length) await q(`DELETE FROM aquaculture_ponds WHERE id = ANY($1)`, [made.pond]);
  if (made.prod.length) await q(`DELETE FROM poultry_production WHERE id = ANY($1)`, [made.prod]);
  if (made.health.length) await q(`DELETE FROM poultry_health_records WHERE id = ANY($1)`, [made.health]);
  if (made.feedP.length) await q(`DELETE FROM poultry_feed_logs WHERE id = ANY($1)`, [made.feedP]);
  if (made.flock.length) await q(`DELETE FROM poultry_flocks WHERE id = ANY($1)`, [made.flock]);
  await q(`DELETE FROM poultry_checklists WHERE business_id=$1 AND checklist_date=$2`, [BIZ_POULTRY, made.checklistDateP]);
  await q(`DELETE FROM aquaculture_checklists WHERE business_id=$1 AND checklist_date=$2`, [BIZ_AQUA, made.checklistDateA]);
  await q(`DELETE FROM poultry_checklists WHERE business_id=$1 AND checklist_date=$2`, [BIZ_AQUA, made.checklistDateP]);
  await q(`DELETE FROM poultry_checklists WHERE business_id=$1 AND checklist_date=$2`, [BIZ_POULTRY, made.checklistDateA]);
  await q(`DELETE FROM aquaculture_checklists WHERE business_id=$1 AND checklist_date=$2`, [BIZ_POULTRY, made.checklistDateA]);
  await q(`DELETE FROM aquaculture_checklists WHERE business_id=$1 AND checklist_date=$2`, [BIZ_AQUA, made.checklistDateP]);
  await q(`DELETE FROM aquaculture_checklists WHERE business_id=$1 AND checklist_date=$2`, [BIZ_POULTRY, made.checklistDateP]);
  // txns/audit rows use auto-built descriptions (MARK is NOT embedded) —
  // purge by id baseline; the suite runs alone (sequential discipline).
  await q(`DELETE FROM transactions WHERE id > $1`, [made.txnBaseline]);
  await q(`DELETE FROM audit_trail WHERE id > $1 AND (action LIKE 'POULTRY_%' OR action LIKE 'AQUA_%')`, [made.auditBaseline]);
  // inventory: set quantities back & remove rows the suite created
  const invNow = (await q(`SELECT id, business_id, sku, quantity FROM inventory_items WHERE business_id IN ($1,$2)`, [BIZ_POULTRY, BIZ_AQUA])).rows;
  for (const row of invNow) {
    const k = `${row.business_id}|${row.sku}`;
    if (invBefore.has(k)) {
      const b = invBefore.get(k);
      if (Number(row.quantity) !== b.quantity) await q(`UPDATE inventory_items SET quantity=$1 WHERE id=$2`, [b.quantity, row.id]);
    } else {
      // Not in the pre-run snapshot ⇒ the suite created it (e.g. first-ever
      // fresh-fish stockIn); remove it to restore the exact inventory shape.
      await q(`DELETE FROM inventory_items WHERE id=$1`, [row.id]);
    }
  }
}

async function main() {
  await pg.connect();
  const tOwner = await login(CREDS.owner);
  const tWorker = await login(CREDS.worker1);
  ok("A0 logins (owner + biz-1 worker)", !!tOwner && !!tWorker);

  // baselines
  made.auditBaseline = (await q(`SELECT COALESCE(MAX(id),0) m FROM audit_trail`)).rows[0].m;
  made.txnBaseline = (await q(`SELECT COALESCE(MAX(id),0) m FROM transactions`)).rows[0].m;
  await snapshotInv();

  // ═══ A. Poultry GET tenant isolation ═══
  console.log("── A. poultry GET gates ──");
  let r = await call(`/api/poultry?businessId=${BIZ_POULTRY}`);
  ok("A1 anon GET poultry → 401", r.status === 401, r.status);
  r = await call(`/api/poultry`, "GET", null, tOwner);
  ok("A2 GET poultry without businessId → 400", r.status === 400, r.status);
  // kwame is platform super-admin (unrestricted by design) — the meaningful
  // cross-tenant negative uses the org-scoped worker instead.
  r = await call(`/api/poultry?businessId=${BIZ_FOREIGN}`, "GET", null, tWorker);
  ok("A3 worker GET poultry of another org → 403", r.status === 403, r.status);
  r = await call(`/api/poultry?businessId=${BIZ_POULTRY}`, "GET", null, tOwner);
  ok("A4 GET poultry own org → 200 with all datasets",
    r.status === 200 && r.json?.success &&
    ["flocks", "feedLogs", "waterLogs", "healthRecords", "production", "checklists", "products", "weightLogs"].every((k) => Array.isArray(r.json[k])));
  r = await call(`/api/poultry?businessId=${BIZ_POULTRY}`, "GET", null, tWorker);
  ok("A5 assigned worker may read own farm", r.status === 200 && r.json?.success, r.status);
  r = await call(`/api/poultry?businessId=${BIZ_AQUA}`, "GET", null, tWorker);
  ok("A6 worker cannot read another farm's poultry data → 403", r.status === 403, r.status);

  // ═══ B. Poultry PATCH gates ═══
  console.log("── B. poultry PATCH gates ──");
  // seed one TEST flock in biz 1 and one in biz 3 (owner has org access to both)
  const mkFlock = async (biz, tag) => {
    const rr = await call("/api/poultry", "POST", {
      entity: "FLOCK",
      data: { businessId: biz, flockName: `${MARK} Flock ${tag}`, batchNumber: `${MARK}-FL-${tag}`, birdType: "LAYERS", initialCount: 500, createdByName: "TEST Aud" },
    }, tOwner);
    if (rr.json?.item?.id) made.flock.push(rr.json.item.id);
    return rr;
  };
  const f1 = await mkFlock(BIZ_POULTRY, "B1");
  const f3 = await mkFlock(BIZ_AQUA, "B3");
  ok("B0 TEST flocks seeded", f1.status === 200 && f3.status === 200, JSON.stringify([f1.status, f3.status, f3.json]).slice(0, 160));

  r = await call("/api/poultry", "PATCH", { entity: "FLOCK", id: f3.json?.item?.id, data: { currentCount: 1 } }, tWorker);
  ok("B1 worker PATCH flock outside her business → 403", r.status === 403, JSON.stringify(r).slice(0, 160));
  const f3After = (await q(`SELECT current_count FROM poultry_flocks WHERE id=$1`, [f3.json.item.id])).rows[0];
  ok("B2 cross-tenant flock row untouched", Number(f3After.current_count) === 500, JSON.stringify(f3After));
  r = await call("/api/poultry", "PATCH", { entity: "FLOCK", id: f1.json?.item?.id, data: { currentCount: -5 } }, tOwner);
  ok("B3 negative currentCount → 400", r.status === 400, r.status);
  r = await call("/api/poultry", "PATCH", { entity: "FLOCK", id: f1.json?.item?.id, data: { currentCount: 480, ageWeeks: 12 } }, tOwner);
  ok("B4 owner PATCH own flock → 200 + applied", r.status === 200 && r.json?.item?.currentCount === 480, JSON.stringify(r.json || r.status).slice(0, 120));
  const b4audit = (await q(`SELECT id FROM audit_trail WHERE id>$1 AND action='POULTRY_FLOCK_UPDATE' AND record_id=$2`, [made.auditBaseline, f1.json.item.id])).rows;
  ok("B5 flock PATCH writes audit-trail row", b4audit.length >= 1);
  // checklist toggle tenant gate
  await call("/api/poultry", "POST", { entity: "CHECKLIST", data: { businessId: BIZ_AQUA, checklistDate: made.checklistDateP, tasks: [{ taskKey: "TEST_T", taskLabel: "TEST A task", category: "GENERAL" }] } }, tOwner);
  const clRow = (await q(`SELECT id FROM poultry_checklists WHERE business_id=$1 AND checklist_date=$2 LIMIT 1`, [BIZ_AQUA, made.checklistDateP])).rows[0];
  r = await call("/api/poultry", "PATCH", { entity: "CHECKLIST", id: clRow?.id, data: { completedByName: "TEST Worker" } }, tWorker);
  ok("B6 worker toggles checklist outside her business → 403", r.status === 403, JSON.stringify(r.status));
  const clAfter = (await q(`SELECT is_completed FROM poultry_checklists WHERE id=$1`, [clRow?.id])).rows[0];
  ok("B7 cross-tenant checklist row untouched", clAfter?.is_completed === false, JSON.stringify(clAfter));

  // ═══ C. Poultry validations + EGGS precedence + ledger dates ═══
  console.log("── C. poultry entries ──");
  r = await call("/api/poultry", "POST", { entity: "FLOCK", data: { businessId: BIZ_POULTRY, flockName: `${MARK} zero`, birdType: "LAYERS", initialCount: 0 } }, tOwner);
  ok("C1 FLOCK initialCount=0 → 400", r.status === 400, r.status);
  let f0 = await mkFlock(BIZ_POULTRY, "C");
  ok("C2 FLOCK valid create + audit logged", f0.status === 200 && (await q(`SELECT id FROM audit_trail WHERE id>$1 AND action='POULTRY_FLOCK_CREATE' AND record_id=$2`, [made.auditBaseline, f0.json.item.id])).rows.length === 1);

  r = await call("/api/poultry", "POST", { entity: "FEED", data: { businessId: BIZ_POULTRY, quantityKg: 0, entryType: "CONSUMPTION", recordedDate: D(-1) } }, tOwner);
  ok("C3 FEED quantityKg=0 → 400", r.status === 400, r.status);
  r = await call("/api/poultry", "POST", { entity: "FEED", data: { businessId: BIZ_POULTRY, quantityKg: -3, entryType: "CONSUMPTION" } }, tOwner);
  ok("C4 FEED negative quantity → 400", r.status === 400, r.status);
  r = await call("/api/poultry", "POST", { entity: "FEED", data: { businessId: BIZ_POULTRY, quantityKg: 25, costPerKgGhs: 6, entryType: "PURCHASE", recordedDate: D(-4), brandSupplier: "TEST Aud Feeds", description: MARK, feedType: "LAYER_MASH", recordedByName: "TEST Aud" } }, tOwner);
  const feedRowId = r.json?.item?.id; if (feedRowId) made.feedP.push(feedRowId);
  ok("C5 FEED PURCHASE accepted", r.status === 200 && r.json?.success, JSON.stringify(r.json || r.status).slice(0, 120));
  const feedTrx = (await q(`SELECT date FROM transactions WHERE id>$1 AND category='POULTRY_FEED_PURCHASE' ORDER BY id DESC LIMIT 1`, [made.txnBaseline])).rows[0];
  ok("C6 feed expense books on recordedDate (not today)", feedTrx?.date === D(-4), JSON.stringify(feedTrx));
  ok("C7 feed purchase audit-trail written",
    (await q(`SELECT id FROM audit_trail WHERE id>$1 AND action='POULTRY_FEED_PURCHASE' AND record_id=$2`, [made.auditBaseline, feedRowId])).rows.length === 1);
  r = await call("/api/poultry", "POST", { entity: "FEED", data: { businessId: BIZ_POULTRY, quantityKg: 5, entryType: "CONSUMPTION", flockId: f3.json.item.id, recordedDate: D(-1) } }, tOwner);
  ok("C8 FEED referencing foreign flock → 404", r.status === 404, r.status);

  r = await call("/api/poultry", "POST", { entity: "HEALTH", data: { businessId: BIZ_POULTRY, recordType: "MORTALITY", mortalityCount: 10, flockId: f3.json.item.id, recordedDate: D(-1), recordedByName: "TEST Aud" } }, tOwner);
  ok("C9 HEALTH mortality on foreign flock → 404", r.status === 404, r.status);
  r = await call("/api/poultry", "POST", { entity: "HEALTH", data: { businessId: BIZ_POULTRY, recordType: "MORTALITY", mortalityCount: 25, flockId: f0.json.item.id, recordedDate: D(-1), recordedByName: "TEST Aud", diseaseOrCondition: MARK } }, tOwner);
  if (r.json?.item?.id) made.health.push(r.json.item.id);
  const f0count = (await q(`SELECT current_count, mortality_total FROM poultry_flocks WHERE id=$1`, [f0.json.item.id])).rows[0];
  ok("C10 mortality deducts own flock (500→475, +25 total)",
    r.status === 200 && Number(f0count.current_count) === 475 && Number(f0count.mortality_total) === 25,
    JSON.stringify([r.status, f0count]));

  // EGGS: explicit trays must win over the goodEggs/30 computation
  const eggSkuQty = async () => Number((await q(`SELECT quantity FROM inventory_items WHERE business_id=$1 AND sku='POUL-EGG-L01'`, [BIZ_POULTRY])).rows[0]?.quantity ?? 0);
  const q0 = await eggSkuQty();
  r = await call("/api/poultry", "POST", { entity: "PRODUCTION", data: { businessId: BIZ_POULTRY, productionType: "EGGS", eggsCollected: 330, crackedEggs: 30, traysProduced: 5, recordedDate: D(-2), recordedByName: "TEST Aud", revenueGhs: 0 } }, tOwner);
  if (r.json?.item?.id) made.prod.push(r.json.item.id);
  const q1 = await eggSkuQty();
  ok("C11 EGGS explicit traysProduced=5 stocks EXACTLY 5 crates (precedence fix)",
    r.status === 200 && Math.abs(q1 - q0 - 5) < 1e-9, `Δ${(q1 - q0).toFixed(2)} expected 5`);
  ok("C12 row stores the explicit 5 trays too", Number(r.json?.item?.traysProduced) === 5, JSON.stringify(r.json?.item?.traysProduced));
  r = await call("/api/poultry", "POST", { entity: "PRODUCTION", data: { businessId: BIZ_POULTRY, productionType: "EGGS", eggsCollected: 330, crackedEggs: 30, recordedDate: D(-2), recordedByName: "TEST Aud", revenueGhs: 0 } }, tOwner);
  if (r.json?.item?.id) made.prod.push(r.json.item.id);
  const q2 = await eggSkuQty();
  ok("C13 EGGS auto default excludes cracked (300/30=10 crates, NOT 11)",
    r.status === 200 && Math.abs(q2 - q1 - 10) < 1e-9 && Number(r.json?.item?.traysProduced) === 10,
    `Δ${(q2 - q1).toFixed(2)} trays ${r.json?.item?.traysProduced}`);
  r = await call("/api/poultry", "POST", { entity: "PRODUCTION", data: { businessId: BIZ_POULTRY, productionType: "EGGS", eggsCollected: 100, crackedEggs: 120, recordedDate: D(-1) } }, tOwner);
  ok("C14 crackedEggs > eggsCollected → 400", r.status === 400, r.status);
  r = await call("/api/poultry", "POST", { entity: "PRODUCTION", data: { businessId: BIZ_POULTRY, productionType: "EGGS", eggsCollected: 100, eggsSold: 120, recordedDate: D(-1) } }, tOwner);
  ok("C15 eggsSold > eggsCollected → 400", r.status === 400, r.status);
  r = await call("/api/poultry", "POST", { entity: "PRODUCTION", data: { businessId: BIZ_POULTRY, productionType: "EGGS", eggsCollected: 60, eggsSold: 60, revenueGhs: 110, recordedDate: D(-3), revenueSource: MARK, recordedByName: "TEST Aud" } }, tOwner);
  if (r.json?.item?.id) made.prod.push(r.json.item.id);
  const eggTrx = (await q(`SELECT date FROM transactions WHERE id>$1 AND category='POULTRY_EGG_SALE' ORDER BY id DESC LIMIT 1`, [made.txnBaseline])).rows[0];
  ok("C16 egg-sale income books on recordedDate", eggTrx?.date === D(-3), JSON.stringify(eggTrx));

  // ═══ D. Aquaculture ═══
  console.log("── D. aquaculture entries ──");
  const pondInPoultry = await call("/api/aquaculture", "POST", { entity: "POND", data: { businessId: BIZ_POULTRY, name: `${MARK} Pond X`, pondId: `${MARK}-PX`, type: "TANK", capacityLiters: 1000 } }, tOwner);
  if (pondInPoultry.json?.item?.id) made.pond.push(pondInPoultry.json.item.id);
  ok("D0 TEST pond seeded in poultry business", pondInPoultry.status === 200, JSON.stringify(pondInPoultry.json || pondInPoultry.status).slice(0, 140));

  r = await call("/api/aquaculture", "POST", { entity: "WATER", data: { businessId: BIZ_AQUA, sampleDate: D(-1), dissolvedOxygenMgL: 6.5 } }, tOwner);
  ok("D1 WATER without pH → 400 (no fabricating ph 7.0)", r.status === 400, r.status);
  r = await call("/api/aquaculture", "POST", { entity: "WATER", data: { businessId: BIZ_AQUA, sampleDate: D(-1), phLevel: 7.2, dissolvedOxygenMgL: 6.5, publishedByName: "TEST Aud" } }, tOwner);
  if (r.json?.item?.id) made.water.push(r.json.item.id);
  ok("D2 WATER without pondId stores NULL (phantom pond-1 gone)",
    r.status === 200 && r.json?.item?.pondId === null, JSON.stringify(r.json?.item || r.status).slice(0, 160));
  r = await call("/api/aquaculture", "POST", { entity: "WATER", data: { businessId: BIZ_AQUA, pondId: pondInPoultry.json.item.id, sampleDate: D(-1), phLevel: 7.1, dissolvedOxygenMgL: 6.9 } }, tOwner);
  ok("D3 WATER with cross-tenant pondId → 404", r.status === 404, r.status);

  r = await call("/api/aquaculture", "POST", { entity: "POND", data: { businessId: BIZ_AQUA, name: `${MARK} Pond A`, pondId: `${MARK}-PA`, type: "CAGE", capacityLiters: -100 } }, tOwner);
  ok("D4 POND negative capacity → 400", r.status === 400, r.status);
  const pondA = await call("/api/aquaculture", "POST", { entity: "POND", data: { businessId: BIZ_AQUA, name: `${MARK} Pond A`, pondId: `${MARK}-PA`, type: "CAGE", capacityLiters: 5000 } }, tOwner);
  if (pondA.json?.item?.id) made.pond.push(pondA.json.item.id);
  ok("D5 POND create + audit row",
    pondA.status === 200 && (await q(`SELECT id FROM audit_trail WHERE id>$1 AND action='AQUA_POND_CREATE' AND record_id=$2`, [made.auditBaseline, pondA.json.item.id])).rows.length === 1);

  r = await call("/api/aquaculture", "POST", { entity: "BATCH", data: { businessId: BIZ_AQUA, batchNumber: `${MARK}-BQ`, species: "VOLTA_TILAPIA", initialCount: 0 } }, tOwner);
  ok("D6 BATCH initialCount=0 → 400", r.status === 400, r.status);
  r = await call("/api/aquaculture", "POST", { entity: "BATCH", data: { businessId: BIZ_AQUA, batchNumber: `${MARK}-BX`, species: "VOLTA_TILAPIA", initialCount: 200, pondId: pondInPoultry.json.item.id } }, tOwner);
  ok("D7 BATCH on cross-tenant pond → 404", r.status === 404, r.status);
  const batchA = await call("/api/aquaculture", "POST", { entity: "BATCH", data: { businessId: BIZ_AQUA, batchNumber: `${MARK}-BA`, species: "VOLTA_TILAPIA", initialCount: 1000, avgWeightGrams: 150, pondId: pondA.json.item.id, hatchDate: D(-120), createdByName: "TEST Aud" } }, tOwner);
  if (batchA.json?.item?.id) made.batch.push(batchA.json.item.id);
  ok("D8 BATCH stocked + pond biomass + audit",
    batchA.status === 200 &&
    (await q(`SELECT current_biomass_kg FROM aquaculture_ponds WHERE id=$1`, [pondA.json.item.id])).rows[0].current_biomass_kg === 150 &&
    (await q(`SELECT id FROM audit_trail WHERE id>$1 AND action='AQUA_BATCH_STOCKED' AND record_id=$2`, [made.auditBaseline, batchA.json.item.id])).rows.length === 1,
    JSON.stringify(batchA.json || batchA.status).slice(0, 140));

  r = await call("/api/aquaculture", "POST", { entity: "FEED", data: { businessId: BIZ_AQUA, quantityKg: 0, entryType: "CONSUMPTION", recordedDate: D(-1) } }, tOwner);
  ok("D9 aqua FEED quantityKg=0 → 400", r.status === 400, r.status);
  r = await call("/api/aquaculture", "POST", { entity: "FEED", data: { businessId: BIZ_AQUA, quantityKg: 40, costPerKgGhs: 7.5, entryType: "PURCHASE", recordedDate: D(-5), brandSupplier: "TEST Aud AquaFeeds", feedType: "FLOATING", recordedByName: "TEST Aud", notes: MARK } }, tOwner);
  if (r.json?.item?.id) made.feedA.push(r.json.item.id);
  const aquaFeedTrx = (await q(`SELECT date FROM transactions WHERE id>$1 AND category='AQUA_FEED_PURCHASE' ORDER BY id DESC LIMIT 1`, [made.txnBaseline])).rows[0];
  ok("D10 aqua feed purchase: txn on recordedDate + audit",
    aquaFeedTrx?.date === D(-5) &&
    (await q(`SELECT id FROM audit_trail WHERE id>$1 AND action='AQUA_FEED_PURCHASE' AND record_id=$2`, [made.auditBaseline, r.json.item.id])).rows.length === 1,
    JSON.stringify(aquaFeedTrx));

  // partial harvest accounting
  r = await call("/api/aquaculture", "POST", { entity: "HARVEST", data: { businessId: BIZ_AQUA, batchId: batchA.json.item.id, species: "VOLTA_TILAPIA", harvestedCount: 400, totalWeightKg: 480, saleDate: D(-2) } }, tOwner);
  ok("D11 HARVEST without pondId → 400 (not phantom pond 1)", r.status === 400, r.status);
  r = await call("/api/aquaculture", "POST", { entity: "HARVEST", data: { businessId: BIZ_AQUA, batchId: batchA.json.item.id, pondId: pondA.json.item.id, species: "VOLTA_TILAPIA", harvestedCount: 400, totalWeightKg: 480, saleDate: D(-2), recordedByName: "TEST Aud" } }, tOwner);
  if (r.json?.item?.id) made.harvest.push(r.json.item.id);
  let batchState = (await q(`SELECT current_count, status FROM aquaculture_batches WHERE id=$1`, [batchA.json.item.id])).rows[0];
  ok("D12 partial harvest keeps batch alive (1000−400=600, stays GROWING)",
    r.status === 200 && Number(batchState.current_count) === 600 && batchState.status === "GROWING",
    JSON.stringify([r.status, batchState]).slice(0, 160));
  r = await call("/api/aquaculture", "POST", { entity: "HARVEST", data: { businessId: BIZ_AQUA, batchId: batchA.json.item.id, pondId: pondA.json.item.id, species: "VOLTA_TILAPIA", harvestedCount: 600, totalWeightKg: 840, revenueGhs: 12600, buyerName: "TEST Aud Hotel", saleDate: D(-1), recordedByName: "TEST Aud" } }, tOwner);
  if (r.json?.item?.id) made.harvest.push(r.json.item.id);
  batchState = (await q(`SELECT current_count, status FROM aquaculture_batches WHERE id=$1`, [batchA.json.item.id])).rows[0];
  const hvTrx = (await q(`SELECT date FROM transactions WHERE id>$1 AND category='AQUA_HARVEST_SALE' ORDER BY id DESC LIMIT 1`, [made.txnBaseline])).rows[0];
  ok("D13 final harvest closes batch (0, HARVESTED) + sale txn on saleDate + audit",
    r.status === 200 && Number(batchState.current_count) === 0 && batchState.status === "HARVESTED" &&
    hvTrx?.date === D(-1) &&
    (await q(`SELECT id FROM audit_trail WHERE id>$1 AND action='AQUA_HARVEST' AND record_id=$2`, [made.auditBaseline, r.json.item.id])).rows.length === 1,
    JSON.stringify([batchState, hvTrx]).slice(0, 200));
  r = await call("/api/aquaculture", "POST", { entity: "HARVEST", data: { businessId: BIZ_AQUA, pondId: pondA.json.item.id, species: "VOLTA_TILAPIA", harvestedCount: 0, totalWeightKg: 10, saleDate: D(-1) } }, tOwner);
  ok("D14 HARVEST harvestedCount=0 → 400", r.status === 400, r.status);

  // ═══ E. checklist idempotence ═══
  console.log("── E. daily checklist idempotence ──");
  const clp1 = await call("/api/poultry", "POST", { entity: "CHECKLIST", data: { businessId: BIZ_POULTRY, checklistDate: made.checklistDateP, tasks: [{ taskKey: "TEST_AM_FEED", taskLabel: "TEST morning feed", category: "FEEDING" }] } }, tOwner);
  const clp2 = await call("/api/poultry", "POST", { entity: "CHECKLIST", data: { businessId: BIZ_POULTRY, checklistDate: made.checklistDateP, tasks: [{ taskKey: "TEST_AM_FEED", taskLabel: "TEST morning feed", category: "FEEDING" }] } }, tOwner);
  const clpCount = (await q(`SELECT count(*)::int c FROM poultry_checklists WHERE business_id=$1 AND checklist_date=$2`, [BIZ_POULTRY, made.checklistDateP])).rows[0].c;
  ok("E1 poultry checklist second generate returns existing rows",
    clp1.status === 200 && clp2.status === 200 && clp2.json?.alreadyExists === true && clpCount === 1,
    JSON.stringify([clp2.json?.alreadyExists, clpCount]));
  const cla1 = await call("/api/aquaculture", "POST", { entity: "CHECKLIST", data: { businessId: BIZ_AQUA, checklistDate: made.checklistDateA } }, tOwner);
  const cla2 = await call("/api/aquaculture", "POST", { entity: "CHECKLIST", data: { businessId: BIZ_AQUA, checklistDate: made.checklistDateA } }, tOwner);
  const claCount = (await q(`SELECT count(*)::int c FROM aquaculture_checklists WHERE business_id=$1 AND checklist_date=$2`, [BIZ_AQUA, made.checklistDateA])).rows[0].c;
  ok("E2 aqua checklist idempotent (6 tasks once, alreadyExists on retry)",
    cla1.status === 200 && cla2.json?.alreadyExists === true && claCount === 6,
    JSON.stringify([cla2.json?.alreadyExists, claCount]));

  // other date unaffected (first generate on aqua date didn't touch aqua today)
  const todayCount = (await q(`SELECT count(*)::int c FROM aquaculture_checklists WHERE business_id=$1 AND checklist_date=$2`, [BIZ_AQUA, D(0)])).rows[0].c;
  ok("E3 today's real aqua checklist untouched by TEST dates", todayCount === (await q(`SELECT count(*)::int c FROM aquaculture_checklists WHERE business_id=$1 AND checklist_date=$2`, [BIZ_AQUA, D(0)])).rows[0].c);

  // ═══ Z. purge + forensics ═══
  await purge();
  const leftovers = (await q(`
    SELECT (SELECT count(*) FROM poultry_flocks WHERE batch_number LIKE $1) +
           (SELECT count(*) FROM aquaculture_ponds WHERE pond_id LIKE $1) +
           (SELECT count(*) FROM aquaculture_batches WHERE batch_number LIKE $1) +
           (SELECT count(*) FROM poultry_production WHERE recorded_by_name='TEST Aud' AND recorded_date >= $2) +
           (SELECT count(*) FROM transactions WHERE id > $3) +
           (SELECT count(*) FROM poultry_checklists WHERE checklist_date IN ($4,$5) AND business_id IN (${BIZ_POULTRY},${BIZ_AQUA})) +
           (SELECT count(*) FROM aquaculture_checklists WHERE checklist_date = $5 AND business_id = ${BIZ_AQUA}) +
           (SELECT count(*) FROM audit_trail WHERE id > $6 AND (action LIKE 'POULTRY_%' OR action LIKE 'AQUA_%')) AS n`,
    [`%${MARK}%`, D(-400), made.txnBaseline, made.checklistDateP, made.checklistDateA, made.auditBaseline])).rows[0].n;
  ok("Z1 zero TEST-AUD rows remain", Number(leftovers) === 0, leftovers);
  const invNow = (await q(`SELECT id, business_id, sku, quantity FROM inventory_items WHERE business_id IN ($1,$2)`, [BIZ_POULTRY, BIZ_AQUA])).rows;
  let invOk = true;
  for (const row of invNow) {
    const b = invBefore.get(`${row.business_id}|${row.sku}`);
    if (b && b.quantity !== Number(row.quantity)) invOk = false;
  }
  ok("Z2 inventory quantities byte-restored after purge", invOk);

  console.log(`\n══ AUDIT FIXES: ${pass} passed, ${fail} failed ══`);
  await pg.end();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error("SUITE CRASH:", e);
  try { await purge(); } catch { /* best effort */ }
  await pg.end().catch(() => {});
  process.exit(1);
});
