// Benchmarking DEMO data seeder — makes the Flock Performance Benchmarking
// system come alive on the POULTRY-01 flagship farm:
//   • 2 benchmark profiles (broiler + layer, from the built-in templates)
//   • 1 ACTIVE broiler flock mid-cycle (slightly behind target → WATCH)
//   • 3 historical broiler flocks (SOLD/CLOSED, full 42-day cycles) → band
//   • 1 historical layer flock (late-lay window) → layer band
//   • enrichment of the canonical layer flocks (eggs, egg weights, feed)
// Everything goes through the REAL APIs (single-booking, stock + finance
// side effects included). Idempotent: skips when demo flocks already exist.
//
// Run: node dev-tooling/seed-benchmark-demo.mjs
const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const OWNER = { email: "kwame.owner@gomina360.com", pw: process.env.OWNER_PW || "Owner@GoMina26" };

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
const poultry = await fetch(`${BASE}/api/poultry?businessId=1`, { headers: { cookie } }).then((r) => r.json());
if (!poultry.success) throw new Error("could not load poultry data");
const flockBy = (batch) => poultry.flocks.find((f) => f.batchNumber === batch);
const demoExists = flockBy("BENCH-DEMO-B01");

// ── 1. benchmark profiles (idempotent by name) ─────────────────────────
const prof = await fetch(`${BASE}/api/poultry/benchmarks?businessId=1`, { headers: { cookie } }).then((r) => r.json());
const tplBroiler = prof.templates.find((t) => t.birdType === "BROILERS");
const tplLayer = prof.templates.find((t) => t.birdType === "LAYERS");
const BROILER_PROFILE = "Cobb 500 / Ross 308 — GoMina Farm Target";
const LAYER_PROFILE = "Isa Brown / Lohmann — Layer Farm Target";
if (!prof.profiles.some((p) => p.name === BROILER_PROFILE)) {
  await api("/api/poultry/benchmarks", {
    entity: "PROFILE",
    data: {
      businessId: 1, name: BROILER_PROFILE, birdType: "BROILERS", isDefault: true,
      toleranceWarnPct: 5, toleranceCritPct: 10, curves: tplBroiler.curves,
      notes: "Copied from the Cobb 500 / Ross 308 breed template — adjust to this farm's genetics and feed program.",
      createdByName: "Demo Seeder", createdByRole: "OWNER",
    },
  });
  console.log("✔ broiler benchmark profile created");
} else console.log("· broiler profile already present");
if (!prof.profiles.some((p) => p.name === LAYER_PROFILE)) {
  await api("/api/poultry/benchmarks", {
    entity: "PROFILE",
    data: {
      businessId: 1, name: LAYER_PROFILE, birdType: "LAYERS", isDefault: true,
      toleranceWarnPct: 5, toleranceCritPct: 10, curves: tplLayer.curves,
      notes: "Copied from the Isa Brown / Lohmann layer template.",
      createdByName: "Demo Seeder", createdByRole: "OWNER",
    },
  });
  console.log("✔ layer benchmark profile created");
} else console.log("· layer profile already present");

// ── helpers ─────────────────────────────────────────────────────────────
const postFlock = (data) => api("/api/poultry", { entity: "FLOCK", data });
const patchFlock = (id, data) => api("/api/poultry", { entity: "FLOCK", id, data }, "PATCH");
const postWeight = (data) => api("/api/poultry", { entity: "WEIGHT", data });
const postFeed = (data) => api("/api/poultry", { entity: "FEED", data });
const postHealth = (data) => api("/api/poultry", { entity: "HEALTH", data });
const postProd = (data) => api("/api/poultry", { entity: "PRODUCTION", data });

/** daily feed consumption rows for a flock over an age-day range */
async function seedFeed(flock, fromDay, toDay, gPerBirdDay, costPerKg, feedType, supplier) {
  for (let day = fromDay; day <= toDay; day++) {
    const alive = Math.max(1, Math.round(flock.initialCount * (1 - (flock.mortalityTotal || 0) / flock.initialCount / 2 * (day / toDay))));
    const kg = +(gPerBirdDay(Math.min(day, toDay)) * alive / 1000).toFixed(1);
    if (kg <= 0) continue;
    await postFeed({
      businessId: 1, flockId: flock.id, batchNumber: flock.batchNumber,
      feedType, entryType: "CONSUMPTION", sourceType: "PURCHASED",
      quantityKg: kg, costPerKgGhs: costPerKg, brandSupplier: supplier,
      recordedDate: D(daysAgoOf(flock, day)), recordedByName: "Demo Seeder", recordedByRole: "OWNER",
    });
  }
}
const daysAgoOf = (flock, ageDay) =>
  Math.round((Date.now() - new Date(flock.arrivalDate).getTime()) / 86400000) - ageDay;

const seedWeights = async (flock, samplesG) => {
  for (const [day, g] of samplesG) {
    await postWeight({
      businessId: 1, flockId: flock.id, batchNumber: flock.batchNumber,
      weightKind: "BIRD", sampleSize: 30, avgWeightG: g,
      recordedDate: D(daysAgoOf(flock, day)), recordedByName: "Demo Seeder", recordedByRole: "OWNER",
    });
  }
};

const seedMortality = async (flock, events, note = "daily check") => {
  for (const [day, n, cost] of events) {
    await postHealth({
      businessId: 1, flockId: flock.id, batchNumber: flock.batchNumber,
      recordType: "MORTALITY", mortalityCount: n, costGhs: cost || 0,
      diseaseOrCondition: note, recordedDate: D(daysAgoOf(flock, day)),
      recordedByName: "Demo Seeder", recordedByRole: "OWNER",
    });
  }
};

if (demoExists) {
  console.log("· demo flocks already present — nothing else to do");
  process.exit(0);
}

// ── 2. ACTIVE broiler flock mid-cycle (slightly behind target) ─────────
{
  const { item: b1 } = await postFlock({
    businessId: 1, batchNumber: "BENCH-DEMO-B01", flockName: "Demo — current broiler cycle",
    birdType: "BROILERS", breed: "Cobb 500", supplier: "Akate Farms Hatchery",
    houseName: "House B", initialCount: 2500, currentCount: 2500, mortalityTotal: 0,
    arrivalDate: D(30), costPerBirdGhs: 7.5, status: "ACTIVE",
    createdByName: "Demo Seeder", createdByRole: "OWNER",
  });
  await seedWeights(b1, [[7, 185], [14, 460], [21, 820], [28, 1240], [30, 1350]]);
  await seedFeed(b1, 1, 30, (d) => (d <= 7 ? 23 : d <= 14 ? 43 : d <= 21 ? 71 : d <= 28 ? 99 : 108), 5.9, (d) => (d <= 14 ? "STARTER" : "GROWER"), "Ghafeed Poultry Mills");
  await seedMortality(b1, [[3, 20, 0], [7, 15, 120], [12, 12, 0], [18, 10, 0], [24, 8, 0], [29, 15, 180]], "early chick mortality / heat stress");
  await postHealth({
    businessId: 1, flockId: b1.id, batchNumber: b1.batchNumber,
    recordType: "VACCINATION", vaccineOrDrug: "Gumboro (intermediate)", dosage: "1 dose/bird via drinking water",
    administeredBy: "Dr. Selorm Gbeho", birdsAffected: 2420, costGhs: 480,
    recordedDate: D(daysAgoOf(b1, 14)), recordedByName: "Demo Seeder", recordedByRole: "OWNER",
  });
  console.log("✔ BENCH-DEMO-B01 active flock + logs");
}

// ── 3. historical broiler flocks (full 42-day cycles) ───────────────────
async function historicalBroiler({ batch, name, breed, arrivedDaysAgo, initial, mortality, weights, feedG, feedCost, harvest }) {
  const { item: f } = await postFlock({
    businessId: 1, batchNumber: batch, flockName: name,
    birdType: "BROILERS", breed, supplier: "Akate Farms Hatchery",
    houseName: "House A", initialCount: initial, currentCount: initial, mortalityTotal: 0,
    arrivalDate: D(arrivedDaysAgo), costPerBirdGhs: 7.2, status: "SOLD",
    createdByName: "Demo Seeder", createdByRole: "OWNER",
  });
  await seedWeights(f, weights);
  await seedFeed(f, 1, 42, feedG, feedCost, (d) => (d <= 14 ? "STARTER" : d <= 28 ? "GROWER" : "FINISHER"), "Ghafeed Poultry Mills");
  const quarters = Math.ceil(mortality / 8);
  await seedMortality(f, [5, 10, 16, 22, 28, 34, 38, 41].map((d, i) => [d, i === 7 ? mortality - quarters * 7 : quarters, 0]), "cycled out");
  await postProd({
    businessId: 1, flockId: f.id, batchNumber: f.batchNumber,
    productionType: "BROILER_WEIGHT", avgWeightKg: harvest.avgKg, birdsHarvested: harvest.birds,
    broilersSold: harvest.birds, // merchant took the whole lot — stock nets to zero
    totalWeightKg: harvest.kg, revenueGhs: harvest.revenue, revenueSource: "live-bird sale (merchant)",
    recordedDate: D(daysAgoOf(f, 42)), recordedByName: "Demo Seeder", recordedByRole: "OWNER",
  });
  // the merchant took the whole lot — the flock is sold out (mortality events
  // already drove mortalityTotal; currentCount lands at initial − mortality)
  await patchFlock(f.id, { currentCount: 0, notes: "42-day cycle sold out (demo)." });
  console.log(`✔ ${batch} historical flock + logs`);
}

await historicalBroiler({
  batch: "BENCH-DEMO-B02", name: "Demo — good previous cycle", breed: "Cobb 500",
  arrivedDaysAgo: 160, initial: 3000, mortality: 150,
  weights: [[7, 190], [14, 470], [21, 850], [28, 1320], [35, 1880], [42, 2470]],
  feedG: (d) => (d <= 7 ? 21 : d <= 14 ? 38 : d <= 21 ? 58 : d <= 28 ? 92 : d <= 35 ? 118 : 134),
  feedCost: 5.8,
  harvest: { birds: 2850, kg: 7040, avgKg: 2.47, revenue: 316800 },
});
await historicalBroiler({
  batch: "BENCH-DEMO-B03", name: "Demo — difficult cycle (different breed)", breed: "Ross 308",
  arrivedDaysAgo: 280, initial: 2800, mortality: 220,
  weights: [[7, 170], [14, 420], [21, 740], [28, 1140], [35, 1640], [42, 2140]],
  feedG: (d) => (d <= 7 ? 25 : d <= 14 ? 47 : d <= 21 ? 78 : d <= 28 ? 108 : d <= 35 ? 128 : 142),
  feedCost: 6.3,
  harvest: { birds: 2580, kg: 5620, avgKg: 2.18, revenue: 224800 },
});

// ── 4. close the canonical June broiler batch with its own cycle ───────
{
  const b02 = flockBy("BATCH-2026-B02");
  if (b02 && !(poultry.feedLogs || []).some((l) => l.batchNumber === "BATCH-2026-B02")) {
    await patchFlock(b02.id, { status: "CLOSED", notes: "42-day cycle completed end of July 2026 (demo backfill)." });
    const f = { ...b02, status: "CLOSED", currentCount: 0, arrivalDate: b02.arrivalDate };
    await seedWeights(f, [[7, 188], [14, 455], [21, 830], [28, 1290], [35, 1840], [42, 2430]]);
    await seedFeed(f, 1, 42, (d) => (d <= 7 ? 22 : d <= 14 ? 40 : d <= 21 ? 60 : d <= 28 ? 95 : d <= 35 ? 120 : 136), 6.0, (d) => (d <= 14 ? "STARTER" : d <= 28 ? "GROWER" : "FINISHER"), "Ghafeed Poultry Mills");
    // B02-old carries its canonical lifetime mortalityTotal (200) — spread it
    // as dated events so the mortality band has a real curve, then correct the
    // counters with one direct SQL write (PATCH cannot touch mortalityTotal).
    const quarters = Math.ceil(200 / 8);
    await seedMortality(f, [4, 9, 15, 21, 27, 33, 39, 42].map((d, i) => [d, i === 7 ? 200 - quarters * 7 : quarters, 0]), "cycled out");
    await postProd({
      businessId: 1, flockId: f.id, batchNumber: f.batchNumber,
      productionType: "BROILER_WEIGHT", avgWeightKg: 2.43, birdsHarvested: 2800,
      broilersSold: 2800, totalWeightKg: 6800, revenueGhs: 306000, revenueSource: "live-bird sale (merchant)",
      recordedDate: D(daysAgoOf(f, 42)), recordedByName: "Demo Seeder", recordedByRole: "OWNER",
    });
    {
      const req = (await import("node:module")).createRequire("/home/user/pgtooling/package.json");
      const pg = req("pg");
      const client = new pg.Client(process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db");
      await client.connect();
      await client.query("update poultry_flocks set mortality_total = 200, current_count = 0 where batch_number = 'BATCH-2026-B02'");
      await client.end();
    }
    console.log("✔ BATCH-2026-B02 closed + backfilled cycle");
  }
}

// ── 5. layer enrichment: canonical flocks + one closed historical ───────
{
  const l01 = flockBy("BATCH-2026-L01");
  if (l01 && !(poultry.production || []).some((p) => p.batchNumber === "BATCH-2026-L01")) {
    for (let i = 0; i < 10; i++) {
      const day = 27 - i * 3;
      const layPct = +(77 + Math.sin(i) * 1.5 + 1).toFixed(1);
      const eggs = Math.round((l01.currentCount || 4200) * layPct / 100);
      await postProd({
        businessId: 1, flockId: l01.id, batchNumber: l01.batchNumber,
        productionType: "EGGS", eggsCollected: eggs, traysProduced: Math.round(eggs / 30),
        crackedEggs: 12 + (i % 3) * 3, layPercentage: layPct,
        recordedDate: D(day), recordedByName: "Demo Seeder", recordedByRole: "OWNER",
      });
    }
    for (const [day, g] of [[20, 62.4], [14, 62.9], [8, 63.2], [2, 63.5]]) {
      await postWeight({
        businessId: 1, flockId: l01.id, batchNumber: l01.batchNumber, weightKind: "EGG",
        sampleSize: 60, avgWeightG: g, recordedDate: D(day),
        recordedByName: "Demo Seeder", recordedByRole: "OWNER",
      });
    }
    for (let day = 20; day >= 0; day--) {
      await postFeed({
        businessId: 1, flockId: l01.id, batchNumber: l01.batchNumber, feedType: "LAYER_MASH",
        entryType: "CONSUMPTION", sourceType: "PURCHASED", quantityKg: 462, costPerKgGhs: 5.2,
        brandSupplier: "Agricare Layer Mash", recordedDate: D(day),
        recordedByName: "Demo Seeder", recordedByRole: "OWNER",
      });
    }
    await seedMortality(l01, [[18, 5, 0], [6, 3, 350]], "old flock attrition");
    console.log("✔ BATCH-2026-L01 layer logs");
  }

  const l03 = flockBy("BATCH-2026-L03");
  if (l03 && !(poultry.production || []).some((p) => p.batchNumber === "BATCH-2026-L03")) {
    for (let i = 0; i < 6; i++) {
      const day = 20 - i * 4;
      const layPct = +(57 + (i % 3) * 2).toFixed(1);
      const eggs = Math.round((l03.currentCount || 2465) * layPct / 100);
      await postProd({
        businessId: 1, flockId: l03.id, batchNumber: l03.batchNumber,
        productionType: "EGGS", eggsCollected: eggs, traysProduced: Math.round(eggs / 30),
        crackedEggs: 9, layPercentage: layPct,
        recordedDate: D(day), recordedByName: "Demo Seeder", recordedByRole: "OWNER",
      });
    }
    for (const [day, g] of [[10, 65.1], [3, 65.4]]) {
      await postWeight({
        businessId: 1, flockId: l03.id, batchNumber: l03.batchNumber, weightKind: "EGG",
        sampleSize: 50, avgWeightG: g, recordedDate: D(day),
        recordedByName: "Demo Seeder", recordedByRole: "OWNER",
      });
    }
    for (let day = 11; day >= 0; day--) {
      await postFeed({
        businessId: 1, flockId: l03.id, batchNumber: l03.batchNumber, feedType: "LAYER_MASH",
        entryType: "CONSUMPTION", sourceType: "PURCHASED", quantityKg: 234, costPerKgGhs: 5.2,
        brandSupplier: "Agricare Layer Mash", recordedDate: D(day),
        recordedByName: "Demo Seeder", recordedByRole: "OWNER",
      });
    }
    console.log("✔ BATCH-2026-L03 layer logs");
  }

  // closed historical layer flock (late-lay window, weeks 44-56)
  const { item: hl } = await postFlock({
    businessId: 1, batchNumber: "BENCH-DEMO-L01", flockName: "Demo — previous layer cycle",
    birdType: "LAYERS", breed: "Isa Brown", supplier: "Akate Farms Hatchery",
    houseName: "House L", initialCount: 4000, currentCount: 4000, mortalityTotal: 0,
    arrivalDate: D(400), costPerBirdGhs: 6.8, status: "SOLD",
    createdByName: "Demo Seeder", createdByRole: "OWNER",
  });
  for (let wk = 44; wk <= 56; wk++) {
    const layPct = +(82 - (wk - 44) * 0.65).toFixed(1);
    const eggs = Math.round(3800 * layPct / 100);
    await postProd({
      businessId: 1, flockId: hl.id, batchNumber: hl.batchNumber,
      productionType: "EGGS", eggsCollected: eggs, traysProduced: Math.round(eggs / 30),
      crackedEggs: 14, layPercentage: layPct,
      recordedDate: D(daysAgoOf(hl, wk * 7)), recordedByName: "Demo Seeder", recordedByRole: "OWNER",
    });
  }
  for (const [wk, g] of [[45, 63.8], [50, 64.2], [55, 64.6]]) {
    await postWeight({
      businessId: 1, flockId: hl.id, batchNumber: hl.batchNumber, weightKind: "EGG",
      sampleSize: 60, avgWeightG: g, recordedDate: D(daysAgoOf(hl, wk * 7)),
      recordedByName: "Demo Seeder", recordedByRole: "OWNER",
    });
  }
  for (let day = 44 * 7; day <= 56 * 7; day++) {
    await postFeed({
      businessId: 1, flockId: hl.id, batchNumber: hl.batchNumber, feedType: "LAYER_MASH",
      entryType: "CONSUMPTION", sourceType: "PURCHASED", quantityKg: 425, costPerKgGhs: 5.35,
      brandSupplier: "Agricare Layer Mash", recordedDate: D(daysAgoOf(hl, day)),
      recordedByName: "Demo Seeder", recordedByRole: "OWNER",
    });
  }
  await seedMortality(hl, [[320, 60, 0], [350, 55, 0], [380, 90, 0], [392, 75, 0]], "end-of-lay attrition");
  await patchFlock(hl.id, { currentCount: 0, notes: "Flock sold after 56-week lay cycle (demo)." });
  console.log("✔ BENCH-DEMO-L01 historical layer flock");
}

console.log("\nBENCHMARK DEMO SEED COMPLETE");
console.log("Next: open POULTRY-01 → Dashboard → Benchmark Performance panel.");
