// Fish Benchmarking DEMO data seeder — makes the Fish Batch Performance
// Benchmarking system come alive on the AQUA-01 farm (business 3):
//   • 2 benchmark profiles (tilapia + catfish, from the built-in templates)
//   • 3 ponds/tank (2 earth ponds + 1 catfish tank)
//   • 1 GROWING tilapia batch mid-cycle (slightly behind target + overfed →
//     WATCH/OFF_TRACK variance + benchmark alerts on the dashboard)
//   • 1 GROWING catfish batch (on-target → scorecard A story)
//   • 2 HARVESTED historical tilapia batches (full ~28-week cycles) →
//     age-matched farm-history bands + medians
//   • water-quality rows for the demo ponds
// Everything goes through the REAL APIs (single-booking; harvests stock in +
// sell out of Inventory and book INCOME transactions). Idempotent: skips
// when the demo batches already exist.
//
// Run: node dev-tooling/seed-fish-benchmark-demo.mjs
const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.OWNER_PW || "Owner@GoMina26" };
const BIZ = 3; // AQUA-01 — Mina Volta Tilapia & Catfish

const D = (offsetDays) => { const d = new Date(); d.setDate(d.getDate() - Number(offsetDays)); return d.toISOString().split("T")[0]; };

const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: OWNER.email, password: OWNER.pw }),
});
if (!login.ok) { console.error("owner login failed:", login.status); process.exit(1); }
const cookie = login.headers.get("set-cookie").split(";")[0];
console.log("✔ owner login");

async function api(path, body, method = "POST") {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  const d = await res.json().catch(() => ({}));
  if (!d.success) throw new Error(`${method} ${path} → ${res.status}: ${d.error || "unknown"}`);
  return d;
}

// ── 0. current state ────────────────────────────────────────────────────
const aqua = await fetch(`${BASE}/api/aquaculture?businessId=${BIZ}`, { headers: { cookie } }).then((r) => r.json());
if (!aqua.success) throw new Error("could not load aquaculture data");
const demoExists = (aqua.batches || []).some((b) => b.batchNumber === "FB-DEMO-T01");

// ── 1. benchmark profiles (idempotent by name) ─────────────────────────
const prof = await fetch(`${BASE}/api/aquaculture/benchmarks?businessId=${BIZ}`, { headers: { cookie } }).then((r) => r.json());
if (!prof.success) throw new Error("could not load fish benchmark profiles");
const tplTilapia = prof.templates.find((t) => t.species === "VOLTA_TILAPIA");
const tplCatfish = prof.templates.find((t) => t.species === "AFRICAN_CATFISH");
const TILAPIA_PROFILE = "Volta Tilapia — GoMina Farm Target";
const CATFISH_PROFILE = "African Catfish — GoMina Farm Target";
if (!prof.profiles.some((p) => p.name === TILAPIA_PROFILE)) {
  await api("/api/aquaculture/benchmarks", {
    entity: "PROFILE",
    data: {
      businessId: BIZ, name: TILAPIA_PROFILE, species: "VOLTA_TILAPIA", isDefault: true,
      toleranceWarnPct: 5, toleranceCritPct: 10, curves: tplTilapia.curves,
      notes: "Copied from the tilapia species template — adjust to this farm's strain and feed program.",
      createdByName: "Demo Seeder", createdByRole: "OWNER",
    },
  });
  console.log("✔ tilapia benchmark profile created (default)");
} else console.log("· tilapia profile already present");
if (!prof.profiles.some((p) => p.name === CATFISH_PROFILE)) {
  await api("/api/aquaculture/benchmarks", {
    entity: "PROFILE",
    data: {
      businessId: BIZ, name: CATFISH_PROFILE, species: "AFRICAN_CATFISH", isDefault: true,
      toleranceWarnPct: 5, toleranceCritPct: 10, curves: tplCatfish.curves,
      notes: "Copied from the African catfish species template.",
      createdByName: "Demo Seeder", createdByRole: "OWNER",
    },
  });
  console.log("✔ catfish benchmark profile created (default)");
} else console.log("· catfish profile already present");

// ── 2. ponds (idempotent by pondId) ─────────────────────────────────────
const ponds = {};
for (const [key, pondId, name, type, liters] of [
  ["T1", "POND-DEMO-T1", "Demo Tilapia Pond A", "EARTH_POND", 400000],
  ["T2", "POND-DEMO-T2", "Demo Tilapia Pond B", "EARTH_POND", 400000],
  ["C1", "POND-DEMO-C1", "Demo Catfish Tank 1", "TANK", 60000],
]) {
  let pond = (aqua.ponds || []).find((p) => p.pondId === pondId);
  if (!pond) {
    const { item } = await api("/api/aquaculture", {
      entity: "POND",
      data: { businessId: BIZ, pondId, name, type, capacityLiters: liters, status: "STOCKED", notes: "Demo benchmark pond (seeded)." },
    });
    pond = item;
    console.log(`✔ pond ${pondId} created`);
  } else console.log(`· pond ${pondId} already present`);
  ponds[key] = pond;
}

if (demoExists) {
  console.log("· demo batches already present — nothing else to do");
  process.exit(0);
}

// ── helpers ─────────────────────────────────────────────────────────────
const postBatch = (data) => api("/api/aquaculture", { entity: "BATCH", data });
const postWeight = (data) => api("/api/aquaculture", { entity: "WEIGHT", data });
const postFeed = (data) => api("/api/aquaculture", { entity: "FEED", data });
const postHarvest = (data) => api("/api/aquaculture", { entity: "HARVEST", data });
const postWater = (data) => api("/api/aquaculture", { entity: "WATER", data });

const daysAgoOf = (batch, ageDay) =>
  Math.round((Date.now() - new Date(batch.hatchDate).getTime()) / 86400000) - ageDay;

/** piecewise-linear interpolation on [[age, value]] points */
const interp = (points, x) => {
  const pts = points.filter((p) => x >= p[0]);
  if (!pts.length) return points[0][1];
  const p = pts[pts.length - 1];
  const i = points.indexOf(p);
  const next = points[i + 1];
  if (!next || next[0] === p[0]) return p[1];
  return p[1] + ((next[1] - p[1]) * (x - p[0])) / (next[0] - p[0]);
};

// Template feeding-rate curves (kept in sync with FISH_BENCHMARK_TEMPLATES —
// the demo farm feeds "by the book", so on-target batches benchmark green).
const RATE_TILAPIA = [[14, 8], [28, 6], [56, 4.3], [84, 3.2], [112, 2.3], [140, 1.7], [168, 1.3], [196, 1.1]];
const RATE_CATFISH = [[14, 10], [28, 8], [56, 4.1], [84, 3.0], [112, 2.3], [140, 1.7], [168, 1.3], [196, 1.05]];

/** weight (g) at an age day, interpolated between the batch's samples */
const weightAt = (samples, day) => interp(samples, day);

/**
 * Feed a batch from its first sample age to `toDay`, ONE CONSUMPTION row per
 * day (the engine's feeding-rate KPI reads each row as one day's ration).
 * Ration = rate(age) × biomass, rate from the species template ×
 * `rateFactor` (1 = by the book).
 */
async function seedFeed({ batch, samples, alive, rateCurve, rateFactor, feedType, costPerKg, fromDay, toDay, supplier }) {
  let totalKg = 0;
  for (let day = fromDay; day <= toDay; day++) {
    const g = weightAt(samples, day);
    const rate = interp(rateCurve, day) * rateFactor; // % of biomass/day
    const kg = +(((rate / 100) * (g / 1000) * alive)).toFixed(2);
    if (kg <= 0) continue;
    totalKg += kg;
    await postFeed({
      businessId: BIZ, batchId: batch.id, pondId: batch.pondId || null,
      feedType, entryType: "CONSUMPTION", quantityKg: kg, costPerKgGhs: costPerKg,
      brandSupplier: supplier,
      recordedDate: D(daysAgoOf(batch, day)),
      recordedByName: "Demo Seeder", recordedByRole: "OWNER",
    });
  }
  return +totalKg.toFixed(0);
}

const seedWeights = async (batch, samples) => {
  for (const [day, g] of samples) {
    await postWeight({
      businessId: BIZ, batchId: batch.id, sampleSize: 30, avgWeightG: g,
      recordedDate: D(daysAgoOf(batch, day)),
      notes: "demo growth sample", recordedByName: "Demo Seeder", recordedByRole: "OWNER",
    });
  }
};

// ── 3. GROWING tilapia batch — slightly behind target and overfed ──────
{
  const samples = [[28, 16], [42, 32], [56, 58], [70, 95], [84, 138], [98, 180], [112, 222], [120, 247]];
  const { item: t01 } = await postBatch({
    businessId: BIZ, batchNumber: "FB-DEMO-T01", pondId: ponds.T2.id,
    species: "VOLTA_TILAPIA", strainGenetics: "Akosombo strain",
    hatchDate: D(120), initialCount: 10000, currentCount: 9520, mortalityTotal: 480,
    costPerFingerlingGhs: 1.10, targetHarvestDate: D(-76),
    notes: "Demo — current tilapia cycle (growth trailing target).",
    createdByName: "Demo Seeder", createdByRole: "OWNER",
  });
  await seedWeights(t01, samples);
  const feedKg = await seedFeed({
    batch: t01, samples, alive: 9520, rateCurve: RATE_TILAPIA, rateFactor: 1.12,
    feedType: "FLOATING", costPerKg: 6.1, fromDay: 28, toDay: 120,
    supplier: "Raanan Tilapia Feed",
  });
  console.log(`✔ FB-DEMO-T01 growing tilapia + logs (${feedKg} kg feed)`);
}

// ── 4. GROWING catfish batch — on target ───────────────────────────────
{
  const samples = [[28, 22], [42, 55], [56, 92], [70, 150], [84, 228]];
  const { item: c01 } = await postBatch({
    businessId: BIZ, batchNumber: "FB-DEMO-C01", pondId: ponds.C1.id,
    species: "AFRICAN_CATFISH", strainGenetics: "Clarias gariepinus × Heterobranchus hybrid",
    hatchDate: D(84), initialCount: 6000, currentCount: 5760, mortalityTotal: 240,
    costPerFingerlingGhs: 1.6, targetHarvestDate: D(-112),
    notes: "Demo — current catfish cycle (on target).",
    createdByName: "Demo Seeder", createdByRole: "OWNER",
  });
  await seedWeights(c01, samples);
  const feedKg = await seedFeed({
    batch: c01, samples, alive: 5760, rateCurve: RATE_CATFISH, rateFactor: 0.72,
    feedType: "SINKING", costPerKg: 6.8, fromDay: 28, toDay: 84,
    supplier: "Aqualis Catfish Pellet",
  });
  console.log(`✔ FB-DEMO-C01 growing catfish + logs (${feedKg} kg feed)`);
}

// ── 5. historical tilapia cycles (HARVESTED → farm-history bands) ──────
async function historicalTilapia({ batch, pond, hatchDaysAgo, cycleDays, initial, mortality, samples, rateFactor, feedCost, harvests }) {
  const preHarvest = initial - mortality;
  const { item: b } = await postBatch({
    businessId: BIZ, batchNumber: batch, pondId: pond.id,
    species: "VOLTA_TILAPIA", strainGenetics: "Akosombo strain",
    hatchDate: D(hatchDaysAgo), initialCount: initial, currentCount: preHarvest, mortalityTotal: mortality,
    costPerFingerlingGhs: 1.0,
    notes: "Demo — completed tilapia cycle.",
    createdByName: "Demo Seeder", createdByRole: "OWNER",
  });
  await seedWeights(b, samples);
  const feedKg = await seedFeed({
    batch: b, samples, alive: preHarvest, rateCurve: RATE_TILAPIA, rateFactor,
    feedType: "FLOATING", costPerKg: feedCost, fromDay: 28, toDay: cycleDays - 1,
    supplier: "Raanan Tilapia Feed",
  });
  let sold = 0;
  for (const h of harvests) {
    sold += h.count;
    await postHarvest({
      businessId: BIZ, batchId: b.id, pondId: pond.id, species: "VOLTA_TILAPIA",
      harvestedCount: h.count, totalWeightKg: h.kg, revenueGhs: h.revenue,
      saleDate: D(daysAgoOf(b, cycleDays)), buyerName: h.buyer,
      recordedByName: "Demo Seeder", recordedByRole: "OWNER",
    });
  }
  console.log(`✔ ${batch} harvested cycle + logs (${feedKg} kg feed, ${sold} fish out)`);
}

// good cycle: 91% survival, 505g average, sold at GH₵62/kg
await historicalTilapia({
  batch: "FB-DEMO-T02", pond: ponds.T2, hatchDaysAgo: 336, cycleDays: 196,
  initial: 10000, mortality: 900,
  samples: [[28, 15], [56, 62], [84, 145], [112, 250], [140, 355], [168, 445], [196, 515]],
  rateFactor: 0.81, feedCost: 5.9,
  harvests: [
    { count: 6000, kg: 3090, revenue: 191580, buyer: "Ashaiman Market Traders" },
    { count: 3100, kg: 1510, revenue: 93620, buyer: "Labadi Beach Hotel" },
  ],
});
// difficult cycle: 86% survival, smaller fish, higher feed cost
await historicalTilapia({
  batch: "FB-DEMO-T03", pond: ponds.T1, hatchDaysAgo: 420, cycleDays: 182,
  initial: 8000, mortality: 1120,
  samples: [[28, 13], [56, 55], [84, 130], [112, 225], [140, 315], [168, 395], [182, 428]],
  rateFactor: 0.95, feedCost: 6.3,
  harvests: [
    { count: 6880, kg: 2940, revenue: 176400, buyer: "Ashaiman Market Traders" },
  ],
});

// ── 6. water-quality rows for the demo ponds ────────────────────────────
for (const [pond, doMin, doMax] of [[ponds.T1, 5.2, 6.4], [ponds.T2, 4.8, 6.2], [ponds.C1, 3.6, 4.8]]) {
  for (let i = 0; i < 4; i++) {
    await postWater({
      businessId: BIZ, pondId: pond.id, sampleDate: D(i * 3),
      phLevel: +(7.0 + (i % 3) * 0.3).toFixed(1),
      dissolvedOxygenMgL: +(doMin + ((doMax - doMin) * i) / 3).toFixed(1),
      temperatureC: +(27.5 + (i % 2) * 0.8).toFixed(1),
      ammoniaMgL: +(0.1 + (i % 2) * 0.08).toFixed(2),
      turbidity: i % 2 ? "MODERATE" : "CLEAR",
      recordedByName: "Demo Seeder", recordedByRole: "OWNER",
    });
  }
}
console.log("✔ water-quality rows for the demo ponds");

console.log("\nFISH BENCHMARK DEMO SEED COMPLETE");
console.log("Next: open AQUA-01 → Dashboard → Benchmark Performance panel (tilapia batch FB-DEMO-T01 is the story batch).");
