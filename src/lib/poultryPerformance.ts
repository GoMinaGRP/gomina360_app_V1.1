// Pure poultry production & growth analytics for the Poultry dashboard.
// Everything here is data-in/data-out (no React) so every series the charts
// render can be reproduced and verified directly from the database.

export interface PoultryPerfFilters {
  /** Parent dashboard quick date filter: ALL | TODAY | LAST_7 | LAST_30 */
  dateFilter?: string;
  /** ALL | EGGS | BROILERS (parent product filter) */
  productFilter?: string;
  /** Exact batch number, or ALL */
  batchNumber?: string;
  /** Flock id, or null for all */
  flockId?: number | null;
  /** Branch code, or ALL */
  branchCode?: string;
}

const TODAY = () => new Date().toISOString().split("T")[0];

/** Mirrors the dashboard's matchesDashDate semantics exactly. */
export function withinDateFilter(dateStr: string | undefined | null, dateFilter?: string): boolean {
  if (!dateStr) return false;
  const f = dateFilter || "ALL";
  if (f === "ALL") return true;
  const today = TODAY();
  if (f === "TODAY") return dateStr === today;
  const limit = new Date();
  if (f === "LAST_7") limit.setDate(limit.getDate() - 7);
  else if (f === "LAST_30") limit.setDate(limit.getDate() - 30);
  else return true;
  return new Date(dateStr) >= limit;
}

const ageDaysBetween = (arrival: string, date: string) =>
  Math.max(0, Math.round((new Date(date).getTime() - new Date(arrival).getTime()) / 86400000));

/** Broiler target live weight (kg) by age in days — industry standard curve
 *  (Cobb 500 / Ross 308 performance objectives, as-hatched average). */
export function broilerTargetKg(ageDays: number): number {
  const pts: [number, number][] = [
    [0, 0.042], [7, 0.19], [14, 0.47], [21, 0.85], [28, 1.33], [35, 1.9], [42, 2.5], [49, 3.02], [56, 3.48],
  ];
  if (ageDays <= 0) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (ageDays <= pts[i][0]) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      return +(y0 + ((y1 - y0) * (ageDays - x0)) / (x1 - x0)).toFixed(3);
    }
  }
  return pts[pts.length - 1][1];
}

/** Layer target body weight (kg) by age in days (Isa Brown / Lohmann
 *  management guide): pullets reach ~1.5kg at point of lay (~18 wks),
 *  mature at ~1.9–2.0kg. */
export function layerTargetKg(ageDays: number): number {
  const wks = ageDays / 7;
  const pts: [number, number][] = [
    [0, 0.04], [3, 0.19], [6, 0.45], [9, 0.78], [12, 1.15], [15, 1.4],
    [18, 1.55], [21, 1.7], [25, 1.83], [30, 1.9], [40, 1.95], [60, 2.0], [90, 2.05],
  ];
  if (wks <= 0) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (wks <= pts[i][0]) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      return +(y0 + ((y1 - y0) * (wks - x0)) / (x1 - x0)).toFixed(3);
    }
  }
  return pts[pts.length - 1][1];
}

/** Layer target egg weight (g) by flock age in weeks (Isa Brown guide):
 *  ~48g small eggs at onset, ~65–66g extra-large at end of lay. */
export function eggWeightTargetG(ageWeeks: number): number {
  const pts: [number, number][] = [
    [18, 47], [20, 49], [24, 55], [28, 58], [32, 60], [36, 61.5],
    [40, 62.5], [45, 63.5], [50, 64], [60, 65], [80, 66],
  ];
  if (ageWeeks <= 18) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (ageWeeks <= pts[i][0]) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      return +(y0 + ((y1 - y0) * (ageWeeks - x0)) / (x1 - x0)).toFixed(1);
    }
  }
  return pts[pts.length - 1][1];
}

/** Layer target lay percentage by age in weeks (Hy-Line / Isa Brown guide):
 *  ramp from point of lay (~19–20 wks) to ~92% peak at 25–38 wks, then a
 *  gentle decline. */
export function layerTargetLayPct(ageWeeks: number): number {
  if (ageWeeks < 19) return 0;
  if (ageWeeks < 20) return 30;
  if (ageWeeks < 21) return 50;
  if (ageWeeks < 22) return 62;
  if (ageWeeks < 23) return 72;
  if (ageWeeks < 24) return 81;
  if (ageWeeks < 25) return 88;
  if (ageWeeks <= 38) return 92;
  return Math.max(60, +(92 - (ageWeeks - 38) * 0.5).toFixed(1));
}

const MEAN = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export interface PoultryPerfResult {
  /** Daily average live weight (kg) vs breed-standard target */
  growthTrend: { date: string; avgWeightKg: number; targetKg: number }[];
  /** Average live weight (kg) bucketed by flock age (weeks) vs target */
  weightByAge: { age: string; avgWeightKg: number; targetKg: number }[];
  /** Daily feed consumption (kg) */
  feedDaily: { date: string; kg: number }[];
  /** Daily feed conversion ratio (recorded), kg feed per kg gain */
  fcrTrend: { date: string; fcr: number }[];
  /** Daily deaths + cumulative mortality % of placed birds */
  mortalityDaily: { date: string; deaths: number; cumMortPct: number }[];
  /** Daily broiler harvests (birds + total kg) */
  broilerDaily: { date: string; harvested: number; weightKg: number }[];
  /** Daily lay % vs age-standard target */
  layTrend: { date: string; layPct: number; targetPct: number }[];
  /** Daily egg output (pieces) in scope */
  eggDaily: { date: string; eggs: number; trays: number }[];
  /** Daily average egg weight (g) vs age-standard target, linked to the
   *  eggs collected + feed consumed the same day (production & feed join) */
  eggWeightDaily: { date: string; avgG: number; targetG: number; eggs: number; feedKg: number }[];
  /** Daily estimated standing biomass (kg) = avg sampled live weight ×
   *  estimated birds alive that day (current + later deaths + later harvests) */
  biomassDaily: { date: string; biomassKg: number }[];
  kpis: {
    totalFeedKg: number;
    avgFcr: number | null;
    livabilityPct: number | null;
    totalDeaths: number;
    avgDailyGainG: number | null;
    peakLayPct: number | null;
    eggsPerHenDay: number | null;
    feedPerBirdG: number | null;
    birdsHarvested: number;
    eggs: number;
    placed: number;
    /** FCR derived from weight samples × feed rows (batch/flock scope) */
    calcFcr: number | null;
    /** Latest average egg weight (g) from daily egg weighing */
    avgEggWeightG: number | null;
    /** Latest estimated standing biomass (kg) */
    biomassKg: number | null;
  };
}

const isWeightRecord = (p: any) =>
  (p.productionType === "BROILER_WEIGHT" || p.productionType === "BROILER") && (p.avgWeightKg || 0) > 0;

export function computePoultryPerformance(
  {
    flocks,
    feedLogs,
    healthRecords,
    production,
    weightLogs = [],
  }: { flocks: any[]; feedLogs: any[]; healthRecords: any[]; production: any[]; weightLogs?: any[] },
  filters: PoultryPerfFilters,
): PoultryPerfResult {
  const batchOf = (row: any) => row.batchNumber || null;
  const flockByBatch = new Map(flocks.map((f) => [f.batchNumber, f]));
  const flockById = new Map(flocks.map((f) => [f.id, f]));

  // Product filter maps to bird type (same rule as the dashboard).
  const birdTypeOk = (row: any) => {
    const pf = filters.productFilter || "ALL";
    if (pf === "ALL") return true;
    const flock = (row.flockId && flockById.get(row.flockId)) || flockByBatch.get(batchOf(row));
    // Production rows carry their own productionType — that is authoritative.
    if (row.productionType) {
      if (pf === "EGGS") return row.productionType === "EGGS";
      if (pf === "BROILERS") return row.productionType === "BROILER_WEIGHT" || row.productionType === "BROILER";
    }
    if (!flock) return true; // unlinked rows stay visible
    return pf === "EGGS" ? flock.birdType === "LAYERS" : flock.birdType === "BROILERS";
  };
  const keep = (row: any, dateField = "recordedDate") =>
    withinDateFilter(row[dateField], filters.dateFilter) &&
    birdTypeOk(row) &&
    (!filters.batchNumber || filters.batchNumber === "ALL" || batchOf(row) === filters.batchNumber) &&
    (!filters.flockId || row.flockId === filters.flockId || batchOf(row) === flockById.get(filters.flockId)?.batchNumber) &&
    (!filters.branchCode || filters.branchCode === "ALL" || row.branchCode === filters.branchCode);

  const prod = (production || []).filter((p) => keep(p));
  const feed = (feedLogs || []).filter((f) => keep(f) && f.entryType === "CONSUMPTION");
  const health = (healthRecords || []).filter((h) => keep(h));
  const wlogs = (weightLogs || []).filter((w) => keep(w));
  const birdLogs = wlogs.filter((w) => w.weightKind === "BIRD" && (w.avgWeightG || 0) > 0);
  const eggLogs = wlogs.filter((w) => w.weightKind === "EGG" && (w.avgWeightG || 0) > 0);

  const selFlocks = (flocks || []).filter(
    (f) =>
      (!filters.batchNumber || filters.batchNumber === "ALL" || f.batchNumber === filters.batchNumber) &&
      (!filters.flockId || f.id === filters.flockId) &&
      (!filters.branchCode || filters.branchCode === "ALL" || f.branchCode === filters.branchCode) &&
      (filters.productFilter === "EGGS"
        ? f.birdType === "LAYERS"
        : filters.productFilter === "BROILERS"
          ? f.birdType === "BROILERS"
          : true),
  );
  const placed = selFlocks.reduce((s, f) => s + (f.initialCount || 0), 0);
  const liveBirds = selFlocks.reduce((s, f) => s + (f.currentCount || 0), 0);

  // ── Daily growth trend (live weight samples vs breed target) ──────────
  // Sources: production BROILER_WEIGHT rows + daily bird-weighing logs.
  // Target curve: broiler standard for BROILERS flocks, layer body-weight
  // standard for LAYERS flocks.
  const targetFor = (flock: any, ageDays: number) =>
    flock?.birdType === "LAYERS" ? layerTargetKg(ageDays) : broilerTargetKg(ageDays);
  const byDate = new Map<string, { w: number[]; t: number[] }>();
  for (const p of prod.filter(isWeightRecord)) {
    const flock = (p.flockId && flockById.get(p.flockId)) || flockByBatch.get(p.batchNumber);
    const age = flock?.arrivalDate ? ageDaysBetween(flock.arrivalDate, p.recordedDate) : null;
    const e = byDate.get(p.recordedDate) || { w: [], t: [] };
    e.w.push(p.avgWeightKg);
    if (age != null) e.t.push(targetFor(flock, age));
    byDate.set(p.recordedDate, e);
  }
  for (const w of birdLogs) {
    const flock = (w.flockId && flockById.get(w.flockId)) || flockByBatch.get(w.batchNumber);
    const age = flock?.arrivalDate ? ageDaysBetween(flock.arrivalDate, w.recordedDate) : null;
    const e = byDate.get(w.recordedDate) || { w: [], t: [] };
    e.w.push((w.avgWeightG || 0) / 1000);
    if (age != null) e.t.push(targetFor(flock, age));
    byDate.set(w.recordedDate, e);
  }
  const growthTrend = [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({ date, avgWeightKg: +MEAN(v.w).toFixed(3), targetKg: v.t.length ? +MEAN(v.t).toFixed(3) : null as any }))
    .filter((r) => r.targetKg != null);

  // ── Average weight by age (weekly buckets) ────────────────────────────
  const byAge = new Map<number, { w: number[]; t: number[] }>();
  const pushAge = (wk: number, kg: number, t: number | null) => {
    const e = byAge.get(wk) || { w: [], t: [] };
    e.w.push(kg);
    if (t != null) e.t.push(t);
    byAge.set(wk, e);
  };
  for (const p of prod.filter(isWeightRecord)) {
    const flock = (p.flockId && flockById.get(p.flockId)) || flockByBatch.get(p.batchNumber);
    if (!flock?.arrivalDate) continue;
    const age = ageDaysBetween(flock.arrivalDate, p.recordedDate);
    pushAge(Math.floor(age / 7), p.avgWeightKg, targetFor(flock, age));
  }
  for (const w of birdLogs) {
    const flock = (w.flockId && flockById.get(w.flockId)) || flockByBatch.get(w.batchNumber);
    if (!flock?.arrivalDate) continue;
    const age = ageDaysBetween(flock.arrivalDate, w.recordedDate);
    pushAge(Math.floor(age / 7), (w.avgWeightG || 0) / 1000, targetFor(flock, age));
  }
  const weightByAge = [...byAge.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([wk, v]) => ({ age: `W${wk}`, avgWeightKg: +MEAN(v.w).toFixed(3), targetKg: v.t.length ? +MEAN(v.t).toFixed(3) : broilerTargetKg(wk * 7) }));

  // ── Daily feed consumption ────────────────────────────────────────────
  const feedMap = new Map<string, number>();
  for (const f of feed) feedMap.set(f.recordedDate, (feedMap.get(f.recordedDate) || 0) + (f.quantityKg || 0));
  const feedDaily = [...feedMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, kg]) => ({ date, kg: +kg.toFixed(2) }));

  // ── FCR trend (recorded values) ───────────────────────────────────────
  const fcrMap = new Map<string, number[]>();
  for (const p of prod.filter((p) => (p.fcr || 0) > 0)) fcrMap.set(p.recordedDate, [...(fcrMap.get(p.recordedDate) || []), p.fcr]);
  const fcrTrend = [...fcrMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, xs]) => ({ date, fcr: +MEAN(xs).toFixed(2) }));

  // ── Mortality trend + cumulative % ────────────────────────────────────
  const mortMap = new Map<string, number>();
  for (const h of health.filter((h) => h.recordType === "MORTALITY" && (h.mortalityCount || 0) > 0))
    mortMap.set(h.recordedDate, (mortMap.get(h.recordedDate) || 0) + h.mortalityCount);
  let cum = 0;
  const mortalityDaily = [...mortMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, n]) => {
    cum += n;
    return { date, deaths: n, cumMortPct: placed > 0 ? +((cum / placed) * 100).toFixed(2) : 0 };
  });
  const totalDeaths = cum;

  // ── Broiler harvest trend ─────────────────────────────────────────────
  const broMap = new Map<string, { harvested: number; weightKg: number }>();
  for (const p of prod.filter((p) => (p.productionType === "BROILER_WEIGHT" || p.productionType === "BROILER") && ((p.birdsHarvested || 0) > 0 || (p.totalWeightKg || 0) > 0))) {
    const e = broMap.get(p.recordedDate) || { harvested: 0, weightKg: 0 };
    e.harvested += p.birdsHarvested || 0;
    e.weightKg += p.totalWeightKg || 0;
    broMap.set(p.recordedDate, e);
  }
  const broilerDaily = [...broMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({ date, harvested: v.harvested, weightKg: +v.weightKg.toFixed(1) }));

  // ── Lay % vs age-standard target ──────────────────────────────────────
  const layMap = new Map<string, { a: number[]; t: number[] }>();
  for (const p of prod.filter((p) => p.productionType === "EGGS" && (p.layPercentage || 0) > 0)) {
    const flock = (p.flockId && flockById.get(p.flockId)) || flockByBatch.get(p.batchNumber);
    const ageWk = flock?.arrivalDate ? ageDaysBetween(flock.arrivalDate, p.recordedDate) / 7 : null;
    const e = layMap.get(p.recordedDate) || { a: [], t: [] };
    e.a.push(p.layPercentage);
    if (ageWk != null) e.t.push(layerTargetLayPct(ageWk));
    layMap.set(p.recordedDate, e);
  }
  const layTrend = [...layMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({ date, layPct: +MEAN(v.a).toFixed(1), targetPct: v.t.length ? +MEAN(v.t).toFixed(1) : null as any }))
    .filter((r) => r.targetPct != null);

  // ── Daily egg output ──────────────────────────────────────────────────
  const eggMap = new Map<string, { eggs: number; trays: number }>();
  for (const p of prod.filter((p) => p.productionType === "EGGS")) {
    const e = eggMap.get(p.recordedDate) || { eggs: 0, trays: 0 };
    e.eggs += p.eggsCollected || 0;
    e.trays += p.traysProduced || 0;
    eggMap.set(p.recordedDate, e);
  }
  const eggDaily = [...eggMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({ date, eggs: v.eggs, trays: +v.trays.toFixed(1) }));

  // ── Daily egg weight (from egg-weighing logs) vs age-standard target,
  //    linked to the eggs collected + feed consumed the same day ─────────
  const eggWMap = new Map<string, { g: number[]; t: number[] }>();
  for (const w of eggLogs) {
    const flock = (w.flockId && flockById.get(w.flockId)) || flockByBatch.get(w.batchNumber);
    const ageWk = flock?.arrivalDate ? ageDaysBetween(flock.arrivalDate, w.recordedDate) / 7 : null;
    const e = eggWMap.get(w.recordedDate) || { g: [], t: [] };
    e.g.push(w.avgWeightG);
    if (ageWk != null) e.t.push(eggWeightTargetG(ageWk));
    eggWMap.set(w.recordedDate, e);
  }
  const feedOn = (date: string) => feedDaily.find((r) => r.date === date)?.kg ?? 0;
  const eggsOn = (date: string) => eggDaily.find((r) => r.date === date)?.eggs ?? 0;
  const eggWeightDaily = [...eggWMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({
      date,
      avgG: +MEAN(v.g).toFixed(1),
      targetG: v.t.length ? +MEAN(v.t).toFixed(1) : (60 as any),
      eggs: eggsOn(date),
      feedKg: feedOn(date),
    }));

  // ── Estimated standing biomass (kg): sampled avg weight × estimated
  //    birds alive that day (today's count + deaths & harvests after it) ──
  const deathsAfter = (flock: any, date: string) =>
    health.filter((h) => h.recordType === "MORTALITY" && (h.batchNumber || null) === flock.batchNumber && h.recordedDate > date)
      .reduce((s, h) => s + (h.mortalityCount || 0), 0);
  const harvestedAfter = (flock: any, date: string) =>
    prod.filter((p) => (p.batchNumber || null) === flock.batchNumber && p.recordedDate > date)
      .reduce((s, p) => s + (p.birdsHarvested || 0), 0);
  const aliveOn = (flock: any, date: string) =>
    (flock.currentCount || 0) + deathsAfter(flock, date) + harvestedAfter(flock, date);
  // per date × flock sample means
  const sampleByDateFlock = new Map<string, number[]>(); // key `${date}|${flockKey}` → kg samples
  for (const p of prod.filter(isWeightRecord)) {
    const flock = (p.flockId && flockById.get(p.flockId)) || flockByBatch.get(p.batchNumber);
    if (!flock) continue;
    const k = `${p.recordedDate}|${flock.batchNumber}`;
    sampleByDateFlock.set(k, [...(sampleByDateFlock.get(k) || []), p.avgWeightKg]);
  }
  for (const w of birdLogs) {
    const flock = (w.flockId && flockById.get(w.flockId)) || flockByBatch.get(w.batchNumber);
    if (!flock) continue;
    const k = `${w.recordedDate}|${flock.batchNumber}`;
    sampleByDateFlock.set(k, [...(sampleByDateFlock.get(k) || []), (w.avgWeightG || 0) / 1000]);
  }
  const bioMap = new Map<string, number>();
  for (const [k, xs] of sampleByDateFlock) {
    const [date, batch] = k.split("|");
    const flock = flockByBatch.get(batch);
    if (!flock) continue;
    bioMap.set(date, (bioMap.get(date) || 0) + MEAN(xs) * aliveOn(flock, date));
  }
  const biomassDaily = [...bioMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, kg]) => ({ date, biomassKg: +kg.toFixed(1) }));

  // ── KPIs ──────────────────────────────────────────────────────────────
  const totalFeedKg = feedDaily.reduce((s, r) => s + r.kg, 0);
  const fcrVals = fcrTrend.map((r) => r.fcr);
  const avgFcr = fcrVals.length ? +MEAN(fcrVals).toFixed(2) : null;
  const livabilityPct = placed > 0 ? +(100 - (totalDeaths / placed) * 100).toFixed(2) : null;
  const samples = growthTrend;
  const avgDailyGainG = samples.length >= 2
    ? +(((samples[samples.length - 1].avgWeightKg - samples[0].avgWeightKg) * 1000) /
        Math.max(1, ageDaysBetween(samples[0].date, samples[samples.length - 1].date))).toFixed(1)
    : null;
  const eggRows = prod.filter((p) => p.productionType === "EGGS");
  const eggs = eggRows.reduce((s, p) => s + (p.eggsCollected || 0), 0);
  const peakLayPct = layTrend.length ? Math.max(...layTrend.map((r) => r.layPct)) : null;
  const layerBirds = selFlocks.filter((f) => f.birdType === "LAYERS").reduce((s, f) => s + (f.currentCount || 0), 0);
  const eggDays = new Set(eggRows.map((p) => p.recordedDate)).size;
  const eggsPerHenDay = layerBirds > 0 && eggDays > 0 ? +(eggs / (layerBirds * eggDays)).toFixed(2) : null;
  const feedPerBirdG = liveBirds > 0 && feedDaily.length > 0 ? +(((totalFeedKg * 1000) / liveBirds) / feedDaily.length).toFixed(0) : null;
  const birdsHarvested = broilerDaily.reduce((s, r) => s + r.harvested, 0);

  // Calculated FCR from actual weighing × feed rows: total feed ÷ total
  // biomass gained between first and last sample per flock.
  let totalGainKg = 0;
  const sampleDatesByFlock = new Map<string, string[]>();
  for (const k of sampleByDateFlock.keys()) {
    const [date, batch] = k.split("|");
    sampleDatesByFlock.set(batch, [...(sampleDatesByFlock.get(batch) || []), date]);
  }
  for (const [batch, dates] of sampleDatesByFlock) {
    const flock = flockByBatch.get(batch);
    if (!flock || !selFlocks.some((f) => f.batchNumber === batch)) continue;
    const uniq = [...new Set(dates)].sort();
    if (uniq.length < 2) continue;
    const first = uniq[0], last = uniq[uniq.length - 1];
    const wFirst = MEAN(sampleByDateFlock.get(`${first}|${batch}`) || []);
    const wLast = MEAN(sampleByDateFlock.get(`${last}|${batch}`) || []);
    const gainPerBird = wLast - wFirst;
    if (gainPerBird <= 0) continue;
    const aliveMid = (aliveOn(flock, first) + aliveOn(flock, last)) / 2;
    totalGainKg += gainPerBird * aliveMid;
  }
  const calcFcr = totalFeedKg > 0 && totalGainKg > 0 ? +(totalFeedKg / totalGainKg).toFixed(2) : null;
  const avgEggWeightG = eggWeightDaily.length ? eggWeightDaily[eggWeightDaily.length - 1].avgG : null;
  const biomassKg = biomassDaily.length ? biomassDaily[biomassDaily.length - 1].biomassKg : null;

  return {
    growthTrend, weightByAge, feedDaily, fcrTrend, mortalityDaily, broilerDaily, layTrend, eggDaily, eggWeightDaily, biomassDaily,
    kpis: { totalFeedKg: +totalFeedKg.toFixed(1), avgFcr, livabilityPct, totalDeaths, avgDailyGainG, peakLayPct, eggsPerHenDay, feedPerBirdG, birdsHarvested, eggs, placed, calcFcr, avgEggWeightG, biomassKg },
  };
}
